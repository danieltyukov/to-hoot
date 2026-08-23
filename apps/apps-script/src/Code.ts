// The Google Apps Script half of the calendar bridge: the Google globals, and
// nothing else. Every decision worth testing lives in
// `packages/core/src/calendar/bridge.ts`, which this file bundles.
//
// The user deploys this to their OWN Google account. Nothing here names an
// account, a calendar or a URL: the shared secret comes from Script Properties,
// the calendar is found or created at runtime, and the deployment URL is
// whatever Google hands back.
//
// Apps Script exposes exactly two entry points, `doGet` and `doPost`. There is
// no `doOptions` and never will be, so a CORS preflight cannot be answered and
// no browser can call this. The app reaches it from Rust (`tauri-plugin-http`)
// and from native Android (`CapacitorHttp`) instead.
//
// The import below is a relative path into `packages/core` rather than a package
// import, so esbuild bundles the shared protocol straight from source. The
// output is a single file a human is expected to read before pasting it into
// their own account, and a build-order dependency on another package's `dist`
// would earn nothing.

import {
  BRIDGE_VERSION,
  LOG_CALENDAR_NAME,
  handleBridgeRequest,
  pickLogCalendar,
  scriptFailure,
  type CalendarListEntry,
  type CalendarPort,
  type EventResource,
  type ListOptions,
  type ListPage,
  type RawCalendarEvent,
} from '../../../packages/core/src/calendar/bridge.js';

// The Google globals, declared to the width they are used and no wider. A types
// package would describe hundreds of services this script never touches.

interface ScriptProperties {
  getProperty(key: string): string | null;
  setProperty(key: string, value: string): void;
}

declare const PropertiesService: {
  getScriptProperties(): ScriptProperties;
};

interface TextOutput {
  setMimeType(mimeType: unknown): TextOutput;
}

declare const ContentService: {
  createTextOutput(value: string): TextOutput;
  MimeType: { JSON: unknown };
};

declare const Session: {
  getScriptTimeZone(): string;
};

interface CalendarResource {
  id?: string;
  summary?: string;
  description?: string;
  timeZone?: string;
}

interface CalendarListPage {
  items?: CalendarListEntry[];
  nextPageToken?: string;
}

/** The Calendar advanced service (v3). Absent unless the user enabled it. */
interface CalendarAdvancedService {
  Events: {
    list(calendarId: string, optionalArgs: ListOptions): ListPage;
    insert(resource: EventResource, calendarId: string): RawCalendarEvent;
    update(resource: EventResource, calendarId: string, eventId: string): RawCalendarEvent;
    remove(calendarId: string, eventId: string): void;
  };
  Calendars: {
    get(calendarId: string): CalendarResource;
    insert(resource: CalendarResource): CalendarResource;
  };
  CalendarList: {
    list(optionalArgs: Record<string, unknown>): CalendarListPage;
  };
  Settings: {
    get(setting: string): { id?: string; value?: string };
  };
}

declare const Calendar: CalendarAdvancedService;

interface PostEvent {
  postData?: { contents?: string };
}

/**
 * Set by hand in Project Settings -> Script Properties. Never in this file:
 * `clasp push` uploads the source to a Google-hosted project, and the source is
 * also what the setup wizard shows on screen for pasting.
 */
const SECRET_PROPERTY = 'TO_HOOT_SECRET';
/** Cached so a write does not re-scan the calendar list every time. */
const LOG_CALENDAR_PROPERTY = 'TO_HOOT_LOG_CALENDAR_ID';
/** 250 calendars a page. A stop, not a limit anyone reaches. */
const MAX_CALENDAR_LIST_PAGES = 20;

function scriptProperties(): ScriptProperties {
  return PropertiesService.getScriptProperties();
}

function scriptSecret(): string {
  return scriptProperties().getProperty(SECRET_PROPERTY) ?? '';
}

function json(value: unknown): TextOutput {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * The advanced service, or undefined when it was never enabled. Referring to
 * `Calendar` directly in that state throws a ReferenceError, and the resulting
 * HTML error page is the least diagnosable failure this bridge has.
 */
function calendarService(): CalendarAdvancedService | undefined {
  return typeof Calendar === 'undefined' ? undefined : Calendar;
}

function calendarExists(api: CalendarAdvancedService, calendarId: string): boolean {
  try {
    return typeof api.Calendars.get(calendarId).id === 'string';
  } catch {
    return false;
  }
}

function writableCalendars(api: CalendarAdvancedService): CalendarListEntry[] {
  const out: CalendarListEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_CALENDAR_LIST_PAGES; page++) {
    const args: Record<string, unknown> = { maxResults: 250, minAccessRole: 'writer', showHidden: true };
    if (pageToken !== undefined) args['pageToken'] = pageToken;
    const answer = api.CalendarList.list(args);
    for (const item of answer.items ?? []) out.push(item);
    pageToken = answer.nextPageToken;
    if (pageToken === undefined || pageToken.length === 0) break;
  }
  return out;
}

/**
 * The timezone of the user's calendar, which is not the script's: the manifest
 * pins the script to UTC so nothing here ever formats a local time by accident.
 *
 * It only labels the log calendar, so an unreadable setting falls back instead
 * of failing the write.
 */
function calendarTimeZone(api: CalendarAdvancedService): string {
  try {
    const value = api.Settings.get('timezone').value;
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    // Some Workspace configurations refuse the settings read.
  }
  return Session.getScriptTimeZone();
}

/**
 * The dedicated log calendar, created on first write.
 *
 * Write-back never touches the user's real calendars. A bug here can then only
 * damage events this app wrote, and the whole layer switches off with one
 * checkbox in Google Calendar rather than a support request.
 *
 * The cached id is checked before it is trusted: a user who deletes the
 * calendar would otherwise get "Not Found" on every write forever.
 */
function logCalendarId(api: CalendarAdvancedService): string {
  const props = scriptProperties();
  const cached = props.getProperty(LOG_CALENDAR_PROPERTY);
  if (cached !== null && cached.length > 0 && calendarExists(api, cached)) return cached;

  const adopted = pickLogCalendar(writableCalendars(api), LOG_CALENDAR_NAME);
  if (adopted !== undefined) {
    props.setProperty(LOG_CALENDAR_PROPERTY, adopted);
    return adopted;
  }

  const created = api.Calendars.insert({
    summary: LOG_CALENDAR_NAME,
    description: 'Time tracked in to-hoot. Created by the to-hoot calendar bridge; safe to hide or delete.',
    timeZone: calendarTimeZone(api),
  });
  const id = created.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Google created the log calendar but returned no id');
  }
  props.setProperty(LOG_CALENDAR_PROPERTY, id);
  return id;
}

/** Every method a straight pass-through; the choices are all in bridge.ts. */
function makeCalendarPort(): CalendarPort | undefined {
  const api = calendarService();
  if (api === undefined) return undefined;
  return {
    list: (calendarId, opts) => api.Events.list(calendarId, opts),
    insert: (calendarId, resource) => api.Events.insert(resource, calendarId),
    update: (calendarId, eventId, resource) => api.Events.update(resource, calendarId, eventId),
    remove: (calendarId, eventId) => {
      api.Events.remove(calendarId, eventId);
    },
    logCalendarId: () => logCalendarId(api),
  };
}

/**
 * The one entry point that does anything. Always HTTP 200, always JSON,
 * including for a rejected secret: Apps Script's own failure responses are HTML
 * pages, so a client that had to tell them apart by status code could not.
 */
function doPost(e: PostEvent | undefined): TextOutput {
  try {
    const raw = e && e.postData ? e.postData.contents : undefined;
    return json(handleBridgeRequest(raw, { secret: scriptSecret(), calendar: makeCalendarPort() }));
  } catch (err) {
    return json(scriptFailure(err));
  }
}

/**
 * A deployment probe, for the setup wizard and for anyone opening the URL.
 *
 * It carries no calendar data and takes no secret, because a GET reaches Google
 * with its query string in the logs. What it does report is the two things that
 * are otherwise invisible from outside: whether the secret was ever set, and
 * whether the Calendar advanced service is on.
 */
function doGet(): TextOutput {
  try {
    return json({
      ok: true,
      service: 'to-hoot calendar bridge',
      version: BRIDGE_VERSION,
      secretConfigured: scriptSecret().length > 0,
      calendarServiceEnabled: calendarService() !== undefined,
    });
  } catch (err) {
    return json(scriptFailure(err));
  }
}

// Named exports so the esbuild footer can hand them to Apps Script as the
// top-level `doGet` and `doPost` a web app deployment requires.
export { doGet, doPost };
