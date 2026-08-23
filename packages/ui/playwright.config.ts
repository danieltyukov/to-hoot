import { defineConfig, devices } from '@playwright/test';

/*
 * The shell tests run against a real browser because what they check does not
 * exist anywhere else: media queries, layout, scroll width and what survives a
 * reload. jsdom evaluates a stylesheet but has no viewport that responds to one.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: process.env['CI'] === 'true',
  retries: process.env['CI'] === 'true' ? 1 : 0,
  reporter: process.env['CI'] === 'true' ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The preview server, not the dev server: this is the build that ships, and
    // a bundling mistake that only shows up in production is exactly the kind of
    // thing a shell test should be catching.
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: process.env['CI'] !== 'true',
    timeout: 120_000,
  },
});
