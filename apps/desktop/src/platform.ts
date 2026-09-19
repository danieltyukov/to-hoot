// The desktop shell's half of the `Platform` contract.
//
// This module is bundled by `scripts/stage-web.mjs` and loaded ahead of the
// application, so `window.__toHootPlatform` is already in place when the app
// starts. Core and ui never import a Tauri module; this file is the only place
// in the tree that does.

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  remove as removeFile,
  rename,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openUrl as openExternal } from '@tauri-apps/plugin-opener';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { load, type Store } from '@tauri-apps/plugin-store';

import type {
  CallbackListener,
  FileStore,
  Http,
  HttpResponse,
  KeyValueStore,
  NotificationId,
  NotifyOptions,
  Platform,
  Unsubscribe,
  WindowFrame,
  ClaudeCodeEntry,
} from '@to-hoot/core';

/**
 * Requests go through `tauri-plugin-http`, which runs them in Rust rather than
 * in the webview. That is the entire reason it is here: no CORS preflight, so
 * the Apps Script calendar bridge is reachable at all, and the GitHub API needs
 * no proxy. What it may reach is fixed by `capabilities/default.json`, not by
 * this file.
 *
 * The scope governs the URL the request is made to, and is not re-checked when
 * a server redirects: an allowlisted host that answers 302 can send the request
 * on anywhere. The allowlist is therefore a statement about where this app
 * knocks, not a guarantee about where the bytes end up. It still has to name
 * script.googleusercontent.com, because that is the URL the redirect is
 * followed to and Apps Script would otherwise be unreachable, but it is worth
 * knowing that naming it is not what makes the redirect safe.
 */
const http: Http = async (req): Promise<HttpResponse> => {
  const res = await tauriFetch(req.url, {
    method: req.method ?? 'GET',
    headers: req.headers,
    body: req.body,
  });

  // Lowercased, because callers read `headers.etag` and a server is free to
  // send `ETag`. Getting this wrong loses every conditional request, which
  // shows up only as a rate limit burned through four times too fast.
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Buffered once, rather than handing back the stream's own `text()`, which
  // can only be consumed once. Callers may read a body twice (log it, then
  // parse it), and the Android adapter allows that; a contract that holds on
  // one platform and not the other is worse than either behaviour.
  const body = await res.text();
  return { status: res.status, headers, text: async () => body };
};

const STORE_FILE = 'to-hoot.json';

let storePromise: Promise<Store> | null = null;
function store$(): Promise<Store> {
  // `autoSave` debounces the write to disk; `save()` after each mutation would
  // rewrite the whole file on every keystroke of a settings form.
  storePromise ??= load(STORE_FILE, { autoSave: 200 });
  return storePromise;
}

const store: KeyValueStore = {
  async get(key) {
    const value = await (await store$()).get<string>(key);
    return value ?? null;
  },
  async set(key, value) {
    await (await store$()).set(key, value);
  },
  async remove(key) {
    await (await store$()).delete(key);
  },
  async keys() {
    return (await store$()).keys();
  },
};

/**
 * The event log and its snapshots, as files in the app's data directory.
 *
 * Separate from `store` because the log outgrows a key-value store: `store` is
 * one JSON document rewritten in full on every change, which is fine for
 * settings and wrong for something appended to all day.
 */
const DATA_DIR = 'data';
const baseDir = BaseDirectory.AppData;

function filePath(name: string): string {
  return `${DATA_DIR}/${name}`;
}

const files: FileStore = {
  async read(name) {
    const path = filePath(name);
    // Asked rather than caught: a missing file is an ordinary answer here, and
    // matching on the text of an OS error message is not a way to tell it apart
    // from a permission problem.
    if (!(await exists(path, { baseDir }))) return null;
    return readTextFile(path, { baseDir });
  },
  /*
   * Written to a temporary file and then renamed over the target.
   *
   * A rename within one directory is atomic, so a reader sees either the whole
   * old file or the whole new one and never a half of either. Writing in place
   * is not: the event log is rewritten entirely every thirty seconds while a
   * timer runs, so a process killed mid-write is the ordinary case rather than
   * a rare one, and what it leaves behind is a truncated file that is the only
   * copy of whatever had not synced.
   */
  async write(name, contents) {
    await mkdir(DATA_DIR, { baseDir, recursive: true });
    const target = filePath(name);
    const temp = `${target}.tmp`;
    await writeTextFile(temp, contents, { baseDir });
    await rename(temp, target, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
  },
  async remove(name) {
    const path = filePath(name);
    if (await exists(path, { baseDir })) await removeFile(path, { baseDir });
  },
};

async function ensureNotificationPermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === 'granted';
}

let nextId = 1;
const pending = new Map<NotificationId, ReturnType<typeof setTimeout>>();

async function notify(opts: NotifyOptions): Promise<NotificationId> {
  const id = nextId++;
  if (!(await ensureNotificationPermission())) return id;
  const fire = (): void => {
    pending.delete(id);
    sendNotification({ title: opts.title, body: opts.body });
  };

  // A timer, unlike on Android. The notification plugin's `schedule` option is
  // implemented on mobile only, and a desktop process that lives in the tray is
  // still running when the timer fires, so there is nothing to work around.
  if (opts.inMs && opts.inMs > 0) pending.set(id, setTimeout(fire, opts.inMs));
  else fire();
  return id;
}

/** A no-op for an id that already fired, which is the contract. */
async function cancelNotification(id: NotificationId): Promise<void> {
  const handle = pending.get(id);
  if (handle === undefined) return;
  clearTimeout(handle);
  pending.delete(id);
}

/**
 * The desktop's answer to "the app came back": the window regained focus, after
 * an unminimise, a workspace switch or a machine waking up. Core does not care
 * which of those it was; it re-reads the clock and reconciles the gap.
 */
function onResume(cb: () => void): Unsubscribe {
  const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) cb();
  });
  let cancelled = false;
  void unlisten.then((off) => {
    if (cancelled) off();
  });
  return () => {
    cancelled = true;
    void unlisten.then((off) => off());
  };
}

/**
 * Seconds since the last input the OS saw, from the X11 screensaver extension.
 *
 * Returns 0 when that cannot be answered (a Wayland session with no XWayland
 * connection, a headless run). Zero reads as "active", which is the safe way to
 * be wrong: the worst case is that an idle stretch is caught by the wall-clock
 * gap check a beat later, rather than time being taken off a task the user was
 * actually working on.
 */
async function idleSeconds(): Promise<number> {
  try {
    return await invoke<number>('idle_seconds');
  } catch {
    return 0;
  }
}

/**
 * The window controls, and the grab that moves the window.
 *
 * The window is created with `decorations: false` (tauri.conf.json), so there
 * is no native title bar: none of GTK's, and none of the compositor's. The app
 * draws the three buttons itself, in its own top row, and every one of them
 * comes back here. `close` goes through the same close-requested path the
 * native button used, which the Rust side answers by hiding to the tray.
 *
 * What the webview may ask for is listed in `capabilities/default.json`; a call
 * this file makes that the capability does not grant is refused at runtime, so
 * the two have to move together.
 */
const frame: WindowFrame = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  onMaximizedChange(cb) {
    // There is no maximise event, only a resize, and a resize is what a
    // maximise is. The state is asked for after each one rather than inferred
    // from the size, so a restore to the same size as before still reads right.
    const unlisten = getCurrentWindow().onResized(() => {
      void getCurrentWindow()
        .isMaximized()
        .then(cb, () => undefined);
    });
    let cancelled = false;
    void unlisten.then((off) => {
      if (cancelled) off();
    });
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  },
  startDragging: () => getCurrentWindow().startDragging(),
};

/**
 * The loopback listener a sign-in redirects to.
 *
 * `oauth_listen` binds port 8976 on the Rust side, which is the one port
 * Cloudflare's sign-in will redirect to (it is registered for wrangler, its
 * own tool), and waits for exactly one request. The wait is cancelled by
 * asking the shell to close the socket: a person who closed the browser tab
 * would otherwise leave the port held until the app quits.
 */
function oauthLoopback(): CallbackListener {
  return {
    redirectUri: 'http://localhost:8976/oauth/callback',
    async waitForCallback(cancelled) {
      const poll =
        cancelled === undefined
          ? undefined
          : setInterval(() => {
              if (cancelled()) void invoke('oauth_cancel').catch(() => undefined);
            }, 500);
      try {
        return await invoke<string>('oauth_listen');
      } finally {
        if (poll !== undefined) clearInterval(poll);
      }
    },
  };
}

/**
 * Hands a URL to the desktop's own browser, through the OS.
 *
 * An anchor in this window is not a link to anywhere: the window is the
 * application, so following one either navigates the app away from itself or,
 * with this CSP, does nothing at all. The plugin runs the open in Rust through
 * xdg-open, and `capabilities/default.json` fixes which URLs it will accept.
 */
async function openUrl(url: string): Promise<void> {
  await openExternal(url);
}

export const platform: Platform = {
  kind: 'desktop',
  http,
  store,
  files,
  notify,
  cancelNotification,
  onResume,
  idleSeconds,
  claudeCode: {
    add: (name, server) => invoke<string>('claude_code_add', { name, server }),
    inspect: name => invoke<ClaudeCodeEntry>('claude_code_inspect', { name }),
  },
  window: frame,
  openUrl,
  oauthLoopback,
};

declare global {
  interface Window {
    __toHootPlatform?: Platform;
  }
}

window.__toHootPlatform = platform;
