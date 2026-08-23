import { describe, it, expect } from 'vitest';
import { replay } from './replay.js';
import type { Event } from './events.js';
import type { State } from './state.js';

const ev = (o: Partial<Event>): Event => ({
  id: o.id!, deviceId: o.deviceId ?? 'a', ts: o.ts ?? 0,
  type: o.type ?? 'update', entity: 'task', entityId: o.entityId ?? 't1',
  payload: o.payload ?? {}, schemaVersion: 1,
});

describe('replay', () => {
  it('is order-independent: any shuffle of the same events yields the same state', () => {
    const evs = [
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'a', projectId: 'inbox' } }),
      ev({ id: '2', ts: 2, payload: { title: 'b' } }),
      ev({ id: '3', ts: 3, payload: { notes: 'n' } }),
    ];
    const forward = replay(evs);
    const backward = replay([...evs].reverse());
    expect(backward).toEqual(forward);
  });

  it('sums concurrent timeDelta events rather than overwriting', () => {
    const s = replay([
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'a', projectId: 'inbox' } }),
      ev({ id: '2', ts: 5, deviceId: 'a', type: 'timeDelta', payload: { day: '2026-08-23', ms: 1000 } }),
      ev({ id: '3', ts: 5, deviceId: 'b', type: 'timeDelta', payload: { day: '2026-08-23', ms: 2000 } }),
    ]);
    expect(s.tasks.t1.timeSpentOnDay['2026-08-23']).toBe(3000);
    expect(s.tasks.t1.timeSpent).toBe(3000);
  });

  it('merges updates that touch disjoint fields', () => {
    const s = replay([
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'a', projectId: 'inbox' } }),
      ev({ id: '2', ts: 5, deviceId: 'a', payload: { title: 'from-a' } }),
      ev({ id: '3', ts: 5, deviceId: 'b', payload: { notes: 'from-b' } }),
    ]);
    expect(s.tasks.t1.title).toBe('from-a');
    expect(s.tasks.t1.notes).toBe('from-b');
  });

  it('lets delete win over a concurrent update regardless of timestamp', () => {
    const s = replay([
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'a', projectId: 'inbox' } }),
      ev({ id: '2', ts: 9, type: 'update', payload: { title: 'late' } }),
      ev({ id: '3', ts: 5, type: 'delete', payload: {} }),
    ]);
    expect(s.tasks.t1).toBeUndefined();
  });

  it('breaks same-timestamp ties by deviceId, stably', () => {
    const s = replay([
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'a', projectId: 'inbox' } }),
      ev({ id: '2', ts: 5, deviceId: 'zzz', payload: { title: 'z' } }),
      ev({ id: '3', ts: 5, deviceId: 'aaa', payload: { title: 'a' } }),
    ]);
    expect(s.tasks.t1.title).toBe('z');
  });

  it('applies a duplicated event once, because sync delivers at least once', () => {
    const evs = [
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'a', projectId: 'inbox' } }),
      ev({ id: '2', ts: 5, type: 'timeDelta', payload: { day: '2026-08-23', ms: 1000 } }),
      ev({ id: '3', ts: 6, payload: { title: 'b' } }),
    ];
    const once = replay(evs);
    // A push that succeeded but whose response was lost gets retried, so the
    // same event id arrives twice. Last write wins survives that; a delta does
    // not, and the duplicate would be invisible.
    const twice = replay([evs[0]!, evs[1]!, evs[2]!, evs[1]!, evs[2]!]);
    expect(twice).toEqual(once);
    expect(twice.tasks.t1.timeSpentOnDay['2026-08-23']).toBe(1000);
  });

  it('lets a create after a delete bring the entity back', () => {
    const s = replay([
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'first', projectId: 'inbox' } }),
      ev({ id: '2', ts: 3, type: 'timeDelta', payload: { day: '2026-08-23', ms: 5000 } }),
      ev({ id: '3', ts: 5, type: 'delete', payload: {} }),
      ev({ id: '4', ts: 9, type: 'create', payload: { title: 'again', projectId: 'inbox' } }),
      ev({ id: '5', ts: 10, payload: { notes: 'after' } }),
    ]);
    expect(s.tasks.t1.title).toBe('again');
    expect(s.tasks.t1.notes).toBe('after');
    // The time belonged to the deleted task, not to the one that took its id.
    expect(s.tasks.t1.timeSpent).toBe(0);
  });

  it('still loses an update that falls between a delete and a later create', () => {
    const s = replay([
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'first', projectId: 'inbox' } }),
      ev({ id: '2', ts: 5, type: 'delete', payload: {} }),
      ev({ id: '3', ts: 7, payload: { title: 'ghost', notes: 'ghost' } }),
      ev({ id: '4', ts: 9, type: 'create', payload: { title: 'again', projectId: 'inbox' } }),
    ]);
    expect(s.tasks.t1.title).toBe('again');
    expect(s.tasks.t1.notes).toBeUndefined();
  });

  it('mutual exclusion: setting dueWithTime clears dueDay', () => {
    const s = replay([
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'a', projectId: 'inbox', dueDay: '2026-08-23' } }),
      ev({ id: '2', ts: 2, payload: { dueWithTime: 1755950000000 } }),
    ]);
    expect(s.tasks.t1.dueDay).toBeUndefined();
    expect(s.tasks.t1.dueWithTime).toBe(1755950000000);
  });
});

// A seeded generator, so a failure is reproducible rather than a one-off that
// nobody can bring back.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items: Event[], seed: number): Event[] {
  const rand = rng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function buildRandomLog(count: number, seed = 20260823): Event[] {
  const rand = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const devices = ['alpha', 'beta', 'gamma'];
  const taskIds = ['t1', 't2', 't3', 't4', 't5'];
  const projectIds = ['inbox', 'work'];
  const days = ['2026-08-21', '2026-08-22', '2026-08-23'];
  const out: Event[] = [];

  for (let i = 0; i < count; i++) {
    // A small timestamp range on purpose: collisions are what exercise the
    // deviceId and id tiebreakers.
    const ts = 1 + Math.floor(rand() * 12);
    const deviceId = pick(devices);
    const id = `e${String(i).padStart(3, '0')}`;
    const roll = rand();

    if (roll < 0.2) {
      out.push({
        id, deviceId, ts, type: 'create', entity: 'task', entityId: pick(taskIds),
        payload: { title: `t${i}`, projectId: pick(projectIds), timeEstimate: Math.floor(rand() * 5) * 60_000 },
        schemaVersion: 1,
      });
    } else if (roll < 0.4) {
      const payload: Record<string, unknown> = {};
      const field = pick(['title', 'notes', 'isDone', 'dueDay', 'dueWithTime', 'parentId', 'tagIds']);
      if (field === 'title') payload['title'] = `title-${i}`;
      else if (field === 'notes') payload['notes'] = `notes-${i}`;
      else if (field === 'isDone') payload['isDone'] = rand() < 0.5;
      else if (field === 'dueDay') payload['dueDay'] = pick(days);
      else if (field === 'dueWithTime') payload['dueWithTime'] = 1_755_000_000_000 + i;
      else if (field === 'parentId') payload['parentId'] = pick(taskIds);
      else payload['tagIds'] = [pick(['home', 'deep'])];
      out.push({ id, deviceId, ts, type: 'update', entity: 'task', entityId: pick(taskIds), payload, schemaVersion: 1 });
    } else if (roll < 0.75) {
      out.push({
        id, deviceId, ts, type: 'timeDelta', entity: 'task', entityId: pick(taskIds),
        payload: { day: pick(days), ms: Math.floor(rand() * 60_000) }, schemaVersion: 1,
      });
    } else if (roll < 0.85) {
      out.push({ id, deviceId, ts, type: 'delete', entity: 'task', entityId: pick(taskIds), payload: {}, schemaVersion: 1 });
    } else if (roll < 0.95) {
      out.push({
        id, deviceId, ts, type: 'create', entity: 'project', entityId: pick(projectIds),
        payload: { title: `p${i}`, color: '#123456' }, schemaVersion: 1,
      });
    } else {
      out.push({
        id, deviceId, ts, type: 'update', entity: 'settings', entityId: 'settings',
        payload: { theme: pick(['light', 'dark', 'system']), idleThresholdMs: 60_000 * (i + 1) },
        schemaVersion: 1,
      });
    }
  }
  return out;
}

describe('replay determinism', () => {
  it('any permutation of a 40-event log converges to the same state', () => {
    const evs = buildRandomLog(40);
    const reference = replay(evs);
    for (let i = 0; i < 25; i++) {
      expect(replay(shuffle(evs, 1000 + i))).toEqual(reference);
    }
  });

  it('the generated log is not trivially small', () => {
    const evs = buildRandomLog(40);
    const state = replay(evs);
    expect(evs).toHaveLength(40);
    expect(Object.keys(state.tasks).length).toBeGreaterThan(0);
    const tracked = Object.values(state.tasks).reduce((sum, t) => sum + t.timeSpent, 0);
    expect(tracked).toBeGreaterThan(0);
  });
});

function permutations(items: Event[]): Event[][] {
  if (items.length <= 1) return [items];
  const out: Event[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
  }
  return out;
}

describe('delete and re-create determinism', () => {
  it('converges under all 720 permutations of a log that deletes and re-creates', () => {
    const evs = [
      ev({ id: '1', ts: 1, type: 'create', payload: { title: 'first', projectId: 'inbox' } }),
      ev({ id: '2', ts: 3, type: 'timeDelta', payload: { day: '2026-08-23', ms: 5000 } }),
      ev({ id: '3', ts: 5, type: 'delete', payload: {} }),
      ev({ id: '4', ts: 9, type: 'create', payload: { title: 'again', projectId: 'inbox' } }),
      ev({ id: '5', ts: 10, payload: { notes: 'after' } }),
      ev({ id: '6', ts: 11, type: 'timeDelta', payload: { day: '2026-08-23', ms: 7000 } }),
    ];
    const perms = permutations(evs);
    expect(perms).toHaveLength(720);
    const reference = replay(evs);
    expect(reference.tasks.t1.timeSpent).toBe(7000);
    for (const perm of perms) expect(replay(perm)).toEqual(reference);
  });
});

describe('the snapshot watermark', () => {
  const createEv = ev({ id: '01AAA', ts: 1, type: 'create', payload: { title: 'a', projectId: 'inbox' } });
  const deltaEv = ev({ id: '01BBB', ts: 5, type: 'timeDelta', payload: { day: '2026-08-23', ms: 5000 } });

  it('discards an event the base has already folded in', () => {
    // What a compactor writes: the state, stamped with the last event it folded.
    const snapshot: State = { ...replay([createEv, deltaEv]), coversThrough: deltaEv.id };
    expect(snapshot.tasks.t1.timeSpent).toBe(5000);
    // The batch is redelivered after compaction folded it away. Dedup inside one
    // call cannot see it, so the watermark has to.
    expect(replay([deltaEv], snapshot)).toEqual(snapshot);
    expect(replay([createEv, deltaEv], snapshot).tasks.t1.timeSpent).toBe(5000);
  });

  it('still applies an event strictly newer than the watermark', () => {
    const snapshot: State = { ...replay([createEv, deltaEv]), coversThrough: deltaEv.id };
    const later = ev({ id: '01CCC', ts: 9, type: 'timeDelta', payload: { day: '2026-08-23', ms: 3000 } });
    const next = replay([later], snapshot);
    expect(next.tasks.t1.timeSpent).toBe(8000);
    // The watermark is the compactor's to move, not replay's: advancing it here
    // would silently discard a clock-skewed event that a full replay merges.
    expect(next.coversThrough).toBe(deltaEv.id);
  });

  it('filters nothing when the base carries no watermark', () => {
    const base = replay([createEv]);
    expect(base.coversThrough).toBeUndefined();
    expect(replay([deltaEv], base).tasks.t1.timeSpent).toBe(5000);
  });

  it('skips a malformed entry rather than throwing, watermark or no watermark', () => {
    // A log decoded from JSON can hold a null, which is why isWellFormed reads
    // `e?.id`. The watermark filter must not read an id off an entry nobody has
    // validated yet: one bad event must never stop a device loading its own data.
    const snapshot: State = { ...replay([createEv]), coversThrough: createEv.id };
    const later = ev({ id: '01CCC', ts: 9, type: 'timeDelta', payload: { day: '2026-08-23', ms: 3000 } });
    const log = [null as unknown as Event, later];
    expect(replay(log, snapshot).tasks.t1.timeSpent).toBe(3000);
    expect(replay(log).tasks.t1).toBeUndefined(); // no base, same tolerance
  });
});
