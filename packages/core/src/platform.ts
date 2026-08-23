// The one interface each shell implements. Nothing in core or ui imports a
// Tauri or a Capacitor module directly, so the same application code runs on the
// desktop, on Android, and against a fake adapter in a plain browser test.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface HttpRequest {
  url: string;
  /** Defaults to GET. */
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  /**
   * Header names are lowercased by the implementation, so callers can read
   * `headers.etag` without knowing what casing the server chose.
   */
  headers: Record<string, string>;
  text(): Promise<string>;
}

/**
 * Modelled on fetch, deliberately: it is the shape every implementation already
 * has, and it keeps this interface free of any one API's vocabulary.
 *
 * The implementations are `tauri-plugin-http` (Rust) and `CapacitorHttp`
 * (native Android), neither of which goes through the browser fetch stack. That
 * is what makes the Apps Script calendar bridge reachable at all: Apps Script
 * cannot answer a CORS preflight, so a browser request to it can never succeed.
 */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface NotifyOptions {
  title: string;
  body?: string;
  /** Milliseconds from now. Omitted or 0 means immediately. */
  inMs?: number;
}

export type Unsubscribe = () => void;

/**
 * A handle on a notification that has been handed to the OS but not yet fired.
 *
 * A number because Android's is one: notification ids there are 32-bit ints,
 * and inventing a richer type here would only be something every shell has to
 * translate back.
 */
export type NotificationId = number;

/**
 * Storage for things too big to belong in `KeyValueStore`: the event log and its
 * snapshots.
 *
 * They are separate because the backings are. `KeyValueStore` is
 * SharedPreferences on Android, which rewrites its whole XML file on every
 * commit and writes it asynchronously, so a process killed at the wrong moment
 * loses the write. That is a fine way to keep a handful of settings and a bad
 * way to keep an append-only log.
 */
export interface FileStore {
  /** Null when the file does not exist, rather than throwing. */
  read(name: string): Promise<string | null>;
  write(name: string, contents: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface Platform {
  http: Http;
  /** Settings, and nothing larger. See `files` for the log. */
  store: KeyValueStore;
  files: FileStore;
  /**
   * Hands a notification to the OS and answers with a handle for cancelling it.
   *
   * The handle matters for the delayed case. A timer stopped early has to take
   * its reminder back, and on Android the alarm outlives the process that
   * scheduled it: without cancellation a cancelled pomodoro still buzzes,
   * possibly from a process that no longer exists.
   */
  notify(opts: NotifyOptions): Promise<NotificationId>;
  /** Cancelling an id that already fired, or was never scheduled, does nothing. */
  cancelNotification(id: NotificationId): Promise<void>;
  /** Fires when the app comes back to the foreground. */
  onResume(cb: () => void): Unsubscribe;
  /**
   * Seconds the user has been idle at the OS level. Desktop only: mobile and
   * browser have no such signal and infer idleness from a wall-clock gap.
   */
  idleSeconds?(): Promise<number>;
}
