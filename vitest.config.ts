import { defineConfig } from 'vitest/config';

// Two projects because they need different environments: core is pure data and
// runs in node, the UI needs a DOM. Without this, one `vitest run` at the root
// would try to run the component tests without jsdom.
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', root: './packages/core', environment: 'node' } },
      './packages/ui/vite.config.ts',
    ],
  },
});
