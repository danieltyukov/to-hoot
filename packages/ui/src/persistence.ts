import { emptyState, replay, type Event, type FileStore, type State } from '@to-hoot/core';

/*
 * The log on disk.
 *
 * Two files, and the difference between them is the whole design:
 *
 *   log.json    every event this device knows about and has not yet handed to
 *               sync. Authoritative. Truncated only for events a push has
 *               acknowledged, because until then this is the only copy.
 *
 *   cache.json  a replayed state and the id it covers up to. Never
 *               authoritative: it can be deleted at any moment and the app
 *               rebuilds it from the log.
 *
 * The cache exists because boot cost is otherwise unbounded. Time is written
 * every thirty seconds while a timer runs, so a year of ordinary use is tens of
 * thousands of events, and replaying all of them on every start is a cost that
 * only grows. With the cache, boot replays the remainder onto it, which
 * `replay` already does for free: a base state carrying `coversThrough` makes it
 * discard everything at or below that id.
 *
 * They are separate files rather than one because they have different
 * durability requirements. Losing the cache costs a slower boot. Losing the log
 * costs the user their unsynced work.
 */

export const LOG_FILE = 'log.json';
export const CACHE_FILE = 'cache.json';

/** Bumped only for a change the older reader cannot cope with. */
export const FORMAT_VERSION = 1;

/**
 * How many events may sit in front of the cache before it is rewritten.
 *
 * Not a memory limit. It is the number of events a boot has to replay in the
 * worst case, and a few hundred is imperceptible while tens of thousands is not.
 */
export const CACHE_EVERY = 400;

interface LogFile {
  version: number;
  events: Event[];
}

interface CacheFile {
  version: number;
  state: State;
}

function parse(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The greatest id in a set, which is the only watermark replay's filter accepts. */
export function watermarkOf(events: readonly Event[]): string | undefined {
  let top: string | undefined;
  for (const event of events) {
    if (typeof event?.id !== 'string') continue;
    if (top === undefined || event.id > top) top = event.id;
  }
  return top;
}

/**
 * Reads what is on disk into a state and the log behind it.
 *
 * A cache that cannot be read, or that was written by a newer format, is
 * ignored rather than repaired: it is derivable, so the honest response to any
 * doubt about it is to throw it away and replay. The log gets no such treatment.
 */
export interface Loaded {
  events: Event[];
  state: State;
  cached: boolean;
  /**
   * The cache the state was replayed onto, watermark intact, or undefined when
   * there was no usable one.
   *
   * Returned rather than kept private because `state` alone is not enough to
   * replay the log again later. An import has to re-order the whole log, and
   * doing that needs the same base this did, including its `coversThrough`:
   * the log still holds the events the cache covers, and the watermark is what
   * stops them being applied twice.
   */
  base?: State;
  /**
   * Set when the log file exists and could not be read.
   *
   * Absent and unreadable are different answers and must never be collapsed
   * into one. An absent log is a new install. An unreadable log is the only
   * copy of work nobody else has, and the honest response is to refuse to
   * touch it: treating it as empty means the next write puts `[]` over the top
   * and the corruption becomes permanent.
   *
   * That is not a remote possibility. Neither shell writes atomically, and the
   * whole file is rewritten every thirty seconds while a timer runs, so
   * "killed mid-write" is the ordinary case rather than the exotic one.
   */
  damaged?: string;
}

export async function load(files: FileStore): Promise<Loaded> {
  const [logText, cacheText] = await Promise.all([files.read(LOG_FILE), files.read(CACHE_FILE)]);

  let damaged: string | undefined;
  let events: Event[] = [];
  if (logText !== null) {
    const logBody = parse(logText) as LogFile | undefined;
    if (logBody === undefined) {
      damaged = 'The log file could not be read. It may have been cut short by a crash.';
    } else if (!Array.isArray(logBody.events)) {
      damaged = 'The log file has no events in it, which is not a shape this app writes.';
    } else {
      events = logBody.events.filter(isEventish);
    }
  }

  const cacheBody = parse(cacheText) as CacheFile | undefined;
  const usable =
    cacheBody?.version === FORMAT_VERSION &&
    typeof cacheBody.state === 'object' &&
    cacheBody.state !== null &&
    typeof cacheBody.state.coversThrough === 'string';

  const base = usable ? cacheBody.state : undefined;
  return {
    events,
    state: replay(events, base),
    cached: usable,
    ...(base === undefined ? {} : { base }),
    ...(damaged === undefined ? {} : { damaged }),
  };
}

function isEventish(value: unknown): value is Event {
  return typeof (value as Event | null)?.id === 'string';
}

export async function writeLog(files: FileStore, events: readonly Event[]): Promise<void> {
  const body: LogFile = { version: FORMAT_VERSION, events: [...events] };
  await files.write(LOG_FILE, JSON.stringify(body));
}

/**
 * Rewrites the cache to cover everything currently in the log.
 *
 * The watermark is supplied rather than taken from the log, because after a
 * successful push the log is empty and the state is not: everything it
 * describes is in the repository. Deriving the watermark from an empty log gave
 * `undefined`, skipped the write, and left a restart with no log and no cache,
 * which is to say with nothing at all.
 *
 * It is the GREATEST id in the folded set, not the last one applied.
 * Replay orders by `(ts, deviceId, id)`, so the last event it applies is
 * routinely not the greatest id: two devices landing in the same millisecond is
 * enough. Stamping the last-applied id would leave an event above the watermark
 * that had already been folded, and the next boot would fold it a second time.
 * For a `timeDelta`, which carries an increment, that is silently doubled time.
 */
export async function writeCache(
  files: FileStore,
  coversThrough: string | undefined,
  state: State,
): Promise<void> {
  if (coversThrough === undefined) return;
  const body: CacheFile = { version: FORMAT_VERSION, state: { ...state, coversThrough } };
  await files.write(CACHE_FILE, JSON.stringify(body));
}

/**
 * Moves an unreadable log aside so a new one can be started.
 *
 * Renamed rather than deleted. The bytes are the only copy of whatever had not
 * synced, and a person with a hex editor can get more out of them than this
 * app can; deleting them to tidy up would throw away the one thing that still
 * has the user's work in it.
 */
export async function setLogAside(files: FileStore, now: number): Promise<string> {
  const kept = `log.damaged-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
  const text = await files.read(LOG_FILE);
  if (text !== null) await files.write(kept, text);
  await files.remove(LOG_FILE);
  await files.remove(CACHE_FILE);
  return kept;
}

/** Forgets the cache, which is always safe: it is rebuilt by replaying the log. */
export async function clearCache(files: FileStore): Promise<void> {
  await files.remove(CACHE_FILE);
}

/**
 * The events a push has not yet acknowledged.
 *
 * Everything at or below the watermark is in the repository, so the local copy
 * is no longer the only one and may be dropped. Above it, this device holds the
 * only copy and dropping it would lose the user's work.
 */
export function unpushed(events: readonly Event[], pushedThrough: string | undefined): Event[] {
  if (pushedThrough === undefined) return [...events];
  return events.filter(e => e.id > pushedThrough);
}

export { emptyState };
