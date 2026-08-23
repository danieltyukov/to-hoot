import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, toSyncable, validateSettings } from './settings.js';
import type { Platform, HttpRequest, HttpResponse } from './platform.js';
import type { Settings } from './models.js';
import { replay } from './replay.js';
import type { Event } from './events.js';

const filled: Settings = {
  github: { owner: 'an-owner', repo: 'a-repo', branch: 'master', token: 'ghp_secret' },
  calendar: { execUrl: 'https://example.test/exec', secret: 'shared-shh', icsUrl: 'https://example.test/basic.ics' },
  worker: { url: 'https://example.test/mcp/path-secret-1234', pathSecret: 'path-secret-1234' },
  deviceId: 'device-alpha',
  deviceName: 'a laptop',
  theme: 'dark',
  dayStartOffsetMs: 4 * 3600_000,
  idleThresholdMs: 12 * 60_000,
  workdayStart: '08:30',
  workdayEnd: '18:00',
};

describe('toSyncable', () => {
  it('never serialises secrets into a syncable payload', () => {
    const s = { ...DEFAULT_SETTINGS, github: { token: 'ghp_secret', owner: 'o', repo: 'r', branch: '' } };
    const synced = toSyncable(s);
    expect(JSON.stringify(synced)).not.toContain('ghp_secret');
  });

  it('drops every secret and every device-local field', () => {
    const json = JSON.stringify(toSyncable(filled));
    for (const secret of ['ghp_secret', 'shared-shh', 'path-secret-1234', 'device-alpha', 'a laptop']) {
      expect(json).not.toContain(secret);
    }
    expect(toSyncable(filled)).toEqual({
      // The branch syncs: every device points at the same one, and a device
      // that had to re-derive it could derive it differently.
      github: { owner: 'an-owner', repo: 'a-repo', branch: 'master' },
      calendar: { execUrl: 'https://example.test/exec', icsUrl: 'https://example.test/basic.ics' },
      theme: 'dark',
      dayStartOffsetMs: 4 * 3600_000,
      idleThresholdMs: 12 * 60_000,
      workdayStart: '08:30',
      workdayEnd: '18:00',
    });
  });

  it('does not alias the settings it was given', () => {
    const synced = toSyncable(filled);
    synced.github.owner = 'changed';
    expect(filled.github.owner).toBe('an-owner');
  });
});

describe('settings events', () => {
  const settingsEvent = (payload: unknown): Event => ({
    id: 'e1', deviceId: 'dev', ts: 1, type: 'update', entity: 'settings',
    entityId: 'settings', payload, schemaVersion: 1,
  });

  it('cannot write a secret or a device id into replayed state', () => {
    const state = replay([settingsEvent(filled)]);
    // Absent from the type and from the object, not merely empty: reading a
    // token off replayed state should not compile, let alone return something.
    expect(state.settings.github).not.toHaveProperty('token');
    expect(state.settings.calendar).not.toHaveProperty('secret');
    expect(state.settings).not.toHaveProperty('worker');
    expect(state.settings).not.toHaveProperty('deviceId');
    expect(state.settings).not.toHaveProperty('deviceName');
    for (const secret of ['ghp_secret', 'shared-shh', 'path-secret-1234', 'device-alpha']) {
      expect(JSON.stringify(state)).not.toContain(secret);
    }
  });

  it('applies exactly the syncable fields, so replay and toSyncable cannot drift', () => {
    const state = replay([settingsEvent(filled)]);
    expect(state.settings).toEqual(toSyncable(filled));
  });
});

describe('validateSettings', () => {
  it('accepts a complete settings object unchanged', () => {
    const result = validateSettings(filled);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(filled);
  });

  it('fills missing fields from the defaults, because a persisted field added later is optional', () => {
    const result = validateSettings({ theme: 'light' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
  });

  it('refuses a value of the wrong type rather than silently defaulting it', () => {
    const result = validateSettings({ idleThresholdMs: 'ten minutes' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('idleThresholdMs');
  });

  it('refuses an unknown theme, a malformed workday time and a nonsense day offset', () => {
    expect(validateSettings({ theme: 'sepia' }).ok).toBe(false);
    expect(validateSettings({ workdayStart: '9am' }).ok).toBe(false);
    expect(validateSettings({ workdayEnd: '25:00' }).ok).toBe(false);
    expect(validateSettings({ dayStartOffsetMs: -1 }).ok).toBe(false);
    expect(validateSettings({ dayStartOffsetMs: 25 * 3600_000 }).ok).toBe(false);
    expect(validateSettings({ idleThresholdMs: 0 }).ok).toBe(false);
  });

  it('refuses anything that is not an object', () => {
    for (const bad of [null, 'settings', 42, [], undefined]) {
      expect(validateSettings(bad).ok).toBe(false);
    }
  });

  it('ignores keys it does not know, so an older build can read a newer file', () => {
    const result = validateSettings({ ...filled, somethingNew: { nested: true } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(filled);
  });

  it('accepts what toSyncable produces, so a synced payload can be rehydrated', () => {
    const result = validateSettings(toSyncable(filled));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.github.token).toBe('');
      expect(result.value.theme).toBe('dark');
    }
  });
});

describe('Platform', () => {
  it('is implementable by a plain in-memory adapter', async () => {
    const store = new Map<string, string>();
    const requests: HttpRequest[] = [];
    const files = new Map<string, string>();
    const platform: Platform = {
      async http(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        return { status: 200, headers: { etag: 'W/"abc"' }, text: async () => '{"ok":true}' };
      },
      store: {
        get: async key => store.get(key) ?? null,
        set: async (key, value) => { store.set(key, value); },
        remove: async key => { store.delete(key); },
        keys: async () => [...store.keys()],
      },
      files: {
        read: async name => files.get(name) ?? null,
        write: async (name, contents) => { files.set(name, contents); },
        remove: async name => { files.delete(name); },
      },
      notify: async () => 1,
      cancelNotification: async () => {},
      onResume: () => () => {},
    };

    const res = await platform.http({ url: 'https://example.test/x', method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('W/"abc"');
    expect(JSON.parse(await res.text())).toEqual({ ok: true });
    expect(requests[0].method).toBe('POST');

    await platform.store.set('k', 'v');
    expect(await platform.store.get('k')).toBe('v');
    expect(await platform.store.keys()).toEqual(['k']);
    await platform.store.remove('k');
    expect(await platform.store.get('k')).toBeNull();

    // Desktop supplies an OS idle signal; mobile and browser do not.
    expect(platform.idleSeconds).toBeUndefined();
  });
});

describe('deviceId validation at the settings boundary', () => {
  it('accepts an unset id, which is what an install before the wizard looks like', () => {
    const result = validateSettings({ deviceId: '' });
    expect(result.ok).toBe(true);
  });

  it('accepts a path-safe id', () => {
    const result = validateSettings({ deviceId: 'daniel-laptop' });
    expect(result.ok && result.value.deviceId).toBe('daniel-laptop');
  });

  it.each(['has/slash', '../escape', '.leading-dot', 'has space', 'has:colon'])(
    'refuses %s rather than writing events where no reader looks',
    bad => {
      // The engine rejects these too, but by then the value is already stored.
      // A settings file edited by hand reaches the app through here.
      const result = validateSettings({ deviceId: bad });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain('deviceId');
    },
  );
});
