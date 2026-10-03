import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';

const FULL = {
  TO_HOOT_GITHUB_OWNER: 'someone',
  TO_HOOT_GITHUB_REPO: 'to-hoot-data',
  TO_HOOT_GITHUB_TOKEN: 'ghp_example',
};

describe('parseConfig', () => {
  it('reads the repository out of the environment', () => {
    const result = parseConfig(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.github).toMatchObject({
      owner: 'someone',
      repo: 'to-hoot-data',
      token: 'ghp_example',
    });
  });

  it('names every missing variable at once', () => {
    const result = parseConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain('TO_HOOT_GITHUB_OWNER');
    expect(result.error).toContain('TO_HOOT_GITHUB_REPO');
    expect(result.error).toContain('TO_HOOT_GITHUB_TOKEN');
  });

  it('defaults the device id to a usable path segment', () => {
    const result = parseConfig(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deviceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it('refuses a device id that is not a single path segment', () => {
    const result = parseConfig({ ...FULL, TO_HOOT_DEVICE_ID: 'laptop/mcp' });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain('TO_HOOT_DEVICE_ID');
  });

  it('keeps the branch and api base optional', () => {
    const bare = parseConfig(FULL);
    expect(bare.ok && bare.value.github.branch).toBeUndefined();

    const custom = parseConfig({
      ...FULL,
      TO_HOOT_GITHUB_BRANCH: 'data',
      TO_HOOT_GITHUB_API_BASE: 'https://ghe.example.com/api/v3',
    });
    expect(custom.ok && custom.value.github.branch).toBe('data');
    expect(custom.ok && custom.value.github.apiBase).toBe('https://ghe.example.com/api/v3');
  });

  it('treats a blank variable as absent rather than as an empty token', () => {
    const result = parseConfig({ ...FULL, TO_HOOT_GITHUB_TOKEN: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toContain('TO_HOOT_GITHUB_TOKEN');
  });

  it('puts the timer file inside the state directory', () => {
    const result = parseConfig({ ...FULL, TO_HOOT_STATE_DIR: '/var/tmp/to-hoot' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.timerFile).toBe('/var/tmp/to-hoot/timer.json');
  });

  describe('the desktop app\'s settings file', () => {
    // The vault tauri-plugin-store writes: every value is a string, and the
    // settings are one JSON document inside the "settings" key.
    const vault = (github: Record<string, string>): string =>
      JSON.stringify({ settings: JSON.stringify({ github, deviceId: 'desktop' }), 'setup-done': 'true' });
    const files = (map: Record<string, string>) => (path: string): string => {
      const text = map[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return text;
    };
    const SETTINGS = '/home/someone/.local/share/com.tohoot.app/to-hoot.json';

    it('reads the repository and token from it, so no agent config has to hold the token', () => {
      const read = files({ [SETTINGS]: vault({ owner: 'someone', repo: 'to-hoot-data', token: 'gho_device', branch: 'trunk' }) });
      const result = parseConfig({ TO_HOOT_SETTINGS: SETTINGS }, read);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.github).toMatchObject({ owner: 'someone', repo: 'to-hoot-data', token: 'gho_device', branch: 'trunk' });
    });

    it('lets an explicit variable win over the file', () => {
      const read = files({ [SETTINGS]: vault({ owner: 'someone', repo: 'to-hoot-data', token: 'gho_device', branch: '' }) });
      const result = parseConfig({ TO_HOOT_SETTINGS: SETTINGS, TO_HOOT_GITHUB_REPO: 'other-data' }, read);
      expect(result.ok && result.value.github.repo).toBe('other-data');
      expect(result.ok && result.value.github.branch).toBeUndefined();
    });

    it('says what is wrong when the app has not connected sync, or the file is not there', () => {
      const unsynced = parseConfig(
        { TO_HOOT_SETTINGS: SETTINGS },
        files({ [SETTINGS]: vault({ owner: '', repo: '', token: '', branch: '' }) }),
      );
      expect(unsynced.ok).toBe(false);
      if (!unsynced.ok) expect(unsynced.error).toContain('connect sync in the ToHoot app');

      const missing = parseConfig({ TO_HOOT_SETTINGS: SETTINGS }, files({}));
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error).toContain(SETTINGS);

      // A broken file is reported without quoting it: the parser's message
      // would carry the start of the text, and the text holds the token.
      const broken = parseConfig(
        { TO_HOOT_SETTINGS: SETTINGS },
        files({ [SETTINGS]: '{"settings": "{\\"github\\":{\\"token\\":\\"gho_secret' }),
      );
      expect(broken.ok).toBe(false);
      if (!broken.ok) {
        expect(broken.error).toContain('not valid JSON');
        expect(broken.error).not.toContain('gho_secret');
      }
      if (!missing.ok) expect(missing.error).toContain('ENOENT');
    });
  });
});
