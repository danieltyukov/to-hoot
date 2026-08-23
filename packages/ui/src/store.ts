import {
  DEFAULT_PROJECT_ID,
  DEFAULT_SETTINGS,
  Tracker,
  cloneSettings,
  dayStr,
  newEvent,
  replay,
  taskTotalTime,
  toSyncable,
  isValidDeviceId,
  ulid,
  validateSettings,
  type Event,
  type KeyValueStore,
  type Settings,
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
 * Where the full settings live, secrets included.
 *
 * The platform key-value store, never the event log. A token written to the log
 * is a token pushed to the data repository and pulled down by every other
 * device, which turns one leaked credential into a permanent one in a git
 * history. `toSyncable` is what decides which fields are allowed to travel.
 */
const SETTINGS_KEY = 'settings';

/** Set once the wizard has been finished or dismissed. */
const SETUP_KEY = 'setup-done';

/**
 * How often accrued time is written to the log while a timer runs.
 *
 * One event per second would be correct and unusable: an hour of tracking would
 * be 3600 events to sync, merge and replay. The display does not wait for it,
 * because time since the last flush is added at read time.
 */
export const FLUSH_MS = 30_000;

/*
 * Colours a new project or tag can take.
 *
 * Six, spread round the wheel but all held to the same muted, earthy register as
 * the interface, so a list of projects reads as one palette rather than as a set
 * of highlighter pens. Every one clears 3:1 against both the light and the dark
 * background, which is the non-text threshold a 6px dot has to meet. None is in
 * the blue-to-purple arc: that is where the stock framework colours live, and
 * where this design deliberately does not go.
 */
export const ENTITY_COLORS = [
  '#c2603f',
  '#8a6d3b',
  '#5f7346',
  '#3d7350',
  '#4a6670',
  '#a4494f',
] as const;

/** Cycles, so consecutive projects never come out the same colour. */
function nextColor(index: number): string {
  return ENTITY_COLORS[index % ENTITY_COLORS.length]!;
}

export interface Snapshot {
  state: State;
  /** The full settings, secrets included. Local only; see SETTINGS_KEY. */
  settings: Settings;
  /** False until the wizard has been finished or dismissed. */
  setupDone: boolean;
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
  /** Where settings and secrets are kept. Absent means they are not persisted. */
  vault?: KeyValueStore | undefined;
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class Store {
  private readonly nowFn: () => number;
  private readonly storage: StoreOptions['storage'];
  private readonly vault: KeyValueStore | undefined;
  /**
   * The id every event this device writes is stamped with, and the folder its
   * events land in under events/<deviceId>/.
   *
   * Not readonly: it starts as a generated ULID so a device that has never been
   * named still writes somewhere unique, and becomes the name the user chose as
   * soon as they choose one. There used to be two of these, a ULID here and a
   * name in settings that nothing read, so the wizard's promise about where
   * events would be written was true of nothing.
   */
  private deviceId: string;
  private tracker: Tracker;
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

    this.vault = opts.vault;

    const stored = readStorage(this.storage, DEVICE_KEY);
    this.deviceId = stored ?? ulid();
    if (stored === null) writeStorage(this.storage, DEVICE_KEY, this.deviceId);

    this.tracker = this.newTracker();
    this.log = [...(opts.seed ?? [])];

    const savedTheme = readStorage(this.storage, THEME_KEY);
    const state = replay(this.log);
    // Left unset. A generated ULID in this field would show up pre-filled in
    // the wizard as a 26-character string nobody typed, which is exactly what a
    // real user would keep.
    const settings = cloneSettings(DEFAULT_SETTINGS);
    this.snapshot = {
      state,
      settings,
      setupDone: false,
      events: this.log,
      runningTaskId: null,
      now: this.nowFn(),
      theme: isTheme(savedTheme) ? savedTheme : state.settings.theme,
      pendingMs: 0,
      pendingSince: null,
    };
  }

  /**
   * Reads settings out of the platform store.
   *
   * Separate from the constructor because it is asynchronous and the app has to
   * render before it finishes. Until it does, the defaults apply, which is the
   * same thing a first run looks like.
   */
  async load(): Promise<void> {
    if (this.vault === undefined) return;
    const [raw, setup] = await Promise.all([
      this.vault.get(SETTINGS_KEY),
      this.vault.get(SETUP_KEY),
    ]);
    const patch: Partial<Snapshot> = { setupDone: setup === 'true' };
    if (raw !== null) {
      const parsed = safeJson(raw);
      const result = validateSettings(parsed);
      // A settings file that fails validation is kept out rather than partly
      // applied. Half-loading it is how a bad value ends up written back over
      // a good one.
      if (result.ok) {
        patch.settings = result.value;
        this.adoptDeviceId(result.value.deviceId);
        if (isTheme(result.value.theme)) patch.theme = result.value.theme;
      }
    }
    this.publish(patch);
  }

  /**
   * Merges a settings patch, persists all of it locally, and syncs the part
   * that is allowed to travel.
   *
   * The split is the whole point. `toSyncable` drops the GitHub token, the
   * calendar secret, the worker URL (it carries a path secret) and the device
   * identity, and only what survives that goes into the event log.
   */
  saveSettings(patch: Partial<Settings>): void {
    const merged: Settings = {
      ...this.snapshot.settings,
      ...patch,
      github: { ...this.snapshot.settings.github, ...patch.github },
      calendar: { ...this.snapshot.settings.calendar, ...patch.calendar },
      worker: { ...this.snapshot.settings.worker, ...patch.worker },
    };
    if (patch.deviceId !== undefined) this.adoptDeviceId(patch.deviceId.trim());
    void this.vault?.set(SETTINGS_KEY, JSON.stringify(merged));
    if (patch.theme !== undefined) writeStorage(this.storage, THEME_KEY, patch.theme);

    const syncable = toSyncable(merged);
    this.commit(
      [
        this.event('update', 'settings', 'app', {
          theme: syncable.theme,
          dayStartOffsetMs: syncable.dayStartOffsetMs,
          idleThresholdMs: syncable.idleThresholdMs,
          workdayStart: syncable.workdayStart,
          workdayEnd: syncable.workdayEnd,
          github: syncable.github,
          calendar: syncable.calendar,
        }),
      ],
      { settings: merged, theme: merged.theme },
    );
  }

  /** Records that the wizard is done, so it does not open again. */
  finishSetup(): void {
    void this.vault?.set(SETUP_KEY, 'true');
    this.publish({ setupDone: true });
  }

  /** The whole log, for the export button. */
  exportJson(): string {
    return JSON.stringify({ version: 1, exported: this.nowFn(), events: this.log }, null, 2);
  }

  /**
   * Merges an exported log back in.
   *
   * Merged rather than replaced, and replay dedupes by event id, so importing
   * the same file twice is harmless and importing another device's export is a
   * merge rather than an overwrite.
   */
  importJson(text: string): { ok: true; added: number } | { ok: false; error: string } {
    const parsed = safeJson(text);
    const events = (parsed as { events?: unknown } | undefined)?.events;
    if (!Array.isArray(events)) return { ok: false, error: 'That file has no events in it.' };
    const known = new Set(this.log.map(e => e.id));
    const fresh = events.filter(
      (e): e is Event => typeof (e as Event | null)?.id === 'string' && !known.has((e as Event).id),
    );
    this.commit(fresh);
    return { ok: true, added: fresh.length };
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

  /** The id this device stamps its events with. The wizard states this. */
  get device(): string {
    return this.deviceId;
  }

  private newTracker(): Tracker {
    return new Tracker({ deviceId: this.deviceId, now: this.nowFn });
  }

  /**
   * Adopts a new device name.
   *
   * The running timer is stopped first so the seconds since the last flush are
   * banked under the id that earned them, and because the Tracker stamps events
   * with the id it was built with: keeping the old one would write the next
   * delta to the previous folder.
   */
  private adoptDeviceId(next: string): void {
    if (next === '' || next === this.deviceId || !isValidDeviceId(next)) return;
    if (this.snapshot.runningTaskId !== null) this.stop();
    this.deviceId = next;
    writeStorage(this.storage, DEVICE_KEY, next);
    this.tracker = this.newTracker();
  }

  /** A field-level change to a task. The detail view is the main caller. */
  patchTask(taskId: string, patch: Record<string, unknown>): void {
    this.commit([this.event('update', 'task', taskId, patch)]);
  }

  addSubtask(parentId: string, title: string): string {
    return this.addTask(title, { parentId });
  }

  deleteTask(taskId: string): void {
    const stopping = this.snapshot.runningTaskId === taskId;
    const stopped = stopping ? this.stopEvents() : [];
    this.commit(
      [...stopped, this.event('delete', 'task', taskId, {})],
      stopping ? { runningTaskId: null } : {},
    );
  }

  addProject(title: string): string {
    const id = ulid();
    this.commit([
      this.event('create', 'project', id, {
        title,
        color: nextColor(Object.keys(this.snapshot.state.projects).length),
        isArchived: false,
      }),
    ]);
    return id;
  }

  addTag(title: string): string {
    const id = ulid();
    this.commit([
      this.event('create', 'tag', id, {
        title,
        color: nextColor(Object.keys(this.snapshot.state.tags).length),
      }),
    ]);
    return id;
  }

  private stopEvents(): Event[] {
    const events = this.tracker.stop();
    this.flushedAt = null;
    return events;
  }

  private event(
    type: 'create' | 'update' | 'delete',
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
