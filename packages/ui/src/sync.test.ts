// @vitest-environment node
import { DEFAULT_SETTINGS, cloneSettings, type FileStore, type Http, type Settings } from '@to-hoot/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryStore } from './platform/browser.js';
import { FLUSH_MS, Store } from './store.js';
import {
  SYNC_AFTER_CHANGE_MS,
  SYNC_EVERY_HIDDEN_MS,
  SYNC_EVERY_MS,
  SyncController,
  TRACKING_PUSH_EVERY_MS,
} from './sync.js';

/*
 * These drive the real SyncEngine and the real GitHubClient against a Git Data
 * API implemented in memory with content-addressed objects.
 *
 * Deliberately strict where GitHub is lenient: `base_tree` is documented as
 * taking a tree sha, and this refuses a commit sha. Being stricter than the
 * real thing is the only reason an earlier run of this harness noticed that the
 * client sends one, and that a server which did not resolve it would drop every
 * previously committed file while still reporting success.
 */
function gitApi({ defaultBranch = 'main', empty = true } = {}): {
  http: Http;
  paths: () => string[];
  calls: string[];
} {
  const objects = new Map<string, { type: string; data: never }>();
  const calls: string[] = [];
  let ref: string | null = null;
  let next = 0;

  const put = (type: string, data: unknown): string => {
    const id = `${type}-${next++}`;
    objects.set(id, { type, data: data as never });
    return id;
  };
  const treeOf = (commit: string): Array<{ path: string; sha: string; type: string }> => {
    const c = objects.get(commit)?.data as unknown as { tree: string } | undefined;
    if (c === undefined) return [];
    return (objects.get(c.tree)?.data as unknown as { entries: never[] })?.entries ?? [];
  };
  if (!empty) ref = put('commit', { tree: put('tree', { entries: [] }), parents: [] });

  const http: Http = async req => {
    const url = new URL(req.url);
    const rest = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    calls.push(`${req.method ?? 'GET'} ${rest || '/'}`);
    const body = (): Record<string, never> => (req.body === undefined ? {} : JSON.parse(req.body));
    const send = (status: number, value: unknown, headers: Record<string, string> = {}) => ({
      status,
      headers,
      text: async () => JSON.stringify(value),
    });

    if (rest === '') return send(200, { default_branch: defaultBranch, private: true });
    if (rest.startsWith('/git/ref/heads/')) {
      if (rest.slice('/git/ref/heads/'.length) !== defaultBranch) return send(404, { message: 'Not Found' });
      return ref === null ? send(409, { message: 'empty' }) : send(200, { object: { sha: ref } });
    }
    if (rest === '/git/trees' && req.method === 'POST') {
      /*
       * Verified against real GitHub: the Git Data API refuses to work in a
       * repository with no commits. Every write answers 409, so the engine's
       * commit path can make the second commit and not the first.
       */
      if (ref === null) return send(409, { message: 'Git Repository is empty.' });
      const { base_tree, tree } = body() as unknown as {
        base_tree?: string;
        tree: Array<{ path: string; content?: string; sha: string | null }>;
      };
      let base: Array<{ path: string; sha: string; type: string }> = [];
      if (base_tree !== undefined) {
        const obj = objects.get(base_tree);
        // Strict on purpose. See the note above the harness.
        if (obj?.type === 'commit') base = treeOf(base_tree);
        else if (obj?.type === 'tree') base = (obj.data as unknown as { entries: never[] }).entries;
      }
      const merged = new Map(base.map(e => [e.path, e]));
      for (const entry of tree) {
        if (entry.sha === null) merged.delete(entry.path);
        else merged.set(entry.path, { path: entry.path, sha: put('blob', entry.content), type: 'blob' });
      }
      return send(201, { sha: put('tree', { entries: [...merged.values()] }) });
    }
    // The Contents API is the way in: it creates the branch and the first
    // commit together, which is the only thing that works on an empty repo.
    if (rest.startsWith('/contents/') && req.method === 'PUT') {
      if (ref !== null) return send(422, { message: 'already exists' });
      ref = put('commit', { tree: put('tree', { entries: [{ path: 'README.md', sha: put('blob', 'x'), type: 'blob' }] }), parents: [] });
      return send(201, {});
    }
    if (rest === '/git/commits' && req.method === 'POST') {
      const { message, tree, parents } = body() as unknown as Record<string, never>;
      return send(201, { sha: put('commit', { message, tree, parents }) });
    }
    if (rest === '/git/refs' && req.method === 'POST') {
      if (ref !== null) return send(422, { message: 'Reference already exists' });
      ref = (body() as unknown as { sha: string }).sha;
      return send(201, {});
    }
    if (rest.startsWith('/git/refs/heads/') && req.method === 'PATCH') {
      ref = (body() as unknown as { sha: string }).sha;
      return send(200, {});
    }
    if (rest.startsWith('/commits')) {
      if (ref === null) return send(409, { message: 'empty' });
      // The etag is the head, which is what the real one amounts to: a poll
      // that carries the current one is answered 304 with no body at all.
      const etag = `"${ref}"`;
      if (req.headers?.['if-none-match'] === etag) return send(304, null, { etag });
      return send(200, [{ sha: ref }], { etag });
    }
    if (rest.startsWith('/git/trees/')) {
      return send(200, { truncated: false, tree: treeOf(rest.slice('/git/trees/'.length).split('?')[0]!) });
    }
    if (rest.startsWith('/git/blobs/')) {
      const blob = objects.get(rest.slice('/git/blobs/'.length));
      if (blob === undefined) return send(404, { message: 'Not Found' });
      return send(200, {
        content: Buffer.from(String(blob.data), 'utf8').toString('base64'),
        encoding: 'base64',
      });
    }
    return send(404, { message: 'Not Found' });
  };

  return { http, calls, paths: () => (ref === null ? [] : treeOf(ref).map(e => e.path).sort()) };
}

function memoryFiles(): FileStore {
  const contents = new Map<string, string>();
  return {
    async read(name) {
      return contents.get(name) ?? null;
    },
    async write(name, text) {
      contents.set(name, text);
    },
    async remove(name) {
      contents.delete(name);
    },
  };
}

function settingsFor(overrides: Partial<Settings['github']> = {}): Settings {
  const s = cloneSettings(DEFAULT_SETTINGS);
  s.github = { owner: 'someone', repo: 'to-hoot-data', branch: '', token: 'tok', ...overrides };
  return s;
}

function deviceOn(http: Http, deviceId: string, settings: Settings, extra: { visible?: () => boolean } = {}) {
  const store = new Store({ storage: null, vault: memoryStore(), files: memoryFiles() });
  store.saveSettings({ deviceId, deviceName: deviceId });
  const sync = new SyncController({ store, http, settings: () => settings, ...extra });
  return { store, sync };
}

describe('SyncController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing at all until it has somewhere to sync to', async () => {
    const api = gitApi();
    const settings = cloneSettings(DEFAULT_SETTINGS);
    const { sync } = deviceOn(api.http, 'laptop', settings);

    const status = await sync.syncNow();
    expect(status.phase).toBe('unconfigured');
    // Not one request. An unconfigured app is a local app, not a broken one.
    expect(api.calls).toEqual([]);
  });

  it.each([
    ['an empty repository whose default is master', { defaultBranch: 'master', empty: true }],
    ['an existing repository on main', { defaultBranch: 'main', empty: false }],
  ])('pushes this device work into %s', async (_name, shape) => {
    const api = gitApi(shape);
    const { store, sync } = deviceOn(api.http, 'laptop', settingsFor());
    store.addTask('Solder the preamp');

    expect((await sync.syncNow()).phase).toBe('ok');
    const events = api.paths().filter(p => p.startsWith('events/'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^events\/laptop\/.*\.json$/);
    // The branch was read rather than assumed, and nothing else was touched.
    expect(api.calls).toContain('GET /');
    expect(api.calls.some(c => c.includes(`heads/${shape.defaultBranch}`))).toBe(true);
    if (shape.defaultBranch !== 'main') {
      expect(api.calls.some(c => c.includes('heads/main'))).toBe(false);
    }
  });

  it('converges two devices, each writing under its own prefix', async () => {
    const api = gitApi({ defaultBranch: 'master', empty: true });
    const settings = settingsFor();
    const a = deviceOn(api.http, 'laptop', settings);
    const b = deviceOn(api.http, 'phone', settings);

    const solder = a.store.addTask('Solder the preamp');
    a.store.addTask('Order the enclosure');
    await a.sync.syncNow();

    // B has never seen any of it.
    expect(Object.keys(b.store.getSnapshot().state.tasks)).toHaveLength(0);
    await b.sync.syncNow();
    expect(Object.values(b.store.getSnapshot().state.tasks).map(t => t.title).sort()).toEqual([
      'Order the enclosure',
      'Solder the preamp',
    ]);

    // B completes one, A picks it up.
    b.store.toggleDone(solder, true);
    await b.sync.syncNow();
    await a.sync.syncNow();

    expect(a.store.getSnapshot().state.tasks[solder]!.isDone).toBe(true);
    expect(a.store.getSnapshot().state.tasks).toEqual(b.store.getSnapshot().state.tasks);
    // One file per push batch, each under the writing device's own prefix.
    const prefixes = new Set(
      api.paths().filter(p => p.startsWith('events/')).map(p => p.split('/').slice(0, 2).join('/')),
    );
    expect([...prefixes].sort()).toEqual(['events/laptop', 'events/phone']);
  });

  it('sums tracked time from two devices rather than letting one win', async () => {
    // timeDelta carries an increment, not a total, which is what makes tracking
    // on two devices at once add up instead of one overwriting the other.
    const api = gitApi();
    const settings = settingsFor();
    const files = { a: memoryFiles(), b: memoryFiles() };
    let clockA = new Date(2026, 7, 23, 9, 0, 0).getTime();
    let clockB = clockA;

    const a = new Store({ now: () => clockA, storage: null, vault: memoryStore(), files: files.a });
    const b = new Store({ now: () => clockB, storage: null, vault: memoryStore(), files: files.b });
    a.saveSettings({ deviceId: 'laptop' });
    b.saveSettings({ deviceId: 'phone' });
    const syncA = new SyncController({ store: a, http: api.http, settings: () => settings });
    const syncB = new SyncController({ store: b, http: api.http, settings: () => settings });

    const id = a.addTask('Solder the preamp');
    await syncA.syncNow();
    await syncB.syncNow();

    // Both under the ten-minute idle threshold, so both are work rather than a
    // machine that went to sleep.
    a.start(id);
    clockA += 6 * 60_000;
    a.stop();

    b.start(id);
    clockB += 9 * 60_000;
    b.stop();

    await syncA.syncNow();
    await syncB.syncNow();
    await syncA.syncNow();

    const day = '2026-08-23';
    expect(a.getSnapshot().state.tasks[id]!.timeSpentOnDay[day]).toBe(15 * 60_000);
    expect(a.getSnapshot().state.tasks).toEqual(b.getSnapshot().state.tasks);
  });

  it('forgets a device on request and reports the list without it', async () => {
    const api = gitApi();
    const settings = settingsFor();
    const laptop = deviceOn(api.http, 'laptop', settings);
    const phone = deviceOn(api.http, 'old-phone', settings);
    laptop.store.addTask('Solder the preamp');
    phone.store.addTask('Buy solder');
    await laptop.sync.syncNow();
    await phone.sync.syncNow();
    // A compaction is what writes the registry; force one with a third sync.
    for (let i = 0; i < 3; i++) {
      laptop.store.addTask(`Task ${i}`);
      await laptop.sync.syncNow();
    }
    let status = await laptop.sync.syncNow();
    const listed = status.devices.map(d => d.id);
    if (!listed.includes('old-phone')) return; // registry not written yet at this threshold; nothing to forget

    status = await laptop.sync.forgetDevice('old-phone');
    expect(status.phase).toBe('ok');
    expect(status.detail).toBe('Forgot old-phone.');
    expect(status.devices.map(d => d.id)).not.toContain('old-phone');
    // The phone's task is still everywhere.
    await laptop.sync.syncNow();
    expect(Object.values(laptop.store.getSnapshot().state.tasks).map(t => t.title)).toContain('Buy solder');
  });

  it('keeps local work when a push fails, rather than dropping it', async () => {
    const failing: Http = async () => ({
      status: 500,
      headers: {},
      text: async () => '{"message":"server error"}',
    });
    const { store, sync } = deviceOn(failing, 'laptop', settingsFor());
    store.addTask('Solder the preamp');

    const before = store.pending().length;
    const status = await sync.syncNow();
    expect(status.phase).toBe('error');
    // Still the only copy, so still here. Nothing was marked pushed.
    expect(store.pending()).toHaveLength(before);
    expect(Object.keys(store.getSnapshot().state.tasks)).toHaveLength(1);
  });

  it('gives an empty repository its first commit rather than failing forever', async () => {
    /*
     * Found by running against real GitHub, not by any fake. A repository the
     * wizard has just created has no commits at all, and every Git Data write
     * into one answers `409 Git Repository is empty`. Without this, the first
     * sync a new user ever runs fails, and keeps failing, with a message about
     * trees.
     */
    const api = gitApi({ defaultBranch: 'master', empty: true });
    const { store, sync } = deviceOn(api.http, 'laptop', settingsFor());
    store.addTask('Solder the preamp');

    expect((await sync.syncNow()).phase).toBe('ok');
    // Bootstrapped through the Contents API, then the ordinary path.
    expect(api.calls.some(c => c.startsWith('PUT /contents/'))).toBe(true);
    expect(api.paths().some(p => p.startsWith('events/laptop/'))).toBe(true);
  });

  it('keeps what it read, so a poll that finds nothing new is one request', async () => {
    // The whole point of the conditional GET: a 304 costs nothing against the
    // rate limit and takes one round trip. That only holds if the engine that
    // learned the etag is still the engine doing the next poll.
    const api = gitApi({ empty: false });
    const { store, sync } = deviceOn(api.http, 'laptop', settingsFor());
    store.addTask('Solder the preamp');
    await sync.syncNow();

    api.calls.length = 0;
    expect((await sync.syncNow()).phase).toBe('ok');
    expect(api.calls).toEqual(['GET /commits']);
  });

  it('reads only what another device added, not the whole repository again', async () => {
    const api = gitApi({ empty: false });
    const settings = settingsFor();
    const laptop = deviceOn(api.http, 'laptop', settings);
    const phone = deviceOn(api.http, 'phone', settings);
    laptop.store.addTask('Solder the preamp');
    await laptop.sync.syncNow();
    await phone.sync.syncNow();

    phone.store.addTask('Buy solder');
    await phone.sync.syncNow();

    api.calls.length = 0;
    await laptop.sync.syncNow();
    expect(Object.values(laptop.store.getSnapshot().state.tasks).map(t => t.title).sort()).toEqual([
      'Buy solder',
      'Solder the preamp',
    ]);
    // The head moved, so the tree is re-read, and then the phone's files and
    // nothing else: the branch is not resolved again and the laptop's own file
    // is not fetched a second time.
    const theirs = api.paths().filter(p => p.startsWith('events/phone/')).length;
    expect(theirs).toBeGreaterThan(0);
    expect(api.calls.filter(c => c === 'GET /')).toEqual([]);
    expect(api.calls.filter(c => c.startsWith('GET /git/blobs/'))).toHaveLength(theirs);
  });

  it('starts over when the repository it syncs to changes', async () => {
    const api = gitApi({ empty: false });
    const settings = settingsFor();
    const { store, sync } = deviceOn(api.http, 'laptop', settings);
    store.addTask('Solder the preamp');
    await sync.syncNow();

    settings.github.repo = 'to-hoot-data-2';
    api.calls.length = 0;
    await sync.syncNow();
    // A different repository means a different branch to resolve and a
    // different head to read. Nothing cached from the old one applies.
    expect(api.calls[0]).toBe('GET /');
  });

  it('follows a sync with another when a change landed while it ran', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const api = gitApi({ empty: false });
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let gated = true;
    // Held at the first write, which is after the run has decided what to
    // push. A change made now is one this run will not carry.
    const http: Http = async req => {
      if (gated && req.method === 'POST' && req.url.endsWith('/git/trees')) {
        gated = false;
        await gate;
      }
      return api.http(req);
    };
    const { store, sync } = deviceOn(http, 'laptop', settingsFor());
    store.addTask('Solder the preamp');
    const first = sync.syncNow();
    await vi.waitFor(() => expect(gated).toBe(false));

    store.addTask('Order the enclosure');
    sync.soon();
    vi.advanceTimersByTime(SYNC_AFTER_CHANGE_MS);
    release();
    await first;
    expect(api.paths().filter(p => p.startsWith('events/laptop/'))).toHaveLength(1);
    // Nobody asks again. The controller noticed the change on its own.
    await vi.waitFor(() => expect(store.pending()).toHaveLength(0));
    expect(api.paths().filter(p => p.startsWith('events/laptop/'))).toHaveLength(2);
  });

  it('holds a running timer\'s bookkeeping rather than committing every flush', async () => {
    // A timer flushes a timeDelta every FLUSH_MS. Committing each one is a
    // commit every half minute per device, which is most of GitHub's hourly
    // budget for writes and keeps every other device's poll from ever being a
    // 304. The time is not lost: it is pushed with the next real change, when
    // the timer stops, or after TRACKING_PUSH_EVERY_MS at the latest.
    const api = gitApi({ empty: false });
    let clock = new Date(2026, 7, 23, 9, 0, 0).getTime();
    const now = () => clock;
    const store = new Store({ now, storage: null, vault: memoryStore(), files: memoryFiles() });
    store.saveSettings({ deviceId: 'laptop' });
    const sync = new SyncController({ store, http: api.http, settings: () => settings, now });
    const settings = settingsFor();
    const id = store.addTask('Solder the preamp');
    await sync.syncNow();
    const commits = () => api.calls.filter(c => c === 'POST /git/commits').length;
    const before = commits();

    store.start(id);
    clock += FLUSH_MS;
    store.tick();
    expect(store.pending()).toHaveLength(1);
    let status = await sync.syncNow();
    expect(commits()).toBe(before);
    // Not a backlog: nothing is waiting that should have gone.
    expect(status.phase).toBe('ok');
    expect(status.pending).toBe(0);
    expect(status.detail).toBe('Everything is synced.');

    // A real change takes the held time with it.
    store.addTask('Order the enclosure');
    status = await sync.syncNow();
    expect(commits()).toBe(before + 1);
    expect(store.pending()).toHaveLength(0);

    // Stopping is what makes the total final, so it goes at once.
    clock += FLUSH_MS;
    store.tick();
    await sync.syncNow();
    expect(commits()).toBe(before + 1);
    store.stop();
    await sync.syncNow();
    expect(commits()).toBe(before + 2);
    expect(store.pending()).toHaveLength(0);

    // Left running, the time still reaches the repository on its own.
    store.start(id);
    clock += FLUSH_MS;
    store.tick();
    await sync.syncNow();
    expect(commits()).toBe(before + 2);
    clock += TRACKING_PUSH_EVERY_MS;
    store.tick();
    await sync.syncNow();
    expect(commits()).toBe(before + 3);
    expect(store.pending()).toHaveLength(0);
  });

  it('pushes held bookkeeping when asked to sync everything', async () => {
    const api = gitApi({ empty: false });
    let clock = new Date(2026, 7, 23, 9, 0, 0).getTime();
    const now = () => clock;
    const store = new Store({ now, storage: null, vault: memoryStore(), files: memoryFiles() });
    store.saveSettings({ deviceId: 'laptop' });
    const settings = settingsFor();
    const sync = new SyncController({ store, http: api.http, settings: () => settings, now });
    const id = store.addTask('Solder the preamp');
    await sync.syncNow();
    store.start(id);
    clock += FLUSH_MS;
    store.tick();
    const before = api.calls.filter(c => c === 'POST /git/commits').length;
    await sync.syncNow({ everything: true });
    expect(api.calls.filter(c => c === 'POST /git/commits')).toHaveLength(before + 1);
    expect(store.pending()).toHaveLength(0);
  });

  it('polls often while the app is visible and rarely while it is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const api = gitApi({ empty: false });
    let visible = true;
    const { sync } = deviceOn(api.http, 'laptop', settingsFor(), { visible: () => visible });
    // The device's own settings event goes first, so every tick below is a
    // poll that finds nothing: one conditional request each.
    await sync.syncNow();
    api.calls.length = 0;
    const polls = () => api.calls.filter(c => c === 'GET /commits').length;
    const stop = sync.start();

    await vi.advanceTimersByTimeAsync(SYNC_EVERY_MS);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(SYNC_EVERY_MS);
    expect(polls()).toBe(2);

    visible = false;
    await vi.advanceTimersByTimeAsync(SYNC_EVERY_MS);
    // The tick that was already scheduled fires, and the next one is slow.
    expect(polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(SYNC_EVERY_HIDDEN_MS - SYNC_EVERY_MS);
    expect(polls()).toBe(3);
    await vi.advanceTimersByTimeAsync(SYNC_EVERY_MS);
    expect(polls()).toBe(4);
    stop();
  });

  it('joins a sync already in flight instead of racing it', async () => {
    // Two runs against the same ref is a conflict this device caused itself.
    const api = gitApi();
    const { store, sync } = deviceOn(api.http, 'laptop', settingsFor());
    store.addTask('Solder the preamp');

    const [first, second] = await Promise.all([sync.syncNow(), sync.syncNow()]);
    expect(first).toBe(second);
    expect(api.calls.filter(c => c === 'POST /git/commits')).toHaveLength(1);
  });

  it('survives a restart with the repository as its base', async () => {
    const api = gitApi();
    const settings = settingsFor();
    const files = memoryFiles();
    const vault = memoryStore();

    const first = new Store({ storage: null, vault, files });
    first.saveSettings({ deviceId: 'laptop' });
    first.addTask('Solder the preamp');
    await new SyncController({ store: first, http: api.http, settings: () => settings }).syncNow();
    await first.flush();

    // A push acknowledged means the repository has a copy, so the local log is
    // allowed to be empty. The state must not be.
    expect(first.pending()).toHaveLength(0);

    const second = new Store({ storage: null, vault, files });
    await second.load();
    expect(Object.values(second.getSnapshot().state.tasks).map(t => t.title)).toEqual([
      'Solder the preamp',
    ]);
  });
});
