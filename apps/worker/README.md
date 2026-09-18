# to-hoot MCP endpoint (Cloudflare Worker)

The same fifteen tools the stdio server offers, reachable from claude.ai. The
list, and how projects and tags can be named by title, is in
[`apps/mcp/README.md`](../mcp/README.md). Deploy it yourself; nothing here is
tied to one account.

## Configuration

| Binding | Required | Meaning |
| --- | --- | --- |
| `MCP_PATH_SECRET` | yes | 32 or more characters from `A-Za-z0-9._~-`. The endpoint is `/mcp/<secret>`. |
| `GITHUB_OWNER` | yes | Owner of the data repository. |
| `GITHUB_REPO` | yes | The data repository. |
| `GITHUB_TOKEN` | yes | Fine-grained token, Contents read and write on that repository alone. |
| `GITHUB_BRANCH` | no | Unset means whatever the repository's default branch is. |
| `GITHUB_API_BASE` | no | For GitHub Enterprise. |
| `DEVICE_ID` | no | One path segment. Defaults to `worker`. |
| `ALLOWED_HOSTNAMES` | no | Comma separated. Defaults to the request's own host. |

Set all four secrets with `wrangler secret put NAME`; none of them belongs in
`wrangler.jsonc`. Generate the path secret with
`openssl rand -base64 32 | tr -d '/+=' | cut -c1-32`.

```
npx wrangler deploy
```

Then add `https://<name>.<subdomain>.workers.dev/mcp/<secret>` as a custom
connector in Claude, with authentication set to none.

## Why it is shaped this way

Authless, because Anthropic supports it and an OAuth server for one person's
task list is a lot of machinery to protect one token. The secret lives in the
path segment rather than the query string, because query strings are what
proxies, browser histories and access logs record in full. Anything that is not
the endpoint gets a 404, which is also what an unrouted path gets.

The handler validates neither Host nor Origin, so the Worker does both in front
of it. With no `ALLOWED_HOSTNAMES` set the Host check is a no-op, since
Cloudflare only routes a hostname to a Worker configured for it, but the Origin
check still refuses a page on another origin.

What a tool call costs, against the 50 subrequests the free tier allows, where
`t` is the number of event files in the repository, at most 32:

| | configured branch | unset branch |
| --- | --- | --- |
| read, warm isolate | 1 | 1 |
| read, cold isolate | 3 + t | 4 + t |
| write, warm isolate | 5 | 5 |
| write, cold isolate | 8 + t | 9 + t |

A warm read is a single conditional GET that answers 304. A cold one adds the
tree, the snapshot blob and one blob per event file; a write adds a conditional
GET and four more for the commit, which is four however many files it carries.
Leaving `GITHUB_BRANCH` unset costs one extra request to read the repository's
default branch, and only once per isolate, because the answer is cached on the
client. With one event file in the tree, which is the ordinary shape between
two compactions, a cold write is 9 or 10.

The Worker reads the prebuilt snapshot and then the tail of the event log, up
to 32 files, and never the whole log: the free tier allows 10ms of CPU per
request, and awaiting a fetch costs none of it while folding hundreds of events
costs real CPU. Each event blob is cached by its SHA, so a file is fetched once
per isolate however many reads follow. When the tree holds more than 32 event
files it reads none of them, rather than some, and answers from the snapshot
alone. The devices compact at 30 files, so that only happens when a device has
stopped syncing for a long time. It never compacts itself, because compaction
reads everything and the devices already do it on their own schedule.

Two consequences worth knowing:

- Events other devices wrote since the last compaction are visible here while
  the tree holds at most 32 event files. Past that the Worker falls back to the
  snapshot until the next compaction. Events this Worker wrote are visible
  either way: they are held and replayed onto the snapshot until a compaction
  absorbs them.
- The running timer lives in the isolate, which can be recycled between two
  requests. `stop_timer` refuses rather than guessing when the start is gone,
  and says to use `log_time` instead.
