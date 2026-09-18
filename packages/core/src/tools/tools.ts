// The fifteen tools Claude gets, defined once and served by both the stdio
// server and the Cloudflare Worker.
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
//      happens here rather than in fifteen different prompts.
//
// A fourth holds for everything that names a project or a tag: a title is
// accepted wherever an id is. The model thinks in words, and "the Radio project"
// is what it has when the user speaks; a title nothing matches is created in
// the same batch as the task that named it, so the request works before the
// project exists. The id form and the title form of one field are never
// accepted together, because there is no honest answer when they disagree.

import { z } from 'zod/v4';

import { newEvent, type EntityKind, type Event } from '../events.js';
import { DEFAULT_PROJECT_ID, dayStr, nextEntityColor, type Project, type Tag, type Task } from '../models.js';
import { replay } from '../replay.js';
import { taskTotalTime, todayTasks, trackedToday, plannedToday } from '../selectors.js';
import type { State } from '../state.js';
import type { ToolContext, ToolDefinition, ToolResult, ToolSchema } from './runtime.js';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A single day cannot hold more, so a bigger number is a units mistake. */
const MAX_LOG_MINUTES = 24 * 60;
/** What the built-in project is called on the wire. It has no entity of its own. */
const INBOX_TITLE = 'Inbox';

const dayField = z
  .string()
  .regex(DAY_PATTERN, 'expected a day as "YYYY-MM-DD"')
  .describe('A logical day, "YYYY-MM-DD".');

const isoField = z
  .string()
  .refine(v => Number.isFinite(Date.parse(v)), 'expected an ISO 8601 date-time')
  .describe('An ISO 8601 date-time, for example "2026-08-23T09:00:00Z".');

const idField = z.string().min(1).describe('The task id.');

const colorField = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'expected a hex colour like "#c2603f"')
  .describe('A hex colour, "#rrggbb". Defaults to the next in the palette the app uses.');

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

/** The title a task's project shows under. Unknown reads as Inbox, where the app shows it. */
function projectTitle(state: State, projectId: string): string {
  if (projectId === DEFAULT_PROJECT_ID) return INBOX_TITLE;
  return state.projects[projectId]?.title ?? INBOX_TITLE;
}

/**
 * The shape a task takes on the wire. Trimmed deliberately: every absent field
 * is one less thing for the model to reason about, and the omissions are all
 * "this task has no notes", never "this field was hidden".
 *
 * Names ride beside the ids so a listing reads without a second lookup. A tag
 * id that no tag answers to gets no title rather than its id as one: a list of
 * titles that contained an id would invite the model to pass it back as a
 * title, and that would create a tag named after an id.
 */
function view(state: State, task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    done: task.isDone,
    projectId: task.projectId,
    project: projectTitle(state, task.projectId),
    estimateMinutes: minutes(task.timeEstimate),
    spentMinutes: minutes(task.timeSpent),
  };
  if (task.notes !== undefined && task.notes !== '') out['notes'] = task.notes;
  if (task.tagIds.length > 0) {
    out['tagIds'] = task.tagIds;
    const titles = task.tagIds
      .map(id => state.tags[id]?.title)
      .filter((title): title is string => title !== undefined && title !== '');
    if (titles.length > 0) out['tags'] = titles;
  }
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

function projectView(project: Project, openTasks: number): Record<string, unknown> {
  return {
    id: project.id,
    title: project.title,
    color: project.color,
    archived: project.isArchived,
    openTasks,
  };
}

function tagView(tag: Tag, openTasks: number): Record<string, unknown> {
  return { id: tag.id, title: tag.title, color: tag.color, openTasks };
}

/**
 * Whether a task is in a project, the way every other answer here counts it: a
 * task whose project no longer exists reads as Inbox in `view`, so it belongs
 * to the Inbox in a listing and in a count too.
 */
function inProject(state: State, task: Task, projectId: string): boolean {
  if (projectId !== DEFAULT_PROJECT_ID) return task.projectId === projectId;
  return task.projectId === DEFAULT_PROJECT_ID || state.projects[task.projectId] === undefined;
}

/** Open tasks per project id, the Inbox included, in one pass over the tasks. */
function openTasksByProject(state: State): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of Object.values(state.tasks)) {
    if (task.isDone) continue;
    const key = inProject(state, task, DEFAULT_PROJECT_ID) ? DEFAULT_PROJECT_ID : task.projectId;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Open tasks per tag id, in one pass over the tasks. */
function openTasksByTag(state: State): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of Object.values(state.tasks)) {
    if (task.isDone) continue;
    // A task listing the same tag twice is one task with that tag.
    for (const tagId of new Set(task.tagIds)) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
  }
  return counts;
}

function today(state: State, now: number): string {
  return dayStr(now, state.settings.dayStartOffsetMs);
}

/** Creation order. Ids are ULIDs, so sorting them sorts by creation time. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Titles match ignoring case and surrounding whitespace, which is how a person reads them. */
function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The entity with this title, or undefined. Two entities with the same title
 * can exist, since the app does not forbid it, so the oldest wins: it is the
 * one the user has had longest and most likely means.
 */
function findByTitle<T extends { id: string; title: string }>(
  entities: Record<string, T>,
  title: string,
): T | undefined {
  return Object.values(entities)
    .filter(e => sameTitle(e.title, title))
    .sort(byId)[0];
}

function entityEvent(
  ctx: ToolContext,
  type: Event['type'],
  entity: EntityKind,
  entityId: string,
  payload: unknown,
): Event {
  return newEvent({
    id: ctx.newId(),
    deviceId: ctx.deviceId,
    ts: ctx.now(),
    type,
    entity,
    entityId,
    payload,
  });
}

function taskEvent(ctx: ToolContext, type: Event['type'], entityId: string, payload: unknown): Event {
  return entityEvent(ctx, type, 'task', entityId, payload);
}

/**
 * Applies events the caller is about to append, so a tool can report the task
 * as it will be rather than as it was. Replaying the events onto the state
 * already in hand is the same fold the next read performs, so the answer cannot
 * drift from what the log says; asking the backend to read its own write back
 * would cost a round trip and, on the Worker, would not see it yet.
 */
function preview(state: State, events: Event[]): State {
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

/**
 * Why `title` cannot name a project, or null when it can. `except` is the
 * project being renamed, which is allowed to keep its own title.
 *
 * "Inbox" is refused because the built-in project already answers to it on the
 * wire: a real project with that title would be indistinguishable from the
 * Inbox in every listing, and a title passed back would resolve to the wrong
 * one.
 */
function projectTitleProblem(state: State, title: string, except?: string): string | null {
  const trimmed = title.trim();
  if (trimmed === '') return 'a project title must not be blank';
  if (sameTitle(trimmed, INBOX_TITLE)) {
    return (
      `${JSON.stringify(INBOX_TITLE)} is the built-in project every task without one belongs to; ` +
      'a project cannot take that name'
    );
  }
  const existing = findByTitle(state.projects, trimmed);
  if (existing !== undefined && existing.id !== except) {
    return `a project titled ${JSON.stringify(existing.title)} already exists: ${JSON.stringify(existing.id)}`;
  }
  return null;
}

/** Why `title` cannot name a tag, or null when it can. `except` is the tag being renamed. */
function tagTitleProblem(state: State, title: string, except?: string): string | null {
  const trimmed = title.trim();
  if (trimmed === '') return 'a tag title must not be blank';
  const existing = findByTitle(state.tags, trimmed);
  if (existing !== undefined && existing.id !== except) {
    return `a tag titled ${JSON.stringify(existing.title)} already exists: ${JSON.stringify(existing.id)}`;
  }
  return null;
}

/** A title resolved to an id, with the create event when nothing had that title. */
interface Resolved {
  id: string;
  create?: Event;
}

/**
 * A project by title. An existing project wins, then the built-in Inbox, and a
 * title nothing answers to becomes a new project whose create event the caller
 * appends ahead of whatever named it. The colour is the next in the palette,
 * exactly as the app would choose it.
 */
function resolveProject(state: State, ctx: ToolContext, title: string): Resolved | { problem: string } {
  const trimmed = title.trim();
  if (trimmed === '') return { problem: 'project must not be blank: give the title of a project' };
  const existing = findByTitle(state.projects, trimmed);
  if (existing !== undefined) return { id: existing.id };
  if (sameTitle(trimmed, INBOX_TITLE)) return { id: DEFAULT_PROJECT_ID };
  const id = ctx.newId();
  const create = entityEvent(ctx, 'create', 'project', id, {
    title: trimmed,
    color: nextEntityColor(Object.keys(state.projects).length),
    isArchived: false,
  });
  return { id, create };
}

/**
 * Tags by title, in the order given, each existing tag matched and each new
 * one created. Two spellings of one new title in the same call make one tag,
 * and a title given twice is attached once.
 */
function resolveTags(
  state: State,
  ctx: ToolContext,
  titles: string[],
): { ids: string[]; creates: Event[] } | { problem: string } {
  const ids: string[] = [];
  const creates: Event[] = [];
  const fresh: { id: string; title: string }[] = [];
  let count = Object.keys(state.tags).length;
  for (const raw of titles) {
    const title = raw.trim();
    if (title === '') return { problem: 'a tag must not be blank: give the title of a tag' };
    const existing = findByTitle(state.tags, title) ?? fresh.find(f => sameTitle(f.title, title));
    if (existing !== undefined) {
      if (!ids.includes(existing.id)) ids.push(existing.id);
      continue;
    }
    const id = ctx.newId();
    creates.push(entityEvent(ctx, 'create', 'tag', id, { title, color: nextEntityColor(count) }));
    count += 1;
    fresh.push({ id, title });
    ids.push(id);
  }
  return { ids, creates };
}

/**
 * The refusal for a call that gives both forms of one field. Checked before
 * any read, because no state could settle which one was meant.
 */
function bothFormsProblem(args: {
  project?: string;
  projectId?: string;
  tags?: string[];
  tagIds?: string[];
  tag?: string;
  tagId?: string;
}): string | null {
  if (args.project !== undefined && args.projectId !== undefined) {
    return 'project and projectId are both given: pass the title or the id, not both';
  }
  if (args.tags !== undefined && args.tagIds !== undefined) {
    return 'tags and tagIds are both given: pass titles or ids, not both';
  }
  if (args.tag !== undefined && args.tagId !== undefined) {
    return 'tag and tagId are both given: pass the title or the id, not both';
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
    'A project or tag can be named by title (project, tag) or by id (projectId, tagId), not ' +
    'both; a title nothing matches lists nothing. Completed tasks are left out unless ' +
    'includeDone is true.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  schema: z.object({
    project: z
      .string()
      .min(1)
      .optional()
      .describe('Only tasks in the project with this title. "Inbox" is the built-in project.'),
    projectId: z.string().min(1).optional().describe('Only tasks in this project, by id.'),
    tag: z.string().min(1).optional().describe('Only tasks carrying the tag with this title.'),
    tagId: z.string().min(1).optional().describe('Only tasks carrying this tag, by id.'),
    parentId: z.string().min(1).optional().describe('Only the subtasks of this task.'),
    includeDone: z.boolean().optional().describe('Include completed tasks. Defaults to false.'),
    limit: z.number().int().min(1).max(200).optional().describe('At most this many. Defaults to 50.'),
  }),
  async run(args, ctx) {
    const ambiguous = bothFormsProblem(args);
    if (ambiguous !== null) return fail(ambiguous);
    const state = await ctx.backend.loadState();

    // A title nothing matches is an empty answer, not an error: "what is in
    // the Radio project" has a true answer before the project exists.
    let projectId = args.projectId;
    if (args.project !== undefined) {
      const found = findByTitle(state.projects, args.project);
      if (found !== undefined) projectId = found.id;
      else if (sameTitle(args.project, INBOX_TITLE)) projectId = DEFAULT_PROJECT_ID;
      else return ok({ total: 0, tasks: [] });
    }
    let tagId = args.tagId;
    if (args.tag !== undefined) {
      const found = findByTitle(state.tags, args.tag);
      if (found === undefined) return ok({ total: 0, tasks: [] });
      tagId = found.id;
    }

    const matches = Object.values(state.tasks)
      .filter(t => args.includeDone === true || !t.isDone)
      .filter(t => projectId === undefined || inProject(state, t, projectId))
      .filter(t => tagId === undefined || t.tagIds.includes(tagId))
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
    'the two are mutually exclusive. Name the project and tags by title (project, tags) or by ' +
    'id (projectId, tagIds), not both; a title nothing matches is created along with the task. ' +
    'A task can be a subtask of a top-level task, and nesting stops there.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      title: z.string().min(1).describe('What the task is.'),
      notes: z.string().optional().describe('Free text.'),
      project: z
        .string()
        .min(1)
        .optional()
        .describe('The project by title. Created if no project has it. Defaults to the Inbox.'),
      projectId: z.string().min(1).optional().describe('The project by id, when you already have one.'),
      tags: z
        .array(z.string().min(1))
        .optional()
        .describe('Tags by title. A title no tag has is created.'),
      tagIds: z.array(z.string().min(1)).optional().describe('Tags by id, when you already have them.'),
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
    const ambiguous = bothFormsProblem(args);
    if (ambiguous !== null) return fail(ambiguous);
    const state = await ctx.backend.loadState();
    if (args.parentId !== undefined) {
      const problem = parentProblem(state, undefined, args.parentId);
      if (problem !== null) return fail(problem);
    }

    // Entities a title creates go into the batch ahead of the task, so the log
    // reads in the order it happened and the ids sort that way too.
    const creates: Event[] = [];
    let projectId = args.projectId ?? DEFAULT_PROJECT_ID;
    if (args.project !== undefined) {
      const resolved = resolveProject(state, ctx, args.project);
      if ('problem' in resolved) return fail(resolved.problem);
      projectId = resolved.id;
      if (resolved.create !== undefined) creates.push(resolved.create);
    }
    let tagIds = args.tagIds ?? [];
    if (args.tags !== undefined) {
      const resolved = resolveTags(state, ctx, args.tags);
      if ('problem' in resolved) return fail(resolved.problem);
      tagIds = resolved.ids;
      creates.push(...resolved.creates);
    }

    const payload: Record<string, unknown> = {
      title: args.title,
      projectId,
      tagIds,
      isDone: false,
      timeEstimate: args.estimateMinutes === undefined ? 0 : msFromMinutes(args.estimateMinutes),
    };
    if (args.notes !== undefined) payload['notes'] = args.notes;
    if (args.parentId !== undefined) payload['parentId'] = args.parentId;
    if (args.dueDay !== undefined) payload['dueDay'] = args.dueDay;
    if (args.dueAt !== undefined) payload['dueWithTime'] = Date.parse(args.dueAt);

    const id = ctx.newId();
    const batch = [...creates, taskEvent(ctx, 'create', id, payload)];
    await ctx.backend.append(batch);

    const next = preview(state, batch);
    const created = next.tasks[id];
    if (created === undefined) return fail(`the task was written but did not replay back: ${id}`);
    return ok({ created: true, task: view(next, created) });
  },
});

const updateTask = define({
  name: 'update_task',
  title: 'Update a task',
  description:
    'Changes the fields you name and leaves the rest alone. Name the project and tags by title ' +
    '(project, tags) or by id (projectId, tagIds), not both; a title nothing matches is created. ' +
    'Pass clearDue to take a task off its day, or clearParent to promote a subtask to the top ' +
    'level. Use complete_task to finish a task and log_time to record time.',
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      id: idField,
      title: z.string().min(1).optional(),
      notes: z.string().optional(),
      project: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Moves the task to the project with this title, creating it if needed. "Inbox" is the built-in project.',
        ),
      projectId: z.string().min(1).optional().describe('Moves the task to this project, by id.'),
      tags: z
        .array(z.string().min(1))
        .optional()
        .describe('Replaces the whole tag list, by title. A title no tag has is created.'),
      tagIds: z.array(z.string().min(1)).optional().describe('Replaces the whole tag list, by id.'),
      parentId: z.string().min(1).optional().describe('Moves this task under that one.'),
      clearParent: z.boolean().optional().describe('Promotes a subtask to the top level.'),
      estimateMinutes: z.number().min(0).optional(),
      dueDay: dayField.optional(),
      dueAt: isoField.optional(),
      clearDue: z.boolean().optional().describe('Removes both dueDay and dueAt.'),
    })
    .strict(),
  async run(args, ctx) {
    const ambiguous = bothFormsProblem(args);
    if (ambiguous !== null) return fail(ambiguous);
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

    const creates: Event[] = [];
    const payload: Record<string, unknown> = {};
    if (args.title !== undefined) payload['title'] = args.title;
    if (args.notes !== undefined) payload['notes'] = args.notes;
    if (args.projectId !== undefined) payload['projectId'] = args.projectId;
    if (args.project !== undefined) {
      const resolved = resolveProject(state, ctx, args.project);
      if ('problem' in resolved) return fail(resolved.problem);
      payload['projectId'] = resolved.id;
      if (resolved.create !== undefined) creates.push(resolved.create);
    }
    if (args.tagIds !== undefined) payload['tagIds'] = args.tagIds;
    if (args.tags !== undefined) {
      const resolved = resolveTags(state, ctx, args.tags);
      if ('problem' in resolved) return fail(resolved.problem);
      payload['tagIds'] = resolved.ids;
      creates.push(...resolved.creates);
    }
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

    const batch = [...creates, taskEvent(ctx, 'update', args.id, payload)];
    await ctx.backend.append(batch);

    const next = preview(state, batch);
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

    const next = preview(state, [event]);
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

    const next = preview(state, [event]);
    const task = next.tasks[args.id];
    return ok({
      logged: true,
      day,
      minutes: args.minutes,
      task: task === undefined ? undefined : view(next, task),
    });
  },
});

const listProjects = define({
  name: 'list_projects',
  title: 'List projects',
  description:
    'Every project with its id, title, colour, archived flag and count of open tasks, plus the ' +
    'built-in Inbox, which holds every task not filed in a project. Archived projects are ' +
    'included and flagged.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  schema: z.object({}),
  async run(_args, ctx) {
    const state = await ctx.backend.loadState();
    const open = openTasksByProject(state);
    return ok({
      inbox: { openTasks: open.get(DEFAULT_PROJECT_ID) ?? 0 },
      projects: Object.values(state.projects)
        .sort(byId)
        .map(p => projectView(p, open.get(p.id) ?? 0)),
    });
  },
});

const addProject = define({
  name: 'add_project',
  title: 'Add a project',
  description:
    'Creates a project. The title must not already be in use, ignoring case. The colour ' +
    'defaults to the next in the palette the app uses. add_task and update_task also take a ' +
    'project by title and create it when nothing has that title, so this is for a project with ' +
    'no task yet or one that needs a particular colour.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      title: z.string().min(1).describe("The project's name."),
      color: colorField.optional(),
    })
    .strict(),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    const problem = projectTitleProblem(state, args.title);
    if (problem !== null) return fail(problem);

    const id = ctx.newId();
    const event = entityEvent(ctx, 'create', 'project', id, {
      title: args.title.trim(),
      color: args.color ?? nextEntityColor(Object.keys(state.projects).length),
      isArchived: false,
    });
    await ctx.backend.append([event]);

    const next = preview(state, [event]);
    const created = next.projects[id];
    if (created === undefined) return fail(`the project was written but did not replay back: ${id}`);
    return ok({ created: true, project: projectView(created, 0) });
  },
});

const updateProject = define({
  name: 'update_project',
  title: 'Update a project',
  description:
    'Renames, recolours, archives or unarchives a project by id, changing only the fields you ' +
    'name. A new title must not be in use by another project. Archiving hides a project in the ' +
    'app without touching its tasks.',
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      id: z.string().min(1).describe('The project id.'),
      title: z.string().min(1).optional().describe('A new name.'),
      color: colorField.optional(),
      archived: z.boolean().optional().describe('True archives the project, false brings it back.'),
    })
    .strict(),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    const project = state.projects[args.id];
    if (project === undefined) {
      if (args.id === DEFAULT_PROJECT_ID) {
        return fail(
          `${JSON.stringify(DEFAULT_PROJECT_ID)} is the built-in project; it cannot be renamed, recoloured or archived`,
        );
      }
      return fail(`there is no project ${JSON.stringify(args.id)}`);
    }

    const payload: Record<string, unknown> = {};
    if (args.title !== undefined) {
      const problem = projectTitleProblem(state, args.title, args.id);
      if (problem !== null) return fail(problem);
      payload['title'] = args.title.trim();
    }
    if (args.color !== undefined) payload['color'] = args.color;
    if (args.archived !== undefined) payload['isArchived'] = args.archived;
    if (Object.keys(payload).length === 0) {
      return fail('nothing to update: name at least one field to change');
    }

    const event = entityEvent(ctx, 'update', 'project', args.id, payload);
    await ctx.backend.append([event]);

    const next = preview(state, [event]);
    const updated = next.projects[args.id] ?? project;
    return ok({ updated: true, project: projectView(updated, openTasksByProject(next).get(args.id) ?? 0) });
  },
});

const listTags = define({
  name: 'list_tags',
  title: 'List tags',
  description: 'Every tag with its id, title, colour and count of open tasks carrying it.',
  annotations: { readOnlyHint: true, openWorldHint: false },
  schema: z.object({}),
  async run(_args, ctx) {
    const state = await ctx.backend.loadState();
    const open = openTasksByTag(state);
    return ok({
      tags: Object.values(state.tags)
        .sort(byId)
        .map(t => tagView(t, open.get(t.id) ?? 0)),
    });
  },
});

const addTag = define({
  name: 'add_tag',
  title: 'Add a tag',
  description:
    'Creates a tag. The title must not already be in use, ignoring case. The colour defaults ' +
    'to the next in the palette the app uses. add_task and update_task also take tags by title ' +
    'and create the ones nothing matches, so this is for a tag with no task yet or one that ' +
    'needs a particular colour.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      title: z.string().min(1).describe("The tag's name."),
      color: colorField.optional(),
    })
    .strict(),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    const problem = tagTitleProblem(state, args.title);
    if (problem !== null) return fail(problem);

    const id = ctx.newId();
    const event = entityEvent(ctx, 'create', 'tag', id, {
      title: args.title.trim(),
      color: args.color ?? nextEntityColor(Object.keys(state.tags).length),
    });
    await ctx.backend.append([event]);

    const next = preview(state, [event]);
    const created = next.tags[id];
    if (created === undefined) return fail(`the tag was written but did not replay back: ${id}`);
    return ok({ created: true, tag: tagView(created, 0) });
  },
});

const updateTag = define({
  name: 'update_tag',
  title: 'Update a tag',
  description:
    'Renames or recolours a tag by id, changing only the fields you name. A new title must not ' +
    'be in use by another tag.',
  annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  schema: z
    .object({
      id: z.string().min(1).describe('The tag id.'),
      title: z.string().min(1).optional().describe('A new name.'),
      color: colorField.optional(),
    })
    .strict(),
  async run(args, ctx) {
    const state = await ctx.backend.loadState();
    const tag = state.tags[args.id];
    if (tag === undefined) return fail(`there is no tag ${JSON.stringify(args.id)}`);

    const payload: Record<string, unknown> = {};
    if (args.title !== undefined) {
      const problem = tagTitleProblem(state, args.title, args.id);
      if (problem !== null) return fail(problem);
      payload['title'] = args.title.trim();
    }
    if (args.color !== undefined) payload['color'] = args.color;
    if (Object.keys(payload).length === 0) {
      return fail('nothing to update: name at least one field to change');
    }

    const event = entityEvent(ctx, 'update', 'tag', args.id, payload);
    await ctx.backend.append([event]);

    const next = preview(state, [event]);
    const updated = next.tags[args.id] ?? tag;
    return ok({ updated: true, tag: tagView(updated, openTasksByTag(next).get(args.id) ?? 0) });
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
  listProjects,
  addProject,
  updateProject,
  listTags,
  addTag,
  updateTag,
];

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOLS.find(t => t.name === name);
}
