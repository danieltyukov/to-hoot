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
});
