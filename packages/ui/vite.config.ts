/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

/**
 * Inlines the built Apps Script bundle, which the setup wizard shows for the
 * user to paste into their own Google account.
 *
 * A virtual module rather than an import of the file, because `dist/` is a
 * build artifact and is not committed. A direct import would turn a clean clone
 * into a build failure; this turns it into a wizard that says how to produce
 * the file, which is a thing the user can act on.
 */
function appsScriptSource(): Plugin {
  const id = 'virtual:apps-script-source';
  const resolved = `\0${id}`;
  const bundle = fileURLToPath(new URL('../../apps/apps-script/dist/Code.js', import.meta.url));
  const missing = [
    '// The calendar bridge has not been built in this checkout.',
    '//',
    '// Run this, then reopen the wizard:',
    '//',
    '//   npm run build -w @to-hoot/apps-script',
    '',
  ].join('\n');

  return {
    name: 'to-hoot:apps-script-source',
    resolveId: source => (source === id ? resolved : undefined),
    load(source) {
      if (source !== resolved) return undefined;
      const text = existsSync(bundle) ? readFileSync(bundle, 'utf8') : missing;
      return `export default ${JSON.stringify(text)};`;
    },
  };
}

export default defineConfig({
  plugins: [react(), appsScriptSource()],
  base: './',
  // Core resolves to its source rather than to `dist`, so a checkout runs its
  // tests without a build step first and a change in core shows up here
  // immediately. TypeScript still resolves it through the project reference in
  // tsconfig.json, which is what keeps the published types honest.
  resolve: { alias: { '@to-hoot/core': coreSrc } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { port: 5173, strictPort: true },
  test: {
    name: 'ui',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Only src. The Playwright specs under e2e/ match vitest's default spec
    // glob, and vitest cannot run them.
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
