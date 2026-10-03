// Bundles the stdio server, and everything it imports, into one file.
//
// An installed ToHoot has no checkout and no node_modules, so the server it
// registers with an agent has to be a single module that node can run as it
// is. The release publishes this file as `to-hoot-mcp.mjs`, and the desktop
// app downloads the copy for its own version into its data folder.
//
// Not minified: it is a program somebody's agent runs with their GitHub token
// in its environment, and anyone who wants to read what it does should be able
// to. `@to-hoot/core` resolves through its export map, so core is built first
// (`npm run build -w @to-hoot/core`, or `tsc -b` here, which builds both).

import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(here, 'dist/to-hoot-mcp.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // The entry's own `#!/usr/bin/env node` is kept at the top. Below it, a
  // `require` for any CommonJS dependency that asks for a Node builtin, which
  // an ES module does not have on its own.
  banner: {
    js: "import { createRequire as __toHootCreateRequire } from 'node:module';\nconst require = __toHootCreateRequire(import.meta.url);",
  },
  legalComments: 'inline',
  logLevel: 'info',
});
