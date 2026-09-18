# to-hoot MCP server (stdio)

Gives Claude fifteen tools over the same data the app uses, over stdio, against
your own GitHub data repository. Nothing is hardcoded: every account value is
read from the environment.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `TO_HOOT_GITHUB_OWNER` | yes | Owner of the data repository. |
| `TO_HOOT_GITHUB_REPO` | yes | The data repository. |
| `TO_HOOT_GITHUB_TOKEN` | yes | Fine-grained token with Contents read and write on that repository alone. |
| `TO_HOOT_GITHUB_BRANCH` | no | Unset means whatever the repository's default branch is. |
| `TO_HOOT_GITHUB_API_BASE` | no | For GitHub Enterprise. Defaults to the public API. |
| `TO_HOOT_DEVICE_ID` | no | One path segment, unique per device. Defaults to `mcp-<hostname>`. |
| `TO_HOOT_STATE_DIR` | no | Where the running timer is kept. Defaults to `~/.to-hoot`. |

A blank value counts as unset, so exporting an empty token fails with the name
of the variable rather than a 401 from GitHub.

## Running it

```
npm run build -w @to-hoot/core && npm run build -w @to-hoot/mcp
npx @modelcontextprotocol/inspector node apps/mcp/dist/index.js
claude mcp add to-hoot -- node "$PWD/apps/mcp/dist/index.js"
```

stdout carries the protocol and nothing else. Every log line goes to stderr,
and `console.log`, `.info` and `.debug` are redirected there at startup so a
dependency cannot corrupt the stream.

## Tools

Fifteen, registered in one list in `@to-hoot/core/tools` so this server and the
Cloudflare Worker cannot drift.

`list_tasks`, `search_tasks`, `today`, `list_projects` and `list_tags` read.
`add_task`, `update_task`, `complete_task`, `start_timer`, `stop_timer`,
`log_time`, `add_project`, `update_project`, `add_tag` and `update_tag` write,
each as one batch appended to the log, so a change made here is
indistinguishable from one made in the app.

The project and tag tools:

| Tool | Does |
| --- | --- |
| `list_projects` | Every project with id, title, colour, archived flag and open-task count, plus the built-in Inbox with its count. |
| `add_project` | Creates a project. The title is required and must not be in use, ignoring case; the colour defaults to the next in the app's own palette. |
| `update_project` | Renames, recolours, archives or unarchives a project by id. |
| `list_tags` | Every tag with id, title, colour and open-task count. |
| `add_tag` | As `add_project`, for a tag. |
| `update_tag` | Renames or recolours a tag by id. |

Projects and tags can be named by title as well as by id. `add_task` and
`update_task` take `project` (a title) and `tags` (titles) beside `projectId`
and `tagIds`, and `list_tasks` takes `project` and `tag` beside its id filters.
A title is matched ignoring case and surrounding whitespace; `Inbox` names the
built-in project. A title nothing matches is created in the same batch as the
task that named it, so "add a task to the Radio project" works before the
project exists. Passing both forms of one field is refused. Every task the
tools return carries `project` and `tags` titles beside the ids, so a listing
reads without a second lookup.

The timer belongs to this server rather than to the app running on your
devices, and it lives in `$TO_HOOT_STATE_DIR/timer.json` so it survives the
server being restarted between the start and the stop. A span longer than
twelve hours is a forgotten timer: `stop_timer` clears it and records nothing,
and says so.
