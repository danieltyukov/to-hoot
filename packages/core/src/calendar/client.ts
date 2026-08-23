// The client side of the Apps Script calendar bridge.
//
// It talks over `Platform.http`, which is `tauri-plugin-http` on the desktop and
// `CapacitorHttp` on Android. Neither goes through the browser fetch stack, and
// that is not an implementation detail: Apps Script exposes only `doGet` and
// `doPost`, so a CORS preflight can never be answered, and `/exec` redirects to
// `script.googleusercontent.com`, which a preflighted request may not follow.
// A `fetch` in here would work in no shipped configuration of this app.
//
// Everything account-specific arrives through the config, so nothing is bound
// to one person's script, secret or calendar.

import type { Http, HttpResponse } from '../platform.js';
import {
  MAX_DELETE_IDS,
  MAX_WRITE_ENTRIES,
  type BridgeErrorCode,
  type BridgeEvent,
  type BridgeOk,
  type WriteLogEntry,
  type WriteResult,
} from './bridge.js';

export interface CalendarBridgeConfig {
  /** The `/exec` URL of the user's own deployment. */
  execUrl: string;
  /** The shared secret, which travels in the body and never in the URL. */
  secret: string;
}

export interface ListEventsOptions {
  /** Epoch milliseconds. The caller owns the day boundary. */
  from: number;
  days: number;
  /** Defaults to whatever the script treats as primary. */
  calendarId?: string;
  /** A stop, so a script that always returns a token cannot spin forever. */
  maxPages?: number;
}

export type CalendarErrorCode =
  | BridgeErrorCode
  | 'http'
  | 'not-json'
  | 'transport'
  | 'bad-response'
  | 'too-many-pages';

export class CalendarBridgeError extends Error {
  constructor(
    readonly code: CalendarErrorCode,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarBridgeError';
  }
}

/** True for the one failure the setup wizard has to phrase differently. */
export function isSecretRejected(err: unknown): boolean {
  return err instanceof CalendarBridgeError && err.code === 'unauthorized';
}

const DEFAULT_MAX_PAGES = 20;

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

export class CalendarBridgeClient {
  private readonly http: Http;
  private readonly execUrl: string;
  private readonly secret: string;

  constructor(http: Http, config: CalendarBridgeConfig) {
    if (config.execUrl.length === 0) {
      throw new CalendarBridgeError('bad-request', undefined, 'the calendar bridge has no deployment URL configured');
    }
    if (!config.execUrl.startsWith('https://')) {
      throw new CalendarBridgeError(
        'bad-request',
        undefined,
        'the calendar bridge URL must be https: the shared secret travels in the request body',
      );
    }
    this.http = http;
    this.execUrl = config.execUrl;
    this.secret = config.secret;
  }

  /**
   * Every event in the window, paging until the script stops handing out
   * tokens. The loop lives here rather than in the script because a handler
   * that walked a long window would hit the six-minute execution limit and
   * return nothing at all.
   */
  async listEvents(options: ListEventsOptions): Promise<BridgeEvent[]> {
    const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
    const events: BridgeEvent[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const body: Record<string, unknown> = { action: 'listEvents', from: options.from, days: options.days };
      if (options.calendarId !== undefined) body['calendarId'] = options.calendarId;
      if (pageToken !== undefined) body['pageToken'] = pageToken;

      const answer = await this.post(body);
      if (answer.action !== 'listEvents' || !Array.isArray(answer.events)) {
        throw new CalendarBridgeError('bad-response', undefined, 'the bridge answered listEvents with something else');
      }
      events.push(...answer.events);
      pageToken = answer.nextPageToken;
      if (pageToken === undefined || pageToken.length === 0) return events;
    }

    throw new CalendarBridgeError(
      'too-many-pages',
      undefined,
      `the calendar bridge was still paging after ${maxPages} requests`,
    );
  }

  /**
   * Writes the given blocks to the log calendar, in batches the six-minute
   * limit can serve. Batches run one after another on purpose: the write queue
   * above this is what controls concurrency.
   */
  async writeLog(entries: readonly WriteLogEntry[]): Promise<WriteResult[]> {
    const written: WriteResult[] = [];
    for (const batch of chunk(entries, MAX_WRITE_ENTRIES)) {
      const answer = await this.post({ action: 'writeLog', entries: batch });
      if (answer.action !== 'writeLog' || !Array.isArray(answer.written)) {
        throw new CalendarBridgeError('bad-response', undefined, 'the bridge answered writeLog with something else');
      }
      written.push(...answer.written);
    }
    return written;
  }

  /** Removes blocks by their `toHootId`. Ids with no event are reported, not thrown. */
  async deleteLog(toHootIds: readonly string[]): Promise<{ deleted: string[]; missing: string[] }> {
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const batch of chunk(toHootIds, MAX_DELETE_IDS)) {
      const answer = await this.post({ action: 'deleteLog', toHootIds: batch });
      if (answer.action !== 'deleteLog') {
        throw new CalendarBridgeError('bad-response', undefined, 'the bridge answered deleteLog with something else');
      }
      deleted.push(...answer.deleted);
      missing.push(...answer.missing);
    }
    return { deleted, missing };
  }

  private async post(body: Record<string, unknown>): Promise<BridgeOk> {
    let response: HttpResponse;
    let text: string;
    try {
      response = await this.http({
        url: this.execUrl,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The secret goes in the body. Apps Script logs request URLs, so a
        // secret in the query string is a secret written to Google's logs.
        body: JSON.stringify({ secret: this.secret, ...body }),
      });
      text = await response.text();
    } catch (err) {
      throw new CalendarBridgeError('transport', undefined, `the calendar bridge could not be reached: ${messageOf(err)}`);
    }

    if (response.status !== 200) {
      throw new CalendarBridgeError(
        'http',
        response.status,
        `the calendar bridge answered ${response.status}: check that the /exec URL is the current deployment`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Google serves an HTML sign-in page rather than running the script when
      // the deployment is not readable by anyone with the link.
      throw new CalendarBridgeError(
        'not-json',
        response.status,
        'the calendar bridge answered with a web page rather than JSON: check that the deployment has "Anyone with the link" access',
      );
    }

    if (!isRecord(parsed)) {
      throw new CalendarBridgeError('bad-response', response.status, 'the calendar bridge answered with something that is not an object');
    }
    if (parsed['ok'] !== true) {
      const code = parsed['code'];
      const error = parsed['error'];
      throw new CalendarBridgeError(
        typeof code === 'string' ? (code as CalendarErrorCode) : 'bad-response',
        response.status,
        typeof error === 'string' ? error : 'the calendar bridge refused the request',
      );
    }
    return parsed as unknown as BridgeOk;
  }
}
