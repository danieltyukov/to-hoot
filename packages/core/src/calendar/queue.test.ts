import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WriteQueue } from './queue.js';

interface Call {
  id: string;
  payload: string;
  settled: boolean;
  resolve(): void;
  reject(err: unknown): void;
}

/**
 * A write that never finishes until the test says so. Every property the queue
 * is supposed to have is about *when* writes run relative to each other, and
 * none of it is observable against a writer that resolves immediately.
 */
function controllable() {
  const calls: Call[] = [];
  const write = (id: string, payload: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const call: Call = {
        id,
        payload,
        settled: false,
        resolve: () => {
          call.settled = true;
          resolve();
        },
        reject: err => {
          call.settled = true;
          reject(err);
        },
      };
      calls.push(call);
    });
  return { calls, write };
}

/** Lets the promise chain the queue is built on run to a standstill. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('WriteQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces four rapid edits of one task into a single write', async () => {
    const api = controllable();
    const q = new WriteQueue(api.write);
    for (const t of ['a', 'b', 'c', 'd']) q.enqueue('task1', t);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.payload).toBe('d');
  });

  it('waits a full second of quiet, and restarts that second on every edit', async () => {
    const api = controllable();
    const q = new WriteQueue(api.write);
    q.enqueue('task1', 'a');
    await vi.advanceTimersByTimeAsync(999);
    expect(api.calls).toHaveLength(0);
    q.enqueue('task1', 'b');
    await vi.advanceTimersByTimeAsync(999);
    expect(api.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.payload).toBe('b');
  });

  it('never runs two writes for the same task concurrently', async () => {
    const api = controllable();
    const q = new WriteQueue(api.write);
    q.enqueue('task1', 'first');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls).toHaveLength(1);

    q.enqueue('task1', 'second');
    await vi.advanceTimersByTimeAsync(1000);
    // The debounce has elapsed, but the first write is still in flight.
    expect(api.calls).toHaveLength(1);

    api.calls[0]!.resolve();
    await settle();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]!.payload).toBe('second');
    expect(api.calls[0]!.settled).toBe(true);
  });

  it('caps concurrent writes across tasks at three', async () => {
    const api = controllable();
    const q = new WriteQueue(api.write);
    for (const id of ['t1', 't2', 't3', 't4', 't5']) q.enqueue(id, id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls.map(c => c.id)).toEqual(['t1', 't2', 't3']);
    expect(q.runningCount).toBe(3);

    api.calls[1]!.resolve();
    await settle();
    expect(api.calls.map(c => c.id)).toEqual(['t1', 't2', 't3', 't4']);

    api.calls[0]!.resolve();
    api.calls[2]!.resolve();
    api.calls[3]!.resolve();
    await settle();
    expect(api.calls.map(c => c.id)).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });

  it('honours a configured concurrency limit and debounce', async () => {
    const api = controllable();
    const q = new WriteQueue(api.write, { debounceMs: 50, maxConcurrent: 1 });
    q.enqueue('t1', 'a');
    q.enqueue('t2', 'b');
    await vi.advanceTimersByTimeAsync(50);
    expect(api.calls).toHaveLength(1);
    api.calls[0]!.resolve();
    await settle();
    expect(api.calls).toHaveLength(2);
  });

  it('keeps going after a failed write, and reports it', async () => {
    const api = controllable();
    const seen: { id: string; err: unknown }[] = [];
    const q = new WriteQueue(api.write, { onError: (id, err) => seen.push({ id, err }) });
    q.enqueue('t1', 'a');
    q.enqueue('t2', 'b');
    await vi.advanceTimersByTimeAsync(1000);
    api.calls[0]!.reject(new Error('rate limited'));
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe('t1');
    expect((seen[0]!.err as Error).message).toBe('rate limited');
    expect(q.runningCount).toBe(1);

    // A failure must not leave the entity permanently blocked either.
    q.enqueue('t1', 'retry');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.calls.map(c => c.payload)).toContain('retry');
  });

  it('flush skips the debounce and resolves once the queue has drained', async () => {
    const api = controllable();
    const q = new WriteQueue(api.write);
    q.enqueue('t1', 'a');
    q.enqueue('t2', 'b');

    let drained = false;
    const done = q.flush().then(() => {
      drained = true;
    });
    await settle();
    expect(api.calls).toHaveLength(2);
    expect(drained).toBe(false);

    for (const call of api.calls) call.resolve();
    await settle();
    await done;
    expect(drained).toBe(true);
    expect(q.pendingCount).toBe(0);
  });

  it('idle resolves immediately when there is nothing to do', async () => {
    const q = new WriteQueue(controllable().write);
    await expect(q.idle()).resolves.toBeUndefined();
  });

  it('cancel drops a pending write, dispose drops all of them', async () => {
    const api = controllable();
    const q = new WriteQueue(api.write);
    q.enqueue('t1', 'a');
    q.enqueue('t2', 'b');
    expect(q.cancel('t1')).toBe(true);
    expect(q.cancel('t1')).toBe(false);
    q.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toHaveLength(0);
    expect(q.pendingCount).toBe(0);
  });

  it('refuses work after dispose rather than queueing it forever', async () => {
    const api = controllable();
    const q = new WriteQueue(api.write);
    q.dispose();
    q.enqueue('t1', 'a');
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.calls).toHaveLength(0);
  });
});
