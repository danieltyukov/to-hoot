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
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { load, type Store } from '@tauri-apps/plugin-store';

import type {
  FileStore,
  Http,
  HttpResponse,
  KeyValueStore,
  NotificationId,
  NotifyOptions,
  Platform,
  Unsubscribe,
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

export const platform: Platform = {
  http,
  store,
  files,
  notify,
  cancelNotification,
  onResume,
  idleSeconds,
};

declare global {
  interface Window {
    __toHootPlatform?: Platform;
  }
}

window.__toHootPlatform = platform;
