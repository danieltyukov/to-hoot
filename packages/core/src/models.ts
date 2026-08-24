// Entity models, identity, and logical day strings. Pure data and pure
// functions: nothing here touches the DOM, the network, or a platform API.

/**
 * One continuous stretch of tracked work, in epoch milliseconds.
 *
 * An inference, not a record, and the difference matters: a timeDelta carries
 * an increment and the wall clock it was written at, so a delta of 30s stamped
 * 14:00:30 covers 14:00:00 to 14:00:30. It is only as good as the clock of the
 * device that wrote it. Good enough to show when a day went, and never a
 * billing record.
 */
export interface WorkPeriod {
  startMs: number;
  endMs: number;
}

/** A unit of work. `timeSpent` is derived; see the rules below. */
export interface Task {
  id: string;
  title: string;
  notes?: string;
  isDone: boolean;
  doneOn?: number;

  /** Required. "inbox" is the default project. */
  projectId: string;
  /** Never contains "TODAY": today is computed from the due fields. */
  tagIds: string[];

  /** Nesting is capped at two levels, enforced during replay. */
  parentId?: string;
  subTaskIds: string[];

  /** Milliseconds. */
  timeEstimate: number;
  /** DERIVED: the sum of `timeSpentOnDay`. Never written from an event payload. */
  timeSpent: number;
  /** "YYYY-MM-DD" -> milliseconds. This is the storage of record for time. */
  timeSpentOnDay: Record<string, number>;
  /**
   * DERIVED: "YYYY-MM-DD" -> when the work actually happened, joined and sorted.
   * Never written from an update payload; replay builds it from the same
   * timeDelta events `timeSpentOnDay` sums.
   *
   * It exists because the sum cannot say when. Inferring stretches from the log
   * at the moment they are needed only works while the log still holds them,
   * and a push truncates the log to what it has not acknowledged: the totals
   * survive that, so the stretches have to survive it in the same place.
   */
  workPeriodsOnDay: Record<string, WorkPeriod[]>;

  /** "YYYY-MM-DD". Mutually exclusive with `dueWithTime`. */
  dueDay?: string;
  /** Epoch milliseconds. Mutually exclusive with `dueDay`. */
  dueWithTime?: number;

  calendarEventId?: string;
  /** Idempotency ledger for calendar write-back: day -> ms already written. */
  calendarWritten: Record<string, number>;
  /**
   * The other half of that ledger: day -> how many blocks are on the calendar.
   *
   * One block per work period, so the count moves when the day's shape changes
   * and not only when its total does. Without it a day that went from three
   * stretches to two would leave the third block behind forever, since nothing
   * else records that it was ever written.
   */
  calendarBlocks: Record<string, number>;

  created: number;
  updated: number;
}

export interface Project {
  id: string;
  title: string;
  color: string;
  /** Ordered. Whole-array last-write-wins. */
  taskIds: string[];
  isArchived: boolean;
}

export interface Tag {
  id: string;
  title: string;
  color: string;
  /** Ordered. Whole-array last-write-wins. */
  taskIds: string[];
}

export type Theme = 'light' | 'dark' | 'system';

/**
 * Every account-specific value lives here, so nothing is hardcoded to one
 * person's accounts. Secrets are marked; see `toSyncable` in settings.ts for
 * which fields are kept out of the synced payload.
 */
export interface Settings {
  github: {
    owner: string;
    repo: string;
    /**
     * The branch the data lives on.
     *
     * Empty means "whatever the repository says its default is", which the
     * client resolves once and caches. It is stored rather than re-derived
     * because a literal `main` written back over a `master` repository sends
     * every read to a branch that does not exist, and GitHub answers 404 for
     * that in the same way it answers for a repository you cannot see. The
     * write path is worse: a missing ref reads as "no commits yet", so the next
     * commit creates an orphan branch and reports success.
     */
    branch: string;
    /** Secret. Never synced. */
    token: string;
  };
  calendar: {
    execUrl: string;
    /** Secret. Never synced. */
    secret: string;
    icsUrl: string;
  };
  worker: {
    /** Contains a path secret, so it is never synced. */
    url: string;
    /**
     * The path secret the endpoint URL is built from. Secret, never synced.
     *
     * Stored rather than re-generated, so the commands the wizard prints and
     * the URL already saved beside them cannot disagree.
     */
    pathSecret: string;
  };
  /** Device-local. Two devices must never share one id. */
  deviceId: string;
  /** Device-local. */
  deviceName: string;
  theme: Theme;
  /** How far past midnight the logical day still counts as the previous one. */
  dayStartOffsetMs: number;
  idleThresholdMs: number;
  /** "HH:MM", local time. */
  workdayStart: string;
  /** "HH:MM", local time. */
  workdayEnd: string;
}

export const DEFAULT_PROJECT_ID = 'inbox';

/**
 * A device id is one path segment: no slash, no leading dot, nothing exotic.
 *
 * This is a data-integrity rule, not a style one. Sync writes each device's
 * events to `events/<deviceId>/<ulid>.json`, and every reader looks for exactly
 * that shape. A slash in the value writes files under a path no reader matches,
 * so the events are pushed, stored, and then ignored forever: the device appears
 * to sync and its work quietly never arrives anywhere.
 */
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether a device id is safe to use as a path segment.
 *
 * Empty is allowed only where `allowUnset` is set, which is the difference
 * between "not configured yet" and "configured wrongly". Settings loaded from
 * disk may legitimately carry an empty id before the wizard has run; the sync
 * engine may not accept one.
 */
export function isValidDeviceId(value: unknown, allowUnset = false): value is string {
  if (typeof value !== 'string') return false;
  if (value === '') return allowUnset;
  return DEVICE_ID.test(value);
}

/** The rule, in words, for a message shown to whoever typed the bad value. */
export const DEVICE_ID_RULE =
  'Letters, numbers, dots, dashes and underscores, starting with a letter or number.';

/** Field defaults for a new task. Callers supply id, title, created, updated. */
export const DEFAULT_TASK: Omit<Task, 'id' | 'created' | 'updated'> = {
  title: '',
  isDone: false,
  projectId: DEFAULT_PROJECT_ID,
  tagIds: [],
  subTaskIds: [],
  timeEstimate: 0,
  timeSpent: 0,
  timeSpentOnDay: {},
  workPeriodsOnDay: {},
  calendarWritten: {},
  calendarBlocks: {},
};

export const DEFAULT_SETTINGS: Settings = {
  github: { owner: '', repo: '', branch: '', token: '' },
  calendar: { execUrl: '', secret: '', icsUrl: '' },
  worker: { url: '', pathSecret: '' },
  deviceId: '',
  deviceName: '',
  theme: 'system',
  dayStartOffsetMs: 0,
  idleThresholdMs: 10 * 60_000,
  workdayStart: '09:00',
  workdayEnd: '17:00',
};

/** Builds a task with the default fields, freshly cloned. */
export function newTask(id: string, ts: number, patch: Partial<Task> = {}): Task {
  return {
    ...DEFAULT_TASK,
    tagIds: [],
    subTaskIds: [],
    timeSpentOnDay: {},
    workPeriodsOnDay: {},
    calendarWritten: {},
    calendarBlocks: {},
    id,
    created: ts,
    updated: ts,
    ...patch,
  };
}

// Crockford base32, the ULID alphabet: no I, L, O or U.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function randomPart(): number[] {
  // Math.random is enough: a ULID is an identifier, not a secret, and the
  // monotonic counter below is what guarantees uniqueness within a millisecond.
  const out = new Array<number>(RAND_LEN);
  for (let i = 0; i < RAND_LEN; i++) out[i] = Math.floor(Math.random() * 32);
  return out;
}

/** Increments the random part by one, carrying left. Wraps if every char is max. */
function bumpRandom(parts: number[]): void {
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]! < 31) {
      parts[i]!++;
      return;
    }
    parts[i] = 0;
  }
}

function encodeTime(ts: number): string {
  let rest = ts;
  let out = '';
  for (let i = 0; i < TIME_LEN; i++) {
    out = B32[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * A 26-character ULID: 10 chars of millisecond timestamp then 16 of randomness,
 * so ids sort lexicographically by creation time. Repeated calls within one
 * millisecond increment the random part instead of redrawing it, which keeps
 * them unique and keeps them sorting in call order. A clock that steps backwards
 * reuses the previous timestamp for the same reason.
 */
export function ulid(): string {
  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    lastRandom = randomPart();
  } else {
    bumpRandom(lastRandom);
  }
  return encodeTime(lastTime) + lastRandom.map(n => B32[n]).join('');
}

/**
 * The logical day of `ts` as "YYYY-MM-DD", in local calendar fields.
 *
 * `offsetMs` shifts the day boundary later: with a 4h offset, 02:00 still
 * belongs to the previous day. Local fields, not `toISOString`, because the
 * latter reports UTC and shifts the day for anyone who is not on UTC.
 */
export function dayStr(ts: number, offsetMs = 0): string {
  const d = new Date(ts - offsetMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
