// @vitest-environment node
import { dayStr, newEvent, replay, type Event, type FileStore, type State } from '@to-hoot/core';
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

function delta(taskId: string, atMs: number, ms: number): Event {
  return newEvent({
    deviceId: 'laptop',
    id: `01M2${String(seq++).padStart(22, '0')}`,
    type: 'timeDelta',
    entity: 'task',
    entityId: taskId,
    payload: { day: dayStr(atMs), ms },
    ts: atMs,
  });
}

/** A repository snapshot that accounts for exactly these events, as a pull returns one. */
function covering(events: Event[]): State {
  return { ...replay([...events]), coversThrough: watermarkOf(events)! };
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

  it('refuses a log with a broken entry in it rather than reading past it', async () => {
    /*
     * This test used to assert the opposite: that the bad entries were skipped
     * and the good one kept. That reads well until you follow what happens
     * next, which is that the file is rewritten from what was kept, so the
     * entries that were skipped are deleted. Whatever they were, they were in
     * the only copy, and nobody asked for them to go.
     */
    const files = memoryFiles({
      [LOG_FILE]: JSON.stringify({ version: 1, events: [null, task('Solder the preamp'), 7] }),
    });
    const { state, damaged } = await load(files);
    expect(Object.keys(state.tasks)).toHaveLength(0);
    expect(damaged).toBeTruthy();
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

describe('folding forward and replaying agree', () => {
  /*
   * The licence for folding forward is that it gives the same answer as a
   * replay. It very nearly did not.
   *
   * `replay(events, base)` discards everything at or below `base.coversThrough`,
   * and after a sync the base carries the repository's watermark. ULIDs order by
   * time, so a device whose clock runs ahead pushes a watermark greater than an
   * id this device is about to mint. The fold then dropped the user's own action
   * from the state while still writing it to the log and pushing it: the task
   * they just typed simply never appeared, and the sync sent it anyway.
   */
  const remoteAhead = (): State => {
    const ahead: Event[] = [
      {
        ...task('From the other device'),
        // A ULID minted a minute into the future, which is all a clock skew is.
        id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
        deviceId: 'phone',
      },
    ];
    return { ...replay(ahead), coversThrough: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' };
  };

  it('applies a local event whose id sorts below the adopted watermark', async () => {
    const files = memoryFiles();
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });

    store.adoptRemote(remoteAhead());
    expect(Object.keys(store.getSnapshot().state.tasks)).toHaveLength(1);

    const id = store.addTask('Solder the preamp');
    const state = store.getSnapshot().state;

    // The action the user just took is on screen.
    expect(state.tasks[id]?.title).toBe('Solder the preamp');
    // And it is in the log, so the two cannot disagree about whether it exists.
    expect(store.pending().some(e => e.entityId === id)).toBe(true);
    expect(Object.keys(state.tasks)).toHaveLength(2);
  });

  it('keeps unpushed local work when adopting a repository that is ahead', async () => {
    // Same failure, one step earlier: rebasing local events onto a remote state
    // whose watermark is above them would drop them on the way in.
    const files = memoryFiles();
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    const id = store.addTask('Solder the preamp');

    store.adoptRemote(remoteAhead());

    expect(store.getSnapshot().state.tasks[id]?.title).toBe('Solder the preamp');
    expect(store.pending().some(e => e.entityId === id)).toBe(true);
  });

  it('merges onto the adopted base rather than replaying the log alone', () => {
    // After a sync the log no longer describes the state: the snapshot accounts
    // for most of it. Replaying the log by itself throws that history away.
    const files = memoryFiles();
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    store.adoptRemote(remoteAhead());

    /*
     * The id has to sort above the adopted watermark, which is what "arrived
     * after the snapshot was taken" means. It used to sort below it, and the
     * assertion passed only because the watermark was being stripped off the
     * base entirely. Stripping it is what let an event the snapshot already
     * held be applied to that snapshot a second time, so the id is now the
     * realistic one and the filtered case is pinned by its own test.
     */
    store.merge([{ ...task('Arrived from elsewhere'), id: '02M0MERGED0000000000000001', deviceId: 'phone' }]);

    const titles = Object.values(store.getSnapshot().state.tasks).map(t => t.title).sort();
    expect(titles).toEqual(['Arrived from elsewhere', 'From the other device']);
  });
});

describe('a log that cannot be read', () => {
  it('is never treated as an empty one', async () => {
    // Neither shell wrote atomically, and the whole file is rewritten every
    // thirty seconds while a timer runs, so a file cut short by a kill is the
    // ordinary case. Reading it as empty and writing [] over the top makes the
    // loss permanent.
    const files = memoryFiles({ [LOG_FILE]: '{"version":1,"events":[{"id":"01A","ty' });
    const { events, damaged } = await load(files);
    expect(events).toEqual([]);
    expect(damaged).toContain('could not be read');
  });

  it('is distinguished from a log that is simply absent', async () => {
    const { damaged } = await load(memoryFiles());
    expect(damaged).toBeUndefined();
  });

  it('is never written over, whatever the app goes on to do', async () => {
    const original = '{"version":1,"events":[{"id":"01A","ty';
    const files = memoryFiles({ [LOG_FILE]: original });
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    await store.load();

    expect(store.getSnapshot().storageError).toContain('could not be read');

    store.addTask('Solder the preamp');
    await store.flush();

    // The bytes are still there. They are the only copy of whatever had not
    // synced, and this app can no longer read them.
    expect(files.contents.get(LOG_FILE)).toBe(original);
  });

  it('can be set aside deliberately, and is kept when it is', async () => {
    const original = '{"version":1,"events":[{"id":"01A","ty';
    const files = memoryFiles({ [LOG_FILE]: original });
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    await store.load();

    const kept = await store.startFreshLog();

    expect(kept).toMatch(/^log\.damaged-/);
    expect(files.contents.get(kept!)).toBe(original);
    expect(store.getSnapshot().storageError).toBeNull();

    store.addTask('Solder the preamp');
    await store.flush();
    expect(files.contents.get(LOG_FILE)).toContain('Solder the preamp');
  });
});

describe('the order the two files are written in', () => {
  it('never leaves a truncated log with a cache that does not cover it', async () => {
    /*
     * `markPushed` and `adoptRemote` both shorten the log, and what it no longer
     * holds is carried by the cache. If the cache write is the one that fails,
     * writing the log anyway leaves a pair that describes nothing: the next boot
     * replays a log missing the events, onto a cache that never gained them.
     */
    const contents = new Map<string, string>();
    let failCache = false;
    const files: FileStore = {
      async read(n) {
        return contents.get(n) ?? null;
      },
      async write(n, t) {
        if (n === CACHE_FILE && failCache) throw new Error('disk full');
        contents.set(n, t);
      },
      async remove(n) {
        contents.delete(n);
      },
    };

    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    store.addTask('Solder the preamp');
    store.addTask('Order the enclosure');
    await store.flush();

    failCache = true;
    store.markPushed(store.pending().at(-1)!.id);
    await store.flush();

    // The write failed and said so, and the fuller log is still on disk.
    expect(store.getSnapshot().storageError).toContain('Could not save');
    const onDisk = JSON.parse(contents.get(LOG_FILE)!) as { events: Event[] };
    expect(onDisk.events.length).toBeGreaterThan(0);

    const next = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    await next.load();
    expect(Object.keys(next.getSnapshot().state.tasks)).toHaveLength(2);
  });
});

describe('importing an exported log', () => {
  const build = (files: FileStore) =>
    new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });

  const idAt = (n: number): string => `01M1${String(n).padStart(22, '0')}`;

  const retitle = (entityId: string, id: string, ts: number, title: string): Event =>
    newEvent({ deviceId: 'phone', id, type: 'update', entity: 'task', entityId, payload: { title }, ts });

  it('replays an imported event into its place in the order, not onto the end', () => {
    /*
     * The whole difference between folding forward and replaying. An imported
     * event can carry any timestamp, so it can sort before events already
     * applied, and last-write-wins only gives the right answer if the log is
     * ordered together. Folded onto the end, the older title wins purely
     * because it arrived last, which is the one thing the ordering exists to
     * prevent.
     */
    const created = task('Preamp');
    const settled = retitle(created.entityId, idAt(2), BASE + 2000, 'Preamp, second attempt');
    const store = new Store({
      now: () => BASE,
      storage: null,
      vault: memoryStore(),
      seed: [created, settled],
    });

    const stale = retitle(created.entityId, idAt(1), BASE + 1000, 'Preamp, first guess');
    expect(store.importJson(JSON.stringify({ events: [stale] }))).toEqual({ ok: true, added: 1 });

    expect(store.getSnapshot().state.tasks[created.entityId]!.title).toBe('Preamp, second attempt');
  });

  it('keeps the history the cache accounts for when the log has been compacted', async () => {
    /*
     * A guard on the base a replay is given, not on the import itself.
     *
     * Once a push has been acknowledged the log holds only what is above the
     * watermark, and the cache is the only thing that still describes the rest.
     * Replaying the log alone here is a full-history loss, and it is what
     * happens if the base is left undefined because nothing has adopted a
     * remote state in this session yet.
     */
    const a = task('Solder the preamp');
    const b = task('Order the transformer');
    const files = memoryFiles();
    await writeCache(files, watermarkOf([a, b]), replay([a, b]));
    await writeLog(files, []);

    const store = build(files);
    await store.load();
    const fresh = task('Cut the chassis');
    expect(store.importJson(JSON.stringify({ events: [fresh] }))).toEqual({ ok: true, added: 1 });

    expect(
      Object.values(store.getSnapshot().state.tasks)
        .map(t => t.title)
        .sort(),
    ).toEqual(['Cut the chassis', 'Order the transformer', 'Solder the preamp']);
  });

  it('does not add time in twice that the cache already accounts for', async () => {
    /*
     * The other half of that guard, and the reason the base cannot simply have
     * its watermark stripped the way an adopted remote state does.
     *
     * Until a push truncates it the log still holds the events the cache
     * covers, so base and log overlap. `coversThrough` is what stops the
     * overlap being applied a second time, and a timeDelta applied twice is
     * time the user did not spend, recorded permanently.
     */
    const created = task('Solder the preamp');
    const spent = newEvent({
      deviceId: 'laptop',
      id: idAt(9),
      type: 'timeDelta',
      entity: 'task',
      entityId: created.entityId,
      payload: { day: dayStr(BASE), ms: 90_000 },
      ts: BASE + 90_000,
    });
    const files = memoryFiles();
    await writeCache(files, watermarkOf([created, spent]), replay([created, spent]));
    await writeLog(files, [created, spent]);

    const store = build(files);
    await store.load();
    expect(store.getSnapshot().state.tasks[created.entityId]!.timeSpent).toBe(90_000);

    store.importJson(JSON.stringify({ events: [task('Cut the chassis')] }));
    expect(store.getSnapshot().state.tasks[created.entityId]!.timeSpent).toBe(90_000);
  });
});

describe('a log this app did not write', () => {
  /*
   * Three shapes that are not corruption in the "cut short by a kill" sense and
   * still must never be written over. The rule is one rule: if the file is not
   * exactly the shape this app writes, it is not this app's to replace.
   */
  it('treats a log of exactly null as damaged rather than throwing', async () => {
    // `typeof null === 'object'`, so a shape check that only rules out
    // `undefined` walks straight into reading `.events` off null.
    const files = memoryFiles({ [LOG_FILE]: 'null' });
    await expect(load(files)).resolves.toMatchObject({ events: [] });
    expect((await load(files)).damaged).toBeTruthy();
  });

  it('treats a log from a newer format as damaged rather than reading it as this one', async () => {
    // The cache checks its version and the log did not, so a v2 log was read as
    // v1 and rewritten as v1. The cache can be discarded on doubt. The log
    // cannot, so the only safe response to a version it cannot read is to stop.
    const files = memoryFiles({ [LOG_FILE]: JSON.stringify({ version: 2, events: [task('a')] }) });
    const { events, damaged } = await load(files);
    expect(events).toEqual([]);
    expect(damaged).toBeTruthy();
  });

  it('treats a log holding an unusable entry as damaged rather than dropping it', async () => {
    // Silently filtering the entry out and then rewriting the file is a delete
    // the user never asked for, of the one copy nothing else has.
    const files = memoryFiles({
      [LOG_FILE]: JSON.stringify({ version: 1, events: [task('a'), { id: 42 }] }),
    });
    const { events, damaged } = await load(files);
    expect(events).toEqual([]);
    expect(damaged).toBeTruthy();
  });
});

describe('a log that cannot be read at all', () => {
  /** A store whose reads throw, as EACCES or EIO does, rather than returning null. */
  const throwingFiles = (contents: Map<string, string>, failing: string): FileStore => ({
    async read(name) {
      if (name === failing) throw new Error('EIO: i/o error');
      return contents.get(name) ?? null;
    },
    async write(name, text) {
      contents.set(name, text);
    },
    async remove(name) {
      contents.delete(name);
    },
  });

  it('reports damage rather than rejecting when the log cannot be read', async () => {
    // Unparseable content was handled and an unreadable file was not, though
    // they mean the same thing to everything downstream.
    const contents = new Map<string, string>();
    await expect(load(throwingFiles(contents, LOG_FILE))).resolves.toMatchObject({ events: [] });
    expect((await load(throwingFiles(contents, LOG_FILE))).damaged).toBeTruthy();
  });

  it('ignores a cache that cannot be read, because a cache is derivable', async () => {
    const contents = new Map<string, string>([
      [LOG_FILE, JSON.stringify({ version: 1, events: [task('Solder the preamp')] })],
    ]);
    const { events, damaged, cached } = await load(throwingFiles(contents, CACHE_FILE));
    expect(events).toHaveLength(1);
    expect(cached).toBe(false);
    expect(damaged).toBeUndefined();
  });

  it('does not reject when the vault refuses to answer', async () => {
    /*
     * The caller chains the first sync onto this promise. A rejection therefore
     * skipped the sync too, so one unreadable settings key stopped work that
     * was already safely on disk from ever reaching the repository.
     */
    const vault = {
      get: async (): Promise<string | null> => {
        throw new Error('EACCES: permission denied');
      },
      set: async (): Promise<void> => undefined,
      remove: async (): Promise<void> => undefined,
      keys: async (): Promise<string[]> => [],
    };
    const store = new Store({ now: () => BASE, storage: null, vault, files: memoryFiles() });
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('never writes a short log over the real one after a failed read', async () => {
    /*
     * The whole point of the guard. `load` rejecting left `storageError` null,
     * so the store carried on with an empty log and the next save put that
     * empty log on disk. Three events became one.
     */
    const real = [task('a'), task('b'), task('c')];
    const contents = new Map<string, string>([
      [LOG_FILE, JSON.stringify({ version: 1, events: real })],
    ]);
    const files = throwingFiles(contents, LOG_FILE);

    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.getSnapshot().storageError).toBeTruthy();

    store.addTask('written during the degraded session');
    await store.flush();

    const stillThere = JSON.parse(contents.get(LOG_FILE)!) as { events: Event[] };
    expect(stillThere.events).toHaveLength(3);
  });
});

describe('the damaged flag and a failed write are different facts', () => {
  it('does not let a write failure clear the damaged flag', async () => {
    /*
     * They were one field. A damaged log set `storageError`; a later cache
     * write failed and set it again; the persist after that saw a non-null
     * `writeFailure`, published `storageError: null` to say the write had
     * recovered, and unstuck the damaged guard. The next persist then wrote
     * over the damaged bytes.
     */
    const contents = new Map<string, string>([[LOG_FILE, '{"version":1,"events":[{"id":"01A","ty']]);
    let failWrite = true;
    const files: FileStore = {
      async read(name) {
        return contents.get(name) ?? null;
      },
      async write(name, text) {
        if (failWrite) throw new Error('no space left on device');
        contents.set(name, text);
      },
      async remove(name) {
        contents.delete(name);
      },
    };

    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    await store.load();
    const damaged = store.getSnapshot().storageError;
    expect(damaged).toContain('could not be read');

    // A forced cache write is the only write still attempted while damaged, so
    // it is the only one that can fail and set the transient flag.
    store.addTask('a');
    store.markPushed(store.pending().at(-1)!.id);
    await store.flush();
    // Not "Could not save": while the log is damaged nothing is attempted, so
    // there is no write to fail and nothing that can replace the message.
    expect(store.getSnapshot().storageError).toBe(damaged);

    failWrite = false;
    store.addTask('b');
    store.markPushed(store.pending().at(-1)!.id);
    await store.flush();
    store.addTask('c');
    await store.flush();

    // Still damaged, and the bytes are still the damaged ones.
    expect(store.getSnapshot().storageError).toContain('could not be read');
    expect(contents.get(LOG_FILE)).toBe('{"version":1,"events":[{"id":"01A","ty');
  });

  it('writes nothing at all while the log is damaged, including the cache', async () => {
    // The notice tells the user nothing is being written. A forced cache write
    // would make that untrue, for a file that buys nothing while the log it
    // describes cannot be read.
    const contents = new Map<string, string>([[LOG_FILE, 'not json']]);
    const written: string[] = [];
    const files: FileStore = {
      async read(name) {
        return contents.get(name) ?? null;
      },
      async write(name, text) {
        written.push(name);
        contents.set(name, text);
      },
      async remove(name) {
        contents.delete(name);
      },
    };
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    await store.load();
    store.addTask('a');
    store.markPushed(store.pending().at(-1)!.id);
    await store.flush();
    expect(written).toEqual([]);
  });

  it('goes on writing after a write fails, because a failed write is transient', async () => {
    /*
     * The other direction, and the reason the two facts cannot share a field.
     * Guarding the writes on the user-visible error would mean one full disk
     * latched saving off for the rest of the session: nothing would write, so
     * nothing would ever clear the error that was stopping the writes.
     */
    const contents = new Map<string, string>();
    let failWrite = true;
    const files: FileStore = {
      async read(name) {
        return contents.get(name) ?? null;
      },
      async write(name, text) {
        if (failWrite) throw new Error('no space left on device');
        contents.set(name, text);
      },
      async remove(name) {
        contents.delete(name);
      },
    };
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    store.addTask('written while the disk was full');
    await store.flush();
    expect(store.getSnapshot().storageError).toContain('Could not save');

    failWrite = false;
    store.addTask('written after it cleared');
    await store.flush();

    expect(store.getSnapshot().storageError).toBeNull();
    const written = JSON.parse(contents.get(LOG_FILE)!) as { events: Event[] };
    expect(written.events).toHaveLength(2);
  });

  it('keeps the work of the degraded session when a fresh log is started', async () => {
    /*
     * `startFreshLog` emptied the log. Those events are the only copy there has
     * ever been, because the damaged flag is what stopped them being written,
     * so emptying it is the loss the whole degraded mode exists to prevent.
     */
    const contents = new Map<string, string>([[LOG_FILE, 'not json']]);
    const files: FileStore = {
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
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), files });
    await store.load();
    store.addTask('typed while the log was unreadable');

    const kept = await store.startFreshLog();
    expect(kept).toBeTruthy();
    expect(store.getSnapshot().storageError).toBeNull();

    // On screen, and now actually on disk.
    expect(Object.values(store.getSnapshot().state.tasks).map(t => t.title)).toEqual([
      'typed while the log was unreadable',
    ]);
    const fresh = JSON.parse(contents.get(LOG_FILE)!) as { events: Event[] };
    expect(fresh.events).toHaveLength(1);
  });
});

describe('an event the base already accounts for', () => {
  const build = () => new Store({ now: () => BASE, storage: null, vault: memoryStore() });

  it('does not add its time a second time when it is fed back after a sync', async () => {
    /*
     * The hole the fold fix opened. Stripping the watermark off the adopted
     * base was safe only under the premise that everything replayed onto it is
     * known not to be in it. `merge` dedups against the local log, and after a
     * push the local log is empty, so an event the snapshot already accounts
     * for passed the dedup and was applied on top of the snapshot that already
     * held it. For a timeDelta that is time the user did not spend.
     */
    const created = task('Solder the preamp');
    const spent = delta(created.entityId, BASE + 3_600_000, 3_600_000);
    const store = new Store({
      now: () => BASE,
      storage: null,
      vault: memoryStore(),
      seed: [created, spent],
    });

    // A push acknowledged both, then a pull adopted the snapshot holding them.
    store.markPushed(watermarkOf([created, spent]));
    store.adoptRemote(covering([created, spent]));
    expect(store.getSnapshot().state.tasks[created.entityId]!.timeSpent).toBe(3_600_000);

    store.importJson(JSON.stringify({ events: [created, spent] }));
    expect(store.getSnapshot().state.tasks[created.entityId]!.timeSpent).toBe(3_600_000);
  });

  it('is logged but does not change state when it arrives below the watermark', async () => {
    // The accepted cost of compaction, pinned so it stays deliberate: below the
    // watermark the snapshot is the authority, so the event still goes into the
    // log and still syncs, and it cannot move the state here.
    const created = task('Solder the preamp');
    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore() });
    store.markPushed(created.id);
    store.adoptRemote(covering([created]));

    const old = { ...task('minted before the snapshot'), id: '01A0000000000000000000000A' };
    expect(store.importJson(JSON.stringify({ events: [old] }))).toEqual({ ok: true, added: 1 });
    expect(store.getSnapshot().events.some(e => e.id === old.id)).toBe(true);
    expect(Object.values(store.getSnapshot().state.tasks).map(t => t.title)).toEqual([
      'Solder the preamp',
    ]);
  });

  it('still applies a local event minted below an adopted watermark', () => {
    // The Important 3 case, which the fix above must not undo: this device's
    // own unpushed event sorts below the repository's watermark only because
    // another device's clock ran ahead, and it is genuinely not in the snapshot.
    const store = build();
    const ahead: Event = { ...task('From the other device'), id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', deviceId: 'phone' };
    store.adoptRemote({ ...replay([ahead]), coversThrough: ahead.id });

    const id = store.addTask('Solder the preamp');
    // Forces the full replay path rather than the fold.
    store.merge([{ ...task('Arrived from elsewhere'), id: '01ZZZZZZZZZZZZZZZZZZZZZZZb', deviceId: 'phone' }]);

    expect(store.getSnapshot().state.tasks[id]?.title).toBe('Solder the preamp');
  });
});

describe('importing an export from another device', () => {
  it('gives what a full replay of everything gives', () => {
    /*
     * The assertion the round-trip test never made. It imported this device's
     * own export and checked `added: 0`, which exercises the dedup and says
     * nothing about where the events land once they are in.
     */
    const mine = [task('Solder the preamp'), task('Order the transformer')];
    const theirs: Event[] = [
      { ...task('Cut the chassis'), deviceId: 'phone', ts: BASE - 86_400_000 },
      { ...task('Drill the panel'), deviceId: 'phone', ts: BASE - 172_800_000 },
    ];
    const spentThere = {
      ...delta(mine[0]!.entityId, BASE - 86_400_000 + 600_000, 600_000),
      deviceId: 'phone',
    };

    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), seed: mine });
    store.importJson(JSON.stringify({ events: [...theirs, spentThere] }));

    expect(store.getSnapshot().state).toEqual(replay([...mine, ...theirs, spentThere]));
  });

  it('is idempotent, however many times the same file is imported', () => {
    const mine = [task('Solder the preamp')];
    const theirs: Event[] = [{ ...task('Cut the chassis'), deviceId: 'phone', ts: BASE - 86_400_000 }];
    const spentThere = { ...delta(mine[0]!.entityId, BASE - 3_600_000, 600_000), deviceId: 'phone' };
    const file = JSON.stringify({ events: [...theirs, spentThere] });

    const store = new Store({ now: () => BASE, storage: null, vault: memoryStore(), seed: mine });
    expect(store.importJson(file)).toEqual({ ok: true, added: 2 });
    const once = store.getSnapshot().state;

    expect(store.importJson(file)).toEqual({ ok: true, added: 0 });
    expect(store.importJson(file)).toEqual({ ok: true, added: 0 });
    expect(store.getSnapshot().state).toEqual(once);
  });
});
