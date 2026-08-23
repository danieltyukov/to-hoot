import {
  CalendarBridgeClient,
  WriteQueue,
  applyWriteback,
  dayStr,
  planWriteback,
  workdayAnchor,
  type BridgeEvent,
  type Http,
  type Settings,
  type PartialProgress,
  type State,
  type Task,
  type WritebackAction,
} from '@to-hoot/core';

import type { Store } from './store.js';

/*
 * The calendar, connected at both ends.
 *
 * Reading puts the day the user actually has beside the day they planned, which
 * is the entire reason a tracker and a calendar are in one view. Writing back
 * puts the time they spent onto a separate calendar, so the record of the day
 * outlives this app.
 *
 * Write-back is driven by the delta between `timeSpentOnDay` and
 * `calendarWritten`, never by "something changed". That ledger is what makes a
 * repeated sync free and an interrupted one safe to resume: it advances only
 * for writes that actually landed, so a failure is retried in full rather than
 * lost, and a success is never written twice.
 */

/** How often to re-read the day while the app is open. */
export const CALENDAR_EVERY_MS = 10 * 60_000;

export interface CalendarServiceOptions {
  store: Store;
  http: Http;
  settings: () => Settings;
  now?: () => number;
  onEvents?: (events: BridgeEvent[]) => void;
  onError?: (message: string) => void;
}

export type CalendarMode = 'off' | 'bridge' | 'ics';

export function modeFor(settings: Settings): CalendarMode {
  if (settings.calendar.execUrl !== '' && settings.calendar.secret !== '') return 'bridge';
  if (settings.calendar.icsUrl !== '') return 'ics';
  return 'off';
}

export class CalendarService {
  private readonly store: Store;
  private readonly http: Http;
  private readonly readSettings: () => Settings;
  private readonly nowFn: () => number;
  private readonly onEvents: ((events: BridgeEvent[]) => void) | undefined;
  private readonly onError: ((message: string) => void) | undefined;

  /** One write in flight per task, debounced, so an edit burst is one call. */
  private readonly queue: WriteQueue<WritebackAction[]>;
  private timer: ReturnType<typeof setInterval> | undefined;

  events: BridgeEvent[] = [];

  constructor(options: CalendarServiceOptions) {
    this.store = options.store;
    this.http = options.http;
    this.readSettings = options.settings;
    this.nowFn = options.now ?? Date.now;
    this.onEvents = options.onEvents;
    this.onError = options.onError;
    this.queue = new WriteQueue<WritebackAction[]>(
      (taskId, actions) => this.write(taskId, actions),
      { onError: (_id, err) => this.onError?.(messageOf(err)) },
    );
  }

  /** Debouncing or waiting for a slot. The settings screen shows this. */
  get pendingWrites(): number {
    return this.queue.pendingCount + this.queue.runningCount;
  }

  /**
   * Starts reading on a timer, and returns the way to stop reading.
   *
   * It deliberately does not dispose the write queue. `dispose` is permanent,
   * and React mounts, unmounts and remounts in development while the memoized
   * service survives all three, so disposing here left write-back dead in dev
   * and working in production. Stopping the reads is reversible; throwing away
   * the queue is not.
   */
  start(): () => void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), CALENDAR_EVERY_MS);
    return () => clearInterval(this.timer);
  }

  /** Permanent teardown, for a caller that really is finished with this. */
  dispose(): void {
    clearInterval(this.timer);
    this.queue.dispose();
  }

  /** Reads today onto the timeline. Quiet when there is nothing configured. */
  async refresh(): Promise<void> {
    const settings = this.readSettings();
    const mode = modeFor(settings);
    if (mode === 'off') {
      this.publish([]);
      return;
    }
    const from = startOfDay(this.nowFn(), settings.dayStartOffsetMs);
    try {
      this.publish(
        mode === 'bridge'
          ? await this.readBridge(settings, from)
          : await this.readIcs(settings, from),
      );
    } catch (err) {
      // A calendar that cannot be read is not a reason to lose the tasks beside
      // it, so this reports and leaves the last good answer on screen.
      this.onError?.(messageOf(err));
    }
  }

  private publish(events: BridgeEvent[]): void {
    this.events = events;
    this.onEvents?.(events);
  }

  private async readBridge(settings: Settings, from: number): Promise<BridgeEvent[]> {
    const client = new CalendarBridgeClient(this.http, {
      execUrl: settings.calendar.execUrl,
      secret: settings.calendar.secret,
    });
    return client.listEvents({ from, days: 1 });
  }

  private async readIcs(settings: Settings, from: number): Promise<BridgeEvent[]> {
    const res = await this.http({ url: settings.calendar.icsUrl, method: 'GET' });
    if (res.status !== 200) throw new Error(`the feed answered ${res.status}`);
    return parseIcs(await res.text(), from, from + 86_400_000);
  }

  /**
   * Queues write-back for every task whose calendar record is behind.
   *
   * The delta decides, so calling this on every state change is free when
   * nothing has moved. Only tasks with a real difference reach the queue.
   */
  syncWriteback(state: State = this.store.getSnapshot().state): void {
    const settings = this.readSettings();
    if (modeFor(settings) !== 'bridge') return;

    for (const task of Object.values(state.tasks)) {
      const actions = planWriteback(task, {
        anchorFor: day => workdayAnchor(day, settings.workdayStart),
      });
      if (actions.length > 0) this.queue.enqueue(task.id, actions);
    }
  }

  /** Waits for every queued write. Tests and a clean shutdown use it. */
  async idle(): Promise<void> {
    await this.queue.idle();
  }

  private async write(taskId: string, actions: WritebackAction[]): Promise<void> {
    const settings = this.readSettings();
    if (modeFor(settings) !== 'bridge') return;
    const task = this.store.getSnapshot().state.tasks[taskId];
    if (task === undefined) return;

    const client = new CalendarBridgeClient(this.http, {
      execUrl: settings.calendar.execUrl,
      secret: settings.calendar.secret,
    });

    const writes = actions.filter(a => a.kind === 'write');
    const deletes = actions.filter(a => a.kind === 'delete');
    const landed: WritebackAction[] = [];

    /*
     * A failure mid-way through a batch still has to advance the ledger for the
     * blocks that were written, which is what `partial` on the error carries.
     * Without it the next sync would write those days a second time, and the
     * user would watch their calendar fill with duplicates every few minutes.
     * What is left out stays unwritten and is retried in full.
     */
    try {
      if (writes.length > 0) {
        const results = await client.writeLog(writes.map(a => a.entry));
        landed.push(...matching(writes, results.map(r => r.toHootId)));
      }
      if (deletes.length > 0) {
        const { deleted, missing } = await client.deleteLog(deletes.map(a => a.toHootId));
        // Already gone counts as done: there is nothing left to remove.
        landed.push(...matching(deletes, [...deleted, ...missing]));
      }
    } catch (err) {
      const partial = (err as { partial?: PartialProgress } | null)?.partial;
      if (partial !== undefined) {
        landed.push(...matching(writes, (partial.written ?? []).map(r => r.toHootId)));
        landed.push(...matching(deletes, [...(partial.deleted ?? []), ...(partial.missing ?? [])]));
      }
      this.record(taskId, task, landed);
      throw err;
    }

    this.record(taskId, task, landed);
  }

  private record(taskId: string, task: Task, landed: WritebackAction[]): void {
    if (landed.length === 0) return;
    this.store.patchTask(taskId, {
      calendarWritten: applyWriteback(task.calendarWritten, landed),
    });
  }
}

/** The actions whose ids the script confirmed. */
function matching(actions: WritebackAction[], ids: readonly string[]): WritebackAction[] {
  const done = new Set(ids);
  return actions.filter(a => done.has(a.toHootId));
}

function startOfDay(now: number, offsetMs: number): number {
  const d = new Date(now - offsetMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + offsetMs;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Enough iCalendar to put a day on a timeline.
 *
 * Deliberately small. This path exists for someone who wants to see their day
 * and nothing more: no recurrence expansion, no timezone database, no
 * attendees. An event this cannot read is skipped rather than guessed at,
 * because a block drawn at the wrong hour is worse than one that is absent.
 */
export function parseIcs(text: string, from: number, to: number): BridgeEvent[] {
  const events: BridgeEvent[] = [];
  // Unfold first: iCalendar wraps long lines and continues them with a space.
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');

  let current: Record<string, string> | null = null;
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      current = {};
      continue;
    }
    if (line.startsWith('END:VEVENT')) {
      if (current !== null) {
        const event = eventFrom(current, from, to);
        if (event !== null) events.push(event);
      }
      current = null;
      continue;
    }
    if (current === null) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    // "DTSTART;TZID=Europe/Amsterdam" keeps its parameters in the key, which is
    // how the all-day form (VALUE=DATE) stays distinguishable.
    current[line.slice(0, at)] = line.slice(at + 1);
  }
  return events.sort((a, b) => a.start - b.start);
}

function eventFrom(fields: Record<string, string>, from: number, to: number): BridgeEvent | null {
  const startKey = Object.keys(fields).find(k => k.startsWith('DTSTART'));
  const endKey = Object.keys(fields).find(k => k.startsWith('DTEND'));
  if (startKey === undefined) return null;

  const start = icsTime(fields[startKey]!);
  if (start === null) return null;
  const allDay = /VALUE=DATE(?!-TIME)/.test(startKey) || fields[startKey]!.trim().length === 8;
  const explicitEnd = endKey === undefined ? null : icsTime(fields[endKey]!);
  // An all-day entry with no DTEND covers the day. Half an hour, the default
  // for a timed event with no end, would put it outside its own day's window
  // and drop it from the feed entirely.
  const end = explicitEnd ?? (allDay ? start + 86_400_000 : start + 30 * 60_000);

  if (start >= to || end <= from) return null;
  return {
    id: fields['UID'] ?? `${start}`,
    calendarId: 'ics',
    title: fields['SUMMARY'] ?? 'Busy',
    start,
    end,
    allDay,
  };
}

/** "20260823T140000Z", "20260823T140000" or "20260823". */
function icsTime(raw: string): number | null {
  const value = raw.trim();
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (utc !== null) {
    return Date.UTC(+utc[1]!, +utc[2]! - 1, +utc[3]!, +utc[4]!, +utc[5]!, +utc[6]!);
  }
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (local !== null) {
    return new Date(+local[1]!, +local[2]! - 1, +local[3]!, +local[4]!, +local[5]!, +local[6]!).getTime();
  }
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date !== null) return new Date(+date[1]!, +date[2]! - 1, +date[3]!).getTime();
  return null;
}

export { dayStr, type BridgeEvent, type Task };
