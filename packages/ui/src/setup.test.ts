// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Http, HttpRequest, HttpResponse } from '@to-hoot/core';

import {
  README_PATH,
  SECRET_LENGTH,
  checkDeviceId,
  checkDeviceName,
  createDataRepo,
  inspectRepo,
  generateSecret,
  listRepos,
  mcpAddCommand,
  readRepo,
  readmeFor,
  testCalendar,
  testIcs,
  testSync,
  testWorker,
  verifyToken,
  wranglerCommands,
} from './setup.js';

/** What a route answers with: a status and the body as a plain string. */
interface Reply {
  status?: number;
  text?: string;
}

/** A scripted transport. Each entry answers the first request whose URL matches. */
function transport(
  routes: Array<[test: RegExp | ((req: HttpRequest) => boolean), reply: Reply]>,
): { http: Http; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const http: Http = async req => {
    seen.push(req);
    for (const [match, reply] of routes) {
      const hit = typeof match === 'function' ? match(req) : match.test(req.url);
      if (!hit) continue;
      const response: HttpResponse = {
        status: reply.status ?? 200,
        headers: {},
        text: async () => reply.text ?? '',
      };
      return response;
    }
    throw new Error(`no route for ${req.method ?? 'GET'} ${req.url}`);
  };
  return { http, seen };
}

const json = (status: number, body: unknown): Reply => ({ status, text: JSON.stringify(body) });

describe('generateSecret', () => {
  it('is long enough that guessing is hopeless', () => {
    // The bridge cannot throttle wrong-secret attempts and doGet reveals
    // whether a deployment is configured. Length is the whole argument.
    const secret = generateSecret();
    expect(secret).toHaveLength(SECRET_LENGTH);
    expect(SECRET_LENGTH).toBeGreaterThanOrEqual(32);
    expect(secret).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSecret()));
    expect(seen.size).toBe(200);
  });

  it('draws every character from the CSPRNG, never Math.random', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const random = vi.spyOn(Math, 'random');
    generateSecret();
    expect(spy).toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    spy.mockRestore();
    random.mockRestore();
  });

  it('refuses to produce a weak secret when there is no CSPRNG', () => {
    // Falling back to Math.random would produce something that looks exactly as
    // random as the real thing, which is the worst possible failure mode.
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    expect(() => generateSecret()).toThrow(/CSPRNG/);
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true });
  });

  it('is not biased towards the start of the alphabet', () => {
    // 256 is not a multiple of 62, so a plain modulo would make the first eight
    // letters likelier. Rejection sampling is what removes that.
    const counts = new Map<string, number>();
    for (const ch of generateSecret(60_000)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    const values = [...counts.values()];
    const expected = 60_000 / 62;
    expect(Math.max(...values) / expected).toBeLessThan(1.15);
    expect(Math.min(...values) / expected).toBeGreaterThan(0.85);
  });
});

describe('checkDeviceId', () => {
  it('accepts a name that is safe as a path segment', () => {
    const result = checkDeviceId('  daniel-laptop  ');
    expect(result).toMatchObject({ status: 'ok', value: 'daniel-laptop' });
  });

  it.each(['has/slash', '../escape', '.hidden', 'has space', ''])('refuses %s', bad => {
    // A slash writes events under a path every reader ignores, so the device
    // appears to sync and its work never arrives. Caught where it is typed.
    expect(checkDeviceId(bad).status).toBe('error');
  });

  it('says where the name will be used, since that is why the rule exists', () => {
    const result = checkDeviceId('laptop');
    expect(result.status === 'ok' && result.detail).toContain('events/laptop/');
  });
});

describe('verifyToken', () => {
  it('reports which account the token belongs to', async () => {
    const { http } = transport([[/\/user$/, json(200, { login: 'someone', name: 'Some One' })]]);
    const result = await verifyToken(http, 'ghp_x');
    expect(result).toMatchObject({ status: 'ok', detail: 'Signed in as someone.' });
  });

  it('says the token was rejected rather than showing a status code', async () => {
    const { http } = transport([[/\/user$/, json(401, { message: 'Bad credentials' })]]);
    const result = await verifyToken(http, 'ghp_x');
    expect(result).toMatchObject({ status: 'error', detail: 'GitHub rejected the token.' });
  });

  it('passes through what GitHub said for anything else', async () => {
    const { http } = transport([[/\/user$/, json(403, { message: 'Resource not accessible' })]]);
    expect((await verifyToken(http, 'ghp_x')).detail).toBe('Resource not accessible');
  });

  it('survives a transport that throws', async () => {
    const http: Http = async () => {
      throw new Error('network down');
    };
    expect((await verifyToken(http, 'ghp_x')).detail).toContain('network down');
  });
});

describe('readRepo', () => {
  it('reads the real default branch instead of assuming main', async () => {
    // Verified live: a repo made with `gh repo create` can come out as master,
    // and every read and write would then go to a branch that does not exist.
    const { http } = transport([
      [/\/repos\/o\/r$/, json(200, { default_branch: 'master', private: true })],
    ]);
    const result = await readRepo(http, 't', 'o', 'r');
    expect(result).toMatchObject({ status: 'ok', value: { branch: 'master' } });
  });

  it('warns when the data repository is public', async () => {
    const { http } = transport([[/\/repos\//, json(200, { default_branch: 'main', private: false })]]);
    expect((await readRepo(http, 't', 'o', 'r')).detail).toContain('PUBLIC');
  });

  it('does not claim a 404 means the repo is missing', async () => {
    // GitHub answers 404 for a repo the token cannot see as well as one that is
    // not there, and sending half the users to the wrong fix wastes their time.
    const { http } = transport([[/\/repos\//, json(404, { message: 'Not Found' })]]);
    const result = await readRepo(http, 't', 'o', 'r');
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.hint).toContain('may not exist');
  });
});

describe('createDataRepo', () => {
  it('creates it private and empty', async () => {
    const { http, seen } = transport([
      [/\/user\/repos$/, json(201, { full_name: 'someone/to-hoot-data', default_branch: 'main' })],
    ]);
    const result = await createDataRepo(http, 't', 'to-hoot-data');

    const body = JSON.parse(seen[0]!.body!) as Record<string, unknown>;
    expect(body['private']).toBe(true);
    // No auto_init: an empty repository is what the sync engine expects, and it
    // creates the branch itself on the first push.
    expect(body['auto_init']).toBe(false);
    expect(result).toMatchObject({ status: 'ok', value: { owner: 'someone', repo: 'to-hoot-data' } });
  });

  it('explains a token that cannot create repositories', async () => {
    const { http } = transport([[/\/user\/repos$/, json(403, { message: 'Forbidden' })]]);
    const result = await createDataRepo(http, 't', 'x');
    expect(result.status === 'error' && result.hint).toContain('Administration: write');
  });

  it('reports a name that is already taken in GitHub words', async () => {
    const { http } = transport([[/\/user\/repos$/, json(422, { message: 'name already exists' })]]);
    expect((await createDataRepo(http, 't', 'x')).detail).toBe('name already exists');
  });
});

describe('listRepos', () => {
  it('carries each repository default branch through', async () => {
    const { http } = transport([
      [
        /\/user\/repos\?/,
        json(200, [
          { full_name: 'o/a', default_branch: 'main' },
          { full_name: 'o/b', default_branch: 'master' },
        ]),
      ],
    ]);
    const result = await listRepos(http, 't');
    expect(result.status === 'ok' && result.value.map(r => r.branch)).toEqual(['main', 'master']);
  });
});

/*
 * The three shapes a data repository can be in. All three have to pass, which
 * is the whole point of reading the branch rather than assuming it.
 */
describe.each([
  ['an empty repository', null, 'main'],
  ['a repository on main', 'headsha', 'main'],
  ['a repository on master', 'headsha', 'master'],
])('testSync against %s', (_name, head, branch) => {
  function repoTransport(): { http: Http; seen: HttpRequest[] } {
    const target = { owner: 'o', repo: 'r', branch };
    const content = readmeFor(target);
    return transport([
      // The ref: 409 is GitHub's answer for a repository with no commits.
      [
        req => req.url.includes(`/git/ref/heads/${branch}`),
        head === null ? json(409, { message: 'Git Repository is empty.' }) : json(200, { object: { sha: head } }),
      ],
      [/\/git\/trees$/, json(201, { sha: 'treesha' })],
      [/\/git\/commits$/, json(201, { sha: 'commitsha' })],
      [/\/git\/refs$/, json(201, {})],
      [req => req.method === 'PATCH', json(200, {})],
      [/\/commits\?/, json(200, [{ sha: 'commitsha' }])],
      [
        /\/git\/trees\/commitsha/,
        json(200, { truncated: false, tree: [{ path: README_PATH, sha: 'blobsha', type: 'blob' }] }),
      ],
      [/\/git\/blobs\/blobsha/, json(200, { content: btoa(content), encoding: 'base64' })],
    ]);
  }

  it('writes a commit and reads it back', async () => {
    const { http, seen } = repoTransport();
    const result = await testSync(http, 'token', { owner: 'o', repo: 'r', branch });

    expect(result).toMatchObject({ status: 'ok' });
    expect(result.status === 'ok' && result.detail).toContain(branch);
    // Every ref request went to THIS branch. The earlier version of this
    // assertion accepted main or master either way, which is to say it accepted
    // the bug it was written to catch.
    const refs = seen.filter(r => /heads\//.test(r.url));
    expect(refs.length).toBeGreaterThan(0);
    for (const req of refs) expect(req.url).toContain(`heads/${branch}`);
  });
});

/*
 * The failure this whole layer exists to prevent, driven end to end.
 *
 * With a literal `main` against a `master` repository: the ref read 404s, the
 * client reads that as "no commits yet", and the commit goes in parentless and
 * creates an orphan refs/heads/main beside the user's real data. The test
 * reports success. Every part of that is silent.
 */
describe('a master repository never grows a main branch', () => {
  function masterRepo(): { http: Http; seen: HttpRequest[] } {
    return transport([
      [/\/repos\/o\/r$/, json(200, { default_branch: 'master', private: true })],
      // main does not exist here. This is the 404 that used to read as "empty".
      [req => req.url.includes('/git/ref/heads/main'), json(404, { message: 'Not Found' })],
      [req => req.url.includes('/git/ref/heads/master'), json(200, { object: { sha: 'headsha' } })],
      [/\/git\/trees$/, json(201, { sha: 'treesha' })],
      [/\/git\/commits$/, json(201, { sha: 'commitsha' })],
      [req => req.method === 'PATCH', json(200, {})],
      [/\/commits\?/, json(200, [{ sha: 'commitsha' }])],
      [
        /\/git\/trees\/commitsha/,
        json(200, { truncated: false, tree: [{ path: README_PATH, sha: 'blobsha', type: 'blob' }] }),
      ],
      [
        /\/git\/blobs\/blobsha/,
        json(200, {
          content: btoa(readmeFor({ owner: 'o', repo: 'r', branch: 'master' })),
          encoding: 'base64',
        }),
      ],
    ]);
  }

  it('resolves the branch itself when none is stored yet', async () => {
    // An empty branch is handed to the client as "resolve it", which is what
    // turns a first-run setup on a master repository into a correct one.
    const { http, seen } = masterRepo();
    const result = await testSync(http, 'token', { owner: 'o', repo: 'r', branch: '' });

    expect(result).toMatchObject({ status: 'ok', value: { branch: 'master' } });
    expect(seen.some(r => r.url.endsWith('/repos/o/r'))).toBe(true);
    expect(seen.some(r => r.url.includes('heads/main'))).toBe(false);
  });

  it('creates no ref, because the branch it writes to already exists', async () => {
    const { http, seen } = masterRepo();
    await testSync(http, 'token', { owner: 'o', repo: 'r', branch: '' });

    // POST /git/refs is the orphan-branch call. It must not happen here.
    expect(seen.filter(r => r.url.endsWith('/git/refs'))).toEqual([]);
    // The commit has a parent, so it is on the user's history rather than beside it.
    const commit = seen.find(r => r.url.endsWith('/git/commits'))!;
    expect(JSON.parse(commit.body!).parents).toEqual(['headsha']);
  });

  it('hands the resolved branch back so the caller can store it', async () => {
    // The bug was reading it and dropping it. This is what makes it stick.
    const { http } = masterRepo();
    const result = await testSync(http, 'token', { owner: 'o', repo: 'r', branch: '' });
    expect(result.status === 'ok' && result.value.branch).toBe('master');
    expect(result.status === 'ok' && result.detail).toContain('on master');
  });
});

describe('testSync failures', () => {
  const target = { owner: 'o', repo: 'r', branch: 'main' };

  it('separates a refused read from a refused write', async () => {
    // Both are 403. Telling someone their token cannot write, when in fact it
    // cannot read, sends them to grant a permission they already have.
    const { http } = transport([[/\/git\/ref\//, json(403, { message: 'Resource not accessible' })]]);
    const result = await testSync(http, 't', target);
    expect(result.status === 'error' && result.detail).toContain('may not read');
  });

  it('separates a token that cannot write from one that is invalid', async () => {
    const forbidden = transport([[/\/git\/ref\//, json(403, { message: 'Resource not accessible' })]]);
    const result = await testSync(forbidden.http, 't', target);
    expect(result.status === 'error' && result.hint).toContain('Contents: read and write');

    const expired = transport([[/\/git\/ref\//, json(401, { message: 'Bad credentials' })]]);
    expect((await testSync(expired.http, 't', target)).detail).toContain('rejected the token');
  });

  it('fails when what comes back is not what went in', async () => {
    // A write that returns 200 and a read that returns the content are two
    // different claims, and the app depends on the second one every start.
    const { http } = transport([
      [req => req.url.includes('/git/ref/heads/'), json(200, { object: { sha: 'head' } })],
      [/\/git\/trees$/, json(201, { sha: 't' })],
      [/\/git\/commits$/, json(201, { sha: 'c' })],
      [req => req.method === 'PATCH', json(200, {})],
      [/\/commits\?/, json(200, [{ sha: 'c' }])],
      [/\/git\/trees\/c/, json(200, { truncated: false, tree: [{ path: README_PATH, sha: 'b', type: 'blob' }] })],
      [/\/git\/blobs\/b/, json(200, { content: btoa('something else'), encoding: 'base64' })],
    ]);
    expect((await testSync(http, 't', target)).detail).toContain('not what was written');
  });
});

describe('testCalendar', () => {
  const url = 'https://script.google.com/macros/s/AKfy/exec';
  const bridge = (body: unknown, status = 200) =>
    transport([[/script\.google\.com/, json(status, body)]]).http;

  it('shows a real upcoming event, because that is the proof it works', async () => {
    const start = new Date(2026, 7, 23, 14, 30).getTime();
    const http = bridge({
      ok: true,
      action: 'listEvents',
      events: [{ id: 'e', calendarId: 'c', title: 'Standup', start, end: start + 1800_000, allDay: false }],
    });
    const result = await testCalendar(http, url, 'secret');
    expect(result.status === 'ok' && result.detail).toContain('Standup at 14:30');
  });

  it('says so plainly when the week is empty', async () => {
    const http = bridge({ ok: true, action: 'listEvents', events: [] });
    expect((await testCalendar(http, url, 's')).detail).toContain('Nothing scheduled');
  });

  it('reads the failure out of the body, since Apps Script cannot set a status', async () => {
    // Not a detail: a web app built on ContentService answers HTTP 200 whatever
    // happened, so a client that told failures apart by status code could not
    // tell them apart at all. Every classification below rests on this.
    const http = bridge({ ok: false, code: 'bad-request', error: 'days out of range' });
    const result = await testCalendar(http, url, 's');
    expect(result.status).toBe('error');
  });

  /*
   * The distinction the wizard claims to make, made for real.
   *
   * The POST answers `unauthorized` for both a missing property and a wrong
   * value, so the response alone cannot tell them apart. The script's own doGet
   * can: it takes no secret, carries no calendar data, and reports whether the
   * property was ever set. It exists for this and was not being called.
   */
  it('names a missing Script Property before a secret is even sent', async () => {
    const { http, seen } = transport([
      [
        req => req.method === 'GET',
        json(200, { ok: true, secretConfigured: false, calendarServiceEnabled: true }),
      ],
    ]);
    const result = await testCalendar(http, url, 'anything');

    expect(result.status === 'error' && result.detail).toBe(
      'The deployment has no TO_HOOT_SECRET property set.',
    );
    // And it never sent the secret to a deployment that cannot check it.
    expect(seen.filter(r => r.method === 'POST')).toEqual([]);
  });

  it('says the secret is wrong when the probe says the property is set', async () => {
    const { http } = transport([
      [
        req => req.method === 'GET',
        json(200, { ok: true, secretConfigured: true, calendarServiceEnabled: true }),
      ],
      [req => req.method === 'POST', json(200, { ok: false, code: 'unauthorized', error: 'no' })],
    ]);
    const result = await testCalendar(http, url, 'wrong');
    expect(result.status === 'error' && result.detail).toBe(
      'The secret does not match the one on the deployment.',
    );
  });

  it('names the advanced service from the probe, before the call fails', async () => {
    const { http } = transport([
      [
        req => req.method === 'GET',
        json(200, { ok: true, secretConfigured: true, calendarServiceEnabled: false }),
      ],
    ]);
    const result = await testCalendar(http, url, 's');
    expect(result.status === 'error' && result.hint).toContain('Google Calendar API under Services');
  });

  it('hedges honestly when the probe itself cannot be read', async () => {
    // Without the probe the two cases genuinely cannot be told apart from here,
    // and saying so beats picking the likelier one and being confidently wrong.
    const http = bridge({ ok: false, code: 'unauthorized', error: 'secret rejected' });
    const result = await testCalendar(http, url, 's');
    expect(result.status === 'error' && result.hint).toContain('is not set on the deployment at all');
    expect(result.status === 'error' && result.hint).toContain('could not be read');
  });

  it('names the advanced service when the call itself reports it off', async () => {
    const http = bridge({ ok: false, code: 'calendar-service-disabled', error: 'Calendar is off' });
    const result = await testCalendar(http, url, 's');
    expect(result.status === 'error' && result.hint).toContain('advanced service');
  });

  it('never leaves a raw library message as the thing the reader sees', async () => {
    const http = bridge({ ok: false, code: 'bad-response', error: 'the bridge said something odd' });
    const result = await testCalendar(http, url, 's');
    expect(result.status === 'error' && result.detail).toBe('The calendar check failed.');
    expect(result.status === 'error' && result.hint).toBe('The bridge said something odd.');
  });

  it('recognises a sign-in page for what it is', async () => {
    const http = transport([[/script\.google\.com/, { status: 200, text: '<!doctype html><html>' }]]).http;
    const result = await testCalendar(http, url, 's');
    expect(result.status === 'error' && result.hint).toContain('access set to Anyone');
  });

  it('explains that a browser cannot reach Apps Script at all', async () => {
    const http: Http = async () => {
      throw new Error('Failed to fetch');
    };
    const result = await testCalendar(http, url, 's');
    expect(result.status === 'error' && result.hint).toContain('CORS preflight');
  });

  it('refuses a URL that is not a deployment before making a request', async () => {
    const http = vi.fn();
    const result = await testCalendar(http as unknown as Http, 'https://example.com/', 's');
    expect(result.status).toBe('error');
    expect(http).not.toHaveBeenCalled();
  });
});

describe('testIcs', () => {
  it('counts the events in a real feed', async () => {
    const feed = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VEVENT\nBEGIN:VEVENT\nEND:VEVENT\nEND:VCALENDAR';
    const { http } = transport([[/./, { status: 200, text: feed }]]);
    const result = await testIcs(http, 'https://calendar.google.com/x/basic.ics');
    expect(result).toMatchObject({ status: 'ok', value: 2 });
    expect(result.status === 'ok' && result.detail).toContain('read-only');
  });

  it('rejects an address that returns something else', async () => {
    const { http } = transport([[/./, { status: 200, text: '<html>' }]]);
    expect((await testIcs(http, 'https://example.com/x')).status).toBe('error');
  });
});

describe('the generated commands', () => {
  it('puts this machine absolute path in the mcp command', () => {
    expect(mcpAddCommand('/home/someone/to-hoot/apps/mcp/dist/index.js')).toBe(
      'claude mcp add to-hoot -- node /home/someone/to-hoot/apps/mcp/dist/index.js',
    );
  });

  it('names the branch only when there is one worth naming', () => {
    // Empty means the Worker should fall back to its own default. Emitting the
    // binding with no value would set it to nothing.
    expect(wranglerCommands({ pathSecret: 'a', owner: 'o', repo: 'r', branch: '' })).not.toContain(
      'GITHUB_BRANCH',
    );
    expect(
      wranglerCommands({ pathSecret: 'a', owner: 'o', repo: 'r', branch: 'master' }),
    ).toContain('GITHUB_BRANCH      # master');
  });

  it('fills the wrangler commands in with real values', () => {
    const script = wranglerCommands({
      pathSecret: 'abc123',
      owner: 'someone',
      repo: 'to-hoot-data',
      branch: 'main',
    });
    expect(script).toContain('MCP_PATH_SECRET   # abc123');
    expect(script).toContain('GITHUB_OWNER      # someone');
    expect(script).toContain('npx wrangler deploy');
    // No branch line when it is already the default; one when it is not.
    expect(script).not.toContain('GITHUB_BRANCH');
    expect(wranglerCommands({ pathSecret: 'a', owner: 'o', repo: 'r', branch: 'master' })).toContain(
      'GITHUB_BRANCH      # master',
    );
  });

  it('never puts a secret in a URL or a file', () => {
    const script = wranglerCommands({ pathSecret: 's3cret', owner: 'o', repo: 'r', branch: 'main' });
    // `wrangler secret put` prompts; the value is a comment for the human, not
    // an argument that would land in shell history as part of the command.
    expect(script).not.toMatch(/put MCP_PATH_SECRET s3cret/);
  });
});

describe('testWorker', () => {
  const url = 'https://to-hoot-mcp.someone.workers.dev/mcp/abc';

  it('runs a real tools/list and names what came back', async () => {
    const { http, seen } = transport([
      [/workers\.dev/, json(200, { result: { tools: [{ name: 'list_tasks' }, { name: 'start_timer' }] } })],
    ]);
    const result = await testWorker(http, url);
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ method: 'tools/list' });
    expect(result.status === 'ok' && result.detail).toContain('list_tasks, start_timer');
  });

  it('reads an SSE framed answer, which is the other shape MCP replies in', async () => {
    const frame = `event: message\ndata: ${JSON.stringify({ result: { tools: [{ name: 'x' }] } })}\n\n`;
    const { http } = transport([[/workers\.dev/, { status: 200, text: frame }]]);
    expect((await testWorker(http, url)).status).toBe('ok');
  });

  it('reads a 404 as the path secret rather than as a missing worker', async () => {
    const { http } = transport([[/workers\.dev/, { status: 404, text: '' }]]);
    expect((await testWorker(http, url)).detail).toContain('path secret does not match');
  });

  it('refuses a URL with no secret path before calling anything', async () => {
    const http = vi.fn();
    const result = await testWorker(http as unknown as Http, 'https://example.com');
    expect(result.status).toBe('error');
    expect(http).not.toHaveBeenCalled();
  });
});

describe('inspectRepo', () => {
  function repoWith(paths: string[], meta?: Record<string, unknown>) {
    return transport([
      [/\/commits\?/, json(200, [{ sha: 'c' }])],
      [
        /\/git\/trees\/c/,
        json(200, {
          truncated: false,
          tree: paths.map(p => ({
            path: p,
            sha: p === 'meta.json' ? 'metablob' : `sha-${p}`,
            type: 'blob',
          })),
        }),
      ],
      [
        /\/git\/blobs\/metablob/,
        json(200, {
          content: btoa(JSON.stringify({ schemaVersion: 1, devices: meta ?? {} })),
          encoding: 'base64',
        }),
      ],
      [/\/git\/blobs\//, json(200, { content: btoa('x'), encoding: 'base64' })],
    ]);
  }

  it('reports an empty repository as one with nothing to join', async () => {
    const { http } = transport([[/\/commits\?/, json(409, { message: 'Git Repository is empty.' })]]);
    const result = await readRepoContents(http);
    expect(result).toMatchObject({ hasLog: false, deviceIds: [], eventFiles: 0 });
  });

  const readRepoContents = async (http: Http) => {
    const check = await inspectRepo(http, 't', { owner: 'o', repo: 'r', branch: 'main' });
    return check.status === 'ok' ? check.value : null;
  };

  it('finds the devices that have written here', async () => {
    const { http } = repoWith([
      'README.md',
      'events/laptop/01A.json',
      'events/laptop/01B.json',
      'events/phone/01C.json',
    ]);
    const found = await readRepoContents(http);
    expect(found).toMatchObject({ hasLog: true, eventFiles: 3, deviceIds: ['laptop', 'phone'] });
  });

  it('keeps a device whose events have been compacted away', async () => {
    /*
     * meta.json outlives the event files. A device that synced and was then
     * compacted into the snapshot has no events/<id>/ path left, but its name is
     * still taken: handing it to a second machine would put two devices on one
     * prefix, which is the one thing the whole merge design rests on not
     * happening.
     */
    const { http } = repoWith(['snapshot.json', 'meta.json', 'events/phone/01C.json'], {
      laptop: { firstSeen: 1, lastSeen: 2 },
      phone: { firstSeen: 3, lastSeen: 4 },
    });
    const found = await readRepoContents(http);
    expect(found?.deviceIds).toEqual(['laptop', 'phone']);
    expect(found?.hasSnapshot).toBe(true);
    // A repository whose log is entirely in the snapshot still has a log.
    expect(found?.hasLog).toBe(true);
  });

  it('survives meta.json being unreadable rather than refusing to connect', async () => {
    const { http } = transport([
      [/\/commits\?/, json(200, [{ sha: 'c' }])],
      [
        /\/git\/trees\/c/,
        json(200, {
          truncated: false,
          tree: [
            { path: 'meta.json', sha: 'bad', type: 'blob' },
            { path: 'events/laptop/01A.json', sha: 's', type: 'blob' },
          ],
        }),
      ],
      [/\/git\/blobs\//, json(200, { content: btoa('{ not json'), encoding: 'base64' })],
    ]);
    // The paths still say who is here, which is enough to refuse a clash.
    expect((await readRepoContents(http))?.deviceIds).toEqual(['laptop']);
  });
});

describe('checkDeviceName', () => {
  it('accepts a name nobody is using', () => {
    expect(checkDeviceName('laptop', ['phone'])).toMatchObject({ status: 'ok', value: 'laptop' });
  });

  it('refuses a name another device already claims', () => {
    /*
     * Every device writes only under events/<deviceId>/, and that single
     * guarantee is what makes merging a replay rather than a reconciliation,
     * and why there is no locking in the sync engine at all. Two devices
     * sharing a name write one path concurrently and one side's events are lost
     * on the retry.
     */
    const result = checkDeviceName('laptop', ['laptop', 'phone']);
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.detail).toContain('already called');
    expect(result.status === 'error' && result.hint).toContain('without locking');
  });

  it('still refuses a name that is not a path segment, whoever holds it', () => {
    expect(checkDeviceName('my laptop', []).status).toBe('error');
  });

  it('trims before comparing, so trailing space is not a way around it', () => {
    expect(checkDeviceName('  laptop  ', ['laptop']).status).toBe('error');
  });
});

describe('testSync against a repository that already has a log', () => {
  it('joins it and says so, rather than reporting a fresh setup', async () => {
    const existing = 'events/laptop/01A.json';
    const { http } = transport([
      [/\/commits\?/, json(200, [{ sha: 'c' }])],
      [
        /\/git\/trees\/c/,
        json(200, {
          truncated: false,
          tree: [
            { path: existing, sha: 'e1', type: 'blob' },
            { path: README_PATH, sha: 'b', type: 'blob' },
          ],
        }),
      ],
      [req => req.url.includes('/git/ref/heads/'), json(200, { object: { sha: 'c' } })],
      [/\/git\/trees$/, json(201, { sha: 't' })],
      [/\/git\/commits$/, json(201, { sha: 'c' })],
      [req => req.method === 'PATCH', json(200, {})],
      [
        req => req.url.includes('/git/blobs/'),
        json(200, {
          content: btoa(readmeFor({ owner: 'o', repo: 'r', branch: 'main' })),
          encoding: 'base64',
        }),
      ],
    ]);

    const result = await testSync(http, 't', { owner: 'o', repo: 'r', branch: 'main' });
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.detail).toContain('Joined the log already here');
    expect(result.status === 'ok' && result.detail).toContain('laptop');
  });
});
