import {
  GitHubClient,
  SyncConflictError,
  SyncEngine,
  isEmptyRepository,
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

/** How often to sync while the app is open. */
export const SYNC_EVERY_MS = 5 * 60_000;

/** How long to wait after a change before pushing it. */
export const SYNC_AFTER_CHANGE_MS = 10_000;

export type SyncPhase = 'unconfigured' | 'idle' | 'syncing' | 'ok' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  /** What happened, in words, for the settings screen and nothing else. */
  detail: string;
  at: number | null;
  pending: number;
}

export interface SyncControllerOptions {
  store: Store;
  http: Http;
  settings: () => Settings;
  now?: () => number;
  onStatus?: (status: SyncStatus) => void;
}

function configured(settings: Settings): boolean {
  return (
    settings.github.owner !== '' && settings.github.repo !== '' && settings.github.token !== ''
  );
}

export class SyncController {
  private readonly store: Store;
  private readonly http: Http;
  private readonly readSettings: () => Settings;
  private readonly nowFn: () => number;
  private readonly onStatus: ((status: SyncStatus) => void) | undefined;

  private running: Promise<SyncStatus> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private after: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  status: SyncStatus = { phase: 'unconfigured', detail: 'Not configured.', at: null, pending: 0 };

  constructor(options: SyncControllerOptions) {
    this.store = options.store;
    this.http = options.http;
    this.readSettings = options.settings;
    this.nowFn = options.now ?? Date.now;
    this.onStatus = options.onStatus;
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
    const tick = (): void => {
      if (this.stopped) return;
      void this.syncNow();
      this.timer = setTimeout(tick, SYNC_EVERY_MS);
    };
    this.timer = setTimeout(tick, SYNC_EVERY_MS);
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
    this.after = setTimeout(() => void this.syncNow(), SYNC_AFTER_CHANGE_MS);
  }

  /**
   * One round trip: push what is local, then take what is remote.
   *
   * Never two at once. A second call while one is in flight joins the first
   * rather than starting a race for the same ref, which would produce a
   * conflict this device caused itself.
   */
  syncNow(): Promise<SyncStatus> {
    if (this.running !== null) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
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

  private set(phase: SyncPhase, detail: string, at: number | null = this.status.at): SyncStatus {
    this.status = { phase, detail, at, pending: this.store.pending().length };
    this.onStatus?.(this.status);
    return this.status;
  }

  private async run(): Promise<SyncStatus> {
    const settings = this.readSettings();
    if (!configured(settings)) return this.set('unconfigured', 'Not configured.');

    this.set('syncing', 'Syncing.');
    const client = new GitHubClient(this.http, {
      owner: settings.github.owner,
      repo: settings.github.repo,
      token: settings.github.token,
      // Empty means "resolve the repository's own default", which is what stops
      // a guessed `main` from writing to a branch that does not exist.
      ...(settings.github.branch === '' ? {} : { branch: settings.github.branch }),
    });
    const engine = new SyncEngine({ client, deviceId: this.store.device });

    try {
      // Read before writing: the engine swaps its commit against the head it
      // read, so pushing against a stale one is a conflict it caused itself.
      await engine.pull();

      const pending = this.store.pending();
      if (pending.length > 0) {
        const result = await this.push(engine, settings, pending);
        // `unchanged` means the engine found nothing new to write, which is as
        // good as a push: the repository already has these events.
        if (result === 'ok' || result === 'unchanged') this.store.markPushed(watermarkOf(pending));
      }

      // The repository's view, snapshot included. Local work that has not been
      // pushed is rebased onto it rather than replayed alongside it.
      this.store.adoptRemote(await engine.pullState());
      await this.store.flush();

      const count = this.store.pending().length;
      return this.set(
        'ok',
        count === 0 ? 'Everything is synced.' : `${count} events still to push.`,
        this.nowFn(),
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

function messageOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const trimmed = text.trim();
  if (trimmed === '') return 'Sync failed.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
