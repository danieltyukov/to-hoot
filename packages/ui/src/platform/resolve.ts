import type { FileStore, NotificationId, NotifyOptions, Platform, Unsubscribe } from '@to-hoot/core';

import { browserHttp, browserStore } from './browser.js';

/*
 * Which platform the app is running on, decided at boot.
 *
 * Each shell bundles its own adapter and loads it ahead of the application, so
 * by the time this runs `window.__toHootPlatform` is either there, and this is
 * the desktop or the Android app, or it is not, and this is a browser. Nothing
 * else in the app has to know which.
 */

declare global {
  interface Window {
    __toHootPlatform?: Platform;
  }
}

/**
 * Files in a browser, kept in local storage.
 *
 * Honest about what it is: local storage is small (a few megabytes) and
 * synchronous, so it is a development convenience rather than somewhere to keep
 * a year of events. The shells hand back real files.
 */
function browserFiles(prefix = 'to-hoot:file:'): FileStore {
  return {
    async read(name) {
      try {
        return localStorage.getItem(prefix + name);
      } catch {
        return null;
      }
    },
    async write(name, contents) {
      localStorage.setItem(prefix + name, contents);
    },
    async remove(name) {
      try {
        localStorage.removeItem(prefix + name);
      } catch {
        /* already gone */
      }
    },
  };
}

let nextId = 1;
const pending = new Map<NotificationId, ReturnType<typeof setTimeout>>();

async function browserNotify(opts: NotifyOptions): Promise<NotificationId> {
  const id = nextId++;
  const fire = (): void => {
    pending.delete(id);
    // Permission is asked for at the moment there is something to say, not at
    // boot: a page that asks on load is a page people click "block" on.
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(opts.title, { body: opts.body });
    } else if (Notification.permission === 'default') {
      void Notification.requestPermission().then(p => {
        if (p === 'granted') new Notification(opts.title, { body: opts.body });
      });
    }
  };
  if (opts.inMs && opts.inMs > 0) pending.set(id, setTimeout(fire, opts.inMs));
  else fire();
  return id;
}

async function browserCancelNotification(id: NotificationId): Promise<void> {
  const handle = pending.get(id);
  if (handle === undefined) return;
  clearTimeout(handle);
  pending.delete(id);
}

/**
 * A tab coming back into view is the browser's version of an app resuming, and
 * it is the same question either way: how much wall clock went by?
 */
function browserOnResume(cb: () => void): Unsubscribe {
  const handler = (): void => {
    if (document.visibilityState === 'visible') cb();
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

export const browserPlatform: Platform = {
  http: browserHttp,
  store: browserStore(),
  files: browserFiles(),
  notify: browserNotify,
  cancelNotification: browserCancelNotification,
  onResume: browserOnResume,
  // No idleSeconds. A browser cannot see what the user is doing in another
  // window, and guessing from this page's own events would be a worse answer
  // than admitting there is none.
};

export function resolvePlatform(): Platform {
  return globalThis.window?.__toHootPlatform ?? browserPlatform;
}
