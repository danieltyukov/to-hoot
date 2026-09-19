# ToHoot 0.7.0: one button for every connection

An addendum to the 0.6.0 overhaul design. That release made sync a single
sign-in and left the calendar and the Claude endpoint as flows with a paste in
them: a token from Cloudflare's dashboard, and a script deployed by hand to
Apps Script. The person using the app asked for the same thing on all three,
and this release delivers it, within one floor that cannot be moved: Claude has
no API for adding a connector, so "copy the URL and press Add inside Claude"
remains the last step of the Claude setup.

## 1. Calendar: Sign in with Google

The Apps Script bridge existed because the app had no OAuth client of its own.
It now has two, registered to a Google Cloud project owned by the author, under
the contact@danieltyukov.com account: a Desktop client and an Android client.

- **Desktop.** The app opens Google's consent page in the browser and listens
  on `http://localhost:8976/oauth/callback` for the redirect. The listener is a
  Tauri command (`oauth_listen`) that binds the port, accepts until a GET to the
  callback path arrives, answers with a "signed in" page, and returns the URL.
  A cancel command raises a flag and connects to the port so a blocked accept
  wakes up. Port 8976 is Cloudflare's, and reusing it means one listener for
  both sign-ins.
- **Android.** The redirect is the reversed client id as a URL scheme,
  `com.googleusercontent.apps.<id>:/oauth2redirect`, registered by an intent
  filter on the main activity. `build.gradle` fills the scheme in from
  `google-oauth.json` at the repository root, the same file the web build reads
  its client ids from, so the two cannot drift. The shell listens for
  `appUrlOpen` and closes the Custom Tab.
- **PKCE** on both, S256, state checked on the way back. The Desktop client's
  secret is `VITE_GOOGLE_DESKTOP_CLIENT_SECRET` at build time; the Android
  client has none.
- **The grant** (`calendar.google`: refresh token, access token, expiry, email,
  log calendar id) is device-local settings, never synced. The core's
  `GoogleCalendarClient` refreshes the access token in place and hands refreshed
  tokens and the adopted log calendar id back through callbacks, which the UI
  service persists.
- **Modes.** `google` outranks `bridge` outranks `ics`. Signing out revokes the
  grant at Google, clears the block, and the app falls back to whatever was
  configured before.
- **The step.** One primary button, a Connected line that reads the calendars
  and names the account, Sign out. The iCal feed and the Apps Script bridge stay
  under two reveals. In a browser tab the button is disabled and says why.

## 2. Claude: Sign in and deploy

Cloudflare's dashboard has a public OAuth client, the one wrangler uses, whose
only registered redirect is `http://localhost:8976/oauth/callback`. The app uses
it: PKCE, the same loopback listener, scopes `account:read user:read
workers:write workers_scripts:write offline_access`. The token that comes back
lives in memory for the deploy, which is unchanged from 0.6.0 (download the
release's Worker, upload with the four secret bindings, enable the workers.dev
route, ask for tools), and is revoked when the deploy finishes, whatever the
outcome. An account that can deploy to more than one Cloudflare account is
asked which, and the token waits for that one press.

The pasted API token stays under a reveal beside the path secret. Wrangler
stays under its own.

Cloudflare's redirect cannot reach a phone, so this is a desktop button. The
Worker's hostname (`worker.base`) now syncs, so the phone shows "Endpoint
deployed from another device"; the path secret does not, so the URL that is a
credential stays where it was made.

## 3. What is not in this release

- Adding the connector inside Claude. There is no API for it.
- Signing in with Google on the web build. A tab has nowhere to receive a
  redirect; the feed and the bridge still work there.
- Migrating an existing bridge deployment. Signing in with Google simply takes
  precedence, and the bridge settings stay in place for whoever signs out.

## 4. Testing

- Core: the Google client against a scripted transport, thirty cases.
- UI: PKCE, callback parsing, both auth URLs, both exchanges, both revocations;
  the calendar step end to end with a fake loopback shell that answers with the
  state of the URL the app opened; the Claude step end to end the same way,
  including the revoke after the deploy; the phone's view of an endpoint
  deployed elsewhere.
- Rust: `cargo check`; the listener is exercised by hand against the real
  Google and Cloudflare sign-ins on this machine before the release.

## 5. 0.7.1, after the first day in use

- **Add to Claude Code.** The desktop shell gains two commands that read and
  rewrite `~/.claude.json`, adding or replacing the `to-hoot` entry under
  `mcpServers` and touching nothing else (a file that is not a JSON object is
  refused, not overwritten; the write is a temp file renamed into place). The
  entry is `http` with the endpoint URL when one is deployed, `stdio` with the
  local server otherwise. The step shows what the file says on open, and calls
  the entry stale when the endpoint no longer matches it.
- **The address on the calendar step** comes from the primary calendar's id,
  since the calendar scope alone gets a 401 from the userinfo endpoint. That
  endpoint stays as the fallback.
- **The Android client** needs Google's "Enable custom URI scheme" switch,
  which is off for new clients and produced "Access blocked: request is
  invalid" on the phone. Flipped in the console; written into the fork notes.
- The Cloudflare line no longer says "Signed in and deployed" from a saved
  endpoint; the title carries the state.
