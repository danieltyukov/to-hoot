# Contributing

Bug reports and patches are welcome. There is no CLA and no style bikeshed;
match the code that is already there.

## Layout

    packages/core/     pure TypeScript: models, event log, merge, replay, tick
    packages/ui/       React 19 and Vite. The whole application.
    apps/desktop/      Tauri 2 shell
    apps/mobile/       Capacitor 8 shell, with android/ committed
    apps/mcp/          stdio MCP server
    apps/worker/       Cloudflare Worker, remote MCP
    apps/apps-script/  Google Calendar bridge, bundled by esbuild
    site/              the project site, its own Vite build
    scripts/           font pipeline, run by hand and rarely

`packages/core` never imports the DOM and never imports a Tauri or Capacitor
module. `packages/ui` never imports one either: both go through the `Platform`
interface in `packages/core/src/platform.ts`, which each shell implements. That
seam is what lets the app run in a plain browser under Playwright, and breaking
it breaks the test strategy rather than just the layering.

The package manager is npm workspaces, not pnpm. Capacitor's CLI does not follow
Node module resolution and fails against pnpm's symlinked `node_modules`
(ionic-team/capacitor#865, still open). The two shells are outside the workspace
on purpose, each with its own lockfile, because both CLIs want a flat
`node_modules`.

## Running the tests

```
npm ci
npm run typecheck     # tsc -b across every project reference
npm test              # vitest: core, mcp, worker and ui
npm run test:e2e      # playwright, against the production build
```

`npm test` needs no build step first. Vitest and Vite both alias `@to-hoot/core`
to its source, so a fresh checkout runs green immediately; TypeScript still
resolves it through the export map and the project references, which is what
keeps the published entry points honest.

Playwright needs browsers once: `npx playwright install --with-deps chromium`.
The E2E config starts `vite preview` against a real build rather than the dev
server, because a bundling mistake that only appears in production is exactly
what a shell test should catch.

Two suites are not in `npm test` because they need a device:

- `apps/desktop` uses WebdriverIO with the `embedded` provider. The `crabnebula`
  provider requires a subscription and is never used.
- `apps/mobile` uses the Maestro CLI against an API 34 AVD, with the flows in
  `apps/mobile/e2e/`. `maestro cloud` is never invoked.

## Running each target

**The web app**, which is all you need for most changes:

```
npm run dev -w @to-hoot/ui
```

**Desktop.** On Ubuntu, install the toolchain first:

```
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
cd apps/desktop && npm install && npm run dev
```

`librsvg2-dev` is only needed for the AppImage. Without it linuxdeploy's GTK
plugin exits 1 with "there is no 'libdir' variable for 'librsvg-2.0'", while the
deb still builds, which makes the failure look unrelated to the bundle target.

**Mobile.** Needs JDK 21 and the Android SDK:

```
cd apps/mobile && npm install && npm run apk:debug
```

Run `npx cap sync android` after a fresh clone. `android/` is committed because
the manifest and the signing configuration are source; everything Gradle and
`cap sync` generate inside it is ignored by the `.gitignore` files Capacitor
wrote there.

**MCP server**, **Worker** and **Apps Script bridge** each have their own README
with the environment they read and how to deploy them. None of them has an
account value compiled in.

## Nothing is hardcoded

Every account-specific value is a runtime setting, stored per device and never
committed: the data repository owner and name, the GitHub token, the Apps Script
`/exec` URL and shared secret, and the Worker URL and path secret. The only
personal strings in this repository are the repository URL itself and the
copyright line in `LICENSE`.

A patch that adds a default pointing at somebody's account will be sent back,
even if it is behind a flag.

## Commits

Conventional commits, scoped by package: `feat(core):`, `fix(ui):`, `docs:`.
Describe the change and why it is right, not the process that produced it.

## CI

`.github/workflows/ci.yml` runs typecheck, unit tests and Playwright on every
push and pull request. It needs no secrets, so it runs on forks.

`.github/workflows/pages.yml` builds `site/` and deploys it to GitHub Pages on
push to `main`. Pages must be set to "GitHub Actions" as its source, once, in
the repository settings.

`.github/workflows/release.yml` runs on a `v*` tag and attaches three artifacts
to a GitHub Release: the signed APK, the `.deb` and the `.AppImage`. It reads
four repository secrets, all of them Android signing material:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The release keystore, base64 encoded: `base64 -w0 to-hoot-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | Store password |
| `ANDROID_KEY_ALIAS` | Key alias, `to-hoot` if you followed the README |
| `ANDROID_KEY_PASSWORD` | Key password |

With those unset the release build still runs and produces an unsigned APK
rather than failing, so a fork can cut its own tag. The workflow writes the
keystore to a temp file and deletes it in an `always()` step; nothing about a
real key belongs in this repository, and `*.jks`, `*.keystore` and
`keystore.properties` are gitignored.

Desktop release builds run on `ubuntu-22.04`, not `ubuntu-latest`. glibc pins
forward: a binary built on 24.04 fails to start on 22.04 with a missing-symbol
error, so building on the oldest base that still ships WebKitGTK 4.1 is what
makes the artifact portable. Local builds on a newer Ubuntu are fine for
development.

Keep `runs-on` to standard GitHub-hosted runners. Actions minutes are free and
unmetered on public repositories with standard runners; larger runners bill even
on a public repository.
