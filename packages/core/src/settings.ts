// Settings hold every account-specific value, so nothing is hardcoded to one
// person's accounts and anyone can point a clone at their own.
//
// Two kinds of field never leave the device:
//   - Secrets. The sync target is a git repository; a token written there is a
//     durable credential leak that lands on every device and in every clone.
//   - Device identity. Two devices sharing a deviceId would write the same
//     event paths, and the whole merge model rests on them never colliding.

import { DEVICE_ID_RULE, DEFAULT_SETTINGS, isValidDeviceId, type Settings, type Theme } from './models.js';

export { DEFAULT_SETTINGS };
export type { Settings, Theme };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Settings as they travel between devices: no secrets, no device identity. */
export interface SyncableSettings {
  github: { owner: string; repo: string };
  calendar: { execUrl: string; icsUrl: string };
  theme: Theme;
  dayStartOffsetMs: number;
  idleThresholdMs: number;
  workdayStart: string;
  workdayEnd: string;
}

/**
 * The fields kept out of the synced payload, as a list rather than a comment so
 * a reader can check it against `SyncableSettings` at a glance:
 * `github.token`, `calendar.secret`, `worker.url` (it carries a path secret),
 * `deviceId` and `deviceName`.
 */
export function toSyncable(s: Settings): SyncableSettings {
  return {
    github: { owner: s.github.owner, repo: s.github.repo },
    calendar: { execUrl: s.calendar.execUrl, icsUrl: s.calendar.icsUrl },
    theme: s.theme,
    dayStartOffsetMs: s.dayStartOffsetMs,
    idleThresholdMs: s.idleThresholdMs,
    workdayStart: s.workdayStart,
    workdayEnd: s.workdayEnd,
  };
}

/** Replayed state carries these and nothing else; see `State.settings`. */
export const DEFAULT_SYNCABLE_SETTINGS: SyncableSettings = toSyncable(DEFAULT_SETTINGS);

export function cloneSettings(s: Settings): Settings {
  return {
    ...s,
    github: { ...s.github },
    calendar: { ...s.calendar },
    worker: { ...s.worker },
  };
}

export function cloneSyncableSettings(s: SyncableSettings): SyncableSettings {
  return { ...s, github: { ...s.github }, calendar: { ...s.calendar } };
}

const DAY_MS = 24 * 3600_000;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates a settings object read from disk or from a sync payload.
 *
 * Missing fields take their default, because every field added after v1 is
 * optional with a default and "an existing install" includes this user's own
 * phone running a build from three months ago. A field that is present but the
 * wrong type is an error rather than a silent default: that is a corrupt file
 * or a schema mismatch, and loading half of it quietly is how a bad value ends
 * up written back over a good one.
 */
export function validateSettings(input: unknown): Result<Settings> {
  if (!isRecord(input)) return { ok: false, error: 'settings must be an object' };

  const out = cloneSettings(DEFAULT_SETTINGS);
  const bad: string[] = [];

  const str = (v: unknown, path: string, assign: (s: string) => void): void => {
    if (v === undefined) return;
    if (typeof v !== 'string') bad.push(path);
    else assign(v);
  };

  const num = (
    v: unknown,
    path: string,
    ok: (n: number) => boolean,
    assign: (n: number) => void,
  ): void => {
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) bad.push(path);
    else assign(v);
  };

  const time = (v: unknown, path: string, assign: (s: string) => void): void => {
    if (v === undefined) return;
    if (typeof v !== 'string' || !HH_MM.test(v)) bad.push(path);
    else assign(v);
  };

  const nested = (key: string): Record<string, unknown> | undefined => {
    const v = input[key];
    if (v === undefined) return undefined;
    if (!isRecord(v)) {
      bad.push(key);
      return undefined;
    }
    return v;
  };

  const github = nested('github');
  if (github) {
    str(github['owner'], 'github.owner', v => { out.github.owner = v; });
    str(github['repo'], 'github.repo', v => { out.github.repo = v; });
    str(github['token'], 'github.token', v => { out.github.token = v; });
  }

  const calendar = nested('calendar');
  if (calendar) {
    str(calendar['execUrl'], 'calendar.execUrl', v => { out.calendar.execUrl = v; });
    str(calendar['secret'], 'calendar.secret', v => { out.calendar.secret = v; });
    str(calendar['icsUrl'], 'calendar.icsUrl', v => { out.calendar.icsUrl = v; });
  }

  const worker = nested('worker');
  if (worker) {
    str(worker['url'], 'worker.url', v => { out.worker.url = v; });
  }

  /*
   * The device id is checked here as well as where it is typed, because this is
   * the other way a value reaches the app: a settings file edited by hand, or
   * carried over from a build that did not check. An id that is not a path
   * segment writes events where no reader looks, so the failure is silent data
   * loss rather than an error anyone sees.
   *
   * Empty is allowed and means "the wizard has not run yet". A non-empty value
   * that breaks the rule is a corrupt file, not a default to fall back on.
   */
  if (input['deviceId'] !== undefined) {
    if (isValidDeviceId(input['deviceId'], true)) out.deviceId = input['deviceId'];
    else bad.push(`deviceId (${DEVICE_ID_RULE})`);
  }
  str(input['deviceName'], 'deviceName', v => { out.deviceName = v; });

  const theme = input['theme'];
  if (theme !== undefined) {
    if (theme === 'light' || theme === 'dark' || theme === 'system') out.theme = theme;
    else bad.push('theme');
  }

  num(input['dayStartOffsetMs'], 'dayStartOffsetMs', n => n >= 0 && n < DAY_MS, n => { out.dayStartOffsetMs = n; });
  num(input['idleThresholdMs'], 'idleThresholdMs', n => n > 0, n => { out.idleThresholdMs = n; });
  time(input['workdayStart'], 'workdayStart', v => { out.workdayStart = v; });
  time(input['workdayEnd'], 'workdayEnd', v => { out.workdayEnd = v; });

  if (bad.length > 0) return { ok: false, error: `invalid settings: ${bad.join(', ')}` };
  return { ok: true, value: out };
}
