import { describe, expect, it } from 'vitest';
import type { Http, HttpRequest, HttpResponse } from '../platform.js';
import { MAX_WRITE_ENTRIES } from './bridge.js';
import { CalendarBridgeClient, CalendarBridgeError } from './client.js';

const EXEC_URL = 'https://script.google.com/macros/s/AKfycb-example/exec';
const SECRET = 'a-generated-secret';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  raw: string | undefined;
}

class MockHttp {
  calls: Call[] = [];
  private queued: { status: number; body: unknown; raw?: string }[] = [];
  private fail: Error | undefined;

  reply(body: unknown, status = 200): this {
    this.queued.push({ status, body });
    return this;
  }

  replyRaw(raw: string, status = 200): this {
    this.queued.push({ status, body: undefined, raw });
    return this;
  }

  failWith(err: Error): this {
    this.fail = err;
    return this;
  }

  readonly http: Http = async (req: HttpRequest): Promise<HttpResponse> => {
    this.calls.push({
      url: req.url,
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      body: req.body === undefined ? undefined : JSON.parse(req.body),
      raw: req.body,
    });
    if (this.fail) throw this.fail;
    const next = this.queued.shift();
    if (!next) throw new Error(`no reply queued for ${req.url}`);
    const text = next.raw ?? JSON.stringify(next.body);
    return { status: next.status, headers: {}, text: async () => text };
  };
}

function clientFor(mock: MockHttp): CalendarBridgeClient {
  return new CalendarBridgeClient(mock.http, { execUrl: EXEC_URL, secret: SECRET });
}

function event(id: string) {
  return { id, calendarId: 'primary', title: id, start: 1000, end: 2000, allDay: false };
}

describe('CalendarBridgeClient transport', () => {
  it('posts the secret in the body and never in the URL', async () => {
    const mock = new MockHttp().reply({ ok: true, action: 'listEvents', events: [] });
    await clientFor(mock).listEvents({ from: 0, days: 1 });

    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(EXEC_URL);
    expect(call.url).not.toContain(SECRET);
    expect(call.url).not.toContain('?');
    expect(call.body.secret).toBe(SECRET);
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('reports a rejected secret as its own failure, not as a generic error', async () => {
    const mock = new MockHttp().reply({ ok: false, code: 'unauthorized', error: 'bad secret' });
    await expect(clientFor(mock).listEvents({ from: 0, days: 1 })).rejects.toMatchObject({
      name: 'CalendarBridgeError',
      code: 'unauthorized',
    });
  });

  it('explains an HTML answer instead of dying in JSON.parse', async () => {
    // Google serves a sign-in page when the deployment is not readable by
    // anyone with the link, which is the single most common setup mistake.
    const mock = new MockHttp().replyRaw('<!DOCTYPE html><html><title>Sign in</title>');
    const err = await clientFor(mock)
      .listEvents({ from: 0, days: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarBridgeError);
    expect((err as CalendarBridgeError).code).toBe('not-json');
    expect((err as CalendarBridgeError).message).toMatch(/access/i);
  });

  it('carries the status through when the deployment answers with an error page', async () => {
    const mock = new MockHttp().replyRaw('nope', 404);
    const err = await clientFor(mock)
      .listEvents({ from: 0, days: 1 })
      .catch((e: unknown) => e);
    expect((err as CalendarBridgeError).code).toBe('http');
    expect((err as CalendarBridgeError).status).toBe(404);
  });

  it('wraps a transport failure in the bridge error type', async () => {
    const mock = new MockHttp().failWith(new Error('dns failure'));
    const err = await clientFor(mock)
      .listEvents({ from: 0, days: 1 })
      .catch((e: unknown) => e);
    expect((err as CalendarBridgeError).code).toBe('transport');
    expect((err as CalendarBridgeError).message).toContain('dns failure');
  });

  it('refuses an execUrl that is not an https deployment URL', () => {
    expect(() => new CalendarBridgeClient(new MockHttp().http, { execUrl: 'http://example.com/exec', secret: SECRET }))
      .toThrow(/https/i);
  });
});

describe('CalendarBridgeClient listEvents', () => {
  it('drives the pagination loop until the script stops handing out tokens', async () => {
    const mock = new MockHttp()
      .reply({ ok: true, action: 'listEvents', events: [event('a')], nextPageToken: 'p2' })
      .reply({ ok: true, action: 'listEvents', events: [event('b')], nextPageToken: 'p3' })
      .reply({ ok: true, action: 'listEvents', events: [event('c')] });

    const events = await clientFor(mock).listEvents({ from: 1000, days: 7 });
    expect(events.map(e => e.id)).toEqual(['a', 'b', 'c']);
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls.map(c => c.body.pageToken)).toEqual([undefined, 'p2', 'p3']);
    expect(mock.calls.every(c => c.body.from === 1000 && c.body.days === 7)).toBe(true);
  });

  it('stops rather than looping forever on a script that always returns a token', async () => {
    const mock = new MockHttp();
    for (let i = 0; i < 10; i++) mock.reply({ ok: true, action: 'listEvents', events: [], nextPageToken: 'p' });
    const err = await clientFor(mock)
      .listEvents({ from: 0, days: 1, maxPages: 3 })
      .catch((e: unknown) => e);
    expect((err as CalendarBridgeError).code).toBe('too-many-pages');
    expect(mock.calls).toHaveLength(3);
  });

  it('passes a calendar id through and defaults to none, so the script decides', async () => {
    const mock = new MockHttp().reply({ ok: true, action: 'listEvents', events: [] });
    await clientFor(mock).listEvents({ from: 0, days: 1, calendarId: 'team@example.com' });
    expect(mock.calls[0]!.body.calendarId).toBe('team@example.com');

    const plain = new MockHttp().reply({ ok: true, action: 'listEvents', events: [] });
    await clientFor(plain).listEvents({ from: 0, days: 1 });
    expect(plain.calls[0]!.body.calendarId).toBeUndefined();
  });
});

describe('CalendarBridgeClient writeLog', () => {
  const entry = (n: number) => ({ toHootId: `t${n}::2026-08-23`, title: `task ${n}`, start: 0, end: 1000 });

  it('sends one batch and returns what the script did with it', async () => {
    const mock = new MockHttp().reply({
      ok: true,
      action: 'writeLog',
      calendarId: 'log-calendar-id',
      written: [{ toHootId: 't1::2026-08-23', eventId: 'ev-1', created: true }],
    });
    const written = await clientFor(mock).writeLog([entry(1)]);
    expect(written).toEqual([{ toHootId: 't1::2026-08-23', eventId: 'ev-1', created: true }]);
    expect(mock.calls[0]!.body.action).toBe('writeLog');
  });

  it('splits a backfill into batches the six-minute limit can serve', async () => {
    const entries = Array.from({ length: MAX_WRITE_ENTRIES + 1 }, (_, i) => entry(i));
    const mock = new MockHttp()
      .reply({ ok: true, action: 'writeLog', calendarId: 'c', written: [] })
      .reply({ ok: true, action: 'writeLog', calendarId: 'c', written: [] });
    await clientFor(mock).writeLog(entries);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.body.entries).toHaveLength(MAX_WRITE_ENTRIES);
    expect(mock.calls[1]!.body.entries).toHaveLength(1);
  });

  it('makes no request at all for an empty batch', async () => {
    const mock = new MockHttp();
    await expect(clientFor(mock).writeLog([])).resolves.toEqual([]);
    await expect(clientFor(mock).deleteLog([])).resolves.toEqual({ deleted: [], missing: [] });
    expect(mock.calls).toHaveLength(0);
  });
});

describe('CalendarBridgeClient deleteLog', () => {
  it('merges what several batches deleted and what they could not find', async () => {
    const mock = new MockHttp().reply({ ok: true, action: 'deleteLog', deleted: ['a'], missing: ['b'] });
    await expect(clientFor(mock).deleteLog(['a', 'b'])).resolves.toEqual({ deleted: ['a'], missing: ['b'] });
    expect(mock.calls[0]!.body.toHootIds).toEqual(['a', 'b']);
  });
});
