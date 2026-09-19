/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

/*
 * The Google OAuth clients, from the one file the Android build reads too, so
 * the scheme the phone registers and the client id the app signs in with
 * cannot drift apart. Set as process env defaults, which is what Vite folds
 * into `import.meta.env`; a VITE_ variable already in the environment, or in a
 * .env file, wins over the file. The Desktop client's secret has no default:
 * it is VITE_GOOGLE_DESKTOP_CLIENT_SECRET from the environment or from .env.
 */
const googleClients = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../google-oauth.json', import.meta.url)), 'utf8'),
) as { desktopClientId?: string; androidClientId?: string };
process.env['VITE_GOOGLE_DESKTOP_CLIENT_ID'] ??= googleClients.desktopClientId ?? '';
process.env['VITE_GOOGLE_ANDROID_CLIENT_ID'] ??= googleClients.androidClientId ?? '';

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
    // Known Google clients under test, whatever google-oauth.json says, so the
    // sign-in tests are the same on a fork with no clients registered.
    env: {
      VITE_GOOGLE_DESKTOP_CLIENT_ID: 'test-desktop.apps.googleusercontent.com',
      VITE_GOOGLE_DESKTOP_CLIENT_SECRET: 'test-desktop-secret',
      VITE_GOOGLE_ANDROID_CLIENT_ID: 'test-android.apps.googleusercontent.com',
    },
  },
});
