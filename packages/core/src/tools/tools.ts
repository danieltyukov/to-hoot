// The nine tools Claude gets, defined once and served by both the stdio server
// and the Cloudflare Worker.
//
// Three rules hold across all of them:
//
//   1. A tool never mutates state. It reads the replayed state, decides on
//      events, and appends them; the next read is a replay like any other. That
//      is what keeps a change made through Claude indistinguishable from one
//      made in the app.
//   2. A refusal is a result with `isError`, never a thrown exception. The model
//      is the one reading it, and a sentence it can act on ("that task is
//      already a subtask") is worth more than a stack trace.
//   3. Time is milliseconds in the log and minutes at this boundary. The model
//      thinks in minutes and the storage of record does not, so the conversion
//      happens here rather than in nine different prompts.

import { z } from 'zod/v4';

import { newEvent, type Event } from '../events.js';
import { dayStr, type Task } from '../models.js';
import { replay } from '../replay.js';
import { taskTotalTime, todayTasks, trackedToday, plannedToday } from '../selectors.js';
import type { State } from '../state.js';
import type { ToolContext, ToolDefinition, ToolResult, ToolSchema } from './runtime.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A single day cannot hold more, so a bigger number is a units mistake. */
const MAX_LOG_MINUTES = 24 * 60;

const dayField = z
  .string()
  .regex(DAY_PATTERN, 'expected a day as "YYYY-MM-DD"')
  .describe('A logical day, "YYYY-MM-DD".');

const isoField = z
  .string()
  .refine(v => Number.isFinite(Date.parse(v)), 'expected an ISO 8601 date-time')
  .describe('An ISO 8601 date-time, for example "2026-08-23T09:00:00Z".');

const idField = z.string().min(1).describe('The task id.');

function fail(text: string): ToolResult {
  return { text, isError: true };
}

function ok(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2) };
}

/** Milliseconds as minutes, to one decimal, so 30 seconds is 0.5 and not 1. */
function minutes(ms: number): number {
  return Math.round(ms / 6000) / 10;
}

function msFromMinutes(value: number): number {
  return Math.round(value * 60_000);
}

/**
 * The shape a task takes on the wire. Trimmed deliberately: every absent field
 * is one less thing for the model to reason about, and the omissions are all
 * "this task has no notes", never "this field was hidden".
 */
function view(state: State, task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    done: task.isDone,
    projectId: task.projectId,
    estimateMinutes: minutes(task.timeEstimate),
    spentMinutes: minutes(task.timeSpent),
  };
  if (task.notes !== undefined && task.notes !== '') out['notes'] = task.notes;
  if (task.tagIds.length > 0) out['tagIds'] = task.tagIds;
  if (task.parentId !== undefined) out['parentId'] = task.parentId;
  if (task.subTaskIds.length > 0) {
    out['subTaskIds'] = task.subTaskIds;
    // Only worth reporting where it can differ from the task's own time.
    out['spentWithSubtasksMinutes'] = minutes(taskTotalTime(state, task.id));
  }
  if (task.dueDay !== undefined) out['dueDay'] = task.dueDay;
  if (task.dueWithTime !== undefined) out['dueAt'] = new Date(task.dueWithTime).toISOString();
  if (task.isDone && task.doneOn !== undefined) out['doneAt'] = new Date(task.doneOn).toISOString();
  return out;
}

function today(state: State, now: number): string {
  return dayStr(now, state.settings.dayStartOffsetMs);
}

/** Creation order. Task ids are ULIDs, so sorting them sorts by creation time. */
function byId(a: Task, b: Task): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function taskEvent(
  ctx: ToolContext,
  type: Event['type'],
  entityId: string,
  payload: unknown,
): Event {
  return newEvent({
    id: ctx.newId(),
    deviceId: ctx.deviceId,
    ts: ctx.now(),
    type,
    entity: 'task',
    entityId,
    payload,
  });
}

/**
 * Applies events the caller is about to append, so a tool can report the task
 * as it will be rather than as it was. Replaying the one event onto the state
 * already in hand is the same fold the next read performs, so the answer cannot
 * drift from what the log says; asking the backend to read its own write back
 * would cost a round trip and, on the Worker, would not see it yet.
 */
function project(state: State, events: Event[]): State {
  return replay(events, state);
}

/**
 * Whether `parentId` may parent `taskId`, with the reason when it may not.
 *
 * Nesting is capped at two levels and the cap is enforced during replay, which
 * skips the offending field silently. Silence is right for a remote event from
 * a device running another build and wrong for a tool call: the model would be
 * told the subtask was created and then find it at the top level.
 */
function parentProblem(state: State, taskId: string | undefined, parentId: string): string | null {
  const parent = state.tasks[parentId];
  if (parent === undefined) return `there is no task ${JSON.stringify(parentId)} to parent this one`;
  if (taskId !== undefined && parentId === taskId) return 'a task cannot be its own parent';
  if (parent.parentId !== undefined) {
    return `subtasks are capped at two levels: ${JSON.stringify(parentId)} is already a subtask of ${JSON.stringify(parent.parentId)}`;
  }
  if (taskId !== undefined && state.tasks[taskId]?.subTaskIds.length) {
    return `subtasks are capped at two levels: ${JSON.stringify(taskId)} already has subtasks of its own`;
  }
  return null;
}

interface ToolSpec<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  schema: S;
  annotations: ToolDefinition['annotations'];
  run(args: z.output<S>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Wraps a spec into a definition, validating the arguments on the way in.
 *
 * Both servers validate too, so on the MCP path this pass is redundant. It is
 * kept because it is the only pass on every other path, and because a validator
 * that runs in one caller and not another is a bug waiting for the second
 * caller.
 */
function define<S extends z.ZodType>(spec: ToolSpec<S>): ToolDefinition {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.schema as unknown as ToolSchema,
    annotations: spec.annotations,
    async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = spec.schema.safeParse(args ?? {});
      if (!parsed.success) return fail(z.prettifyError(parsed.error));
      return spec.run(parsed.data, ctx);
    },
  };
}

const listTasks = define({
  name: 'list_tasks',
  title: 'List tasks',
  description:
    'Lists tasks, newest last. Filters are combined: a task must match every filter given. ' +
    'Completed tasks are left out unless includeDone is true.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  schema: z.object({
    projectId: z.string().min(1).optional().describe('Only tasks in this project.'),
    tagId: z.string().min(1).optional().describe('Only tasks carrying this tag.'),
    parentId: z.string().min(1).optional().describe('Only the subtasks of this task.'),
    includeDone: z.boolean().optional().describe('Include completed tasks. Defaults to false.'),
    limit: z.number().int().min(1).max(200).optional().describe('At most this many. Defaults to 50.'),
  }),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    const matches = Object.values(state.tasks)
      .filter(t => args.includeDone === true || !t.isDone)
      .filter(t => args.projectId === undefined || t.projectId === args.projectId)
      .filter(t => args.tagId === undefined || t.tagIds.includes(args.tagId))
      .filter(t => args.parentId === undefined || t.parentId === args.parentId)
      .sort(byId);
    const limit = args.limit ?? 50;
    return ok({
      total: matches.length,
      tasks: matches.slice(0, limit).map(t => view(state, t)),
    });
  },
});

const searchTasks = define({
  name: 'search_tasks',
  title: 'Search tasks',
  description:
    'Finds tasks whose title or notes contain the query, ignoring case. ' +
    'Completed tasks are left out unless includeDone is true.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  schema: z.object({
    query: z.string().min(1).describe('Text to look for in the title and notes.'),
    includeDone: z.boolean().optional().describe('Include completed tasks. Defaults to false.'),
    limit: z.number().int().min(1).max(200).optional().describe('At most this many. Defaults to 20.'),
  }),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    const needle = args.query.toLowerCase();
    const matches = Object.values(state.tasks)
      .filter(t => args.includeDone === true || !t.isDone)
      .filter(t => `${t.title}\n${t.notes ?? ''}`.toLowerCase().includes(needle))
      .sort(byId);
    const limit = args.limit ?? 20;
    return ok({
      total: matches.length,
      tasks: matches.slice(0, limit).map(t => view(state, t)),
    });
  },
});

const todayTool = define({
  name: 'today',
  title: "Today's list",
  description:
    "Today's list: everything due today or overdue, plus the time tracked today across every " +
    'task and the estimates on the list. Time spent today on a task due next week still counts ' +
    'as tracked today.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  schema: z.object({}),
  async run(_args, ctx) {
    const state = await ctx.backend.loadState();
    const now = ctx.now();
    return ok({
      day: today(state, now),
      trackedMinutes: minutes(trackedToday(state, now)),
      plannedMinutes: minutes(plannedToday(state, now)),
      tasks: todayTasks(state, now).map(t => view(state, t)),
    });
  },
});

const addTask = define({
  name: 'add_task',
  title: 'Add a task',
  description:
    'Creates a task. Give dueDay to put it on a day\'s list, or dueAt to schedule it at a time; ' +
    'the two are mutually exclusive. A task can be a subtask of a top-level task, and nesting ' +
    'stops there.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      title: z.string().min(1).describe('What the task is.'),
      notes: z.string().optional().describe('Free text.'),
      projectId: z.string().min(1).optional().describe('Defaults to "inbox".'),
      tagIds: z.array(z.string().min(1)).optional().describe('Tag ids to attach.'),
      parentId: z.string().min(1).optional().describe('Makes this a subtask of that task.'),
      estimateMinutes: z.number().min(0).optional().describe('How long it is expected to take.'),
      dueDay: dayField.optional(),
      dueAt: isoField.optional(),
    })
    .strict(),
  async run(args, ctx) {
    if (args.dueDay !== undefined && args.dueAt !== undefined) {
      return fail('dueDay and dueAt are mutually exclusive: pass a day or a time, not both');
    }
    const state = await ctx.backend.loadState();
    if (args.parentId !== undefined) {
      const problem = parentProblem(state, undefined, args.parentId);
      if (problem !== null) return fail(problem);
    }

    const payload: Record<string, unknown> = {
      title: args.title,
      projectId: args.projectId ?? 'inbox',
      tagIds: args.tagIds ?? [],
      isDone: false,
      timeEstimate: args.estimateMinutes === undefined ? 0 : msFromMinutes(args.estimateMinutes),
    };
    if (args.notes !== undefined) payload['notes'] = args.notes;
    if (args.parentId !== undefined) payload['parentId'] = args.parentId;
    if (args.dueDay !== undefined) payload['dueDay'] = args.dueDay;
    if (args.dueAt !== undefined) payload['dueWithTime'] = Date.parse(args.dueAt);

    const id = ctx.newId();
    const event = taskEvent(ctx, 'create', id, payload);
    await ctx.backend.append([event]);

    const next = project(state, [event]);
    const created = next.tasks[id];
    if (created === undefined) return fail(`the task was written but did not replay back: ${id}`);
    return ok({ created: true, task: view(next, created) });
  },
});

const updateTask = define({
  name: 'update_task',
  title: 'Update a task',
  description:
    'Changes the fields you name and leaves the rest alone. Pass clearDue to take a task off ' +
    'its day, or clearParent to promote a subtask to the top level. Use complete_task to ' +
    'finish a task and log_time to record time.',
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      id: idField,
      title: z.string().min(1).optional(),
      notes: z.string().optional(),
      projectId: z.string().min(1).optional(),
      tagIds: z.array(z.string().min(1)).optional().describe('Replaces the whole tag list.'),
      parentId: z.string().min(1).optional().describe('Moves this task under that one.'),
      clearParent: z.boolean().optional().describe('Promotes a subtask to the top level.'),
      estimateMinutes: z.number().min(0).optional(),
      dueDay: dayField.optional(),
      dueAt: isoField.optional(),
      clearDue: z.boolean().optional().describe('Removes both dueDay and dueAt.'),
    })
    .strict(),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    const task = state.tasks[args.id];
    if (task === undefined) return fail(`there is no task ${JSON.stringify(args.id)}`);

    if (args.clearDue === true && (args.dueDay !== undefined || args.dueAt !== undefined)) {
      return fail('clearDue cannot be combined with dueDay or dueAt');
    }
    if (args.dueDay !== undefined && args.dueAt !== undefined) {
      return fail('dueDay and dueAt are mutually exclusive: pass a day or a time, not both');
    }
    if (args.clearParent === true && args.parentId !== undefined) {
      return fail('clearParent cannot be combined with parentId');
    }
    if (args.parentId !== undefined) {
      const problem = parentProblem(state, args.id, args.parentId);
      if (problem !== null) return fail(problem);
    }

    const payload: Record<string, unknown> = {};
    if (args.title !== undefined) payload['title'] = args.title;
    if (args.notes !== undefined) payload['notes'] = args.notes;
    if (args.projectId !== undefined) payload['projectId'] = args.projectId;
    if (args.tagIds !== undefined) payload['tagIds'] = args.tagIds;
    if (args.parentId !== undefined) payload['parentId'] = args.parentId;
    if (args.clearParent === true) payload['parentId'] = null;
    if (args.estimateMinutes !== undefined) payload['timeEstimate'] = msFromMinutes(args.estimateMinutes);
    if (args.dueDay !== undefined) payload['dueDay'] = args.dueDay;
    if (args.dueAt !== undefined) payload['dueWithTime'] = Date.parse(args.dueAt);
    if (args.clearDue === true) {
      payload['dueDay'] = null;
      payload['dueWithTime'] = null;
    }
    if (Object.keys(payload).length === 0) {
      return fail('nothing to update: name at least one field to change');
    }

    const event = taskEvent(ctx, 'update', args.id, payload);
    await ctx.backend.append([event]);

    const next = project(state, [event]);
    const updated = next.tasks[args.id];
    if (updated === undefined) return fail(`the update was written but did not replay back: ${args.id}`);
    return ok({ updated: true, task: view(next, updated) });
  },
});

const completeTask = define({
  name: 'complete_task',
  title: 'Complete a task',
  description:
    'Marks a task done, or reopens it with done set to false. Completing an already completed ' +
    'task changes nothing and is not an error.',
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      id: idField,
      done: z.boolean().optional().describe('False reopens the task. Defaults to true.'),
    })
    .strict(),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    const task = state.tasks[args.id];
    if (task === undefined) return fail(`there is no task ${JSON.stringify(args.id)}`);

    const done = args.done ?? true;
    if (task.isDone === done) {
      return ok({ changed: false, task: view(state, task) });
    }

    const payload = done ? { isDone: true, doneOn: ctx.now() } : { isDone: false, doneOn: null };
    const event = taskEvent(ctx, 'update', args.id, payload);
    await ctx.backend.append([event]);

    const next = project(state, [event]);
    const updated = next.tasks[args.id] ?? task;
    return ok({ changed: true, task: view(next, updated) });
  },
});

const startTimer = define({
  name: 'start_timer',
  title: 'Start the timer',
  description:
    'Starts tracking time against a task. Starting a second timer banks the first one. ' +
    'The timer belongs to this server, not to the app running on your devices.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  schema: z.object({ id: idField }).strict(),
  async run(args, ctx) {
    // The whole read-decide-append-write runs as one section; see withTimerLock.
    return ctx.withTimerLock(async () => {
      const state = await ctx.backend.loadState();
      if (state.tasks[args.id] === undefined) return fail(`there is no task ${JSON.stringify(args.id)}`);

      const now = ctx.now();
      const running = await ctx.timers.read();
      let banked: { taskId: string; minutes: number } | undefined;
      if (running !== null) {
        const flushed = await bank(ctx, state, running, now);
        if (flushed.tooLong) {
          // The same answer `stop_timer` gives, because it is the same
          // situation. Destroying a forgotten timer quietly while the other
          // path refuses out loud would make the pair impossible to reason
          // about, and the caller would never learn the span existed.
          await ctx.timers.write(null);
          return fail(forgottenTimer(running.taskId, flushed.ms, 'Start it again once you have.'));
        }
        if (flushed.event !== undefined) {
          // Before the new timer replaces it: a throw here leaves the old timer
          // running, which is recoverable, rather than dropping its span.
          await ctx.backend.append([flushed.event]);
          banked = { taskId: running.taskId, minutes: minutes(flushed.ms) };
        }
      }

      await ctx.timers.write({ taskId: args.id, startedAt: now });
      return ok({ started: args.id, startedAt: new Date(now).toISOString(), banked });
    });
  },
});

const stopTimer = define({
  name: 'stop_timer',
  title: 'Stop the timer',
  description:
    'Stops the running timer and records the elapsed time against its task, credited to the ' +
    'day the timer started on.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  schema: z.object({}),
  async run(_args, ctx) {
    return ctx.withTimerLock(async () => {
      const running = await ctx.timers.read();
      if (running === null) {
        return fail('no timer is running on this server; use log_time to record time directly');
      }
      const state = await ctx.backend.loadState();
      const flushed = await bank(ctx, state, running, ctx.now());

      if (flushed.tooLong) {
        // Banking it would write hours nobody worked, and silently trimming it
        // would write a number this server invented. Neither is the user's call
        // to make for them, so the span is reported and dropped.
        await ctx.timers.write(null);
        return fail(forgottenTimer(running.taskId, flushed.ms));
      }
      if (flushed.event === undefined) {
        await ctx.timers.write(null);
        return ok({ stopped: running.taskId, recordedMinutes: 0 });
      }

      // Append FIRST, clear second. The other order loses the span outright
      // when the append fails: the timer is already gone, and the minutes are
      // stated nowhere for anyone to recover them from. This way a failure
      // leaves the timer running and the caller can simply stop it again.
      await ctx.backend.append([flushed.event]);
      await ctx.timers.write(null);
      return ok({
        stopped: running.taskId,
        recordedMinutes: minutes(flushed.ms),
        day: (flushed.event.payload as { day: string }).day,
      });
    });
  },
});

const logTime = define({
  name: 'log_time',
  title: 'Log time',
  description:
    'Records time against a task as an increment, so two devices logging at once add up rather ' +
    'than overwrite each other. Negative minutes correct an over-log; a day never goes below zero.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      id: idField,
      minutes: z
        .number()
        .refine(v => v !== 0, 'minutes must not be zero')
        .refine(v => Math.abs(v) <= MAX_LOG_MINUTES, `minutes must be within one day (${MAX_LOG_MINUTES})`)
        .describe('Minutes to add. Negative subtracts.'),
      day: dayField.optional().describe('Defaults to today.'),
    })
    .strict(),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    if (state.tasks[args.id] === undefined) return fail(`there is no task ${JSON.stringify(args.id)}`);

    const day = args.day ?? today(state, ctx.now());
    const event = taskEvent(ctx, 'timeDelta', args.id, { day, ms: msFromMinutes(args.minutes) });
    await ctx.backend.append([event]);

    const next = project(state, [event]);
    const task = next.tasks[args.id];
    return ok({
      logged: true,
      day,
      minutes: args.minutes,
      task: task === undefined ? undefined : view(next, task),
    });
  },
});

/** One wording for a forgotten timer, so both timer tools say the same thing. */
function forgottenTimer(taskId: string, ms: number, andThen = ''): string {
  return (
    `the timer on ${JSON.stringify(taskId)} ran for ${minutes(ms)} minutes, which is longer than ` +
    'one work session; it has been cleared without recording anything. Use log_time to record ' +
    `what was actually worked.${andThen === '' ? '' : ` ${andThen}`}`
  );
}

interface Banked {
  ms: number;
  event?: Event;
  tooLong?: boolean;
}

/**
 * Turns a running timer into the event that records it.
 *
 * A backwards clock yields nothing rather than negative time, and a span past
 * the session cap yields nothing and says so: a timer left running overnight is
 * a forgotten timer, and writing it as work would put hours into the log that
 * only a manual correction could take back out.
 */
async function bank(
  ctx: ToolContext,
  state: State,
  running: RunningTimerLike,
  now: number,
): Promise<Banked> {
  const elapsed = now - running.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 1000) return { ms: Math.max(0, elapsed) };
  if (elapsed > ctx.maxSessionMs) return { ms: elapsed, tooLong: true };
  const day = dayStr(running.startedAt, state.settings.dayStartOffsetMs);
  return { ms: elapsed, event: taskEvent(ctx, 'timeDelta', running.taskId, { day, ms: elapsed }) };
}

interface RunningTimerLike {
  taskId: string;
  startedAt: number;
}

/** Registration order, which is the order `tools/list` advertises them in. */
export const TOOLS: readonly ToolDefinition[] = [
  listTasks,
  searchTasks,
  todayTool,
  addTask,
  updateTask,
  completeTask,
  startTimer,
  stopTimer,
  logTime,
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find(t => t.name === name);
}
