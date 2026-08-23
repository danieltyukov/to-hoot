import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_SETTINGS, cloneSettings, type Http, type Settings } from '@to-hoot/core';
import { describe, expect, it, vi } from 'vitest';

import App from '../../App.js';
import { Store } from '../../store.js';
import { memoryStore } from '../../platform/browser.js';
import { SECRET_LENGTH } from '../../setup.js';
import { SECRET_PROPERTY } from './StepCalendar.js';
import { Wizard } from './Wizard.js';

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

/** A host that keeps the settings the wizard writes, as the app does. */
function setup(routes: Route[] = []) {
  const { http, seen } = transport(routes);
  const saved: Array<Partial<Settings>> = [];
  const onDone = vi.fn();

  function Host() {
    const [settings, setSettings] = useState<Settings>(() => cloneSettings(DEFAULT_SETTINGS));
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
      />
    );
  }

  const utils = render(<Host />);
  return { ...utils, http, seen, saved, onDone, user: userEvent.setup() };
}

const go = async (user: ReturnType<typeof userEvent.setup>, step: string): Promise<void> => {
  await user.click(document.querySelector<HTMLElement>(`[data-step="${step}"]`)!);
};

/**
 * The text of a check's result, once it has one.
 *
 * Scoped to the result element rather than searched for across the step: the
 * prose deliberately uses the same words as the outcomes ("read-only",
 * "Administration: write"), which is a sign the copy is consistent and a
 * nuisance for a document-wide text query.
 */
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
    // Nothing was configured on the way past.
    expect(saved).toEqual([]);
  });

  it('offers to create the private data repo through the API', async () => {
    const { user, seen } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      [/\/user\/repos$/, { status: 201, body: { full_name: 'someone/to-hoot-data', default_branch: 'main' } }],
    ]);
    await go(user, 'sync');
    await user.type(screen.getByLabelText('GitHub token'), 'github_pat_x');
    await user.click(screen.getByRole('button', { name: 'Verify token' }));
    await screen.findByText('Signed in as someone.');

    await user.click(screen.getByRole('button', { name: 'Create it for me' }));
    await screen.findByText(/Created someone\/to-hoot-data/);

    const create = seen.find(r => r.url.endsWith('/user/repos'))!;
    expect(JSON.parse(create.body!)).toMatchObject({ private: true, auto_init: false });
  });

  it('reports the real error when a token lacks the needed scope', async () => {
    // Not "something went wrong": the message names the permission, because
    // that is the only thing the reader can act on.
    const { user } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      [/\/user\/repos$/, { status: 403, body: { message: 'Resource not accessible by personal access token' } }],
    ]);
    await go(user, 'sync');
    await user.type(screen.getByLabelText('GitHub token'), 'github_pat_x');
    await user.click(screen.getByRole('button', { name: 'Verify token' }));
    await screen.findByText('Signed in as someone.');

    await user.click(screen.getByRole('button', { name: 'Create it for me' }));
    expect(await resultText()).toContain('Administration: write');
  });

  it('stores the repository real default branch rather than assuming main', async () => {
    const { user, saved } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      [/\/repos\/someone\//, { body: { default_branch: 'master', private: true } }],
    ]);
    await go(user, 'sync');
    await user.type(screen.getByLabelText('GitHub token'), 'github_pat_x');
    await user.click(screen.getByRole('button', { name: 'Verify token' }));
    await screen.findByText('Signed in as someone.');

    await user.click(screen.getByRole('button', { name: 'Use an existing one' }));
    expect(await screen.findByText(/default branch master/)).toBeInTheDocument();
    // And the connection test aims at that branch, not at main.
    expect(screen.getByText(/on master/)).toBeInTheDocument();
    expect(saved.at(-1)).toMatchObject({ github: { owner: 'someone' } });
  });

  it('refuses a device name that would write events where no reader looks', async () => {
    const { user } = setup([
      [/\/user$/, { body: { login: 'someone' } }],
      [/\/repos\/someone\//, { body: { default_branch: 'main', private: true } }],
    ]);
    await go(user, 'sync');
    await user.type(screen.getByLabelText('GitHub token'), 'github_pat_x');
    await user.click(screen.getByRole('button', { name: 'Verify token' }));
    await screen.findByText('Signed in as someone.');
    await user.click(screen.getByRole('button', { name: 'Use an existing one' }));
    await screen.findByText(/default branch main/);

    const name = await screen.findByLabelText('Device name');
    await user.type(name, 'my laptop');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    // The check cannot be run at all until the name is usable.
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();

    await user.clear(name);
    await user.type(name, 'my-laptop');
    expect(screen.getByText('Events will be written under events/my-laptop/.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
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

    const source = container.querySelector('.copyable-text')!.textContent!;
    expect(source.length).toBeGreaterThan(200);
    expect(source).toContain(SECRET_PROPERTY);

    const secret = screen.getByLabelText('Shared secret') as HTMLInputElement;
    expect(secret.value).toHaveLength(SECRET_LENGTH);
    expect(source).not.toContain(secret.value);
    // Twice on purpose: in the script, where the property is read, and in the
    // instructions, where the reader is told to set it.
    expect(screen.getAllByText(new RegExp(SECRET_PROPERTY)).length).toBeGreaterThanOrEqual(2);
  });

  it('generates the secret and never invites anyone to choose one', async () => {
    // The bridge cannot throttle guesses and doGet reveals whether a deployment
    // is configured, so the length is the entire security argument.
    const { user } = setup();
    await go(user, 'calendar');
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
    await user.type(
      screen.getByLabelText('Deployment URL'),
      'https://script.google.com/macros/s/AK/exec',
    );
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText(/TO_HOOT_SECRET is not set/)).toBeInTheDocument();
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
    await user.type(
      screen.getByLabelText('Deployment URL'),
      'https://script.google.com/macros/s/AK/exec',
    );
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Standup at 14:30/)).toBeInTheDocument();
  });

  it('offers the read-only feed as a simpler way in', async () => {
    const feed = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VEVENT\nEND:VCALENDAR';
    const { user } = setup([[/basic\.ics/, { text: feed }]]);
    await go(user, 'calendar');
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
    await user.type(
      screen.getByLabelText('Endpoint URL'),
      'https://to-hoot-mcp.someone.workers.dev/mcp/abc',
    );
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(screen.getByText(/1 tools: list_tasks/)).toBeInTheDocument());
    expect(JSON.parse(seen.at(-1)!.body!)).toMatchObject({ method: 'tools/list' });
  });

  it('gives every control a name the mobile suite can address it by', async () => {
    const { user, container } = setup();
    for (const step of ['local', 'sync', 'calendar', 'claude']) {
      await go(user, step);
      for (const control of container.querySelectorAll('button, input, select, textarea')) {
        expect(control, `${step}: ${control.outerHTML.slice(0, 80)}`).toHaveAccessibleName();
      }
    }
  });
});
