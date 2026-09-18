// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_VERSION, type Http, type HttpRequest, type HttpResponse } from '@to-hoot/core';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CLOUDFLARE_TOKEN_URL,
  DEFAULT_REPO_NAME,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_CLIENT_ID,
  GITHUB_DEVICE_CODE_URL,
  README_PATH,
  SECRET_LENGTH,
  WORKER_COMPATIBILITY_DATE,
  WORKER_COMPATIBILITY_FLAGS,
  WORKER_SCRIPT_NAME,
  checkDeviceId,
  checkDeviceName,
  createDataRepo,
  deployWorker,
  fetchWorkerBundle,
  findDataRepo,
  inspectRepo,
  generateSecret,
  joinOrCreateRepo,
  listCloudflareAccounts,
  listRepos,
  mcpAddCommand,
  multipartBody,
  pollDeviceLogin,
  readRepo,
  readmeFor,
  startDeviceLogin,
  suggestDeviceName,
  testCalendar,
  testIcs,
  testSync,
  endpointUrl,
  testWorker,
  uploadWorker,
  verifyToken,
  waitForDeviceLogin,
  workerBundleUrl,
  wranglerCommands,
  type DeviceCode,
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

  it('says how many calendars it read, so an empty week is diagnosable', async () => {
    const http = bridge({ ok: true, action: 'listEvents', calendarCount: 5, events: [] });
    expect((await testCalendar(http, url, 's')).detail).toContain('5 calendars');
  });

  it('says so plainly when the week is empty', async () => {
    const http = bridge({ ok: true, action: 'listEvents', events: [] });
    expect((await testCalendar(http, url, 's')).detail).toContain('Nothing scheduled');
  });

  it('says the deployed script is behind, because a stale one reads one calendar', async () => {
    // The user cannot see which build is deployed. Without this the app quietly
    // shows a day from one calendar and the browser shows five, and nothing on
    // screen connects the two.
    const { http } = transport([
      [
        req => req.method === 'GET',
        json(200, { ok: true, secretConfigured: true, calendarServiceEnabled: true, version: 1 }),
      ],
      [/script\.google\.com/, json(200, { ok: true, action: 'listEvents', events: [] })],
    ]);
    const result = await testCalendar(http, url, 's');
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('older version');
  });

  it('says nothing about the version when the deployment is current', async () => {
    const { http } = transport([
      [
        req => req.method === 'GET',
        json(200, {
          ok: true,
          secretConfigured: true,
          calendarServiceEnabled: true,
          version: BRIDGE_VERSION,
        }),
      ],
      [/script\.google\.com/, json(200, { ok: true, action: 'listEvents', events: [] })],
    ]);
    expect((await testCalendar(http, url, 's')).detail).not.toContain('older version');
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

  describe('composing the endpoint URL', () => {
    // The step people get wrong by hand, and every way of getting it wrong
    // arrives as the same 404 a Worker that is down would give.
    const SECRET = 'abc123';

    it('adds the path the endpoint answers on', () => {
      expect(endpointUrl('https://to-hoot-mcp.someone.workers.dev', SECRET)).toBe(
        'https://to-hoot-mcp.someone.workers.dev/mcp/abc123',
      );
    });

    it('does not leave two slashes where wrangler printed a trailing one', () => {
      expect(endpointUrl('https://to-hoot-mcp.someone.workers.dev/', SECRET)).toBe(
        'https://to-hoot-mcp.someone.workers.dev/mcp/abc123',
      );
    });

    it('adds the scheme to a hostname copied out of a terminal', () => {
      expect(endpointUrl('to-hoot-mcp.someone.workers.dev', SECRET)).toBe(
        'https://to-hoot-mcp.someone.workers.dev/mcp/abc123',
      );
    });

    it('leaves a finished endpoint exactly as it was pasted', () => {
      // Someone pasting one knows which secret is deployed on it, and that is
      // not necessarily the one held here: rotating it in the app changes
      // nothing about the Worker until the commands are run again.
      const pasted = 'https://to-hoot-mcp.someone.workers.dev/mcp/olderSecret';
      expect(endpointUrl(pasted, SECRET)).toBe(pasted);
    });

    it('is empty until there is something to compose', () => {
      expect(endpointUrl('', SECRET)).toBe('');
      expect(endpointUrl('   ', SECRET)).toBe('');
    });
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

describe('signing in with GitHub', () => {
  const form = (req: HttpRequest): Record<string, string> =>
    Object.fromEntries(new URLSearchParams(req.body ?? ''));

  it('asks for a device code with the app client id and the repo scope', async () => {
    const { http, seen } = transport([
      [
        /login\/device\/code$/,
        json(200, {
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
      ],
    ]);
    const result = await startDeviceLogin(http, { now: () => 1_000 });

    expect(result).toMatchObject({
      status: 'ok',
      value: {
        deviceCode: 'dev-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: 1_000 + 900_000,
        intervalMs: 5_000,
      },
    });
    expect(seen[0]!.url).toBe(GITHUB_DEVICE_CODE_URL);
    expect(seen[0]!.method).toBe('POST');
    // Form encoded in, JSON out: the two things GitHub's OAuth endpoints insist on.
    expect(seen[0]!.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(seen[0]!.headers?.['accept']).toBe('application/json');
    expect(form(seen[0]!)).toEqual({ client_id: GITHUB_CLIENT_ID, scope: 'repo' });
  });

  it('names a device flow that is switched off on the app', async () => {
    const { http } = transport([
      [/login\/device\/code$/, json(400, { error: 'device_flow_disabled', error_description: 'Device flow is disabled' })],
    ]);
    const result = await startDeviceLogin(http);
    expect(result).toMatchObject({ status: 'error', detail: 'Device flow is disabled' });
    expect(result.status === 'error' && result.hint).toContain('device flow');
  });

  const code: DeviceCode = {
    deviceCode: 'dev-1',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    expiresAt: 100_000,
    intervalMs: 5_000,
  };

  it('polls the token endpoint with the device grant', async () => {
    const { http, seen } = transport([[/access_token$/, json(200, { access_token: 'gho_x', token_type: 'bearer' })]]);
    expect(await pollDeviceLogin(http, code)).toEqual({ status: 'ok', token: 'gho_x' });
    expect(seen[0]!.url).toBe(GITHUB_ACCESS_TOKEN_URL);
    expect(form(seen[0]!)).toEqual({
      client_id: GITHUB_CLIENT_ID,
      device_code: 'dev-1',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
  });

  it('keeps waiting on authorization_pending and backs off on slow_down', async () => {
    // Both arrive as 200 with an error field: they are the ordinary shape of a
    // person who has not finished typing, not failures.
    const pending = transport([[/access_token$/, json(200, { error: 'authorization_pending' })]]);
    expect(await pollDeviceLogin(pending.http, code)).toEqual({ status: 'pending', intervalMs: 5_000 });

    const slow = transport([[/access_token$/, json(200, { error: 'slow_down', interval: 10 })]]);
    expect(await pollDeviceLogin(slow.http, code)).toEqual({ status: 'pending', intervalMs: 10_000 });

    const slowUnsaid = transport([[/access_token$/, json(200, { error: 'slow_down' })]]);
    expect(await pollDeviceLogin(slowUnsaid.http, code)).toEqual({ status: 'pending', intervalMs: 10_000 });
  });

  it.each([
    ['expired_token', 'The code expired before it was entered.'],
    ['access_denied', 'The sign-in was cancelled on GitHub.'],
  ])('turns %s into a sentence', async (error, detail) => {
    const { http } = transport([[/access_token$/, json(200, { error })]]);
    expect(await pollDeviceLogin(http, code)).toMatchObject({ status: 'error', detail });
  });

  it('waits through the pending polls, at the interval GitHub asks for', async () => {
    let calls = 0;
    const http: Http = async () => {
      calls++;
      const body =
        calls === 1
          ? { error: 'authorization_pending' }
          : calls === 2
            ? { error: 'slow_down', interval: 8 }
            : { access_token: 'gho_done' };
      return { status: 200, headers: {}, text: async () => JSON.stringify(body) };
    };
    const slept: number[] = [];
    const result = await waitForDeviceLogin(http, code, {
      now: () => 0,
      sleep: async ms => void slept.push(ms),
    });
    expect(result).toMatchObject({ status: 'ok', value: 'gho_done' });
    // Five seconds after the first pending answer, eight after GitHub raised it.
    expect(slept).toEqual([5_000, 8_000]);
  });

  it('gives up when the code has expired rather than polling forever', async () => {
    const { http, seen } = transport([[/access_token$/, json(200, { error: 'authorization_pending' })]]);
    let clock = 0;
    const result = await waitForDeviceLogin(http, code, {
      now: () => clock,
      sleep: async () => {
        clock += 60_000;
      },
    });
    expect(result).toMatchObject({ status: 'error', detail: /expired/ });
    // 100 seconds of life at a 5 second interval, minus the poll that expired.
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it('stops when the person cancels', async () => {
    const { http, seen } = transport([[/access_token$/, json(200, { error: 'authorization_pending' })]]);
    let cancelled = false;
    const result = await waitForDeviceLogin(http, code, {
      now: () => 0,
      sleep: async () => {
        cancelled = true;
      },
      cancelled: () => cancelled,
    });
    expect(result).toMatchObject({ status: 'error', detail: 'Sign-in cancelled.' });
    expect(seen).toHaveLength(1);
  });
});

describe('finding the data repository', () => {
  const listing = (repos: Array<[full: string, branch: string]>) =>
    json(200, repos.map(([full_name, default_branch]) => ({ full_name, default_branch })));

  it('finds the account own repository by its default name, whatever the case', async () => {
    const { http } = transport([
      [/\/user\/repos/, listing([['someone/other', 'main'], ['someone/To-Hoot-Data', 'master']])],
      [/\/repos\/someone\/To-Hoot-Data$/, json(200, { default_branch: 'master', private: true })],
    ]);
    const result = await findDataRepo(http, 't', 'someone');
    expect(result).toMatchObject({
      status: 'ok',
      value: { owner: 'someone', repo: 'To-Hoot-Data', branch: 'master' },
    });
  });

  it('ignores a repository of that name that belongs to somebody else', async () => {
    const { http } = transport([[/\/user\/repos/, listing([['org/to-hoot-data', 'main']])]]);
    const result = await findDataRepo(http, 't', 'someone');
    expect(result).toMatchObject({ status: 'ok', value: null });
    expect(result.detail).toContain(DEFAULT_REPO_NAME);
  });

  it('creates the repository when there is none, and says so', async () => {
    const { http, seen } = transport([
      [/\/user\/repos\?/, listing([])],
      [/\/user\/repos$/, json(201, { full_name: 'someone/to-hoot-data', default_branch: 'main' })],
    ]);
    const result = await joinOrCreateRepo(http, 't', 'someone');
    expect(result).toMatchObject({
      status: 'ok',
      value: { created: true, target: { owner: 'someone', repo: 'to-hoot-data' }, contents: { hasLog: false } },
    });
    const create = seen.find(r => r.method === 'POST')!;
    expect(JSON.parse(create.body!)).toMatchObject({ name: 'to-hoot-data', private: true });
  });

  it('joins a repository that already holds a log, naming the devices in it', async () => {
    const { http } = transport([
      [/\/user\/repos\?/, listing([['someone/to-hoot-data', 'main']])],
      [/\/repos\/someone\/to-hoot-data$/, json(200, { default_branch: 'main', private: true })],
      [/\/commits\?/, json(200, [{ sha: 'c' }])],
      [
        /\/git\/trees\/c/,
        json(200, {
          truncated: false,
          tree: [
            { path: 'events/desktop/01A.json', sha: 'e1', type: 'blob' },
            { path: 'meta.json', sha: 'm', type: 'blob' },
          ],
        }),
      ],
      [
        /\/git\/blobs\/m/,
        json(200, {
          content: btoa(JSON.stringify({ schemaVersion: 1, devices: { desktop: { firstSeen: 1, lastSeen: 2 }, phone: { firstSeen: 1, lastSeen: 2 } } })),
          encoding: 'base64',
        }),
      ],
    ]);
    const result = await joinOrCreateRepo(http, 't', 'someone');
    expect(result).toMatchObject({
      status: 'ok',
      value: { created: false, contents: { hasLog: true, deviceIds: ['desktop', 'phone'] } },
    });
    expect(result.detail).toContain('desktop, phone');
  });

  it('passes a failure to create straight through', async () => {
    const { http } = transport([
      [/\/user\/repos\?/, listing([])],
      [/\/user\/repos$/, json(403, { message: 'Resource not accessible by personal access token' })],
    ]);
    expect(await joinOrCreateRepo(http, 't', 'someone')).toMatchObject({ status: 'error' });
  });
});

describe('suggestDeviceName', () => {
  it('names the device after what the shell says it is', () => {
    expect(suggestDeviceName('android', [])).toBe('phone');
    expect(suggestDeviceName('desktop', [])).toBe('desktop');
    expect(suggestDeviceName('browser', [])).toBe('browser');
    expect(suggestDeviceName(undefined, [])).toBe('browser');
  });

  it('steps past names already writing to the repository', () => {
    // A second phone is a real thing to own, and it must not share a folder
    // with the first: every device writes only under its own prefix.
    expect(suggestDeviceName('android', ['phone'])).toBe('phone-2');
    expect(suggestDeviceName('android', ['phone', 'phone-2'])).toBe('phone-3');
  });
});

describe('deploying the Worker from the app', () => {
  const ACCOUNT = 'acc-1';
  const okCf = (result: unknown) => json(200, { success: true, errors: [], result });
  const cfError = (status: number, message: string) => json(status, { success: false, errors: [{ code: 1, message }] });

  it('sends the token creation page the permission set it needs', () => {
    const url = new URL(CLOUDFLARE_TOKEN_URL);
    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/profile/api-tokens');
    const groups = JSON.parse(url.searchParams.get('permissionGroupKeys')!) as Array<{ key: string; type: string }>;
    expect(groups).toEqual(
      expect.arrayContaining([
        { key: 'workers_scripts', type: 'edit' },
        { key: 'account_settings', type: 'read' },
      ]),
    );
    expect(url.searchParams.get('name')).toBe('ToHoot');
  });

  it('mirrors the compatibility settings wrangler.jsonc deploys with', () => {
    // Two copies of one fact, and this is what notices them drifting: the
    // endpoint the app deploys has to run the way the one wrangler deploys runs.
    const jsonc = readFileSync(
      fileURLToPath(new URL('../../../apps/worker/wrangler.jsonc', import.meta.url)),
      'utf8',
    );
    expect(jsonc).toContain(`"compatibility_date": "${WORKER_COMPATIBILITY_DATE}"`);
    expect(jsonc).toContain(`"compatibility_flags": ${JSON.stringify(WORKER_COMPATIBILITY_FLAGS)}`);
    expect(jsonc).toContain(`"name": "${WORKER_SCRIPT_NAME}"`);
  });

  it('downloads the bundle for this build from the release', () => {
    expect(workerBundleUrl('0.6.0')).toBe(
      'https://github.com/danieltyukov/to-hoot/releases/download/v0.6.0/to-hoot-worker.mjs',
    );
  });

  it('explains a release with no bundle rather than uploading nothing', async () => {
    const { http } = transport([[/releases\/download/, { status: 404, text: 'Not Found' }]]);
    const result = await fetchWorkerBundle(http);
    expect(result).toMatchObject({ status: 'error', detail: /No Worker bundle is published/ });
  });

  it('refuses a download that is not a module', async () => {
    const { http } = transport([[/releases\/download/, { status: 200, text: '<html>sign in</html>' }]]);
    expect(await fetchWorkerBundle(http)).toMatchObject({ status: 'error', detail: /not a Worker module/ });
  });

  it('accepts the module shape esbuild actually writes', async () => {
    // Wrangler's bundle ends in `export {\n  index_default as default\n};`, with
    // a space, which is what the first version of this check did not accept.
    const tail = 'var index_default = { fetch() {} };\nexport {\n  index_default as default\n};\n';
    const { http } = transport([[/releases\/download/, { status: 200, text: tail }]]);
    expect(await fetchWorkerBundle(http)).toMatchObject({ status: 'ok', value: tail });
  });

  it('lists the accounts the token can see, and names a rejected token', async () => {
    const ok = transport([[/\/accounts$/, okCf([{ id: ACCOUNT, name: 'Someone' }])]]);
    expect(await listCloudflareAccounts(ok.http, 'cf')).toMatchObject({
      status: 'ok',
      value: [{ id: ACCOUNT, name: 'Someone' }],
    });
    expect(ok.seen[0]!.headers?.['authorization']).toBe('Bearer cf');

    const bad = transport([[/\/accounts$/, cfError(403, 'Authentication error')]]);
    const result = await listCloudflareAccounts(bad.http, 'cf');
    expect(result).toMatchObject({ status: 'error', detail: 'Cloudflare rejected the token.' });
    expect(result.status === 'error' && result.hint).toContain('Workers Scripts: Edit');
  });

  it('builds a multipart body with the metadata and the module parts', () => {
    const body = multipartBody(
      [
        { name: 'metadata', content: '{"a":1}', contentType: 'application/json' },
        { name: 'index.mjs', filename: 'index.mjs', content: 'export default 1', contentType: 'application/javascript+module' },
      ],
      'B',
    );
    expect(body).toBe(
      [
        '--B',
        'Content-Disposition: form-data; name="metadata"',
        'Content-Type: application/json',
        '',
        '{"a":1}',
        '--B',
        'Content-Disposition: form-data; name="index.mjs"; filename="index.mjs"',
        'Content-Type: application/javascript+module',
        '',
        'export default 1',
        '--B--',
        '',
      ].join('\r\n'),
    );
  });

  function deployRoutes(overrides: Array<[RegExp | ((req: HttpRequest) => boolean), Reply]> = []) {
    return transport([
      ...overrides,
      [req => req.method === 'PUT' && /workers\/scripts\/to-hoot-mcp$/.test(req.url), okCf({ id: 'to-hoot-mcp' })],
      [req => req.method === 'GET' && /workers\/subdomain$/.test(req.url), okCf({ subdomain: 'someone' })],
      [req => req.method === 'POST' && /scripts\/to-hoot-mcp\/subdomain$/.test(req.url), okCf({ enabled: true })],
      [/workers\.dev\/mcp\//, json(200, { result: { tools: [{ name: 'list_tasks' }, { name: 'add_task' }] } })],
    ]);
  }

  it('uploads the module with every secret as a binding, then routes it', async () => {
    const { http, seen } = deployRoutes();
    const result = await uploadWorker(http, {
      apiToken: 'cf',
      accountId: ACCOUNT,
      bundle: 'export default {}',
      secrets: { MCP_PATH_SECRET: 's'.repeat(40), GITHUB_OWNER: 'someone', GITHUB_REPO: 'to-hoot-data', GITHUB_TOKEN: 'gho_x', GITHUB_BRANCH: '' },
      boundary: 'B',
    });
    expect(result).toMatchObject({
      status: 'ok',
      value: { scriptName: 'to-hoot-mcp', subdomain: 'someone', base: 'https://to-hoot-mcp.someone.workers.dev' },
    });

    const upload = seen.find(r => r.method === 'PUT')!;
    expect(upload.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/to-hoot-mcp`);
    expect(upload.headers?.['content-type']).toBe('multipart/form-data; boundary=B');
    const metadataText = /name="metadata"\r\nContent-Type: application\/json\r\n\r\n(.*?)\r\n--B/s.exec(upload.body!)![1]!;
    const metadata = JSON.parse(metadataText) as {
      main_module: string;
      compatibility_date: string;
      compatibility_flags: string[];
      bindings: Array<{ type: string; name: string; text: string }>;
    };
    expect(metadata.main_module).toBe('index.mjs');
    expect(metadata.compatibility_date).toBe(WORKER_COMPATIBILITY_DATE);
    expect(metadata.compatibility_flags).toEqual(WORKER_COMPATIBILITY_FLAGS);
    // An empty branch is not a binding: the Worker's own fallback is the
    // repository's default, and an empty string would set it to nothing.
    expect(metadata.bindings.map(b => b.name).sort()).toEqual(
      ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN', 'MCP_PATH_SECRET'],
    );
    expect(metadata.bindings.every(b => b.type === 'secret_text')).toBe(true);
    expect(upload.body).toContain('filename="index.mjs"');
    expect(upload.body).toContain('export default {}');

    // The route is switched on for the script after the upload.
    const enable = seen.find(r => r.method === 'POST' && r.url.endsWith('/subdomain'))!;
    expect(JSON.parse(enable.body!)).toEqual({ enabled: true, previews_enabled: false });
  });

  it('registers a workers.dev subdomain for an account that has none', async () => {
    const { http, seen } = deployRoutes([
      [req => req.method === 'GET' && /workers\/subdomain$/.test(req.url), cfError(404, 'no subdomain')],
      [req => req.method === 'PUT' && /workers\/subdomain$/.test(req.url), okCf({ subdomain: 'to-hoot-abc123' })],
    ]);
    const result = await uploadWorker(http, {
      apiToken: 'cf',
      accountId: ACCOUNT,
      bundle: 'export default {}',
      secrets: {},
      randomSuffix: () => 'abc123',
    });
    expect(result).toMatchObject({ status: 'ok', value: { subdomain: 'to-hoot-abc123' } });
    const register = seen.find(r => r.method === 'PUT' && r.url.endsWith('/workers/subdomain'))!;
    expect(JSON.parse(register.body!)).toEqual({ subdomain: 'to-hoot-abc123' });
  });

  it('surfaces Cloudflare own message when the upload is refused', async () => {
    const { http } = deployRoutes([
      [req => req.method === 'PUT' && /workers\/scripts/.test(req.url), cfError(400, 'Uncaught SyntaxError: Unexpected token')],
    ]);
    const result = await uploadWorker(http, { apiToken: 'cf', accountId: ACCOUNT, bundle: 'x', secrets: {} });
    expect(result).toMatchObject({ status: 'error', detail: 'Uncaught SyntaxError: Unexpected token' });
  });

  it('proves the endpoint answers, retrying while the hostname settles', async () => {
    let checks = 0;
    const { http } = deployRoutes([
      [
        req => /workers\.dev\/mcp\//.test(req.url) && ++checks === 1,
        { status: 530, text: 'not yet' },
      ],
    ]);
    const slept: number[] = [];
    const result = await deployWorker(
      http,
      { apiToken: 'cf', accountId: ACCOUNT, bundle: 'export default {}', secrets: {}, pathSecret: 'p'.repeat(40) },
      { sleep: async ms => void slept.push(ms) },
    );
    expect(result).toMatchObject({
      status: 'ok',
      value: { endpoint: `https://to-hoot-mcp.someone.workers.dev/mcp/${'p'.repeat(40)}`, tools: ['list_tasks', 'add_task'] },
    });
    expect(slept).toEqual([3000]);
    expect(checks).toBe(2);
  });

  it('says the upload landed even when the endpoint has not answered yet', async () => {
    const { http } = deployRoutes([[/workers\.dev\/mcp\//, { status: 530, text: 'not yet' }]]);
    const result = await deployWorker(
      http,
      { apiToken: 'cf', accountId: ACCOUNT, bundle: 'export default {}', secrets: {}, pathSecret: 'p'.repeat(40) },
      { sleep: async () => undefined, attempts: 2 },
    );
    expect(result).toMatchObject({ status: 'error', detail: /Deployed to https:\/\/to-hoot-mcp\.someone\.workers\.dev, but/ });
  });
});
