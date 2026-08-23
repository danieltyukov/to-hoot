// @vitest-environment node
import { DEFAULT_SETTINGS, cloneSettings, type FileStore, type Http, type Settings } from '@to-hoot/core';
import { describe, expect, it } from 'vitest';

import { memoryStore } from './platform/browser.js';
import { Store } from './store.js';
import { SyncController } from './sync.js';

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
    const send = (status: number, value: unknown) => ({
      status,
      headers: {} as Record<string, string>,
      text: async () => JSON.stringify(value),
    });

    if (rest === '') return send(200, { default_branch: defaultBranch, private: true });
    if (rest.startsWith('/git/ref/heads/')) {
      if (rest.slice('/git/ref/heads/'.length) !== defaultBranch) return send(404, { message: 'Not Found' });
      return ref === null ? send(409, { message: 'empty' }) : send(200, { object: { sha: ref } });
    }
    if (rest === '/git/trees' && req.method === 'POST') {
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
      return ref === null ? send(409, { message: 'empty' }) : send(200, [{ sha: ref }]);
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

function deviceOn(http: Http, deviceId: string, settings: Settings) {
  const store = new Store({ storage: null, vault: memoryStore(), files: memoryFiles() });
  store.saveSettings({ deviceId, deviceName: deviceId });
  const sync = new SyncController({ store, http, settings: () => settings });
  return { store, sync };
}

describe('SyncController', () => {
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
    expect(api.paths()).toHaveLength(1);
    expect(api.paths()[0]).toMatch(/^events\/laptop\/.*\.json$/);
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
    const prefixes = new Set(api.paths().map(p => p.split('/').slice(0, 2).join('/')));
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
