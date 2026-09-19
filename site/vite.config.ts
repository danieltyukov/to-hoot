import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/*
 * The site is its own build, outside the npm workspace and with its own
 * lockfile, for the same reason the two shells are: what it needs is one
 * dependency, and it must not be able to pull React or any application code in
 * by accident. A landing page that ships the whole app is slow for nothing.
 *
 * What it does share is `packages/ui/src/tokens.css`, imported by `style.css`.
 * The palette, type scale, radii and motion come from the same file the app
 * reads, so the two cannot drift. The `@font-face` rules come with it, and Vite
 * rebases their relative URLs against the file that declared them, so the site
 * self-hosts the same three subsets without a second copy in the repository.
 */
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  // Relative, not '/to-hoot/'. Every asset URL is then correct wherever the
  // page is served from: a project Pages path, a user Pages root, or a local
  // `vite preview`. The page has no routing, so there is nothing else a base
  // path would be doing.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 0,
    // Two pages: the landing page and the privacy policy the Google sign-in
    // points at. Both share the stylesheet and the theme script.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        privacy: fileURLToPath(new URL('./privacy.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    // tokens.css, the fonts and the screenshots all live above this root. The
    // build resolves them through rollup regardless; this is what lets the dev
    // server serve them too.
    fs: { allow: [repoRoot] },
  },
});
