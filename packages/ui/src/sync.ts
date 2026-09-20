import {
  GitHubClient,
  SyncConflictError,
  SyncEngine,
  isEmptyRepository,
  type DeviceRecord,
  type Event,
  type Http,
  type PushResult,
  type Settings,
} from '@to-hoot/core';

import { watermarkOf } from './persistence.js';
import { ensureInitialCommit } from './setup.js';
import type { Store } from './store.js';

/*
 * What drives sync.
 *
 * The engine knows how to merge; nothing knew when to run it. This does, and
 * the answer is deliberately opportunistic: on boot, on a timer, when the app
 * comes back to the foreground, and shortly after the user changes something.
 *
 * Late sync is harmless by design. Every event carries its own timestamp and
 * device, replay orders them into one sequence whenever they arrive, and
 * `timeDelta` carries an increment rather than a total so two devices tracking
 * at once sum instead of overwriting. That is what makes it safe not to fight
 * the platform for background execution: a phone that syncs when it is next
 * opened produces the same state as one that synced on the minute.
 */

/**
 * How often to poll while the app is on screen.
 *
 * Ten seconds, because the poll is one conditional GET that answers 304 when
 * nothing moved, and a 304 costs nothing against GitHub's primary rate limit
 * and one round trip of time. The price of polling often is therefore only
 * the request itself, and what it buys is that a task added on the phone, or
 * by Claude, is on the laptop's screen in seconds rather than in a minute.
 */
export const SYNC_EVERY_MS = 10_000;

/**
 * How often to poll while the app is hidden: minimised, on another workspace,
 * or a tab nobody is looking at. Nobody is waiting on the screen, so a minute
 * is plenty; coming back to the foreground syncs at once anyway.
 */
export const SYNC_EVERY_HIDDEN_MS = 60_000;

/**
 * How long to wait after a change before pushing it. Long enough that a burst
 * of edits becomes one commit, short enough that the other device sees the
 * change on its next poll rather than the one after.
 */
export const SYNC_AFTER_CHANGE_MS = 2_000;

/**
 * How long a running timer's bookkeeping may wait before it is pushed on its
 * own. See `isBookkeeping`.
 */
export const TRACKING_PUSH_EVERY_MS = 120_000;

export type SyncPhase = 'unconfigured' | 'idle' | 'syncing' | 'ok' | 'error';

/** One device that has written to the repository, and when it last did. */
export interface SyncDevice {
  id: string;
  lastSeen: number;
}

export interface SyncStatus {
  phase: SyncPhase;
  /** What happened, in words, for the settings screen and nothing else. */
  detail: string;
  at: number | null;
  /**
   * Events that should be in the repository by now and are not. A running
   * timer's held bookkeeping is not counted: it is waiting on purpose, and
   * showing it as a backlog would make a healthy device look stuck.
   */
  pending: number;
  /**
   * Every device the repository has seen, from its own registry. This is what
   * answers "will the phone's tasks show up here": the phone is in the list,
   * and so is the last moment it wrote.
   */
  devices: SyncDevice[];
}

export interface SyncControllerOptions {
  store: Store;
  http: Http;
  settings: () => Settings;
  now?: () => number;
  onStatus?: (status: SyncStatus) => void;
  /**
   * Whether the app is on screen, which sets the polling rate. Defaults to
   * the document's own visibility, and to visible where there is no document.
   */
  visible?: () => boolean;
}

export interface SyncOptions {
  /**
   * Push everything, a running timer's held bookkeeping included. The Sync
   * now button, where a person is asking for exactly that.
   */
  everything?: boolean;
}

function configured(settings: Settings): boolean {
  return (
    settings.github.owner !== '' && settings.github.repo !== '' && settings.github.token !== ''
  );
}

function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Whether an event is a running timer's own bookkeeping: the `timeDelta` a
 * flush banks every half minute, and the calendar ledger the write-back
 * updates right after it.
 *
 * These are held rather than pushed as they arrive. A timer produces one every
 * FLUSH_MS, and a commit per flush is a commit every half minute per device:
 * most of GitHub's hourly budget for writes, and a moved head on every other
 * device's every poll, so none of them ever gets the free 304. The time is not
 * at risk, it is on disk here, and it reaches the repository with the next
 * real change, when the timer stops, or after TRACKING_PUSH_EVERY_MS at the
 * latest. Only the running task's own events qualify: a delta on any other
 * task is a stop, an idle answer or a manual log, and those go at once.
 */
function isBookkeeping(event: Event, runningTaskId: string): boolean {
  if (event.entity !== 'task' || event.entityId !== runningTaskId) return false;
  if (event.type === 'timeDelta') return true;
  if (event.type !== 'update') return false;
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return false;
  return Object.keys(payload).every(key => key === 'calendarWritten' || key === 'calendarBlocks');
}

interface Wiring {
  /** The settings the engine was built from. A change to any of them rebuilds it. */
  key: string;
  engine: SyncEngine;
  /**
   * The head the store last adopted, so a poll that finds nothing new does
   * not rebase and rewrite the cache for nothing. `undefined` until the first
   * adoption, which is distinct from `null`, the head of an empty repository.
   */
  adopted: string | null | undefined;
}

export class SyncController {
  private readonly store: Store;
  private readonly http: Http;
  private readonly readSettings: () => Settings;
  private readonly nowFn: () => number;
  private readonly onStatus: ((status: SyncStatus) => void) | undefined;
  private readonly visible: () => boolean;

  private running: Promise<SyncStatus> | null = null;
  /** A change landed while a sync was in flight, so one more must follow it. */
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private after: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /**
   * Kept across runs, because everything worth keeping lives in the engine:
   * the etag that turns an idle poll into one free request, the blob cache
   * that makes a changed poll fetch only what is new, and the resolved branch.
   * Building a fresh one per run threw all three away, and every poll read the
   * whole repository again, one file after another.
   */
  private wiring: Wiring | undefined;

  status: SyncStatus = { phase: 'unconfigured', detail: 'Not configured.', at: null, pending: 0, devices: [] };

  constructor(options: SyncControllerOptions) {
    this.store = options.store;
    this.http = options.http;
    this.readSettings = options.settings;
    this.nowFn = options.now ?? Date.now;
    this.onStatus = options.onStatus;
    this.visible = options.visible ?? documentVisible;
  }

  /**
   * Starts the timer and returns the way to stop it.
   *
   * The caller wires resume and post-change nudges to `soon()`; this only owns
   * the clock, so a test can drive everything else without one.
   */
  start(): () => void {
    // Restartable, because React mounts, unmounts and remounts in development
    // and the memoized controller survives all three. A `stopped` flag that
    // only ever went one way left the timer, `soon()` and every later sync dead
    // in dev while production was fine, which is the worst place for a
    // difference between the two to live.
    this.stopped = false;
    // The rate is read when each tick is scheduled, so a window that is
    // minimised slows down at its next tick and speeds up again the tick after
    // it comes back. Coming back also focuses the window, and the caller syncs
    // on that at once, so nothing waits out the slow interval on screen.
    const schedule = (): void => {
      this.timer = setTimeout(tick, this.visible() ? SYNC_EVERY_MS : SYNC_EVERY_HIDDEN_MS);
    };
    const tick = (): void => {
      if (this.stopped) return;
      void this.syncNow();
      schedule();
    };
    schedule();
    return () => {
      this.stopped = true;
      clearTimeout(this.timer);
      clearTimeout(this.after);
    };
  }

  /**
   * Syncs shortly, coalescing a burst of changes into one round trip.
   *
   * A push per keystroke would be correct and absurd. The delay is what turns
   * "the user is editing" into one commit rather than thirty.
   */
  soon(): void {
    if (this.stopped || !configured(this.readSettings())) return;
    clearTimeout(this.after);
    this.after = setTimeout(() => {
      if (this.running === null) {
        void this.syncNow();
        return;
      }
      // A sync is in flight and has already decided what it pushes, so this
      // change is not in it. Joining it would report success and leave the
      // change here until the next poll; instead one more run follows it.
      this.again = true;
    }, SYNC_AFTER_CHANGE_MS);
  }

  /**
   * One round trip: push what is local, then take what is remote.
   *
   * Never two at once. A second call while one is in flight joins the first
   * rather than starting a race for the same ref, which would produce a
   * conflict this device caused itself.
   */
  syncNow(options: SyncOptions = {}): Promise<SyncStatus> {
    if (this.running !== null) return this.running;
    this.running = this.run(options).finally(() => {
      this.running = null;
      if (this.again && !this.stopped) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  /**
   * Pushes, giving an empty repository its first commit if that is what is
   * wrong.
   *
   * Verified live: the Git Data API answers `409 Git Repository is empty` for
   * every write into a repository with no commits, so the engine's whole commit
   * path can make the second commit and not the first. Someone who points the
   * app at a fresh empty repository without running the wizard's check would
   * otherwise see sync fail forever with a message about trees.
   */
  private async push(
    engine: SyncEngine,
    settings: Settings,
    pending: Parameters<SyncEngine['push']>[0],
  ): Promise<PushResult['status']> {
    try {
      return (await engine.push(pending)).status;
    } catch (err) {
      // `isEmptyRepository` is status-only, so this is "some 409", not proof of
      // an empty repository. That is safe rather than sloppy: re-initialising a
      // repository that already has a commit is answered 422 and changes
      // nothing, and the retry below is the single one. But a 409 that meant
      // something else will surface as the retry's own failure rather than as
      // this one, so the original is kept and re-thrown if the seed refuses.
      if (!isEmptyRepository(err)) throw err;
      const seeded = await ensureInitialCommit(this.http, settings.github.token, {
        owner: settings.github.owner,
        repo: settings.github.repo,
        branch: settings.github.branch,
      });
      // The seed's own reason, not a generic one, and the original 409 with it.
      // Throwing `err` alone was the generic one, which is what the comment was
      // written to rule out.
      if (seeded.status === 'error') {
        throw new Error(
          `${seeded.detail} (after ${err instanceof Error ? err.message : String(err)})`,
        );
      }
      await engine.pull();
      return (await engine.push(pending)).status;
    }
  }

  /**
   * Removes a device from the repository's registry, so it leaves the Devices
   * list on every device at their next sync. Its events stay; see
   * `SyncEngine.forgetDevice`. Queued behind a sync in flight rather than
   * racing it for the ref.
   */
  forgetDevice(id: string): Promise<SyncStatus> {
    if (this.running !== null) return this.running.then(() => this.forgetDevice(id));
    this.running = this.forget(id).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async forget(id: string): Promise<SyncStatus> {
    const settings = this.readSettings();
    if (!configured(settings)) return this.set('unconfigured', 'Not configured.');
    const { engine } = this.wiringFor(settings);
    try {
      await engine.pull();
      const result = await engine.forgetDevice(id);
      if (result === 'conflict') {
        return this.set('error', 'Another device was writing. Try again.', this.status.at);
      }
      return this.set(
        'ok',
        result === 'ok' ? `Forgot ${id}.` : `${id} was already gone.`,
        this.status.at,
        devicesOf(engine.devices),
      );
    } catch (err) {
      return this.set('error', messageOf(err), this.status.at);
    }
  }

  private wiringFor(settings: Settings): Wiring {
    const key = JSON.stringify([
      settings.github.owner,
      settings.github.repo,
      settings.github.branch,
      settings.github.token,
      this.store.device,
    ]);
    if (this.wiring?.key !== key) {
      const client = new GitHubClient(this.http, {
        owner: settings.github.owner,
        repo: settings.github.repo,
        token: settings.github.token,
        // Empty means "resolve the repository's own default", which is what stops
        // a guessed `main` from writing to a branch that does not exist.
        ...(settings.github.branch === '' ? {} : { branch: settings.github.branch }),
      });
      this.wiring = {
        key,
        engine: new SyncEngine({ client, deviceId: this.store.device }),
        adopted: undefined,
      };
    }
    return this.wiring;
  }

  /**
   * Whether what is pending is worth a commit now: anything at all once the
   * timer is stopped, and otherwise anything that is not the running timer's
   * own bookkeeping, or bookkeeping old enough to have waited its turn.
   */
  private due(pending: readonly Event[]): boolean {
    if (pending.length === 0) return false;
    const running = this.store.getSnapshot().runningTaskId;
    if (running === null) return true;
    const cutoff = this.nowFn() - TRACKING_PUSH_EVERY_MS;
    return pending.some(e => !isBookkeeping(e, running) || e.ts <= cutoff);
  }

  /** The events that should have been pushed by now. See `SyncStatus.pending`. */
  private waiting(): number {
    const pending = this.store.pending();
    return this.due(pending) ? pending.length : 0;
  }

  private set(
    phase: SyncPhase,
    detail: string,
    at: number | null = this.status.at,
    devices: SyncDevice[] = this.status.devices,
  ): SyncStatus {
    this.status = { phase, detail, at, pending: this.waiting(), devices };
    this.onStatus?.(this.status);
    return this.status;
  }

  private async run(options: SyncOptions): Promise<SyncStatus> {
    const settings = this.readSettings();
    if (!configured(settings)) return this.set('unconfigured', 'Not configured.');

    this.set('syncing', 'Syncing.');
    const wiring = this.wiringFor(settings);
    const { engine } = wiring;

    try {
      // Read before writing: the engine swaps its commit against the head it
      // read, so pushing against a stale one is a conflict it caused itself.
      await engine.pull();

      const pending = this.store.pending();
      if (options.everything === true ? pending.length > 0 : this.due(pending)) {
        const result = await this.push(engine, settings, pending);
        // `unchanged` means the engine found nothing new to write, which is as
        // good as a push: the repository already has these events.
        if (result === 'ok' || result === 'unchanged') this.store.markPushed(watermarkOf(pending));
        // The commit just made is the head now; read it back so the store's
        // base is what the repository actually holds.
        if (result === 'ok') await engine.pull();
      }

      // The repository's view, snapshot included. Local work that has not been
      // pushed is rebased onto it rather than replayed alongside it. Only when
      // the head has moved since the last adoption, which a push of our own
      // counts as: a poll that found nothing new leaves the store alone, and
      // costs the one conditional request it already made.
      if (engine.head !== wiring.adopted) {
        this.store.adoptRemote(engine.state());
        wiring.adopted = engine.head;
      }
      await this.store.flush();

      const count = this.waiting();
      return this.set(
        'ok',
        count === 0 ? 'Everything is synced.' : `${count} events still to push.`,
        this.nowFn(),
        devicesOf(engine.devices),
      );
    } catch (err) {
      if (err instanceof SyncConflictError) {
        // Another device won the ref race. Nothing is lost: the next run reads
        // its commit and rebuilds this device's write on top of it.
        return this.set('error', 'Another device was writing. It will retry.', this.status.at);
      }
      return this.set('error', messageOf(err), this.status.at);
    }
  }
}

/** The registry as a list, most recently active first. */
function devicesOf(devices: Record<string, DeviceRecord>): SyncDevice[] {
  return Object.entries(devices)
    .map(([id, record]) => ({ id, lastSeen: record.lastSeen }))
    .sort((a, b) => b.lastSeen - a.lastSeen || (a.id < b.id ? -1 : 1));
}

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const trimmed = text.trim();
  if (trimmed === '') return 'Sync failed.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
