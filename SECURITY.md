# Security

## Reporting

Use GitHub's private vulnerability reporting: the Security tab of
<https://github.com/danieltyukov/to-hoot>, then "Report a vulnerability". That
opens a private thread visible only to the maintainers, which is the right place
for anything you would not want in a public issue.

This is one person's side project with no service behind it and no on-call
rotation. Expect a reply in days, not hours. There is no bounty.

If the report is about your own deployment rather than about this code, rotate
first and report second: revoke the GitHub token, redeploy the Apps Script web
app with a new secret, and delete the Worker. Each of those is yours alone and
none of them needs anybody else's cooperation.

## Where the secrets live

Every credential this app touches belongs to the person running it. There is no
shared account, no server holding anything on your behalf, and no telemetry.

| Secret | Stored in | Scope |
|---|---|---|
| GitHub fine-grained token | Platform store: `tauri-plugin-store` on desktop, `@capacitor/preferences` on Android | Contents read and write, on the data repository alone |
| Apps Script shared secret | Platform store, and a Script Property named `TO_HOOT_SECRET` in your own Apps Script project | Your Apps Script deployment |
| Apps Script `/exec` URL | Platform store | Your Google account |
| Worker path secret | Platform store, and a Worker secret in your own Cloudflare account | Your Worker |
| Android release keystore | Outside the repository, and in Actions secrets as base64 for CI | Signing releases |

**Tokens are per device and never sync.** They are deliberately kept out of the
event log. A token that syncs is a token that reaches every device you own and
lands in the data repository, where it stays in the git history after you notice.

Settings shows tokens masked, with a Show control beside each. The Apps Script
secret can be rotated from the app, which generates a new one and shows it. The
script source does not change, because the secret was never in it: what changes
is the value you set `TO_HOOT_SECRET` to in your own project.

## The GitHub token

Ask for a fine-grained personal access token, not a classic one, with
**Contents: read and write** on the single data repository and nothing else. A
classic token carries `repo` across every repository you can reach, which is a
much larger blast radius for the same functionality.

The data repository should be private and should hold data only: no code, no
Actions, no workflows. Nothing in this project ever executes anything it reads
from there.

The sync path never passes `force: true` on a ref update, anywhere. The write is
a compare-and-swap against the parent commit, and a rejected update means
re-read and retry. A force push against an append-only log destroys history that
another device has not read yet.

## The capability URL

The optional Cloudflare Worker exposes MCP at `/mcp/<secret>` with no
authentication. The path segment is the credential: anyone holding that URL can
read and write your task list. It is a capability URL, and it is only as private
as wherever you paste it.

The shape is deliberate. Anthropic supports authless MCP connectors, and running
an OAuth server to protect one person's task list is a large amount of machinery
with its own attack surface. Three things make it defensible:

- The secret is in the path, not the query string. Query strings are what
  proxies, browser histories and access logs record in full.
- Every request whose path is not the endpoint gets a 404, the same answer an
  unrouted path gets, so the endpoint cannot be found by probing.
- The Worker checks `Origin` before the MCP handler sees the request, and checks
  `Host` against `ALLOWED_HOSTNAMES` when you set it.

Generate it with at least 32 random characters:

```
openssl rand -base64 32 | tr -d '/+=' | cut -c1-32
```

To revoke, run `wrangler secret put MCP_PATH_SECRET` with a new value and update
the connector in Claude. The old URL 404s from the next request onward.

If you do not want a capability URL at all, skip the Worker. The stdio MCP
server for Claude Code is a local process with no network listener, and
everything else in the app works without either.

## The Apps Script bridge

The bridge is deployed with "Who has access: Anyone", because Apps Script has no
other setting that lets a non-browser client reach it. "Anyone" means no Google
sign-in, so the shared secret is the whole of the authentication. It travels in
the request body and never in the query string, because Apps Script logs request
URLs.

The bridge writes only to a separate calendar named "to-hoot log", found or
created on first use. Your real calendars are read and never modified, so a bug
in write-back can only damage events this app wrote, and the whole layer switches
off with one checkbox in Google Calendar.

## Releases

Release binaries are built by `.github/workflows/release.yml` on a tag, on
GitHub-hosted runners, from the commit the tag points at. The workflow is in the
repository and the build log is public, so you can check what went into an
artifact before you install it.

The Android keystore reaches CI as a base64 secret, is written to a temp file,
and is removed in an `always()` step. It is not in the repository and never has
been. If it is ever lost, updates can no longer install over an existing
installation, and recovering means uninstalling, which destroys local app data.

## Scope

Out of scope for a report: anything that requires an attacker to already have
your device unlocked, or to already hold your GitHub token. Both of those are
game over by construction, and this project does not pretend otherwise.
