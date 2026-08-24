import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';
import { VERSION } from './index.js';

describe('core', () => {
  it('exports the version the package claims', () => {
    // Against package.json rather than against a literal. A literal is a test
    // that has to be edited on every release, which makes it a chore rather
    // than a guard; this one catches the thing that actually goes wrong, which
    // is bumping one of the two and forgetting the other.
    const pkg: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    );
    expect(VERSION).toBe((pkg as { version: string }).version);
  });
});
