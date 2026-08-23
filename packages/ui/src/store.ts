import {
  DEFAULT_PROJECT_ID,
  Tracker,
  dayStr,
  newEvent,
  replay,
  taskTotalTime,
  ulid,
  type Event,
  type State,
  type Theme,
} from '@to-hoot/core';

/*
 * The app's state, for Phase 3: an event log in memory, replayed on every
 * change. Sync, persistence and compaction arrive later and attach here.
 *
 * The log is the only write path, exactly as it is in core. Nothing mutates
 * state, so the UI cannot invent a shape the replayed state would never produce,
 * and the moment a real transport is wired in there is nothing to reconcile.
 *
 * Two things are deliberately outside the log:
 *   - The device id, which must differ per device. It lives in local storage,
 *     generated on first run. Two devices sharing one would write the same event
 *     paths, and the whole merge model rests on them not colliding.
 *   - The theme, which is also written to the log so it syncs, but is read back
 *     from local storage at boot. The log is not persisted yet, so without the
 *     local copy the theme would reset on every reload.
 */

const DEVICE_KEY = 'to-hoot:device';
const THEME_KEY = 'to-hoot:theme';

/**
 * How often accrued time is written to the log while a timer runs.
 *
 * One event per second would be correct and unusable: an hour of tracking would
 * be 3600 events to sync, merge and replay. The display does not wait for it,
 * because time since the last flush is added at read time.
 */
export const FLUSH_MS = 30_000;

export interface Snapshot {
  state: State;
  events: readonly Event[];
  runningTaskId: string | null;
  /** The clock reading this snapshot was taken at. Advances every display tick. */
  now: number;
  theme: Theme;
  /** Milliseconds accrued to the running task but not yet in the log. */
  pendingMs: number;
  /** When the pending stretch started, for drawing it on the timeline. */
  pendingSince: number | null;
}

export interface StoreOptions {
  now?: () => number;
  /** Injected so tests are not writing to a shared browser store. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  seed?: readonly Event[];
}

function readStorage(storage: StoreOptions['storage'], key: string): string | null {
  // A browser with site data blocked throws on access rather than returning
  // null, and a theme preference is not worth failing to boot over.
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(storage: StoreOptions['storage'], key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* ignore: see readStorage */
  }
}

function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark' || v === 'system';
}

export class Store {
  private readonly nowFn: () => number;
  private readonly storage: StoreOptions['storage'];
  private readonly deviceId: string;
  private readonly tracker: Tracker;
  private readonly listeners = new Set<() => void>();

  private log: Event[] = [];
  private snapshot: Snapshot;
  private flushedAt: number | null = null;

  constructor(opts: StoreOptions = {}) {
    this.nowFn = opts.now ?? Date.now;
    this.storage =
      opts.storage === undefined
        ? typeof localStorage === 'undefined'
          ? null
          : localStorage
        : opts.storage;

    const stored = readStorage(this.storage, DEVICE_KEY);
    this.deviceId = stored ?? ulid();
    if (stored === null) writeStorage(this.storage, DEVICE_KEY, this.deviceId);

    this.tracker = new Tracker({ deviceId: this.deviceId, now: this.nowFn });
    this.log = [...(opts.seed ?? [])];

    const savedTheme = readStorage(this.storage, THEME_KEY);
    const state = replay(this.log);
    this.snapshot = {
      state,
      events: this.log,
      runningTaskId: null,
      now: this.nowFn(),
      theme: isTheme(savedTheme) ? savedTheme : state.settings.theme,
      pendingMs: 0,
      pendingSince: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  /** Tracked time including subtasks, with the unflushed stretch added on. */
  trackedFor = (taskId: string): number => {
    const stored = taskTotalTime(this.snapshot.state, taskId);
    return taskId === this.snapshot.runningTaskId ? stored + this.snapshot.pendingMs : stored;
  };

  addTask(title: string, patch: Record<string, unknown> = {}): string {
    const id = ulid();
    const now = this.nowFn();
    this.commit([
      this.event('create', 'task', id, {
        title,
        projectId: DEFAULT_PROJECT_ID,
        isDone: false,
        timeEstimate: 0,
        dueDay: dayStr(now, this.snapshot.state.settings.dayStartOffsetMs),
        ...patch,
      }),
    ]);
    return id;
  }

  toggleDone(taskId: string, done: boolean): void {
    // Finishing the running task stops the timer, and stops it first, so the
    // seconds since the last flush land on the task that earned them instead of
    // being thrown away by the act of finishing.
    const stopping = done && this.snapshot.runningTaskId === taskId;
    const stopped = stopping ? this.stopEvents() : [];
    this.commit(
      [
        ...stopped,
        this.event('update', 'task', taskId, { isDone: done, doneOn: done ? this.nowFn() : null }),
      ],
      stopping ? { runningTaskId: null } : {},
    );
  }

  start(taskId: string): void {
    const events = this.tracker.start(taskId);
    this.flushedAt = this.nowFn();
    this.commit(events, { runningTaskId: taskId });
  }

  stop(): void {
    this.commit(this.stopEvents(), { runningTaskId: null });
  }

  /**
   * One turn of the clock.
   *
   * Two rates in one call: the display moves every tick so a running timer is
   * visibly running, and the log is written every FLUSH_MS so it stays a log
   * rather than a stream.
   */
  tick(): void {
    const now = this.nowFn();
    if (this.snapshot.runningTaskId !== null && this.flushedAt !== null) {
      if (now - this.flushedAt >= FLUSH_MS) {
        const events = this.tracker.onTick();
        this.flushedAt = now;
        this.commit(events);
        return;
      }
    }
    this.publish({});
  }

  setTheme(theme: Theme): void {
    // Written to the log so it syncs, and to local storage so it survives a
    // reload before any log has been loaded.
    writeStorage(this.storage, THEME_KEY, theme);
    this.commit([this.event('update', 'settings', 'app', { theme })], { theme });
  }

  private stopEvents(): Event[] {
    const events = this.tracker.stop();
    this.flushedAt = null;
    return events;
  }

  private event(
    type: 'create' | 'update',
    entity: 'task' | 'project' | 'tag' | 'settings',
    entityId: string,
    payload: unknown,
  ): Event {
    return newEvent({ deviceId: this.deviceId, type, entity, entityId, payload, ts: this.nowFn() });
  }

  private commit(events: readonly Event[], patch: Partial<Snapshot> = {}): void {
    if (events.length > 0) this.log = [...this.log, ...events];
    this.publish({ ...patch, state: replay(this.log), events: this.log });
  }

  private publish(patch: Partial<Snapshot>): void {
    const now = this.nowFn();
    const merged = { ...this.snapshot, ...patch, now };
    const running = merged.runningTaskId !== null && this.flushedAt !== null;
    this.snapshot = {
      ...merged,
      pendingMs: running ? Math.max(0, now - this.flushedAt!) : 0,
      pendingSince: running ? this.flushedAt : null,
    };
    for (const listener of this.listeners) listener();
  }
}

/** A store with no log and no browser storage. Used by tests and by SSR. */
export function emptyStore(): Store {
  return new Store({ storage: null });
}
