// Everything account-specific arrives through the environment, so a clone of
// this repository is pointed at its owner's data by configuration alone and
// nothing here is hardcoded to one person's accounts.
//
// Or through the desktop app's own settings file, named by TO_HOOT_SETTINGS.
// That is how the app registers this server with an agent: the agent's config
// holds a path, not the GitHub token, so the token stays in one owner-only
// file on this machine instead of in every agent's settings (some of which,
// VS Code's for one, can sync to a cloud account). The token is read at start,
// so signing in again in the app reaches every agent without adding it again.

import { readFileSync } from 'node:fs';
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

/** What the desktop app keeps about the data repository. */
interface AppGitHub {
  owner?: unknown;
  repo?: unknown;
  token?: unknown;
  branch?: unknown;
}

/**
 * The repository settings out of the desktop app's store file. The store is
 * tauri-plugin-store's JSON, where every value is a string and the settings
 * are one JSON document under `settings`.
 */
function fromAppSettings(path: string, readFile: (path: string) => string): Result<Env> {
  let github: AppGitHub | undefined;
  try {
    const vault = JSON.parse(readFile(path)) as { settings?: unknown };
    const settings = typeof vault.settings === 'string' ? (JSON.parse(vault.settings) as { github?: AppGitHub }) : undefined;
    github = settings?.github;
  } catch (err) {
    return { ok: false, error: `could not read the ToHoot settings at ${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    ok: true,
    value: {
      TO_HOOT_GITHUB_OWNER: str(github?.owner),
      TO_HOOT_GITHUB_REPO: str(github?.repo),
      TO_HOOT_GITHUB_TOKEN: str(github?.token),
      TO_HOOT_GITHUB_BRANCH: str(github?.branch),
    },
  };
}

export function parseConfig(env: Env, readFile: (path: string) => string = p => readFileSync(p, 'utf8')): Result<Config> {
  const settingsPath = read(env, 'TO_HOOT_SETTINGS');
  if (settingsPath !== undefined) {
    const app = fromAppSettings(settingsPath, readFile);
    if (!app.ok) return app;
    // An explicit variable still wins, key by key.
    const merged: Env = { ...app.value };
    for (const [key, value] of Object.entries(env)) if (read(env, key) !== undefined) merged[key] = value;
    env = merged;
  }

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
    return {
      ok: false,
      error:
        settingsPath === undefined
          ? `set ${missing.join(', ')} before starting the server`
          : `the ToHoot settings at ${settingsPath} have no data repository yet: connect sync in the ToHoot app first`,
    };
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
