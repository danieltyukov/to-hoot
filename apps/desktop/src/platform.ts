// The desktop shell's half of the `Platform` contract.
//
// This module is bundled by `scripts/stage-web.mjs` and loaded ahead of the
// application, so `window.__toHootPlatform` is already in place when the app
// starts. Core and ui never import a Tauri module; this file is the only place
// in the tree that does.

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { load, type Store } from '@tauri-apps/plugin-store';

import type {
  Http,
  HttpResponse,
  KeyValueStore,
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

  return { status: res.status, headers, text: () => res.text() };
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

async function ensureNotificationPermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === 'granted';
}

async function notify(opts: NotifyOptions): Promise<void> {
  if (!(await ensureNotificationPermission())) return;
  const fire = (): void => sendNotification({ title: opts.title, body: opts.body });

  // A timer, unlike on Android. The notification plugin's `schedule` option is
  // implemented on mobile only, and a desktop process that lives in the tray is
  // still running when the timer fires, so there is nothing to work around.
  if (opts.inMs && opts.inMs > 0) setTimeout(fire, opts.inMs);
  else fire();
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

export const platform: Platform = { http, store, notify, onResume, idleSeconds };

declare global {
  interface Window {
    __toHootPlatform?: Platform;
  }
}

window.__toHootPlatform = platform;
