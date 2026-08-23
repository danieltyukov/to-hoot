// Where the endpoint lives and who is allowed to ask for it.
//
// Anthropic supports authless remote MCP servers, and an OAuth server for one
// person's task list is a great deal of moving parts to protect one token. What
// stands in for it is an unguessable path: 32 random characters in the path
// SEGMENT, never in the query string, because query strings are what proxies,
// browser histories and access logs record in full.

export const MCP_PREFIX = '/mcp/';

/**
 * 32 characters from a 62-character alphabet is about 190 bits. The check is
 * not decoration: a short "secret" that happens to work locally is exactly what
 * gets deployed and then found by a scanner.
 */
export const MIN_SECRET_LENGTH = 32;

/**
 * The characters a path secret may use: the URL unreserved set.
 *
 * Anything outside it survives configuration and then fails forever at request
 * time in a way nobody would connect to the secret. A `#` truncates the path in
 * the client, a `?` starts a query string (which is exactly where this must
 * never be), a space or a slash re-splits the path, and each of those produces
 * a 404 from an endpoint whose configuration looks correct.
 */
export const SECRET_CHARSET = /^[A-Za-z0-9._~-]+$/;

/** Why this secret cannot be used, or null when it can. */
export function secretProblem(secret: string): string | null {
  if (secret === '') return 'set MCP_PATH_SECRET on this Worker';
  if (secret.length < MIN_SECRET_LENGTH) {
    return `MCP_PATH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  if (!SECRET_CHARSET.test(secret)) {
    return 'MCP_PATH_SECRET must use only letters, digits, dot, dash, underscore or tilde';
  }
  return null;
}

/** The full path an endpoint is reachable at. */
export function mcpPath(secret: string): string {
  return `${MCP_PREFIX}${secret}`;
}

/**
 * A comparison that does not stop at the first difference.
 *
 * Over the public internet a timing side channel on a path segment is not much
 * of a threat, but the alternative costs nothing and removes the question.
 * Length is compared first and separately, which does leak the length; that is
 * unavoidable and is not what the comparison protects.
 */
export function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether this request is for the endpoint. One trailing slash is accepted
 * because clients add them; anything deeper is not, so the secret cannot be
 * used as a prefix for paths nobody wrote.
 */
export function matchesMcpPath(pathname: string, secret: string): boolean {
  if (!pathname.startsWith(MCP_PREFIX)) return false;
  const rest = pathname.slice(MCP_PREFIX.length);
  const trimmed = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  return secretEquals(trimmed, secret);
}

/**
 * The hostnames this deployment answers for.
 *
 * With none configured this falls back to the request's own host, which makes
 * the Host check a no-op: on Cloudflare a request only reaches a Worker over a
 * hostname routed to it, so there is nothing to compare against that the
 * platform has not already checked. The Origin check still does real work with
 * that fallback, and it is the one that matters in a browser: a page on another
 * origin sends its own `Origin` and is refused.
 */
export function allowedHostnames(configured: string | undefined, requestHost: string): string[] {
  const listed = (configured ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
  return listed.length > 0 ? listed : [requestHost];
}
