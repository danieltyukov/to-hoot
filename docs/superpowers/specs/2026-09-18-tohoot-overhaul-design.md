# ToHoot 0.6.0: the name, the icon, Claude's projects and tags, setup you press rather than type, and a visual refresh

Date: 2026-09-18
Status: approved by the owner in advance ("full authority"), implemented on `feat/tohoot-overhaul`, shipping as 0.6.0

Five asks, in the owner's words, and what each becomes:

| Ask | What ships |
|---|---|
| "the icon on mobile does not look good" | A new launcher icon: clay ground, ink owl face, drawn as an adaptive icon with a themed (monochrome) layer, plus a matching splash and desktop icon. |
| "the name ... ToHoot on mobile and desktop" | The product is called ToHoot everywhere a person reads it. Package, binary, repository and data-repository names stay `to-hoot`. |
| "with claude i want to be able to create projects and tags too" | Six new tools, tasks that take project and tag names rather than ids, and a Worker that reads the whole log so Claude on the web sees what the desktop wrote a minute ago. |
| "simplifying the config with cloud, github, calendar ... button presses not actual things being entered" | Sign in with GitHub instead of pasting a token. The data repository is found or created for you and the device is named for you. The Claude endpoint deploys from inside the app against the Cloudflare API. The calendar step becomes numbered buttons with one unavoidable paste. |
| "on the laptop ill see the laptop and phone tasks and vice versa" | Already true by construction, and now visible: Settings lists every device that writes to the repository and when it last synced, and the app polls once a minute rather than every five. |

Plus "overall design betterment so it looks more slick and feels more smooth and modern", which runs through every screen below.

## 1. The name

The word a person sees is **ToHoot**. That covers the wordmark, the title bar, the window title, the Android launcher label, the `.desktop` entry, the tray menu, the splash, the favicon title, the site, and the READMEs' first line.

Everything that is an identifier stays `to-hoot`: the GitHub repository, the npm packages, the Tauri `productName` and `mainBinaryName` (which name the deb package, the binary and the icon files, so an installed 0.5.x upgrades in place), the Android `applicationId` `com.tohoot.app`, the Worker name `to-hoot-mcp`, the MCP server name, the suggested data repository `to-hoot-data`, and the `to-hoot log` calendar. Renaming any of those breaks an upgrade or a connector for no gain a reader would notice.

The `.desktop` template is where `Name=` comes from on Linux. It is a Tauri handlebars template and currently reads `Name={{name}}`; it becomes `Name=ToHoot` so the launcher says the product name while the package keeps its own.

The wordmark component renders `ToH` + `o` + `o` + `t`, so the two pupils stay in the `oo` of `Hoot`. `textContent` is `ToHoot`, which is what selection, search and a screen reader get.

## 2. The icon and the splash

**What is wrong.** The launcher PNGs carry a near-black square with a clay disc at 64% of the canvas. Behind an adaptive-icon mask that reads as a dark blob with a small orange circle, and there is no monochrome layer, so a phone on Android 13 with themed icons shows nothing of the mark at all. The splash is still Capacitor's stock blue cross on white.

**The new icon.** The owl face fills the icon instead of sitting inside a disc: a clay ground (`#c2603f`, the light-theme accent, which reads on both light and dark wallpapers) with the two eyes and the beak in ink (`#12110f`). The eye and beak geometry is the same three subpaths `OwlIcon`, the favicon and the launcher already share, scaled so the face spans about 47dp of the 66dp safe zone and sits a fraction above centre, because a beak points down and the face otherwise looks like it is sinking.

Android gets it as an adaptive icon built from vectors rather than PNGs:

- `mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml`: background `@color/ic_launcher_background` (now the clay), foreground `@drawable/ic_launcher_foreground` (a vector of the face), and a `<monochrome>` layer pointing at the same vector, which is what themed icons tint.
- `drawable/ic_launcher_foreground.xml`: the face as a `<vector>` in the 108dp viewport, so every density renders from one file. The stock `drawable-v24` foreground and the hidden-background grid drawable go.
- `mipmap-*/ic_launcher.png` and `ic_launcher_round.png`: regenerated for Android 7, the only place they are still read, from the same SVG with `rsvg-convert`.

The splash uses the `core-splashscreen` theme the project already depends on, properly this time: `windowSplashScreenBackground` is the app's paper (`#faf8f5`, `#12110f` under `values-night`), `windowSplashScreenAnimatedIcon` is the launcher foreground, and `postSplashScreenTheme` hands over to the app theme. The ten `splash.png` drawables are deleted.

The desktop takes the same artwork as a rounded square (radius 22%) through `tauri icon`, which regenerates every size including the `.icns` and `.ico`. The favicon keeps the negative-space disc: at 16px a face on a clay square is a clay square.

`marks.test.ts` changes from "the three files carry one path" to "the three files carry the same eyes and beak": the favicon and `OwlIcon` keep the disc, the launcher source and the desktop source carry the face on a ground, and the test asserts the eye and beak subpaths are byte-identical across all four.

## 3. Claude: projects and tags, names rather than ids, and a Worker that sees the log

### 3.1 Six new tools

| Tool | Does |
|---|---|
| `list_projects` | Every project with id, title, colour, archived flag and open-task count, plus the implicit Inbox with its count. |
| `add_project` | Creates a project. Title is required; colour defaults to the next in the app's own six-colour cycle. A title already in use (case-insensitive) is refused with the existing id in the message. |
| `update_project` | Renames, recolours, archives or unarchives by id. |
| `list_tags` | Every tag with id, title, colour and task count. |
| `add_tag` | As `add_project`, for a tag. |
| `update_tag` | Renames or recolours by id. |

Fifteen tools in total, registered in one list so the stdio server and the Worker cannot drift. The colour cycle moves from `packages/ui/src/store.ts` to core as `ENTITY_COLORS`, so the app and the tools pick from one palette.

### 3.2 Names as well as ids

Claude thinks in words. `add_task` and `update_task` accept `project` (a title) and `tags` (an array of titles) beside the existing `projectId` and `tagIds`, and `list_tasks` accepts `project` and `tag` titles beside its id filters. A title is matched case-insensitively; a title nothing matches is created in the same event batch as the task, so "add a task to the Radio project" works before the project exists. Passing both the id and the name form of one field is refused as ambiguous.

Every task the tools return now carries `project` (the title, or `Inbox`) and `tags` (titles) beside the ids, so a listing reads without a second lookup.

### 3.3 A Worker that reads the tail

Today the Worker reads `snapshot.json` and nothing else, so a task the desktop wrote after the last compaction is invisible to Claude on the web until the next one, which at the 500-event threshold can be days. Two changes close that:

1. **The Worker reads the event files too, up to a cap.** After the snapshot it fetches every `events/<device>/<ulid>.json` in the tree when there are at most 32 of them, cached by blob sha exactly as the snapshot is, and replays them onto the snapshot along with its own pending writes. Above the cap it falls back to today's behaviour. Budget: 3 requests for the snapshot path plus at most 32 blobs plus 4 for a write is 39 of the 50 subrequests the free tier allows, and replaying a few hundred events onto a hundred tasks is well under a millisecond of the 10ms CPU budget. The `tools.test.ts` claim "never reads an event blob" becomes "reads the tail when it is short, and never when it is long".
2. **Compaction also triggers on file count.** `SyncEngine` folds the log when the events past the snapshot reach 500 **or** the event files reach 30, so the tail the Worker reads is bounded by the devices that write it. A compaction also deletes every earlier `snapshot-<seq>-<rand>.json` copy in the tree: `snapshot.json` is the file every reader opens, the copy exists to make two concurrent compactors harmless, and once the ref has moved the previous copies point at nothing. Forty-one of them sit in the owner's repository today.

## 4. Setup and Settings

The rule for every connection: a button that does the thing, a status line that says what it did, and a field only where a third party leaves no alternative.

### 4.1 Sync: Sign in with GitHub

**The button.** "Sign in with GitHub" runs GitHub's OAuth device flow against the ToHoot OAuth App (client id `Ov23liL8JUqlMBxGIk3l`, a public identifier baked into `setup.ts` and overridable with `VITE_GITHUB_CLIENT_ID` for a fork). The app requests a device code, shows the eight-character user code in large type with a Copy button, copies it to the clipboard, and offers "Open GitHub", which opens `github.com/login/device` through the shell's `openUrl`. It then polls the token endpoint at the interval GitHub names, backing off on `slow_down`, until the browser approves, the code expires, or the person cancels. No client secret exists and none is needed for this flow.

The token has the `repo` scope, because OAuth Apps have no narrower private-repository scope. It never leaves the device and is never shown, which is a different posture from a token someone types, and `SECURITY.md` says so. The fine-grained token path stays for anyone who wants a single-repository credential, collapsed under "Use a token instead", and once a token is in hand by either route the rest of the flow is identical.

**The repository, without a form.** With a token the app lists the account's own repositories and looks for `to-hoot-data`. Found: it inspects it and joins. Absent: it creates it, private, and gives it its first commit. A different name is one tap away under "Use another repository", which reveals the existing name field and the existing create-or-select pair. Nothing about the Git Data API path changes.

**The device, named for you.** Each shell now says what it is: `Platform.kind` is `'desktop'`, `'android'` or `'browser'`. The suggested name is `desktop`, `phone` or `browser`. When the repository already has a device by that name the app asks one question with two buttons: "This is that phone, set up again" (reuse, which is today's "I am replacing that machine") or "It is another one" (which takes `phone-2`). The name field stays visible and editable underneath, so nothing is hidden, and every rule about path segments and clashes holds as before.

**Then it tests itself.** The connection check that used to sit behind a button runs on its own once the token, repository and device are settled, and the status line reads "Connected. Tasks from every device appear here." or the real error. The three buttons that existed (Verify token, Create it for me, Test sync) become one flow that a person can watch happen.

### 4.2 Calendar

Google requires a person to create the script, so this step keeps one paste. Everything else becomes a button, in three numbered stages:

1. **Open Apps Script** (opens `script.google.com/home/projects/create`), **Copy the script**.
2. **Copy the secret**, with the property name shown beside it. Rotate stays.
3. **Paste the deployment URL**, the one field, then **Test calendar**, which runs as soon as a URL that looks right is pasted.

The read-only iCal route stays underneath as the "only show my events" alternative, with **Open Google Calendar settings** beside its one field. The prose shrinks to one sentence per stage.

### 4.3 Claude: the endpoint deploys from the app

Claude Code keeps its copyable `claude mcp add` command; that path is for a machine with a terminal.

The web endpoint stops asking anyone to run wrangler. Three stages:

1. **Create a Cloudflare token.** Opens `dash.cloudflare.com/profile/api-tokens` with the permission set prefilled in the URL (Workers Scripts: Edit, Account Settings: Read, named ToHoot). The copy says which template to pick if the form did not prefill, because that prefill is a dashboard convenience the app cannot verify. The person presses Create, presses Copy, and pastes it into the one field. The token is used for the deploy and then forgotten: it is a powerful credential and the app has no reason to keep it.
2. **Deploy the endpoint.** One button. The app fetches the Worker bundle for its own version from the release assets (`to-hoot-worker.mjs`, a new asset the release workflow produces with `wrangler deploy --dry-run --outdir`), uploads it with `PUT /accounts/{id}/workers/scripts/to-hoot-mcp` as a multipart body whose metadata carries `main_module`, the compatibility date and flags, observability, and the four secrets as `secret_text` bindings (the GitHub token the app already holds, the owner, the repository, the path secret, plus the branch when one is configured), enables the `workers.dev` route for the script, registers an account subdomain if the account has none, and then runs the existing `tools/list` check against the resulting URL, retrying briefly while DNS catches up. An account with more than one Cloudflare account gets a chooser. The status line names the endpoint and the tool count.
3. **Add it to Claude.** "Copy the endpoint and open Claude" copies the URL and opens the connectors page.

The wrangler commands stay under "Deploy with wrangler instead", unchanged, for people who prefer a terminal or a fork with no release assets.

The Worker itself changes only where section 3 says. `SERVER_INFO.version` reports the core version rather than a stale `0.1.0`.

### 4.4 Settings

Settings becomes one scrolling page of cards, 640px wide on the desktop and full width on a phone:

- **Connections**: Sync, Calendar, Claude. Each card carries a glyph, a title, a status line ("danieltyukov/to-hoot-data, synced 2 min ago, 2 devices" or "Not connected") and one button, Set up or Manage, which expands the card into the same component the wizard uses.
- **Devices**, shown once sync is configured: every device in `meta.json` with when it last wrote, this device marked. This is the answer to "will I see the phone's tasks here": the phone is in the list, and so is its last sync.
- **Preferences**: theme as a three-way segmented control, workday hours, day start, idle threshold.
- **Data**: where the data lives, export, import, event count, and the damaged-log notice when there is one.
- A version line at the foot.

### 4.5 The wizard

Same four steps, same components, redrawn: a centred card with the progress as four pills, a filled primary button, and Skip in plain text beside it. Step one keeps its claim that there is nothing to set up.

## 5. Sync visibility

- The poll runs once a minute instead of every five. A conditional GET that answers 304 costs nothing against the primary rate limit, which is what the architecture document already assumed.
- `SyncEngine` exposes the device registry it reads, and the controller puts it on `SyncStatus`, which is what the Devices card renders.
- A running timer stays device-local by design; what crosses is the tracked time, every thirty seconds of it, and it now arrives within a minute.

## 6. The visual refresh

Everything below stays inside the rules `styles.test.ts` enforces: no colour literal outside the token sheet, no gradient, no blur, no border and shadow on one element, no transform under the pointer, every duration a token.

- **Tokens.** `--r-panel: 10px` arrives, as the token sheet promised it would with the first panel. `--on-accent` arrives for text on a filled accent control: white in light, ink in dark, tested at 4.5:1 against `--accent-hover` in both themes.
- **Buttons.** `.button-primary`: filled `--accent-hover`, `--on-accent` text. Used once per screen: Sign in, Deploy, Next.
- **Sidebar.** Glyphs beside Today, Projects and Tags, a settings row with a gear at the foot beside the theme toggle, counts right-aligned, and 8px more breathing room.
- **Rows.** A running row gets a 2px inset accent edge, tags show as small pills after the title on wide screens, and the composer gets a plus glyph and a placeholder that names the list it adds to.
- **Phone.** The three tabs get glyphs above their labels. Pane changes fade in over `--dur-base`.
- **Cards** for Settings and the wizard, as above, with hairlines and `--r-panel`, no shadows.

## 7. Not changing

| Not doing | Why |
|---|---|
| Renaming the deb, the binary, the app id or the Worker | Every one breaks an in-place upgrade or a connector. |
| Syncing tokens or secrets between devices | Still the wrong place for a credential. Sign-in makes the second device cheap instead. |
| Storing the Cloudflare token | It can rewrite every Worker on the account. Used once, then gone. |
| A GitHub App instead of an OAuth App | Fine-grained, but the install step makes a phone flow longer, and a user token cannot reach a repository it just created unless the installation covers all repositories. |
| Scanning a QR code from the desktop | Needs a camera plugin and a deep link the phone's camera app may not honour. Sign-in is two taps on the phone itself. |
| Reading the log in the Worker past 32 files | The subrequest budget is hard. Compaction on file count is what keeps the tail short. |
| Deleting tasks from Claude | Not asked for, and a destructive tool deserves its own conversation. |

## 8. Testing

- **core**: the six tools and the name resolution; `add_task` creating a missing project and tag in one batch; the refusal of id and name together; compaction on file count; deletion of earlier snapshot copies; the snapshot backend reading a short tail and skipping a long one.
- **worker**: fifteen tools advertised; the read path fetching event blobs when there are few and not when there are many; the request budget assertions updated to the new numbers.
- **mcp**: the tool count in the dist smoke test.
- **ui**: device flow start, poll, `slow_down`, expiry and denial against a fake transport; repository discovery (found, absent, another name); device naming and the two-button clash; the Cloudflare deploy composing the multipart body with all four bindings, choosing an account, registering a subdomain, and surfacing each API error by message; Settings cards and the Devices list; the wizard's new controls all named and unique; the wordmark reading `ToHoot`; the tokens and styles audits extended to `--r-panel` and `--on-accent`; `marks.test.ts` on the shared eyes and beak.
- **Playwright**: wordmark text, wizard heading, the token-path sync round trip moved behind "Use a token instead", the 360px no-horizontal-scroll check across the new Settings, and the framed title bar.
- **By hand, on this machine**: a deploy against the owner's Cloudflare account to a throwaway script name, then deleted; the live Worker redeployed and `tools/list` showing fifteen; the deb built locally to confirm the package is still `to-hoot` with `Name=ToHoot`; the APK's label and icon read with `aapt`.

## 9. Release

0.6.0 by the existing flow: the ten version files, a PR, a merge commit, an annotated `v0.6.0` tag, and the release workflow. The workflow gains a `worker` job that produces `to-hoot-worker.mjs` beside the APK, the deb and the AppImage; the Cloudflare deploy in 4.3 downloads exactly that file for the version the app reports.

After the release: the desktop binary on this machine is replaced from the deb and its `.desktop` entry and icons updated to ToHoot; the APK is downloaded, its signature verified with `apksigner`, and installed on the API 36 emulator to check the label, the icon and that the app opens on the task list; the live Worker is redeployed; the stdio server's `dist` is rebuilt so Claude Code sees the new tools.
