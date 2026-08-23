import { describe, expect, it, vi } from 'vitest';
import {
  MAX_LIST_DAYS,
  MAX_WRITE_ENTRIES,
  constantTimeEquals,
  handleBridgeRequest,
  listOptionsFor,
  logEventResource,
  parseBridgeRequest,
  scriptFailure,
  pickLogCalendar,
  toBridgeEvent,
  type BridgeResponse,
  type CalendarPort,
  type EventResource,
  type ListOptions,
  type ListPage,
  type RawCalendarEvent,
} from './bridge.js';

const SECRET = 'a-generated-secret';
const DAY_MS = 86_400_000;

/**
 * An in-memory stand-in for the Calendar advanced service, with enough of its
 * real behaviour that the idempotency test means something: events are stored,
 * `privateExtendedProperty` actually filters, and ids are handed out on insert.
 */
class FakePort implements CalendarPort {
  readonly events = new Map<string, RawCalendarEvent>();
  readonly listCalls: { calendarId: string; opts: ListOptions }[] = [];
  readonly updated: string[] = [];
  readonly removed: string[] = [];
  logCalendarCreated = 0;
  throwOnList: Error | undefined;
  private nextId = 1;
  private page: RawCalendarEvent[] = [];
  private nextPageToken: string | undefined;

  /**
   * Puts an event in the store as if a previous run had written it. Two of
   * these sharing a toHootId is what a half-failed run leaves behind.
   */
  seedExisting(id: string, toHootId: string, summary: string): void {
    this.events.set(id, {
      id,
      summary,
      start: { dateTime: '2026-08-23T09:00:00Z' },
      end: { dateTime: '2026-08-23T10:00:00Z' },
      extendedProperties: { private: { toHootId } },
    });
  }

  /** Seeds what the next `list` window returns, as the real service would. */
  seedWindow(items: RawCalendarEvent[], nextPageToken?: string): void {
    this.page = items;
    this.nextPageToken = nextPageToken;
  }

  list(calendarId: string, opts: ListOptions): ListPage {
    this.listCalls.push({ calendarId, opts });
    if (this.throwOnList) throw this.throwOnList;
    const filter = opts.privateExtendedProperty;
    if (filter !== undefined) {
      const [key, value] = splitOnce(filter, '=');
      const items = [...this.events.values()].filter(
        e => e.extendedProperties?.private?.[key] === value,
      );
      return { items };
    }
    const page: ListPage = { items: this.page };
    if (this.nextPageToken !== undefined) page.nextPageToken = this.nextPageToken;
    return page;
  }

  insert(calendarId: string, resource: EventResource): RawCalendarEvent {
    const id = `ev-${this.nextId++}`;
    const stored: RawCalendarEvent = { ...resource, id };
    this.events.set(id, stored);
    return stored;
  }

  update(calendarId: string, eventId: string, resource: EventResource): RawCalendarEvent {
    this.updated.push(eventId);
    const stored: RawCalendarEvent = { ...resource, id: eventId };
    this.events.set(eventId, stored);
    return stored;
  }

  remove(calendarId: string, eventId: string): void {
    this.removed.push(eventId);
    this.events.delete(eventId);
  }

  logCalendarId(): string {
    this.logCalendarCreated++;
    return 'log-calendar-id';
  }
}

function splitOnce(s: string, sep: string): [string, string] {
  const at = s.indexOf(sep);
  return at < 0 ? [s, ''] : [s.slice(0, at), s.slice(at + sep.length)];
}

function post(body: unknown, secret: string = SECRET): string {
  return JSON.stringify({ secret, ...(body as Record<string, unknown>) });
}

function run(body: unknown, port?: CalendarPort, secret = SECRET): BridgeResponse {
  return handleBridgeRequest(post(body, secret), { secret: SECRET, calendar: port ?? new FakePort() });
}

describe('constantTimeEquals', () => {
  it('accepts an exact match and rejects a near miss of the same length', () => {
    expect(constantTimeEquals(SECRET, SECRET)).toBe(true);
    expect(constantTimeEquals(SECRET, 'a-generated-secreT')).toBe(false);
  });

  it('rejects a prefix, so a length difference is not a shortcut', () => {
    expect(constantTimeEquals(SECRET, 'a-gen')).toBe(false);
    expect(constantTimeEquals('a-gen', SECRET)).toBe(false);
  });

  it('reads every character of both strings, whichever one differs', () => {
    // Counting the reads rather than timing them, which would be flaky. An
    // implementation that returned at the first difference would read fewer
    // characters for a mismatch at the front than at the back, and `===` would
    // read none at all. This is white box on purpose: the property under test
    // is how the comparison is done, not what it answers.
    const spy = vi.spyOn(String.prototype, 'charCodeAt');
    constantTimeEquals('abcdef', 'zbcdef');
    const differsAtFront = spy.mock.calls.length;
    spy.mockClear();
    constantTimeEquals('abcdef', 'abcdez');
    const differsAtBack = spy.mock.calls.length;
    spy.mockRestore();

    expect(differsAtFront).toBe(12);
    expect(differsAtBack).toBe(12);
    expect(constantTimeEquals('abcdef', 'zbcdef')).toBe(false);
    expect(constantTimeEquals('abcdef', 'abcdez')).toBe(false);
  });
});

describe('parseBridgeRequest', () => {
  it('reports a bad request for a missing or non-JSON body', () => {
    expect(parseBridgeRequest(undefined).ok).toBe(false);
    const parsed = parseBridgeRequest('<html>sign in</html>');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('bad-request');
  });

  it('rejects an unknown action', () => {
    const parsed = parseBridgeRequest(post({ action: 'dropDatabase' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe('unsupported-action');
  });

  it('accepts epoch milliseconds and an offset-bearing ISO string for `from`', () => {
    const ms = parseBridgeRequest(post({ action: 'listEvents', from: 1_755_900_000_000, days: 7 }));
    expect(ms.ok).toBe(true);
    if (ms.ok && ms.request.action === 'listEvents') expect(ms.request.from).toBe(1_755_900_000_000);

    const iso = parseBridgeRequest(post({ action: 'listEvents', from: '2026-08-23T00:00:00Z', days: 1 }));
    expect(iso.ok).toBe(true);
    if (iso.ok && iso.request.action === 'listEvents') {
      expect(iso.request.from).toBe(Date.parse('2026-08-23T00:00:00Z'));
    }
  });

  it('rejects an ISO string with no zone, which would mean the script timezone', () => {
    const parsed = parseBridgeRequest(post({ action: 'listEvents', from: '2026-08-23T00:00:00', days: 1 }));
    expect(parsed.ok).toBe(false);
  });

  it('rejects a window longer than the six-minute execution limit can serve', () => {
    expect(parseBridgeRequest(post({ action: 'listEvents', from: 0, days: 0 })).ok).toBe(false);
    expect(parseBridgeRequest(post({ action: 'listEvents', from: 0, days: MAX_LIST_DAYS })).ok).toBe(true);
    expect(parseBridgeRequest(post({ action: 'listEvents', from: 0, days: MAX_LIST_DAYS + 1 })).ok).toBe(false);
  });

  it('rejects a writeLog batch that is empty, oversized, or malformed', () => {
    const entry = { toHootId: 't1::2026-08-23', title: 'Write the report', start: 1000, end: 2000 };
    expect(parseBridgeRequest(post({ action: 'writeLog', entries: [] })).ok).toBe(false);
    expect(parseBridgeRequest(post({ action: 'writeLog', entries: [entry] })).ok).toBe(true);
    const oversized = new Array(MAX_WRITE_ENTRIES + 1).fill(entry);
    expect(parseBridgeRequest(post({ action: 'writeLog', entries: oversized })).ok).toBe(false);
    expect(parseBridgeRequest(post({ action: 'writeLog', entries: [{ ...entry, toHootId: '' }] })).ok).toBe(false);
    expect(parseBridgeRequest(post({ action: 'writeLog', entries: [{ ...entry, end: entry.start }] })).ok).toBe(false);
  });

  it('rejects a deleteLog with anything but non-empty id strings', () => {
    expect(parseBridgeRequest(post({ action: 'deleteLog', toHootIds: ['a'] })).ok).toBe(true);
    expect(parseBridgeRequest(post({ action: 'deleteLog', toHootIds: [] })).ok).toBe(false);
    expect(parseBridgeRequest(post({ action: 'deleteLog', toHootIds: [''] })).ok).toBe(false);
    expect(parseBridgeRequest(post({ action: 'deleteLog', toHootIds: 'a' })).ok).toBe(false);
  });
});

describe('handleBridgeRequest authentication', () => {
  it('rejects a wrong secret without touching the calendar', () => {
    const port = new FakePort();
    const res = handleBridgeRequest(post({ action: 'listEvents', from: 0, days: 1 }, 'guessed'), {
      secret: SECRET,
      calendar: port,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('unauthorized');
    expect(port.listCalls).toHaveLength(0);
  });

  it('rejects everything when the script has no secret configured', () => {
    // An unconfigured deployment must be closed, not open: an empty Script
    // Property must never match an empty secret in the request.
    for (const sent of ['', SECRET]) {
      const res = handleBridgeRequest(post({ action: 'listEvents', from: 0, days: 1 }, sent), {
        secret: '',
        calendar: new FakePort(),
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('unauthorized');
    }
  });

  it('reports the auth failure before it reports a malformed body', () => {
    const res = handleBridgeRequest(JSON.stringify({ secret: 'wrong', action: 'nonsense' }), {
      secret: SECRET,
      calendar: new FakePort(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('unauthorized');
  });
});

describe('handleBridgeRequest listEvents', () => {
  it('expands recurrence by asking for single events in start order', () => {
    const port = new FakePort();
    run({ action: 'listEvents', from: 1_755_900_000_000, days: 2 }, port);
    const call = port.listCalls[0]!;
    expect(call.calendarId).toBe('primary');
    expect(call.opts.singleEvents).toBe(true);
    expect(call.opts.orderBy).toBe('startTime');
    expect(call.opts.timeMin).toBe(new Date(1_755_900_000_000).toISOString());
    expect(call.opts.timeMax).toBe(new Date(1_755_900_000_000 + 2 * DAY_MS).toISOString());
  });

  it('passes the page token straight through, so the client drives the loop', () => {
    const port = new FakePort();
    port.seedWindow([], 'page-2');
    const res = run({ action: 'listEvents', from: 0, days: 1, pageToken: 'page-1' }, port);
    expect(port.listCalls[0]!.opts.pageToken).toBe('page-1');
    expect(res.ok && res.action === 'listEvents' ? res.nextPageToken : undefined).toBe('page-2');
  });

  it('drops cancelled events and events with no usable time', () => {
    const port = new FakePort();
    port.seedWindow([
      { id: 'a', summary: 'Standup', start: { dateTime: '2026-08-23T09:00:00Z' }, end: { dateTime: '2026-08-23T09:15:00Z' } },
      { id: 'b', summary: 'Gone', status: 'cancelled', start: { dateTime: '2026-08-23T10:00:00Z' }, end: { dateTime: '2026-08-23T11:00:00Z' } },
      { id: 'c', summary: 'Broken' },
    ]);
    const res = run({ action: 'listEvents', from: 0, days: 1 }, port);
    expect(res.ok && res.action === 'listEvents' ? res.events.map(e => e.id) : []).toEqual(['a']);
  });

  it('reads a caller-supplied calendar id rather than assuming one account', () => {
    const port = new FakePort();
    run({ action: 'listEvents', from: 0, days: 1, calendarId: 'team@example.com' }, port);
    expect(port.listCalls[0]!.calendarId).toBe('team@example.com');
  });

  it('turns a Calendar exception into ok:false rather than throwing', () => {
    const port = new FakePort();
    port.throwOnList = new Error('Rate Limit Exceeded');
    const res = run({ action: 'listEvents', from: 0, days: 1 }, port);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('calendar-error');
      expect(res.error).toContain('Rate Limit Exceeded');
    }
  });

  it('reports a disabled advanced service as its own code', () => {
    const res = handleBridgeRequest(post({ action: 'listEvents', from: 0, days: 1 }), {
      secret: SECRET,
      calendar: undefined,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('calendar-service-disabled');
  });
});

describe('handleBridgeRequest writeLog', () => {
  const entry = { toHootId: 't1::2026-08-23', title: 'Write the report', start: 1_755_936_000_000, end: 1_755_939_600_000 };

  it('inserts into the dedicated log calendar and stamps the private id', () => {
    const port = new FakePort();
    const res = run({ action: 'writeLog', entries: [entry] }, port);
    expect(res.ok).toBe(true);
    expect(port.logCalendarCreated).toBe(1);
    const [stored] = [...port.events.values()];
    expect(stored!.extendedProperties?.private?.['toHootId']).toBe(entry.toHootId);
    expect(stored!.summary).toBe('Write the report');
    expect(stored!.start?.dateTime).toBe(new Date(entry.start).toISOString());
  });

  it('looks an existing event up by toHootId and updates it rather than inserting', () => {
    const port = new FakePort();
    run({ action: 'writeLog', entries: [entry] }, port);
    const longer = { ...entry, end: entry.end + 1_800_000 };
    const res = run({ action: 'writeLog', entries: [longer] }, port);

    expect(port.events.size).toBe(1);
    expect(port.updated).toEqual(['ev-1']);
    const lookup = port.listCalls.find(c => c.opts.privateExtendedProperty !== undefined);
    expect(lookup?.opts.privateExtendedProperty).toBe(`toHootId=${entry.toHootId}`);
    expect(res.ok && res.action === 'writeLog' ? res.written : []).toEqual([
      { toHootId: entry.toHootId, eventId: 'ev-1', created: false },
    ]);
  });

  it('is idempotent: replaying the same batch leaves one event', () => {
    const port = new FakePort();
    run({ action: 'writeLog', entries: [entry] }, port);
    run({ action: 'writeLog', entries: [entry] }, port);
    run({ action: 'writeLog', entries: [entry] }, port);
    expect(port.events.size).toBe(1);
  });
});

describe('handleBridgeRequest duplicate cleanup', () => {
  const entry = { toHootId: 't1::2026-08-23', title: 'Write the report', start: 1_755_936_000_000, end: 1_755_939_600_000 };

  it('keeps one event and removes the duplicates a half-failed run left behind', () => {
    const port = new FakePort();
    port.seedExisting('dup-1', entry.toHootId, 'old one');
    port.seedExisting('dup-2', entry.toHootId, 'old two');

    const res = run({ action: 'writeLog', entries: [entry] }, port);
    expect([...port.events.values()].map(e => e.summary)).toEqual(['Write the report']);
    expect(port.removed).toEqual(['dup-2']);
    expect(res.ok && res.action === 'writeLog' ? res.written : []).toEqual([
      { toHootId: entry.toHootId, eventId: 'dup-1', created: false, duplicatesRemoved: 1 },
    ]);
  });

  it('cleans up however many duplicates there are, not just the second', () => {
    const port = new FakePort();
    for (const n of [1, 2, 3]) port.seedExisting(`dup-${n}`, entry.toHootId, `old ${n}`);
    run({ action: 'writeLog', entries: [entry] }, port);
    expect(port.events.size).toBe(1);
    expect(port.removed).toEqual(['dup-2', 'dup-3']);
  });

  it('deleteLog removes every duplicate, so nothing is left orphaned', () => {
    const port = new FakePort();
    for (const n of [1, 2, 3]) port.seedExisting(`dup-${n}`, 't1::2026-08-23', `old ${n}`);
    const res = run({ action: 'deleteLog', toHootIds: ['t1::2026-08-23'] }, port);
    expect(port.events.size).toBe(0);
    expect(port.removed).toEqual(['dup-1', 'dup-2', 'dup-3']);
    // The id is reported once, however many events carried it.
    expect(res.ok && res.action === 'deleteLog' ? res.deleted : []).toEqual(['t1::2026-08-23']);
  });
});

describe('handleBridgeRequest deleteLog', () => {
  it('removes what it finds and names what it did not', () => {
    const port = new FakePort();
    run({ action: 'writeLog', entries: [{ toHootId: 't1::2026-08-23', title: 'x', start: 1000, end: 2000 }] }, port);
    const res = run({ action: 'deleteLog', toHootIds: ['t1::2026-08-23', 't9::2026-08-23'] }, port);
    expect(res.ok && res.action === 'deleteLog' ? res.deleted : []).toEqual(['t1::2026-08-23']);
    expect(res.ok && res.action === 'deleteLog' ? res.missing : []).toEqual(['t9::2026-08-23']);
    expect(port.events.size).toBe(0);
  });
});

describe('event mapping', () => {
  it('reads a timed event at its own offset, not the script timezone', () => {
    const ev = toBridgeEvent(
      {
        id: 'a',
        summary: 'Standup',
        location: 'Room 2',
        start: { dateTime: '2026-08-23T09:00:00+02:00' },
        end: { dateTime: '2026-08-23T09:15:00+02:00' },
      },
      'primary',
    );
    expect(ev).toEqual({
      id: 'a',
      calendarId: 'primary',
      title: 'Standup',
      start: Date.parse('2026-08-23T07:00:00Z'),
      end: Date.parse('2026-08-23T07:15:00Z'),
      allDay: false,
      location: 'Room 2',
    });
  });

  it('reports an all-day event by its day strings, so the client can place it locally', () => {
    const ev = toBridgeEvent(
      { id: 'b', summary: 'Conference', start: { date: '2026-08-24' }, end: { date: '2026-08-26' } },
      'primary',
    );
    expect(ev?.allDay).toBe(true);
    expect(ev?.startDay).toBe('2026-08-24');
    expect(ev?.endDay).toBe('2026-08-26');
    expect(ev?.start).toBe(Date.UTC(2026, 7, 24));
  });

  it('carries a toHootId back and leaves an untitled event untitled', () => {
    const ev = toBridgeEvent(
      {
        id: 'c',
        start: { dateTime: '2026-08-23T09:00:00Z' },
        end: { dateTime: '2026-08-23T10:00:00Z' },
        extendedProperties: { private: { toHootId: 't1::2026-08-23' } },
      },
      'log-calendar-id',
    );
    expect(ev?.title).toBe('');
    expect(ev?.toHootId).toBe('t1::2026-08-23');
  });
});

describe('log calendar selection', () => {
  it('picks an existing calendar by name and ignores one the user only subscribes to', () => {
    const id = pickLogCalendar(
      [
        { id: 'sub', summary: 'to-hoot log', accessRole: 'reader' },
        { id: 'mine', summary: 'to-hoot log', accessRole: 'owner' },
      ],
      'to-hoot log',
    );
    expect(id).toBe('mine');
  });

  it('returns undefined when there is nothing to adopt', () => {
    expect(pickLogCalendar([{ id: 'other', summary: 'Work', accessRole: 'owner' }], 'to-hoot log')).toBeUndefined();
  });
});

describe('request building', () => {
  it('never asks for more than one page worth of events', () => {
    const opts = listOptionsFor({ action: 'listEvents', from: 0, days: 1, maxResults: 9999 });
    expect(opts.maxResults).toBeLessThanOrEqual(250);
    expect(opts.showDeleted).toBe(false);
  });

  it('describes the block it writes, and marks it as this app doing it', () => {
    const resource = logEventResource({ toHootId: 't1::2026-08-23', title: 'Write the report', start: 0, end: 3600_000 });
    expect(resource.summary).toBe('Write the report');
    expect(resource.start.dateTime).toBe(new Date(0).toISOString());
    expect(resource.end.dateTime).toBe(new Date(3600_000).toISOString());
    expect(resource.extendedProperties.private['toHootId']).toBe('t1::2026-08-23');
  });
});

describe('scriptFailure', () => {
  it('answers a wrapper failure in JSON, because the alternative is an HTML error page', () => {
    expect(scriptFailure(new Error('script properties unavailable'))).toEqual({
      ok: false,
      code: 'script-error',
      error: 'script properties unavailable',
    });
    expect(scriptFailure('boom').error).toBe('boom');
  });
});
