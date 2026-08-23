import { describe, expect, it } from 'vitest';

import { newEvent, type Event } from '../events.js';
import { dayStr } from '../models.js';
import {
  TOOLS,
  memoryBackend,
  memoryTimerStore,
  toolByName,
  toolContext,
  type MemoryBackend,
  type ToolContext,
} from './index.js';

const DEVICE = 'test-device';
// A fixed clock, so a day string in an expectation is a constant and not
// whatever day the suite happens to run on.
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);
const TODAY = dayStr(NOW);

function seed(...events: Event[]): Event[] {
  return events;
}

function ev(entityId: string, payload: unknown, type: Event['type'] = 'create'): Event {
  return newEvent({ deviceId: 'seed', type, entity: 'task', entityId, payload, ts: NOW - 60_000 });
}

interface Harness {
  ctx: ToolContext;
  backend: MemoryBackend;
  call(name: string, args?: unknown): Promise<{ text: string; isError?: boolean }>;
  json(name: string, args?: unknown): Promise<any>;
}

function harness(events: Event[] = [], now: number = NOW): Harness {
  const backend = memoryBackend(events);
  const ctx = toolContext({
    backend,
    timers: memoryTimerStore(),
    deviceId: DEVICE,
    now: () => now,
  });
  const call = async (name: string, args: unknown = {}) => {
    const tool = toolByName(name);
    if (tool === undefined) throw new Error(`no such tool: ${name}`);
    return tool.run(args, ctx);
  };
  return {
    ctx,
    backend,
    call,
    json: async (name, args) => JSON.parse((await call(name, args)).text),
  };
}

describe('tool registry', () => {
  it('exposes the nine tools once each', () => {
    expect(TOOLS.map(t => t.name)).toEqual([
      'list_tasks',
      'search_tasks',
      'today',
      'add_task',
      'update_task',
      'complete_task',
      'start_timer',
      'stop_timer',
      'log_time',
    ]);
  });

  it('marks the reads readOnlyHint and the reruns idempotentHint', () => {
    const readOnly = TOOLS.filter(t => t.annotations.readOnlyHint === true).map(t => t.name);
    expect(readOnly).toEqual(['list_tasks', 'search_tasks', 'today']);

    const idempotent = TOOLS.filter(t => t.annotations.idempotentHint === true).map(t => t.name);
    expect(idempotent).toContain('update_task');
    expect(idempotent).toContain('complete_task');
  });

  it('gives every tool a JSON-schema-convertible object schema', () => {
    for (const tool of TOOLS) {
      const schema = tool.inputSchema['~standard'].jsonSchema.input();
      expect(schema, tool.name).toMatchObject({ type: 'object' });
    }
  });
});

describe('add_task', () => {
  it('appends one create event and returns the new task', async () => {
    const h = harness();
    const out = await h.json('add_task', { title: 'Write the brief', estimateMinutes: 30 });

    expect(out.task.title).toBe('Write the brief');
    expect(out.task.projectId).toBe('inbox');
    expect(out.task.estimateMinutes).toBe(30);
    expect(h.backend.appended).toHaveLength(1);
    expect(h.backend.appended[0]!.type).toBe('create');
    expect(h.backend.appended[0]!.deviceId).toBe(DEVICE);
  });

  it('rejects a parentId that is already a child', async () => {
    const h = harness(
      seed(
        ev('parent', { title: 'Parent' }),
        ev('child', { title: 'Child', parentId: 'parent' }),
      ),
    );

    const out = await h.call('add_task', { title: 'Grandchild', parentId: 'child' });

    expect(out.isError).toBe(true);
    expect(out.text).toContain('two levels');
    expect(out.text).toContain('child');
    expect(h.backend.appended).toHaveLength(0);
  });

  it('rejects a parentId no task has', async () => {
    const h = harness();
    const out = await h.call('add_task', { title: 'Orphan', parentId: 'nope' });

    expect(out.isError).toBe(true);
    expect(out.text).toContain('nope');
    expect(h.backend.appended).toHaveLength(0);
  });

  it('accepts a parent that has no parent of its own', async () => {
    const h = harness(seed(ev('parent', { title: 'Parent' })));
    const out = await h.json('add_task', { title: 'Child', parentId: 'parent' });

    expect(out.task.parentId).toBe('parent');
    expect(h.backend.appended).toHaveLength(1);
  });

  it('refuses a due day and a due time together', async () => {
    const h = harness();
    const out = await h.call('add_task', {
      title: 'Both',
      dueDay: '2026-08-23',
      dueAt: '2026-08-23T09:00:00Z',
    });

    expect(out.isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });

  it('reports a schema violation as an error result, not a throw', async () => {
    const h = harness();
    const out = await h.call('add_task', { title: '' });

    expect(out.isError).toBe(true);
    expect(out.text).toContain('title');
    expect(h.backend.appended).toHaveLength(0);
  });
});

describe('list_tasks', () => {
  const events = seed(
    ev('a', { title: 'Alpha', projectId: 'work' }),
    ev('b', { title: 'Beta', projectId: 'work', isDone: true, doneOn: NOW - 60_000 }),
    ev('c', { title: 'Gamma', projectId: 'home' }),
  );

  it('filters by project and excludes done by default', async () => {
    const h = harness(events);
    const out = await h.json('list_tasks', { projectId: 'work' });

    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['a']);
    expect(out.total).toBe(1);
  });

  it('includes done tasks when asked', async () => {
    const h = harness(events);
    const out = await h.json('list_tasks', { projectId: 'work', includeDone: true });

    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['a', 'b']);
  });

  it('honours limit and reports the untruncated total', async () => {
    const h = harness(events);
    const out = await h.json('list_tasks', { limit: 1 });

    expect(out.tasks).toHaveLength(1);
    expect(out.total).toBe(2);
  });
});

describe('search_tasks', () => {
  it('matches title and notes case-insensitively', async () => {
    const h = harness(
      seed(
        ev('a', { title: 'Rewrite the SYNC engine' }),
        ev('b', { title: 'Groceries', notes: 'milk and sync cable' }),
        ev('c', { title: 'Unrelated' }),
      ),
    );

    const out = await h.json('search_tasks', { query: 'sync' });
    expect(out.tasks.map((t: { id: string }) => t.id).sort()).toEqual(['a', 'b']);
  });
});

describe('today', () => {
  it('returns tracked and planned totals', async () => {
    const h = harness(
      seed(
        ev('a', { title: 'Due today', dueDay: TODAY, timeEstimate: 45 * 60_000 }),
        ev('b', { title: 'Due tomorrow', dueDay: '2099-01-01', timeEstimate: 90 * 60_000 }),
        ev('a', { day: TODAY, ms: 20 * 60_000 }, 'timeDelta'),
      ),
    );

    const out = await h.json('today');

    expect(out.day).toBe(TODAY);
    expect(out.plannedMinutes).toBe(45);
    expect(out.trackedMinutes).toBe(20);
    expect(out.tasks.map((t: { id: string }) => t.id)).toEqual(['a']);
  });
});

describe('read-only tools', () => {
  it('do not emit events', async () => {
    const h = harness(seed(ev('a', { title: 'Alpha', dueDay: TODAY })));

    await h.call('list_tasks');
    await h.call('search_tasks', { query: 'alpha' });
    await h.call('today');

    expect(h.backend.appended).toEqual([]);
  });
});

describe('update_task', () => {
  it('emits an update carrying only the fields it was given', async () => {
    const h = harness(seed(ev('a', { title: 'Old', notes: 'keep me' })));
    await h.call('update_task', { id: 'a', title: 'New' });

    expect(h.backend.appended).toHaveLength(1);
    expect(h.backend.appended[0]!.payload).toEqual({ title: 'New' });
  });

  it('clears both due fields on clearDue', async () => {
    const h = harness(seed(ev('a', { title: 'Old', dueDay: TODAY })));
    await h.call('update_task', { id: 'a', clearDue: true });

    expect(h.backend.appended[0]!.payload).toEqual({ dueDay: null, dueWithTime: null });
  });

  it('refuses an unknown task', async () => {
    const h = harness();
    const out = await h.call('update_task', { id: 'ghost', title: 'x' });

    expect(out.isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });

  it('refuses a reparent that would break the two-level cap', async () => {
    const h = harness(
      seed(
        ev('parent', { title: 'Parent' }),
        ev('child', { title: 'Child', parentId: 'parent' }),
        ev('other', { title: 'Other' }),
      ),
    );
    const out = await h.call('update_task', { id: 'other', parentId: 'child' });

    expect(out.isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });

  it('refuses a call that changes nothing', async () => {
    const h = harness(seed(ev('a', { title: 'Old' })));
    const out = await h.call('update_task', { id: 'a' });

    expect(out.isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });
});

describe('complete_task', () => {
  it('marks done and stamps the completion time', async () => {
    const h = harness(seed(ev('a', { title: 'Alpha' })));
    await h.call('complete_task', { id: 'a' });

    expect(h.backend.appended[0]!.payload).toEqual({ isDone: true, doneOn: NOW });
  });

  it('is idempotent: completing a done task emits nothing', async () => {
    const h = harness(seed(ev('a', { title: 'Alpha', isDone: true, doneOn: NOW - 1000 })));
    const out = await h.call('complete_task', { id: 'a' });

    expect(out.isError).toBeUndefined();
    expect(h.backend.appended).toHaveLength(0);
  });

  it('reopens a task and clears the completion stamp', async () => {
    const h = harness(seed(ev('a', { title: 'Alpha', isDone: true, doneOn: NOW - 1000 })));
    await h.call('complete_task', { id: 'a', done: false });

    expect(h.backend.appended[0]!.payload).toEqual({ isDone: false, doneOn: null });
  });
});

describe('log_time', () => {
  it('emits a timeDelta increment for today by default', async () => {
    const h = harness(seed(ev('a', { title: 'Alpha' })));
    await h.call('log_time', { id: 'a', minutes: 25 });

    expect(h.backend.appended[0]!.type).toBe('timeDelta');
    expect(h.backend.appended[0]!.payload).toEqual({ day: TODAY, ms: 25 * 60_000 });
  });

  it('credits an explicit day', async () => {
    const h = harness(seed(ev('a', { title: 'Alpha' })));
    await h.call('log_time', { id: 'a', minutes: 10, day: '2026-08-01' });

    expect(h.backend.appended[0]!.payload).toEqual({ day: '2026-08-01', ms: 10 * 60_000 });
  });

  it('refuses zero minutes', async () => {
    const h = harness(seed(ev('a', { title: 'Alpha' })));
    const out = await h.call('log_time', { id: 'a', minutes: 0 });

    expect(out.isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });
});

describe('timers', () => {
  it('start then stop banks the elapsed span as a timeDelta', async () => {
    const backend = memoryBackend(seed(ev('a', { title: 'Alpha' })));
    const timers = memoryTimerStore();
    let now = NOW;
    const ctx = toolContext({ backend, timers, deviceId: DEVICE, now: () => now });

    await toolByName('start_timer')!.run({ id: 'a' }, ctx);
    expect(backend.appended).toHaveLength(0);
    expect(await timers.read()).toEqual({ taskId: 'a', startedAt: NOW });

    now = NOW + 90_000;
    const stopped = await toolByName('stop_timer')!.run({}, ctx);

    expect(stopped.isError).toBeUndefined();
    expect(backend.appended).toHaveLength(1);
    expect(backend.appended[0]!.payload).toEqual({ day: TODAY, ms: 90_000 });
    expect(await timers.read()).toBeNull();
  });

  it('starting a second timer banks the first', async () => {
    const backend = memoryBackend(seed(ev('a', { title: 'Alpha' }), ev('b', { title: 'Beta' })));
    const timers = memoryTimerStore();
    let now = NOW;
    const ctx = toolContext({ backend, timers, deviceId: DEVICE, now: () => now });

    await toolByName('start_timer')!.run({ id: 'a' }, ctx);
    now = NOW + 60_000;
    await toolByName('start_timer')!.run({ id: 'b' }, ctx);

    expect(backend.appended).toHaveLength(1);
    expect(backend.appended[0]!.entityId).toBe('a');
    expect(await timers.read()).toEqual({ taskId: 'b', startedAt: now });
  });

  it('reports an error when nothing is running', async () => {
    const h = harness();
    const out = await h.call('stop_timer');

    expect(out.isError).toBe(true);
    expect(out.text).toContain('log_time');
  });

  it('refuses to bank a span longer than the session cap and clears the timer', async () => {
    const backend = memoryBackend(seed(ev('a', { title: 'Alpha' })));
    const timers = memoryTimerStore();
    let now = NOW;
    const ctx = toolContext({
      backend,
      timers,
      deviceId: DEVICE,
      now: () => now,
      maxSessionMs: 3600_000,
    });

    await toolByName('start_timer')!.run({ id: 'a' }, ctx);
    now = NOW + 5 * 3600_000;
    const out = await toolByName('stop_timer')!.run({}, ctx);

    expect(out.isError).toBe(true);
    expect(out.text).toContain('log_time');
    expect(backend.appended).toHaveLength(0);
    expect(await timers.read()).toBeNull();
  });

  it('credits the span to the day it started on', async () => {
    const backend = memoryBackend(seed(ev('a', { title: 'Alpha' })));
    const timers = memoryTimerStore();
    const start = Date.UTC(2026, 7, 23, 23, 50, 0);
    let now = start;
    const ctx = toolContext({ backend, timers, deviceId: DEVICE, now: () => now });

    await toolByName('start_timer')!.run({ id: 'a' }, ctx);
    now = start + 20 * 60_000;
    await toolByName('stop_timer')!.run({}, ctx);

    expect((backend.appended[0]!.payload as { day: string }).day).toBe(dayStr(start));
  });

  it('refuses to start on a task that does not exist', async () => {
    const h = harness();
    const out = await h.call('start_timer', { id: 'ghost' });

    expect(out.isError).toBe(true);
    expect(await h.ctx.timers.read()).toBeNull();
  });
});
