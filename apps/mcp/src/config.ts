// Everything account-specific arrives through the environment, so a clone of
// this repository is pointed at its owner's data by configuration alone and
// nothing here is hardcoded to one person's accounts.

import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export interface Config {
  github: {
    owner: string;
    repo: string;
    token: string;
    branch?: string;
    apiBase?: string;
  };
  /** A single path segment: it is the prefix this server writes events under. */
  deviceId: string;
  /** Where the running timer is remembered between calls. */
  timerFile: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The same shape `SyncEngine` enforces, checked here so the failure is readable. */
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type Env = Record<string, string | undefined>;

/**
 * A blank value is treated as absent rather than as an empty token: an unset
 * variable and one exported as `""` are the same mistake, and letting the empty
 * one through produces a 401 from GitHub instead of a sentence naming the
 * variable that was not set.
 */
function read(env: Env, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A hostname turned into one path segment, so the default id is still unique. */
function defaultDeviceId(): string {
  const host = hostname()
    .split('.')[0]
    ?.replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  return host === undefined || host === '' ? 'mcp' : `mcp-${host}`;
}

export function parseConfig(env: Env): Result<Config> {
  const missing: string[] = [];
  const require_ = (key: string): string => {
    const value = read(env, key);
    if (value === undefined) missing.push(key);
    return value ?? '';
  };

  const owner = require_('TO_HOOT_GITHUB_OWNER');
  const repo = require_('TO_HOOT_GITHUB_REPO');
  const token = require_('TO_HOOT_GITHUB_TOKEN');
  if (missing.length > 0) {
    return { ok: false, error: `set ${missing.join(', ')} before starting the server` };
  }

  const deviceId = read(env, 'TO_HOOT_DEVICE_ID') ?? defaultDeviceId();
  if (!DEVICE_ID.test(deviceId)) {
    return {
      ok: false,
      error: `TO_HOOT_DEVICE_ID must be a single path segment matching ${String(DEVICE_ID)}`,
    };
  }

  const stateDir = read(env, 'TO_HOOT_STATE_DIR') ?? join(homedir(), '.to-hoot');
  const github: Config['github'] = { owner, repo, token };
  const branch = read(env, 'TO_HOOT_GITHUB_BRANCH');
  if (branch !== undefined) github.branch = branch;
  const apiBase = read(env, 'TO_HOOT_GITHUB_API_BASE');
  if (apiBase !== undefined) github.apiBase = apiBase;

  return { ok: true, value: { github, deviceId, timerFile: join(stateDir, 'timer.json') } };
}
