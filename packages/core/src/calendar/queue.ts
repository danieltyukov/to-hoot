// A write queue with three properties, none of which is an optimisation.
//
//   1. PER-ENTITY SERIALISATION. Two writes for the same entity never overlap.
//      Google Calendar answers a second write to the same event with a rate
//      limit error or, worse, applies them out of order, so the second write
//      for an entity waits for the first to finish rather than racing it.
//   2. A 1000 ms DEBOUNCE per entity. One settled user edit dispatches several
//      actions (title, estimate, tags), and without a debounce each becomes its
//      own API call, which is how a single edit trips the per-event write rate
//      limit.
//   3. AT MOST THREE writes in flight across entities. A backfill of a month of
//      history is a few hundred writes, and firing them all at once exhausts
//      the per-user quota and fails the lot.
//
// It is generic over the payload because none of that is calendar-specific: the
// queue knows about identity, timing and concurrency, and nothing else.

/** One settled edit, not four keystrokes. */
export const DEFAULT_DEBOUNCE_MS = 1000;
/** Google's per-user quota is the ceiling; three is comfortably under it. */
export const DEFAULT_MAX_CONCURRENT = 3;

export interface WriteQueueOptions {
  debounceMs?: number;
  maxConcurrent?: number;
  /**
   * Called for every failed write. Without one, failures are still counted and
   * the last is kept on `lastError`, because a write-back that quietly stops
   * working looks exactly like a write-back with nothing to do.
   */
  onError?(entityId: string, err: unknown): void;
}

export type WriteFn<P> = (entityId: string, payload: P) => Promise<void> | void;

interface Pending<P> {
  payload: P;
  timer: ReturnType<typeof setTimeout>;
}

export class WriteQueue<P> {
  private readonly write: WriteFn<P>;
  private readonly debounceMs: number;
  private readonly maxConcurrent: number;
  private readonly onError: ((entityId: string, err: unknown) => void) | undefined;

  /** Entities still inside their debounce window. */
  private readonly pending = new Map<string, Pending<P>>();
  /** Debounced and waiting for a slot. Insertion order is the run order. */
  private readonly ready = new Map<string, P>();
  private readonly running = new Set<string>();
  private readonly idleWaiters: (() => void)[] = [];
  private disposed = false;

  errorCount = 0;
  lastError: unknown;

  constructor(write: WriteFn<P>, options: WriteQueueOptions = {}) {
    this.write = write;
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.onError = options.onError;
  }

  /** Entities debouncing or waiting for a slot. */
  get pendingCount(): number {
    return this.pending.size + this.ready.size;
  }

  get runningCount(): number {
    return this.running.size;
  }

  /**
   * Queues the latest state of an entity, replacing anything not yet started
   * for it. A fresh edit restarts the debounce even if the previous one had
   * already elapsed but is still waiting for a slot: the user is evidently
   * still typing, and the newer payload supersedes the older one anyway.
   */
  enqueue(entityId: string, payload: P): void {
    if (this.disposed) return;
    const existing = this.pending.get(entityId);
    if (existing) clearTimeout(existing.timer);
    this.ready.delete(entityId);
    const timer = setTimeout(() => this.promote(entityId), this.debounceMs);
    this.pending.set(entityId, { payload, timer });
  }

  /** Drops a queued write that has not started. Returns whether there was one. */
  cancel(entityId: string): boolean {
    const existing = this.pending.get(entityId);
    if (existing) {
      clearTimeout(existing.timer);
      this.pending.delete(entityId);
      this.settleIfIdle();
      return true;
    }
    if (this.ready.delete(entityId)) {
      this.settleIfIdle();
      return true;
    }
    return false;
  }

  /**
   * Starts everything queued without waiting out the debounce, and resolves
   * when the queue has drained. For "sync now", and for shutdown, where the
   * alternative is losing the last second of edits.
   */
  flush(): Promise<void> {
    for (const [entityId, entry] of [...this.pending]) {
      clearTimeout(entry.timer);
      this.pending.delete(entityId);
      this.ready.set(entityId, entry.payload);
    }
    this.pump();
    return this.idle();
  }

  /** Resolves when nothing is queued, debouncing, or in flight. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>(resolve => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * Drops everything queued and refuses further work. Writes already in flight
   * are not cancellable and are left to finish; they start nothing new.
   */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.ready.clear();
    this.settleIfIdle();
  }

  private isIdle(): boolean {
    return this.pending.size === 0 && this.ready.size === 0 && this.running.size === 0;
  }

  private promote(entityId: string): void {
    const entry = this.pending.get(entityId);
    if (!entry) return;
    this.pending.delete(entityId);
    this.ready.set(entityId, entry.payload);
    this.pump();
  }

  private pump(): void {
    while (this.running.size < this.maxConcurrent) {
      let next: string | undefined;
      for (const entityId of this.ready.keys()) {
        // Skipping rather than stopping: an entity whose previous write is
        // still in flight must not hold up the rest of the queue.
        if (!this.running.has(entityId)) {
          next = entityId;
          break;
        }
      }
      if (next === undefined) break;
      const payload = this.ready.get(next) as P;
      this.ready.delete(next);
      this.running.add(next);
      this.start(next, payload);
    }
    this.settleIfIdle();
  }

  private start(entityId: string, payload: P): void {
    let result: Promise<void>;
    try {
      result = Promise.resolve(this.write(entityId, payload));
    } catch (err) {
      result = Promise.reject(err);
    }
    result
      .then(
        () => undefined,
        (err: unknown) => {
          this.report(entityId, err);
        },
      )
      .then(() => {
        this.running.delete(entityId);
        this.pump();
      });
  }

  private report(entityId: string, err: unknown): void {
    this.errorCount++;
    this.lastError = err;
    // A failed write leaves the ledger untouched, so the next sync retries it
    // with the same delta. Retrying here as well would double the traffic
    // against a rate limit that is usually what failed in the first place.
    if (this.onError) this.onError(entityId, err);
  }

  private settleIfIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }
}
