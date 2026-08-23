// @vitest-environment node
import { newEvent, replay, type Event, type FileStore } from '@to-hoot/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { CACHE_EVERY, CACHE_FILE, LOG_FILE, load, unpushed, watermarkOf, writeCache, writeLog } from './persistence.js';
import { Store } from './store.js';
import { memoryStore } from './platform/browser.js';

/** An in-memory FileStore that counts what was written, like a shell's would not. */
function memoryFiles(seed: Record<string, string> = {}): FileStore & {
  contents: Map<string, string>;
  writes: string[];
} {
  const contents = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    contents,
    writes,
    async read(name) {
      return contents.get(name) ?? null;
    },
    async write(name, text) {
      writes.push(name);
      contents.set(name, text);
    },
    async remove(name) {
      contents.delete(name);
    },
  };
}

const BASE = new Date(2026, 7, 23, 9, 0, 0).getTime();
let seq = 0;
beforeEach(() => {
  seq = 0;
});

function task(title: string, ts = BASE + seq): Event {
  return newEvent({
    deviceId: 'laptop',
    id: `01M0${String(seq++).padStart(22, '0')}`,
    type: 'create',
    entity: 'task',
    entityId: `t${seq}`,
    payload: { title, projectId: 'inbox' },
    ts,
  });
}

describe('watermarkOf', () => {
  it('is the greatest id, not the last one applied', () => {
    /*
     * Replay orders by (ts, deviceId, id), so the last event it applies is
     * routinely not the greatest id: two devices in the same millisecond is
     * enough. A watermark taken from the last-applied event would leave an
     * already-folded event above it, and the next boot would fold it again.
     * For a timeDelta, which carries an increment, that is doubled time.
     */
    const events = [
      { ...task('a'), id: '01ZZZ' },
      { ...task('b'), id: '01BBB' },
    ];
    expect(watermarkOf(events)).toBe('01ZZZ');
  });

  it('is undefined for nothing, so an empty cache is never written', () => {
    expect(watermarkOf([])).toBeUndefined();
  });
});

describe('load', () => {
  it('reads an empty disk as an empty app rather than failing', async () => {
    const files = memoryFiles();
    const { events, state, cached } = await load(files);
    expect(events).toEqual([]);
    expect(state.tasks).toEqual({});
    expect(cached).toBe(false);
  });

  it('replays the log when there is no cache', async () => {
    const files = memoryFiles();
    await writeLog(files, [task('Solder the preamp')]);
    const { state, cached } = await load(files);
    expect(Object.values(state.tasks).map(t => t.title)).toEqual(['Solder the preamp']);
    expect(cached).toBe(false);
  });

  it('replays only what is in front of the cache', async () => {
    const files = memoryFiles();
    const first = [task('Solder the preamp')];
    await writeCache(files, first[0]!.id, replay(first));

    const all = [...first, task('Order the enclosure')];
    await writeLog(files, all);

    const { state, cached } = await load(files);
    expect(cached).toBe(true);
    // Both tasks are there: one from the cache, one replayed onto it.
    expect(Object.values(state.tasks).map(t => t.title).sort()).toEqual([
      'Order the enclosure',
      'Solder the preamp',
    ]);
  });

  it('throws a damaged cache away rather than repairing it', async () => {
    // It is derivable, so any doubt is settled by replaying the log. The log
    // gets no such treatment: it is the only copy of unsynced work.
    const files = memoryFiles({ [CACHE_FILE]: '{ this is not json' });
    await writeLog(files, [task('Solder the preamp')]);
    const { state, cached } = await load(files);
    expect(cached).toBe(false);
    expect(Object.keys(state.tasks)).toHaveLength(1);
  });

  it('ignores a cache written by a format it does not know', async () => {
    const files = memoryFiles({ [CACHE_FILE]: JSON.stringify({ version: 99, state: {} }) });
    expect((await load(files)).cached).toBe(false);
  });

  it('survives a log with a broken entry in it', async () => {
    const files = memoryFiles({
      [LOG_FILE]: JSON.stringify({ version: 1, events: [null, task('Solder the preamp'), 7] }),
    });
    const { state } = await load(files);
    expect(Object.keys(state.tasks)).toHaveLength(1);
  });
});

describe('unpushed', () => {
  it('keeps everything until a push says otherwise', () => {
    const events = [task('a'), task('b')];
    expect(unpushed(events, undefined)).toHaveLength(2);
  });

  it('drops only what the repository already has', () => {
    const events = [task('a'), task('b'), task('c')];
    expect(unpushed(events, events[1]!.id).map(e => e.id)).toEqual([events[2]!.id]);
  });
});

describe('the Store on disk', () => {
  const build = (files: FileStore, now = () => BASE) =>
    new Store({ now, storage: null, vault: memoryStore(), files });

  it('carries a task across a restart', async () => {
    const files = memoryFiles();
    const first = build(files);
    first.addTask('Solder the preamp');
    await first.flush();

    const second = build(files);
    await second.load();
    expect(Object.values(second.getSnapshot().state.tasks).map(t => t.title)).toEqual([
      'Solder the preamp',
    ]);
  });

  it('carries tracked time across a restart, to the right day', async () => {
    const files = memoryFiles();
    let clock = BASE;
    const first = build(files, () => clock);
    const id = first.addTask('Solder the preamp');
    first.start(id);
    clock += 90_000;
    first.stop();
    await first.flush();

    const second = build(files, () => clock);
    await second.load();
    expect(second.getSnapshot().state.tasks[id]!.timeSpent).toBe(90_000);
  });

  it('writes the log on every change and the cache only occasionally', async () => {
    // The log is the only copy of unsynced work, so it is written every time.
    // The cache is derivable, so writing it every time would be cost for nothing.
    const files = memoryFiles();
    const store = build(files);
    for (let i = 0; i < 5; i++) store.addTask(`task ${i}`);
    await store.flush();

    expect(files.writes.filter(w => w === LOG_FILE)).toHaveLength(5);
    expect(files.writes.filter(w => w === CACHE_FILE)).toHaveLength(0);
  });

  it('rewrites the cache once enough has piled up in front of it', async () => {
    const files = memoryFiles();
    const store = build(files);
    for (let i = 0; i <= CACHE_EVERY; i++) store.addTask(`task ${i}`);
    await store.flush();
    expect(files.writes.filter(w => w === CACHE_FILE).length).toBeGreaterThan(0);

    // And the next boot agrees with the one that wrote it.
    const next = build(files);
    await next.load();
    expect(Object.keys(next.getSnapshot().state.tasks)).toHaveLength(CACHE_EVERY + 1);
  });

  it('folds a local event forward rather than replaying the whole log', async () => {
    /*
     * This runs on every tick of a running timer. Replaying from the beginning
     * each time is a cost that grows with the length of the log, which is the
     * shape of problem that is fine in a demo and unusable in a year.
     */
    const files = memoryFiles();
    const store = build(files);
    for (let i = 0; i < 300; i++) store.addTask(`task ${i}`);

    const before = performance.now();
    for (let i = 0; i < 100; i++) store.addTask(`later ${i}`);
    const perEvent = (performance.now() - before) / 100;

    // Generous, because a machine under load is still a machine under load. A
    // full replay of a 400-event log per commit is far above this.
    expect(perEvent).toBeLessThan(5);
    expect(Object.keys(store.getSnapshot().state.tasks)).toHaveLength(400);
  });

  it('gives the same answer folded forward as replayed from nothing', async () => {
    // The whole licence for folding forward. If these ever disagree, the fast
    // path is wrong and the slow one is right.
    const files = memoryFiles();
    let clock = BASE;
    const store = build(files, () => clock);
    const id = store.addTask('Solder the preamp');
    store.patchTask(id, { timeEstimate: 5_400_000 });
    store.start(id);
    clock += 60_000;
    store.stop();
    store.toggleDone(id, true);

    const folded = store.getSnapshot().state;
    const replayed = replay(store.getSnapshot().events as Event[]);
    expect(folded.tasks).toEqual(replayed.tasks);
  });

  it('keeps every event until a push acknowledges it', async () => {
    const files = memoryFiles();
    const store = build(files);
    store.addTask('a');
    store.addTask('b');
    expect(store.pending()).toHaveLength(2);

    store.markPushed(store.pending()[0]!.id);
    // The first is in the repository now, so the local copy may go.
    expect(store.pending()).toHaveLength(1);
    expect(store.getSnapshot().events).toHaveLength(1);
    // And the state does not lose the task the event created.
    expect(Object.keys(store.getSnapshot().state.tasks)).toHaveLength(2);
  });

  it('survives a file store that throws on write', async () => {
    // A full disk is not a reason to lose the session that is in memory.
    const files: FileStore = {
      read: async () => null,
      write: async () => {
        throw new Error('no space left on device');
      },
      remove: async () => undefined,
    };
    const store = build(files);
    store.addTask('Solder the preamp');
    await expect(store.flush()).resolves.toBeUndefined();
    expect(Object.keys(store.getSnapshot().state.tasks)).toHaveLength(1);
  });
});
