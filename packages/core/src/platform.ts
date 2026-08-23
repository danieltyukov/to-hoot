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

export interface Platform {
  http: Http;
  store: KeyValueStore;
  notify(opts: NotifyOptions): Promise<void>;
  /** Fires when the app comes back to the foreground. */
  onResume(cb: () => void): Unsubscribe;
  /**
   * Seconds the user has been idle at the OS level. Desktop only: mobile and
   * browser have no such signal and infer idleness from a wall-clock gap.
   */
  idleSeconds?(): Promise<number>;
}
