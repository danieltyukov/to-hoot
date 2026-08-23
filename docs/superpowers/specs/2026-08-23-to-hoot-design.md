# to-hoot design

Date: 2026-08-23
Status: approved, ready for implementation planning

A personal productivity and time-tracking app for one user, modelled on
super-productivity but deliberately much smaller. Runs as a Linux desktop app and
an Android app from one codebase, syncs between them through a private GitHub
repository, reads and writes Google Calendar, and exposes itself to Claude over
MCP.

## 1. Goals

1. One task list that is the same on desktop and phone, with no server to run.
2. Time tracking that is trustworthy: the numbers must survive laptop sleep,
   backgrounded tabs, and a phone that Android suspended.
3. Time tracked against scheduled calendar events, and the work actually done
   written back to Google Calendar.
4. Claude can read and change the task list from Claude Code, Claude web, and
   Claude Cowork.
5. It looks like a person designed it.
6. It costs nothing to build or run, forever, with no credit card anywhere.
7. Anyone else can clone it, point it at their own accounts, and configure the
   whole thing from inside the app without touching a config file.

## 2. Non-goals

Explicitly out of scope for v1, with reasons.

| Not building | Why |
|---|---|
| Recurring tasks | Real value, high cost. Deferred to v2, and when built it uses RRULE rather than a bespoke weekday-boolean model. |
| Reminders | Needs Android notification permission plumbing and an exact-alarm story. Deferred. |
| Backlog, notes, focus mode, Pomodoro | Ceremony around the core loop, not the loop. |
| Metrics, history, worklog, charts | These are queries over the event log, not features. |
| Issue provider integrations | The largest subtree in super-productivity and irrelevant to a single user. |
| Boards, sections, task view customizer | Saved-search UI for people with more projects than one person has. |
| Plugin system | The MCP server is the plugin system. |
| Multi-user, encryption at rest, conflict review UI | Consequences of untrusted servers and a released fleet. Neither applies. |
| iOS | No Apple hardware, no developer account, and the account would cost money. |

## 3. Constraints that shaped the design

These are verified facts, not assumptions. Each one moved a decision.

| Constraint | Consequence |
|---|---|
| Cloudflare Workers free plan allows 10 ms CPU per request | The Worker reads a prebuilt snapshot and never replays the event log. |
| Cloudflare free plan allows 50 subrequests per request | One conditional GET per tool call, never one GET per event file. |
| Claude's remote MCP infrastructure speaks the 2025-era protocol | The Worker must keep `legacy: 'stateless'`. Setting `legacy: 'reject'` would pass local tests and break Claude. |
| Anthropic supports `none` as a connector auth type | No OAuth 2.1 authorization server. A capability URL with the secret in the path is enough. |
| Apps Script cannot answer a CORS preflight and has no `doOptions` | All calendar traffic goes through `tauri-plugin-http` (Rust) or `CapacitorHttp` (native), never the browser fetch stack. |
| Android WorkManager's periodic floor is 15 minutes, and Doze caps `allowWhileIdle` at once per 9 minutes | Background sync is opportunistic, never a correctness guarantee. Safe only because the event log is append-only. |
| Capacitor's CLI breaks on pnpm's symlinked node_modules | The monorepo uses npm workspaces, which hoists by default. |
| GitHub Git Data API commits N files in 4 calls, atomically | Appending events and rewriting the snapshot happen in one commit. |
| A 304 from a conditional request does not count against the primary rate limit | Polling for remote changes is free. |
| Fontshare's ITF FFL prohibits redistribution and subsetting | Only SIL OFL fonts, because the code repo is public and the fonts are committed. |
| Maestro does not claim API 35/36 support | E2E runs against an API 34 AVD. |

## 4. Repository layout

Two repositories.

**`danieltyukov/to-hoot`, public.** Code, CI, and the APK releases.

    packages/core/        pure TypeScript, no DOM: models, event log, merge, tick
    packages/ui/          React 19 + Vite. The entire application.
    apps/desktop/         Tauri 2.11 shell -> AppImage and .deb
    apps/mobile/          Capacitor 8.5 shell -> android/ -> signed APK
    apps/mcp/             stdio MCP server for Claude Code
    apps/worker/          Cloudflare Worker, remote MCP for Claude web and Cowork
    apps/apps-script/     Google Calendar bridge, esbuild output pushed by clasp
    site/                 one-page project site -> GitHub Pages
    docs/
    .github/workflows/
    LICENSE               MIT
    README.md CONTRIBUTING.md SECURITY.md

**`danieltyukov/to-hoot-data`, private.** Datastore only. No code, no Actions, no
CI. Its entire contents are the event log and snapshot described in section 6.

`packages/ui` is the whole app. The desktop and mobile targets are shells that
supply a platform adapter. That is what makes one design pass cover both.

Package manager is **npm workspaces**. Not pnpm: Capacitor's CLI does not follow
Node module resolution and fails against pnpm's symlinked `node_modules`
(ionic-team/capacitor#865, open). npm hoists by default, so the failure mode
cannot occur rather than being worked around.

### Platform adapter

`packages/core` defines one interface that each shell implements. Nothing in
`core` or `ui` imports a Tauri or Capacitor module directly.

    interface Platform {
      http(req): Promise<Response>     // tauri-plugin-http | CapacitorHttp
      store: KeyValueStore             // tauri-plugin-store | @capacitor/preferences
      notify(opts): Promise<void>
      onResume(cb): Unsubscribe
      idleSeconds?(): Promise<number>  // desktop only; undefined on mobile
    }

This is the seam that keeps the app testable in a plain browser under Playwright,
where the adapter is backed by `fetch` and `localStorage`.

## 5. Data model

Entities are deliberately few. Field weights come from reading
super-productivity's model and discarding what it marked legacy.

### Task

    interface Task {
      id: string                    // ULID, time-ordered
      title: string
      notes?: string
      isDone: boolean
      doneOn?: number

      projectId: string             // required; "inbox" is the default project
      tagIds: string[]              // never contains "TODAY"

      parentId?: string             // max depth 2, enforced in the API
      subTaskIds: string[]

      timeEstimate: number          // ms
      timeSpent: number             // DERIVED, never written directly
      timeSpentOnDay: Record<string, number>   // "YYYY-MM-DD" -> ms

      dueDay?: string               // "YYYY-MM-DD"      | mutually
      dueWithTime?: number          // epoch ms          | exclusive

      calendarEventId?: string      // linked calendar event, if any
      calendarWritten: Record<string, number>  // day -> ms already written back

      created: number
      updated: number
    }

Five rules that are load-bearing:

1. **`timeSpentOnDay` is the storage. `timeSpent` is a derived sum.** Every
   report, total, and progress ring is a projection of that map. Writing
   `timeSpent` directly is a bug.
2. **Subtasks are capped at two levels.** `addTask` rejects a `parentId` that
   itself has a parent. This is not a limitation to remove later; it is what
   keeps ordering, roll-up, and the timeline tractable.
3. **`dueDay` and `dueWithTime` are mutually exclusive.** Setting one clears the
   other. Readers check `dueWithTime` first. Planning is day-level; scheduling is
   time-level.
4. **`calendarWritten` is the idempotency ledger.** Write-back pushes
   `timeSpentOnDay[day] - calendarWritten[day]` and never a total. A repeated
   sync is a no-op.
5. **Parent totals are derived, not stored.** A parent's total time is computed at
   read time as its own `timeSpentOnDay` sum plus each child's. It is never stored on
   the parent and never emitted as a second event. Under a replay architecture a
   stored roll-up can double count (if a delta is replayed twice, or emitted for both
   child and parent) and can drift from `timeSpentOnDay`; a derived total can do
   neither. This is a deliberate departure from super-productivity, whose incremental
   roll-up follows from its stored-state model rather than from the data.

### Project, Tag, and Today

    interface Project { id, title, color, taskIds: string[], isArchived: boolean }
    interface Tag     { id, title, color, taskIds: string[] }

The ordered `taskIds` array lives on the container, not as an order field on the
task. Ordering is the entity with the nastiest merge semantics, so it is settled
deliberately: **whole-array last-write-wins**, chosen consciously rather than
arrived at.

**Today is computed, never stored.** Membership derives from `dueDay` and
`dueWithTime`. A separate `todayOrder: string[]` stores ordering only. There is
no `isToday` boolean, because a stored flag and a due date can disagree and then
someone has to decide which is right.

## 6. Sync

A private GitHub repository is the datastore. The model is an append-only event
log with periodic snapshots.

### Layout of `to-hoot-data`

    snapshot.json                     rebuilt state, plus the log position it covers
    snapshot-<seq>-<rand>.json        immutable historical snapshots
    events/<deviceId>/<ulid>.json     one file per sync batch, append-only
    meta.json                         device registry, schema version

Each device writes only under its own `events/<deviceId>/` prefix, so two devices
never write the same path and a write can never collide with another device's
write. Merge becomes replay, not reconciliation.

### Write path

One commit per sync, using the Git Data API. Four calls regardless of how many
files change, because small file contents are inlined into the tree rather than
uploaded as separate blobs:

    GET   /repos/:o/:r/git/ref/heads/main       -> parent commit SHA
    POST  /repos/:o/:r/git/trees                -> tree SHA (base_tree + inline content)
    POST  /repos/:o/:r/git/commits              -> commit SHA
    PATCH /repos/:o/:r/git/refs/heads/main      -> move the branch

The `PATCH` fails if the ref moved since the `GET`. **That rejection is the
concurrency check.** On failure, re-read and retry from step one. `force: true`
is never passed, anywhere, under any condition. A force push against an
append-only log is a data-loss weapon, and the design's correctness rests on the
log being genuinely append-only.

Because a tree write can touch any set of paths, **appending events and rewriting
the snapshot happen in the same commit.** There is no window in which the
snapshot disagrees with the log, which makes compaction an ordinary write rather
than a dangerous operation.

### Read path

    GET /repos/:o/:r/commits?sha=main&per_page=1   with If-None-Match

A 304 does not count against the primary rate limit, so polling is free. When the
ETag moves:

    GET /repos/:o/:r/git/trees/<sha>?recursive=1

returns every path and blob SHA in one request. Blobs are content-addressed and
immutable, so a local SHA-to-content cache never needs invalidating and only
genuinely new files are fetched.

Budget at one sync per minute per device: roughly 240 requests/hour against a
5,000/hour primary limit and a 500/hour content-generating secondary limit.

### Events and merge

    interface Event {
      id: string          // ULID, time-ordered
      deviceId: string
      ts: number          // originating device wall clock
      type: 'create' | 'update' | 'delete' | 'timeDelta'
      entity: 'task' | 'project' | 'tag' | 'settings'
      entityId: string
      payload: unknown
      schemaVersion: number
    }

Replay is ordered by `(ts, deviceId)`, with `deviceId` breaking ties stably so
every device computes the same state from the same log.

Resolution, in order:

1. **`timeDelta` events are commutative.** They carry an increment, not a total,
   so two devices tracking time concurrently produce a sum rather than one
   overwriting the other. This is the single most important special case: time is
   the data most likely to be edited on two devices at once, and it is also the
   data where last-write-wins is most obviously wrong.
2. **Disjoint field updates merge.** Two updates touching different fields of the
   same task both apply.
3. **Otherwise last-write-wins per field**, by `ts`, ties broken by `deviceId`.
4. **Delete beats concurrent update.** Otherwise a late update resurrects a
   deleted task.

### Compaction

When the log exceeds 500 events past the snapshot, the next sync folds everything
older into a new snapshot and deletes those event files, in the same commit.

Snapshots are written to **immutable filenames** (`snapshot-<seq>-<rand>.json`)
and `snapshot.json` records which one it was built from. A concurrent compactor
writes a different file, so a snapshot pointer can never be stranded by another
device clobbering a fixed path.

### Schema versioning

Every persisted field added after v1 is **optional with a default**. A required
field added to a persisted model breaks every existing install, and "existing
install" includes this user's own phone running a build from three months ago.
Hydration validates the schema version and refuses a snapshot it does not
understand rather than silently loading a partial one.

## 7. Time tracking

### The tick

Exactly one task is current at a time (`currentTaskId: string | null`). A 1-second
interval accumulates elapsed time into `timeSpentOnDay[today]`.

The tick reports a **wall-clock delta**, never a constant:

    consumeTick() {
      const now = Date.now()
      const delta = now - this.lastTickStart
      this.lastTickStart = now
      return { delta, day: todayStr(), now }
    }

If the browser throttles the interval to once a minute, the next tick carries
about 60000 ms and the arithmetic stays correct. A counter that increments by a
constant is wrong the first time the machine sleeps.

Guards: a non-finite delta is discarded rather than stored, because one NaN
serialises to `null` and silently zeroes a day. A delta larger than a configured
cap is clamped and routed to idle handling instead of being trusted.

Day rollover is driven by the timer, window focus, and `visibilitychange`
together, because a throttled interval can simply fail to fire across midnight.

### Idle

Desktop has an OS idle signal through Tauri. Mobile and browser do not, so a gap
in the wall-clock delta is the signal.

On detecting idle, the app **subtracts the idle time first**, then asks where it
went, offering the choice of a break, the same task, or a different one. It never
guesses. The task id and idle duration are snapshotted before any await, because
the user may return to a different task than the one that was running.

### Mobile

No background timer. The app stores `startedAt` and, for a bounded session,
schedules a local notification for the end time. On `resume` it recomputes elapsed
time from wall-clock. This is exact, costs no battery, and survives process death,
which is more than a background timer can claim on modern Android.

## 8. Calendar

A Google Apps Script web app owned by `contact@danieltyukov.com`, deployed as
"Execute as: Me", "Who has access: Anyone".

### Interface

    POST { secret, action: 'listEvents',  from, days }
    POST { secret, action: 'writeLog',    entries: [{ toHootId, title, start, end }] }
    POST { secret, action: 'deleteLog',   toHootIds: [] }

The shared secret is in the POST **body**, never the query string, because Apps
Script logs URLs. It is stored in Script Properties, never in source, because
`clasp push` uploads source to a Google-hosted project.

Auth failure returns HTTP 200 with `{ok: false}`. Apps Script's own error
responses are HTML and unhelpful to parse.

### Why CORS never comes up

Apps Script exposes only `doGet` and `doPost`. There is no `doOptions`, and it
will never route an OPTIONS request to one, so a CORS preflight can never be
answered. On top of that, `/exec` redirects to `script.googleusercontent.com`,
and a redirect after preflight is forbidden by the Fetch spec.

This would be fatal for a browser app. It is irrelevant here because
`tauri-plugin-http` executes in Rust and `CapacitorHttp` executes in native
Android HTTP. Neither goes through the browser fetch stack. Both hosts are
allowlisted in the Tauri capability file, including
`script.googleusercontent.com` for the redirect target.

### Reading

Calendar advanced service v3, not `CalendarApp`, because it supports
`singleEvents` and `orderBy` for expanding recurrence, and `extendedProperties`
for stamping identity. Events are fetched, cached, and rendered on the timeline.
They are never persisted as entities. An event becomes durable only if the user
converts it to a task.

### Writing

Write-back targets a **separate "to-hoot log" calendar** owned by `contact@`,
created by the script if absent. The real calendar is never mutated, the whole
layer toggles off with one checkbox in Google Calendar, and a write-back bug
cannot corrupt a genuine meeting.

Every written event carries `extendedProperties.private.toHootId`. Re-sync looks
up by that key and updates rather than inserting, so writes are idempotent by
construction rather than by bookkeeping.

The write queue copies super-productivity's proven shape:

- **Per-entity serialization.** Writes to one event never interleave.
- **1000 ms debounce.** One settled user edit produces one API call, not four.
- **Maximum 3 concurrent HTTP writes** across entities, to stay under Google's
  per-user rate limit during a bulk backfill.

Only deltas are pushed: `timeSpentOnDay[day] - calendarWritten[day]`.

Apps Script's 6-minute execution limit is the only real constraint, and it is
identical on consumer and Workspace accounts. Handlers paginate; the client
drives the loop.

## 9. Claude access

Both servers share one tool implementation in `packages/core`.

| Tool | Effect |
|---|---|
| `list_tasks` | filter by project, tag, done state |
| `search_tasks` | text match over title and notes |
| `add_task` | title, project, tags, estimate, due |
| `update_task` | any mutable field |
| `complete_task` | sets `isDone` and `doneOn` |
| `start_timer` / `stop_timer` | moves `currentTaskId` |
| `log_time` | explicit `(task, day, ms)` entry |
| `today` | today's list plus tracked against planned |

Read-only tools carry `readOnlyHint`; `complete_task` and `update_task` carry
`idempotentHint`.

**`apps/mcp`** is a stdio server for Claude Code. Note that stdout is the protocol
channel, so all logging goes to stderr.

**`apps/worker`** is a Cloudflare Worker for Claude web and Cowork. It is
stateless, needs no Durable Object, and keeps `legacy: 'stateless'` because
Claude's remote MCP infrastructure is legacy-era. It is authless with the secret
in the URL path (`/mcp/<32 random chars>`), which Anthropic supports and which
avoids building an OAuth server for one user. Anything else returns 404.

The Worker **reads the snapshot and never replays the log**, which both the 10 ms
CPU budget and the 50-subrequest limit require. Writes go through the same Git
Data API path as the clients.

## 10. Design system

Derived from measured values, not invented.

| Token | Value |
|---|---|
| Palette | Paper and Clay. Accent `#d97757` dark, `#c2603f` light. |
| Light | bg `#faf8f5`, surface `#ffffff`, border `#e8e3db`, text `#1c1b19`, muted `#6b665f` |
| Dark | bg `#12110f`, surface `#191816`, border `#2b2926`, text `#ece8e2`, muted `#98928a` |
| UI type | Instrument Sans (OFL) |
| Running text | Newsreader (OFL) |
| Numerals and timers | JetBrains Mono 500 (OFL), tabular figures |
| Radii | exactly two: 6px controls, 10px panels |
| Motion | 100 / 200 / 320 ms, `cubic-bezier(.165,.84,.44,1)`, no springs |
| Base size | 15px, not 16px |

One accent, used for at most three things: the current-time line, the active nav
item, and the progress ring. Borders or shadows, never both on one element.

Rules with reasons:

- **The accent is one hue in both themes.** Warm-metal accents do not survive
  theme inversion; to reach 4.5:1 on white, amber darkens into olive. Clay keeps
  its identity at both lightnesses.
- **The accent is never green.** Green is spoken for by the completed state.
- Fonts are self-hosted, subsetted, and committed. All three are OFL, which
  permits redistribution and modification. Subsetted files are renamed, because
  OFL reserves the original name for unmodified versions. Each font ships its
  `OFL.txt` and the notices appear in an in-app Licenses screen.

### Layout

Three panes on desktop: sidebar, task list, day timeline. On mobile the same
three become tabs.

Timeline geometry, specified concretely enough to build:

- Hour rows 56px. Hour gutter 48px, labels right-aligned, 10px mono, offset
  -6px so the label sits optically on the line. The grid needs `padding-top: 8px`
  or the first label clips.
- Lanes left to right: hour gutter, 16px tracked-time lane, then the events lane.
  Tracked time sits beside planned time so the gap between them is legible at a
  glance. This is the whole point of merging a tracker with a calendar.
- Tracked pills: 9px wide, 5px radius, accent at 32% opacity, coloured by project.
- Events: 6px radius, 1px border, 2.5px left border in the project colour.
- **Minimum event height 28px.** Below about 34px the time moves inline after the
  title instead of onto a second line, or it clips.
- Current time: 1px accent line, 6px dot at the left, time in a filled chip at the
  right so it does not collide with event text.
- Day header carries `tracked 4h 12m / planned 5h 30m` permanently.

### Identity

Two marks sharing one construction of two eyes and a beak triangle:

- **Logo**, the open "heart brow": a single stroke forming two arches over the
  eyes, descending into open sides that imply a facial disc without closing it.
  Used where it has room.
- **Icon**, negative space: one filled disc with eyes and beak punched out.
  Favicon, Android launcher, tray. Stays legible at 16px where the logo does not.

The wordmark sets "to-hoot" with small solid pupils in the two `o`s of "hoot".

Rejected after rendering and looking: pointed ear tufts read as a cat; an
interior facial-disc heart reads as headphones; a single-stroke spectacles
construction reads as a butterfly; two circles alone read as a colon.

### Pull without dark patterns

- A **consistency grid** in the footer, not a streak counter. A missed day is a
  lighter square, never a reset to zero. This is also the more robust engineering
  choice: a hard streak needs one authoritative "did I show up" boolean across
  timezones, sleeping laptops, and disagreeing clocks, and every one of those is a
  bug that destroys trust the first time it fires wrongly.
- The daily bar is **one completed task or one tracked session**, not a quota.
- A **"today is done"** terminal state that stops asking for anything.
- Completion feedback under 200 ms: the circle fills, the check strokes in, the
  row fades to muted. No confetti.
- Explicitly not built: red badge counts, loss-framed copy, escalating reminders.

## 11. Testing

| Layer | Tool | Covers |
|---|---|---|
| `packages/core` | Vitest | merge and replay determinism, commutative time deltas, ref-conflict retry, wall-clock tick under simulated sleep, day rollover, two-level subtask enforcement, calendar delta ledger |
| `packages/ui` | Playwright | the app against a fake platform adapter |
| `apps/desktop` | WebdriverIO, `embedded` provider | tray, global shortcut, autostart, single instance |
| `apps/mobile` | Maestro CLI, API 34 AVD | launch, add task, start timer, background and resume, sync |
| Sync | Vitest integration | two simulated devices against a scratch repo |

The merge tests are property-based where practical: any interleaving of the same
event set must produce the same final state on every device.

**Accessibility is the mobile test API.** Maestro reads the accessibility tree,
which is where a WebView publishes its DOM. Every icon-only control needs an
`aria-label`, or it is not addressable and therefore not testable.

Paid traps to avoid deliberately: the WebDriver provider is pinned to `embedded`
(`crabnebula` requires a subscription), and `maestro cloud` is never invoked.

CI runs on the public repo, where GitHub-hosted standard runners are free and
unmetered. Keep `runs-on: ubuntu-latest`; larger runners bill even on public
repos. The private data repo runs nothing.

## 12. Distribution

- **Desktop**: `.deb` and `.AppImage` from `tauri build`. Because the project is
  public and strangers download the binaries, **release builds run in CI on
  Ubuntu 22.04**, not on the development machine. glibc pins forward: a binary
  built on 24.04 fails on 22.04 with a missing-symbol error, so building on the
  oldest base that still ships WebKitGTK 4.1 is what makes the artifact portable.
  Local `tauri build` on 24.04 stays fine for development.
- **Android**: signed release APK, `--androidreleasetype APK` (the default
  produces an AAB, which cannot be sideloaded) and `--signing-type apksigner`.
  Attached to a GitHub Release on the **public** repo, because private-repo
  release assets are not anonymously downloadable and the phone's browser has no
  GitHub session.
- Day to day, `adb install -r` over USB. It is also permanently exempt from
  Android's developer-verification rollout.
- The keystore is backed up outside the repo. Losing it means updates can no
  longer install over the top, and recovering requires uninstalling, which
  destroys local app data.
- **Releases are cut by CI on a tag.** One workflow builds the signed APK, the
  `.deb` and the `.AppImage`, and attaches all three to a GitHub Release. Free
  and unmetered on a public repo. The signing key lives in Actions secrets as
  base64 and is written to a temp file that is removed in an `always()` step.
- Anyone building from source needs no keystore: debug builds sign themselves.

## 13. Known risks

| Risk | Mitigation |
|---|---|
| `@capacitor/background-runner`'s `fetch` is documented as "limited support" and the whole background sync depends on an authenticated JSON PUT | Prototype it before building on it. If it fails, background sync degrades to foreground-only, which is acceptable because a late sync is harmless against an append-only log. |
| Maestro's docs do not claim API 35/36 support | Use an API 34 AVD. `targetSdk 36` does not prevent installing on API 34; only `minSdk` gates that. |
| Capacitor plus a JS monorepo is historically fragile | npm workspaces, and validate `cap sync` on day one before any app code depends on it. |
| WebKitGTK renders a blank window on NVIDIA drivers | Ship `__NV_DISABLE_EXPLICIT_SYNC=1` in the `.desktop` Exec line; fall back to `WEBKIT_DISABLE_DMABUF_RENDERER=1`. |
| Claude adopts the 2026-07-28 protocol and drops legacy | `legacy: 'stateless'` serves both eras. Nothing to do unless Anthropic removes legacy support. |
| clasp v3 dropped TypeScript transpilation and renamed most commands | The Apps Script builds through esbuild to plain JS. Existing notes in `danieltyukov-site` document the old syntax and do not apply. |
| Log growth degrades cold start | Compaction at 500 events, snapshot is the read path. |

## 14. Build sequence

Each step ends somewhere demonstrably working.

1. **Skeleton and the risky seam.** npm workspaces, `packages/core` with models
   and a passing test, `packages/ui` rendering. Immediately: `cap add android`,
   `cap sync`, build a debug APK, install on the API 34 AVD. Prove the highest
   risk before anything is built on it.
2. **Core, tested.** Event log, replay, merge, compaction, the wall-clock tick.
   Pure TypeScript, no UI, high test coverage. This is where correctness lives.
3. **The app.** Design tokens, three-pane shell, task list, task detail, the day
   timeline, running timer. Against an in-memory store.
4. **Sync.** GitHub Git Data client, the ref-conflict retry, background schedule.
   Two-device integration test against a scratch repo.
5. **Desktop shell.** Tauri, platform adapter, tray, autostart, single instance.
   Real `.deb` and `.AppImage`.
6. **Mobile shell.** Capacitor adapter, resume-driven recompute, haptics, signed
   release APK, Maestro flows green.
7. **Calendar.** Apps Script, esbuild, clasp deploy, the log calendar, read into
   the timeline, debounced write-back queue.
8. **Claude.** Shared tool layer, stdio server, Worker, deploy, connect from
   Claude Code and from Claude web.
9. **Setup wizard.** The first-run flow of section 18, every step with a live
   Test connection. This is what removes the last hardcoded value, so it also
   proves the app works against a fresh account rather than only this one.
10. **Open source furniture.** MIT licence, README with real screenshots,
    CONTRIBUTING, SECURITY, issue templates, `docs/SETUP.md`,
    `docs/ARCHITECTURE.md`. A clean-clone test: build from scratch in an empty
    directory with no local state and confirm nothing personal leaks in.
11. **The site.** `site/` against the shared tokens, GitHub Pages workflow,
    content per section 17, accessibility pass.
12. **Polish and QA.** Real design pass against the rendered app, empty states,
    the consistency grid, accessibility labels, full E2E green on all three
    targets, both themes checked at every breakpoint.

## 15. Zero cost, verified

| Component | Cost | Card | At the limit |
|---|---|---|---|
| All packages (MIT / Apache-2.0 / OFL) | none | no | n/a |
| Cloudflare Workers Free + `workers.dev` | none | no | HTTP error, never a bill |
| GitHub Free, unlimited private repos | none | no | 403 with `Retry-After` |
| GitHub Actions on a public repo | none, unmetered | no | n/a |
| GitHub Releases for the APK | none, unmetered bandwidth, 2 GiB/file | no | n/a |
| Apps Script + Calendar API v3 | none, no GCP billing account | no | quota error |
| Self-signed APK, no Play account | none | no | n/a |

Every service in the stack **hard-fails rather than billing**. There is no
overage, no auto-upgrade, and no component that requires a payment method to sign
up or to operate at these volumes.

## 16. Open source readiness

to-hoot is a public project that a stranger should be able to clone, build, and
run against their own accounts without editing a single source file.

### Licence

**MIT**, matching the existing policy of MIT for software. `LICENSE` at the root,
plus an in-app Licenses screen listing the third-party notices, since the three
bundled OFL fonts require their notice to travel with the files.

### Repository furniture

| File | Purpose |
|---|---|
| `README.md` | What it is, a screenshot, what it costs (nothing), install, build from source, links to the site |
| `LICENSE` | MIT |
| `CONTRIBUTING.md` | Layout, how to run each target, how to run the tests |
| `SECURITY.md` | Where tokens live, what the capability URL protects, how to report an issue |
| `.github/ISSUE_TEMPLATE/` | bug and feature, with a platform field |
| `docs/SETUP.md` | The long-form version of the in-app wizard, for people who prefer reading |
| `docs/ARCHITECTURE.md` | The event log and merge model, for anyone auditing their own data |

The README leads with a screenshot of the real app in both themes, not a feature
list. No badge wall, no emoji, no marketing voice.

### Nothing is hardcoded

Every account-specific value moves into runtime settings, stored locally and
never committed:

    data repo owner/name          user's own private repo
    GitHub token                  user's own fine-grained PAT
    Apps Script /exec URL         user's own deployment
    Apps Script shared secret      generated in-app
    Worker URL and path secret     user's own deployment, optional

The repository contains no personal identifiers. `contact@danieltyukov.com`
appears nowhere in code; it is one user's setting value.

## 17. The project site

A **single page**, static, served by GitHub Pages from the public repo, built by
CI on push to `main`.

### Why not reuse the app's build

The site is its own tiny Vite build in `site/`, importing the same
`packages/ui/tokens.css`. It shares the palette, type scale, radii and motion
with the app by construction rather than by copying values, so the two can never
drift. It does not import React or any app code, because a landing page that
ships the whole application is slow for no reason.

### Content, in order

1. **Header.** The heart-brow mark, the wordmark, one line saying what it is, and
   two buttons: download the APK, download the desktop build. No hero gradient,
   no centred marketing block.
2. **A real screenshot** of the three-pane app, in both themes, switching with
   the visitor's theme.
3. **What it is for.** Four short items, prose not cards: one list on every
   device, time tracked against your actual calendar, your data in your own
   private repo, and ask Claude to add a task from anywhere.
4. **What it costs.** A short, honest table: every service, free tier, and the
   fact that each one hard-fails rather than billing. This is a genuine
   differentiator against every hosted competitor and deserves its own section.
5. **Set up in four steps**, mirroring the in-app wizard exactly, so the page and
   the app never disagree.
6. **Build from source.** The commands, for people who will not install a binary
   someone else compiled.
7. **Footer.** Repo link, licence, the fonts' OFL notices.

Deliberately absent: a three-column feature grid with line icons, a pricing
table, testimonials, a newsletter box, an "isn't just X, it's Y" sentence.

### Constraints

Static HTML and CSS with a few lines of JS for the theme toggle. Self-hosted
fonts, same subsets as the app. No analytics, no third-party requests at all, so
the page has nothing to disclose and nothing to consent to. Lighthouse
accessibility must pass before it ships, since it is the front door.

## 18. Setup happens in the app

The hard requirement: a new user configures everything from the interface. No
config files, no environment variables, no terminal, except where Google and
Cloudflare genuinely require a human in their own console.

A first-run wizard, resumable and skippable, with every step independently
testable. Each step ends in a real **Test connection** button that makes a live
call and reports the actual error, because a setup flow that only validates
syntax is a setup flow that fails later somewhere less obvious.

### Step 1: Local only

The app works immediately with no accounts at all. Everything below is optional
and can be added later from Settings. Someone who wants a local task tracker with
time tracking should never be forced through a sync wizard.

### Step 2: Sync

The user pastes a GitHub fine-grained PAT. The app then:

1. Verifies the token and shows which account it belongs to.
2. Offers to **create the private data repository** through the API, or to select
   an existing one. Creation is one API call and removes the most error-prone
   manual step.
3. Writes an initial commit and reads it back, proving the whole round trip
   before declaring success.
4. Names the device, so the event log prefix is meaningful.

Adding the second device is a paste of the same token plus picking the same repo.
The app detects an existing log and offers to adopt it rather than initialise.

The exact scopes required are shown inline with a copy button, because "create a
token with the right permissions" is where this kind of setup usually fails.

### Step 3: Calendar

Google requires a human to create and authorize a script, so this cannot be fully
automated. The wizard makes it mechanical:

1. Generates a random shared secret and shows the complete, ready-to-paste Apps
   Script source with a copy button. The secret is **not** substituted into the
   source. It is shown separately, to be added as a Script Property named
   `TO_HOOT_SECRET`, because `clasp push` uploads source to a Google-hosted
   project and a secret baked into source would be exposed twice over.
2. Links to `script.google.com`, and lists the exact clicks: new project, paste,
   enable the Calendar advanced service, deploy as web app, execute as me, anyone
   with access.
3. The user pastes the `/exec` URL back into the app.
4. **Test connection** calls `listEvents` and shows the next few real events. If
   the redirect host is blocked, or the secret is wrong, or the advanced service
   was not enabled, the error message says which.
5. The app offers to create the "to-hoot log" calendar on first write.

Read-only calendar via a plain ICS URL is offered as a simpler alternative for
anyone who only wants to see their events and does not need write-back.

### Step 4: Claude

Two paths, both optional.

**Claude Code** is one command, generated with the correct absolute path and a
copy button:

    claude mcp add to-hoot -- node /path/to/to-hoot/apps/mcp/dist/index.js

**Claude web and Cowork** need a public URL, which means the user's own free
Cloudflare account. The wizard generates the path secret, provides the exact
`wrangler` commands with values filled in, and accepts the resulting URL back.
**Test connection** performs a real `tools/list` against it.

If someone skips this, everything else still works. The MCP layer is additive.

### Settings

Everything the wizard sets is editable afterwards in one Settings screen, grouped
as Sync, Calendar, Claude, Appearance and Data. Data offers export to JSON,
import, log compaction, and a plain statement of where the data lives and what
deleting the repo would mean. A user should be able to leave as easily as they
arrived.

### Secrets

Tokens go in the platform store (`tauri-plugin-store` on desktop,
`@capacitor/preferences` on Android), never in the synced event log. They are
per-device by design: a token that syncs is a token that leaks to every device
and into the data repo. Settings shows tokens masked with a reveal, and the
Apps Script secret can be rotated from the app, which reprints the script source
with the new value.
