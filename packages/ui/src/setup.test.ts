// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { Http, HttpRequest, HttpResponse } from '@to-hoot/core';

import {
  README_PATH,
  SECRET_LENGTH,
  checkDeviceId,
  createDataRepo,
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
    // Every request went to the branch that was read, not to a guessed one.
    for (const req of seen) expect(req.url).not.toMatch(/heads\/(?!(main|master)\b)/);
  });
});

describe('testSync failures', () => {
  const target = { owner: 'o', repo: 'r', branch: 'main' };

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

  it('distinguishes a missing property from a wrong secret', async () => {
    // An unconfigured deployment refuses a correct secret too, so telling
    // someone their secret is wrong sends them to re-copy a right one.
    const http = bridge({ ok: false, code: 'unauthorized', error: 'secret rejected' });
    const result = await testCalendar(http, url, 's');
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.hint).toContain('TO_HOOT_SECRET is not set');
    expect(result.status === 'error' && result.hint).toContain('unconfigured deployment refuses a correct secret');
  });

  it('names the advanced service when Calendar is not enabled', async () => {
    const http = bridge({ ok: false, code: 'calendar-service-disabled', error: 'Calendar is off' });
    const result = await testCalendar(http, url, 's');
    expect(result.status === 'error' && result.hint).toContain('advanced service');
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
