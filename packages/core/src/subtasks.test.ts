import { describe, it, expect } from 'vitest';
import { replay } from './replay.js';
import type { Event } from './events.js';

const ev = (o: Partial<Event>): Event => ({
  id: o.id!, deviceId: o.deviceId ?? 'a', ts: o.ts ?? 0,
  type: o.type ?? 'update', entity: 'task', entityId: o.entityId ?? 't1',
  payload: o.payload ?? {}, schemaVersion: 1,
});

describe('subtask nesting', () => {
  it('refuses a third level of nesting and leaves state consistent', () => {
    const s = replay([
      ev({ id: '1', ts: 1, entityId: 'p', type: 'create', payload: { title: 'parent', projectId: 'inbox' } }),
      ev({ id: '2', ts: 2, entityId: 'c', type: 'create', payload: { title: 'child', projectId: 'inbox', parentId: 'p' } }),
      ev({ id: '3', ts: 3, entityId: 'g', type: 'create', payload: { title: 'grand', projectId: 'inbox', parentId: 'c' } }),
    ]);
    expect(s.tasks.c.parentId).toBe('p');
    expect(s.tasks.g).toBeUndefined();
    expect(s.tasks.c.subTaskIds).toEqual([]);
    expect(s.tasks.p.subTaskIds).toEqual(['c']);
  });

  it('caps by the whole log, not by arrival order, when the parent event is late', () => {
    // The grandchild's create carries the earliest timestamp, so a check that
    // only looked at the state so far would let it through.
    const s = replay([
      ev({ id: '3', ts: 1, entityId: 'g', type: 'create', payload: { title: 'grand', projectId: 'inbox', parentId: 'c' } }),
      ev({ id: '2', ts: 2, entityId: 'c', type: 'create', payload: { title: 'child', projectId: 'inbox', parentId: 'p' } }),
      ev({ id: '1', ts: 3, entityId: 'p', type: 'create', payload: { title: 'parent', projectId: 'inbox' } }),
    ]);
    expect(s.tasks.g).toBeUndefined();
    expect(s.tasks.c.parentId).toBe('p');
  });

  it('ignores a reparent that would push a task to a third level, keeping the rest of the update', () => {
    const s = replay([
      ev({ id: '1', ts: 1, entityId: 'p', type: 'create', payload: { title: 'parent', projectId: 'inbox' } }),
      ev({ id: '2', ts: 2, entityId: 'c', type: 'create', payload: { title: 'child', projectId: 'inbox', parentId: 'p' } }),
      ev({ id: '3', ts: 3, entityId: 'x', type: 'create', payload: { title: 'other', projectId: 'inbox' } }),
      ev({ id: '4', ts: 4, entityId: 'x', type: 'update', payload: { parentId: 'c', title: 'renamed' } }),
    ]);
    expect(s.tasks.x.parentId).toBeUndefined();
    expect(s.tasks.x.title).toBe('renamed');
  });

  it('refuses a task that is its own parent', () => {
    const s = replay([
      ev({ id: '1', ts: 1, entityId: 'p', type: 'create', payload: { title: 'parent', projectId: 'inbox', parentId: 'p' } }),
    ]);
    expect(s.tasks.p).toBeUndefined();
  });

  it('skips the malformed event without breaking the rest of the replay', () => {
    const s = replay([
      ev({ id: '1', ts: 1, entityId: 'p', type: 'create', payload: { title: 'parent', projectId: 'inbox' } }),
      ev({ id: '2', ts: 2, entityId: 'c', type: 'create', payload: { title: 'child', projectId: 'inbox', parentId: 'p' } }),
      ev({ id: '3', ts: 3, entityId: 'g', type: 'create', payload: { title: 'grand', projectId: 'inbox', parentId: 'c' } }),
      ev({ id: '4', ts: 4, entityId: 'after', type: 'create', payload: { title: 'after', projectId: 'inbox' } }),
    ]);
    expect(s.tasks.after.title).toBe('after');
    expect(Object.keys(s.tasks).sort()).toEqual(['after', 'c', 'p']);
  });
});

describe('subtask cap resolution', () => {
  it('rejects only the link that breaks the cap, not every task in the chain', () => {
    // c is a root, b is legitimately its child, a would be a third level.
    const s = replay([
      ev({ id: '1', ts: 1, entityId: 'c', type: 'create', payload: { title: 'c', projectId: 'inbox' } }),
      ev({ id: '2', ts: 2, entityId: 'b', type: 'create', payload: { title: 'b', projectId: 'inbox', parentId: 'c' } }),
      ev({ id: '3', ts: 3, entityId: 'a', type: 'create', payload: { title: 'a', projectId: 'inbox', parentId: 'b' } }),
    ]);
    expect(s.tasks.b.parentId).toBe('c');
    expect(s.tasks.c.subTaskIds).toEqual(['b']);
    expect(s.tasks.a).toBeUndefined();
  });
});

describe('deleting a parent', () => {
  it('leaves the children reachable as roots instead of dangling', () => {
    const s = replay([
      ev({ id: '1', ts: 1, entityId: 'p', type: 'create', payload: { title: 'p', projectId: 'inbox' } }),
      ev({ id: '2', ts: 2, entityId: 'c1', type: 'create', payload: { title: 'c1', projectId: 'inbox', parentId: 'p' } }),
      ev({ id: '3', ts: 3, entityId: 'c2', type: 'create', payload: { title: 'c2', projectId: 'inbox', parentId: 'p' } }),
      ev({ id: '4', ts: 4, entityId: 'p', type: 'delete', payload: {} }),
    ]);
    expect(s.tasks.p).toBeUndefined();
    // A view that renders roots as !parentId must still find them.
    const roots = Object.values(s.tasks).filter(t => !t.parentId).map(t => t.id).sort();
    expect(roots).toEqual(['c1', 'c2']);
    expect(s.tasks.c1.parentId).toBeUndefined();
    expect(s.tasks.c2.parentId).toBeUndefined();
  });

  it('clears a parentId that points at a task the log never created', () => {
    const s = replay([
      ev({ id: '1', ts: 1, entityId: 'orphan', type: 'create', payload: { title: 'o', projectId: 'inbox', parentId: 'never-created' } }),
    ]);
    expect(s.tasks.orphan.parentId).toBeUndefined();
  });
});
