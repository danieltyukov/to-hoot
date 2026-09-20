# Setup

Everything here is also in the app, as a first-run wizard you can resume or skip.
This is the same thing written out, for people who would rather read the whole
shape of it before clicking anything.

Four steps. Only the first is required, and each of the others can be added or
removed later from Settings without disturbing the ones you already did.

1. [Local only](#1-local-only), no accounts.
2. [Sync](#2-sync), a private GitHub repository you own, one button.
3. [Calendar](#3-calendar), a sign-in with Google, one button.
4. [Claude](#4-claude), MCP over stdio, and an endpoint that signs in with
   Cloudflare and deploys itself, one button.

Every connection in the app does the real operation and shows it happening,
line by line, rather than checking that a URL looks like a URL. A setup flow that
only validates syntax is a setup flow that fails later, somewhere less obvious.

## 1. Local only

Install it and use it. Tasks, projects, tags, timers, the day timeline and the
consistency grid all work with no account anywhere, storing everything on the
device.

Nothing later in this document is required. If a local task tracker with time
tracking is what you wanted, you are done, and the app will not nag you about the
rest.

Settings is one page of cards: the three connections, a list of every device
that writes to your repository, and then Appearance, Tracking and Data. Three of
them are worth a look before you connect anything. **Appearance**
carries the theme and the hours your workday runs between, which is the span the
day timeline opens on. **Data** is export to JSON and import. **Tracking**
carries the two below, and both change what the totals mean rather than how they
look:

- **The day starts at.** Midnight, or any hour up to 06:00. Work done before it
  counts towards the previous day, so an evening that ran past midnight stays on
  the day it belonged to instead of starting a new one.
- **Ask about idle time after.** Two, five, ten, fifteen, thirty or sixty
  minutes. On the desktop, a stretch that long with nothing happening is taken
  back out of the totals and you are asked where it went: the task it
  interrupted, a different task, or it was a break. The time is removed either
  way, so the numbers stay honest whether or not you answer. Android has no
  equivalent signal and does not ask.

## 2. Sync

Sync uses a private GitHub repository as the datastore. There is no server in
between and no account with anyone. If you delete the repository, the data is
gone, and the app says so in those words in Settings.

### One button

Press **Sign in with GitHub**. The app asks GitHub for an eight-character code,
puts it on your clipboard, and opens `github.com/login/device` in your browser,
where you paste the code and approve ToHoot. That is GitHub's device flow, and
it is the one sign-in that works from a phone with no server anywhere: nothing
is typed into the app and no client secret exists.

From there the app does the rest and shows each line as it happens:

1. **Finds or creates the data repository.** It looks in your own account for
   `to-hoot-data`, joins it if it is there, and creates it, private, if it is
   not. Another name is one tap away under "Use another repository".
2. **Names this device.** A phone is called `phone`, a desktop `desktop`. If
   that name is already writing to the repository the app asks one question:
   is that this device, set up again (keep the name), or another one (which
   takes `phone-2`). The name is editable underneath.
3. **Checks the connection.** It writes a commit and reads it back, then says
   "Connected. Tasks from every device appear here."

The token GitHub hands over has the `repo` scope, because OAuth Apps have no
narrower scope that reaches a private repository. It never leaves the device
and is never shown. `SECURITY.md` has the trade-off.

### Or a token

Under **Use a token instead**, paste a **fine-grained** personal access token
(github.com, Settings, Developer settings, Personal access tokens, Fine-grained
tokens) with **Contents: Read and write** on the data repository, plus
**Administration: write** if you want the app to create the repository for you.
Everything after the token is the same flow as above.

### What the repository holds

Data only. No code, no Actions, no workflows. Nothing in this project ever
executes anything it reads from there. Each device writes only under its own
`events/<device>/` prefix, which is what lets two devices sync with no locking
and why two devices must never share a name.

The names come from `meta.json` first and from the event paths only as a
fallback. A device whose events have all been folded into the snapshot has no
`events/<id>/` folder left, and it still holds its name.

### Adding a second device

Sign in on it. The app finds the same repository, sees the first device's name,
suggests one for this device, and joins the log. Both devices then write only
under their own prefix, so they cannot collide, and time tracked on both at once
adds up instead of one overwriting the other. Settings lists every device that
writes to the repository and when it last did.

A device you no longer use stays on that list until you press **Forget** beside
it. Forgetting removes it from the repository's registry and nothing else: the
tasks and time it recorded are in the log and stay there, on every device. A
device that writes again afterwards reappears, which is what happens if you
forget the Claude endpoint's `worker` entry while the endpoint is still deployed.

### When it syncs

On its own, and opportunistically: once the log has loaded, every ten seconds
while the app is on screen and once a minute while it is hidden, when the app
comes back to the foreground, and a couple of seconds after anything changes.
A task added on your phone, or by Claude, is on the desktop within about ten
seconds. You never have to press anything. There is a **Sync now** button in
Settings, Sync, beside the status line, and it is there for reassurance rather
than because sync needs it; it also pushes a running timer's time at once,
which otherwise travels every couple of minutes rather than every flush.

Nothing fights the platform for background execution, because it does not have
to. Every event carries its own timestamp and device, and tracked time carries an
increment rather than a total, so a phone that syncs when it is next opened
reaches the same state as one that synced on time.

## 3. Calendar

Optional. It gives you two things: your real events beside your task list, and
tracked time written back to a separate calendar so a week of work is visible
where the rest of your commitments are.

### Sign in with Google

One button. Press **Sign in with Google**, approve ToHoot in the browser that
opens, and come back. The app exchanges what Google sent back for a grant, reads
your calendars to prove it works, finds or creates the "to-hoot log" calendar,
and shows **Connected** with the address you signed in as. Nothing is pasted.

Google shows an "unverified app" interstitial the first time, because this is
one person's project and not a verified publisher: press **Advanced**, then
continue to ToHoot. The consent screen asks for the calendar scope alone.

The sign-in needs the desktop app or the Android app, because a browser tab has
nowhere to receive Google's redirect. The desktop app listens on
`localhost:8976` for it; the Android app registers a URL scheme of its own. Both
use PKCE, so the code that comes back is useless to anything that did not start
the sign-in. The grant stays on the device, in the platform store, and is
refreshed in place; it never enters the event log. **Sign out** revokes it at
Google and forgets it.

Signing in on one device does not sign in the others. Each device that should
show your day signs in once.

### The read-only shortcut

If you only want to *see* your events and do not need write-back, and would
rather not sign in, paste a **secret ICS URL** under **Only show my events,
without signing in** (Google Calendar, calendar settings, "Secret address in
iCal format"). Read-only, no grant to manage. Signing in with Google takes
precedence over it if you do both.

### The Apps Script bridge

Kept under **Use an Apps Script bridge instead** for a deployment that already
exists, or for anyone who would rather not grant the app a Google token.
Signing in with Google takes precedence over it if you do both.

The app shows you the complete script source with a copy button, plus a freshly
generated secret shown separately. The secret is deliberately **not** substituted
into the source: `clasp push` uploads source to a Google-hosted project, and a
secret baked into the source would be exposed twice over.

1. Go to script.google.com and create a new project. Paste in the source the app
   gave you, replacing whatever is in the editor.
2. **Services**, add **Calendar**, version **v3**, identifier `Calendar`. Without
   this the bridge answers `calendar-service-disabled` and nothing else works.
3. **Project Settings**, **Script Properties**, add a property named
   `TO_HOOT_SECRET` with the secret the app generated.
4. **Deploy**, **New deployment**, type **Web app**. Execute as: **Me**. Who has
   access: **Anyone**. "Anyone" here means no Google sign-in, which is why the
   shared secret is the whole of the authentication.
5. Copy the `/exec` URL and paste it back into the app, then press **Test
   connection**. It calls `listEvents` and shows your next few real events.

If you would rather not click, `apps/apps-script/README.md` documents the same
thing through clasp. Steps 2 and 3 still have to happen in the editor: the
advanced service comes from the manifest, but the Script Property does not.

### When Test connection fails

The error message names which of these it was:

| Message | Cause |
|---|---|
| `unauthorized` | The Script Property does not match the secret in the app. |
| `calendar-service-disabled` | Step 2 was skipped or saved without the advanced service. |
| `bad-request` | Usually a `/dev` URL pasted instead of the `/exec` one. |
| A network error on desktop | The redirect host is blocked. The bridge redirects `/exec` to `script.googleusercontent.com`, and both hosts have to be allowed. |
| An HTML response | The deployment is not published, or is published to the wrong account. |

### What it reads

Every calendar the account can see, merged into one day: work calendars shared
with you, imported feeds, group calendars. Calendars you have unticked in Google
Calendar are left out, so the app's day and the browser's agree. A calendar
shared with you as free/busy has no titles to give, and its hours show as
"Busy".

If you deployed the script before this and the timeline looks emptier than your
browser, paste the script again from Settings and redeploy: an older deployment
reads only the account's own calendar. The calendar check in Settings says so
when it sees one.

### Tracking a meeting

Press a meeting on the timeline and the timer starts against it. The first press
makes a task for it; every press after that finds the same task, so a meeting
you stop and come back to stays one row rather than becoming several. Pressing a
different block banks the current one and switches.

Nothing is written back to your calendar for those, on purpose: the meeting is
already there. Track twenty minutes of an hour-long meeting and to-hoot knows
you did twenty, while your calendar keeps showing the meeting that was booked.

### Write-back

Tracked time is written to a separate calendar named "to-hoot log", found or
created on first use. Your real calendars are read and never modified, so a bug
in write-back can only damage events this app wrote, and you can hide the whole
layer with one checkbox in Google Calendar.

A day becomes one block per stretch of work, at the times you actually worked.
Stop for lunch and you get two blocks, not one long one. Days you tracked before
this app kept that detail have a total and nothing else, so they stay as a single
block at your workday start.

Writing the same block twice leaves one event: every written event carries a
`toHootId` of `<taskId>::<day>` for the first stretch and `<taskId>::<day>::<n>`
for the rest, and a re-sync updates by that key rather than inserting.

## 4. Claude

Optional, and additive: skipping it changes nothing else. Two paths, and you can
take either, both, or neither.

Both expose the same fifteen tools over the same event log: `list_tasks`,
`search_tasks`, `today`, `add_task`, `update_task`, `complete_task`,
`start_timer`, `stop_timer`, `log_time`, `list_projects`, `add_project`,
`update_project`, `list_tags`, `add_tag` and `update_tag`. Tasks take project
and tag names as well as ids, and a name nothing matches is created in the same
batch as the task. A change Claude makes is one event appended to the log,
indistinguishable from one you made in the app.

### Claude Code

One button on the desktop: **Add to Claude Code** writes a `to-hoot` server into
Claude Code's own config file, `~/.claude.json`, which is what `claude mcp add`
does from a terminal. Everything else in that file is left as it was. With the
endpoint deployed, the entry points Claude Code at the endpoint over HTTP, the
same one Claude on the web uses, so an installed app needs no checkout and no
build on the machine. Without an endpoint it points at the local stdio server
below. Claude Code picks the entry up the next time it starts, and the step
says so when the endpoint has changed since the entry was written.

The command is still there under **Use the command instead**, and it is the
only way in a browser tab or on a phone, which cannot write the file:

```
npm run build -w @to-hoot/core && npm run build -w @to-hoot/mcp
claude mcp add to-hoot -- node /absolute/path/to/to-hoot/apps/mcp/dist/index.js
```

The app generates that second line with the right absolute path already in it.

The server reads its configuration from the environment, never from a file in
the repository:

| Variable | Required | Meaning |
|---|---|---|
| `TO_HOOT_GITHUB_OWNER` | yes | Owner of the data repository |
| `TO_HOOT_GITHUB_REPO` | yes | The data repository |
| `TO_HOOT_GITHUB_TOKEN` | yes | A token that can read and write it |
| `TO_HOOT_GITHUB_BRANCH` | no | The branch to use. Unset means the repository's own default |
| `TO_HOOT_DEVICE_ID` | no | One path segment, unique per device. Defaults to `mcp-<hostname>` |
| `TO_HOOT_STATE_DIR` | no | Where a running timer is kept. Defaults to `~/.to-hoot` |

A blank value counts as unset, so an empty token fails by name instead of as a
401 from GitHub.

### Claude on the web and on your phone, over a Worker

Neither can reach a program on your machine, so they need a public URL, which
means a free Cloudflare account with no payment method on it. The Worker is
stateless and holds nothing but the secrets you set on it.

The endpoint deploys from **Settings, Claude**, with one press:

1. **Sign in and deploy.** The browser opens on Cloudflare's own sign-in, using
   the same public OAuth client wrangler uses. Approve it and come back. The app
   downloads the Worker built for its own version from the release, uploads it
   to your account with the four secrets (your GitHub token, the repository
   owner and name, and a generated path secret), switches on its `workers.dev`
   address, asks the new endpoint for its tools, and then revokes the token it
   signed in with. If your account can deploy to more than one Cloudflare
   account, it asks which before uploading.
2. **Add it to Claude.** Copy the endpoint and open Customize, Connectors, Add
   custom connector. Paste the URL and leave the second step empty: this
   endpoint has no authentication to configure. The same connector then works
   in Claude on the web and in the Claude app on your phone. This is the one
   step that stays manual, because Claude has no way for an app to add a
   connector on your behalf.

Cloudflare sends the sign-in back to `localhost:8976` and nowhere else, so this
is a desktop button, and the phone does not show it. The phone learns the
endpoint's hostname through sync and its Claude step says "Endpoint deployed"
with the hostname, or tells you to deploy from the desktop until then. The
path secret that makes the URL a credential stays on the device that deployed
it, so the URL is copied into Claude from the desktop; the connector then
serves the Claude app on the phone as well.

An API token still works, under **Path secret and token options**: the button
there opens the dashboard's token page with the two permissions prefilled
(Workers Scripts: Edit, Account Settings: Read), and the token is used for one
deploy and forgotten.

**That URL is a credential.** Anyone holding it can read and write your task
list. Treat it the way you would treat the token itself; `SECURITY.md` explains
why the design is shaped this way and how to revoke it.

Wrangler still works, under **Deploy with wrangler instead**, on a computer with
this repository checked out:

```
cd apps/worker
npx wrangler secret put MCP_PATH_SECRET     # the path secret the app shows
npx wrangler secret put GITHUB_OWNER
npx wrangler secret put GITHUB_REPO
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

Two behaviours are worth knowing before you rely on it:

- The Worker reads the prebuilt snapshot plus the event files written since the
  last compaction, up to 32 of them, so what the desktop wrote a minute ago is
  visible to Claude on the web. The devices compact the log once it reaches 30
  files or 500 events, which is what keeps that tail short.
- The running timer lives in the isolate, which Cloudflare can recycle between
  two requests. `stop_timer` refuses rather than guessing when the start is gone,
  and tells Claude to use `log_time` instead.

## Running a fork

Sign in with GitHub, Sign in with Google and Sign in and deploy each use an OAuth
client registered to this project. The GitHub and Cloudflare clients are public
and need nothing from you. The Google clients are registered to a Google Cloud
project owned by the author, so a fork that wants Sign in with Google registers
its own:

1. In Google Cloud, create a project, configure the Google Auth Platform with
   the app's name and an external audience, add the
   `https://www.googleapis.com/auth/calendar` scope under Data Access, enable
   the Google Calendar API, and publish the app.
2. Under Clients, create a **Desktop app** client and an **Android** client
   (package `com.tohoot.app`, or your own, with the SHA-1 of the certificate
   that signs your APK). On the Android client, open **Advanced settings** and
   tick **Enable custom URI scheme**: Google leaves it off, and without it the
   phone's sign-in ends on "Access blocked: request is invalid".
3. Put both client ids in `google-oauth.json` at the repository root. The web
   build and the Android build both read it, so the client id the app signs in
   with and the URL scheme the phone registers cannot disagree.
4. Provide the Desktop client's secret as `VITE_GOOGLE_DESKTOP_CLIENT_SECRET`
   at build time: a `.env` file in `packages/ui` for a local build, and a
   repository secret of the same name for the release workflow. Google treats
   the secret of an installed app as not actually secret, which is why PKCE
   carries the real protection, but it is still kept out of the source.

Without the ids the button is disabled and says so, and the feed and the bridge
still work.

## Leaving

Settings, Data, has export to JSON and import, next to a plain statement of
where your data lives and what deleting the repository would mean.

Import merges rather than appends. An exported file carries other devices and
other days, so each event lands in its place in the history instead of winning
because it arrived last: import a file you exported today onto a device that has
since renamed the same task, and the newer title survives. Anything already in
the log is recognised and not added twice, so importing the same file twice
changes nothing.

There is no compact button, on purpose. Compaction happens during a sync, in the
same commit that writes the snapshot, so there is never a moment where the two
disagree. A local button would either do nothing or fold away a log that no other
device had read yet. The Data screen says how many events the log holds and
leaves it at that.

One rule sits behind what happens if the log file on disk is not what the app
expects: if the file is not exactly the shape this app writes, it is not this
app's to replace. That covers a file cut short by a crash, a file the disk
refuses to open at all, a file holding an entry this version cannot read, and a
file written by a newer version of the app, which is the one you might actually
meet, by running an older build against a log a newer one wrote.

In any of those cases Data says so: its summary reads "not saving" rather than an
event count. **Nothing is written at all while that notice is up**, the cache
included, so the sentence on screen is literally true. The app keeps running from
memory, and the way out is a **Start a new log** button, which keeps the old file
beside the new one rather than deleting it and carries whatever you did during
the degraded session into the fresh log. The only copy of that work was in
memory, which is the loss the whole behaviour exists to prevent.

Both shells write to a temporary file and rename over the target, which is atomic
within a directory, so a half-written log should stay hypothetical.

To leave entirely: export, revoke the GitHub token, delete the data repository,
delete the Apps Script deployment, delete the Worker, uninstall. Nothing survives
that, because there was never anywhere else for it to be.
