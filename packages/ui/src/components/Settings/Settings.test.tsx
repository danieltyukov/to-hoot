import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Http } from '@to-hoot/core';
import { describe, expect, it } from 'vitest';

import App from '../../App.js';
import { memoryStore } from '../../platform/browser.js';
import { Store } from '../../store.js';

const NOW = new Date(2026, 7, 23, 10, 0, 0).getTime();

const http: Http = async () => ({ status: 200, headers: {}, text: async () => '{}' });

function setup(seed: Record<string, string> = {}) {
  const vault = memoryStore(seed);
  const store = new Store({ now: () => NOW, storage: null, vault });
  store.finishSetup();
  const utils = render(<App store={store} http={http} />);
  return { ...utils, store, vault, user: userEvent.setup() };
}

const open = async (user: ReturnType<typeof userEvent.setup>, section: string): Promise<HTMLElement> => {
  await user.click(screen.getByRole('button', { name: 'Settings' }));
  await user.click(screen.getByRole('button', { name: new RegExp(`^${section}`) }));
  return document.querySelector<HTMLElement>(`[data-section="${section.toLowerCase()}"]`)!;
};

describe('Settings', () => {
  it('is reachable from the sidebar and closes again', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(container.querySelector('.settings')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(container.querySelector('.settings')).toBeNull();
  });

  it('groups everything the wizard sets, plus appearance and data', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const sections = [...container.querySelectorAll('[data-section]')].map(el =>
      el.getAttribute('data-section'),
    );
    expect(sections).toEqual(['sync', 'calendar', 'claude', 'appearance', 'tracking', 'data']);
  });

  it('exposes the two settings that decide what a tracked second means', async () => {
    /*
     * Both were stored and honoured and neither had a control, which is the
     * worst of the three states: the behaviour is real, so it can surprise
     * someone, and there is nothing on screen to explain it.
     */
    const { user, store } = setup();
    const tracking = await open(user, 'Tracking');

    await user.selectOptions(within(tracking).getByLabelText('The day starts at'), String(4 * 3_600_000));
    expect(store.getSnapshot().settings.dayStartOffsetMs).toBe(4 * 3_600_000);

    await user.selectOptions(within(tracking).getByLabelText('Ask about idle time after'), String(120_000));
    expect(store.getSnapshot().settings.idleThresholdMs).toBe(120_000);
  });

  it('says what the tracking settings are without opening the section', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('midnight, idle after 10m')).toBeInTheDocument();
  });

  it('says at a glance what is configured without opening anything', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getAllByText('Not configured')).toHaveLength(2);
  });

  it('offers the same live checks the wizard did, not a second copy of them', async () => {
    // The sections render the wizard's own step components. If they drifted,
    // setup and settings would disagree about what a working connection is.
    const { user } = setup();
    const sync = await open(user, 'Sync');
    expect(within(sync).getByLabelText('GitHub token')).toBeInTheDocument();
    expect(within(sync).getByRole('button', { name: 'Verify token' })).toBeInTheDocument();
  });

  it('keeps a token masked until it is asked for', async () => {
    const { user } = setup();
    const sync = await open(user, 'Sync');
    const token = within(sync).getByLabelText('GitHub token');
    expect(token).toHaveAttribute('type', 'password');

    await user.click(within(sync).getByRole('button', { name: 'Show github token' }));
    expect(within(sync).getByLabelText('GitHub token')).toHaveAttribute('type', 'text');
  });

  it('rotates the calendar secret and reprints the instructions with the new one', async () => {
    const { user } = setup();
    const calendar = await open(user, 'Calendar');
    const before = (within(calendar).getByLabelText('Shared secret') as HTMLInputElement).value;

    await user.click(within(calendar).getByRole('button', { name: 'Generate a new secret' }));
    const after = (within(calendar).getByLabelText('Shared secret') as HTMLInputElement).value;

    expect(after).not.toBe(before);
    expect(after).toMatch(/^[A-Za-z0-9]{40}$/);
    // The instruction that names the property is still there, now beside the
    // new value, which is what makes a rotation actionable.
    expect(within(calendar).getAllByText(/TO_HOOT_SECRET/).length).toBeGreaterThanOrEqual(2);
  });

  it('changes the theme from Appearance and remembers it', async () => {
    const { user, store } = setup();
    const appearance = await open(user, 'Appearance');
    await user.click(within(appearance).getByRole('button', { name: 'Dark' }));

    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(store.getSnapshot().theme).toBe('dark');
    delete document.documentElement.dataset['theme'];
  });

  it('says plainly where the data lives when nothing is synced', async () => {
    const { user } = setup();
    const data = await open(user, 'Data');
    expect(within(data).getByText(/lives on this device only/)).toBeInTheDocument();
    expect(within(data).getByText(/an export is the only backup/)).toBeInTheDocument();
  });

  it('exports the log and merges an import back without duplicating it', async () => {
    const { user, store } = setup();
    await user.type(screen.getByLabelText('New task'), 'Rewire the bench{Enter}');
    const exported = store.exportJson();
    const before = store.getSnapshot().events.length;

    // Importing the same log twice adds nothing: replay identifies events by id.
    expect(store.importJson(exported)).toEqual({ ok: true, added: 0 });
    expect(store.getSnapshot().events).toHaveLength(before);

    const data = await open(user, 'Data');
    expect(within(data).getByRole('button', { name: 'Export JSON' })).toBeInTheDocument();
    expect(within(data).getByLabelText('Choose a file to import')).toBeInTheDocument();
  });

  it('refuses a file that is not a log rather than wiping anything', async () => {
    const { store } = setup();
    expect(store.importJson('{"nope":1}')).toEqual({
      ok: false,
      error: 'That file has no events in it.',
    });
    expect(store.importJson('not json at all')).toMatchObject({ ok: false });
  });

  it('explains compaction rather than offering a button that does nothing', async () => {
    // Compaction runs inside the sync engine, in the same commit that writes
    // the snapshot. A local button would either be a no-op or would fold a log
    // no other device has seen.
    const { user } = setup();
    const data = await open(user, 'Data');
    expect(within(data).getByText(/Compaction happens during sync/)).toBeInTheDocument();
    expect(within(data).queryByRole('button', { name: /compact/i })).toBeNull();
  });

  it('never writes a secret into the event log', async () => {
    // A token in the log is a token pushed to the data repository and pulled
    // down by every other device, permanently, in a git history.
    const { store } = setup();
    store.saveSettings({
      github: { owner: 'someone', repo: 'data', branch: 'master', token: 'github_pat_SECRET' },
      calendar: { execUrl: 'https://script.google.com/x/exec', secret: 'CALENDARSECRET', icsUrl: '' },
      worker: { url: 'https://x.workers.dev/mcp/PATHSECRET', pathSecret: 'PATHSECRET' },
    });

    const log = JSON.stringify(store.getSnapshot().events);
    expect(log).not.toContain('github_pat_SECRET');
    expect(log).not.toContain('CALENDARSECRET');
    expect(log).not.toContain('PATHSECRET');
    // What is allowed to travel did travel.
    expect(log).toContain('someone');
    // And all of it is still on this device.
    expect(store.getSnapshot().settings.github.token).toBe('github_pat_SECRET');
  });

  it('stamps events with the name the wizard promised, not a hidden ULID', async () => {
    /*
     * There used to be two identities: a generated ULID that every event was
     * stamped with, and a settings.deviceId that nothing read. The wizard's
     * "Events will be written under events/<name>/" was therefore true of
     * nothing, and the field pre-filled with the raw 26-character ULID, which
     * is what a real user would have kept.
     */
    const { store } = setup();
    expect(store.getSnapshot().settings.deviceId).toBe('');

    store.saveSettings({ deviceId: 'laptop', deviceName: 'laptop' });
    store.addTask('Rewire the bench');

    const written = store.getSnapshot().events.filter(e => e.entity === 'task');
    expect(written.length).toBeGreaterThan(0);
    for (const event of written) expect(event.deviceId).toBe('laptop');
  });

  it('refuses to adopt a device name that is not a path segment', () => {
    const { store } = setup();
    const before = store.device;
    store.saveSettings({ deviceId: 'my laptop' });
    // The settings field records what was asked for; the identity does not move
    // to something that would write events where no reader looks.
    expect(store.device).toBe(before);
  });

  it('banks the running time before moving to a new device name', async () => {
    // The Tracker stamps with the id it was built with, so the timer is stopped
    // first and the seconds land under the id that earned them.
    const { store } = setup();
    const id = store.addTask('Rewire the bench');
    store.start(id);
    store.saveSettings({ deviceId: 'laptop' });

    expect(store.getSnapshot().runningTaskId).toBeNull();
    expect(store.device).toBe('laptop');
  });

  it('reads settings back from the platform store on the next start', async () => {
    const vault = memoryStore();
    const first = new Store({ storage: null, vault });
    first.saveSettings({
      github: { owner: 'someone', repo: 'data', branch: 'master', token: 'tok' },
      theme: 'dark',
    });

    const second = new Store({ storage: null, vault });
    await second.load();
    expect(second.getSnapshot().settings.github.token).toBe('tok');
    // The branch too: re-deriving it is what produced an orphan main branch.
    expect(second.getSnapshot().settings.github.branch).toBe('master');
    expect(second.getSnapshot().theme).toBe('dark');
  });

  it('does not open the wizard again once it has been finished', async () => {
    const vault = memoryStore();
    const store = new Store({ storage: null, vault });
    store.finishSetup();

    const next = new Store({ storage: null, vault });
    await next.load();
    expect(next.getSnapshot().setupDone).toBe(true);
  });

  it('opens the wizard on a genuinely first run', async () => {
    const store = new Store({ storage: null, vault: memoryStore() });
    render(<App store={store} http={http} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Nothing to set up' })).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('New task')).toBeNull();
  });

  it('gives every control in settings an accessible name', async () => {
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    for (const section of ['Sync', 'Calendar', 'Claude', 'Appearance', 'Data']) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^${section}`) }));
      for (const control of container.querySelectorAll('button, input, select, textarea')) {
        expect(control, `${section}: ${control.outerHTML.slice(0, 80)}`).toHaveAccessibleName();
      }
      await user.click(screen.getByRole('button', { name: new RegExp(`^${section}`) }));
    }
  });
});

describe('what a tracked second means', () => {
  /*
   * The Tracker is constructed with the settings that decide which day a
   * timeDelta is stamped with and what counts as idle. Both were missing.
   *
   * dayStartOffsetMs is honoured everywhere time is READ, so a second tracked
   * after midnight but before the offset was written under day D and read back
   * under D-1: gone from the day it belonged to, and on one already finished.
   */
  it('stamps a delta with the logical day, not the calendar one', () => {
    const OFFSET = 4 * 3_600_000;
    let clock = new Date(2026, 7, 24, 1, 30, 0).getTime(); // 01:30, still "yesterday"
    const store = new Store({ now: () => clock, storage: null, vault: memoryStore() });
    store.saveSettings({ dayStartOffsetMs: OFFSET });

    const id = store.addTask('Rewire the bench');
    store.start(id);
    clock += 60_000;
    store.stop();

    const days = Object.keys(store.getSnapshot().state.tasks[id]!.timeSpentOnDay);
    // 01:30 with a four-hour offset belongs to the 23rd, which is the day the
    // selectors will look it up under.
    expect(days).toEqual(['2026-08-23']);
  });

  it('honours the configured idle threshold, which had no effect at all', () => {
    let clock = new Date(2026, 7, 23, 10, 0, 0).getTime();
    const store = new Store({ now: () => clock, storage: null, vault: memoryStore() });
    // A minute. Anything longer is the machine having slept, not work.
    store.saveSettings({ idleThresholdMs: 60_000 });

    const id = store.addTask('Rewire the bench');
    store.start(id);
    clock += 30 * 60_000; // half an hour with no ticks
    store.stop();

    // Not banked: it is held as an idle gap for the user to answer.
    expect(store.getSnapshot().state.tasks[id]!.timeSpent).toBe(0);
    expect(store.getSnapshot().idleGap?.ms).toBe(30 * 60_000);
  });

  it('rebuilds the tracker when those settings change', () => {
    let clock = new Date(2026, 7, 24, 1, 30, 0).getTime();
    const store = new Store({ now: () => clock, storage: null, vault: memoryStore() });
    const id = store.addTask('Rewire the bench');

    store.start(id);
    clock += 60_000;
    // Changing the offset mid-session banks what was earned under the old one.
    store.saveSettings({ dayStartOffsetMs: 4 * 3_600_000 });
    expect(store.getSnapshot().runningTaskId).toBeNull();
    expect(Object.keys(store.getSnapshot().state.tasks[id]!.timeSpentOnDay)).toEqual(['2026-08-24']);

    store.start(id);
    clock += 60_000;
    store.stop();
    // And the next session uses the new one.
    expect(Object.keys(store.getSnapshot().state.tasks[id]!.timeSpentOnDay).sort()).toEqual([
      '2026-08-23',
      '2026-08-24',
    ]);
  });
});

describe('when the log on disk cannot be read', () => {
  const damagedFiles = (text: string) => {
    const contents = new Map([['log.json', text]]);
    return {
      contents,
      read: async (n: string) => contents.get(n) ?? null,
      write: async (n: string, t: string) => void contents.set(n, t),
      remove: async (n: string) => void contents.delete(n),
    };
  };

  it('says so, and says the app is not saving', async () => {
    const files = damagedFiles('{"version":1,"events":[{"id":"01A","ty');
    const store = new Store({ now: () => NOW, storage: null, vault: memoryStore(), files });
    store.finishSetup();
    await store.load();
    const user = userEvent.setup();
    render(<App store={store} http={http} />);

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    // Visible without opening anything, because it changes what the app is doing.
    expect(screen.getByText('not saving')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Data/ }));
    const data = document.querySelector<HTMLElement>('[data-section="data"]')!;
    expect(within(data).getByText(/could not be read/)).toBeInTheDocument();
    expect(within(data).getByText(/export it before closing/)).toBeInTheDocument();
  });

  it('offers a way out that keeps the unreadable file', async () => {
    const original = '{"version":1,"events":[{"id":"01A","ty';
    const files = damagedFiles(original);
    const store = new Store({ now: () => NOW, storage: null, vault: memoryStore(), files });
    store.finishSetup();
    await store.load();
    const user = userEvent.setup();
    render(<App store={store} http={http} />);

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: /^Data/ }));
    await user.click(screen.getByRole('button', { name: 'Start a new log' }));

    await waitFor(() => expect(store.getSnapshot().storageError).toBeNull());
    // The bytes are kept, not deleted. They may be the only copy of unsynced work.
    expect([...files.contents.keys()].some(k => k.startsWith('log.damaged-'))).toBe(true);
    expect([...files.contents.values()]).toContain(original);
  });
});
