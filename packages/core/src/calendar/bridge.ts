// The wire protocol of the Google Apps Script calendar bridge, and every part
// of the script that can be reasoned about without Google's globals.
//
// This file is the ONE definition both ends share: `apps/apps-script/src/Code.ts`
// bundles it with esbuild and calls `handleBridgeRequest`, and `client.ts` builds
// its requests against the same types. A protocol split across two files that
// nothing checks against each other is a protocol that drifts.
//
// Two constraints shape it:
//
//   1. Apps Script gives a handler six minutes. Nothing here walks a year of
//      history in one call: list is paged and the client drives the loop, and
//      writes come in bounded batches.
//   2. Apps Script's own failures are HTML pages. So every answer this file
//      produces is JSON with an `ok` field, including the failures, and the
//      wrapper sends all of them with HTTP 200.
//
// It deliberately imports nothing, not even from the rest of core: it is bundled
// into a script the user pastes into their own Google account, and every import
// would be another module in something a human is expected to read before
// pasting it.

/** The name of the separate calendar every write-back goes to. */
export const LOG_CALENDAR_NAME = 'to-hoot log';
/** The `extendedProperties.private` key that makes a re-sync an update. */
export const TO_HOOT_ID_KEY = 'toHootId';

/** Bumped when the wire format changes in a way a client has to notice. */
export const BRIDGE_VERSION = 1;

/** A read window one call can serve comfortably. The client asks again for more. */
export const MAX_LIST_DAYS = 62;
/** Google's own per-page ceiling for `events.list`. */
export const MAX_PAGE_SIZE = 250;
/**
 * Writes per request. Each entry costs a lookup plus an insert or update, so a
 * batch of 50 is roughly 100 Calendar calls: far inside six minutes, and small
 * enough that a backfill makes progress in bounded steps.
 */
export const MAX_WRITE_ENTRIES = 50;
export const MAX_DELETE_IDS = 100;
/** How many events sharing one toHootId a single write will clean up. */
export const MAX_DUPLICATE_CLEANUP = 25;
/** Google rejects longer summaries; a task title is truncated, never dropped. */
const MAX_SUMMARY_CHARS = 1000;
const MAX_ID_CHARS = 200;
const DAY_MS = 86_400_000;
/** The range `Date` can represent. Anything outside it is a client bug. */
const MAX_TIMESTAMP = 8.64e15;

export type BridgeAction = 'listEvents' | 'writeLog' | 'deleteLog';

export type BridgeErrorCode =
  | 'unauthorized'
  | 'bad-request'
  | 'unsupported-action'
  | 'calendar-error'
  | 'calendar-service-disabled'
  | 'script-error';

export interface ListEventsRequest {
  action: 'listEvents';
  /** Epoch milliseconds. The client owns the day boundary; the script never guesses it. */
  from: number;
  days: number;
  /** Defaults to `primary`, which is whichever account deployed the script. */
  calendarId?: string;
  pageToken?: string;
  maxResults?: number;
}

export interface WriteLogEntry {
  /** Stable per task and day. See `logIdFor` in writeback.ts. */
  toHootId: string;
  title: string;
  /** Epoch milliseconds. */
  start: number;
  /** Epoch milliseconds, exclusive. */
  end: number;
  notes?: string;
}

export interface WriteLogRequest {
  action: 'writeLog';
  entries: WriteLogEntry[];
}

export interface DeleteLogRequest {
  action: 'deleteLog';
  toHootIds: string[];
}

export type BridgeRequest = ListEventsRequest | WriteLogRequest | DeleteLogRequest;

export interface BridgeEvent {
  id: string;
  calendarId: string;
  /** Google omits the summary of an untitled event; it stays empty here. */
  title: string;
  /** Epoch milliseconds. For an all-day event, UTC midnight of `startDay`. */
  start: number;
  end: number;
  allDay: boolean;
  /**
   * All-day events only, as Google reports them: a bare "YYYY-MM-DD" with no
   * zone. The client places them in the device's own timezone, because the
   * script's timezone is a property of the deployment, not of the reader.
   */
  startDay?: string;
  /** All-day events only. Exclusive, as Google reports it. */
  endDay?: string;
  location?: string;
  /** Present on events this app wrote. */
  toHootId?: string;
}

export interface WriteResult {
  toHootId: string;
  eventId: string;
  /** False when an existing event was updated in place. */
  created: boolean;
  /**
   * Duplicates carrying the same id that were cleaned up during this write.
   * Absent when there were none, which is every ordinary write.
   */
  duplicatesRemoved?: number;
}

export interface ListEventsOk {
  ok: true;
  action: 'listEvents';
  calendarId: string;
  events: BridgeEvent[];
  /** Present while the window has more events. The client pages until it is not. */
  nextPageToken?: string;
}

export interface WriteLogOk {
  ok: true;
  action: 'writeLog';
  calendarId: string;
  written: WriteResult[];
}

export interface DeleteLogOk {
  ok: true;
  action: 'deleteLog';
  calendarId: string;
  deleted: string[];
  /** Ids with no event behind them. Already-deleted is not an error. */
  missing: string[];
}

export interface BridgeErr {
  ok: false;
  code: BridgeErrorCode;
  error: string;
}

export type BridgeOk = ListEventsOk | WriteLogOk | DeleteLogOk;
export type BridgeResponse = BridgeOk | BridgeErr;

/** The options this file hands to `Calendar.Events.list`, and nothing more. */
export interface ListOptions {
  maxResults: number;
  /**
   * Always true. Recurring events come back as their occurrences, which is the
   * only form a timeline can draw, and `orderBy: startTime` requires it.
   */
  singleEvents: boolean;
  showDeleted: boolean;
  timeMin?: string;
  timeMax?: string;
  orderBy?: 'startTime';
  pageToken?: string;
  /** `key=value`, the only way to find an event by the id this app stamped. */
  privateExtendedProperty?: string;
}

export interface EventTimePoint {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** The subset of a Calendar v3 event resource this bridge reads or writes. */
export interface RawCalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: EventTimePoint;
  end?: EventTimePoint;
  extendedProperties?: { private?: Record<string, string> };
}

export interface EventResource {
  summary: string;
  description?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  extendedProperties: { private: Record<string, string> };
}

export interface ListPage {
  items?: RawCalendarEvent[];
  nextPageToken?: string;
}

export interface CalendarListEntry {
  id?: string;
  summary?: string;
  accessRole?: string;
}

/**
 * The Calendar advanced service, reduced to what the bridge uses. Every method
 * is a direct pass-through, so the interesting decisions (which options, which
 * lookup, insert or update) stay in this file where they are testable, and the
 * script side stays too thin to hide a bug.
 *
 * Synchronous, because Apps Script is.
 */
export interface CalendarPort {
  list(calendarId: string, opts: ListOptions): ListPage;
  insert(calendarId: string, resource: EventResource): RawCalendarEvent;
  update(calendarId: string, eventId: string, resource: EventResource): RawCalendarEvent;
  remove(calendarId: string, eventId: string): void;
  /** The dedicated log calendar, created on first use. */
  logCalendarId(): string;
}

export interface BridgeDeps {
  /** From Script Properties. Empty means the deployment is not configured yet. */
  secret: string;
  /** Undefined when the Calendar advanced service was never enabled. */
  calendar: CalendarPort | undefined;
}

export type ParseResult =
  | { ok: true; secret: string; request: BridgeRequest }
  | { ok: false; error: BridgeErr };

function fail(code: BridgeErrorCode, error: string): BridgeErr {
  return { ok: false, code, error };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS;
}

/**
 * Compares two strings without returning early on the first difference.
 *
 * JavaScript cannot promise true constant time (string comparison, the JIT and
 * the garbage collector are all outside this function's control), so the claim
 * here is narrower and still worth having: the work done does not depend on
 * WHERE the strings differ, so a caller cannot walk the secret out one
 * character at a time by timing. The length is folded into the result rather
 * than short-circuiting on it.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Epoch milliseconds, or an ISO string that carries a zone.
 *
 * An offsetless ISO string is refused rather than guessed at: `Date.parse`
 * would read it in the script's timezone, which belongs to whoever created the
 * deployment and has nothing to do with the device that sent the request.
 */
function normalizeInstant(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) && Math.abs(v) <= MAX_TIMESTAMP ? Math.round(v) : undefined;
  }
  if (typeof v === 'string' && ISO_WITH_ZONE.test(v)) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function parseEnvelope(
  raw: string | undefined,
): { ok: true; secret: string; body: Record<string, unknown> } | { ok: false; error: BridgeErr } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: fail('bad-request', 'the request had no body') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: fail('bad-request', 'the request body was not JSON') };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: fail('bad-request', 'the request body was not an object') };
  }
  const secret = parsed['secret'];
  return { ok: true, secret: typeof secret === 'string' ? secret : '', body: parsed };
}

function parseListEvents(body: Record<string, unknown>): ListEventsRequest | BridgeErr {
  const from = normalizeInstant(body['from']);
  if (from === undefined) {
    return fail('bad-request', 'from must be epoch milliseconds or an ISO string with a zone');
  }
  const days = body['days'];
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_LIST_DAYS) {
    return fail('bad-request', `days must be a whole number between 1 and ${MAX_LIST_DAYS}`);
  }
  const out: ListEventsRequest = { action: 'listEvents', from, days };

  const calendarId = body['calendarId'];
  if (calendarId !== undefined) {
    if (!isId(calendarId)) return fail('bad-request', 'calendarId must be a non-empty string');
    out.calendarId = calendarId;
  }
  const pageToken = body['pageToken'];
  if (pageToken !== undefined) {
    if (typeof pageToken !== 'string' || pageToken.length === 0) {
      return fail('bad-request', 'pageToken must be a non-empty string');
    }
    out.pageToken = pageToken;
  }
  const maxResults = body['maxResults'];
  if (maxResults !== undefined) {
    if (typeof maxResults !== 'number' || !Number.isInteger(maxResults) || maxResults < 1) {
      return fail('bad-request', 'maxResults must be a whole number of at least 1');
    }
    out.maxResults = Math.min(maxResults, MAX_PAGE_SIZE);
  }
  return out;
}

function parseWriteLog(body: Record<string, unknown>): WriteLogRequest | BridgeErr {
  const raw = body['entries'];
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('bad-request', 'entries must be a non-empty array');
  }
  if (raw.length > MAX_WRITE_ENTRIES) {
    return fail('bad-request', `entries must hold at most ${MAX_WRITE_ENTRIES} writes`);
  }
  const entries: WriteLogEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return fail('bad-request', 'every entry must be an object');
    const { toHootId, title, start, end, notes } = item;
    if (!isId(toHootId)) return fail('bad-request', 'every entry needs a toHootId');
    if (typeof title !== 'string') return fail('bad-request', 'every entry needs a title');
    if (typeof start !== 'number' || !Number.isFinite(start) || Math.abs(start) > MAX_TIMESTAMP) {
      return fail('bad-request', 'every entry needs a numeric start');
    }
    if (typeof end !== 'number' || !Number.isFinite(end) || Math.abs(end) > MAX_TIMESTAMP) {
      return fail('bad-request', 'every entry needs a numeric end');
    }
    if (end <= start) return fail('bad-request', 'every entry must end after it starts');
    if (notes !== undefined && typeof notes !== 'string') {
      return fail('bad-request', 'notes must be a string');
    }
    const entry: WriteLogEntry = { toHootId, title, start, end };
    if (notes !== undefined) entry.notes = notes;
    entries.push(entry);
  }
  return { action: 'writeLog', entries };
}

function parseDeleteLog(body: Record<string, unknown>): DeleteLogRequest | BridgeErr {
  const raw = body['toHootIds'];
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('bad-request', 'toHootIds must be a non-empty array');
  }
  if (raw.length > MAX_DELETE_IDS) {
    return fail('bad-request', `toHootIds must hold at most ${MAX_DELETE_IDS} ids`);
  }
  for (const id of raw) if (!isId(id)) return fail('bad-request', 'every toHootId must be a non-empty string');
  return { action: 'deleteLog', toHootIds: raw as string[] };
}

function parseAction(body: Record<string, unknown>): { ok: true; request: BridgeRequest } | { ok: false; error: BridgeErr } {
  const action = body['action'];
  let parsed: BridgeRequest | BridgeErr;
  if (action === 'listEvents') parsed = parseListEvents(body);
  else if (action === 'writeLog') parsed = parseWriteLog(body);
  else if (action === 'deleteLog') parsed = parseDeleteLog(body);
  else return { ok: false, error: fail('unsupported-action', `unknown action ${JSON.stringify(action ?? null)}`) };

  if ('ok' in parsed) return { ok: false, error: parsed };
  return { ok: true, request: parsed };
}

/** Parses and validates a request body. Exported so both ends can be tested against it. */
export function parseBridgeRequest(raw: string | undefined): ParseResult {
  const envelope = parseEnvelope(raw);
  if (!envelope.ok) return envelope;
  const action = parseAction(envelope.body);
  if (!action.ok) return action;
  return { ok: true, secret: envelope.secret, request: action.request };
}

export function listOptionsFor(request: ListEventsRequest): ListOptions {
  const opts: ListOptions = {
    timeMin: new Date(request.from).toISOString(),
    timeMax: new Date(request.from + request.days * DAY_MS).toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    showDeleted: false,
    maxResults: Math.min(Math.max(request.maxResults ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE),
  };
  if (request.pageToken !== undefined) opts.pageToken = request.pageToken;
  return opts;
}

/**
 * The lookup that makes write-back idempotent: no time window, because the
 * event being updated may sit anywhere, and the private property is unique.
 */
export function lookupOptionsFor(toHootId: string): ListOptions {
  return {
    privateExtendedProperty: `${TO_HOOT_ID_KEY}=${toHootId}`,
    singleEvents: true,
    showDeleted: false,
    // More than one match means a previous run half failed. The page is sized
    // to clean up a realistic pile in one pass; anything beyond it is cleaned
    // up by the next sync, since every write does this lookup again.
    maxResults: MAX_DUPLICATE_CLEANUP,
  };
}

export function logEventResource(entry: WriteLogEntry): EventResource {
  const resource: EventResource = {
    summary: entry.title.slice(0, MAX_SUMMARY_CHARS),
    start: { dateTime: new Date(entry.start).toISOString() },
    end: { dateTime: new Date(entry.end).toISOString() },
    extendedProperties: { private: { [TO_HOOT_ID_KEY]: entry.toHootId } },
  };
  if (entry.notes !== undefined && entry.notes.length > 0) {
    resource.description = entry.notes.slice(0, MAX_SUMMARY_CHARS);
  }
  return resource;
}

/** An event that came back from the API, so its id is known to be there. */
type StoredEvent = RawCalendarEvent & { id: string };

interface TimePoint {
  ms: number;
  allDay: boolean;
  day?: string;
}

function parseTimePoint(point: EventTimePoint | undefined): TimePoint | undefined {
  if (!point) return undefined;
  if (typeof point.dateTime === 'string') {
    const ms = Date.parse(point.dateTime);
    return Number.isFinite(ms) ? { ms, allDay: false } : undefined;
  }
  if (typeof point.date === 'string') {
    const m = DATE_ONLY.exec(point.date);
    if (!m) return undefined;
    return { ms: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true, day: point.date };
  }
  return undefined;
}

/** Maps one Calendar event, or undefined for one with no usable time. */
export function toBridgeEvent(raw: RawCalendarEvent, calendarId: string): BridgeEvent | undefined {
  const start = parseTimePoint(raw.start);
  const end = parseTimePoint(raw.end);
  if (!start || !end) return undefined;

  const event: BridgeEvent = {
    id: typeof raw.id === 'string' ? raw.id : '',
    calendarId,
    title: typeof raw.summary === 'string' ? raw.summary : '',
    start: start.ms,
    end: end.ms,
    allDay: start.allDay,
  };
  if (start.day !== undefined) event.startDay = start.day;
  if (end.day !== undefined) event.endDay = end.day;
  if (typeof raw.location === 'string' && raw.location.length > 0) event.location = raw.location;
  const stamped = raw.extendedProperties?.private?.[TO_HOOT_ID_KEY];
  if (typeof stamped === 'string' && stamped.length > 0) event.toHootId = stamped;
  return event;
}

/**
 * The calendar to write the log to, out of everything in the user's list.
 *
 * Only a calendar they own or can write to counts. A calendar merely subscribed
 * to under the same name is read-only, and adopting it would turn every write
 * into a permission error the user cannot see the cause of.
 */
export function pickLogCalendar(entries: CalendarListEntry[], name: string): string | undefined {
  const named = entries.filter(e => typeof e.id === 'string' && (e.summary ?? '').trim() === name);
  const owned = named.find(e => e.accessRole === 'owner') ?? named.find(e => e.accessRole === 'writer');
  return owned?.id;
}

/**
 * Every event carrying this id, not just the first.
 *
 * There should only ever be one. Two means an earlier run inserted and then
 * failed before it could be told what it had done, and the extra is an orphan:
 * once the ledger moves on, the app has no reason to look at that day again and
 * the stale event sits on the user's calendar forever. So each write cleans up
 * what it finds, which is the only place that can.
 */
function findAllByToHootId(calendar: CalendarPort, calendarId: string, toHootId: string): StoredEvent[] {
  const page = calendar.list(calendarId, lookupOptionsFor(toHootId));
  const found: StoredEvent[] = [];
  for (const item of page.items ?? []) {
    if (item.status !== 'cancelled' && typeof item.id === 'string') found.push(item as StoredEvent);
  }
  return found;
}

function handleListEvents(request: ListEventsRequest, calendar: CalendarPort): ListEventsOk {
  const calendarId = request.calendarId ?? 'primary';
  const page = calendar.list(calendarId, listOptionsFor(request));
  const events: BridgeEvent[] = [];
  for (const raw of page.items ?? []) {
    if (raw.status === 'cancelled') continue;
    const event = toBridgeEvent(raw, calendarId);
    if (event) events.push(event);
  }
  const out: ListEventsOk = { ok: true, action: 'listEvents', calendarId, events };
  if (typeof page.nextPageToken === 'string' && page.nextPageToken.length > 0) {
    out.nextPageToken = page.nextPageToken;
  }
  return out;
}

function handleWriteLog(request: WriteLogRequest, calendar: CalendarPort): WriteLogOk {
  const calendarId = calendar.logCalendarId();
  const written: WriteResult[] = [];
  for (const entry of request.entries) {
    const [existing, ...duplicates] = findAllByToHootId(calendar, calendarId, entry.toHootId);
    const resource = logEventResource(entry);
    if (existing) {
      const updated = calendar.update(calendarId, existing.id, resource);
      for (const duplicate of duplicates) calendar.remove(calendarId, duplicate.id);
      const result: WriteResult = {
        toHootId: entry.toHootId,
        eventId: updated.id ?? existing.id,
        created: false,
      };
      if (duplicates.length > 0) result.duplicatesRemoved = duplicates.length;
      written.push(result);
    } else {
      const inserted = calendar.insert(calendarId, resource);
      written.push({ toHootId: entry.toHootId, eventId: inserted.id ?? '', created: true });
    }
  }
  return { ok: true, action: 'writeLog', calendarId, written };
}

function handleDeleteLog(request: DeleteLogRequest, calendar: CalendarPort): DeleteLogOk {
  const calendarId = calendar.logCalendarId();
  const deleted: string[] = [];
  const missing: string[] = [];
  for (const toHootId of request.toHootIds) {
    const existing = findAllByToHootId(calendar, calendarId, toHootId);
    if (existing.length === 0) {
      missing.push(toHootId);
      continue;
    }
    // All of them: leaving a duplicate behind here is what makes an orphan
    // permanent, since the ledger key goes away with the delete.
    for (const event of existing) calendar.remove(calendarId, event.id);
    deleted.push(toHootId);
  }
  return { ok: true, action: 'deleteLog', calendarId, deleted, missing };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(err);
}

/**
 * The answer to a failure outside the request handler: a Script Properties read
 * that threw, or anything else in the thin Google-facing wrapper. Apps Script
 * would otherwise serve its own HTML error page, which no client can parse.
 */
export function scriptFailure(err: unknown): BridgeErr {
  return fail('script-error', messageOf(err));
}

/**
 * The whole request handler, minus the Google globals.
 *
 * Never throws and never returns anything but a JSON-serialisable object: the
 * caller's only job is to hand the body in and send the result back with HTTP
 * 200, whatever it says.
 */
export function handleBridgeRequest(raw: string | undefined, deps: BridgeDeps): BridgeResponse {
  const envelope = parseEnvelope(raw);
  if (!envelope.ok) return envelope.error;

  // Authentication first, so a caller with the wrong secret learns nothing
  // about what the script would have made of their request. An unconfigured
  // deployment (no secret in Script Properties) is closed, not open.
  if (deps.secret.length === 0 || !constantTimeEquals(deps.secret, envelope.secret)) {
    return fail('unauthorized', 'the shared secret did not match');
  }

  const action = parseAction(envelope.body);
  if (!action.ok) return action.error;

  if (!deps.calendar) {
    return fail(
      'calendar-service-disabled',
      'the Calendar advanced service is not enabled on this script: add it as "Calendar" v3 under Services',
    );
  }

  try {
    const request = action.request;
    if (request.action === 'listEvents') return handleListEvents(request, deps.calendar);
    if (request.action === 'writeLog') return handleWriteLog(request, deps.calendar);
    return handleDeleteLog(request, deps.calendar);
  } catch (err) {
    return fail('calendar-error', messageOf(err));
  }
}
