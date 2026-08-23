// What a tool needs from the world, as narrow as it can be made.
//
// The nine tools are one implementation serving two very different hosts: a
// long-lived stdio process next to the user's own repository, and a stateless
// Cloudflare Worker with a 10ms CPU budget per request. Neither of those shapes
// belongs in the tool bodies, so both arrive as a `ToolBackend`: the stdio
// server hands over a full `SyncEngine`, the Worker hands over a snapshot
// reader and a direct append, and the tests hand over an in-memory log.

import type { Event } from '../events.js';
import { replay } from '../replay.js';
import { ulid } from '../models.js';
import type { State } from '../state.js';

/**
 * The state a tool reads and the log it appends to.
 *
 * `append` is all-or-nothing from a tool's point of view: it either commits
 * every event it was handed or throws. A tool never appends twice, so nothing
 * here has to be idempotent.
 */
export interface ToolBackend {
  loadState(): Promise<State>;
  append(events: Event[]): Promise<void>;
}

/** A timer that was started and has not been stopped yet. */
export interface RunningTimer {
  taskId: string;
  /** Epoch milliseconds, from the host's clock. */
  startedAt: number;
}

/**
 * Where a running timer is remembered between two tool calls.
 *
 * It is deliberately not an event: the log records time that was spent, and a
 * timer that is still running has not spent any yet. Writing a "started" marker
 * into an append-only log would leave a permanent record of every abandoned
 * timer for every device to replay.
 */
export interface TimerStore {
  read(): Promise<RunningTimer | null>;
  write(timer: RunningTimer | null): Promise<void>;
}

export interface ToolContextOptions {
  backend: ToolBackend;
  timers: TimerStore;
  /** Stamped onto every event this host writes; never shared with another host. */
  deviceId: string;
  /** Defaults to `Date.now`. Injected so tests can drive the clock. */
  now?: () => number;
  /** Defaults to `ulid`. Ids must be ULIDs: replay dedups and orders by id. */
  newId?: () => string;
  /**
   * A span longer than this is a forgotten timer rather than a work session,
   * and `stop_timer` refuses to bank it. Defaults to 12 hours.
   */
  maxSessionMs?: number;
}

export interface ToolContext {
  backend: ToolBackend;
  timers: TimerStore;
  deviceId: string;
  now(): number;
  newId(): string;
  maxSessionMs: number;
  /**
   * Runs `fn` with no other timer section running against this context.
   *
   * Starting and stopping a timer is read-decide-append-write, and every step
   * but the first awaits. Two calls that interleave there both read the same
   * running timer and both append for it, and because a `timeDelta` carries an
   * increment rather than a total, the second one is time nobody worked,
   * recorded permanently and invisibly while both replies claim the same
   * honest-looking number. The Worker shares one store across every request an
   * isolate serves, so the race is ordinary rather than exotic.
   *
   * A promise chain is enough because the scope is exactly one process or one
   * isolate, which is also the scope of the store it guards. It is not a lock
   * across devices, and it does not need to be: a device writes its own events.
   */
  withTimerLock<T>(fn: () => Promise<T>): Promise<T>;
}

const DEFAULT_MAX_SESSION_MS = 12 * 3600_000;

export function toolContext(options: ToolContextOptions): ToolContext {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? ulid;

  // The tail of the queue. Each caller waits on whatever was queued before it
  // and then becomes the tail, so the sections run one after another. The
  // `catch` keeps a section that threw from poisoning the queue for everyone
  // behind it; the rejection still reaches its own caller through `result`.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    backend: options.backend,
    timers: options.timers,
    deviceId: options.deviceId,
    now,
    newId,
    maxSessionMs: options.maxSessionMs ?? DEFAULT_MAX_SESSION_MS,
    withTimerLock<T>(fn: () => Promise<T>): Promise<T> {
      const result = queue.then(fn, fn);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

/** A tool's answer. `isError` is the MCP tool-level error, not a transport one. */
export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  idempotentHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * One tool, independent of any MCP server class.
 *
 * `run` takes `unknown` and validates the arguments itself rather than trusting
 * a caller to have done it. The MCP server validates them too, which makes the
 * second pass redundant on that path and load bearing on every other one: a
 * direct call from a test or from a future non-MCP host gets the same checks.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: ToolSchema;
  readonly annotations: ToolAnnotations;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * The schema shape both servers need: Standard Schema for validation plus the
 * JSON Schema projection `tools/list` advertises. A `zod/v4` object schema
 * satisfies it; nothing here depends on Zod's own types, so a tool's arguments
 * stay describable without pinning the servers to one validator.
 */
export interface ToolSchema {
  readonly '~standard': {
    readonly validate: (value: unknown) => unknown;
    readonly vendor: string;
    readonly version: number;
    readonly jsonSchema: { input(): unknown; output(): unknown };
  };
}

// An in-memory log. Used by the tests, and by the Worker for the running-timer
// marker it has nowhere durable to put.

export interface MemoryBackend extends ToolBackend {
  /** Every event the log holds, seeds included. */
  readonly log: Event[];
  /** Only what tools appended, in order. Read-only tools must leave this empty. */
  readonly appended: Event[];
}

export function memoryBackend(seed: Event[] = []): MemoryBackend {
  const log = [...seed];
  const appended: Event[] = [];
  return {
    log,
    appended,
    async loadState(): Promise<State> {
      return replay(log);
    },
    async append(events: Event[]): Promise<void> {
      log.push(...events);
      appended.push(...events);
    },
  };
}

export function memoryTimerStore(): TimerStore {
  let current: RunningTimer | null = null;
  return {
    async read(): Promise<RunningTimer | null> {
      return current;
    },
    async write(timer: RunningTimer | null): Promise<void> {
      current = timer;
    },
  };
}
