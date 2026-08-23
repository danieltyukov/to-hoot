# Architecture

This describes what to-hoot writes into your data repository and how it decides
what your state is. It exists because the repository is yours: you can clone it,
read every file in it with `cat`, and this document should let you confirm that
what is there is what you expect.

The implementation is `packages/core/src/events.ts`, `replay.ts` and
`github/sync.ts`. Where this document and that code disagree, the code is right
and the disagreement is a bug worth reporting.

## The shape of it

There is no server. `packages/ui` is the whole application; the desktop and
mobile targets are shells supplying a `Platform` implementation for HTTP, a
key-value store, notifications and resume. State is never written directly. Every
change is an event appended to a log, and state is always the result of replaying
that log.

That constraint is the reason two devices can be offline at the same time and
still agree afterwards.

## The repository

    snapshot.json                     the current state, and the log position it covers
    snapshot-<seq>-<rand>.json        an immutable copy of the same bytes
    events/<deviceId>/<ulid>.json     one file per sync batch, append-only
    meta.json                         the devices the log has seen

Three properties carry the design:

1. **A device writes only under its own `events/<deviceId>/` prefix.** Two
   devices therefore never write the same path, so one write can never lose
   another. Merging becomes replay rather than reconciliation.
2. **The snapshot and the events it absorbs move in one commit.** A git tree
   write can touch any set of paths, so there is no window in which the snapshot
   and the log disagree, and compaction is an ordinary write rather than a
   dangerous operation.
3. **A rejected ref update is the concurrency check.** Nothing is ever forced. A
   loser re-reads and rebuilds its write on top of the winner's commit.

`meta.json` is a device registry, `{ deviceId: { firstSeen, lastSeen } }`,
derived from the log itself and rebuilt deterministically, so two devices
compacting the same log produce identical bytes.

## Events

```ts
interface Event {
  id: string          // ULID, so the log sorts by creation time
  deviceId: string
  ts: number          // the originating device's wall clock, epoch ms
  type: 'create' | 'update' | 'delete' | 'timeDelta'
  entity: 'task' | 'project' | 'tag' | 'settings'
  entityId: string
  payload: unknown
  schemaVersion: number
}
```

An event file is a batch: one JSON file per sync, named with a ULID so the
filenames sort the same way the events do. Files are never rewritten and never
deleted except by compaction.

`payload` is deliberately typed as `unknown`. Events arrive from other devices
running other builds, so replay validates every field it reads rather than
trusting the shape. A payload field that replay does not recognise is ignored,
which is what makes an event written by a newer build harmless to an older one.

## Replay

Events are sorted into a total order before anything is applied:

    (ts, deviceId, id)

All three matter. `ts` is the intent, `deviceId` breaks a tie between two devices
whose clocks read the same, and `id` breaks a tie within one device. A total
order is what makes replay deterministic: every device computes the same state
from the same set of events, whatever order they happened to arrive in.

Applying the sorted events in order is exactly a per-field last-write-wins
frontier. For any field, the value that survives is the one carried by the
greatest event under that ordering, so there is no separate per-field timestamp
to store. Storing one would be storing the same answer twice.

### The merge rules

**1. `timeDelta` events are commutative.** They carry an increment, not a total:
`{ day: "YYYY-MM-DD", ms: number }`. Two devices tracking the same task at the
same time produce a sum, not one overwriting the other.

This is the one case where last-write-wins is not merely imprecise but wrong, and
it is also the data most likely to be edited on two devices at once. It is why
`timeSpentOnDay` can only be written by a `timeDelta` event: an `update` cannot
set a total, so no code path can accidentally clobber tracked time with a stale
figure.

**2. Updates touching different fields both apply.** Renaming a task on the phone
while adding a tag to it on the laptop keeps both changes.

**3. Otherwise, last write wins per field**, under the ordering above.

**4. Delete beats a concurrent update**, whatever the timestamps say. The
alternative is that a late update resurrects a task you deleted, which is worse
than losing an edit to something you had already thrown away.

Replay also deduplicates by event `id`, so the same event file being read twice
changes nothing.

## The write path

One commit per sync, through the Git Data API. Four calls, regardless of how many
files change, because small file contents are inlined into the tree rather than
uploaded as separate blobs:

    GET   /repos/:o/:r/git/ref/heads/<branch>    the parent commit SHA
    POST  /repos/:o/:r/git/trees                 a tree, base_tree plus inline content
    POST  /repos/:o/:r/git/commits               the commit
    PATCH /repos/:o/:r/git/refs/heads/<branch>   move the branch

`<branch>` is the branch you configured, or, with none configured, whatever the
repository says its own default branch is. It is read once from the repository
and reused. Nothing here has a literal branch name in it, and it deliberately
does not fall back to `main`: an account that never changed the setting creates
repositories on `master`, and a client that assumed `main` would get a 404 that
reads like a broken token. Reads and writes resolve it the same way, because a
client that polled one branch and committed to another would be silently wrong.

The `PATCH` fails if the ref moved since the `GET`. **That rejection is the
concurrency check.** On failure the engine re-reads and rebuilds the whole write
against the new head, up to five attempts, then reports a conflict rather than
retrying forever.

`force: true` is never passed, anywhere, under any condition. A force push
against an append-only log is a data-loss weapon: it discards commits another
device has not read yet, and the correctness of everything above rests on the log
genuinely being append-only.

## The read path

    GET /repos/:o/:r/commits?sha=<branch>&per_page=1   with If-None-Match

A 304 does not count against the primary rate limit, so polling costs nothing.
When the ETag moves:

    GET /repos/:o/:r/git/trees/<sha>?recursive=1

returns every path and blob SHA in one request. Blobs are content-addressed and
immutable, so a local SHA-to-content cache never needs invalidating and only
genuinely new files are fetched.

At one sync per minute per device that is roughly 240 requests an hour against a
5,000 per hour primary limit and a 500 per hour content-generating secondary
limit.

## Compaction

When the log grows past 500 events beyond the snapshot, the next sync folds
everything older into a new snapshot and deletes those event files, in the same
commit. `snapshot.json` holds:

```ts
interface SnapshotFile {
  schemaVersion: number
  file: string     // the immutable copy: snapshot-<seq>-<rand>.json
  seq: number
  state: State
}
```

The immutable copy is the point. Two devices can decide to compact at the same
moment; they write different filenames, and only one of them wins the ref. A
fixed snapshot path could be clobbered between another device's write and its
read, leaving `snapshot.json` pointing at bytes nobody wrote.

Compaction never changes what state replays to. It only moves the starting point.

## Schema versioning

Every persisted field added after v1 is optional with a default. A required field
added to a persisted model breaks every existing install, and "existing install"
includes your own phone running a build from three months ago.

Hydration validates the schema version and refuses a snapshot it does not
understand rather than loading part of one. A field that is present but the wrong
type is an error, not a silent default: that is a corrupt file or a schema
mismatch, and quietly loading half of it is how a bad value ends up written back
over a good one.

## What is not in the log

**Secrets.** The GitHub token, the Apps Script secret and the Worker URL are per
device, kept in the platform store, and never appear in an event. The sync target
is a git repository: a token written there is a durable credential leak that
reaches every device and every clone, and stays in the history after you notice.

**Device identity.** `deviceId` and the device name are local. Two devices
sharing a `deviceId` would write the same event paths, and the entire merge model
rests on them never colliding.

Settings that are safe to share do sync, as `settings` events: the data
repository owner and name, the calendar URLs, theme, day start offset, idle
threshold and workday bounds.

## Time tracking

A running timer is stored as a start timestamp plus an accumulated duration, and
the elapsed figure is recomputed from the wall clock rather than counted by an
interval. This is exact, costs no battery, and survives process death.

It also survives Android suspending the WebView, which it does within seconds of
the app leaving the foreground. A JS interval would come back reading whatever it
read on the way out; recomputing from the wall clock on `resume` reads the truth.
On the desktop the OS idle time is available, so a long gap can be offered back
rather than silently counted.

Tracked time reaches the log as `timeDelta` events, bucketed by day, which is
what makes rule 1 above possible.

## Calendar

The calendar bridge is not part of the log. It is a Google Apps Script web app
deployed to your own account, called over HTTP from the shells' native stacks
because Apps Script cannot answer a CORS preflight.

Write-back is idempotent by construction: every written event carries
`extendedProperties.private.toHootId`, which is `<taskId>::<day>`. A re-sync looks
the event up by that key and updates it rather than inserting, so writing the same
block twice leaves one event rather than two. Writes go only to a separate
calendar named "to-hoot log"; your real calendars are read and never modified.

An Apps Script execution is killed at six minutes, so no handler walks a long
history: `listEvents` returns one page and a `nextPageToken`, `writeLog` takes at
most 50 entries, `deleteLog` at most 100, and the client chunks and loops.

## Reading your own data

Clone the data repository and look. Nothing is encrypted, encoded or compressed;
it is JSON with newlines.

```
git clone git@github.com:<you>/to-hoot-data.git
cd to-hoot-data
jq . snapshot.json | head -40
jq -s 'flatten | sort_by(.ts) | .[] | {ts, deviceId, type, entity, entityId}' events/*/*.json
```

The git history is the audit trail. Each commit message says what it was: `sync N
from <deviceId>`, or `compact N events into snapshot <seq>`. Because nothing is
ever force-pushed, the history is complete.
