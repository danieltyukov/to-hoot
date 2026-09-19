# Security

## Reporting

Use GitHub's private vulnerability reporting: the Security tab of
<https://github.com/danieltyukov/to-hoot>, then "Report a vulnerability". That
opens a private thread visible only to the maintainers, which is the right place
for anything you would not want in a public issue.

This is one person's side project with no service behind it and no on-call
rotation. Expect a reply in days, not hours. There is no bounty.

If the report is about your own deployment rather than about this code, rotate
first and report second: revoke the GitHub token, remove ToHoot under your
Google account permissions, and delete the Worker. Each of those is yours alone and
none of them needs anybody else's cooperation.

## Where the secrets live

Every credential this app touches belongs to the person running it. There is no
shared account, no server holding anything on your behalf, and no telemetry.

| Secret | Stored in | Scope |
|---|---|---|
| GitHub token, from Sign in with GitHub or pasted | Platform store: `tauri-plugin-store` on desktop, `@capacitor/preferences` on Android | `repo` from sign-in; Contents read and write on the data repository alone from a fine-grained token |
| Google OAuth grant, from Sign in with Google | Platform store | `calendar` on the account you signed in with |
| Cloudflare OAuth token, from Sign in and deploy | Nowhere. Held in memory for one deploy and revoked when it is done | Workers Scripts: Edit and Account Settings: Read on your account |
| Cloudflare API token, pasted instead of signing in | Nowhere. Used for one deploy from Settings and dropped | Whatever you gave it; the prefilled page asks for the same two |
| Apps Script shared secret, if you use the bridge | Platform store, and a Script Property named `TO_HOOT_SECRET` in your own Apps Script project | Your Apps Script deployment |
| Apps Script `/exec` URL, if you use the bridge | Platform store | Your Google account |
| Worker path secret | Platform store, and a Worker secret in your own Cloudflare account | Your Worker |
| Worker URL, if you pressed Add to Claude Code | Also in `~/.claude.json`, Claude Code's own config, as the `to-hoot` server entry, exactly where `claude mcp add` would put it | Claude Code on that machine |
| Android release keystore | Outside the repository, and in Actions secrets as base64 for CI | Signing releases |

**Tokens are per device and never sync.** They are deliberately kept out of the
event log. A token that syncs is a token that reaches every device you own and
lands in the data repository, where it stays in the git history after you notice.

Settings shows tokens masked, with a Show control beside each. The Apps Script
secret can be rotated from the app, which generates a new one and shows it. The
script source does not change, because the secret was never in it: what changes
is the value you set `TO_HOOT_SECRET` to in your own project.

## The GitHub token

There are two ways a token reaches the app, and they carry different scopes.

**Sign in with GitHub** runs GitHub's OAuth device flow against the ToHoot OAuth
App (client id `Ov23liL8JUqlMBxGIk3l`, a public identifier; a fork registers its
own and sets `VITE_GITHUB_CLIENT_ID`). The token it hands over carries the
`repo` scope, because OAuth Apps have no narrower scope that reaches a private
repository. That is broad. What makes it acceptable is that the token is minted
on the device, stored in the platform store, never shown, and never typed
anywhere, and that you can revoke it in one place: github.com, Settings,
Applications, Authorized OAuth Apps, ToHoot. The app never receives a client
secret, because the device flow does not use one.

**Use a token instead** takes a fine-grained personal access token with
**Contents: read and write** on the single data repository and nothing else,
plus **Administration: write** only if you want the app to create the
repository. That is the narrower credential and the right one if the `repo`
scope is more than you are willing to hold on a phone.

Whichever way it arrived, the token stays on the device it arrived on and never
enters the event log. A second device signs in for itself.

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

To revoke, generate a new path secret in Settings, Claude and press Deploy
again, or run `wrangler secret put MCP_PATH_SECRET` with a new value, then
update the connector in Claude. The old URL 404s from the next request onward.

The deploy from Settings signs in with Cloudflare through the same public OAuth
client wrangler uses, with PKCE, and the redirect lands on the desktop app's
own loopback listener at `localhost:8976`. The token it gets can rewrite every
Worker on the account, so the app holds it in memory for the one upload and
then revokes it: it is not written to the platform store, the log, or anywhere
else, and a redeploy signs in again. A pasted API token, the alternative, is
treated the same way except that revoking it is yours to do on the dashboard.

If you do not want a capability URL at all, skip the Worker. The stdio MCP
server for Claude Code is a local process with no network listener, and
everything else in the app works without either.

## Google Calendar

Sign in with Google asks for the `calendar` scope alone and keeps the grant on
the device, in the platform store, never in the log. The desktop app receives
the redirect on the loopback interface and the Android app on a custom URL
scheme; both use PKCE, so the code that comes back is useless to anything that
did not start the sign-in. Sign out revokes the grant at Google and forgets it
locally. The app writes only to a separate calendar named "to-hoot log", found
or created on first use, so a bug in write-back can only damage events this
app wrote. Your real calendars are read and never modified.

## The Apps Script bridge

Kept for a deployment that already exists. The bridge is deployed with "Who has access: Anyone", because Apps Script has no
other setting that lets a non-browser client reach it. "Anyone" means no Google
sign-in, so the shared secret is the whole of the authentication. It travels in
the request body and never in the query string, because Apps Script logs request
URLs.

The bridge writes to the same "to-hoot log" calendar and never to your real
ones, and the whole layer switches off with one checkbox in Google Calendar.

## Releases

Release binaries are built by `.github/workflows/release.yml` on a tag, on
GitHub-hosted runners, from the commit the tag points at. The workflow is in the
repository and the build log is public, so you can check what went into an
artifact before you install it.

The Android keystore reaches CI as a base64 secret, is written to a temp file,
and is removed in an `always()` step. It is not in the repository and never has
been. If it is ever lost, updates can no longer install over an existing
installation, and recovering means uninstalling, which destroys local app data.

## Known advisories

One moderate advisory is open against a transitive dependency, and it is not
fixable from this repository. It is listed here rather than left for a reader to
find in the Dependabot tab and wonder about.

**`glib` 0.18.5, unsoundness in the `Iterator` and `DoubleEndedIterator` impls
for `VariantStrIter`.** It arrives through Tauri's GTK stack, and not by one
route: `cargo tree -i gtk` shows four independent parents (`tao` for the window,
`muda` for menus, `libappindicator` for the tray, and `tauri` itself), so
dropping a feature does not drop the dependency. The advisory is fixed in `glib`
0.20, and `gtk` 0.18 is what pins it below that; Tauri 2.11.5, the current
release, still builds on `gtk` 0.18. `cargo update -p glib` locks zero packages.
The fix has to arrive as a Tauri release, not as a change here. The affected
iterators are not reachable from any code in this repository.

It is re-checked whenever Tauri is upgraded.

### Closed

**`uuid` 7.0.3, missing buffer bounds check in v3/v5/v6 when `buf` is provided.**
It arrived as `@capacitor/cli` -> `xcode` -> `uuid`, and is resolved by an
`overrides` entry in `apps/mobile/package.json` pinning `uuid` to `^11.1.1`.
`xcode` calls exactly one uuid function, `v4()`, which is unchanged across the
gap, and the advisory concerns `v3`/`v5`/`v6` with a `buf` argument, which it
never calls. The override is a real removal rather than a suppression: `uuid`
7.0.3 is no longer anywhere in `apps/mobile/package-lock.json`.

## Scope

Out of scope for a report: anything that requires an attacker to already have
your device unlocked, or to already hold your GitHub token. Both of those are
game over by construction, and this project does not pretend otherwise.
