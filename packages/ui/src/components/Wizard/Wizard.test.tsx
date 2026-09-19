import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS, cloneSettings, type Http, type Settings } from '@to-hoot/core';
import { describe, expect, it, vi } from 'vitest';
import APPS_SCRIPT_SOURCE from 'virtual:apps-script-source';

import App from '../../App.js';
import { Store } from '../../store.js';
import { memoryStore } from '../../platform/browser.js';
import { SECRET_LENGTH } from '../../setup.js';
import { SECRET_PROPERTY } from './StepCalendar.js';
import { Wizard, type WizardProps } from './Wizard.js';

/*
 * `apps/apps-script/dist/Code.js` is a build artifact and is not committed, so
 * on a fresh clone the virtual module hands over a note saying how to build it
 * rather than the bridge source. That is the plugin working as designed, and
 * this suite has to pass there: `npm ci && npm test` is the first thing anyone
 * cloning this runs, and a red suite on the first run says the project is
 * broken rather than that one artifact is missing.
 *
 * So the claims that hold whatever the module supplied stay in the test below,
 * and the ones that can only be true of the real bundle are gated on having it.
 */
const HAS_BRIDGE_BUNDLE = APPS_SCRIPT_SOURCE.includes(SECRET_PROPERTY);

type Route = [RegExp, { status?: number; body?: unknown; text?: string }];

function transport(routes: Route[]): { http: Http; seen: Array<{ url: string; body?: string }> } {
  const seen: Array<{ url: string; body?: string }> = [];
  const http: Http = async req => {
    seen.push({ url: req.url, ...(req.body === undefined ? {} : { body: req.body }) });
    for (const [match, reply] of routes) {
      if (!match.test(req.url)) continue;
      const text = reply.text ?? JSON.stringify(reply.body ?? {});
      return { status: reply.status ?? 200, headers: {}, text: async () => text };
    }
    throw new Error(`no route for ${req.url}`);
  };
  return { http, seen };
}

/** The shell a sign-in can come back to, or none, plus what it opened. */
interface Shell {
  platform?: WizardProps['platform'];
  openUrl?: (url: string) => Promise<void>;
  initial?: (settings: Settings) => void;
}

/** A host that keeps the settings the wizard writes, as the app does. */
function setup(routes: Route[] = [], shell: Shell = {}) {
  const { http, seen } = transport(routes);
  const saved: Array<Partial<Settings>> = [];
  const onDone = vi.fn();

  function Host() {
    const [settings, setSettings] = useState<Settings>(() => {
      const s = cloneSettings(DEFAULT_SETTINGS);
      shell.initial?.(s);
      return s;
    });
    return (
      <Wizard
        http={http}
        settings={settings}
        onDone={onDone}
        onSave={patch => {
          saved.push(patch);
          setSettings(prev => ({
            ...prev,
            ...patch,
            github: { ...prev.github, ...patch.github },
            calendar: { ...prev.calendar, ...patch.calendar },
            worker: { ...prev.worker, ...patch.worker },
          }));
        }}
        mcpServerPath="/home/someone/to-hoot/apps/mcp/dist/index.js"
        openUrl={shell.openUrl}
        platform={shell.platform}
      />
    );
  }

  const utils = render(<Host />);
  return { ...utils, http, seen, saved, onDone, user: userEvent.setup() };
}

/**
 * A desktop shell whose loopback listener answers with the state of whatever
 * sign-in URL was opened last, the way a browser redirect would. The code it
 * hands back is fixed; what matters is that the state round-trips.
 */
function desktopShell(): Shell & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    openUrl: async url => {
      opened.push(url);
    },
    platform: {
      kind: 'desktop',
      oauthLoopback: () => ({
        redirectUri: 'http://localhost:8976/oauth/callback',
        waitForCallback: async () => {
          const state = new URL(opened.at(-1)!).searchParams.get('state') ?? '';
          return `http://localhost:8976/oauth/callback?code=CODE&state=${state}`;
        },
      }),
    },
  };
}

const go = async (user: ReturnType<typeof userEvent.setup>, step: string): Promise<void> => {
  await user.click(document.querySelector<HTMLElement>(`[data-step="${step}"]`)!);
};

/**
 * The token path, which the tests drive because a device flow needs a browser
 * and a person. Folded away under "Use a token instead"; everything after the
 * token is the same flow sign-in takes.
 */
const pasteToken = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await go(user, 'sync');
  await user.click(screen.getByRole('button', { name: 'Use a token instead' }));
  await user.type(screen.getByLabelText('GitHub token'), 'github_pat_x');
  await user.click(screen.getByRole('button', { name: 'Verify token' }));
  await screen.findByText(/Signed in as someone/);
};

/** GitHub's listing of the account's repositories, as the flow reads it. */
const repoList = (repos: Array<[full: string, branch: string]>): Route => [
  /\/user\/repos\?/,
  { body: repos.map(([full_name, default_branch]) => ({ full_name, default_branch })) },
];

/**
 * The text of a check's result, once it has one.
 *
 * Scoped to the result element rather than searched for across the step: the
 * prose deliberately uses the same words as the outcomes ("read-only",
 * "Administration: write"), which is a sign the copy is consistent and a
 * nuisance for a document-wide text query.
 */
/** aria-label, an associated label element, or the control's own text. */
function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria !== '') return aria;
  if (el.id !== '') {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label !== null) return label.textContent?.trim() ?? '';
  }
  return el.textContent?.trim() ?? '';
}

/** The Apps Script bridge is folded away now that signing in is the way in. */
async function openBridge(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Use an Apps Script bridge instead' }));
}

async function resultText(): Promise<string> {
  const found = await waitFor(() => {
    const done = [...document.querySelectorAll('[data-status]')];
    if (done.length === 0) throw new Error('no result yet');
    return done;
  });
  return found.map(el => el.textContent ?? '').join(' | ');
}

describe('Wizard', () => {
  it('the app is fully usable with no accounts configured', async () => {
    // The whole shape of step one is this claim. A wizard that opened on a
    // token field would be making the opposite one.
    const { user, container } = setup();
    expect(screen.getByRole('heading', { name: 'Nothing to set up' })).toBeInTheDocument();
    expect(container.querySelectorAll('input')).toHaveLength(0);

    // And the app really does run without any of it: no settings were written.
    const store = new Store({ storage: null, vault: memoryStore() });
    store.finishSetup();
    const app = render(<App store={store} />);
    await user.type(within(app.container).getByLabelText('New task'), 'Rewire the bench{Enter}');
    expect(within(app.container).getByText('Rewire the bench')).toBeInTheDocument();
    expect(store.getSnapshot().settings.github.token).toBe('');
  });

  it('a skipped step leaves the rest of the app working', async () => {
    const { user, onDone, saved } = setup();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    for (const _ of [0, 1, 2]) {
      await user.click(screen.getByRole('button', { name: 'Skip this' }));
    }
    expect(onDone).toHaveBeenCalledOnce();

    /*
     * Nothing is configured on the way past. Generated secrets are the one
     * exception and are kept deliberately: the value shown on screen has to be
     * the value that is stored, or someone who copied it into Google would find
     * the app had forgotten it.
     */
    const merged = Object.assign({}, ...saved) as Partial<Settings>;
    expect(merged.github?.owner ?? '').toBe('');
    expect(merged.calendar?.execUrl ?? '').toBe('');
    expect(merged.worker?.url ?? '').toBe('');
    expect(merged.deviceId ?? '').toBe('');
    for (const patch of saved) {
      expect(Object.keys(patch).every(k => k === 'calendar' || k === 'worker')).toBe(true);
    }
  });

  it('creates the private data repo through the API when there is none, unasked', async () => {
    // Nobody types a repository name. The flow looks for the one it would
    // have made and makes it when it is not there.
    const { user, seen } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      repoList([]),
      [/\/user\/repos$/, { status: 201, body: { full_name: 'someone/to-hoot-data', default_branch: 'main' } }],
    ]);
    await pasteToken(user);
    await screen.findByText(/Created someone\/to-hoot-data/);

    const create = seen.find(r => r.url.endsWith('/user/repos') && r.body !== undefined)!;
    expect(JSON.parse(create.body!)).toMatchObject({ private: true, auto_init: false });
    // And this device got a name without anyone typing one.
    expect(screen.getByLabelText('Device name')).toHaveValue('browser');
  });

  it('reports the real error when a token lacks the needed scope', async () => {
    // Not "something went wrong": the message names the permission, because
    // that is the only thing the reader can act on.
    const { user } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      repoList([]),
      [/\/user\/repos$/, { status: 403, body: { message: 'Resource not accessible by personal access token' } }],
    ]);
    await pasteToken(user);
    expect(await resultText()).toContain('Administration: write');
  });

  it('stores the repository real default branch rather than assuming main', async () => {
    const { user, saved } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      repoList([['someone/to-hoot-data', 'master']]),
      [/\/repos\/someone\/to-hoot-data$/, { body: { default_branch: 'master', private: true } }],
      [/\/commits\?/, { status: 409, body: { message: 'Git Repository is empty.' } }],
    ]);
    await pasteToken(user);
    expect(await screen.findByText(/default branch master/)).toBeInTheDocument();
    // What was saved is the branch the API reported, and the round trip that
    // follows aims at it rather than at main.
    await waitFor(() =>
      expect(saved.some(p => p.github?.owner === 'someone' && p.github.branch === 'master')).toBe(true),
    );
    expect(saved.some(p => p.github?.branch === 'main')).toBe(false);
  });

  it('refuses a device name that would write events where no reader looks', async () => {
    const { user } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      repoList([['someone/to-hoot-data', 'main']]),
      [/\/repos\/someone\/to-hoot-data$/, { body: { default_branch: 'main', private: true } }],
      [/\/commits\?/, { status: 409, body: { message: 'Git Repository is empty.' } }],
    ]);
    await pasteToken(user);
    await screen.findByText(/default branch main/);

    const name = await screen.findByLabelText('Device name');
    await user.clear(name);
    await user.type(name, 'my laptop');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    // The rename cannot be committed at all until the name is usable.
    expect(screen.getByRole('button', { name: 'Rename this device' })).toBeDisabled();

    await user.clear(name);
    await user.type(name, 'my-laptop');
    await user.click(screen.getByRole('button', { name: 'Rename this device' }));
    expect(screen.getByText('Events are written under events/my-laptop/.')).toBeInTheDocument();
  });

  it('renders the Apps Script source with no secret in it, and the secret separately', async () => {
    /*
     * The brief's own draft said the source should arrive with the secret
     * substituted in. The controller addendum overrides that, and it is right:
     * `clasp push` uploads the source to a Google-hosted project, and the
     * deployed script only ever reads the secret from a Script Property. Baking
     * it in would expose it and still not work.
     */
    const { user, container } = setup();
    await go(user, 'calendar');
    await openBridge(user);
    await user.click(screen.getByRole('button', { name: 'Show the script' }));

    // Byte for byte what the module supplied, rather than longer than some
    // number. It is the stronger claim as well as the one that survives a clean
    // clone: whatever the wizard is handed, it must show in full and must not
    // reformat a script somebody is about to paste into Google.
    const source = container.querySelector('.copyable-text')!.textContent!;
    expect(source).toBe(APPS_SCRIPT_SOURCE);
    expect(source).not.toHaveLength(0);

    // The load-bearing one, and it holds either way round.
    const secret = screen.getByLabelText('Shared secret') as HTMLInputElement;
    expect(secret.value).toHaveLength(SECRET_LENGTH);
    expect(source).not.toContain(secret.value);
    // Twice in the instructions on purpose: what to name the property, and what
    // rotating the secret means for it.
    expect(screen.getAllByText(new RegExp(SECRET_PROPERTY)).length).toBeGreaterThanOrEqual(2);
  });

  // Everything above holds against the placeholder too. This is the part that
  // cannot: run `npm run build -w @to-hoot/apps-script` to see it.
  it.runIf(HAS_BRIDGE_BUNDLE)('shows the built bridge, entry points and all', async () => {
    const { user, container } = setup();
    await go(user, 'calendar');
    await openBridge(user);
    await user.click(screen.getByRole('button', { name: 'Show the script' }));

    const source = container.querySelector('.copyable-text')!.textContent!;
    expect(source.length).toBeGreaterThan(200);
    expect(source).toContain(SECRET_PROPERTY);
    // Apps Script calls these by name, so a bundle without them deploys and
    // then answers every request with an HTML error page.
    expect(source).toContain('function doPost');
    expect(source).toContain('function doGet');
  });

  it('generates the secret and never invites anyone to choose one', async () => {
    // The bridge cannot throttle guesses and doGet reveals whether a deployment
    // is configured, so the length is the entire security argument.
    const { user } = setup();
    await go(user, 'calendar');
    await openBridge(user);
    const secret = screen.getByLabelText('Shared secret') as HTMLInputElement;

    expect(secret).toHaveAttribute('readonly');
    expect(secret.value).toMatch(/^[A-Za-z0-9]{40}$/);

    const first = secret.value;
    await user.click(screen.getByRole('button', { name: 'Generate a new secret' }));
    expect((screen.getByLabelText('Shared secret') as HTMLInputElement).value).not.toBe(first);
  });

  it('masks every secret until it is asked for', async () => {
    const { user } = setup();
    await go(user, 'calendar');
    await openBridge(user);
    const secret = screen.getByLabelText('Shared secret');
    expect(secret).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show shared secret' }));
    expect(screen.getByLabelText('Shared secret')).toHaveAttribute('type', 'text');
  });

  it('tells a missing Script Property apart from a wrong secret', async () => {
    // An unconfigured deployment refuses a correct secret too, so a plain
    // "wrong secret" sends the reader to re-copy a value that was already right.
    const { user } = setup([
      [/script\.google\.com/, { body: { ok: false, code: 'unauthorized', error: 'no' } }],
    ]);
    await go(user, 'calendar');
    await openBridge(user);
    await user.type(
      screen.getByLabelText('Deployment URL'),
      'https://script.google.com/macros/s/AK/exec',
    );
    await user.click(screen.getByRole('button', { name: 'Test calendar' }));

    expect(await resultText()).toContain('is not set on the deployment at all');
  });

  it('shows real events when the calendar bridge works', async () => {
    const start = new Date(2026, 7, 23, 14, 30).getTime();
    const { user } = setup([
      [
        /script\.google\.com/,
        {
          body: {
            ok: true,
            action: 'listEvents',
            events: [{ id: 'e', calendarId: 'c', title: 'Standup', start, end: start + 1, allDay: false }],
          },
        },
      ],
    ]);
    await go(user, 'calendar');
    await openBridge(user);
    await user.type(
      screen.getByLabelText('Deployment URL'),
      'https://script.google.com/macros/s/AK/exec',
    );
    await user.click(screen.getByRole('button', { name: 'Test calendar' }));
    expect(await resultText()).toContain('Standup at 14:30');
  });

  it('offers the read-only feed as a simpler way in', async () => {
    const feed = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VEVENT\nEND:VCALENDAR';
    const { user } = setup([[/basic\.ics/, { text: feed }]]);
    await go(user, 'calendar');
    await user.click(screen.getByRole('button', { name: 'Only show my events, without signing in' }));
    await user.type(
      screen.getByLabelText('Secret iCal address'),
      'https://calendar.google.com/x/basic.ics',
    );
    await user.click(screen.getByRole('button', { name: 'Test feed' }));
    expect(await resultText()).toContain('Read 1 events. This feed is read-only.');
  });

  it('prints the mcp command with this machine own path', async () => {
    const { user, container } = setup();
    await go(user, 'claude');
    const blocks = [...container.querySelectorAll('.copyable-text')].map(el => el.textContent);
    expect(blocks[0]).toBe(
      'claude mcp add to-hoot -- node /home/someone/to-hoot/apps/mcp/dist/index.js',
    );
  });

  it('runs a real tools/list against the deployed endpoint', async () => {
    const { user, seen } = setup([
      [/workers\.dev/, { body: { result: { tools: [{ name: 'list_tasks' }] } } }],
    ]);
    await go(user, 'claude');
    await user.click(screen.getByRole('button', { name: 'Deploy with wrangler instead' }));
    await user.type(
      screen.getByLabelText('Worker URL'),
      'https://to-hoot-mcp.someone.workers.dev/mcp/abc',
    );
    await user.click(screen.getByRole('button', { name: 'Test endpoint' }));

    await waitFor(() => expect(screen.getByText(/1 tools: list_tasks/)).toBeInTheDocument());
    expect(JSON.parse(seen.at(-1)!.body!)).toMatchObject({ method: 'tools/list' });
  });

  it('adds the path secret to the base URL wrangler printed', async () => {
    // What is pasted is what the deploy printed. Assembling the endpoint by
    // hand is the step people get wrong, and it fails as a 404 that looks
    // exactly like a Worker that is down.
    const { user, seen } = setup([
      [/workers\.dev/, { body: { result: { tools: [{ name: 'list_tasks' }] } } }],
    ]);
    await go(user, 'claude');
    await user.click(screen.getByRole('button', { name: 'Path secret and token options' }));
    const secret = (screen.getByLabelText('Path secret') as HTMLInputElement).value;
    expect(secret).not.toBe('');
    await user.click(screen.getByRole('button', { name: 'Deploy with wrangler instead' }));
    await user.type(
      screen.getByLabelText('Worker URL'),
      'https://to-hoot-mcp.someone.workers.dev',
    );
    await user.click(screen.getByRole('button', { name: 'Test endpoint' }));

    await waitFor(() => expect(screen.getByText(/1 tools: list_tasks/)).toBeInTheDocument());
    expect(seen.at(-1)!.url).toBe(`https://to-hoot-mcp.someone.workers.dev/mcp/${secret}`);
  });

  it('links out to the places the steps send you', async () => {
    const { user, container } = setup();
    await go(user, 'claude');
    await user.click(screen.getByRole('button', { name: 'Path secret and token options' }));
    await user.click(screen.getByRole('button', { name: 'Deploy with wrangler instead' }));
    const links = [...container.querySelectorAll('a.link-button')].map(a => a.getAttribute('href'));
    // The token page, with the permission set in the URL.
    expect(links.some(href => href?.startsWith('https://dash.cloudflare.com/profile/api-tokens?'))).toBe(true);
    expect(links).toContain('https://dash.cloudflare.com');
    expect(links).toContain('https://claude.ai/customize/connectors');
    // Every one opens away from the app, which is the only thing that makes
    // sense in a window that is itself the application.
    for (const link of container.querySelectorAll('a.link-button')) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    }
  });

  it('gives every control a name the mobile suite can address it by', async () => {
    const { user, container } = setup();
    for (const step of ['local', 'sync', 'calendar', 'claude']) {
      await go(user, step);
      const names: string[] = [];
      for (const control of container.querySelectorAll('button, input, select, textarea')) {
        expect(control, `${step}: ${control.outerHTML.slice(0, 80)}`).toHaveAccessibleName();
        names.push(accessibleName(control));
      }
      // Named is not enough: a suite that addresses controls by name needs the
      // names to be unique on screen. Three buttons called "Test connection"
      // are individually named and collectively unusable.
      expect(new Set(names).size, `${step}: duplicate names in ${names.join(', ')}`).toBe(
        names.length,
      );
    }
  });
  it('signs in with Google in one press and proves the calendar can be read', async () => {
    /*
     * What used to be three stages and a paste is one button. The listener
     * hands back a callback carrying the state of the URL the app opened, the
     * code is exchanged with the verifier, and the grant is proved by reading
     * the calendars and finding the log calendar, all before "Connected" shows.
     */
    const shell = desktopShell();
    const { user, seen, saved } = setup(
      [
        [/oauth2\.googleapis\.com\/token/, { body: { access_token: 'A', refresh_token: 'R', expires_in: 3600 } }],
        [
          /users\/me\/calendarList/,
          {
            body: {
              items: [
                { id: 'me@example.test', summary: 'Me', accessRole: 'owner', selected: true },
                { id: 'log-cal-id', summary: 'to-hoot log', accessRole: 'owner' },
              ],
            },
          },
        ],
        [/\/calendars\/[^/]+\/events/, { body: { items: [] } }],
        [/oauth2\/v3\/userinfo/, { body: { email: 'me@example.test' } }],
      ],
      shell,
    );
    await go(user, 'calendar');
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(screen.getByText(/Signed in as me@example\.test/)).toBeInTheDocument();

    // The browser was sent to Google with PKCE and asked for offline access.
    const auth = new URL(shell.opened[0]!);
    expect(auth.origin).toBe('https://accounts.google.com');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:8976/oauth/callback');

    // The exchange carried the code and the verifier, never the challenge.
    const exchange = seen.find(r => r.url.includes('oauth2.googleapis.com/token'))!;
    const body = new URLSearchParams(exchange.body ?? '');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('code_verifier')).toHaveLength(64);

    // What was kept: the grant, the address, and the adopted log calendar.
    const google = saved.map(p => p.calendar?.google).filter(g => g !== undefined);
    expect(google.at(-1)).toMatchObject({ refreshToken: 'R', accessToken: 'A', email: 'me@example.test', logCalendarId: 'log-cal-id' });
    // And nothing under the script route was touched.
    expect(saved.every(p => (p.calendar?.execUrl ?? '') === '')).toBe(true);
  });

  it('says why a browser tab cannot sign in and leaves the older routes open', async () => {
    const { user } = setup();
    await go(user, 'calendar');
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeDisabled();
    expect(screen.getByText(/nowhere for Google to send the answer back/)).toBeInTheDocument();
    // The feed and the bridge are still there, folded away.
    expect(screen.getByRole('button', { name: 'Only show my events, without signing in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use an Apps Script bridge instead' })).toBeInTheDocument();
  });

  it('turns a refusal in the browser into a sentence and leaves nothing saved', async () => {
    const shell = desktopShell();
    shell.platform = {
      kind: 'desktop',
      oauthLoopback: () => ({
        redirectUri: 'http://localhost:8976/oauth/callback',
        waitForCallback: async () => 'http://localhost:8976/oauth/callback?error=access_denied',
      }),
    };
    const { user, saved } = setup([], shell);
    await go(user, 'calendar');
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(screen.getByText('The sign-in was cancelled in the browser.')).toBeInTheDocument());
    expect(saved.some(p => p.calendar?.google !== undefined)).toBe(false);
  });

  it('signs out by revoking the grant and forgetting it', async () => {
    const shell = desktopShell();
    shell.initial = s => {
      s.calendar.google = { refreshToken: 'R', accessToken: 'A', expiresAt: 1, email: 'me@example.test', logCalendarId: 'L' };
    };
    const { user, seen, saved } = setup([[/oauth2\.googleapis\.com\/revoke/, { body: {} }]], shell);
    await go(user, 'calendar');
    expect(screen.getByText('Signed in as me@example.test')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(seen.some(r => r.url.includes('/revoke'))).toBe(true));
    expect(new URLSearchParams(seen.find(r => r.url.includes('/revoke'))!.body ?? '').get('token')).toBe('R');
    expect(saved.at(-1)?.calendar?.google).toMatchObject({ refreshToken: '', accessToken: '', email: '', logCalendarId: '' });
    expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument();
  });

  it('signs in with Cloudflare and deploys the endpoint in one press', async () => {
    /*
     * The same deploy as the token path, with the token coming from wrangler's
     * own OAuth client instead of a paste, and revoked once the deploy is done
     * so nothing that can rewrite every Worker on the account outlives it.
     */
    const shell = desktopShell();
    const okCf = (result: unknown) => ({ body: { success: true, errors: [], result } });
    const { user, seen, saved } = setup(
      [
        [/dash\.cloudflare\.com\/oauth2\/token/, { body: { access_token: 'CFTOKEN', refresh_token: 'x' } }],
        [/dash\.cloudflare\.com\/oauth2\/revoke/, { body: {} }],
        [/\/accounts$/, okCf([{ id: 'acct1', name: 'Someone' }])],
        [/releases\/download\/.*to-hoot-worker\.mjs$/, { text: 'export default {}' }],
        [/scripts\/to-hoot-mcp\/subdomain$/, okCf({ enabled: true })],
        [/workers\/subdomain$/, okCf({ subdomain: 'someone' })],
        [/workers\/scripts\/to-hoot-mcp$/, okCf({ id: 'to-hoot-mcp' })],
        [/workers\.dev\/mcp\//, { body: { result: { tools: [{ name: 'list_tasks' }, { name: 'add_task' }] } } }],
      ],
      {
        ...shell,
        initial: s => {
          s.github = { owner: 'someone', repo: 'to-hoot-data', branch: '', token: 'gho_x' };
        },
      },
    );
    await go(user, 'claude');
    await user.click(screen.getByRole('button', { name: 'Sign in and deploy' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy the endpoint and open Claude' })).toBeInTheDocument());
    const auth = new URL(shell.opened[0]!);
    expect(auth.origin + auth.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:8976/oauth/callback');

    // The upload carried the token it was just granted, and that token was
    // revoked afterwards.
    const upload = seen.find(r => /workers\/scripts\/to-hoot-mcp$/.test(r.url))!;
    expect(upload).toBeDefined();
    await waitFor(() => expect(seen.some(r => r.url.includes('/oauth2/revoke'))).toBe(true));
    expect(new URLSearchParams(seen.find(r => r.url.includes('/oauth2/revoke'))!.body ?? '').get('token')).toBe('CFTOKEN');

    const worker = saved.map(p => p.worker).filter(w => w !== undefined).at(-1)!;
    expect(worker.base).toBe('https://to-hoot-mcp.someone.workers.dev');
    expect(worker.url).toMatch(/^https:\/\/to-hoot-mcp\.someone\.workers\.dev\/mcp\/[A-Za-z0-9]{40}$/);
  });

  it('shows an endpoint deployed elsewhere as deployed, with nothing to press', async () => {
    // The phone learns the hostname through sync and nothing else; the URL
    // carries the path secret and stays on the device that deployed it.
    const { user } = setup([], {
      initial: s => {
        s.worker = { url: '', pathSecret: '', base: 'https://to-hoot-mcp.someone.workers.dev' };
        s.github = { owner: 'someone', repo: 'to-hoot-data', branch: '', token: 'gho_x' };
      },
    });
    await go(user, 'claude');
    expect(screen.getByText(/Deployed from another device at https:\/\/to-hoot-mcp\.someone\.workers\.dev/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in and deploy/ })).toBeDisabled();
  });

  it('registers with Claude Code in one press, pointing at the endpoint when there is one', async () => {
    // What `claude mcp add` does, done by the app: one entry in Claude Code's
    // own config. With an endpoint deployed it is an http entry, so an
    // installed app needs no checkout and no build on the machine.
    const added: Array<{ name: string; server: unknown }> = [];
    const claudeCode = {
      add: async (name: string, server: unknown) => {
        added.push({ name, server });
        return '/home/someone/.claude.json';
      },
      inspect: async () => ({ path: '/home/someone/.claude.json', present: false, target: null }),
    };
    const { user } = setup([], {
      platform: { kind: 'desktop', claudeCode },
      initial: s => {
        s.worker = { url: 'https://to-hoot-mcp.someone.workers.dev/mcp/abc', pathSecret: 'abc', base: 'https://to-hoot-mcp.someone.workers.dev' };
      },
    });
    await go(user, 'claude');
    await user.click(screen.getByRole('button', { name: 'Add to Claude Code' }));
    await waitFor(() => expect(screen.getByText('Registered with Claude Code')).toBeInTheDocument());
    expect(added).toEqual([
      { name: 'to-hoot', server: { type: 'http', url: 'https://to-hoot-mcp.someone.workers.dev/mcp/abc' } },
    ]);
    expect(screen.getByText(/Registered in \/home\/someone\/\.claude\.json/)).toBeInTheDocument();
  });

  it('points Claude Code at the local server when nothing is deployed, and shows what is registered', async () => {
    const added: unknown[] = [];
    const claudeCode = {
      add: async (_name: string, server: unknown) => {
        added.push(server);
        return '/home/someone/.claude.json';
      },
      inspect: async () => ({ path: '/home/someone/.claude.json', present: true, target: 'node' }),
    };
    const { user } = setup([], { platform: { kind: 'desktop', claudeCode } });
    await go(user, 'claude');
    // Already registered, as the file says, and pointing where it should.
    await waitFor(() => expect(screen.getByText('Registered with Claude Code')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Add to Claude Code again' }));
    await waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toEqual({ type: 'stdio', command: 'node', args: ['/home/someone/to-hoot/apps/mcp/dist/index.js'] });
  });

  it('keeps the terminal command where the shell cannot write the config', async () => {
    const { user, container } = setup();
    await go(user, 'claude');
    expect(screen.queryByRole('button', { name: /Add to Claude Code/ })).toBeNull();
    expect(container.textContent).toContain('claude mcp add to-hoot');
  });

});

describe('joining a repository that already has a log', () => {
  /** A repository with one device already in it. */
  const withLog: Route[] = [
    [/\/user$/, { body: { login: 'someone' } }],
    repoList([['someone/to-hoot-data', 'main']]),
    [/\/repos\/someone\/[^/]+$/, { body: { default_branch: 'main', private: true } }],
    [/\/commits\?/, { body: [{ sha: 'c' }] }],
    [
      /\/git\/trees\/c/,
      {
        body: {
          truncated: false,
          tree: [
            { path: 'events/laptop/01A.json', sha: 'e1', type: 'blob' },
            { path: 'meta.json', sha: 'metablob', type: 'blob' },
          ],
        },
      },
    ],
    [
      /\/git\/blobs\/metablob/,
      {
        body: {
          content: btoa(JSON.stringify({ schemaVersion: 1, devices: { laptop: { firstSeen: 1, lastSeen: 2 } } })),
          encoding: 'base64',
        },
      },
    ],
  ];

  async function reachTheDeviceStep(user: ReturnType<typeof userEvent.setup>) {
    await pasteToken(user);
    await screen.findByLabelText('Device name');
  }

  /** Types a name and commits it, the way a person renames the device. */
  async function rename(user: ReturnType<typeof userEvent.setup>, name: string) {
    const field = screen.getByLabelText('Device name');
    await user.clear(field);
    await user.type(field, name);
    await user.click(screen.getByRole('button', { name: 'Rename this device' }));
  }

  it('says it will join rather than set up, so nothing looks like it is starting over', async () => {
    // Setting up a second device is the moment someone is most likely to fear
    // that their first device's history is about to be replaced.
    const { user } = setup(withLog);
    await reachTheDeviceStep(user);
    expect(screen.getByText(/already holds a log from one device: laptop/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing already there is replaced/i)).toBeInTheDocument();
  });

  it('refuses a device name another machine already claims', async () => {
    /*
     * Every device writes only under events/<deviceId>/. That guarantee is what
     * makes merging a replay rather than a reconciliation, and why the sync
     * engine has no locking anywhere. Two devices on one name write the same
     * path concurrently and one side's events are lost on the retry.
     */
    const { user } = setup(withLog);
    await reachTheDeviceStep(user);

    await rename(user, 'laptop');
    expect(screen.getByText(/Another device is already called "laptop"/)).toBeInTheDocument();
    // The question, with its two answers, and no round trip until it is answered.
    expect(screen.getByRole('button', { name: 'Yes, this is it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No, it is another one' })).toBeInTheDocument();
    expect(screen.queryByText(/Writing a commit/)).toBeNull();
  });

  it('accepts a name nobody is using', async () => {
    const { user } = setup(withLog);
    await reachTheDeviceStep(user);
    await rename(user, 'phone');
    expect(screen.getByText('Events are written under events/phone/.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes, this is it' })).toBeNull();
  });

  it('allows the name to be reused, but only as a deliberate choice', async () => {
    // Replacing a lost machine is a real thing to want. It is offered as an
    // explicit answer rather than as a silent merge.
    const { user } = setup(withLog);
    await reachTheDeviceStep(user);
    await rename(user, 'laptop');

    await user.click(screen.getByRole('button', { name: 'Yes, this is it' }));
    expect(screen.queryByText(/Another device is already called/)).toBeNull();
    expect(screen.getByText('Events are written under events/laptop/.')).toBeInTheDocument();
  });

  it('offers the next free name when it is another device', async () => {
    const { user } = setup(withLog);
    await reachTheDeviceStep(user);
    await rename(user, 'laptop');

    await user.click(screen.getByRole('button', { name: 'No, it is another one' }));
    expect(screen.getByLabelText('Device name')).toHaveValue('browser');
    expect(screen.getByText('Events are written under events/browser/.')).toBeInTheDocument();
  });

  it('says nothing about joining when the repository is empty', async () => {
    const { user } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      repoList([['someone/to-hoot-data', 'main']]),
      [/\/repos\/someone\/[^/]+$/, { body: { default_branch: 'main', private: true } }],
      [/\/commits\?/, { status: 409, body: { message: 'Git Repository is empty.' } }],
    ]);
    await reachTheDeviceStep(user);
    expect(screen.queryByText(/already holds a log/i)).toBeNull();
    // Nothing is taken, so any name goes straight through to the round trip.
    await rename(user, 'laptop');
    expect(screen.getByText('Events are written under events/laptop/.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes, this is it' })).toBeNull();
  });

});
