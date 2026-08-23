import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Separate projects because they need different environments: core, the MCP
// server and the Worker are all data and run in node, the UI needs a DOM.
// Without this, one `vitest run` at the root would try to run the component
// tests without jsdom.

// The two servers import core through its published export map, which points at
// `dist`. Resolving them to source instead is what lets a fresh checkout run
// `npm test` without building core first, and it is the same trick
// `packages/ui/vite.config.ts` uses for the same reason. TypeScript still goes
// through the export map and the project references, which is what keeps the
// published entry points honest.
const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Ordered and anchored: a bare string alias is a prefix replacement, so
// `@to-hoot/core` alone would rewrite `@to-hoot/core/tools` into a path under
// `index.ts`.
const coreAlias = [
  { find: /^@to-hoot\/core\/tools$/, replacement: src('./packages/core/src/tools/index.ts') },
  { find: /^@to-hoot\/core$/, replacement: src('./packages/core/src/index.ts') },
];

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', root: './packages/core', environment: 'node' } },
      {
        resolve: { alias: coreAlias },
        test: { name: 'mcp', root: './apps/mcp', environment: 'node' },
      },
      {
        resolve: { alias: coreAlias },
        test: { name: 'worker', root: './apps/worker', environment: 'node' },
      },
      './packages/ui/vite.config.ts',
    ],
  },
});
