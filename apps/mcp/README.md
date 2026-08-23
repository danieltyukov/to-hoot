# to-hoot MCP server (stdio)

Gives Claude the same nine tools the app uses, over stdio, against your own
GitHub data repository. Nothing is hardcoded: every account value is read from
the environment.

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

`list_tasks`, `search_tasks` and `today` read. `add_task`, `update_task`,
`complete_task`, `start_timer`, `stop_timer` and `log_time` write, each as one
event appended to the log, so a change made here is indistinguishable from one
made in the app.

The timer belongs to this server rather than to the app running on your
devices, and it lives in `$TO_HOOT_STATE_DIR/timer.json` so it survives the
server being restarted between the start and the stop. A span longer than
twelve hours is a forgotten timer: `stop_timer` clears it and records nothing,
and says so.
