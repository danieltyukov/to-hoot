// Stages the web assets the app actually ships.
//
// `packages/ui/dist` is the application, built by the ui package and shared with
// every shell. It cannot know which shell is loading it, so the platform adapter
// is injected here instead: the built dist is copied to `apps/mobile/dist`, the
// adapter is bundled next to it, and a script tag for it is inserted ahead of
// the app's own module script. `cap sync` then copies the result into the
// Android project, which is why `webDir` points here and not at the ui package.
//
// Order matters. Module scripts run in document order, so the adapter has
// already put `window.__toHootPlatform` in place by the time the app's first
// line executes. `packages/ui` stays free of any Capacitor import.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const repo = resolve(app, '../..');
const uiDist = join(repo, 'packages/ui/dist');
const outDir = join(app, 'dist');
const fresh = process.argv.includes('--fresh');

function buildUi() {
  const r = spawnSync('npm', ['run', 'build', '-w', '@to-hoot/ui'], { cwd: repo, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (fresh || !existsSync(join(uiDist, 'index.html'))) buildUi();
if (!existsSync(join(uiDist, 'index.html'))) {
  console.error(`stage-web: no built ui at ${uiDist}. Run \`npm run build\` at the repo root.`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(uiDist, outDir, { recursive: true });

const esbuild = await import('esbuild');
await esbuild.build({
  entryPoints: [join(app, 'src/platform.ts')],
  outfile: join(outDir, 'platform.js'),
  bundle: true,
  format: 'esm',
  // Android 7 is the floor (minSdk 24), and its WebView is whatever the device
  // updated to; es2020 is the safe target for the oldest still-shipping ones.
  target: 'es2020',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

const indexPath = join(outDir, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const anchor = html.indexOf('<script type="module"');
if (anchor === -1) {
  // Loudly, rather than shipping a build with no platform: a shell whose
  // adapter never loaded looks like an app with no network and no storage.
  console.error('stage-web: no module script found in index.html, cannot place the adapter ahead of it.');
  process.exit(1);
}
const tag = '<script type="module" src="./platform.js"></script>\n    ';
writeFileSync(indexPath, html.slice(0, anchor) + tag + html.slice(anchor));

console.log(`stage-web: ${outDir} (ui built ${statSync(join(uiDist, 'index.html')).mtime.toISOString()})`);
