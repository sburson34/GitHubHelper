'use strict';

/**
 * Build a standalone single-file executable of the GitHubHelper dashboard.
 *
 * Pipeline:
 *   1. Read the web assets (public/*) into a map.
 *   2. esbuild bundles server.js + Express + the asset map into one CJS file.
 *   3. Node's SEA tooling turns that bundle into a blob and injects it into a
 *      copy of the current node executable (via postject).
 *
 * Output: dist/githubhelper.exe  (Windows) — no Node, no source, no deps
 * required on the target machine; only `git` and an authenticated `gh`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(DIST, 'githubhelper-bundle.cjs');
const BLOB = path.join(DIST, 'sea-prep.blob');
const SEA_CONFIG = path.join(DIST, 'sea-config.json');
const isWin = process.platform === 'win32';
const EXE = path.join(DIST, isWin ? 'githubhelper.exe' : 'githubhelper');
// Standard SEA fuse sentinel from the Node.js docs.
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. Web assets -> embedded map.
const publicDir = path.join(ROOT, 'public');
const assets = {};
for (const f of fs.readdirSync(publicDir)) {
  assets[f] = fs.readFileSync(path.join(publicDir, f), 'utf8');
}
console.log(`Embedding ${Object.keys(assets).length} web asset(s): ${Object.keys(assets).join(', ')}`);

// 2. Bundle. The banner defines the global the server reads for embedded assets.
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'server.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: BUNDLE,
  legalComments: 'none',
  banner: { js: `globalThis.__EMBEDDED_ASSETS__ = ${JSON.stringify(assets)};` },
});
console.log('Bundled  ->', path.relative(ROOT, BUNDLE));

// 3. SEA config + blob.
fs.writeFileSync(
  SEA_CONFIG,
  JSON.stringify({ main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true }, null, 2),
);
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { stdio: 'inherit' });

// 4. Copy the node binary and inject the blob.
fs.copyFileSync(process.execPath, EXE);

let postjectCli;
try {
  postjectCli = require.resolve('postject/dist/cli.js');
} catch {
  postjectCli = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
}
execFileSync(
  process.execPath,
  [postjectCli, EXE, 'NODE_SEA_BLOB', BLOB, '--sentinel-fuse', FUSE],
  { stdio: 'inherit' },
);

const sizeMb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ Built ${path.relative(ROOT, EXE)} (${sizeMb} MB)`);
console.log('  Copy it to any machine that has git + authenticated gh, then run it.');
console.log('  Tip: place it in your projects folder (or pass --root <dir>) and double-click.\n');
