import type { Http, KeyValueStore } from '@to-hoot/core';

/*
 * The browser adapter.
 *
 * The desktop and Android shells supply their own, over `tauri-plugin-http` and
 * `CapacitorHttp`. This one exists so the app runs, and the setup wizard is
 * usable, in a plain browser during development and in the web preview.
 *
 * One thing it genuinely cannot do: reach the Apps Script calendar bridge.
 * `/exec` redirects to `script.googleusercontent.com`, which cannot answer a
 * CORS preflight, so the request fails before it is sent. That is a property of
 * Apps Script rather than of this file, and the wizard's calendar check says so
 * in as many words rather than reporting a generic network error.
 */

export const browserHttp: Http = async req => {
  const res = await fetch(req.url, {
    method: req.method ?? 'GET',
    headers: req.headers,
    body: req.body,
  });
  const headers: Record<string, string> = {};
  // Lowercased, which is what the interface promises callers.
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  // Buffered, rather than handing back the stream's own `text()`, which can only
  // be consumed once. The two shell adapters both allow a body to be read
  // twice; a contract that holds on one platform and not another is worse than
  // either behaviour.
  const body = await res.text();
  return { status: res.status, headers, text: async () => body };
};

/**
 * Local storage, namespaced.
 *
 * Every accessor is wrapped: a browser with site data blocked throws on access
 * rather than returning null, and losing a theme preference is not a reason to
 * fail to start.
 */
export function browserStore(prefix = 'to-hoot:'): KeyValueStore {
  return {
    async get(key) {
      try {
        return localStorage.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        localStorage.setItem(prefix + key, value);
      } catch {
        /* ignore: see get */
      }
    },
    async remove(key) {
      try {
        localStorage.removeItem(prefix + key);
      } catch {
        /* ignore */
      }
    },
    async keys() {
      try {
        return Object.keys(localStorage)
          .filter(k => k.startsWith(prefix))
          .map(k => k.slice(prefix.length));
      } catch {
        return [];
      }
    },
  };
}

/** An in-memory store, for tests and for anything with no storage at all. */
export function memoryStore(seed: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(seed));
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
  };
}
