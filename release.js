'use strict';

/**
 * One-command release: bump version → build the exe → commit + tag + push →
 * publish a GitHub Release with githubhelper.exe attached.
 *
 *   npm run release            # patch bump (1.0.0 -> 1.0.1)
 *   npm run release minor      # 1.0.0 -> 1.1.0
 *   npm run release major      # 1.0.0 -> 2.0.0
 *   npm run release 1.4.2      # explicit version
 *
 * Requires a clean working tree and an authenticated gh.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const REPO = 'sburson34/GitHubHelper';
const EXE = path.join(ROOT, 'dist', 'githubhelper.exe');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
}
function shOut(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
}
function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// --- 0. Preconditions -------------------------------------------------------
if (shOut('git', ['status', '--porcelain'])) {
  die('Working tree is not clean. Commit or stash your changes before releasing.');
}
try { execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' }); }
catch { die('gh is not authenticated — run `gh auth login` first.'); }

// --- 1. Compute the next version -------------------------------------------
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const cur = pkg.version || '0.0.0';
const arg = (process.argv[2] || 'patch').trim();

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) {
  next = arg;
} else {
  const [maj, min, pat] = cur.split('.').map(Number);
  if (arg === 'major') next = `${maj + 1}.0.0`;
  else if (arg === 'minor') next = `${maj}.${min + 1}.0`;
  else if (arg === 'patch') next = `${maj}.${min}.${pat + 1}`;
  else die(`Unknown version argument "${arg}". Use patch | minor | major | x.y.z`);
}
const tag = `v${next}`;

if (shOut('git', ['tag', '--list', tag])) die(`Tag ${tag} already exists. Pick a higher version.`);

console.log(`\n▶ Releasing ${cur} → ${next}  (tag ${tag})\n`);

// --- 2. Write the new version into package.json + lockfile -----------------
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const lockPath = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

// --- 3. Build the executable ------------------------------------------------
console.log('▶ Building executable…\n');
sh(process.execPath, [path.join(ROOT, 'build.js')]);
if (!fs.existsSync(EXE)) die('Build did not produce dist/githubhelper.exe');

// --- 4. Commit + tag + push -------------------------------------------------
console.log('\n▶ Committing, tagging, pushing…\n');
sh('git', ['add', 'package.json', 'package-lock.json']);
sh('git', ['commit', '-m', `Release ${tag}`]);
sh('git', ['tag', '-a', tag, '-m', `GitHubHelper ${tag}`]);
const branch = shOut('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
sh('git', ['push', 'origin', branch]);
sh('git', ['push', 'origin', tag]);

// --- 5. Publish the GitHub Release ------------------------------------------
const notes = `Standalone Windows executable of the GitHubHelper dashboard — a localhost view of branch status across your local repos and GitHub, with click-through diffs and inline push/merge/delete actions.

## Download & run
1. Download **githubhelper.exe** below.
2. The machine needs **git** and **GitHub CLI (\`gh\`)** installed, and \`gh auth login\` run once.
3. Drop the exe in your projects folder and double-click — it auto-detects the folder, starts the server, and opens your browser. Or run from anywhere: \`githubhelper.exe --root C:\\path\\to\\projects\`.

Flags: \`--root <dir>\`, \`--port <n>\` (default 4317).

No Node, source, or API key required — the exe bundles everything and drives your local git/gh. Windows SmartScreen may warn the first time (unsigned binary): More info → Run anyway.`;

console.log('\n▶ Creating GitHub release…\n');
sh('gh', ['release', 'create', tag, EXE,
  '--repo', REPO,
  '--title', `GitHubHelper ${tag} — standalone dashboard`,
  '--notes', notes,
]);

console.log(`\n✓ Released ${tag} → https://github.com/${REPO}/releases/tag/${tag}\n`);
