// A GitHub Git Data client sized for one job: committing an append-only event
// log from several devices at once, over `Platform.http`.
//
// Two properties are load bearing and neither is an optimisation:
//
//   1. A commit costs four requests whatever it touches, because small file
//      contents are inlined into the tree instead of uploaded as blobs. That is
//      what lets a sync append events and rewrite the snapshot in ONE commit,
//      which is what removes the window where the snapshot and the log disagree.
//   2. `force` is never sent. The rejected ref update IS the concurrency check:
//      a PATCH that loses the race reports a conflict, the caller re-reads and
//      retries, and no write can ever overwrite another device's commit. A force
//      push against an append-only log is a data-loss weapon, so the option is
//      absent from this file rather than merely unused.

import type { Http, HttpMethod } from '../platform.js';

/** Everything account-specific arrives here, so nothing is hardcoded to one user. */
export interface GitHubRepoConfig {
  owner: string;
  repo: string;
  /** A fine-grained token with Contents: read and write on this repo alone. */
  token: string;
  /**
   * Defaults to whatever the repository says its default branch is, read once
   * and cached. It is deliberately not defaulted to a literal: a repository
   * takes the branch name its owning account is configured for, `master` on any
   * account that never changed the setting, and GitHub answers 404 for a branch
   * that does not exist, which is the same 404 it gives for a repository the
   * token cannot see.
   */
  branch?: string;
  /** Defaults to the public API host. Overridden for GitHub Enterprise. */
  apiBase?: string;
}

export interface TreeFile {
  path: string;
  content: string;
}

export interface TreeEntry {
  path: string;
  sha: string;
}

export type CommitOutcome = 'ok' | 'conflict';

/**
 * The slice of the client the sync engine needs. Depending on the interface
 * rather than the class is what lets the engine be tested against an in-memory
 * repository without a mocked transport underneath it.
 */
export interface RepoClient {
  commitFiles(
    message: string,
    files: TreeFile[],
    deletions?: string[],
    expectedHead?: string | null,
  ): Promise<CommitOutcome>;
  listTree(sha: string): Promise<TreeEntry[]>;
  getBlob(sha: string): Promise<string>;
  latestCommit(etag?: string): Promise<{ sha: string; etag: string } | 'not-modified'>;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly method: HttpMethod,
    readonly path: string,
    detail: string,
  ) {
    super(`${method} ${path} failed with ${status}: ${detail}`);
    this.name = 'GitHubError';
  }
}

/** The status of a failed request, when the failure came from the API at all. */
export function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A repository with no commits yet, which is not an error: the first push
 * creates the branch.
 *
 * 409 only. GitHub answers 404 for a repository the token cannot see, which a
 * revoked token, a renamed repo and a typo in settings all produce. Treating
 * that as "empty" would show a user with intact data an empty app, and then
 * write a snapshot of nothing over the top of it.
 */
export function isEmptyRepository(err: unknown): boolean {
  return httpStatusOf(err) === 409;
}

/**
 * The branch was looked for and is not there. Separated from the 404 below
 * because the two are byte-identical on the wire and the remedies are opposite:
 * one is a setting to correct, the other is access to restore. Telling someone
 * to regenerate a working token because their branch is named `master` costs
 * them an hour and leaves them no better off.
 */
export class BranchNotFoundError extends GitHubError {
  constructor(readonly branch: string, readonly defaultBranch: string, path: string) {
    super(
      404,
      'GET',
      path,
      `branch "${branch}" does not exist here; the repository's default branch is "${defaultBranch}"`,
    );
    this.name = 'BranchNotFoundError';
  }
}

/** The repository itself did not answer: gone, renamed, or out of the token's reach. */
export class RepositoryNotVisibleError extends GitHubError {
  constructor(owner: string, repo: string, path: string) {
    super(
      404,
      'GET',
      path,
      `repository ${owner}/${repo} is not visible to this token: it may not exist, may have been renamed, or the token may no longer have access`,
    );
    this.name = 'RepositoryNotVisibleError';
  }
}

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const ACCEPT = 'application/vnd.github+json';
/** A non-executable regular file. Every path this app writes is one. */
const BLOB_MODE = '100644';

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export class GitHubClient implements RepoClient {
  private readonly http: Http;
  private readonly config: GitHubRepoConfig;
  private readonly base: string;
  /** Resolved once, then reused. Absent until something needs the branch. */
  private branchPromise?: Promise<string>;
  /**
   * The tree of the commit the last poll saw. A commit's tree never changes, so
   * the pair is immutable once observed and can be held without invalidation,
   * exactly like a blob sha.
   */
  private parentTree?: { commit: string; tree: string };

  constructor(http: Http, config: GitHubRepoConfig) {
    this.http = http;
    this.config = config;
    this.base = (config.apiBase ?? API_BASE).replace(/\/+$/, '');
  }

  private get repoPath(): string {
    return `/repos/${this.config.owner}/${this.config.repo}`;
  }

  /**
   * The branch every read and write targets: the configured one, or the
   * repository's own default read once and cached. Read and write resolve the
   * same way on purpose; a client that polled one branch and committed to
   * another would look like it was working and sync nothing.
   *
   * A failed resolution is not cached, so a network blip does not disable the
   * client for the rest of its life.
   */
  async branchName(): Promise<string> {
    const configured = this.config.branch;
    if (configured !== undefined && configured !== '') return configured;
    if (this.branchPromise === undefined) {
      this.branchPromise = this.repoInfo()
        .then(info => info.defaultBranch)
        .catch((err: unknown) => {
          this.branchPromise = undefined;
          throw err;
        });
    }
    return this.branchPromise;
  }

  /** Also the probe that tells a missing branch apart from a missing repository. */
  async repoInfo(): Promise<{ defaultBranch: string }> {
    const path = this.repoPath;
    const res = await this.send('GET', path);
    const body = parseJson(res, 'GET', path);
    const name = isRecord(body) ? body['default_branch'] : undefined;
    if (typeof name !== 'string' || name === '') {
      throw new GitHubError(res.status, 'GET', path, 'repository has no default_branch');
    }
    return { defaultBranch: name };
  }

  /** The parent commit the next write builds on. */
  async getRef(): Promise<{ sha: string }> {
    const sha = await this.readRef();
    if (sha === null) {
      const branch = await this.branchName();
      throw new GitHubError(404, 'GET', `${this.repoPath}/git/ref/heads/${branch}`, 'branch does not exist');
    }
    return { sha };
  }

  /**
   * `baseTree` is the parent commit's sha, which the API peels to its tree; pass
   * an empty string for the first commit in a repository. Contents are inlined,
   * so an arbitrary number of files still costs one request. A deletion is an
   * entry with a null sha, which is why removing the events a snapshot just
   * absorbed happens in the same tree as writing that snapshot.
   */
  async createTree(baseTree: string, files: TreeFile[], deletions?: string[]): Promise<{ sha: string }> {
    const tree: Record<string, unknown>[] = [
      ...files.map(f => ({ path: f.path, mode: BLOB_MODE, type: 'blob', content: f.content })),
      ...(deletions ?? []).map(path => ({ path, mode: BLOB_MODE, type: 'blob', sha: null })),
    ];
    const body: Record<string, unknown> = { tree };
    if (baseTree !== '') body['base_tree'] = baseTree;
    const path = `${this.repoPath}/git/trees`;
    const res = await this.request('POST', path, body);
    // Verified against the live API: deleting a path the base tree does not
    // have is rejected as `GitRPC::BadObjectState`, which says nothing a reader
    // can act on. The caller's deletion list is stale.
    if (res.status === 422 && (deletions?.length ?? 0) > 0) {
      throw new GitHubError(
        res.status,
        'POST',
        path,
        `${messageOf(res.text)} (every deletion must name a path the base tree actually has)`,
      );
    }
    this.checkOk(res, 'POST', path);
    return { sha: this.expectSha(res, 'POST', path) };
  }

  async createCommit(message: string, tree: string, parents: string[]): Promise<{ sha: string }> {
    const path = `${this.repoPath}/git/commits`;
    const res = await this.send('POST', path, { message, tree, parents });
    return { sha: this.expectSha(res, 'POST', path) };
  }

  /**
   * Moves the branch, and reports a lost race rather than winning it. The body
   * carries the new sha and nothing else: no `force`, under any condition.
   */
  async updateRef(sha: string): Promise<CommitOutcome> {
    const path = `${this.repoPath}/git/refs/heads/${await this.branchName()}`;
    const res = await this.request('PATCH', path, { sha });
    if (isRefConflict(res.status)) return 'conflict';
    this.checkOk(res, 'PATCH', path);
    return 'ok';
  }

  /** Creates the branch. A branch another device created first is a conflict. */
  async createRef(sha: string): Promise<CommitOutcome> {
    const path = `${this.repoPath}/git/refs`;
    const res = await this.request('POST', path, { ref: `refs/heads/${await this.branchName()}`, sha });
    if (isRefConflict(res.status)) return 'conflict';
    this.checkOk(res, 'POST', path);
    return 'ok';
  }

  /**
   * Every path and blob sha under a commit, in one request.
   *
   * A truncated answer is refused rather than returned. Silently reporting part
   * of a repository would read to the caller as events that no longer exist,
   * which is indistinguishable from data loss and would let a compaction fold a
   * log it never saw.
   */
  async listTree(sha: string): Promise<TreeEntry[]> {
    const path = `${this.repoPath}/git/trees/${sha}`;
    const res = await this.send('GET', `${path}?recursive=1`);
    const body = parseJson(res, 'GET', path);
    if (isRecord(body) && body['truncated'] === true) {
      throw new GitHubError(res.status, 'GET', path, 'tree is truncated, refusing a partial repository');
    }
    const raw = isRecord(body) ? body['tree'] : undefined;
    if (!Array.isArray(raw)) throw new GitHubError(res.status, 'GET', path, 'no tree in the response');
    const out: TreeEntry[] = [];
    for (const entry of raw) {
      if (!isRecord(entry) || entry['type'] !== 'blob') continue;
      const p = entry['path'];
      const s = entry['sha'];
      if (typeof p === 'string' && typeof s === 'string') out.push({ path: p, sha: s });
    }
    return out;
  }

  /** Blobs are content-addressed, so a sha-keyed cache above this never stales. */
  async getBlob(sha: string): Promise<string> {
    const path = `${this.repoPath}/git/blobs/${sha}`;
    const res = await this.send('GET', path);
    const body = parseJson(res, 'GET', path);
    if (!isRecord(body)) throw new GitHubError(res.status, 'GET', path, 'blob response is not an object');
    const content = body['content'];
    const encoding = body['encoding'];
    if (typeof content !== 'string') throw new GitHubError(res.status, 'GET', path, 'blob has no content');
    if (encoding === 'utf-8') return content;
    if (encoding !== 'base64') {
      throw new GitHubError(res.status, 'GET', path, `unsupported blob encoding ${String(encoding)}`);
    }
    return decodeBase64(content);
  }

  /**
   * The polling read. A 304 costs nothing against the primary rate limit, which
   * is the whole reason a device can poll once a minute and stay well inside it.
   */
  async latestCommit(etag?: string): Promise<{ sha: string; tree?: string; etag: string } | 'not-modified'> {
    const branch = await this.branchName();
    const path = `${this.repoPath}/commits`;
    const query = `?sha=${encodeURIComponent(branch)}&per_page=1`;
    const res = await this.request('GET', `${path}${query}`, undefined, etag ? { 'if-none-match': etag } : undefined);
    if (res.status === 304) return 'not-modified';
    // Two different problems arrive as the same 404, and they are told apart by
    // asking whether the repository answers at all.
    if (res.status === 404) throw await this.explain404(branch, path);
    this.checkOk(res, 'GET', path);
    const body = parseJson(res, 'GET', path);
    const head = Array.isArray(body) ? body[0] : undefined;
    const sha = isRecord(head) ? head['sha'] : undefined;
    if (typeof sha !== 'string') throw new GitHubError(res.status, 'GET', path, 'no commit on the branch');
    // This response already carries the commit's tree, so the next write can
    // build on the tree itself rather than on the commit. Free, and it is what
    // the API actually asks for; see `baseTreeFor`.
    const tree = treeShaOf(head);
    if (tree !== undefined) this.parentTree = { commit: sha, tree };
    return tree === undefined
      ? { sha, etag: res.headers['etag'] ?? '' }
      : { sha, tree, etag: res.headers['etag'] ?? '' };
  }

  /**
   * The tree to build the next write on.
   *
   * The API documents `base_tree` as taking a TREE sha. Real GitHub also
   * accepts a commit sha and peels it to that commit's tree, verified live, so
   * passing one works today. It is undocumented leniency though, and a stricter
   * implementation reads an unrecognised base as no base at all: the commit
   * succeeds and every previously committed file is gone. Silent, total, and
   * exactly the failure shape a datastore must never have.
   *
   * The pairing is by identity rather than by trust: the tree is looked up
   * under the sha the ref just returned, so the tree built on and the commit
   * parented to are provably the same commit, or the lookup misses.
   *
   * A miss falls back to the commit sha, which is what this did before and what
   * every caller that has not polled still gets. Reading the tree from the
   * commit instead would cost a fifth request on a path the four-request budget
   * belongs to.
   */
  private baseTreeFor(parent: string | null): string {
    if (parent === null) return ''; // no parent, so no base tree: the first commit
    if (this.parentTree?.commit === parent) return this.parentTree.tree;
    return parent;
  }

  /**
   * One commit, four requests, however many files.
   *
   * `expectedHead` is the head the caller built this write from, and passing it
   * makes the whole thing a compare and swap. Without it there is a window
   * between the caller's read and the read below in which another device can
   * commit: this write would then be applied on top of that commit, as a clean
   * fast forward with no conflict, silently discarding whatever it contributed.
   * The window is the caller's entire planning phase, which for a compaction is
   * many round trips. Pass `null` for "the branch did not exist when I planned".
   *
   * A conflict is returned rather than retried here: retrying correctly means
   * re-reading the log and rebuilding the write against it, and only the caller
   * knows what it wanted to write.
   */
  async commitFiles(
    message: string,
    files: TreeFile[],
    deletions?: string[],
    expectedHead?: string | null,
  ): Promise<CommitOutcome> {
    const parent = await this.readRef();
    if (expectedHead !== undefined && parent !== expectedHead) return 'conflict';
    const tree = await this.createTree(this.baseTreeFor(parent), files, deletions);
    const commit = await this.createCommit(message, tree.sha, parent === null ? [] : [parent]);
    return parent === null ? this.createRef(commit.sha) : this.updateRef(commit.sha);
  }

  /**
   * Turns a 404 into the one a person can act on. Costs a request, and only on
   * a path that has already failed.
   */
  private async explain404(branch: string, path: string): Promise<Error> {
    try {
      const info = await this.repoInfo();
      return new BranchNotFoundError(branch, info.defaultBranch, path);
    } catch (err) {
      if (httpStatusOf(err) === 404) {
        return new RepositoryNotVisibleError(this.config.owner, this.config.repo, path);
      }
      return err instanceof Error ? err : new GitHubError(404, 'GET', path, String(err));
    }
  }

  /** The branch head, or null when the repository has no commits yet. */
  private async readRef(): Promise<string | null> {
    const path = `${this.repoPath}/git/ref/heads/${await this.branchName()}`;
    const res = await this.request('GET', path);
    if (res.status === 404 || res.status === 409) return null;
    this.checkOk(res, 'GET', path);
    const body = parseJson(res, 'GET', path);
    const object = isRecord(body) ? body['object'] : undefined;
    const sha = isRecord(object) ? object['sha'] : undefined;
    if (typeof sha !== 'string') throw new GitHubError(res.status, 'GET', path, 'ref has no object sha');
    return sha;
  }

  private async send(method: HttpMethod, path: string, body?: unknown): Promise<RawResponse> {
    const res = await this.request(method, path, body);
    this.checkOk(res, method, path);
    return res;
  }

  private async request(
    method: HttpMethod,
    path: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      accept: ACCEPT,
      authorization: `Bearer ${this.config.token}`,
      'x-github-api-version': API_VERSION,
      ...extra,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.http({
      url: `${this.base}${path}`,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  private checkOk(res: RawResponse, method: HttpMethod, path: string): void {
    if (res.status >= 200 && res.status < 300) return;
    throw new GitHubError(res.status, method, path, messageOf(res.text));
  }

  private expectSha(res: RawResponse, method: HttpMethod, path: string): string {
    const body = parseJson(res, method, path);
    const sha = isRecord(body) ? body['sha'] : undefined;
    if (typeof sha !== 'string') throw new GitHubError(res.status, method, path, 'no sha in the response');
    return sha;
  }
}

/**
 * 422 is what GitHub answers a non-fast-forward ref update with, and what it
 * answers a create for a ref that already exists with. 409 covers the same race
 * on some paths. Both mean the same thing here: someone else got there first.
 */
function isRefConflict(status: number): boolean {
  return status === 409 || status === 422;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `commit.tree.sha` off a commit in the `/commits` listing, when it is there. */
function treeShaOf(commit: unknown): string | undefined {
  if (!isRecord(commit)) return undefined;
  const inner = commit['commit'];
  const tree = isRecord(inner) ? inner['tree'] : undefined;
  const sha = isRecord(tree) ? tree['sha'] : undefined;
  return typeof sha === 'string' && sha !== '' ? sha : undefined;
}

function parseJson(res: RawResponse, method: HttpMethod, path: string): unknown {
  try {
    return JSON.parse(res.text);
  } catch {
    throw new GitHubError(res.status, method, path, 'response was not json');
  }
}

/** The API's own message when there is one, so a failure says why. */
function messageOf(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    const message = isRecord(body) ? body['message'] : undefined;
    if (typeof message === 'string') return message;
  } catch {
    // Fall through to the raw body.
  }
  return text.slice(0, 200);
}

/**
 * Base64 to UTF-8 without Buffer, because this runs in a WebView as well as in
 * Node. `atob` yields one char per byte, so the bytes are rebuilt before being
 * decoded: reading its output as text mangles every multi-byte character.
 */
function decodeBase64(input: string): string {
  const binary = atob(input.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
