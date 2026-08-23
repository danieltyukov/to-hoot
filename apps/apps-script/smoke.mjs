// Runs the BUILT bundle against stubbed Google globals.
//
// The unit tests in packages/core cover the protocol; they cannot cover the one
// thing that only exists after a build: that dist/Code.js still exposes
// top-level `doGet` and `doPost` functions, that the bundle evaluates in a bare
// V8 context, and that a wrong secret is turned away before the calendar is
// touched. Getting that wrong is invisible until a user pastes the file into
// their own account.
//
//   node smoke.mjs        (or: npm run smoke -w @to-hoot/apps-script)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = 'a-secret-only-this-test-knows';

function makeGoogleGlobals({ secret = SECRET, withCalendar = true } = {}) {
  const properties = new Map();
  if (secret !== null) properties.set('TO_HOOT_SECRET', secret);

  const events = new Map();
  const calls = { list: [], insert: 0, update: 0, remove: 0, calendarsInserted: [] };
  let nextEventId = 1;

  const calendar = {
    Events: {
      list(calendarId, args) {
        calls.list.push({ calendarId, args });
        if (args.privateExtendedProperty !== undefined) {
          const at = args.privateExtendedProperty.indexOf('=');
          const key = args.privateExtendedProperty.slice(0, at);
          const value = args.privateExtendedProperty.slice(at + 1);
          return {
            items: [...events.values()].filter(e => e.extendedProperties?.private?.[key] === value),
          };
        }
        return {
          items: [
            {
              id: 'seeded-1',
              summary: 'Standup',
              start: { dateTime: '2026-08-23T09:00:00+02:00' },
              end: { dateTime: '2026-08-23T09:15:00+02:00' },
            },
          ],
        };
      },
      insert(resource, calendarId) {
        calls.insert++;
        const stored = { ...resource, id: `ev-${nextEventId++}` };
        events.set(stored.id, stored);
        return stored;
      },
      update(resource, calendarId, eventId) {
        calls.update++;
        const stored = { ...resource, id: eventId };
        events.set(eventId, stored);
        return stored;
      },
      remove(calendarId, eventId) {
        calls.remove++;
        events.delete(eventId);
      },
    },
    Calendars: {
      get(calendarId) {
        if (calendarId === 'log-cal') return { id: 'log-cal' };
        throw new Error('Not Found');
      },
      insert(resource) {
        calls.calendarsInserted.push(resource);
        return { ...resource, id: 'log-cal' };
      },
    },
    CalendarList: {
      list() {
        return { items: [{ id: 'primary-cal', summary: 'Work', accessRole: 'owner' }] };
      },
    },
    Settings: {
      get() {
        return { id: 'timezone', value: 'Europe/Amsterdam' };
      },
    },
  };

  const globals = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => (properties.has(key) ? properties.get(key) : null),
        setProperty: (key, value) => properties.set(key, value),
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: value => ({
        value,
        setMimeType() {
          return this;
        },
      }),
    },
    Session: { getScriptTimeZone: () => 'Etc/UTC' },
  };
  if (withCalendar) globals.Calendar = calendar;
  return { globals, calls, events, properties };
}

function load(globals) {
  const source = readFileSync(resolve(here, 'dist/Code.js'), 'utf8');
  const context = createContext({ ...globals, JSON, Date, Math, Number, Object, Array, String, Error });
  runInContext(source, context, { filename: 'dist/Code.js' });
  return context;
}

function post(context, body) {
  const out = context.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.value);
}

let checks = 0;
function check(what, fn) {
  fn();
  checks++;
  process.stdout.write(`ok  ${what}\n`);
}

// The bundle evaluates and exposes the two entry points a web app needs.
const configured = makeGoogleGlobals();
const script = load(configured.globals);
check('the bundle exposes top-level doGet and doPost', () => {
  assert.equal(typeof script.doGet, 'function');
  assert.equal(typeof script.doPost, 'function');
});

check('doGet reports the deployment without asking for a secret', () => {
  const answer = JSON.parse(script.doGet().value);
  assert.equal(answer.ok, true);
  assert.equal(answer.secretConfigured, true);
  assert.equal(answer.calendarServiceEnabled, true);
});

check('a wrong secret is refused with HTTP 200 JSON and no calendar call', () => {
  const answer = post(script, { secret: 'guessed', action: 'listEvents', from: 0, days: 1 });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'unauthorized');
  assert.equal(configured.calls.list.length, 0);
});

check('listEvents expands recurrence and maps the event', () => {
  const answer = post(script, { secret: SECRET, action: 'listEvents', from: 1_755_900_000_000, days: 1 });
  assert.equal(answer.ok, true);
  assert.equal(configured.calls.list[0].args.singleEvents, true);
  assert.equal(configured.calls.list[0].args.orderBy, 'startTime');
  assert.deepEqual(answer.events, [
    {
      id: 'seeded-1',
      calendarId: 'primary',
      title: 'Standup',
      start: Date.parse('2026-08-23T07:00:00Z'),
      end: Date.parse('2026-08-23T07:15:00Z'),
      allDay: false,
    },
  ]);
});

check('the first write creates the log calendar rather than using a real one', () => {
  const entry = { toHootId: 't1::2026-08-23', title: 'Write the report', start: 1_755_936_000_000, end: 1_755_939_600_000 };
  const answer = post(script, { secret: SECRET, action: 'writeLog', entries: [entry] });
  assert.equal(answer.ok, true);
  assert.equal(answer.calendarId, 'log-cal');
  assert.deepEqual(configured.calls.calendarsInserted.map(c => c.summary), ['to-hoot log']);
  assert.equal(configured.calls.calendarsInserted[0].timeZone, 'Europe/Amsterdam');
  assert.deepEqual(answer.written, [{ toHootId: entry.toHootId, eventId: 'ev-1', created: true }]);
});

check('writing the same block again updates it instead of inserting a second', () => {
  const entry = { toHootId: 't1::2026-08-23', title: 'Write the report', start: 1_755_936_000_000, end: 1_755_943_200_000 };
  const answer = post(script, { secret: SECRET, action: 'writeLog', entries: [entry] });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.written, [{ toHootId: entry.toHootId, eventId: 'ev-1', created: false }]);
  assert.equal(configured.calls.insert, 1);
  assert.equal(configured.calls.update, 1);
  assert.equal(configured.events.size, 1);
});

check('deleteLog removes what it wrote and reports what it cannot find', () => {
  const answer = post(script, { secret: SECRET, action: 'deleteLog', toHootIds: ['t1::2026-08-23', 't9::2026-08-23'] });
  assert.deepEqual(answer.deleted, ['t1::2026-08-23']);
  assert.deepEqual(answer.missing, ['t9::2026-08-23']);
  assert.equal(configured.events.size, 0);
});

// A deployment where the user never enabled the advanced service.
const withoutService = makeGoogleGlobals({ withCalendar: false });
const scriptWithoutService = load(withoutService.globals);
check('a missing Calendar service is named, not left as a ReferenceError', () => {
  const answer = post(scriptWithoutService, { secret: SECRET, action: 'listEvents', from: 0, days: 1 });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'calendar-service-disabled');
  assert.match(answer.error, /advanced service/i);
});

// A deployment where the secret was never set.
const unconfigured = makeGoogleGlobals({ secret: null });
const scriptUnconfigured = load(unconfigured.globals);
check('an unconfigured deployment is closed, not open', () => {
  for (const secret of ['', SECRET]) {
    const answer = post(scriptUnconfigured, { secret, action: 'listEvents', from: 0, days: 1 });
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'unauthorized');
  }
  assert.equal(unconfigured.calls.list.length, 0);
  assert.equal(JSON.parse(scriptUnconfigured.doGet().value).secretConfigured, false);
});

process.stdout.write(`\n${checks} checks passed against dist/Code.js\n`);
