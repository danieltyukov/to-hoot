# ToHoot 0.9.0: macOS, and any MCP agent

Three requests from the person using the app: find what needs improving and
fix it, make sure it works on macOS, and make it work with agents other than
Claude. This is the design for all three, shipped as one release.

## What was found

- **No macOS build.** The release builds Linux, Windows and Android only. The
  Rust shell compiles there in principle, but the OS idle query returns nothing,
  a window hidden to the tray cannot be brought back from the Dock, and a
  frameless window on macOS has no traffic lights, no rounded corners and no
  shadow. The bundle identifier `com.tohoot.app` ends in `.app`, so on macOS its
  data folder in `~/Library/Application Support` would show in Finder as a
  broken application.
- **The MCP setup only knows Claude.** The endpoint itself is agent-neutral: it
  answers `initialize` for protocol versions 2024-11-05 through 2025-11-25,
  returns 405 to a GET, and its tool schemas are plain JSON Schema. Everything
  around it says Claude. The one-press button writes only Claude Code's
  config, the copy and the docs name no other client, and nothing explains how
  to add the endpoint to ChatGPT.
- **The local server path is broken in an installed app.** "Add to Claude
  Code" without a deployed endpoint registers `node apps/mcp/dist/index.js`, a
  path relative to a checkout the installed app does not have, and with none of
  the `TO_HOOT_GITHUB_*` variables the server refuses to start without. The
  copyable `claude mcp add` command has the same two faults.
- **Word spacing collapses on Linux.** Chromium and WebKitGTK on Linux round
  each glyph advance to a whole pixel. To-Hoot Sans has a 0.2em space, so at
  13 and 14px a space can round to almost nothing ("Usethecommandinstead"), and
  tracked uppercase labels pick up stray gaps ("TIT LE"). The phone, which
  positions glyphs at subpixel precision, never showed it.
- **Stale screenshots.** `docs/img` still shows the 0.1 design from August.

## 1. macOS

- `tauri.macos.conf.json`, merged over the base config on a macOS build:
  product and binary `ToHoot`, identifier `com.tohoot.desktop` (no install base
  to upgrade, so the `.app` suffix can be left behind here only), bundle
  targets `app` and `dmg`, minimum macOS 10.15, ad-hoc signing (`"-"`). The
  window keeps native decorations with `titleBarStyle: "Overlay"` and a hidden
  title, so macOS draws its own traffic lights over the app's title bar and the
  window keeps its corners and shadow.
- `WindowFrame` gains `nativeControls?: 'leading'`. The desktop adapter sets it
  when the webview reports macOS. `TitleBar` then draws no controls of its own
  and leaves room at the leading edge for the traffic lights; dragging and
  double-click to zoom go through the same `startDragging` and
  `toggleMaximize` as on Linux and Windows.
- Idle time from CoreGraphics, `CGEventSourceSecondsSinceLastEventType` over
  the combined session state, called through a two-line FFI declaration rather
  than a new crate.
- `RunEvent::Reopen` (a Dock click) shows the main window. On macOS the tray
  icon is a monochrome template image, so the menu bar tints it like every
  other icon there.
- No Apple Developer ID: it costs money, and the project rule is that nothing
  does. The DMG is ad-hoc signed, which is what stops Apple Silicon reporting
  the app as damaged, and the first launch needs Open Anyway in System
  Settings, Privacy and Security. The README and the release notes say so.
- Release: a `macos-latest` job builds a universal (`aarch64` plus `x86_64`)
  DMG, published as `ToHoot_universal.dmg`. CI gains a desktop job that runs
  the shell's Rust tests on Linux, Windows and macOS for pull requests, so a
  macOS compile error shows on the PR rather than on the tag.

## 2. Agents

The connection is renamed from "Claude" to "Agents" everywhere a person reads
it. Claude stays the first example, not the only one.

**On this computer.** One row per agent the app can configure, each with a
status and an Add button that writes one entry into that agent's own config,
keeping everything else in the file as it was:

| Agent | File | Key | Remote entry | Local entry |
|---|---|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers` | `type: http, url` | `type: stdio, command, args, env` |
| Codex | `~/.codex/config.toml` | `mcp_servers` | `url` | `command, args, env` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` | `httpUrl` | `command, args, env` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` | `url` | `command, args, env` |
| VS Code | `<config>/Code/User/mcp.json` | `servers` | `type: http, url` | `type: stdio, command, args, env` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | `serverUrl` | `command, args, env` |
| opencode | `~/.config/opencode/opencode.json` | `mcp` | `type: remote, url` | `type: local, command[], environment` |

The Rust side owns *where*: an agent id resolves to a file and a format
(JSON, or TOML for Codex through `toml_edit`, which keeps comments and order),
using Tauri's own home and config directories, so the webview can only ever
name a known file. It also reports whether the agent's folder exists, which is
how a row says "found on this computer". The TypeScript side owns *what*: the
key and the entry shape per agent, in `packages/ui/src/agents.ts`, which is
also what renders the copyable snippet for anyone who would rather paste.
A file that is not valid JSON or TOML is refused, never overwritten.

**What an entry points at.** The deployed endpoint when there is one, since it
needs nothing installed. Otherwise the local stdio server, which no longer
needs a checkout: the release ships it as one bundled file,
`to-hoot-mcp.mjs`, and the app downloads the copy for its own version into its
data folder, the same way it already fetches the Worker. The entry runs it with
the absolute path of `node` (found on `PATH` and in the usual install places,
because an editor launched from the Dock does not inherit a shell's `PATH`) and
passes the data repository and token as `TO_HOOT_GITHUB_*` variables. With no
Node found, the row says to install Node 20 or deploy the endpoint.

**In the browser and on a phone.** The deploy flow is unchanged. Its last step
becomes "Add it to your assistant": the endpoint URL, then how to add it in
Claude (Customize, Connectors) and in ChatGPT (developer mode, then a connector
with no authentication), with a copy-and-open button for each, and a line that
any other client taking a remote MCP URL works the same way.

## 3. Design

- `text-rendering: geometricPrecision` on the root, which makes Chromium and
  WebKitGTK on Linux position glyphs at subpixel precision. It changes nothing
  on macOS, Windows or Android, which already do.
- The wizard's Back button is not drawn on the first step, where it can only
  ever be disabled.
- Fresh README screenshots of the current design, light and dark, desktop and
  phone.

## Testing

- Rust unit tests for the JSON and TOML writers (keeps other keys, replaces an
  old entry, refuses an unreadable file), the agent location table, and node
  discovery, run in CI on all three desktop systems.
- Vitest for every agent's entry shape and snippet, the step's states (found,
  added, stale target, no Node), and the bundle download.
- A smoke test that starts the bundled `to-hoot-mcp.mjs` with node and lists
  fifteen tools over stdio.
- Playwright as before; screenshots of the macOS title bar through the fake
  shell, since there is no Mac here. The macOS build itself is proven by the
  CI job and the release workflow.
