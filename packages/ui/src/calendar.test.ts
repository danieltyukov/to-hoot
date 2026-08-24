// @vitest-environment node
import {
  DEFAULT_SETTINGS,
  cloneSettings,
  logIdFor,
  type BridgeEvent,
  type Http,
  type Settings,
} from '@to-hoot/core';
import { describe, expect, it } from 'vitest';

import { CalendarService, modeFor, parseIcs, timelineEventsFrom } from './calendar.js';
import { memoryStore } from './platform/browser.js';
import { Store } from './store.js';

const DAY = '2026-08-23';
const NOON = new Date(2026, 7, 23, 12, 0, 0).getTime();

function bridgeSettings(): Settings {
  const s = cloneSettings(DEFAULT_SETTINGS);
  s.calendar = { execUrl: 'https://script.google.com/macros/s/AK/exec', secret: 'x'.repeat(40), icsUrl: '' };
  return s;
}

/** Records every bridge call and answers with whatever the test scripted. */
function bridge(reply: (action: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const http: Http = async req => {
    const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
    calls.push({ action: String(body['action']), body });
    return { status: 200, headers: {}, text: async () => JSON.stringify(reply(String(body['action']), body)) };
  };
  return { http, calls };
}

function serviceFor(http: Http, settings: Settings, now = NOON) {
  const store = new Store({ now: () => now, storage: null, vault: memoryStore() });
  const calendar = new CalendarService({ store, http, settings: () => settings, now: () => now });
  return { store, calendar };
}

describe('modeFor', () => {
  it('needs both halves before it will call the bridge', () => {
    const s = cloneSettings(DEFAULT_SETTINGS);
    expect(modeFor(s)).toBe('off');
    s.calendar.execUrl = 'https://script.google.com/x/exec';
    // A URL with no secret cannot authenticate, so it is not a usable bridge.
    expect(modeFor(s)).toBe('off');
    s.calendar.secret = 'y';
    expect(modeFor(s)).toBe('bridge');
  });

  it('falls back to the read-only feed', () => {
    const s = cloneSettings(DEFAULT_SETTINGS);
    s.calendar.icsUrl = 'https://calendar.google.com/x/basic.ics';
    expect(modeFor(s)).toBe('ics');
  });
});

describe('reading the day', () => {
  it('asks the bridge for today and keeps what comes back', async () => {
    const start = new Date(2026, 7, 23, 14, 30).getTime();
    const { http, calls } = bridge(() => ({
      ok: true,
      action: 'listEvents',
      events: [{ id: 'e1', calendarId: 'c', title: 'Standup', start, end: start + 1800_000, allDay: false }],
    }));
    const { calendar } = serviceFor(http, bridgeSettings());
    await calendar.refresh();

    expect(calls[0]!.body).toMatchObject({ action: 'listEvents', days: 1 });
    expect(calendar.events.map(e => e.title)).toEqual(['Standup']);
  });

  it('keeps the last good answer when the calendar cannot be read', async () => {
    let fail = false;
    const start = new Date(2026, 7, 23, 9, 0).getTime();
    const http: Http = async () => {
      if (fail) throw new Error('the network went away');
      return {
        status: 200,
        headers: {},
        text: async () =>
          JSON.stringify({
            ok: true,
            action: 'listEvents',
            events: [{ id: 'e', calendarId: 'c', title: 'Standup', start, end: start + 1, allDay: false }],
          }),
      };
    };
    const errors: string[] = [];
    const store = new Store({ storage: null, vault: memoryStore() });
    const settings = bridgeSettings();
    const calendar = new CalendarService({
      store,
      http,
      settings: () => settings,
      onError: m => errors.push(m),
    });

    await calendar.refresh();
    fail = true;
    await calendar.refresh();

    // A calendar that cannot be read is not a reason to blank the timeline.
    expect(calendar.events).toHaveLength(1);
    expect(errors[0]).toContain('network went away');
  });

  it('asks for nothing at all when no calendar is configured', async () => {
    const http: Http = async () => {
      throw new Error('should not have been called');
    };
    const { calendar } = serviceFor(http, cloneSettings(DEFAULT_SETTINGS));
    await expect(calendar.refresh()).resolves.toBeUndefined();
    expect(calendar.events).toEqual([]);
  });
});

describe('writing tracked time back', () => {
  function trackedStore(ms: number) {
    const settings = bridgeSettings();
    const written: Array<Record<string, unknown>> = [];
    const { http, calls } = bridge((action, body) => {
      if (action === 'writeLog') {
        const entries = body['entries'] as Array<{ toHootId: string }>;
        written.push(...entries);
        return {
          ok: true,
          action: 'writeLog',
          calendarId: 'to-hoot log',
          written: entries.map(e => ({ toHootId: e.toHootId, eventId: `g-${e.toHootId}`, created: true })),
        };
      }
      if (action === 'deleteLog') {
        return { ok: true, action: 'deleteLog', deleted: body['toHootIds'], missing: [] };
      }
      return { ok: true, action: 'listEvents', events: [] };
    });

    const store = new Store({ now: () => NOON, storage: null, vault: memoryStore() });
    const id = store.addTask('Solder the preamp');
    store.patchTask(id, {});
    // Straight into the ledger's input, which is what the tracker writes.
    store.merge([
      {
        ...store.getSnapshot().events[0]!,
        id: '01DELTA0000000000000000001',
        type: 'timeDelta',
        entity: 'task',
        entityId: id,
        payload: { day: DAY, ms },
      },
    ]);
    const calendar = new CalendarService({
      store,
      http,
      settings: () => settings,
      now: () => NOON,
    });
    return { store, calendar, calls, written, id };
  }

  it('writes a block covering the day total and records it in the ledger', async () => {
    const { store, calendar, written, id } = trackedStore(90 * 60_000);
    calendar.syncWriteback();
    await calendar.idle();

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ toHootId: logIdFor(id, DAY), title: 'Solder the preamp' });
    // The block covers the day's total, not the delta: trimmed to the delta it
    // would read as half an hour on a day that took an hour.
    expect((written[0]!['end'] as number) - (written[0]!['start'] as number)).toBe(90 * 60_000);
    expect(store.getSnapshot().state.tasks[id]!.calendarWritten[DAY]).toBe(90 * 60_000);
  });

  it('puts the block where the work happened, not at the start of the working day', async () => {
    const { calendar, written } = trackedStore(90 * 60_000);
    calendar.syncWriteback();
    await calendar.idle();

    expect(written[0]!['start']).toBe(NOON - 90 * 60_000);
    expect(written[0]!['end']).toBe(NOON);
  });

  it('writes one block per stretch when the day was worked in two sittings', async () => {
    const { store, calendar, written, id } = trackedStore(30 * 60_000);
    store.merge([
      {
        ...store.getSnapshot().events[0]!,
        id: '01DELTA0000000000000000009',
        ts: NOON + 3 * 3_600_000,
        type: 'timeDelta',
        entity: 'task',
        entityId: id,
        payload: { day: DAY, ms: 20 * 60_000 },
      },
    ]);
    calendar.syncWriteback();
    await calendar.idle();

    expect(written.map(w => [w['start'], w['end']])).toEqual([
      [NOON - 30 * 60_000, NOON],
      [NOON + 3 * 3_600_000 - 20 * 60_000, NOON + 3 * 3_600_000],
    ]);
    expect(store.getSnapshot().state.tasks[id]!.calendarBlocks[DAY]).toBe(2);
  });

  it('writes nothing at all the second time, because the delta is zero', async () => {
    // The whole point of the ledger. A repeated sync has to be free, or the
    // calendar fills with rewrites of blocks that have not changed.
    const { calendar, written } = trackedStore(90 * 60_000);
    calendar.syncWriteback();
    await calendar.idle();
    expect(written).toHaveLength(1);

    calendar.syncWriteback();
    await calendar.idle();
    expect(written).toHaveLength(1);
  });

  it('writes again once more time is tracked, covering the new total', async () => {
    const { store, calendar, written, id } = trackedStore(30 * 60_000);
    calendar.syncWriteback();
    await calendar.idle();

    store.merge([
      {
        ...store.getSnapshot().events[0]!,
        id: '01DELTA0000000000000000002',
        // The stretch that follows the first one, as the tracker flushes it:
        // twenty more minutes, ending twenty minutes later.
        ts: NOON + 20 * 60_000,
        type: 'timeDelta',
        entity: 'task',
        entityId: id,
        payload: { day: DAY, ms: 20 * 60_000 },
      },
    ]);
    calendar.syncWriteback();
    await calendar.idle();

    expect(written).toHaveLength(2);
    expect((written[1]!['end'] as number) - (written[1]!['start'] as number)).toBe(50 * 60_000);
    expect(store.getSnapshot().state.tasks[id]!.calendarWritten[DAY]).toBe(50 * 60_000);
  });

  it('leaves the ledger alone when the write fails, so it is retried in full', async () => {
    const settings = bridgeSettings();
    const http: Http = async () => ({
      status: 200,
      headers: {},
      text: async () => JSON.stringify({ ok: false, code: 'script-error', error: 'Calendar refused' }),
    });
    const store = new Store({ now: () => NOON, storage: null, vault: memoryStore() });
    const id = store.addTask('Solder the preamp');
    store.merge([
      {
        ...store.getSnapshot().events[0]!,
        id: '01DELTA0000000000000000003',
        type: 'timeDelta',
        entity: 'task',
        entityId: id,
        payload: { day: DAY, ms: 60_000 },
      },
    ]);
    const errors: string[] = [];
    const calendar = new CalendarService({
      store,
      http,
      settings: () => settings,
      now: () => NOON,
      onError: m => errors.push(m),
    });

    calendar.syncWriteback();
    await calendar.idle();

    expect(errors).toHaveLength(1);
    // Nothing recorded, so the next attempt writes the whole day again rather
    // than believing a block exists that does not.
    expect(store.getSnapshot().state.tasks[id]!.calendarWritten).toEqual({});
  });

  it('does not call the bridge at all on the read-only feed', async () => {
    const settings = cloneSettings(DEFAULT_SETTINGS);
    settings.calendar.icsUrl = 'https://calendar.google.com/x/basic.ics';
    const http: Http = async () => {
      throw new Error('should not have been called');
    };
    const { calendar } = serviceFor(http, settings);
    calendar.syncWriteback();
    await expect(calendar.idle()).resolves.toBeUndefined();
  });
});

describe('parseIcs', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:one',
    'SUMMARY:Design review',
    'DTSTART:20260823T090000Z',
    'DTEND:20260823T100000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:two',
    'SUMMARY:A very long title that the fe',
    ' ed wrapped onto a second line',
    'DTSTART;TZID=Europe/Amsterdam:20260823T140000',
    'DTEND;TZID=Europe/Amsterdam:20260823T150000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:three',
    'SUMMARY:Someone birthday',
    'DTSTART;VALUE=DATE:20260823',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const from = new Date(2026, 7, 23).getTime();
  const to = from + 86_400_000;

  it('reads the events in the window', () => {
    const events = parseIcs(feed, from, to);
    expect(events.map(e => e.title)).toContain('Design review');
  });

  it('unfolds a wrapped line, which is how iCalendar carries long text', () => {
    const events = parseIcs(feed, from, to);
    expect(events.find(e => e.id === 'two')?.title).toBe(
      'A very long title that the feed wrapped onto a second line',
    );
  });

  it('marks an all-day entry as one rather than drawing it across the grid', () => {
    expect(parseIcs(feed, from, to).find(e => e.id === 'three')?.allDay).toBe(true);
  });

  it('leaves out anything outside the window', () => {
    const other = new Date(2026, 7, 25).getTime();
    expect(parseIcs(feed, other, other + 86_400_000)).toEqual([]);
  });

  it('skips an entry it cannot place rather than guessing at the hour', () => {
    // A block drawn at the wrong time is worse than one that is absent.
    const broken = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:not-a-time\nEND:VEVENT\nEND:VCALENDAR';
    expect(parseIcs(broken, from, to)).toEqual([]);
  });

  it('returns them in time order', () => {
    const events = parseIcs(feed, from, to);
    expect(events.map(e => e.start)).toEqual([...events.map(e => e.start)].sort((a, b) => a - b));
  });
});

describe('putting a calendar day on the timeline', () => {
  const event = (patch: Partial<BridgeEvent>): BridgeEvent => ({
    id: 'e1',
    calendarId: 'primary',
    title: 'Standup',
    start: 1_000,
    end: 2_000,
    allDay: false,
    ...patch,
  });

  it('names an event a shared calendar would only tell it the hours of', () => {
    // A calendar shared as free/busy comes back with no summary. The hour is
    // still gone, and an unlabelled box on the grid reads as a rendering bug.
    expect(timelineEventsFrom([event({ title: '' })])[0]!.title).toBe('Busy');
  });

  it('leaves out the blocks this app wrote, which the tracked lane already draws', () => {
    const mine = event({ id: 'ours', toHootId: 't1::2026-08-24' });
    expect(timelineEventsFrom([mine, event({ id: 'theirs' })]).map(e => e.id)).toEqual(['cal:theirs']);
  });

  it('leaves out an all-day entry rather than claiming the whole grid for it', () => {
    expect(timelineEventsFrom([event({ allDay: true })])).toEqual([]);
  });

  it('leaves out an entry that ends before it starts', () => {
    expect(timelineEventsFrom([event({ start: 2_000, end: 1_000 })])).toEqual([]);
  });
});
