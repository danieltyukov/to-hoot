# to-hoot MCP endpoint (Cloudflare Worker)

The same nine tools the stdio server offers, reachable from claude.ai. Deploy it
yourself; nothing here is tied to one account.

## Configuration

| Binding | Required | Meaning |
| --- | --- | --- |
| `MCP_PATH_SECRET` | yes | 32 or more random characters. The endpoint is `/mcp/<secret>`. |
| `GITHUB_OWNER` | yes | Owner of the data repository. |
| `GITHUB_REPO` | yes | The data repository. |
| `GITHUB_TOKEN` | yes | Fine-grained token, Contents read and write on that repository alone. |
| `GITHUB_BRANCH` | no | Defaults to `main`. |
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

One conditional GET per tool call once the isolate is warm. A cold client also
resolves the repository's default branch, once, unless `GITHUB_BRANCH` is set.
The Worker reads the prebuilt snapshot and
never replays the event log: the free tier allows 10ms of CPU per request, and
awaiting a fetch costs none of it while folding hundreds of events costs real
CPU. It never compacts either, because compaction reads everything and the
devices already do it on their own schedule.

Two consequences worth knowing:

- Events other devices wrote since the last compaction are not visible here.
  Events this Worker wrote are: they are held and replayed onto the snapshot
  until a compaction absorbs them.
- The running timer lives in the isolate, which can be recycled between two
  requests. `stop_timer` refuses rather than guessing when the start is gone,
  and says to use `log_time` instead.
