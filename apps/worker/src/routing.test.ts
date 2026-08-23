import { describe, expect, it } from 'vitest';

import {
  MIN_SECRET_LENGTH,
  allowedHostnames,
  matchesMcpPath,
  mcpPath,
  secretEquals,
  secretProblem,
} from './routing.js';

const SECRET = 'a'.repeat(MIN_SECRET_LENGTH);

describe('mcpPath', () => {
  it('puts the secret in the path, never in the query string', () => {
    expect(mcpPath(SECRET)).toBe(`/mcp/${SECRET}`);
    expect(mcpPath(SECRET)).not.toContain('?');
  });
});

describe('matchesMcpPath', () => {
  it('accepts the exact path', () => {
    expect(matchesMcpPath(`/mcp/${SECRET}`, SECRET)).toBe(true);
  });

  it('accepts one trailing slash, because clients add them', () => {
    expect(matchesMcpPath(`/mcp/${SECRET}/`, SECRET)).toBe(true);
  });

  it('rejects the root, the prefix alone, and a wrong secret', () => {
    expect(matchesMcpPath('/', SECRET)).toBe(false);
    expect(matchesMcpPath('/mcp', SECRET)).toBe(false);
    expect(matchesMcpPath('/mcp/', SECRET)).toBe(false);
    expect(matchesMcpPath(`/mcp/${'b'.repeat(MIN_SECRET_LENGTH)}`, SECRET)).toBe(false);
  });

  it('rejects a longer path that merely starts with the secret', () => {
    expect(matchesMcpPath(`/mcp/${SECRET}/tools`, SECRET)).toBe(false);
  });

  it('rejects a prefix of the secret', () => {
    expect(matchesMcpPath(`/mcp/${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
  });
});

describe('secretProblem', () => {
  it('accepts a long secret from the URL unreserved set', () => {
    expect(secretProblem(SECRET)).toBeNull();
    expect(secretProblem(`${'a'.repeat(29)}._~`)).toBeNull();
  });

  it('refuses a missing or short secret', () => {
    expect(secretProblem('')).toContain('set MCP_PATH_SECRET');
    expect(secretProblem('abc123')).toContain(String(MIN_SECRET_LENGTH));
  });

  it('refuses a character that would break the path it is put in', () => {
    // Each of these passes a length check and then 404s forever, in a way
    // nobody would trace back to the secret.
    for (const bad of ['#', '?', ' ', '/', '%', '+']) {
      const secret = `${'a'.repeat(MIN_SECRET_LENGTH - 1)}${bad}`;
      expect(secretProblem(secret), bad).toContain('letters, digits');
    }
  });
});

describe('secretEquals', () => {
  it('compares every character even when an early one differs', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'xbc')).toBe(false);
    expect(secretEquals('abc', 'abcd')).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});

describe('allowedHostnames', () => {
  it('splits the configured list and drops the blanks', () => {
    expect(allowedHostnames('a.example.com, b.example.com ,,', 'fallback.example.com')).toEqual([
      'a.example.com',
      'b.example.com',
    ]);
  });

  it('falls back to the request host when nothing is configured', () => {
    expect(allowedHostnames(undefined, 'to-hoot.example.workers.dev')).toEqual([
      'to-hoot.example.workers.dev',
    ]);
    expect(allowedHostnames('   ', 'to-hoot.example.workers.dev')).toEqual([
      'to-hoot.example.workers.dev',
    ]);
  });
});
