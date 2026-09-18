# ToHoot 0.6.0 implementation plan

**Spec:** `docs/superpowers/specs/2026-09-18-tohoot-overhaul-design.md`

**Goal:** Ship 0.6.0 with the ToHoot name and icon, six project and tag tools for Claude plus a Worker that reads the log tail, sign-in-with-GitHub and deploy-from-the-app setup, a Settings page that shows every device, and a visual refresh, then release it and install it on the owner's desktop and verify the APK.

Every task inherits the global constraints of the 2026-08-23 plan: npm workspaces, nothing hardcoded to one account except the public OAuth client id, OFL fonts only, no emojis, no em or en dashes as punctuation, conventional commits with no AI attribution, `force` never sent to the refs API, `legacy: 'stateless'` on the Worker, tokens only in the token sheet, every icon-only control named.

Two workstreams run in parallel and touch disjoint files.

## Workstream A: core, Worker, stdio (subagent)

### A1. Colours and name resolution in core
- `packages/core/src/models.ts`: export `ENTITY_COLORS` (the six from `ui/store.ts`) and `nextEntityColor(count)`.
- `packages/core/src/tools/tools.ts`: helpers `findProjectByTitle`, `findTagByTitle` (case-insensitive, trimmed), `view()` gains `project` and `tags` titles.

### A2. The six tools
- `list_projects`, `add_project`, `update_project`, `list_tags`, `add_tag`, `update_tag` in `tools.ts`, appended to `TOOLS` after `log_time`.
- `add_task` / `update_task`: `project`, `tags` (titles) beside `projectId`, `tagIds`; both forms of one field refused; a missing title creates the entity in the same batch. `list_tasks`: `project`, `tag` title filters.
- Tests in `packages/core/src/tools/tools.test.ts`; the "nine" assertion becomes fifteen. `apps/mcp/src/dist-smoke.test.ts`, `legacy.test.ts`, `apps/worker/src/index.test.ts` counts updated.

### A3. Worker reads the tail
- `packages/core/src/tools/snapshot.ts`: `MAX_TAIL_FILES = 32`; `refresh()` collects `events/*/*.json` entries, reads them (blob cache by sha) when count is within the cap, `loadState()` replays tail plus pending onto the base. Above the cap, tail is empty.
- `packages/core/src/tools/snapshot.test.ts` and `apps/worker/src/tools.test.ts` updated: reads the tail when short, skips it when long, request budgets restated.
- `apps/worker/src/index.ts` and `apps/mcp/src/server.ts`: `SERVER_INFO.version` from core `VERSION`.

### A4. Compaction on file count, and copy cleanup
- `packages/core/src/github/sync.ts`: `compactFileThreshold` (default 30) alongside `compactThreshold`; `refresh()` records `snapshot-*.json` copies from the tree; `buildSnapshot()` deletes them all; `get devices()` exposes `meta.devices`.
- Tests in `packages/core/src/github/sync.test.ts`.

### A5. Docs for A
- `docs/ARCHITECTURE.md` (tail reads, file threshold, copy cleanup), `apps/mcp/README.md`, `apps/worker/README.md` (fifteen tools, the new six).

## Workstream B: name, icon, splash, desktop shell (me)

### B1. Name
- `Wordmark.tsx` renders ToHoot; `TitleBar.tsx` centre says ToHoot; `OwlMark`/`OwlIcon` default label ToHoot; `index.html` title; `StepLocal` copy.
- Android `strings.xml` app_name and title; `capacitor.config.ts` appName.
- Tauri `tauri.conf.json` window title; `to-hoot.desktop` `Name=ToHoot`; `lib.rs` tray tooltip and Show item.
- Tests: `Sidebar.test`, `TitleBar.test`, `OwlMark.test`, Playwright wordmark assertion.

### B2. Icon and splash
- New `apps/mobile/icon-source.svg` (face on clay, 1024) and `apps/desktop/icon-source.svg` (same, rounded square).
- Android: `drawable/ic_launcher_foreground.xml` vector, `values/ic_launcher_background.xml` clay, `mipmap-anydpi-v26/*.xml` with monochrome, legacy PNGs via `rsvg-convert`, remove `drawable-v24` and the grid background, delete `splash.png` set, `styles.xml` splash attributes, `values/colors.xml` and `values-night/colors.xml`.
- Desktop: `npx tauri icon` from the desktop source PNG.
- `marks.test.ts` rewritten around the shared eyes and beak.

## Workstream C: setup flows (me)

### C1. Platform kind
- `packages/core/src/platform.ts`: `kind?: 'desktop' | 'android' | 'browser'`; set in both shells and the browser adapter.

### C2. GitHub device flow
- `setup.ts`: `GITHUB_CLIENT_ID`, `startDeviceLogin`, `pollDeviceLogin`, `findDataRepo`, `suggestDeviceName`.
- `StepSync.tsx` rebuilt as the one-flow component with the token fallback.
- Tauri capability: `https://github.com/*` and `https://api.cloudflare.com/*` in `http:default`.
- `setup.test.ts`, `Wizard.test.tsx`, Playwright `first-run.spec.ts`.

### C3. Cloudflare deploy
- `setup.ts`: `CLOUDFLARE_TOKEN_URL`, `workerBundleUrl(version)`, `deployWorker(http, ...)`, multipart builder.
- `StepClaude.tsx` rebuilt around the three stages with the wrangler path collapsed.
- `apps/worker/package.json`: `bundle` script (`wrangler deploy --dry-run --outdir dist`); `.github/workflows/release.yml`: `worker` job and the fourth asset.
- Tests as in the spec.

### C4. Calendar step
- `StepCalendar.tsx` restructured into three numbered stages with buttons; `APPS_SCRIPT_CREATE` and `GOOGLE_CALENDAR_SETTINGS` links.

## Workstream D: Settings, sync visibility, visual refresh (me)

### D1. Sync status carries devices, and polls every minute
- `sync.ts`: `SYNC_EVERY_MS = 60_000`; `SyncStatus.devices`.
- `sync.test.ts` updated.

### D2. Settings page
- `Settings.tsx` and `Settings.css`: connection cards, Devices card, Preferences, Data, version foot.
- `Settings.test.tsx`.

### D3. Tokens, buttons, sidebar, rows, tabs, wizard
- `tokens.css`: `--r-panel`, `--on-accent`; `tokens.test.ts` updated.
- `fields.css`: `.button-primary`. `Sidebar`, `TaskRow`, `TaskList`, `App.css`, `Wizard.css` per the spec.
- `styles.test.ts` additions.

## Workstream E: release (me, after A to D are green)

- Version bump to 0.6.0 in the ten files, `versionCode` 8.
- PR, merge, annotated tag, release workflow.
- Desktop: replace `~/.local/bin/to-hoot` from the deb, update the local `.desktop` and icons.
- APK: download, `apksigner verify`, install on the emulator, check label and icon, open the app.
- Redeploy the live Worker; rebuild `apps/mcp/dist`; live `tools/list` shows fifteen.
- Memory notes updated.
