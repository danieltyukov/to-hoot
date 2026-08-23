/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const coreSrc = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
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
