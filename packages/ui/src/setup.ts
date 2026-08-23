import {
  BranchNotFoundError,
  CalendarBridgeClient,
  DEVICE_ID_RULE,
  GitHubClient,
  RepositoryNotVisibleError,
  httpStatusOf,
  isValidDeviceId,
  type BridgeEvent,
  type Http,
} from '@to-hoot/core';

/*
 * What the setup wizard does, with no React in it.
 *
 * Every check here makes a real call. A step that only validates syntax is a
 * step that passes at setup and fails a week later somewhere with no wizard
 * around to explain it, so each one performs the actual operation it is
 * promising will work: the sync check writes a commit and reads it back, the
 * calendar check lists real events, the worker check runs a real tools/list.
 */

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/**
 * Alphanumeric, 62 symbols. No punctuation, because these values are pasted
 * into a URL path, a shell command and a Google properties field, and every
 * character that needs escaping in one of those is a support question.
 */
const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 40 characters, about 238 bits.
 *
 * The brief's floor is 32 and this is deliberately over it. The Apps Script
 * bridge cannot throttle wrong-secret attempts (Apps Script has no cheap
 * persistent counter) and `doGet` reveals whether a deployment is configured
 * without authenticating. Both are acceptable only because guessing is
 * hopeless, so the length is the entire security argument and is not a place to
 * economise for the sake of a shorter thing to paste.
 */
export const SECRET_LENGTH = 40;

/**
 * A secret from the platform CSPRNG.
 *
 * Rejection sampling rather than `% 62`: 256 is not a multiple of 62, so the
 * modulo would make the first eight letters of the alphabet slightly likelier
 * than the rest. The bias is small and there is no reason to accept any.
 *
 * The user is never asked to choose one and is never offered a default. A
 * human-chosen secret in front of a public `/exec` URL is the failure this
 * whole function exists to prevent.
 */
export function generateSecret(length: number = SECRET_LENGTH): string {
  const source = globalThis.crypto;
  if (source?.getRandomValues === undefined) {
    // Refusing is the only safe answer. Falling back to Math.random would
    // produce something that looks exactly as random as the real thing.
    throw new Error('no CSPRNG available; refusing to generate a weak secret');
  }
  const limit = 256 - (256 % SECRET_ALPHABET.length);
  const out: string[] = [];
  // getRandomValues refuses more than 65536 bytes in one call, so the buffer is
  // capped and the loop refills it. Twice the remaining length covers the
  // rejected bytes without looping often.
  const buffer = new Uint8Array(Math.min(65_536, Math.max(64, length * 2)));
  while (out.length < length) {
    source.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= limit) continue;
      out.push(SECRET_ALPHABET[byte % SECRET_ALPHABET.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

export type Check<T> =
  | { status: 'ok'; detail: string; value: T }
  | { status: 'error'; detail: string; hint?: string };

/** The name a device gives itself, checked where the user types it. */
export function checkDeviceId(value: string): Check<string> {
  const trimmed = value.trim();
  if (trimmed === '') return { status: 'error', detail: 'A device needs a name.' };
  if (!isValidDeviceId(trimmed)) {
    return {
      status: 'error',
      detail: `"${trimmed}" cannot be used as a folder name.`,
      // Not cosmetic: this value becomes a path segment in the data repo, and a
      // bad one writes events where no reader looks.
      hint: DEVICE_ID_RULE,
    };
  }
  return { status: 'ok', detail: `Events will be written under events/${trimmed}/.`, value: trimmed };
}

interface Json {
  status: number;
  body: unknown;
}

async function api(
  http: Http,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Json> {
  const res = await http({
    url: `${GITHUB_API}${path}`,
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed };
}

function field(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** The message GitHub itself gave, so the user sees the real reason. */
function apiMessage(res: Json, fallback: string): string {
  return field(res.body, 'message') ?? fallback;
}

export interface GitHubAccount {
  login: string;
  name?: string | undefined;
}

/** Verifies a token and reports whose it is, which is the check that matters. */
export async function verifyToken(http: Http, token: string): Promise<Check<GitHubAccount>> {
  if (token.trim() === '') return { status: 'error', detail: 'Paste a token first.' };
  let res: Json;
  try {
    res = await api(http, token.trim(), 'GET', '/user');
  } catch (err) {
    return { status: 'error', detail: transportMessage(err) };
  }
  if (res.status === 401) {
    return { status: 'error', detail: 'GitHub rejected the token.', hint: 'Expired, revoked, or mistyped.' };
  }
  if (res.status !== 200) {
    return { status: 'error', detail: apiMessage(res, `GitHub answered ${res.status}.`) };
  }
  const login = field(res.body, 'login');
  if (login === undefined) return { status: 'error', detail: 'GitHub answered without an account.' };
  return {
    status: 'ok',
    detail: `Signed in as ${login}.`,
    value: { login, name: field(res.body, 'name') },
  };
}

export interface RepoTarget {
  owner: string;
  repo: string;
  /** Read from the API, never assumed. Empty when the repo has no commits yet. */
  branch: string;
}

/** Defaults to the account's own default for a new repository, not to `main`. */
export const FALLBACK_BRANCH = 'main';

/**
 * The repository's real default branch.
 *
 * Never assumed to be `main`. A repo created through `gh repo create`, or under
 * an account whose default is still the old one, comes out as `master`, and
 * every read and write would then go to a branch that does not exist.
 */
export async function readRepo(
  http: Http,
  token: string,
  owner: string,
  repo: string,
): Promise<Check<RepoTarget>> {
  let res: Json;
  try {
    res = await api(http, token, 'GET', `/repos/${owner}/${repo}`);
  } catch (err) {
    return { status: 'error', detail: transportMessage(err) };
  }
  if (res.status === 404) {
    return {
      status: 'error',
      detail: `${owner}/${repo} is not visible to this token.`,
      // 404 is what GitHub answers for both, and telling the user only one of
      // them sends half of them looking in the wrong place.
      hint: 'It may not exist, or the token may not grant access to it.',
    };
  }
  if (res.status !== 200) return { status: 'error', detail: apiMessage(res, `GitHub answered ${res.status}.`) };

  const branch = field(res.body, 'default_branch') ?? FALLBACK_BRANCH;
  const isPrivate = (res.body as Record<string, unknown>).private === true;
  return {
    status: 'ok',
    detail: isPrivate
      ? `${owner}/${repo}, private, default branch ${branch}.`
      : `${owner}/${repo} is PUBLIC. Your tasks would be readable by anyone.`,
    value: { owner, repo, branch },
  };
}

/** Every repository the token can write to, for the "use an existing one" path. */
export async function listRepos(http: Http, token: string): Promise<Check<RepoTarget[]>> {
  let res: Json;
  try {
    res = await api(http, token, 'GET', '/user/repos?per_page=100&sort=updated&affiliation=owner');
  } catch (err) {
    return { status: 'error', detail: transportMessage(err) };
  }
  if (res.status !== 200) return { status: 'error', detail: apiMessage(res, `GitHub answered ${res.status}.`) };
  const rows = Array.isArray(res.body) ? res.body : [];
  const repos = rows.flatMap((row): RepoTarget[] => {
    const full = field(row, 'full_name');
    if (full === undefined) return [];
    const [owner, repo] = full.split('/');
    if (owner === undefined || repo === undefined) return [];
    return [{ owner, repo, branch: field(row, 'default_branch') ?? FALLBACK_BRANCH }];
  });
  return { status: 'ok', detail: `${repos.length} repositories.`, value: repos };
}

/** Creates the private data repository through the API. */
export async function createDataRepo(
  http: Http,
  token: string,
  name: string,
): Promise<Check<RepoTarget>> {
  if (name.trim() === '') return { status: 'error', detail: 'Give the repository a name.' };
  let res: Json;
  try {
    res = await api(http, token, 'POST', '/user/repos', {
      name: name.trim(),
      private: true,
      description: 'to-hoot data. Tasks and tracked time, synced between devices.',
      // No auto_init: an empty repository is exactly what the sync engine
      // expects, and it creates the branch itself on the first push.
      auto_init: false,
    });
  } catch (err) {
    return { status: 'error', detail: transportMessage(err) };
  }
  if (res.status === 403) {
    return {
      status: 'error',
      detail: 'This token may not create repositories.',
      hint: 'A fine-grained token needs Administration: write, or create the repository yourself and select it.',
    };
  }
  if (res.status === 422) {
    return { status: 'error', detail: apiMessage(res, 'A repository with that name already exists.') };
  }
  if (res.status !== 201) return { status: 'error', detail: apiMessage(res, `GitHub answered ${res.status}.`) };

  const full = field(res.body, 'full_name') ?? '';
  const [owner, repo] = full.split('/');
  if (owner === undefined || repo === undefined) {
    return { status: 'error', detail: 'GitHub created the repository but did not name it.' };
  }
  return {
    status: 'ok',
    detail: `Created ${full}, private and empty.`,
    // A repository created with no commits has no ref at all yet, so the
    // branch is whatever the account's default turns out to be. Read rather
    // than guessed, for the same reason as everywhere else.
    value: { owner, repo, branch: field(res.body, 'default_branch') ?? FALLBACK_BRANCH },
  };
}

/** The Script Property the deployed bridge reads its secret from. */
export const SECRET_PROPERTY_NAME = 'TO_HOOT_SECRET';

export const README_PATH = 'README.md';

/** What the connection test writes. Also what a curious visitor to the repo reads. */
export function readmeFor(target: RepoTarget): string {
  return [
    '# to-hoot data',
    '',
    'Tasks and tracked time, synced between devices by',
    '[to-hoot](https://github.com/danieltyukov/to-hoot).',
    '',
    'Everything here is an append-only event log under `events/<device>/`, plus a',
    'periodic `snapshot.json`. Editing these files by hand is possible and',
    'unwise: the app replays them and last write wins per field.',
    '',
    `Default branch: \`${target.branch}\`.`,
    '',
    'Deleting this repository deletes the synced history. Each device keeps its',
    'own local copy until it is uninstalled.',
    '',
  ].join('\n');
}

/**
 * Writes a commit and reads it back.
 *
 * Round-tripping rather than just writing, because a write that returns 200 and
 * a read that returns the content are different claims, and it is the second
 * one the app depends on every time it starts.
 *
 * Works against all three shapes a data repo can be in: no commits at all
 * (`commitFiles` creates the ref), a `main` default, and a `master` default.
 * The branch is whatever `readRepo` reported.
 */
export async function testSync(
  http: Http,
  token: string,
  target: RepoTarget,
): Promise<Check<RepoTarget>> {
  const client = new GitHubClient(http, {
    owner: target.owner,
    repo: target.repo,
    token,
    // Empty is handed over as undefined, which makes the client resolve the
    // repository's own default and cache it. Passing a guessed name instead is
    // how a `master` repository ends up with an orphan `main`.
    ...(target.branch === '' ? {} : { branch: target.branch }),
  });

  try {
    // Whatever the client will actually use, resolved before anything is
    // written, so the README and the saved setting name the same branch.
    const branch = await client.branchName();
    const resolved: RepoTarget = { ...target, branch };
    const expected = readmeFor(resolved);

    const outcome = await client.commitFiles('to-hoot: set up data repository', [
      { path: README_PATH, content: expected },
    ]);
    if (outcome === 'conflict') {
      return {
        status: 'error',
        detail: 'Another device wrote to the branch at the same moment.',
        hint: 'Test again; this resolves itself.',
      };
    }

    const head = await client.latestCommit();
    if (head === 'not-modified') {
      return { status: 'error', detail: 'GitHub reported no commit after writing one.' };
    }
    const entry = (await client.listTree(head.sha)).find(item => item.path === README_PATH);
    if (entry === undefined) {
      return { status: 'error', detail: 'The commit landed but the file is not in the tree.' };
    }
    const read = await client.getBlob(entry.sha);
    if (read.trim() !== expected.trim()) {
      return { status: 'error', detail: 'What came back is not what was written.' };
    }
    return {
      status: 'ok',
      detail: `Wrote and read back ${README_PATH} on ${branch}.`,
      value: resolved,
    };
  } catch (err) {
    return { status: 'error', ...syncFailure(err, target) };
  }
}

function syncFailure(err: unknown, target: RepoTarget): { detail: string; hint?: string } {
  const status = httpStatusOf(err);
  const method = (err as { method?: unknown } | null)?.method;

  if (status === 401) return { detail: 'GitHub rejected the token.', hint: 'Expired or revoked.' };
  if (status === 403) {
    // Which request was refused decides which permission is missing. Telling
    // someone their token cannot write, when in fact it cannot read, sends them
    // to grant a permission they already have.
    return method === 'GET'
      ? {
          detail: 'The token may not read this repository.',
          hint: 'A fine-grained token needs Contents: read and write, and this repository has to be in its list.',
        }
      : {
          detail: 'The token may read this repository but not write to it.',
          hint: 'A fine-grained token needs Contents: read and write on this repository.',
        };
  }
  if (err instanceof BranchNotFoundError) {
    return {
      detail: `This repository has no branch called ${err.branch}.`,
      hint: `Its default branch is ${err.defaultBranch}. Select the repository again to pick that up.`,
    };
  }
  if (err instanceof RepositoryNotVisibleError) {
    return {
      detail: `${target.owner}/${target.repo} is not visible to this token.`,
      hint: 'It may not exist, may have been renamed, or the token may no longer cover it.',
    };
  }
  if (status === 404) {
    return {
      detail: `Nothing found at ${target.owner}/${target.repo}.`,
      hint: 'Check the repository still exists and the token still covers it.',
    };
  }
  if (status === 409 || status === 422) {
    return { detail: 'GitHub refused the write.', hint: messageOf(err) };
  }
  return { detail: messageOf(err) };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function transportMessage(err: unknown): string {
  return `Could not reach GitHub: ${messageOf(err)}`;
}

export interface DeploymentProbe {
  secretConfigured: boolean;
  calendarServiceEnabled: boolean;
}

/**
 * Asks the deployment about itself, before sending it a secret.
 *
 * The script's `doGet` answers this unauthenticated and carries no calendar
 * data, deliberately: a GET reaches Google with its query string in the logs, so
 * it takes no secret and can therefore say nothing worth stealing. What it does
 * say is the two things that are invisible from outside, and that is what turns
 * a hedged "one of these two things" into an answer.
 *
 * Null when the probe itself could not be read, which the POST below will then
 * report on its own terms.
 */
export async function probeDeployment(http: Http, execUrl: string): Promise<DeploymentProbe | null> {
  try {
    const res = await http({ url: execUrl.trim(), method: 'GET' });
    if (res.status !== 200) return null;
    const body: unknown = JSON.parse(await res.text());
    if (typeof body !== 'object' || body === null) return null;
    const { secretConfigured, calendarServiceEnabled } = body as Record<string, unknown>;
    if (typeof secretConfigured !== 'boolean') return null;
    return {
      secretConfigured,
      calendarServiceEnabled: calendarServiceEnabled === true,
    };
  } catch {
    return null;
  }
}

/**
 * Calls the calendar bridge for real and names the failure.
 *
 * The failures below are indistinguishable to anyone reading a generic error,
 * and each has a completely different fix. The one that cannot be told apart
 * from the response alone is a deployment with no secret set, because it refuses
 * a correct secret exactly as it refuses a wrong one, so the probe above is
 * asked first and its answer is what makes the message definite.
 */
export async function testCalendar(
  http: Http,
  execUrl: string,
  secret: string,
  now: number = Date.now(),
): Promise<Check<BridgeEvent[]>> {
  if (!/^https:\/\/script\.google\.com\/.*\/exec$/.test(execUrl.trim())) {
    return {
      status: 'error',
      detail: 'That does not look like a deployment URL.',
      hint: 'It ends in /exec and comes from Deploy, Manage deployments.',
    };
  }
  const probe = await probeDeployment(http, execUrl);
  if (probe !== null && !probe.secretConfigured) {
    return {
      status: 'error',
      detail: 'The deployment has no TO_HOOT_SECRET property set.',
      hint: 'Project Settings, Script Properties. Until it is there the script refuses every request, including one carrying the right secret.',
    };
  }
  if (probe !== null && !probe.calendarServiceEnabled) {
    return {
      status: 'error',
      detail: 'The deployment cannot reach Calendar.',
      hint: 'In the Apps Script editor, add Google Calendar API under Services, then redeploy.',
    };
  }

  const client = new CalendarBridgeClient(http, { execUrl: execUrl.trim(), secret });
  try {
    const events = await client.listEvents({ from: now, days: 7 });
    return {
      status: 'ok',
      detail:
        events.length === 0
          ? 'Connected. Nothing scheduled in the next seven days.'
          : `Connected. Next: ${describe(events[0]!)}.`,
      value: events,
    };
  } catch (err) {
    return { status: 'error', ...calendarFailure(err, probe) };
  }
}

function describe(event: BridgeEvent): string {
  const at = new Date(event.start);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${event.title} at ${hh}:${mm}`;
}

function calendarFailure(
  err: unknown,
  probe: DeploymentProbe | null,
): { detail: string; hint?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  const status = (err as { status?: unknown } | null)?.status;

  if (code === 'unauthorized') {
    // With a probe in hand this is definite: the deployment said the property
    // is set, so the only thing left is that the value does not match. Without
    // one, the two cases genuinely cannot be told apart from here, and saying
    // so is better than picking the likelier of them.
    return probe?.secretConfigured === true
      ? {
          detail: 'The secret does not match the one on the deployment.',
          hint: `The deployment has ${SECRET_PROPERTY_NAME} set, so copy the value above into it again.`,
        }
      : {
          detail: 'The script refused the secret.',
          hint: `Either the value does not match, or ${SECRET_PROPERTY_NAME} is not set on the deployment at all. The probe that would tell these apart could not be read.`,
        };
  }
  if (code === 'calendar-service-disabled') {
    return {
      detail: 'The script cannot reach Calendar.',
      hint: 'In the Apps Script editor, add the Calendar advanced service under Services.',
    };
  }
  if (code === 'not-json') {
    return {
      detail: 'The URL answered with a page rather than data.',
      hint: 'That is usually a sign-in or authorisation page: redeploy with access set to Anyone.',
    };
  }
  if (code === 'transport') {
    return {
      detail: 'The request never arrived.',
      hint: 'A browser cannot call Apps Script directly, because /exec redirects to a host that will not answer a CORS preflight. The desktop and Android builds route around it; this check needs one of them.',
    };
  }
  if (code === 'calendar-error' || code === 'script-error') {
    return { detail: 'The script ran and failed.', hint: messageOf(err) };
  }
  if (typeof status === 'number' && status >= 400) {
    return { detail: `The deployment answered ${status}.`, hint: messageOf(err) };
  }
  // Sentence-cased, because the underlying message is written for a log rather
  // than for the person reading this panel.
  return { detail: 'The calendar check failed.', hint: sentence(messageOf(err)) };
}

/** A library message, turned into something that reads as a sentence. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return 'No further detail.';
  const capped = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/** A read-only alternative for anyone who only wants to see their events. */
export async function testIcs(http: Http, url: string): Promise<Check<number>> {
  const trimmed = url.trim();
  if (!/^https?:\/\//.test(trimmed)) {
    return { status: 'error', detail: 'Paste the secret address in iCal format from Google Calendar.' };
  }
  try {
    const res = await http({ url: trimmed, method: 'GET' });
    if (res.status !== 200) return { status: 'error', detail: `The address answered ${res.status}.` };
    const text = await res.text();
    if (!text.startsWith('BEGIN:VCALENDAR')) {
      return { status: 'error', detail: 'That address did not return a calendar.' };
    }
    const count = (text.match(/^BEGIN:VEVENT/gm) ?? []).length;
    return { status: 'ok', detail: `Read ${count} events. This feed is read-only.`, value: count };
  } catch (err) {
    return { status: 'error', detail: `Could not read the feed: ${messageOf(err)}` };
  }
}

/** The exact command, with this machine's path in it, ready to paste. */
export function mcpAddCommand(serverPath: string): string {
  return `claude mcp add to-hoot -- node ${serverPath}`;
}

/** The wrangler commands, in the order they have to be run, with values filled in. */
export function wranglerCommands(input: {
  pathSecret: string;
  owner: string;
  repo: string;
  branch: string;
}): string {
  const lines = [
    'cd apps/worker',
    `npx wrangler secret put MCP_PATH_SECRET   # ${input.pathSecret}`,
    `npx wrangler secret put GITHUB_OWNER      # ${input.owner}`,
    `npx wrangler secret put GITHUB_REPO       # ${input.repo}`,
    'npx wrangler secret put GITHUB_TOKEN      # the token from step 2',
  ];
  // Only when it differs from the Worker's own default, and only when it is
  // actually known: an empty value here would set the binding to nothing.
  if (input.branch !== '' && input.branch !== FALLBACK_BRANCH) {
    lines.push(`npx wrangler secret put GITHUB_BRANCH      # ${input.branch}`);
  }
  lines.push('npx wrangler deploy');
  return lines.join('\n');
}

/** Runs a real tools/list against the deployed worker. */
export async function testWorker(http: Http, url: string): Promise<Check<string[]>> {
  const trimmed = url.trim();
  if (!/^https:\/\/.+\/mcp\/.+/.test(trimmed)) {
    return {
      status: 'error',
      detail: 'That is not an endpoint URL.',
      hint: 'It looks like https://to-hoot-mcp.<subdomain>.workers.dev/mcp/<secret>',
    };
  }
  try {
    const res = await http({
      url: trimmed,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const text = await res.text();
    if (res.status === 404) {
      return { status: 'error', detail: 'The worker is up but the path secret does not match.' };
    }
    if (res.status !== 200) return { status: 'error', detail: `The endpoint answered ${res.status}.` };

    const tools = toolNames(text);
    if (tools.length === 0) {
      return { status: 'error', detail: 'The endpoint answered, but listed no tools.' };
    }
    return { status: 'ok', detail: `${tools.length} tools: ${tools.join(', ')}.`, value: tools };
  } catch (err) {
    return { status: 'error', detail: `Could not reach the endpoint: ${messageOf(err)}` };
  }
}

/** MCP over HTTP may answer as JSON or as one SSE frame; both carry the same body. */
function toolNames(text: string): string[] {
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? (/^data: (.*)$/m.exec(text)?.[1] ?? '')
    : text;
  try {
    const body = JSON.parse(payload) as { result?: { tools?: Array<{ name?: unknown }> } };
    return (body.result?.tools ?? []).flatMap(t => (typeof t.name === 'string' ? [t.name] : []));
  } catch {
    return [];
  }
}
