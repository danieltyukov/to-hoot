# to-hoot desktop

A Tauri 2 shell around the same web application the mobile app runs. It supplies
the three things the web layer cannot supply for itself: HTTP that is not
subject to CORS, a durable key-value store, and OS notifications, plus the one
signal only a desktop has, the OS idle time.

## Build

```
npm install                 # not an npm workspace, deliberately: the Tauri CLI wants a flat node_modules
npm run build               # stages the web assets, then bundles deb and appimage
```

The bundle lands in `src-tauri/target/release/bundle/`.

`npm run stage` is the step worth knowing about. `packages/ui/dist` is the
application and knows nothing about which shell is loading it, so the staging
script copies it to `dist/`, bundles `src/platform.ts` next to it, and inserts a
script tag for the adapter ahead of the app's own module script. Tauri embeds
`dist/` into the binary at compile time: editing `dist/` after a build changes
nothing until the next `cargo build`.

### Ubuntu 24.04 prerequisites

```
libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
libayatana-appindicator3-dev librsvg2-dev
```

`librsvg2-dev` is only needed for the AppImage: linuxdeploy's gtk plugin reads
`librsvg-2.0.pc`, and without it the AppImage bundle fails while the deb still
builds.

## Behaviour worth knowing

**Blank white window on NVIDIA.** WebKitGTK hands back an empty frame with no
error. The binary sets `__NV_DISABLE_EXPLICIT_SYNC=1` for itself, before the
builder runs, so a bare `/usr/bin/to-hoot` carries it: the installed `.desktop`
file has the same line, but `tauri-plugin-autostart` writes its own autostart
entry as a bare path with no environment, and the workaround has to survive
that. An explicit value in the environment is left alone. If a machine is still
blank, add `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

**Single instance.** `tauri-plugin-single-instance` is registered first in the
builder chain and must stay there. Registered after another plugin it stops
deduplicating without saying so, and a second launch would open a second copy
writing to the same event log.

**The tray is a menu.** Linux emits no click events for a tray icon, so nothing
hangs off a click handler. Closing the window hides it; Quit is in the tray menu.

**What the app may reach** is in `src-tauri/capabilities/default.json`, not in
the CSP: `tauri-plugin-http` runs requests in Rust, outside the webview, which
is why CORS never enters into it. The allowlist has to name both
`script.google.com` and `script.googleusercontent.com`, because the Apps Script
`/exec` endpoint 302-redirects to the second one and a redirect target is scoped
separately.

**The scope is not re-checked across redirects.** It governs the URL the request
is made to; an allowlisted host answering 302 can send it on anywhere. The
allowlist says where this app knocks, not where the bytes end up. It still has
to name `script.googleusercontent.com`, because that is the URL the redirect is
followed to.

**Two kinds of storage.** `store` is the plugin-store JSON document, for
settings. `files` is `tauri-plugin-fs` under the app data directory, for the
event log and its snapshots: one document rewritten in full on every change is
the wrong shape for something appended to all day.

The bundle identifier is `com.tohoot.app`, matching the Android app id. Tauri
warns that an identifier ending in `.app` collides with the macOS bundle
extension; it matters only if this ever ships a `.app`.
