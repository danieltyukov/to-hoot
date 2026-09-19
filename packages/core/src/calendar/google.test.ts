import { describe, expect, it } from 'vitest';
import type { Http, HttpRequest, HttpResponse } from '../platform.js';
import { MAX_DELETE_IDS, MAX_WRITE_ENTRIES, type RawCalendarEvent } from './bridge.js';
import { CalendarBridgeError } from './client.js';
import {
  GOOGLE_TOKEN_URL,
  GoogleCalendarClient,
  refreshGoogleTokens,
  type GoogleCalendarClientOptions,
  type GoogleTokens,
} from './google.js';

const NOW = Date.parse('2026-08-24T12:00:00Z');
const CLIENT = { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'client-secret' };
const LOG_ID = 'log-calendar-id@group.calendar.google.com';

const API = '/calendar/v3';
const CALENDAR_LIST = `${API}/users/me/calendarList`;
const TOKEN_PATH = new URL(GOOGLE_TOKEN_URL).pathname;
const calendarPath = (id: string) => `${API}/calendars/${encodeURIComponent(id)}`;
const eventsPath = (id: string) => `${calendarPath(id)}/events`;

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** The JSON body, or the raw text when it is not JSON (the token form). */
  body: any;
}

interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
}

type Responder = Reply | ((call: Call) => Reply);

interface Route {
  method: string;
  path: string | RegExp;
  responder: Responder;
  once: boolean;
}

/**
 * A stand-in for Google, routed by method and path rather than scripted in
 * order: one client call is many requests, and a test that had to predict
 * their exact sequence would be testing the implementation and not the
 * behaviour. `once` routes answer a single time and are consulted first, which
 * is how a page token or a 401 is scripted in front of a standing answer.
 */
class FakeGoogle {
  readonly calls: Call[] = [];
  private readonly routes: Route[] = [];
  private failure: Error | undefined;

  on(method: string, path: string | RegExp, responder: Responder): this {
    this.routes.push({ method, path, responder, once: false });
    return this;
  }

  once(method: string, path: string | RegExp, responder: Responder): this {
    this.routes.push({ method, path, responder, once: true });
    return this;
  }

  failWith(err: Error): this {
    this.failure = err;
    return this;
  }

  /** Every call to the API, leaving out the token endpoint. */
  apiCalls(): Call[] {
    return this.calls.filter(c => c.url.pathname !== TOKEN_PATH);
  }

  readonly http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const call: Call = { method: req.method ?? 'GET', url, headers: req.headers ?? {}, body: parseBody(req.body) };
    this.calls.push(call);
    if (this.failure) throw this.failure;

    const matches = (r: Route) =>
      r.method === call.method && (typeof r.path === 'string' ? r.path === url.pathname : r.path.test(url.pathname));
    const index = this.routes.findIndex(r => r.once && matches(r));
    const route = index >= 0 ? this.routes.splice(index, 1)[0] : this.routes.find(r => !r.once && matches(r));
    if (!route) throw new Error(`no route for ${call.method} ${url.pathname}`);

    const reply = typeof route.responder === 'function' ? route.responder(call) : route.responder;
    const status = reply.status ?? (call.method === 'DELETE' ? 204 : 200);
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return { status, headers: {}, text: async () => text };
  };
}

function parseBody(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function tokens(over: Partial<GoogleTokens> = {}): GoogleTokens {
  return { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: NOW + 3_600_000, ...over };
}

function clientFor(fake: FakeGoogle, over: Partial<GoogleCalendarClientOptions> = {}): GoogleCalendarClient {
  return new GoogleCalendarClient(fake.http, { client: CLIENT, tokens: tokens(), now: () => NOW, ...over });
}

const timed = (id: string, hour: number): RawCalendarEvent => ({
  id,
  summary: id,
  start: { dateTime: `2026-08-24T${String(hour).padStart(2, '0')}:00:00Z` },
  end: { dateTime: `2026-08-24T${String(hour + 1).padStart(2, '0')}:00:00Z` },
});

const DAY = { from: Date.parse('2026-08-24T00:00:00Z'), days: 1 };

/** The list read a merged read starts with. */
function accountWith(fake: FakeGoogle, items: unknown[]): void {
  fake.on('GET', CALENDAR_LIST, { body: { items } });
}

/** A log calendar the client already knows, and Google confirms. */
function knownLog(fake: FakeGoogle): Partial<GoogleCalendarClientOptions> {
  fake.on('GET', calendarPath(LOG_ID), { body: { id: LOG_ID, summary: 'to-hoot log' } });
  return { logCalendarId: LOG_ID };
}

const rateLimited: Reply = {
  status: 403,
  body: { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } },
};

/**
 * An in-memory log calendar with enough of Google's behaviour that the
 * idempotency tests mean something: the private-property filter really
 * filters, ids are handed out on insert, and update and delete are recorded.
 */
class LogStore {
  readonly events = new Map<string, RawCalendarEvent>();
  readonly updated: string[] = [];
  readonly removed: string[] = [];
  /** Inserts from this count on are refused, to script a failure part way. */
  failInsertsFrom = Number.POSITIVE_INFINITY;
  /** Deleting this event id is refused. */
  failRemoveOf: string | undefined;
  /** Deleting this event id answers 410, as Google does for an event already gone. */
  goneAlready: string | undefined;
  private inserted = 0;
  private next = 1;

  constructor(fake: FakeGoogle, calendarId = LOG_ID) {
    const base = eventsPath(calendarId);
    const oneEvent = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)$`);
    const eventIdOf = (call: Call) => decodeURIComponent(call.url.pathname.slice(base.length + 1));

    fake.on('GET', base, call => {
      const filter = call.url.searchParams.get('privateExtendedProperty') ?? '';
      const at = filter.indexOf('=');
      const key = filter.slice(0, at);
      const value = filter.slice(at + 1);
      const items = [...this.events.values()].filter(e => e.extendedProperties?.private?.[key] === value);
      return { body: { items } };
    });
    fake.on('POST', base, call => {
      if (this.inserted++ >= this.failInsertsFrom) return rateLimited;
      const id = `ev-${this.next++}`;
      const stored: RawCalendarEvent = { ...(call.body as RawCalendarEvent), id };
      this.events.set(id, stored);
      return { body: stored };
    });
    fake.on('PUT', oneEvent, call => {
      const id = eventIdOf(call);
      this.updated.push(id);
      const stored: RawCalendarEvent = { ...(call.body as RawCalendarEvent), id };
      this.events.set(id, stored);
      return { body: stored };
    });
    fake.on('DELETE', oneEvent, call => {
      const id = eventIdOf(call);
      if (id === this.failRemoveOf) return rateLimited;
      this.removed.push(id);
      this.events.delete(id);
      return id === this.goneAlready ? { status: 410, body: { error: { message: 'Resource has been deleted' } } } : {};
    });
  }

  seed(id: string, toHootId: string, summary: string): void {
    this.events.set(id, {
      id,
      summary,
      start: { dateTime: '2026-08-23T09:00:00Z' },
      end: { dateTime: '2026-08-23T10:00:00Z' },
      extendedProperties: { private: { toHootId } },
    });
  }
}

async function failureOf(work: Promise<unknown>): Promise<CalendarBridgeError> {
  const err = await work.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CalendarBridgeError);
  return err as CalendarBridgeError;
}

describe('GoogleCalendarClient listEvents', () => {
  it('reads every calendar the account can see, pages each, and drops cancelled events', async () => {
    const fake = new FakeGoogle();
    accountWith(fake, [
      { id: 'primary', summary: 'Main', accessRole: 'owner', primary: true },
      { id: 'work@example.com', summary: 'Work', accessRole: 'reader' },
    ]);
    fake.once('GET', eventsPath('primary'), { body: { items: [timed('mine', 9)], nextPageToken: 'p2' } });
    fake.once('GET', eventsPath('primary'), {
      body: { items: [timed('later', 11), { ...timed('gone', 12), status: 'cancelled' }] },
    });
    fake.on('GET', eventsPath('work@example.com'), { body: { items: [timed('theirs', 8)] } });

    const client = clientFor(fake);
    const events = await client.listEvents(DAY);

    // Merged into clock order, whichever calendar an hour came from.
    expect(events.map(e => e.id)).toEqual(['theirs', 'mine', 'later']);
    expect(events.map(e => e.calendarId)).toEqual(['work@example.com', 'primary', 'primary']);
    expect(client.calendarsRead).toBe(2);

    const list = fake.calls[0]!;
    expect(list.url.pathname).toBe(CALENDAR_LIST);
    expect(list.url.searchParams.get('minAccessRole')).toBe('freeBusyReader');
    expect(list.url.searchParams.get('showHidden')).toBe('true');
    expect(list.url.searchParams.get('maxResults')).toBe('250');

    const pages = fake.calls.filter(c => c.url.pathname === eventsPath('primary'));
    expect(pages.map(c => c.url.searchParams.get('pageToken'))).toEqual([null, 'p2']);
    for (const page of pages) {
      expect(page.url.searchParams.get('singleEvents')).toBe('true');
      expect(page.url.searchParams.get('orderBy')).toBe('startTime');
      expect(page.url.searchParams.get('showDeleted')).toBe('false');
      expect(page.url.searchParams.get('timeMin')).toBe(new Date(DAY.from).toISOString());
      expect(page.url.searchParams.get('timeMax')).toBe(new Date(DAY.from + 86_400_000).toISOString());
    }
  });

  it('reads one calendar and drives the page token itself when the caller names one', async () => {
    const fake = new FakeGoogle();
    fake.once('GET', eventsPath('team@example.com'), { body: { items: [timed('a', 9)], nextPageToken: 'p2' } });
    fake.once('GET', eventsPath('team@example.com'), { body: { items: [timed('b', 10)], nextPageToken: 'p3' } });
    fake.once('GET', eventsPath('team@example.com'), { body: { items: [timed('c', 11)] } });

    const client = clientFor(fake);
    const events = await client.listEvents({ ...DAY, calendarId: 'team@example.com' });

    expect(events.map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(client.calendarsRead).toBe(1);
    expect(fake.calls.map(c => c.url.pathname)).toEqual(Array(3).fill(eventsPath('team@example.com')));
    expect(fake.calls.map(c => c.url.searchParams.get('pageToken'))).toEqual([null, 'p2', 'p3']);
  });

  it('leaves out its own log calendar, which the tracked lane already draws', async () => {
    const fake = new FakeGoogle();
    accountWith(fake, [
      { id: 'primary', accessRole: 'owner', primary: true },
      { id: LOG_ID, summary: 'to-hoot log', accessRole: 'owner' },
    ]);
    fake.on('GET', eventsPath('primary'), { body: { items: [timed('real', 9)] } });
    fake.on('GET', eventsPath(LOG_ID), { body: { items: [timed('ours', 10)] } });

    const client = clientFor(fake);
    expect((await client.listEvents(DAY)).map(e => e.id)).toEqual(['real']);
    expect(client.calendarsRead).toBe(1);
    expect(fake.calls.some(c => c.url.pathname === eventsPath(LOG_ID))).toBe(false);
  });

  it('reads the primary calendar alone when the list is empty or refused', async () => {
    const empty = new FakeGoogle();
    accountWith(empty, []);
    empty.on('GET', eventsPath('primary'), { body: { items: [timed('mine', 9)] } });
    const client = clientFor(empty);
    expect((await client.listEvents(DAY)).map(e => e.id)).toEqual(['mine']);
    expect(client.calendarsRead).toBe(1);

    // Some Workspace configurations refuse the list. A day from one calendar
    // beats an error the reader cannot act on.
    const refused = new FakeGoogle();
    refused.on('GET', CALENDAR_LIST, rateLimited);
    refused.on('GET', eventsPath('primary'), { body: { items: [timed('mine', 9)] } });
    expect((await clientFor(refused).listEvents(DAY)).map(e => e.id)).toEqual(['mine']);
  });

  it('stops rather than looping forever on a calendar that always returns a token', async () => {
    const fake = new FakeGoogle();
    fake.on('GET', eventsPath('primary'), { body: { items: [], nextPageToken: 'again' } });
    const err = await failureOf(clientFor(fake).listEvents({ ...DAY, calendarId: 'primary', maxPages: 3 }));
    expect(err.code).toBe('too-many-pages');
    expect(fake.calls).toHaveLength(3);
  });

  it('refuses a bad window without a round trip', async () => {
    const fake = new FakeGoogle();
    const client = clientFor(fake);
    for (const days of [0, -1, 1.5, 63]) {
      await expect(client.listEvents({ from: 0, days })).rejects.toMatchObject({ code: 'bad-request' });
    }
    await expect(client.listEvents({ from: Number.NaN, days: 1 })).rejects.toMatchObject({ code: 'bad-request' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('GoogleCalendarClient log calendar', () => {
  it('trusts a known id only after checking the calendar still exists', async () => {
    const fake = new FakeGoogle();
    const adopted: string[] = [];
    const client = clientFor(fake, { ...knownLog(fake), onLogCalendar: id => adopted.push(id) });
    await expect(client.logCalendarId()).resolves.toBe(LOG_ID);
    expect(fake.calls.map(c => c.url.pathname)).toEqual([calendarPath(LOG_ID)]);
    // Nothing was adopted or created, so there is nothing new to persist.
    expect(adopted).toEqual([]);
  });

  it('adopts a calendar by name when the known one is gone, ignoring one it only subscribes to', async () => {
    const fake = new FakeGoogle();
    fake.on('GET', calendarPath('stale-id'), { status: 404, body: { error: { message: 'Not Found' } } });
    fake.on('GET', CALENDAR_LIST, call => {
      expect(call.url.searchParams.get('minAccessRole')).toBe('writer');
      return {
        body: {
          items: [
            { id: 'theirs', summary: 'to-hoot log', accessRole: 'reader' },
            { id: 'mine', summary: 'to-hoot log', accessRole: 'owner' },
          ],
        },
      };
    });
    const adopted: string[] = [];
    const client = clientFor(fake, { logCalendarId: 'stale-id', onLogCalendar: id => adopted.push(id) });
    await expect(client.logCalendarId()).resolves.toBe('mine');
    expect(adopted).toEqual(['mine']);
  });

  it('creates the calendar in the account timezone when there is nothing to adopt', async () => {
    const fake = new FakeGoogle();
    accountWith(fake, [{ id: 'primary', summary: 'Main', accessRole: 'owner', primary: true }]);
    fake.on('GET', `${API}/users/me/settings/timezone`, { body: { kind: 'calendar#setting', id: 'timezone', value: 'Europe/Amsterdam' } });
    fake.on('POST', `${API}/calendars`, call => ({ body: { ...call.body, id: 'created-id' } }));

    const adopted: string[] = [];
    const client = clientFor(fake, { onLogCalendar: id => adopted.push(id) });
    await expect(client.logCalendarId()).resolves.toBe('created-id');
    expect(adopted).toEqual(['created-id']);

    const created = fake.calls.find(c => c.method === 'POST')!;
    expect(created.body).toEqual({
      summary: 'to-hoot log',
      description: 'Time tracked in ToHoot. Created by ToHoot; safe to hide or delete.',
      timeZone: 'Europe/Amsterdam',
    });
    expect(created.headers['content-type']).toBe('application/json');

    // Resolved once per instance: a second ask makes no request.
    const before = fake.calls.length;
    await expect(client.logCalendarId()).resolves.toBe('created-id');
    expect(fake.calls).toHaveLength(before);
  });

  it('falls back to the device timezone when the settings read is refused', async () => {
    const fake = new FakeGoogle();
    accountWith(fake, []);
    fake.on('GET', `${API}/users/me/settings/timezone`, rateLimited);
    fake.on('POST', `${API}/calendars`, call => ({ body: { ...call.body, id: 'created-id' } }));
    await clientFor(fake).logCalendarId();
    const created = fake.calls.find(c => c.method === 'POST')!;
    expect(created.body.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('does not cache a failed resolution, so the next write tries again', async () => {
    const fake = new FakeGoogle();
    fake.once('GET', CALENDAR_LIST, rateLimited);
    fake.on('GET', CALENDAR_LIST, { body: { items: [{ id: 'mine', summary: 'to-hoot log', accessRole: 'owner' }] } });
    const client = clientFor(fake);
    await expect(client.logCalendarId()).rejects.toMatchObject({ code: 'calendar-error' });
    await expect(client.logCalendarId()).resolves.toBe('mine');
  });
});

describe('GoogleCalendarClient writeLog', () => {
  const entry = (n: number) => ({ toHootId: `t${n}::2026-08-23`, title: `task ${n}`, start: 1_755_936_000_000, end: 1_755_939_600_000 });

  it('looks the id up and inserts when nothing carries it', async () => {
    const fake = new FakeGoogle();
    const store = new LogStore(fake);
    const client = clientFor(fake, knownLog(fake));

    const written = await client.writeLog([entry(1)]);
    expect(written).toEqual([{ toHootId: 't1::2026-08-23', eventId: 'ev-1', created: true }]);

    const lookup = fake.calls.find(c => c.method === 'GET' && c.url.pathname === eventsPath(LOG_ID))!;
    expect(lookup.url.search).toContain('privateExtendedProperty=toHootId%3Dt1%3A%3A2026-08-23');
    expect(lookup.url.searchParams.get('singleEvents')).toBe('true');
    expect(lookup.url.searchParams.get('showDeleted')).toBe('false');
    expect(lookup.url.searchParams.get('maxResults')).toBe('25');

    const stored = store.events.get('ev-1')!;
    expect(stored.summary).toBe('task 1');
    expect(stored.start?.dateTime).toBe(new Date(1_755_936_000_000).toISOString());
    expect(stored.extendedProperties?.private?.['toHootId']).toBe('t1::2026-08-23');
  });

  it('updates the first match in place and removes the duplicates a half-failed run left', async () => {
    const fake = new FakeGoogle();
    const store = new LogStore(fake);
    store.seed('dup-1', 't1::2026-08-23', 'old one');
    store.seed('dup-2', 't1::2026-08-23', 'old two');
    store.seed('dup-3', 't1::2026-08-23', 'old three');
    const client = clientFor(fake, knownLog(fake));

    const written = await client.writeLog([entry(1)]);
    expect(written).toEqual([{ toHootId: 't1::2026-08-23', eventId: 'dup-1', created: false, duplicatesRemoved: 2 }]);
    expect(store.updated).toEqual(['dup-1']);
    expect(store.removed).toEqual(['dup-2', 'dup-3']);
    expect([...store.events.values()].map(e => e.summary)).toEqual(['task 1']);
    expect(fake.calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('is idempotent: replaying the same batch leaves one event', async () => {
    const fake = new FakeGoogle();
    const store = new LogStore(fake);
    const client = clientFor(fake, knownLog(fake));
    await client.writeLog([entry(1)]);
    await client.writeLog([entry(1)]);
    await client.writeLog([entry(1)]);
    expect(store.events.size).toBe(1);
  });

  it('keeps what landed when a later batch fails', async () => {
    // The ledger only advances for writes that landed. Throwing away the first
    // batch's results means writing those blocks again on the next sync.
    const fake = new FakeGoogle();
    const store = new LogStore(fake);
    store.failInsertsFrom = MAX_WRITE_ENTRIES;
    const client = clientFor(fake, knownLog(fake));

    const entries = Array.from({ length: MAX_WRITE_ENTRIES + 1 }, (_, i) => entry(i));
    const err = await failureOf(client.writeLog(entries));
    expect(err.code).toBe('calendar-error');
    expect(err.message).toContain('Rate Limit Exceeded');
    expect(err.partial?.written).toHaveLength(MAX_WRITE_ENTRIES);
    expect(err.partial?.written?.map(w => w.toHootId)).toEqual(entries.slice(0, MAX_WRITE_ENTRIES).map(e => e.toHootId));
  });

  it('makes no request at all for an empty batch', async () => {
    const fake = new FakeGoogle();
    const client = clientFor(fake);
    await expect(client.writeLog([])).resolves.toEqual([]);
    await expect(client.deleteLog([])).resolves.toEqual({ deleted: [], missing: [] });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('GoogleCalendarClient deleteLog', () => {
  it('removes every event carrying an id and names the ids it could not find', async () => {
    const fake = new FakeGoogle();
    const store = new LogStore(fake);
    store.seed('dup-1', 't1::2026-08-23', 'one');
    store.seed('dup-2', 't1::2026-08-23', 'two');
    store.seed('ev-9', 't9::2026-08-23', 'nine');
    store.goneAlready = 'ev-9';
    const client = clientFor(fake, knownLog(fake));

    const result = await client.deleteLog(['t1::2026-08-23', 't5::2026-08-23', 't9::2026-08-23']);
    // The id is reported once however many events carried it, and an event
    // Google says is already gone still counts: it is not on the calendar.
    expect(result).toEqual({ deleted: ['t1::2026-08-23', 't9::2026-08-23'], missing: ['t5::2026-08-23'] });
    expect(store.removed).toEqual(['dup-1', 'dup-2', 'ev-9']);
    expect(store.events.size).toBe(0);
  });

  it('keeps what an earlier batch did when a later one fails', async () => {
    const fake = new FakeGoogle();
    const store = new LogStore(fake);
    const ids = Array.from({ length: MAX_DELETE_IDS + 1 }, (_, i) => `t${i}::2026-08-23`);
    store.seed('ev-first', ids[0]!, 'first');
    store.seed('ev-last', ids[MAX_DELETE_IDS]!, 'last');
    store.failRemoveOf = 'ev-last';
    const client = clientFor(fake, knownLog(fake));

    const err = await failureOf(client.deleteLog(ids));
    expect(err.code).toBe('calendar-error');
    expect(err.partial?.deleted).toEqual([ids[0]]);
    expect(err.partial?.missing).toEqual(ids.slice(1, MAX_DELETE_IDS));
  });
});

describe('GoogleCalendarClient tokens', () => {
  const refreshed = { access_token: 'access-2', expires_in: 3599, token_type: 'Bearer' };

  it('refreshes before a call once the token has expired, and persists the result', async () => {
    const fake = new FakeGoogle();
    fake.on('POST', TOKEN_PATH, { body: refreshed });
    fake.on('GET', eventsPath('primary'), { body: { items: [] } });
    const persisted: GoogleTokens[] = [];
    const client = clientFor(fake, { tokens: tokens({ expiresAt: NOW }), onTokens: t => persisted.push(t) });

    await client.listEvents({ ...DAY, calendarId: 'primary' });

    expect(fake.calls.map(c => c.url.pathname)).toEqual([TOKEN_PATH, eventsPath('primary')]);
    expect(fake.calls[1]!.headers['authorization']).toBe('Bearer access-2');
    expect(persisted).toEqual([{ accessToken: 'access-2', refreshToken: 'refresh-1', expiresAt: NOW + 3599 * 1000 - 60_000 }]);
  });

  it('refreshes once after a 401 and retries that request with the new token', async () => {
    const fake = new FakeGoogle();
    fake.once('GET', eventsPath('primary'), { status: 401, body: { error: { message: 'Invalid Credentials' } } });
    fake.on('GET', eventsPath('primary'), { body: { items: [timed('a', 9)] } });
    fake.on('POST', TOKEN_PATH, { body: { ...refreshed, refresh_token: 'refresh-2' } });
    const persisted: GoogleTokens[] = [];
    const client = clientFor(fake, { onTokens: t => persisted.push(t) });

    const events = await client.listEvents({ ...DAY, calendarId: 'primary' });

    expect(events.map(e => e.id)).toEqual(['a']);
    expect(fake.calls.map(c => c.url.pathname)).toEqual([eventsPath('primary'), TOKEN_PATH, eventsPath('primary')]);
    expect(fake.calls[0]!.headers['authorization']).toBe('Bearer access-1');
    expect(fake.calls[2]!.headers['authorization']).toBe('Bearer access-2');
    // A rotated refresh token is what the caller has to keep from now on.
    expect(persisted.map(t => t.refreshToken)).toEqual(['refresh-2']);
  });

  it('gives up after a second 401, since the sign-in itself is gone', async () => {
    const fake = new FakeGoogle();
    fake.on('GET', eventsPath('primary'), { status: 401, body: { error: { message: 'Invalid Credentials' } } });
    fake.on('POST', TOKEN_PATH, { body: refreshed });
    const err = await failureOf(clientFor(fake).listEvents({ ...DAY, calendarId: 'primary' }));
    expect(err.code).toBe('unauthorized');
    expect(fake.calls.filter(c => c.url.pathname === TOKEN_PATH)).toHaveLength(1);
    expect(fake.calls).toHaveLength(3);
  });

  it('reports a revoked refresh token as unauthorized', async () => {
    const fake = new FakeGoogle();
    fake.on('POST', TOKEN_PATH, {
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    });
    const err = await failureOf(clientFor(fake, { tokens: tokens({ expiresAt: NOW - 1 }) }).email());
    expect(err.code).toBe('unauthorized');
    expect(fake.calls).toHaveLength(1);
  });

  it('posts the form Google expects, leaving the secret out for a client that has none', async () => {
    const fake = new FakeGoogle();
    fake.on('POST', TOKEN_PATH, { body: refreshed });

    const desktop = await refreshGoogleTokens(fake.http, CLIENT, tokens(), () => NOW);
    expect(desktop).toEqual({ accessToken: 'access-2', refreshToken: 'refresh-1', expiresAt: NOW + 3599 * 1000 - 60_000 });
    const form = new URLSearchParams(fake.calls[0]!.body as string);
    expect(fake.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
    });

    await refreshGoogleTokens(fake.http, { clientId: 'android-id' }, tokens(), () => NOW);
    expect(new URLSearchParams(fake.calls[1]!.body as string).has('client_secret')).toBe(false);
  });

  it('wraps a token endpoint that is unreachable, misbehaving, or answering nonsense', async () => {
    const down = new FakeGoogle().failWith(new Error('dns failure'));
    await expect(refreshGoogleTokens(down.http, CLIENT, tokens())).rejects.toMatchObject({ code: 'transport' });

    const wrongClient = new FakeGoogle().on('POST', TOKEN_PATH, { status: 401, body: { error: 'invalid_client' } });
    await expect(refreshGoogleTokens(wrongClient.http, CLIENT, tokens())).rejects.toMatchObject({ code: 'http', status: 401 });

    const nonsense = new FakeGoogle().on('POST', TOKEN_PATH, { text: '<html>' });
    await expect(refreshGoogleTokens(nonsense.http, CLIENT, tokens())).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('carries the bearer on every request it makes', async () => {
    const fake = new FakeGoogle();
    accountWith(fake, [{ id: 'primary', accessRole: 'owner', primary: true }, { id: 'b', accessRole: 'reader' }]);
    fake.on('GET', eventsPath('primary'), { body: { items: [] } });
    fake.on('GET', eventsPath('b'), { body: { items: [] } });
    fake.on('GET', `${API}/users/me/settings/timezone`, { body: { value: 'UTC' } });
    fake.on('POST', `${API}/calendars`, { body: { id: LOG_ID } });
    fake.on('GET', new URL('https://www.googleapis.com/oauth2/v3/userinfo').pathname, { body: { email: 'someone@example.com' } });
    new LogStore(fake);

    const client = clientFor(fake);
    await client.listEvents(DAY);
    await client.writeLog([{ toHootId: 't1::2026-08-23', title: 'x', start: 0, end: 1000 }]);
    await client.deleteLog(['t1::2026-08-23']);
    await expect(client.email()).resolves.toBe('someone@example.com');

    expect(fake.apiCalls().length).toBeGreaterThan(8);
    for (const call of fake.apiCalls()) {
      expect(call.headers['authorization']).toBe('Bearer access-1');
      expect(call.url.search).not.toContain('access-1');
    }
  });
});

describe('GoogleCalendarClient failures', () => {
  it('wraps a transport failure in the bridge error type', async () => {
    const fake = new FakeGoogle().failWith(new Error('dns failure'));
    const err = await failureOf(clientFor(fake).listEvents({ ...DAY, calendarId: 'primary' }));
    expect(err.code).toBe('transport');
    expect(err.message).toContain('dns failure');
  });

  it('tells a missing calendar scope apart from a rate limit, though both are 403', async () => {
    const scope = new FakeGoogle().on('GET', eventsPath('primary'), {
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          errors: [{ reason: 'insufficientPermissions', message: 'Insufficient Permission' }],
        },
      },
    });
    const refused = await failureOf(clientFor(scope).listEvents({ ...DAY, calendarId: 'primary' }));
    expect(refused.code).toBe('unauthorized');
    expect(refused.message).toContain('insufficient authentication scopes');

    const busy = new FakeGoogle().on('GET', eventsPath('primary'), rateLimited);
    const limited = await failureOf(clientFor(busy).listEvents({ ...DAY, calendarId: 'primary' }));
    expect(limited.code).toBe('calendar-error');
    expect(limited.message).toBe('Rate Limit Exceeded');
  });

  it('carries the status and Google message of any other failure', async () => {
    const fake = new FakeGoogle().on('GET', eventsPath('nope'), { status: 404, body: { error: { message: 'Not Found' } } });
    const err = await failureOf(clientFor(fake).listEvents({ ...DAY, calendarId: 'nope' }));
    expect(err.code).toBe('http');
    expect(err.status).toBe(404);
    expect(err.message).toContain('Not Found');
  });

  it('reports a 2xx that is not the expected JSON as a bad response', async () => {
    const fake = new FakeGoogle().on('GET', eventsPath('primary'), { text: '<!DOCTYPE html><title>Sign in</title>' });
    const err = await failureOf(clientFor(fake).listEvents({ ...DAY, calendarId: 'primary' }));
    expect(err.code).toBe('bad-response');

    const wrongShape = new FakeGoogle().on('GET', eventsPath('primary'), { body: { items: 'no' } });
    await expect(clientFor(wrongShape).listEvents({ ...DAY, calendarId: 'primary' })).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('encodes the calendar id in the path, since Google ids carry # and @', async () => {
    const id = 'team#contacts@group.v.calendar.google.com';
    const fake = new FakeGoogle().on('GET', eventsPath(id), { body: { items: [] } });
    await clientFor(fake).listEvents({ ...DAY, calendarId: id });
    const call = fake.calls[0]!;
    expect(call.url.pathname).toBe(`${API}/calendars/team%23contacts%40group.v.calendar.google.com/events`);
    // The hash never became a fragment, so the query string survived it.
    expect(call.url.hash).toBe('');
    expect(call.url.searchParams.get('singleEvents')).toBe('true');
  });
});
