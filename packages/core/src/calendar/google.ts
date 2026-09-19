// Google Calendar over its REST API, with an OAuth token instead of a pasted
// script.
//
// The Apps Script bridge asks the user to deploy code into their own Google
// account, and `client.ts` talks to that deployment. This client makes the same
// calls the script made from the inside, straight from the app, so there is
// nothing to deploy. It has the bridge client's surface method for method: the
// UI holds either behind one variable, and the write queue and the ledger never
// learn which one they are talking to.
//
// Which calendars a merged read visits, how a write finds the event it wrote
// last time and what a log event looks like are decisions the bridge already
// made, and they are imported from `bridge.ts` rather than made again here. This
// file adds only what the script got from Google's runtime for free: the bearer
// token and its refresh, the paging, and the translation of HTTP failures into
// the bridge's error codes, so every caller keeps handling one error type.
//
// It goes through `Platform.http` like the bridge client does. The REST API
// would answer a browser fetch, but the shells route every request through
// native code, and one path is easier to reason about than two.

import type { Http, HttpMethod, HttpRequest } from '../platform.js';
import {
  LOG_CALENDAR_NAME,
  MAX_DELETE_IDS,
  MAX_LIST_DAYS,
  MAX_MERGED_EVENTS,
  MAX_MERGED_PAGES,
  MAX_WRITE_ENTRIES,
  listOptionsFor,
  logEventResource,
  lookupOptionsFor,
  pickLogCalendar,
  pickReadableCalendars,
  toBridgeEvent,
  type BridgeEvent,
  type CalendarListEntry,
  type ListEventsRequest,
  type RawCalendarEvent,
  type WriteLogEntry,
  type WriteResult,
} from './bridge.js';
import { CalendarBridgeError, type ListEventsOptions, type PartialProgress } from './client.js';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
/** Where the signed-in account's address comes from, for the settings screen. */
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * Taken off Google's `expires_in`, so a token is never presented in its last
 * minute: a request that leaves the device with a valid token and arrives with
 * an expired one costs a refresh and a retry for nothing.
 */
const EXPIRY_SLACK_MS = 60_000;
const DEFAULT_MAX_PAGES = 20;
/** 250 calendars a page. A stop, not a limit anyone reaches. */
const MAX_CALENDAR_LIST_PAGES = 20;
const CALENDAR_LIST_PAGE_SIZE = 250;
const LOG_CALENDAR_DESCRIPTION = 'Time tracked in ToHoot. Created by ToHoot; safe to hide or delete.';

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when accessToken stops working. */
  expiresAt: number;
}

export interface GoogleOAuthClient {
  clientId: string;
  /**
   * Present for a Desktop client, which Google treats as non-confidential and
   * still asks for the secret on refresh; absent for an Android client, which
   * has none.
   */
  clientSecret?: string;
}

export interface GoogleCalendarClientOptions {
  client: GoogleOAuthClient;
  tokens: GoogleTokens;
  /** Called whenever tokens are refreshed, so the caller can persist them. */
  onTokens?: (tokens: GoogleTokens) => void;
  /** The dedicated log calendar's id, when known from an earlier run. */
  logCalendarId?: string;
  /** Called when the log calendar is adopted or created, so the caller can persist it. */
  onLogCalendar?: (id: string) => void;
  now?: () => number;
}

/** What one request came back with, before anyone has looked at the status. */
interface Answer {
  status: number;
  text: string;
}

interface EventsPage {
  items: RawCalendarEvent[];
  nextPageToken?: string;
}

/** What Google says about a failure, as far as the body could be read. */
interface GoogleFailure {
  message: string | undefined;
  reasons: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** JSON, or undefined when the text is not a JSON object. Never throws. */
function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A query string from the option objects `bridge.ts` builds, so the same
 * `listOptionsFor` and `lookupOptionsFor` that the script handed to the
 * advanced service are what this client sends over the wire. Booleans and
 * numbers become their text; absent options stay absent.
 */
function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

/** Google ids contain `#` and `@`, so a path is never built by concatenation alone. */
function calendarUrl(calendarId: string): string {
  return `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}`;
}

function eventsUrl(calendarId: string): string {
  return `${calendarUrl(calendarId)}/events`;
}

function eventUrl(calendarId: string, eventId: string): string {
  return `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
}

/**
 * Google's error body: `{ error: { message, errors: [{ reason }] } }`. Both
 * halves are optional in practice, and a proxy or a load balancer can answer
 * with no JSON at all, so nothing here is trusted to be there.
 */
function googleFailure(text: string): GoogleFailure {
  const body = parseRecord(text);
  const error = body?.['error'];
  if (!isRecord(error)) {
    return { message: typeof error === 'string' ? error : undefined, reasons: [] };
  }
  const reasons: string[] = [];
  const errors = error['errors'];
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (isRecord(item) && typeof item['reason'] === 'string') reasons.push(item['reason']);
    }
  }
  return { message: typeof error['message'] === 'string' ? error['message'] : undefined, reasons };
}

/**
 * The error for a status this client did not expect. 401 never reaches here:
 * it is answered with a refresh first, and only its second occurrence is a
 * failure, which `send` reports itself.
 */
function failureFor(answer: Answer): CalendarBridgeError {
  const failure = googleFailure(answer.text);
  const message = failure.message ?? (answer.text.trim().slice(0, 200) || `HTTP ${answer.status}`);
  if (answer.status === 403) {
    // A 403 is two different things. A token without the calendar scope is a
    // sign-in problem the user fixes by signing in again; a rate limit or a
    // calendar they may not write to is not, and telling them to sign in
    // again would send them somewhere the fix is not.
    const insufficient = failure.reasons.includes('insufficientPermissions') || /insufficient/i.test(message);
    if (insufficient) {
      return new CalendarBridgeError(
        'unauthorized',
        403,
        `Google refused calendar access: ${message}. Sign in again and allow access to your calendars.`,
      );
    }
    return new CalendarBridgeError('calendar-error', 403, message);
  }
  return new CalendarBridgeError('http', answer.status, `Google Calendar answered ${answer.status}: ${message}`);
}

/**
 * Everything the public methods throw goes through here, so a caller catching
 * `CalendarBridgeError` has caught everything. A failure that already is one
 * keeps its code; anything else (a bug, a callback that threw) is reported as
 * the calendar failing, which is the one code every caller already handles.
 */
function asBridgeError(err: unknown, partial?: PartialProgress): CalendarBridgeError {
  if (err instanceof CalendarBridgeError) {
    return partial === undefined ? err : new CalendarBridgeError(err.code, err.status, err.message, partial);
  }
  return new CalendarBridgeError('calendar-error', undefined, messageOf(err), partial);
}

/**
 * True for a failure worth working around: a read that can be answered another
 * way should be. A revoked sign-in or an unreachable network is not, since the
 * other way would fail identically and cost a second round trip to say so.
 */
function recoverable(err: unknown): boolean {
  return err instanceof CalendarBridgeError && err.code !== 'unauthorized' && err.code !== 'transport';
}

/**
 * Exchanges the refresh token for a new access token.
 *
 * `invalid_grant` is Google's answer when the user revoked the app's access,
 * or when a token from a testing-mode OAuth client aged out. Either way the
 * only fix is signing in again, so it is reported the way a rejected secret
 * is, and the settings screen phrases it accordingly.
 */
export async function refreshGoogleTokens(
  http: Http,
  client: GoogleOAuthClient,
  tokens: GoogleTokens,
  now: () => number = Date.now,
): Promise<GoogleTokens> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: client.clientId,
  });
  if (client.clientSecret !== undefined) form.set('client_secret', client.clientSecret);

  let answer: Answer;
  try {
    const response = await http({
      url: GOOGLE_TOKEN_URL,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    answer = { status: response.status, text: await response.text() };
  } catch (err) {
    throw new CalendarBridgeError('transport', undefined, `Google could not be reached to refresh the sign-in: ${messageOf(err)}`);
  }

  const body = parseRecord(answer.text);
  if (answer.status < 200 || answer.status >= 300) {
    const code = body?.['error'];
    const description = body?.['error_description'];
    if (code === 'invalid_grant') {
      throw new CalendarBridgeError(
        'unauthorized',
        answer.status,
        'Google no longer accepts this sign-in: sign in to Google again',
      );
    }
    const detail = typeof description === 'string' ? description : typeof code === 'string' ? code : answer.text.slice(0, 200);
    throw new CalendarBridgeError('http', answer.status, `the Google token endpoint answered ${answer.status}: ${detail}`);
  }

  const accessToken = body?.['access_token'];
  const expiresIn = body?.['expires_in'];
  if (typeof accessToken !== 'string' || accessToken.length === 0 || typeof expiresIn !== 'number') {
    throw new CalendarBridgeError('bad-response', answer.status, 'the Google token endpoint answered without an access token');
  }
  // Google hands out a new refresh token only when it has decided to rotate
  // the old one; the usual answer has none, and the old one stays valid.
  const refreshToken = body?.['refresh_token'];
  return {
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : tokens.refreshToken,
    expiresAt: now() + expiresIn * 1000 - EXPIRY_SLACK_MS,
  };
}

export class GoogleCalendarClient {
  private readonly http: Http;
  private readonly client: GoogleOAuthClient;
  private readonly onTokens: ((tokens: GoogleTokens) => void) | undefined;
  private readonly knownLogCalendarId: string | undefined;
  private readonly onLogCalendar: ((id: string) => void) | undefined;
  private readonly now: () => number;
  private tokens: GoogleTokens;
  /** The refresh in flight, so two calls that both find the token expired share one. */
  private refreshing: Promise<void> | undefined;
  /** The log calendar once resolved, shared the same way. Cleared when resolving failed. */
  private logCalendar: Promise<string> | undefined;

  /**
   * How many calendars the last `listEvents` read, or zero before the first.
   * See `CalendarBridgeClient.calendarsRead` for why it is read off the client
   * rather than returned with the events.
   */
  calendarsRead = 0;

  constructor(http: Http, options: GoogleCalendarClientOptions) {
    this.http = http;
    this.client = options.client;
    this.tokens = { ...options.tokens };
    this.onTokens = options.onTokens;
    this.knownLogCalendarId = options.logCalendarId;
    this.onLogCalendar = options.onLogCalendar;
    this.now = options.now ?? Date.now;
  }

  /**
   * Every event in the window. With a calendar named, that calendar alone,
   * paged until Google stops handing out tokens; without one, everything the
   * account can see, merged into one list in clock order the way the bridge
   * does it.
   */
  async listEvents(options: ListEventsOptions): Promise<BridgeEvent[]> {
    // Checked before any request, as the bridge client does: a bad window is a
    // caller bug, and finding out should not cost a round trip.
    if (!Number.isFinite(options.from)) {
      throw new CalendarBridgeError('bad-request', undefined, 'listEvents needs a finite `from` in epoch milliseconds');
    }
    if (!Number.isInteger(options.days) || options.days < 1 || options.days > MAX_LIST_DAYS) {
      throw new CalendarBridgeError(
        'bad-request',
        undefined,
        `listEvents needs a whole number of days between 1 and ${MAX_LIST_DAYS}, not ${options.days}`,
      );
    }
    if (options.calendarId !== undefined && options.calendarId.length === 0) {
      throw new CalendarBridgeError('bad-request', undefined, 'listEvents needs a non-empty calendarId, or none');
    }
    const request: ListEventsRequest = { action: 'listEvents', from: options.from, days: options.days };
    const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);

    return this.guarded(async () => {
      if (options.calendarId !== undefined) return this.listOneCalendar(request, options.calendarId, maxPages);
      const calendarIds = await this.readableCalendars();
      // No list means no way to tell what else exists. The signed-in account's
      // own calendar is the one there is always an answer for.
      if (calendarIds.length === 0) return this.listOneCalendar(request, 'primary', maxPages);
      return this.listWholeAccount(request, calendarIds);
    });
  }

  /**
   * Writes the given blocks to the log calendar. Each entry is its own lookup
   * and insert or update, so a failure keeps every entry that landed before it,
   * not only the earlier batches: the ledger advances for exactly those.
   */
  async writeLog(entries: readonly WriteLogEntry[]): Promise<WriteResult[]> {
    const written: WriteResult[] = [];
    return this.guarded(async () => {
      for (const batch of chunk(entries, MAX_WRITE_ENTRIES)) {
        try {
          const calendarId = await this.logCalendarId();
          for (const entry of batch) written.push(await this.writeOne(calendarId, entry));
        } catch (err) {
          throw asBridgeError(err, { written });
        }
      }
      return written;
    });
  }

  /** Removes blocks by their `toHootId`. Ids with no event are reported, not thrown. */
  async deleteLog(toHootIds: readonly string[]): Promise<{ deleted: string[]; missing: string[] }> {
    const deleted: string[] = [];
    const missing: string[] = [];
    return this.guarded(async () => {
      for (const batch of chunk(toHootIds, MAX_DELETE_IDS)) {
        try {
          const calendarId = await this.logCalendarId();
          for (const toHootId of batch) {
            const existing = await this.findAllByToHootId(calendarId, toHootId);
            if (existing.length === 0) {
              missing.push(toHootId);
              continue;
            }
            // All of them: leaving a duplicate behind here is what makes an
            // orphan permanent, since the ledger key goes away with the delete.
            for (const event of existing) await this.removeEvent(calendarId, event.id);
            deleted.push(toHootId);
          }
        } catch (err) {
          throw asBridgeError(err, { deleted, missing });
        }
      }
      return { deleted, missing };
    });
  }

  /**
   * The log calendar, adopted or created. Resolved once per instance: a write
   * does not re-scan the calendar list every time, and two writes that start
   * together do not create two calendars.
   */
  logCalendarId(): Promise<string> {
    this.logCalendar ??= this.guarded(() => this.resolveLogCalendar()).catch((err: unknown) => {
      // A failed resolution is not cached, so the next write tries again.
      this.logCalendar = undefined;
      throw err;
    });
    return this.logCalendar;
  }

  /** The signed-in account's address, for the settings screen. */
  async email(): Promise<string> {
    return this.guarded(async () => {
      const body = await this.json('GET', GOOGLE_USERINFO_URL);
      const email = body['email'];
      if (typeof email !== 'string' || email.length === 0) {
        throw new CalendarBridgeError('bad-response', undefined, 'Google answered the account lookup without an email');
      }
      return email;
    });
  }

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      throw asBridgeError(err);
    }
  }

  private async listOneCalendar(request: ListEventsRequest, calendarId: string, maxPages: number): Promise<BridgeEvent[]> {
    this.calendarsRead = 1;
    const events: BridgeEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const answer = await this.eventsPage(calendarId, pageToken === undefined ? request : { ...request, pageToken });
      collectPage(answer, calendarId, events);
      pageToken = answer.nextPageToken;
      if (pageToken === undefined) return events;
    }
    throw new CalendarBridgeError(
      'too-many-pages',
      undefined,
      `Google Calendar was still paging after ${maxPages} requests`,
    );
  }

  /**
   * The whole account's day, in one answer, with the bridge's caps: a page
   * token belongs to one calendar, so the paging happens here per calendar,
   * and the window a timeline asks for is a day, so the caps are a stop rather
   * than a limit anyone reaches.
   */
  private async listWholeAccount(request: ListEventsRequest, calendarIds: readonly string[]): Promise<BridgeEvent[]> {
    const events: BridgeEvent[] = [];
    let visited = 0;
    for (const calendarId of calendarIds) {
      visited++;
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_MERGED_PAGES; page++) {
        const answer = await this.eventsPage(calendarId, pageToken === undefined ? request : { ...request, pageToken });
        collectPage(answer, calendarId, events);
        pageToken = answer.nextPageToken;
        if (pageToken === undefined) break;
      }
      if (events.length >= MAX_MERGED_EVENTS) break;
    }
    // One list in clock order: which calendar an hour came from is a colour,
    // not an ordering, and a caller drawing a day should not have to interleave.
    events.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.calendarsRead = visited;
    return events.slice(0, MAX_MERGED_EVENTS);
  }

  /** The calendars a merged read visits, or none when the list cannot be read. */
  private async readableCalendars(): Promise<string[]> {
    let entries: CalendarListEntry[];
    try {
      entries = await this.calendarList('freeBusyReader');
    } catch (err) {
      // Some Workspace configurations refuse the list. One calendar beats an
      // error the reader cannot act on, unless the error would repeat itself
      // on that one calendar too.
      if (!recoverable(err)) throw err;
      return [];
    }
    return pickReadableCalendars(entries, LOG_CALENDAR_NAME);
  }

  /**
   * The account's calendar list at the given access level, every page of it.
   * `showHidden` is on so the list carries every entry; which to read or
   * adopt is decided by the bridge's helpers.
   */
  private async calendarList(minAccessRole: 'freeBusyReader' | 'writer'): Promise<CalendarListEntry[]> {
    const out: CalendarListEntry[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_CALENDAR_LIST_PAGES; page++) {
      const params = { minAccessRole, showHidden: true, maxResults: CALENDAR_LIST_PAGE_SIZE, pageToken };
      const body = await this.json('GET', `${GOOGLE_CALENDAR_API}/users/me/calendarList?${query(params)}`);
      const items = body['items'];
      if (items !== undefined && !Array.isArray(items)) {
        throw new CalendarBridgeError('bad-response', undefined, 'Google answered the calendar list with something else');
      }
      for (const item of items ?? []) if (isRecord(item)) out.push(item as CalendarListEntry);
      pageToken = tokenOf(body['nextPageToken']);
      if (pageToken === undefined) break;
    }
    return out;
  }

  private async eventsPage(calendarId: string, request: ListEventsRequest): Promise<EventsPage> {
    return this.readEvents(calendarId, query(listOptionsFor(request)));
  }

  private async readEvents(calendarId: string, search: string): Promise<EventsPage> {
    const body = await this.json('GET', `${eventsUrl(calendarId)}?${search}`);
    const items = body['items'];
    if (items !== undefined && !Array.isArray(items)) {
      throw new CalendarBridgeError('bad-response', undefined, 'Google answered the event list with something else');
    }
    const page: EventsPage = { items: (items ?? []).filter(isRecord) as RawCalendarEvent[] };
    const nextPageToken = tokenOf(body['nextPageToken']);
    if (nextPageToken !== undefined) page.nextPageToken = nextPageToken;
    return page;
  }

  /** Every event carrying this id. See `bridge.ts` for why it is all of them. */
  private async findAllByToHootId(calendarId: string, toHootId: string): Promise<(RawCalendarEvent & { id: string })[]> {
    const page = await this.readEvents(calendarId, query(lookupOptionsFor(toHootId)));
    return page.items.filter(
      (item): item is RawCalendarEvent & { id: string } => item.status !== 'cancelled' && typeof item.id === 'string',
    );
  }

  private async writeOne(calendarId: string, entry: WriteLogEntry): Promise<WriteResult> {
    const [existing, ...duplicates] = await this.findAllByToHootId(calendarId, entry.toHootId);
    const resource = logEventResource(entry);
    if (existing) {
      const updated = await this.json('PUT', eventUrl(calendarId, existing.id), resource);
      for (const duplicate of duplicates) await this.removeEvent(calendarId, duplicate.id);
      const result: WriteResult = {
        toHootId: entry.toHootId,
        eventId: typeof updated['id'] === 'string' ? updated['id'] : existing.id,
        created: false,
      };
      if (duplicates.length > 0) result.duplicatesRemoved = duplicates.length;
      return result;
    }
    const inserted = await this.json('POST', eventsUrl(calendarId), resource);
    return { toHootId: entry.toHootId, eventId: typeof inserted['id'] === 'string' ? inserted['id'] : '', created: true };
  }

  /**
   * An event that is already gone counts as removed: the point of the call is
   * that it is not on the calendar afterwards, and it is not.
   */
  private async removeEvent(calendarId: string, eventId: string): Promise<void> {
    await this.send('DELETE', eventUrl(calendarId, eventId), undefined, [404, 410]);
  }

  /**
   * The cached id is checked before it is trusted: a user who deleted the
   * calendar would otherwise get "Not Found" on every write forever. Adopting
   * by name comes next, so a reinstall finds the calendar the last install
   * made, and creating it is the last resort.
   */
  private async resolveLogCalendar(): Promise<string> {
    const known = this.knownLogCalendarId;
    if (known !== undefined && known.length > 0 && (await this.calendarExists(known))) return known;

    const adopted = pickLogCalendar(await this.calendarList('writer'), LOG_CALENDAR_NAME);
    if (adopted !== undefined) {
      this.onLogCalendar?.(adopted);
      return adopted;
    }

    const created = await this.json('POST', `${GOOGLE_CALENDAR_API}/calendars`, {
      summary: LOG_CALENDAR_NAME,
      description: LOG_CALENDAR_DESCRIPTION,
      timeZone: await this.calendarTimeZone(),
    });
    const id = created['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new CalendarBridgeError('bad-response', undefined, 'Google created the log calendar but returned no id');
    }
    this.onLogCalendar?.(id);
    return id;
  }

  private async calendarExists(calendarId: string): Promise<boolean> {
    try {
      const body = await this.json('GET', calendarUrl(calendarId));
      return typeof body['id'] === 'string';
    } catch (err) {
      if (!recoverable(err)) throw err;
      return false;
    }
  }

  /**
   * The timezone of the user's calendar, which only labels the log calendar,
   * so an unreadable setting falls back to the device's rather than failing
   * the write.
   */
  private async calendarTimeZone(): Promise<string> {
    try {
      const body = await this.json('GET', `${GOOGLE_CALENDAR_API}/users/me/settings/timezone`);
      const value = body['value'];
      if (typeof value === 'string' && value.length > 0) return value;
    } catch (err) {
      if (!recoverable(err)) throw err;
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** A request whose answer has to be a JSON object. */
  private async json(method: HttpMethod, url: string, body?: unknown): Promise<Record<string, unknown>> {
    const answer = await this.send(method, url, body);
    const parsed = parseRecord(answer.text);
    if (parsed === undefined) {
      throw new CalendarBridgeError('bad-response', answer.status, 'Google answered with something that is not a JSON object');
    }
    return parsed;
  }

  /**
   * One authorised request. The token is refreshed before the call when it
   * has expired, and once more after a 401, since Google can retire a token
   * early (a password change does it). A second 401 means the sign-in itself
   * is gone.
   */
  private async send(method: HttpMethod, url: string, body: unknown, allow: readonly number[] = []): Promise<Answer> {
    if (this.now() >= this.tokens.expiresAt) await this.refresh();
    let answer = await this.transmit(method, url, body);
    if (answer.status === 401) {
      await this.refresh();
      answer = await this.transmit(method, url, body);
      if (answer.status === 401) {
        throw new CalendarBridgeError(
          'unauthorized',
          401,
          'Google rejected the sign-in even after refreshing it: sign in to Google again',
        );
      }
    }
    if ((answer.status >= 200 && answer.status < 300) || allow.includes(answer.status)) return answer;
    throw failureFor(answer);
  }

  private async transmit(method: HttpMethod, url: string, body: unknown): Promise<Answer> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.tokens.accessToken}`,
      accept: 'application/json',
    };
    const req: HttpRequest = { url, method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      req.body = JSON.stringify(body);
    }
    try {
      const response = await this.http(req);
      return { status: response.status, text: await response.text() };
    } catch (err) {
      throw new CalendarBridgeError('transport', undefined, `Google Calendar could not be reached: ${messageOf(err)}`);
    }
  }

  private refresh(): Promise<void> {
    this.refreshing ??= refreshGoogleTokens(this.http, this.client, this.tokens, this.now)
      .then(tokens => {
        this.tokens = tokens;
        this.onTokens?.(tokens);
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
}

function tokenOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function collectPage(page: EventsPage, calendarId: string, into: BridgeEvent[]): void {
  for (const raw of page.items) {
    if (raw.status === 'cancelled') continue;
    const event = toBridgeEvent(raw, calendarId);
    if (event) into.push(event);
  }
}
