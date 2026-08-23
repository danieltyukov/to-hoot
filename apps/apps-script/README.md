# to-hoot calendar bridge

A Google Apps Script web app that reads the user's calendar and writes tracked
time back to a separate "to-hoot log" calendar. Each user deploys it to their
own Google account; nothing in here is bound to any particular account, calendar
or URL.

The app never calls it from the browser fetch stack. Apps Script exposes only
`doGet` and `doPost`, so a CORS preflight can never be answered, and `/exec`
redirects to `script.googleusercontent.com`, which a preflighted request may not
follow. The desktop shell calls it from Rust through `tauri-plugin-http` and the
Android shell from native code through `CapacitorHttp`.

## Layout

    src/Code.ts        the Google globals and the two entry points, nothing else
    appsscript.json    manifest: V8, Calendar v3 advanced service, web app access
    esbuild.config.js  bundles src into dist/Code.js, which is what gets pushed
    smoke.mjs          runs the built bundle against stubbed Google globals
    dist/              build output, not committed

Everything worth testing lives in `packages/core/src/calendar/bridge.ts`, which
`Code.ts` imports and esbuild inlines. That file is also what the client in
`packages/core/src/calendar/client.ts` builds its requests against, so the two
ends of the protocol cannot drift apart.

## Build

    npm run build -w @to-hoot/apps-script     # typecheck, then bundle to dist/
    npm run smoke -w @to-hoot/apps-script     # build, then exercise dist/Code.js

The build step is mandatory rather than a convenience: clasp v3 no longer
transpiles TypeScript, so what reaches Google has to be JavaScript already.

## Deploying

Two ways in. Both end with an `/exec` URL to paste back into the app.

By hand, which is what the setup wizard walks through:

1. Create a project at `script.google.com`, and paste in the contents of
   `dist/Code.js`.
2. Services -> add **Calendar**, version v3, identifier `Calendar`. Without it
   the bridge answers `calendar-service-disabled` and nothing else.
3. Project Settings -> Script Properties -> add `TO_HOOT_SECRET`, with the
   secret the app generated. The secret is never in the source: `clasp push`
   uploads source to a Google-hosted project, and the source is also what the
   wizard shows on screen.
4. Deploy -> New deployment -> Web app, "Execute as: Me", "Who has access:
   Anyone". "Anyone" here means no Google sign-in, which is why the shared
   secret is the whole of the authentication.
5. Copy the `/exec` URL into the app, and use Test connection.

With clasp, for anyone who would rather not click:

    npm run create -w @to-hoot/apps-script    # writes .clasp.json (never committed)
    npm run push -w @to-hoot/apps-script
    npm run deploy -w @to-hoot/apps-script
    npm run deployments -w @to-hoot/apps-script

clasp v3 renamed these: `create-script`, `create-deployment`, `list-deployments`.
Notes written against clasp v2 do not apply. Steps 2 and 3 above still have to
happen in the editor: the advanced service comes from the manifest, but the
Script Property does not.

`.clasp.json` holds a script id specific to one person's project, so it is
ignored by git. Copy `.clasp.json.example` if you want to fill it in by hand.

## The protocol

    POST { secret, action: 'listEvents', from, days, calendarId?, pageToken? }
    POST { secret, action: 'writeLog',   entries: [{ toHootId, title, start, end }] }
    POST { secret, action: 'deleteLog',  toHootIds: [] }

`from`, `start` and `end` are epoch milliseconds; `from` also accepts an ISO
string that carries a zone. An offsetless ISO string is refused, because
`Date.parse` would read it in the script's timezone, which belongs to whoever
deployed it.

The secret travels in the body and never in the query string, because Apps
Script logs request URLs.

Every answer is HTTP 200 with a JSON body, including every failure, because Apps
Script's own error responses are HTML pages that no client can parse. Failures
carry a `code`: `unauthorized`, `bad-request`, `unsupported-action`,
`calendar-error`, `calendar-service-disabled` or `script-error`.

A GET returns a small status object with no calendar data and no secret: the
protocol version, whether `TO_HOOT_SECRET` is set, and whether the Calendar
service is enabled. It exists so the wizard can tell "not deployed" apart from
"deployed but not finished".

## Write-back

Writes go to a separate calendar named "to-hoot log", found or created on first
use. The user's real calendars are never modified: a bug in write-back can then
only damage events this app wrote, and the whole layer switches off with one
checkbox in Google Calendar.

Every written event carries `extendedProperties.private.toHootId`, which is
`<taskId>::<day>`. A re-sync looks the event up by that key and updates it
rather than inserting, so writing the same block twice leaves one event. That is
only available through the Calendar advanced service, which is also why reading
uses `singleEvents: true` with `orderBy: 'startTime'` to expand recurrence.

## The six-minute limit

An Apps Script execution is killed at six minutes, on consumer and Workspace
accounts alike. So no handler here walks a long history: `listEvents` returns one
page and a `nextPageToken` and the client asks again, `writeLog` takes at most 50
entries, and `deleteLog` at most 100. The client chunks and loops.
