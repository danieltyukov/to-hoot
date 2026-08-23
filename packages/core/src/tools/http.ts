// `Platform.http` over the runtime's own fetch.
//
// The app's own shells deliberately do not use fetch: Apps Script cannot answer
// a CORS preflight, so the desktop goes through `tauri-plugin-http` and Android
// through `CapacitorHttp`. Neither MCP host has that problem. A stdio server on
// Node and a Cloudflare Worker both talk to GitHub only, from a server, where
// fetch is the native transport and there is no CORS to answer.

import type { Http } from '../platform.js';

/**
 * Header names are lowercased here rather than at every call site, which is the
 * contract `HttpResponse` states: a caller reads `headers.etag` without knowing
 * what casing the server chose.
 */
export const fetchHttp: Http = async req => {
  const res = await fetch(req.url, {
    method: req.method ?? 'GET',
    headers: req.headers,
    body: req.body,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, headers, text: () => res.text() };
};
