// The Android shell's half of the `Platform` contract.
//
// This module is bundled by `scripts/stage-web.mjs` and loaded ahead of the
// application, so `window.__toHootPlatform` is already in place when the app
// starts. Core and ui never import a Capacitor module; this file is the only
// place in the tree that does.

import { CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';

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
 * Requests go through `CapacitorHttp`, which runs them natively rather than in
 * the WebView. That is the entire reason it is here: no CORS preflight, so the
 * Apps Script calendar bridge is reachable at all, and its redirect from
 * `script.google.com/exec` to `script.googleusercontent.com` is followed the
 * way a native client follows it.
 */
const http: Http = async (req): Promise<HttpResponse> => {
  const headersOut = { ...req.headers };
  // CapacitorHttpUrlConnection.setRequestBody returns immediately when the
  // Content-Type is absent, so a body sent without one is silently dropped and
  // the server sees an empty POST. text/plain is the type that makes the plugin
  // write the string through verbatim; a caller meaning JSON says so itself,
  // and both clients in core do.
  if (req.body !== undefined && !Object.keys(headersOut).some(k => k.toLowerCase() === 'content-type')) {
    headersOut['content-type'] = 'text/plain;charset=utf-8';
  }

  const res = await CapacitorHttp.request({
    url: req.url,
    method: req.method ?? 'GET',
    headers: headersOut,
    data: req.body,
    // Governs how a non-JSON body comes back: without it the ICS calendar feed
    // would arrive as something other than the text it is.
    //
    // It does not cover JSON. HttpRequestHandler.readData checks the response
    // Content-Type first and parses anything JSON-shaped before it ever looks
    // at responseType, so a GitHub or Apps Script body is handed to us already
    // parsed and is re-serialised below. Nothing may depend on the response
    // text being byte-for-byte what the server sent: an ETag is compared as the
    // header it came in, never as a hash over the body.
    responseType: 'text',
  });

  // Lowercased, because callers read `headers.etag` and a server is free to
  // send `ETag`. Getting this wrong loses every conditional request, which
  // shows up only as a rate limit burned through four times too fast.
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    headers[key.toLowerCase()] = String(value);
  }

  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
  return { status: res.status, headers, text: async () => body };
};

const store: KeyValueStore = {
  async get(key) {
    return (await Preferences.get({ key })).value;
  },
  async set(key, value) {
    await Preferences.set({ key, value });
  },
  async remove(key) {
    await Preferences.remove({ key });
  },
  async keys() {
    return (await Preferences.keys()).keys;
  },
};

/**
 * The event log and its snapshots, as files in the app's data directory.
 *
 * Separate from `store` because Preferences is SharedPreferences, which commits
 * with `apply()`: the write is asynchronous, so a process killed at the wrong
 * moment loses it, and the whole XML file is rewritten every time. Good for a
 * handful of settings, wrong for something appended to all day.
 */
const files: FileStore = {
  async read(name) {
    try {
      const res = await Filesystem.readFile({
        path: name,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return typeof res.data === 'string' ? res.data : await res.data.text();
    } catch {
      // The plugin throws for a missing file, which is an ordinary answer here.
      return null;
    }
  },
  /*
   * Written to a temporary file and then renamed over the target.
   *
   * A rename within one directory is atomic, so a reader sees the whole old
   * file or the whole new one and never half of either. Writing in place is
   * not: the event log is rewritten entirely every thirty seconds while a timer
   * runs, and Android kills backgrounded processes routinely, so a truncated
   * file is the ordinary outcome rather than a rare one. What it truncates is
   * the only copy of anything that has not synced yet.
   */
  async write(name, contents) {
    const temp = `${name}.tmp`;
    await Filesystem.writeFile({
      path: temp,
      data: contents,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    // `rename` replaces the destination, so the old file is never unlinked
    // first and there is no moment with nothing at the target path.
    await Filesystem.rename({
      from: temp,
      to: name,
      directory: Directory.Data,
      toDirectory: Directory.Data,
    });
  },
  async remove(name) {
    try {
      await Filesystem.deleteFile({ path: name, directory: Directory.Data });
    } catch {
      /* already gone, which is what was asked for */
    }
  },
};

/**
 * Android 13 and up asks for POST_NOTIFICATIONS at runtime, and the answer can
 * be no. A refusal costs the reminders and nothing else: it is checked once,
 * cached, and every other part of the app carries on.
 */
let permission: Promise<boolean> | null = null;
function notificationsAllowed(): Promise<boolean> {
  permission ??= (async () => {
    const current = await LocalNotifications.checkPermissions();
    if (current.display === 'granted') return true;
    if (current.display === 'denied') return false;
    return (await LocalNotifications.requestPermissions()).display === 'granted';
  })().catch(() => false);
  return permission;
}

// Notification ids are 32-bit ints on Android, and reusing one replaces the
// notification it belonged to.
let nextId = 1;
function notificationId(): number {
  nextId = (nextId % 0x7fff_ffff) + 1;
  return nextId;
}

/**
 * Hands the alarm to the OS rather than keeping a timer in the page.
 *
 * A JS timer is the obvious implementation and it does not work: Android
 * suspends the WebView within seconds of the app going to the background, and
 * the callback fires late, at whatever moment the user happens to reopen the
 * app, or never. A scheduled notification is held by AlarmManager, so it
 * arrives on time with the screen off and survives the process being killed.
 *
 * The same reasoning is why a running timer is stored as `startedAt` plus a
 * duration rather than as a counter being incremented: elapsed time is read
 * back from the wall clock on `resume`, and it is exact however long the app
 * was away.
 */
async function notify(opts: NotifyOptions): Promise<NotificationId> {
  const id = notificationId();
  if (!(await notificationsAllowed())) return id;

  if (opts.inMs && opts.inMs > 0) {
    await LocalNotifications.schedule({
      notifications: [
        {
          id,
          title: opts.title,
          body: opts.body ?? '',
          // An exact alarm needs SCHEDULE_EXACT_ALARM, which since Android 12
          // is a special access granted in system settings. The plugin's
          // default for this flag is true, and the consequence is worth
          // knowing: the first time anything is scheduled, the user is dropped
          // into the "Alarms & reminders" settings screen without having asked
          // to go there. Starting a timer must not do that.
          isExactNotification: false,
          schedule: {
            at: new Date(Date.now() + opts.inMs),
            // Wakes the device out of Doze rather than waiting for the next
            // maintenance window, which can be an hour away. Android still
            // rate-limits these to roughly one every nine minutes, so a
            // reminder is on time to the minute, not to the second.
            allowWhileIdle: true,
          },
        },
      ],
    });
    return id;
  }

  await LocalNotifications.schedule({
    notifications: [{ id, title: opts.title, body: opts.body ?? '' }],
  });
  // The buzz is what gets noticed when the phone is face down on a desk.
  await Haptics.notification({ type: NotificationType.Success }).catch(() => {});
  return id;
}

/**
 * Takes a pending reminder back off AlarmManager.
 *
 * This is the half that matters on Android: the alarm is held by the OS, so a
 * timer stopped early would otherwise still buzz at its old end time, from a
 * process that may no longer exist. Cancelling an id that already fired, or was
 * never scheduled, is a no-op the plugin absorbs.
 */
async function cancelNotification(id: NotificationId): Promise<void> {
  await LocalNotifications.cancel({ notifications: [{ id }] }).catch(() => {});
}

/**
 * Fires when Android brings the app back to the foreground, which is the moment
 * to re-read the clock: anything the app believed about elapsed time while it
 * was suspended is a guess, and the wall clock is not.
 */
function onResume(cb: () => void): Unsubscribe {
  const handle = App.addListener('resume', cb);
  let cancelled = false;
  void handle.then((h) => {
    if (cancelled) void h.remove();
  });
  return () => {
    cancelled = true;
    void handle.then((h) => h.remove());
  };
}

/**
 * Beyond the `Platform` contract, because only a phone has it. Feature-detected
 * by callers rather than assumed; on a device with the motor disabled, or with
 * the OS refusing, these resolve to nothing rather than throwing.
 */
export interface Haptic {
  tap(): Promise<void>;
  done(): Promise<void>;
}

const haptics: Haptic = {
  tap: () => Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}),
  done: () => Haptics.notification({ type: NotificationType.Success }).catch(() => {}),
};

export interface MobilePlatform extends Platform {
  haptics: Haptic;
}

// No `idleSeconds`. Android has no OS-level idle signal to read, and the app
// infers idleness from the wall-clock gap across a resume instead, which is
// what `onResume` is for.
export const platform: MobilePlatform = {
  http,
  store,
  files,
  notify,
  cancelNotification,
  onResume,
  haptics,
};

declare global {
  interface Window {
    __toHootPlatform?: Platform;
  }
}

window.__toHootPlatform = platform;
