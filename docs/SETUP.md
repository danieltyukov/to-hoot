# Setup

Everything here is also in the app, as a first-run wizard you can resume or skip.
This is the same thing written out, for people who would rather read the whole
shape of it before clicking anything.

Four steps. Only the first is required, and each of the others can be added or
removed later from Settings without disturbing the ones you already did.

1. [Local only](#1-local-only), no accounts.
2. [Sync](#2-sync), a private GitHub repository you own.
3. [Calendar](#3-calendar), an Apps Script bridge in your own Google account.
4. [Claude](#4-claude), MCP over stdio, and optionally over the web.

Every step in the app ends with a **Test connection** button that makes a real
call and reports the actual error. A setup flow that only checks that a URL looks
like a URL is a setup flow that fails later, somewhere less obvious.

## 1. Local only

Install it and use it. Tasks, projects, tags, timers, the day timeline and the
consistency grid all work with no account anywhere, storing everything on the
device.

Nothing later in this document is required. If a local task tracker with time
tracking is what you wanted, you are done, and the app will not nag you about the
rest.

Settings has six sections: Sync, Calendar, Claude, Appearance, Tracking and Data.
Three of them are worth a look before you connect anything. **Appearance**
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

### The token

Create a **fine-grained** personal access token, not a classic one:

1. github.com, Settings, Developer settings, Personal access tokens,
   Fine-grained tokens, Generate new token.
2. **Repository access**: Only select repositories. Pick the data repository, or
   choose "All repositories" for now if you are about to let the app create it,
   then narrow it afterwards.
3. **Permissions**: Repository permissions, **Contents: Read and write**. Nothing
   else. Not Actions, not Workflows, not Administration.
4. Set an expiry you will actually notice. The app reports a 401 clearly when the
   token dies, but it cannot renew it for you.

A classic token would work and should not be used: `repo` on a classic token
covers every repository you can reach, which is a much larger blast radius for
the same feature.

### The repository

Paste the token into the app. It verifies the token, shows you which account it
belongs to, and then offers two paths:

- **Create the data repository.** One API call, private, and the most
  error-prone manual step disappears. `to-hoot-data` is the suggested name.
- **Select an existing one.** The wizard reads it before writing anything and
  tells you what it found, by name: "Already holds a log from one device:
  laptop." It says in as many words that nothing already there is replaced. That
  matters most on the second device, when the repository you are pointing at
  holds the only copy of the first one's history.

It then writes an initial commit and reads it back before declaring success, so
the whole round trip is proven rather than assumed. Against a repository that
already holds a log it reports joining it instead of setting it up.

A repository created empty has no commits at all, and the Git Data API cannot
write into one: there is no parent commit to build a tree against. The app gives
it a first commit through the Contents API before the first sync, so "create it
for me" and "here is one I made earlier" end up in the same state.

Finally, **name the device**. The name becomes the event log prefix, so "laptop"
and "phone" make a log you can read by eye later. Two devices must never share
one, and the wizard reads the repository to check: a name another device already
claims is refused, and the message says which, rather than hinting that
something is wrong.

Re-using a name is possible and is never silent. It is a separate button, "I am
replacing that machine", and it is only safe if the old machine will never sync
again. Two live devices under one name write to the same paths, and the whole
merge model rests on that never happening.

The names come from `meta.json` first and from the event paths only as a
fallback. A device whose events have all been folded into the snapshot has no
`events/<id>/` folder left, and it still holds its name.

The data repository holds data only. No code, no Actions, no workflows. Nothing
in this project ever executes anything it reads from there.

### Adding a second device

Paste the same token, pick the same repository, give it a different device name.
The wizard names the devices already writing there and joins their log. Both
devices then write only under their own prefix, so they cannot collide, and time
tracked on both at once adds up instead of one overwriting the other.

### When it syncs

On its own, and opportunistically: once the log has loaded, on a timer, when the
app comes back to the foreground, and shortly after anything changes. You never
have to press anything. There is a **Sync now** button in Settings, Sync, beside
the status line, and it is there for reassurance rather than because sync needs
it.

Nothing fights the platform for background execution, because it does not have
to. Every event carries its own timestamp and device, and tracked time carries an
increment rather than a total, so a phone that syncs when it is next opened
reaches the same state as one that synced on time.

## 3. Calendar

Optional. It gives you two things: your real events beside your task list, and
tracked time written back to a separate calendar so a week of work is visible
where the rest of your commitments are.

Google requires a human to create and authorize a script, so this step cannot be
fully automated. It is mechanical, though, and the app generates everything you
have to paste.

### The read-only shortcut

If you only want to *see* your events and do not need write-back, skip the
script: paste a **secret ICS URL** into Settings instead (Google Calendar,
calendar settings, "Secret address in iCal format"). Read-only, no deployment,
no secret to manage. Everything below is for write-back.

### Deploying the bridge

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

### Write-back

Tracked time is written to a separate calendar named "to-hoot log", found or
created on first use. Your real calendars are read and never modified, so a bug
in write-back can only damage events this app wrote, and you can hide the whole
layer with one checkbox in Google Calendar.

Writing the same block twice leaves one event: every written event carries a
`toHootId` of `<taskId>::<day>`, and a re-sync updates by that key rather than
inserting.

## 4. Claude

Optional, and additive: skipping it changes nothing else. Two paths, and you can
take either, both, or neither.

Both expose the same nine tools over the same event log: `list_tasks`,
`search_tasks`, `today`, `add_task`, `update_task`, `complete_task`,
`start_timer`, `stop_timer` and `log_time`. A change Claude makes is one event
appended to the log, indistinguishable from one you made in the app.

### Claude Code, over stdio

A local process with no network listener. Build it, then register it:

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
| `TO_HOOT_GITHUB_TOKEN` | yes | The same fine-grained token, or a second one |
| `TO_HOOT_GITHUB_BRANCH` | no | The branch to use. Unset means the repository's own default |
| `TO_HOOT_DEVICE_ID` | no | One path segment, unique per device. Defaults to `mcp-<hostname>` |
| `TO_HOOT_STATE_DIR` | no | Where a running timer is kept. Defaults to `~/.to-hoot` |

A blank value counts as unset, so an empty token fails by name instead of as a
401 from GitHub.

### Claude web and Cowork, over a Worker

These need a public URL, which means a free Cloudflare account. The Worker is
stateless and holds nothing but the secrets you set on it.

```
cd apps/worker
npx wrangler secret put MCP_PATH_SECRET     # openssl rand -base64 32 | tr -d '/+=' | cut -c1-32
npx wrangler secret put GITHUB_OWNER
npx wrangler secret put GITHUB_REPO
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```

Then add `https://<name>.<subdomain>.workers.dev/mcp/<secret>` to Claude as a
custom connector, with authentication set to none, and press **Test connection**
in the app, which performs a real `tools/list` against it.

**That URL is a credential.** Anyone holding it can read and write your task
list. Treat it the way you would treat the token itself; `SECURITY.md` explains
why the design is shaped this way and how to revoke it.

Two behaviours are worth knowing before you rely on it:

- The Worker reads the prebuilt snapshot and never replays the log, because the
  free tier allows 10ms of CPU per request. Events other devices wrote since the
  last compaction are not visible to it. Events it wrote itself are.
- The running timer lives in the isolate, which Cloudflare can recycle between
  two requests. `stop_timer` refuses rather than guessing when the start is gone,
  and tells Claude to use `log_time` instead.

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
