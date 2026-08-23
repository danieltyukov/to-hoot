import { beforeEach, describe, expect, it } from 'vitest';
import {
  BranchNotFoundError,
  GitHubClient,
  GitHubError,
  RepositoryNotVisibleError,
  isEmptyRepository,
} from './client.js';
import type { Http, HttpMethod, HttpRequest, HttpResponse } from '../platform.js';

interface Call {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  // The parsed request body. `any` so the plan's tests can read into it directly.
  body: any;
}

interface Queued {
  method: HttpMethod;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** A commit sha maps to exactly one tree sha, and the two are never the same string. */
function treeOf(commitSha: string): string {
  return `tree-of-${commitSha}`;
}

function isTreeSha(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('tree-');
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers,
    text: async () => (body === null || body === undefined ? '' : JSON.stringify(body)),
  };
}

/** A stand-in for `Platform.http` that records every request and can be steered per call. */
class MockHttp {
  calls: Call[] = [];
  /** blob sha -> decoded content. */
  blobs = new Map<string, string>();
  tree: { path: string; type: string; sha: string }[] = [];
  truncated = false;
  headSha = 'commit-1';
  etag = 'W/"etag-1"';
  /** The branch that actually exists. Anything else 404s, as GitHub does. */
  existingBranch = 'main';
  /** What `GET /repos/o/r` reports, which is not always what a caller assumed. */
  defaultBranch = 'master';
  repoVisible = true;
  /**
   * Rejects a `base_tree` that is not a tree, which is what the API documents
   * and what an implementation other than GitHub's own is entitled to do.
   * GitHub itself peels a commit sha here, so this is the strict reading.
   */
  strictBaseTree = false;
  private lastTreeBody: any;
  private queued: Queued[] = [];

  replyOnce(method: HttpMethod, status: number, body: unknown, headers?: Record<string, string>): void {
    this.queued.push({ method, status, body, headers });
  }

  readonly http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const method = req.method ?? 'GET';
    const body = req.body === undefined ? undefined : JSON.parse(req.body);
    if (req.url.endsWith('/git/trees')) this.lastTreeBody = body;
    this.calls.push({
      method,
      url: req.url,
      headers: req.headers ?? {},
      body,
    });
    const at = this.queued.findIndex(q => q.method === method);
    if (at >= 0) {
      const [q] = this.queued.splice(at, 1);
      return respond(q.status, q.body, q.headers);
    }
    return this.route(method, new URL(req.url));
  };

  private route(method: HttpMethod, url: URL): HttpResponse {
    const path = url.pathname;
    const key = `${method} ${path}`;
    if (!this.repoVisible && path.startsWith('/repos/o/r')) return respond(404, { message: 'Not Found' });
    if (key === 'GET /repos/o/r') return respond(200, { default_branch: this.defaultBranch });
    if (method === 'GET' && path.startsWith('/repos/o/r/git/ref/heads/')) {
      const branch = path.slice('/repos/o/r/git/ref/heads/'.length);
      if (branch !== this.existingBranch) return respond(404, { message: 'Not Found' });
      return respond(200, { ref: `refs/heads/${branch}`, object: { sha: this.headSha, type: 'commit' } });
    }
    if (key === 'POST /repos/o/r/git/trees') {
      const base = this.lastTreeBody?.['base_tree'];
      if (this.strictBaseTree && base !== undefined && !isTreeSha(base)) {
        // What a server that reads the documentation does. GitHub itself peels
        // a commit sha here; nothing else has to.
        return respond(422, { message: `base_tree ${String(base)} is not a tree` });
      }
      return respond(201, { sha: 'tree-2' });
    }
    if (key === 'POST /repos/o/r/git/commits') return respond(201, { sha: 'commit-2' });
    if (method === 'PATCH' && path.startsWith('/repos/o/r/git/refs/heads/')) {
      return respond(200, { object: { sha: 'commit-2' } });
    }
    if (key === 'POST /repos/o/r/git/refs') return respond(201, { object: { sha: 'commit-2' } });
    if (key === 'GET /repos/o/r/commits') {
      // GitHub answers 404 for a branch that does not exist, the same status it
      // gives for a repository it will not admit to having. The response also
      // carries the head commit's tree, which is where base_tree comes from.
      if (url.searchParams.get('sha') !== this.existingBranch) return respond(404, { message: 'Not Found' });
      return respond(200, [{ sha: this.headSha, commit: { tree: { sha: treeOf(this.headSha) } } }], {
        etag: this.etag,
      });
    }
    if (method === 'GET' && path.startsWith('/repos/o/r/git/trees/')) {
      return respond(200, { sha: path.slice(path.lastIndexOf('/') + 1), truncated: this.truncated, tree: this.tree });
    }
    if (method === 'GET' && path.startsWith('/repos/o/r/git/blobs/')) {
      const sha = path.slice(path.lastIndexOf('/') + 1);
      const content = this.blobs.get(sha);
      if (content === undefined) return respond(404, { message: 'Not Found' });
      return respond(200, { sha, encoding: 'base64', content: toBase64(content) });
    }
    return respond(404, { message: `unrouted ${key}` });
  }
}

describe('GitHubClient', () => {
  let http: MockHttp;
  let client: GitHubClient;

  beforeEach(() => {
    http = new MockHttp();
    client = new GitHubClient(http.http, { owner: 'o', repo: 'r', token: 'tok', branch: 'main' });
  });

  describe('branch resolution', () => {
    // The trap this closes: a repository takes its owning account's default
    // branch name, which is master on any account that never changed the
    // setting. A client defaulting to a literal "main" 404s on the very first
    // read, and the 404 is indistinguishable from a token that lost access.
    it('targets the repository default branch when none is configured', async () => {
      http.existingBranch = 'master';
      const unconfigured = new GitHubClient(http.http, { owner: 'o', repo: 'r', token: 'tok' });
      await expect(unconfigured.latestCommit()).resolves.toEqual({
        sha: 'commit-1',
        tree: 'tree-of-commit-1',
        etag: 'W/"etag-1"',
      });
      expect(http.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
        'GET /repos/o/r',
        'GET /repos/o/r/commits',
      ]);
      expect(new URL(http.calls[1]!.url).searchParams.get('sha')).toBe('master');
    });

    it('resolves the default branch once, then commits in four requests', async () => {
      http.existingBranch = 'master';
      const unconfigured = new GitHubClient(http.http, { owner: 'o', repo: 'r', token: 'tok' });
      await unconfigured.commitFiles('first', [{ path: 'a', content: 'x' }]);
      expect(http.calls).toHaveLength(5); // the one-time resolution, then the four
      http.calls = [];
      await unconfigured.commitFiles('second', [{ path: 'b', content: 'y' }]);
      expect(http.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
        'GET /repos/o/r/git/ref/heads/master',
        'POST /repos/o/r/git/trees',
        'POST /repos/o/r/git/commits',
        'PATCH /repos/o/r/git/refs/heads/master',
      ]);
    });

    it('reads and writes the same branch, so a poll cannot watch one and commit to another', async () => {
      http.existingBranch = 'master';
      const unconfigured = new GitHubClient(http.http, { owner: 'o', repo: 'r', token: 'tok' });
      await unconfigured.latestCommit();
      await unconfigured.updateRef('abc');
      const read = new URL(http.calls[1]!.url).searchParams.get('sha');
      const written = new URL(http.calls[2]!.url).pathname;
      expect(written).toBe(`/repos/o/r/git/refs/heads/${read}`);
    });

    it('does not cache a failed resolution', async () => {
      http.repoVisible = false;
      const unconfigured = new GitHubClient(http.http, { owner: 'o', repo: 'r', token: 'tok' });
      await expect(unconfigured.latestCommit()).rejects.toThrow();
      http.repoVisible = true;
      http.existingBranch = 'master';
      await expect(unconfigured.latestCommit()).resolves.toMatchObject({ sha: 'commit-1' });
    });

    it('says which branch it looked for and which one exists', async () => {
      http.existingBranch = 'master'; // configured for main, repo is on master
      const err = await client.latestCommit().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BranchNotFoundError);
      expect((err as Error).message).toMatch(/"main" does not exist/);
      expect((err as Error).message).toMatch(/default branch is "master"/);
    });

    it('says the repository is not visible when the repository itself is not there', async () => {
      http.repoVisible = false;
      const err = await client.latestCommit().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RepositoryNotVisibleError);
      expect(err).not.toBeInstanceOf(BranchNotFoundError);
      expect((err as Error).message).toMatch(/not visible to this token/);
    });

    it('leaves an empty repository reporting itself as empty', async () => {
      // 409 is the answer for a repo with no commits, and it must not be
      // rewritten into either 404 story: the first push creates the branch.
      http.replyOnce('GET', 409, { message: 'Git Repository is empty.' });
      const err = await client.latestCommit().catch((e: unknown) => e);
      expect(isEmptyRepository(err)).toBe(true);
    });
  });

  it('commits many files in exactly four requests', async () => {
    await client.commitFiles('msg', [{ path: 'a', content: '1' }, { path: 'b', content: '2' }, { path: 'c', content: '3' }]);
    expect(http.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /repos/o/r/git/ref/heads/main',
      'POST /repos/o/r/git/trees',
      'POST /repos/o/r/git/commits',
      'PATCH /repos/o/r/git/refs/heads/main',
    ]);
  });

  it('inlines content into the tree rather than creating blobs', async () => {
    await client.commitFiles('msg', [{ path: 'a', content: 'x' }]);
    const tree = http.calls.find(c => c.url.endsWith('/git/trees'))!;
    expect(tree.body.tree[0]).toEqual({ path: 'a', mode: '100644', type: 'blob', content: 'x' });
    expect(http.calls.some(c => c.url.endsWith('/git/blobs'))).toBe(false);
  });

  it('reports a moved ref as a conflict instead of forcing', async () => {
    http.replyOnce('PATCH', 422, { message: 'Update is not a fast forward' });
    await expect(client.updateRef('abc')).resolves.toBe('conflict');
  });

  it('NEVER sends force in a ref update', async () => {
    await client.commitFiles('msg', [{ path: 'a', content: 'x' }]);
    const patch = http.calls.find(c => c.method === 'PATCH')!;
    expect(patch.body).not.toHaveProperty('force');
  });

  it('sends If-None-Match and understands 304', async () => {
    http.replyOnce('GET', 304, null);
    await expect(client.latestCommit('W/"abc"')).resolves.toBe('not-modified');
  });

  it('sends the conditional header only when it has an etag to send', async () => {
    await client.latestCommit();
    expect(http.calls[0]!.headers['if-none-match']).toBeUndefined();
    await client.latestCommit('W/"abc"');
    expect(http.calls[1]!.headers['if-none-match']).toBe('W/"abc"');
  });

  it('returns the head sha and the etag to poll with next time', async () => {
    http.headSha = 'head-9';
    http.etag = 'W/"etag-9"';
    await expect(client.latestCommit()).resolves.toEqual({
      sha: 'head-9',
      tree: 'tree-of-head-9',
      etag: 'W/"etag-9"',
    });
    const poll = http.calls[0]!;
    expect(new URL(poll.url).searchParams.get('sha')).toBe('main');
    expect(new URL(poll.url).searchParams.get('per_page')).toBe('1');
  });

  it('authenticates every request without putting the token in the url', async () => {
    await client.commitFiles('msg', [{ path: 'a', content: 'x' }]);
    for (const call of http.calls) {
      expect(call.headers['authorization']).toBe('Bearer tok');
      expect(call.headers['x-github-api-version']).toBe('2022-11-28');
      expect(call.url).not.toContain('tok');
    }
  });

  it('deletes a path with a null sha entry rather than a second commit', async () => {
    await client.commitFiles('msg', [{ path: 'a', content: 'x' }], ['gone.json']);
    const tree = http.calls.find(c => c.url.endsWith('/git/trees'))!;
    expect(tree.body.tree).toContainEqual({ path: 'gone.json', mode: '100644', type: 'blob', sha: null });
    expect(tree.body.base_tree).toBe('commit-1');
  });

  describe('base_tree', () => {
    // The API documents base_tree as taking a TREE sha. Real GitHub peels a
    // commit sha too, verified live, so passing one works today. On a stricter
    // implementation an unrecognised base reads as no base: the commit succeeds
    // and every previously committed file is gone. Silent and total.
    it('builds on the parent commit tree, not on the parent commit', async () => {
      await client.latestCommit(); // the poll every sync does first
      await client.commitFiles('msg', [{ path: 'a', content: 'x' }], [], 'commit-1');
      const tree = http.calls.find(c => c.method === 'POST' && c.url.endsWith('/git/trees'))!;
      expect(tree.body.base_tree).toBe('tree-of-commit-1');
      expect(tree.body.base_tree).not.toBe('commit-1');
    });

    it('costs no extra request, because the poll already carried the tree', async () => {
      await client.latestCommit();
      http.calls = [];
      await client.commitFiles('msg', [{ path: 'a', content: 'x' }], [], 'commit-1');
      expect(http.calls).toHaveLength(4);
    });

    it('satisfies a server that refuses a commit sha where a tree belongs', async () => {
      http.strictBaseTree = true;
      await client.latestCommit();
      await expect(client.commitFiles('msg', [{ path: 'a', content: 'x' }], [], 'commit-1')).resolves.toBe('ok');
    });

    it('pairs the tree with the commit by identity, so a moved head cannot mismatch', async () => {
      await client.latestCommit(); // records commit-1 and its tree
      http.headSha = 'commit-7'; // the ref has moved on since
      await client.commitFiles('msg', [{ path: 'a', content: 'x' }]);
      const tree = http.calls.find(c => c.method === 'POST' && c.url.endsWith('/git/trees'))!;
      // Not tree-of-commit-1: that tree belongs to a commit this is not parented to.
      expect(tree.body.base_tree).not.toBe('tree-of-commit-1');
      expect(tree.body.base_tree).toBe('commit-7');
    });

    it('omits base_tree entirely for the first commit in a repository', async () => {
      http.replyOnce('GET', 404, { message: 'Not Found' });
      await client.commitFiles('first', [{ path: 'a', content: 'x' }]);
      const tree = http.calls.find(c => c.method === 'POST' && c.url.endsWith('/git/trees'))!;
      expect(tree.body).not.toHaveProperty('base_tree');
    });
  });

  it('says what a rejected deletion means, since the API message does not', async () => {
    // Verified live: deleting a path the base tree lacks is answered with
    // `422 GitRPC::BadObjectState`, and the whole commit is lost, not the entry.
    http.replyOnce('POST', 422, { message: 'GitRPC::BadObjectState' });
    await expect(client.commitFiles('msg', [], ['gone.json'])).rejects.toThrow(
      /every deletion must name a path the base tree actually has/,
    );
  });

  it('leaves a 422 that has nothing to do with deletions alone', async () => {
    http.replyOnce('POST', 422, { message: 'something else entirely' });
    await expect(client.createTree('base', [{ path: 'a', content: 'x' }])).rejects.toThrow(/something else entirely/);
  });

  it('lists a whole tree in one recursive request and ignores directory entries', async () => {
    http.tree = [
      { path: 'events', type: 'tree', sha: 't1' },
      { path: 'events/dev-a/01.json', type: 'blob', sha: 'b1' },
      { path: 'snapshot.json', type: 'blob', sha: 'b2' },
    ];
    await expect(client.listTree('commit-1')).resolves.toEqual([
      { path: 'events/dev-a/01.json', sha: 'b1' },
      { path: 'snapshot.json', sha: 'b2' },
    ]);
    expect(new URL(http.calls[0]!.url).searchParams.get('recursive')).toBe('1');
  });

  it('reads the empty tree without asking, because the API answers 404 for it', async () => {
    /*
     * `4b825dc...` is the sha every Git repository gives an empty tree, and
     * GitHub's REST API returns 404 for it rather than an empty list. A data
     * repository reaches that state the moment its last file is removed, and
     * without this the whole repository reads as missing: not "no events yet"
     * but a hard failure on every sync, for a repository that is merely empty.
     */
    http.replyOnce('GET', 404, { message: 'Not Found' });
    await expect(client.listTree('4b825dc642cb6eb9a060e54bf8d69288fbee4904')).resolves.toEqual([]);
    // And it never went to the network to find that out.
    expect(http.calls).toHaveLength(0);
  });

  it('reads a commit whose tree is empty as no files, not as a missing repository', async () => {
    /*
     * The case the constant above does not catch, and the one that actually
     * happens: the caller passes a *commit* sha, GitHub resolves it to the tree
     * itself, and answers 404 because that tree is empty. The sha in the error
     * is the commit, which looks nothing like the empty tree, so this cannot be
     * spotted by inspecting the argument.
     *
     * Safe to read as empty because the sha did not come from nowhere: the
     * caller has just read it off a ref, so the repository is reachable and the
     * commit exists. The only remaining reading of a 404 here is that the tree
     * under it holds nothing.
     */
    http.replyOnce('GET', 404, { message: 'Not Found' });
    await expect(client.listTree('7f73b9929f0b214b5f6fc5390644f6a131f65a2f')).resolves.toEqual([]);
  });

  it('still throws for a tree failure that is not a 404', async () => {
    // The 404 above is read as an answer, which means this path no longer goes
    // through the shared error check by default. A 500 must not become "no
    // files": that would report an outage as an empty repository.
    http.replyOnce('GET', 500, { message: 'boom' });
    const err = await client.listTree('commit-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(500);
    // Specifically NOT the shape complaint. Both paths throw a GitHubError
    // carrying 500, so type and status alone would pass with the error check
    // removed and prove nothing; "no tree in the response" is what a 500
    // degrades into once the status stops being checked.
    expect((err as GitHubError).message).not.toMatch(/no tree/);
  });

  it('refuses a truncated tree rather than reporting a partial repository', async () => {
    http.truncated = true;
    await expect(client.listTree('commit-1')).rejects.toThrow(/truncat/i);
  });

  it('decodes a base64 blob, multi-byte characters included', async () => {
    http.blobs.set('b1', '{"title":"café — 日本語"}');
    await expect(client.getBlob('b1')).resolves.toBe('{"title":"café — 日本語"}');
  });

  it('refuses a blob it cannot decode instead of returning base64 as text', async () => {
    http.replyOnce('GET', 200, { sha: 'b1', encoding: 'none', content: '' });
    await expect(client.getBlob('b1')).rejects.toThrow(/encoding/i);
  });

  it('throws a GitHubError carrying the status for an unexpected failure', async () => {
    http.replyOnce('POST', 500, { message: 'boom' });
    const err = await client.createTree('base', [{ path: 'a', content: 'x' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(500);
    expect((err as GitHubError).message).toMatch(/boom/);
  });

  it('creates the branch instead of patching it when the repository has no commits yet', async () => {
    http.replyOnce('GET', 404, { message: 'Not Found' });
    await expect(client.commitFiles('first', [{ path: 'a', content: 'x' }])).resolves.toBe('ok');
    expect(http.calls.map(c => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /repos/o/r/git/ref/heads/main',
      'POST /repos/o/r/git/trees',
      'POST /repos/o/r/git/commits',
      'POST /repos/o/r/git/refs',
    ]);
    const tree = http.calls[1]!;
    expect(tree.body).not.toHaveProperty('base_tree');
    expect(http.calls[2]!.body.parents).toEqual([]);
    expect(http.calls[3]!.body).toEqual({ ref: 'refs/heads/main', sha: 'commit-2' });
  });

  it('reports a branch another device created first as a conflict', async () => {
    http.replyOnce('GET', 404, { message: 'Not Found' });
    http.replyOnce('POST', 201, { sha: 'tree-2' });
    http.replyOnce('POST', 201, { sha: 'commit-2' });
    http.replyOnce('POST', 422, { message: 'Reference already exists' });
    await expect(client.commitFiles('first', [{ path: 'a', content: 'x' }])).resolves.toBe('conflict');
  });

  it('does not retry a conflict itself, because retrying needs a fresh read', async () => {
    http.replyOnce('PATCH', 409, { message: 'Conflict' });
    await expect(client.commitFiles('msg', [{ path: 'a', content: 'x' }])).resolves.toBe('conflict');
    expect(http.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });

  it('refuses to commit onto a head that moved since the caller planned', async () => {
    // The ref reads back as commit-1, so a plan built on commit-0 is stale. It
    // would still fast forward cleanly, which is exactly why it has to be
    // caught here rather than left to the ref update.
    await expect(client.commitFiles('msg', [{ path: 'a', content: 'x' }], [], 'commit-0')).resolves.toBe('conflict');
    expect(http.calls.map(c => c.method)).toEqual(['GET']);
  });

  it('commits when the head still matches what the caller planned from', async () => {
    await expect(client.commitFiles('msg', [{ path: 'a', content: 'x' }], [], 'commit-1')).resolves.toBe('ok');
    expect(http.calls).toHaveLength(4);
  });

  it('treats a branch that appeared since the plan as a conflict', async () => {
    // Planned against an empty repository, but someone has since pushed one.
    await expect(client.commitFiles('msg', [{ path: 'a', content: 'x' }], [], null)).resolves.toBe('conflict');
    expect(http.calls).toHaveLength(1);
  });

  it('still commits with no expectation, for a caller that has not read the head', async () => {
    await expect(client.commitFiles('msg', [{ path: 'a', content: 'x' }])).resolves.toBe('ok');
    expect(http.calls).toHaveLength(4);
  });

  it('targets the branch it was configured with, without asking the repository', async () => {
    const other = new GitHubClient(http.http, { owner: 'o', repo: 'r', token: 'tok', branch: 'data' });
    await other.getRef().catch(() => undefined);
    expect(new URL(http.calls[0]!.url).pathname).toBe('/repos/o/r/git/ref/heads/data');
    expect(http.calls.some(c => new URL(c.url).pathname === '/repos/o/r')).toBe(false);
  });
});
