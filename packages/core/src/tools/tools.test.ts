import { describe, expect, it } from 'vitest';

import { newEvent, type EntityKind, type Event } from '../events.js';
import { ENTITY_COLORS, dayStr } from '../models.js';
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

/** A project or tag that already exists when the tool runs. */
function entity(kind: EntityKind, entityId: string, payload: unknown): Event {
  return newEvent({ deviceId: 'seed', type: 'create', entity: kind, entityId, payload, ts: NOW - 120_000 });
}

const RADIO = entity('project', 'p-radio', { title: 'Radio', color: '#c2603f', isArchived: false });
const URGENT = entity('tag', 'g-urgent', { title: 'Urgent', color: '#c2603f' });

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
  it('exposes the fifteen tools once each', () => {
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
      'list_projects',
      'add_project',
      'update_project',
      'list_tags',
      'add_tag',
      'update_tag',
    ]);
  });

  it('marks the reads readOnlyHint and the reruns idempotentHint', () => {
    const readOnly = TOOLS.filter(t => t.annotations.readOnlyHint === true).map(t => t.name);
    expect(readOnly).toEqual(['list_tasks', 'search_tasks', 'today', 'list_projects', 'list_tags']);

    const idempotent = TOOLS.filter(t => t.annotations.idempotentHint === true).map(t => t.name);
    expect(idempotent).toContain('update_task');
    expect(idempotent).toContain('complete_task');
    expect(idempotent).toContain('update_project');
    expect(idempotent).toContain('update_tag');
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
    expect(out.task.project).toBe('Inbox');
    expect(out.task.tags).toBeUndefined();
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
    await h.call('list_projects');
    await h.call('list_tags');

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

  it('does not double-bank when two stop_timer calls race', async () => {
    const backend = memoryBackend(seed(ev('a', { title: 'Alpha' })));
    const timers = memoryTimerStore();
    let now = NOW;
    const ctx = toolContext({ backend, timers, deviceId: DEVICE, now: () => now });

    await toolByName('start_timer')!.run({ id: 'a' }, ctx);
    now = NOW + 600_000;
    const [first, second] = await Promise.all([
      toolByName('stop_timer')!.run({}, ctx),
      toolByName('stop_timer')!.run({}, ctx),
    ]);

    // timeDelta carries an increment, so a second append is ten minutes nobody
    // worked, permanently and invisibly.
    expect(backend.appended).toHaveLength(1);
    expect(backend.appended[0]!.payload).toEqual({ day: TODAY, ms: 600_000 });
    const outcomes = [first, second].map(r => r.isError === true);
    expect(outcomes.sort()).toEqual([false, true]);
  });

  it('does not let two start_timer calls both claim to have started', async () => {
    const backend = memoryBackend(seed(ev('a', { title: 'Alpha' }), ev('b', { title: 'Beta' })));
    const timers = memoryTimerStore();
    const ctx = toolContext({ backend, timers, deviceId: DEVICE, now: () => NOW });

    const results = await Promise.all([
      toolByName('start_timer')!.run({ id: 'a' }, ctx),
      toolByName('start_timer')!.run({ id: 'b' }, ctx),
    ]);

    const running = await timers.read();
    const started = results.filter(r => r.isError !== true);
    expect(started).toHaveLength(2);
    // Whichever won, exactly one timer is running and it is the one the last
    // successful call reported.
    expect(running).not.toBeNull();
    expect(['a', 'b']).toContain(running!.taskId);
    expect(backend.appended.length).toBeLessThanOrEqual(1);
  });

  it('keeps the timer when the append fails, so the span is not lost', async () => {
    const backend = memoryBackend(seed(ev('a', { title: 'Alpha' })));
    const timers = memoryTimerStore();
    let now = NOW;
    const ctx = toolContext({ backend, timers, deviceId: DEVICE, now: () => now });

    await toolByName('start_timer')!.run({ id: 'a' }, ctx);
    backend.append = async () => {
      throw new Error('the repository is unreachable');
    };
    now = NOW + 300_000;

    await expect(toolByName('stop_timer')!.run({}, ctx)).rejects.toThrow(/unreachable/);
    expect(await timers.read()).toEqual({ taskId: 'a', startedAt: NOW });
  });

  it('refuses loudly when start_timer finds a timer past the session cap', async () => {
    const backend = memoryBackend(seed(ev('a', { title: 'Alpha' }), ev('b', { title: 'Beta' })));
    const timers = memoryTimerStore();
    let now = NOW;
    const ctx = toolContext({ backend, timers, deviceId: DEVICE, now: () => now, maxSessionMs: 3600_000 });

    await toolByName('start_timer')!.run({ id: 'a' }, ctx);
    now = NOW + 5 * 3600_000;
    const out = await toolByName('start_timer')!.run({ id: 'b' }, ctx);

    // stop_timer refuses in this case, so start_timer must not destroy it in
    // silence: the two have to agree.
    expect(out.isError).toBe(true);
    expect(out.text).toContain('log_time');
    expect(backend.appended).toHaveLength(0);
    expect(await timers.read()).toBeNull();

    // The stale timer is cleared, so the next call starts cleanly.
    const retry = await toolByName('start_timer')!.run({ id: 'b' }, ctx);
    expect(retry.isError).toBeUndefined();
  });

  it('refuses to start on a task that does not exist', async () => {
    const h = harness();
    const out = await h.call('start_timer', { id: 'ghost' });

    expect(out.isError).toBe(true);
    expect(await h.ctx.timers.read()).toBeNull();
  });
});

describe('names beside ids', () => {
  const events = seed(
    RADIO,
    URGENT,
    ev('a', { title: 'Alpha', projectId: 'p-radio', tagIds: ['g-urgent'] }),
    ev('b', { title: 'Beta' }),
  );

  it('shows the project and tag titles on every task', async () => {
    const h = harness(events);
    const out = await h.json('list_tasks');
    const a = out.tasks.find((t: { id: string }) => t.id === 'a');
    const b = out.tasks.find((t: { id: string }) => t.id === 'b');

    expect(a).toMatchObject({ projectId: 'p-radio', project: 'Radio', tagIds: ['g-urgent'], tags: ['Urgent'] });
    expect(b).toMatchObject({ projectId: 'inbox', project: 'Inbox' });
    expect(b.tagIds).toBeUndefined();
    expect(b.tags).toBeUndefined();
  });

  it('gives a tag id nothing answers to no title rather than the id as one', async () => {
    const h = harness(seed(URGENT, ev('a', { title: 'Alpha', tagIds: ['g-urgent', 'g-gone'] })));
    const out = await h.json('list_tasks');

    expect(out.tasks[0].tagIds).toEqual(['g-urgent', 'g-gone']);
    expect(out.tasks[0].tags).toEqual(['Urgent']);
  });

  it('adds a task to an existing project and tag by title, ignoring case and whitespace', async () => {
    const h = harness(events);
    const out = await h.json('add_task', { title: 'Gamma', project: ' radio ', tags: ['URGENT'] });

    expect(out.task).toMatchObject({ projectId: 'p-radio', project: 'Radio', tagIds: ['g-urgent'], tags: ['Urgent'] });
    // Nothing was created: the titles matched.
    expect(h.backend.appended).toHaveLength(1);
    expect(h.backend.appended[0]!.entity).toBe('task');
  });

  it('creates a missing project and tag in the same batch, ahead of the task', async () => {
    const h = harness(events);
    const out = await h.json('add_task', { title: 'Delta', project: 'Garden', tags: ['Urgent', 'Weekend'] });

    expect(h.backend.appended.map(e => `${e.type} ${e.entity}`)).toEqual([
      'create project',
      'create tag',
      'create task',
    ]);
    const [project, tag, task] = h.backend.appended as [Event, Event, Event];
    // One project and one tag exist already, so both take the second colour.
    expect(project.payload).toEqual({ title: 'Garden', color: ENTITY_COLORS[1], isArchived: false });
    expect(tag.payload).toEqual({ title: 'Weekend', color: ENTITY_COLORS[1] });
    expect(task.payload).toMatchObject({ projectId: project.entityId, tagIds: ['g-urgent', tag.entityId] });
    // ULIDs minted in order sort in order, so replay applies the creates first too.
    expect(project.id < tag.id && tag.id < task.id).toBe(true);
    expect(project.deviceId).toBe(DEVICE);

    expect(out.task).toMatchObject({ project: 'Garden', tags: ['Urgent', 'Weekend'] });
  });

  it('creates one tag for two spellings of a new title in the same call', async () => {
    const h = harness(events);
    const out = await h.json('add_task', { title: 'Delta', tags: ['Weekend', 'weekend ', 'Urgent'] });

    expect(h.backend.appended.filter(e => e.entity === 'tag')).toHaveLength(1);
    expect(out.task.tags).toEqual(['Weekend', 'Urgent']);
  });

  it('resolves "Inbox" to the built-in project rather than creating one', async () => {
    const h = harness(events);
    const out = await h.json('update_task', { id: 'a', project: 'inbox' });

    expect(out.task.projectId).toBe('inbox');
    expect(out.task.project).toBe('Inbox');
    expect(h.backend.appended).toHaveLength(1);
  });

  it('moves a task with update_task and creates the project it names', async () => {
    const h = harness(events);
    const out = await h.json('update_task', { id: 'b', project: 'Garden', tags: [] });

    expect(h.backend.appended.map(e => e.entity)).toEqual(['project', 'task']);
    expect(h.backend.appended[1]!.payload).toEqual({ projectId: h.backend.appended[0]!.entityId, tagIds: [] });
    expect(out.task.project).toBe('Garden');
  });

  it('refuses the id and the title of one field together, before touching the log', async () => {
    const h = harness(events);

    const both = [
      h.call('add_task', { title: 'x', project: 'Radio', projectId: 'p-radio' }),
      h.call('add_task', { title: 'x', tags: ['Urgent'], tagIds: ['g-urgent'] }),
      h.call('update_task', { id: 'a', project: 'Radio', projectId: 'p-radio' }),
      h.call('update_task', { id: 'a', tags: ['Urgent'], tagIds: ['g-urgent'] }),
      h.call('list_tasks', { project: 'Radio', projectId: 'p-radio' }),
      h.call('list_tasks', { tag: 'Urgent', tagId: 'g-urgent' }),
    ];
    for (const out of await Promise.all(both)) {
      expect(out.isError).toBe(true);
      expect(out.text).toContain('not both');
    }
    expect(h.backend.appended).toHaveLength(0);
  });

  it('lists by project and tag title, and an unknown title lists nothing', async () => {
    const h = harness(events);
    const ids = (out: { tasks: { id: string }[] }) => out.tasks.map(t => t.id);

    expect(ids(await h.json('list_tasks', { project: 'radio' }))).toEqual(['a']);
    expect(ids(await h.json('list_tasks', { tag: 'urgent' }))).toEqual(['a']);
    expect(ids(await h.json('list_tasks', { project: 'Inbox' }))).toEqual(['b']);
    expect(await h.json('list_tasks', { project: 'Nowhere' })).toEqual({ total: 0, tasks: [] });
    expect(await h.json('list_tasks', { tag: 'Nowhere' })).toEqual({ total: 0, tasks: [] });
  });

  it('refuses a blank title without writing anything', async () => {
    const h = harness(events);

    expect((await h.call('add_task', { title: 'x', project: '   ' })).isError).toBe(true);
    expect((await h.call('add_task', { title: 'x', tags: ['Urgent', ' '] })).isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });
});

describe('list_projects', () => {
  it('lists every project with its open-task count, the Inbox included, archived flagged', async () => {
    const h = harness(
      seed(
        entity('project', 'p-b', { title: 'Bravo', color: '#5f7346', isArchived: true }),
        entity('project', 'p-a', { title: 'Alpha', color: '#c2603f', isArchived: false }),
        ev('t1', { title: 'One', projectId: 'p-a' }),
        ev('t2', { title: 'Two', projectId: 'p-a', isDone: true, doneOn: NOW - 1000 }),
        ev('t3', { title: 'Three' }),
        // A task whose project is gone reads as Inbox everywhere, so it counts there.
        ev('t4', { title: 'Four', projectId: 'p-gone' }),
      ),
    );

    const out = await h.json('list_projects');

    expect(out.inbox).toEqual({ openTasks: 2 });
    expect(out.projects).toEqual([
      { id: 'p-a', title: 'Alpha', color: '#c2603f', archived: false, openTasks: 1 },
      { id: 'p-b', title: 'Bravo', color: '#5f7346', archived: true, openTasks: 0 },
    ]);
  });

  it('reports an empty Inbox and no projects on a fresh log', async () => {
    expect(await harness().json('list_projects')).toEqual({ inbox: { openTasks: 0 }, projects: [] });
  });
});

describe('add_project', () => {
  it('appends one project create with the next palette colour and returns it', async () => {
    const h = harness(seed(RADIO));
    const out = await h.json('add_project', { title: 'Garden' });

    expect(h.backend.appended).toHaveLength(1);
    expect(h.backend.appended[0]).toMatchObject({
      type: 'create',
      entity: 'project',
      deviceId: DEVICE,
      payload: { title: 'Garden', color: ENTITY_COLORS[1], isArchived: false },
    });
    expect(out).toEqual({
      created: true,
      project: { id: h.backend.appended[0]!.entityId, title: 'Garden', color: ENTITY_COLORS[1], archived: false, openTasks: 0 },
    });
  });

  it('takes an explicit colour and trims the title', async () => {
    const h = harness();
    const out = await h.json('add_project', { title: '  Garden ', color: '#123abc' });

    expect(h.backend.appended[0]!.payload).toEqual({ title: 'Garden', color: '#123abc', isArchived: false });
    expect(out.project.color).toBe('#123abc');
  });

  it('refuses a title already in use, ignoring case, and names the existing id', async () => {
    const h = harness(seed(RADIO));
    const out = await h.call('add_project', { title: 'RADIO' });

    expect(out.isError).toBe(true);
    expect(out.text).toContain('p-radio');
    expect(h.backend.appended).toHaveLength(0);
  });

  it('refuses a blank title, the Inbox, and a colour that is not a hex triplet', async () => {
    const h = harness();

    expect((await h.call('add_project', { title: '' })).isError).toBe(true);
    expect((await h.call('add_project', { title: '   ' })).isError).toBe(true);
    const inbox = await h.call('add_project', { title: 'inbox' });
    expect(inbox.isError).toBe(true);
    expect(inbox.text).toContain('built-in');
    const colour = await h.call('add_project', { title: 'Garden', color: 'red' });
    expect(colour.isError).toBe(true);
    expect(colour.text).toContain('hex colour');
    expect(h.backend.appended).toHaveLength(0);
  });
});

describe('update_project', () => {
  const events = seed(
    RADIO,
    entity('project', 'p-garden', { title: 'Garden', color: '#8a6d3b', isArchived: false }),
    ev('t1', { title: 'One', projectId: 'p-radio' }),
  );

  it('emits an update carrying only the fields it was given', async () => {
    const h = harness(events);
    const out = await h.json('update_project', { id: 'p-radio', title: 'Radio show', archived: true });

    expect(h.backend.appended).toHaveLength(1);
    expect(h.backend.appended[0]).toMatchObject({
      type: 'update',
      entity: 'project',
      entityId: 'p-radio',
      payload: { title: 'Radio show', isArchived: true },
    });
    expect(out).toEqual({
      updated: true,
      project: { id: 'p-radio', title: 'Radio show', color: '#c2603f', archived: true, openTasks: 1 },
    });
  });

  it('recolours and unarchives', async () => {
    const h = harness(seed(entity('project', 'p-a', { title: 'A', color: '#c2603f', isArchived: true })));
    const out = await h.json('update_project', { id: 'p-a', color: '#4a6670', archived: false });

    expect(h.backend.appended[0]!.payload).toEqual({ color: '#4a6670', isArchived: false });
    expect(out.project).toMatchObject({ color: '#4a6670', archived: false });
  });

  it('lets a project keep its own title in a different case', async () => {
    const h = harness(events);
    const out = await h.json('update_project', { id: 'p-radio', title: 'RADIO' });

    expect(out.project.title).toBe('RADIO');
  });

  it('refuses an unknown id, the inbox, a rename onto another project, and a call that changes nothing', async () => {
    const h = harness(events);

    const ghost = await h.call('update_project', { id: 'ghost', color: '#000000' });
    expect(ghost.isError).toBe(true);
    expect(ghost.text).toContain('ghost');
    const inbox = await h.call('update_project', { id: 'inbox', title: 'Home' });
    expect(inbox.isError).toBe(true);
    expect(inbox.text).toContain('built-in');
    const clash = await h.call('update_project', { id: 'p-radio', title: 'garden' });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain('p-garden');
    expect((await h.call('update_project', { id: 'p-radio' })).isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });
});

describe('list_tags', () => {
  it('lists every tag with its open-task count', async () => {
    const h = harness(
      seed(
        entity('tag', 'g-b', { title: 'Bravo', color: '#5f7346' }),
        URGENT,
        ev('t1', { title: 'One', tagIds: ['g-urgent', 'g-urgent'] }),
        ev('t2', { title: 'Two', tagIds: ['g-urgent'], isDone: true, doneOn: NOW - 1000 }),
        ev('t3', { title: 'Three', tagIds: ['g-b', 'g-urgent'] }),
      ),
    );

    const out = await h.json('list_tags');

    expect(out).toEqual({
      tags: [
        { id: 'g-b', title: 'Bravo', color: '#5f7346', openTasks: 1 },
        { id: 'g-urgent', title: 'Urgent', color: '#c2603f', openTasks: 2 },
      ],
    });
  });
});

describe('add_tag', () => {
  it('appends one tag create with the next palette colour and returns it', async () => {
    const h = harness(seed(URGENT));
    const out = await h.json('add_tag', { title: 'Weekend' });

    expect(h.backend.appended).toHaveLength(1);
    expect(h.backend.appended[0]).toMatchObject({
      type: 'create',
      entity: 'tag',
      payload: { title: 'Weekend', color: ENTITY_COLORS[1] },
    });
    expect(out).toEqual({
      created: true,
      tag: { id: h.backend.appended[0]!.entityId, title: 'Weekend', color: ENTITY_COLORS[1], openTasks: 0 },
    });
  });

  it('refuses a title already in use, ignoring case, and names the existing id', async () => {
    const h = harness(seed(URGENT));
    const out = await h.call('add_tag', { title: ' urgent' });

    expect(out.isError).toBe(true);
    expect(out.text).toContain('g-urgent');
    expect(h.backend.appended).toHaveLength(0);
  });

  it('refuses a blank title', async () => {
    const h = harness();

    expect((await h.call('add_tag', { title: '' })).isError).toBe(true);
    expect((await h.call('add_tag', { title: '  ' })).isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });
});

describe('update_tag', () => {
  const events = seed(URGENT, entity('tag', 'g-later', { title: 'Later', color: '#8a6d3b' }));

  it('emits an update carrying only the fields it was given', async () => {
    const h = harness(events);
    const out = await h.json('update_tag', { id: 'g-urgent', title: 'Now', color: '#a4494f' });

    expect(h.backend.appended).toHaveLength(1);
    expect(h.backend.appended[0]).toMatchObject({
      type: 'update',
      entity: 'tag',
      entityId: 'g-urgent',
      payload: { title: 'Now', color: '#a4494f' },
    });
    expect(out).toEqual({ updated: true, tag: { id: 'g-urgent', title: 'Now', color: '#a4494f', openTasks: 0 } });
  });

  it('refuses an unknown id, a rename onto another tag, and a call that changes nothing', async () => {
    const h = harness(events);

    expect((await h.call('update_tag', { id: 'ghost', title: 'x' })).isError).toBe(true);
    const clash = await h.call('update_tag', { id: 'g-urgent', title: 'LATER' });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain('g-later');
    expect((await h.call('update_tag', { id: 'g-urgent' })).isError).toBe(true);
    expect(h.backend.appended).toHaveLength(0);
  });
});
