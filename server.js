'use strict';

/**
 * GitHubHelper — a localhost dashboard that gives a complete picture of the
 * status of every code change across all local + GitHub projects.
 *
 * The heavy git/gh work runs on demand, per selected project, so the dashboard
 * stays snappy and only ever does work for the project you are looking at.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const sessions = require('./sessions');
const resolve = require('./resolve');

// Detect whether we are running as a packaged single-executable (.exe).
let IS_PACKAGED = false;
try { IS_PACKAGED = require('node:sea').isSea(); } catch { /* not a SEA build */ }

// Web assets are baked into the bundle at build time (see build.js, which
// injects __EMBEDDED_ASSETS__ via esbuild). In dev they are served from disk.
const EMBEDDED_ASSETS = typeof __EMBEDDED_ASSETS__ !== 'undefined' ? __EMBEDDED_ASSETS__ : null;

// --- CLI args / config ------------------------------------------------------
function argValue(name) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('-')) return process.argv[i + 1];
  return null;
}

// An explicitly chosen port is honored as-is; the default may auto-fall-back to
// the next free port if it is busy (see listenWithFallback).
const PORT_EXPLICIT = argValue('port') != null || process.env.PORT != null;
const PORT = Number(argValue('port') || process.env.PORT || 4317);

// The folder that holds your project repos. Resolution order:
//   1. --root <dir> / PROJECTS_ROOT env
//   2. the current directory, if it directly contains git repos
//      (drop the .exe in your projects folder and run it)
//   3. the parent of the current directory, if that contains git repos
//      (running `node server.js` from inside this repo)
//   4. the current directory
function hasRepoChild(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git')));
  } catch { return false; }
}
function detectProjectsRoot() {
  const explicit = argValue('root') || process.env.PROJECTS_ROOT;
  if (explicit) return path.resolve(explicit);
  const cwd = process.cwd();
  if (hasRepoChild(cwd)) return cwd;
  const parent = path.dirname(cwd);
  if (hasRepoChild(parent)) return parent;
  return cwd;
}
const PROJECTS_ROOT = detectProjectsRoot();

const app = express();
app.use(express.json());

// Static assets: embedded map when packaged, disk in dev.
if (EMBEDDED_ASSETS) {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  app.get(['/', '/index.html', '/app.js', '/styles.css'], (req, res) => {
    const name = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
    const body = EMBEDDED_ASSETS[name];
    if (body == null) return res.status(404).end();
    res.type(TYPES[path.extname(name)] || 'text/plain').send(body);
  });
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

// ---------------------------------------------------------------------------
// Read-only mode (one-way gate: GitHub/git -> app, never the other way)
// ---------------------------------------------------------------------------
// When on, the dashboard only reads and reports — every command that would
// change local git state or GitHub is refused. Defaults ON for safety and is
// reset to ON on every restart; it is toggled at runtime from the UI.
let readOnly = true;

// Decide whether a (cmd, args) invocation would change anything. Reads (status,
// log, diff, rev-list, for-each-ref, gh api GET, gh *list, …) return false;
// writes (push, merge, checkout, branch -d, gh pr merge, gh api -X DELETE, …)
// return true. Conservative: anything not recognized as a read is treated as a
// read only when it clearly cannot mutate, otherwise as a write.
function isMutatingCommand(cmd, args) {
  const a = args.map(String);
  if (cmd === 'git') {
    const sub = a[0] === '-C' ? a[2] : a[0];
    // `fetch` is deliberately NOT here: it only updates remote-tracking refs
    // (GitHub → your local refs) and never changes a branch you work on, so it
    // is one-way-safe and stays allowed even in read-only mode. `pull` (fetch +
    // merge into your checkout) does change your work, so it remains a write.
    const WRITE = new Set([
      'push', 'merge', 'commit', 'rebase', 'reset', 'pull', 'clone',
      'checkout', 'switch', 'cherry-pick', 'revert', 'am', 'apply', 'clean',
      'gc', 'prune', 'update-ref', 'mv', 'rm', 'add', 'restore', 'notes',
    ]);
    if (sub === 'stash') {
      // list/show read; push/pop/apply/drop/clear/create/store (and bare `stash`) write.
      const rest = a[0] === '-C' ? a.slice(3) : a.slice(1);
      return !['list', 'show'].includes(rest[0]);
    }
    if (WRITE.has(sub)) return true;
    if (sub === 'branch')
      return a.some((x) => ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description'].includes(x));
    if (sub === 'tag') return !a.includes('-l') && !a.includes('--list'); // bare/`-a` creates; `-l` lists
    if (sub === 'remote') return a.some((x) => ['add', 'remove', 'rm', 'set-url', 'rename', 'prune', 'set-head'].includes(x));
    if (sub === 'config') return !a.some((x) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(x));
    if (sub === 'symbolic-ref') return !a.includes('--quiet') && a.length > (a[0] === '-C' ? 4 : 2); // setting a ref takes a value
    return false; // rev-parse, status, log, diff, rev-list, for-each-ref, show, describe, …
  }
  if (cmd === 'gh') {
    const sub = a[0];
    if (sub === 'api') {
      const i = a.findIndex((x) => x === '-X' || x === '--method');
      if (i !== -1 && a[i + 1] && a[i + 1].toUpperCase() !== 'GET') return true;
      // -f/--field/-F/--raw-field/--input make gh default to POST.
      return a.some((x) => ['-f', '--field', '-F', '--raw-field', '--input'].includes(x));
    }
    // <noun> <verb> form: treat known mutating verbs as writes.
    const MUT_VERBS = new Set([
      'create', 'delete', 'merge', 'close', 'edit', 'rename', 'transfer', 'fork',
      'add', 'remove', 'set', 'set-default', 'sync', 'restore', 'ready', 'reopen',
      'comment', 'review', 'lock', 'unlock', 'pin', 'unpin', 'archive', 'clone',
      'checkout', 'rerun', 'cancel', 'disable', 'enable', 'approve',
    ]);
    return a.length >= 2 && MUT_VERBS.has(a[1]);
  }
  return false;
}

// Express guard for the mutating HTTP routes (push/merge/delete-branch).
function denyWhenReadOnly(req, res, next) {
  if (readOnly) {
    return res.status(403).json({
      ok: false,
      readOnly: true,
      error: 'Read-only mode is ON — the dashboard will not make any changes to git or GitHub. Turn off read-only to allow this action.',
    });
  }
  next();
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Run a binary with args, never throwing — returns {ok, stdout, stderr, code}. */
function run(cmd, args, opts = {}) {
  // One-way gate: in read-only mode, refuse to execute anything that mutates.
  if (readOnly && isMutatingCommand(cmd, args)) {
    return Promise.resolve({
      ok: false,
      code: 1,
      stdout: '',
      stderr: 'Blocked: read-only mode is on — no changes are made.',
      blockedByReadOnly: true,
    });
  }
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, maxBuffer: 1024 * 1024 * 32, ...opts },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (err.code ?? 1) : 0,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        });
      },
    );
  });
}

const git = (cwd, ...args) => run('git', ['-C', cwd, ...args]);

/** Run `gh` and parse JSON output; returns null on failure. */
async function ghJson(args) {
  const res = await run('gh', args);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.stdout || 'null');
  } catch {
    return null;
  }
}

/** Run async fn over items with a concurrency cap. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

function parseRemote(url) {
  if (!url) return null;
  const m = url
    .trim()
    .replace(/\.git$/, '')
    .match(/github\.com[/:]([^/]+)\/(.+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], key: `${m[1]}/${m[2]}`.toLowerCase() };
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

async function localRepoInfo(dir) {
  const remoteRes = await git(dir, 'remote', 'get-url', 'origin');
  const remote = remoteRes.ok ? parseRemote(remoteRes.stdout) : null;
  return { name: path.basename(dir), path: dir, remote };
}

let projectCache = { ts: 0, data: null };
const CACHE_MS = 30 * 1000;

async function listProjects() {
  if (projectCache.data && Date.now() - projectCache.ts < CACHE_MS) {
    return projectCache.data;
  }

  // Local git repos under PROJECTS_ROOT (one level deep).
  const entries = fs.existsSync(PROJECTS_ROOT)
    ? fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    : [];
  const localDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(PROJECTS_ROOT, e.name))
    .filter(isGitRepo);

  const locals = await mapLimit(localDirs, 8, localRepoInfo);

  // GitHub repos for the authenticated user.
  let me = null;
  const meRes = await run('gh', ['api', 'user', '--jq', '.login']);
  if (meRes.ok) me = meRes.stdout.trim();

  let ghRepos = [];
  if (me) {
    ghRepos =
      (await ghJson([
        'repo',
        'list',
        me,
        '--limit',
        '200',
        '--json',
        'name,nameWithOwner,defaultBranchRef,pushedAt,isPrivate,description',
      ])) || [];
  }

  const claimedRemotes = new Set(locals.filter((l) => l.remote).map((l) => l.remote.key));

  const projects = [];

  for (const l of locals) {
    projects.push({
      id: `local:${l.name}`,
      label: l.name,
      type: 'local',
      hasLocal: true,
      hasRemote: !!l.remote,
      path: l.path,
      owner: l.remote ? l.remote.owner : null,
      repo: l.remote ? l.remote.repo : null,
      nameWithOwner: l.remote ? l.remote.key : null,
    });
  }

  // GitHub repos not already represented by a local checkout.
  for (const r of ghRepos) {
    const key = r.nameWithOwner.toLowerCase();
    if (claimedRemotes.has(key)) continue;
    const [owner, repo] = r.nameWithOwner.split('/');
    projects.push({
      id: `remote:${r.nameWithOwner}`,
      label: r.name,
      type: 'remote-only',
      hasLocal: false,
      hasRemote: true,
      path: null,
      owner,
      repo,
      nameWithOwner: r.nameWithOwner,
      defaultBranch: r.defaultBranchRef ? r.defaultBranchRef.name : null,
      pushedAt: r.pushedAt,
      isPrivate: r.isPrivate,
      description: r.description || '',
    });
  }

  projects.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  projectCache = { ts: Date.now(), data: projects };
  return projects;
}

// ---------------------------------------------------------------------------
// Local status
// ---------------------------------------------------------------------------

function parseTrack(track) {
  // %(upstream:track) looks like "[ahead 2, behind 1]" / "[ahead 2]" / "" / "[gone]"
  const out = { ahead: 0, behind: 0, gone: false };
  if (!track) return out;
  if (track.includes('gone')) out.gone = true;
  const a = track.match(/ahead (\d+)/);
  const b = track.match(/behind (\d+)/);
  if (a) out.ahead = +a[1];
  if (b) out.behind = +b[1];
  return out;
}

async function detectDefaultBranch(dir) {
  // Try origin/HEAD, then common names, then current branch.
  const head = await git(dir, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  if (head.ok) {
    const m = head.stdout.trim().match(/origin\/(.+)$/);
    if (m) return m[1];
  }
  for (const cand of ['main', 'master']) {
    const r = await git(dir, 'rev-parse', '--verify', cand);
    if (r.ok) return cand;
  }
  const cur = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  return cur.ok ? cur.stdout.trim() : 'main';
}

function describeChange(commitSubjects, stat) {
  const parts = [];
  if (stat && (stat.files || stat.insertions || stat.deletions)) {
    const bits = [];
    if (stat.files) bits.push(`${stat.files} file${stat.files === 1 ? '' : 's'}`);
    if (stat.insertions) bits.push(`+${stat.insertions}`);
    if (stat.deletions) bits.push(`-${stat.deletions}`);
    parts.push(bits.join(' '));
  }
  if (commitSubjects.length) {
    const top = commitSubjects.slice(0, 3).join(' · ');
    parts.push(top + (commitSubjects.length > 3 ? ` …(+${commitSubjects.length - 3} more)` : ''));
  }
  return parts.join(' — ') || 'No changes relative to the default branch.';
}

function parseShortstat(text) {
  const out = { files: 0, insertions: 0, deletions: 0 };
  const f = text.match(/(\d+) files? changed/);
  const i = text.match(/(\d+) insertions?/);
  const d = text.match(/(\d+) deletions?/);
  if (f) out.files = +f[1];
  if (i) out.insertions = +i[1];
  if (d) out.deletions = +d[1];
  return out;
}

function recommendLocalBranch(b, ctx) {
  const { isDefault, uncommittedCount } = ctx;
  if (isDefault) {
    if (uncommittedCount > 0)
      return { level: 'action', text: `You have ${uncommittedCount} uncommitted change(s) on the default branch. Commit or stash them.` };
    if (!b.hasUpstream) return { level: 'action', text: 'Default branch has no upstream — push it to origin.' };
    if (b.ahead > 0) return { level: 'action', text: `Push ${b.ahead} unpushed commit(s) to origin.` };
    if (b.behind > 0) return { level: 'info', text: `Behind origin by ${b.behind} — pull to update.` };
    return { level: 'ok', text: 'Up to date with origin.' };
  }
  if (b.merged) {
    if (!b.hasUpstream || b.ahead === 0)
      return { level: 'cleanup', text: 'Merged into the default branch — safe to delete this branch.' };
  }
  if (!b.hasUpstream) {
    const hasWork = b.aheadOfDefault > 0;
    return {
      level: 'action',
      text: hasWork
        ? `${b.aheadOfDefault} commit(s) ahead of default and never pushed — push and open a PR.`
        : 'Branch has no upstream — push it when you have work to share.',
    };
  }
  if (b.gone) return { level: 'cleanup', text: 'Upstream branch is gone (deleted on remote) — delete this local branch.' };
  if (b.ahead > 0) return { level: 'action', text: `Push ${b.ahead} unpushed commit(s), then open/update a PR.` };
  if (b.aheadOfDefault > 0)
    return { level: 'action', text: `Pushed and ${b.aheadOfDefault} commit(s) ahead of default — open a PR if you have not.` };
  if (b.behindDefault > 0)
    return { level: 'info', text: `Behind default by ${b.behindDefault} — rebase/merge in the latest default branch.` };
  return { level: 'ok', text: 'Pushed and in sync.' };
}

async function localStatus(dir) {
  const defaultBranch = await detectDefaultBranch(dir);
  const curRes = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const currentBranch = curRes.ok ? curRes.stdout.trim() : null;

  // Working tree state.
  const statusRes = await git(dir, 'status', '--porcelain');
  const dirtyLines = statusRes.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
  const stashRes = await git(dir, 'stash', 'list');
  const workingTree = {
    clean: dirtyLines.length === 0,
    count: dirtyLines.length,
    staged: dirtyLines.filter((l) => l[0] !== ' ' && l[0] !== '?').length,
    unstaged: dirtyLines.filter((l) => l[1] !== ' ' && l[1] !== '?').length,
    untracked: dirtyLines.filter((l) => l.startsWith('??')).length,
    stashCount: stashRes.stdout.split('\n').filter(Boolean).length,
    files: dirtyLines.slice(0, 50).map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3) })),
  };

  // All local branches with upstream tracking + last commit, in one call.
  const SEP = '<<GHSEP>>';
  const fmt = ['%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)', '%(committerdate:iso8601)', '%(authorname)', '%(contents:subject)'].join(SEP);
  const refRes = await git(dir, 'for-each-ref', `--format=${fmt}`, 'refs/heads');

  // Branches merged into default.
  const mergedRes = await git(dir, 'branch', '--merged', defaultBranch, '--format=%(refname:short)');
  const mergedSet = new Set(mergedRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean));

  const rawBranches = refRes.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);

  const branches = await mapLimit(rawBranches, 6, async (line) => {
    const [name, upstream, track, sha, date, author, subject] = line.split(SEP);
    const t = parseTrack(track);
    const isDefault = name === defaultBranch;

    // Ahead/behind vs default branch (the unique work on this branch).
    let aheadOfDefault = 0;
    let behindDefault = 0;
    if (!isDefault) {
      const rl = await git(dir, 'rev-list', '--left-right', '--count', `${defaultBranch}...${name}`);
      if (rl.ok) {
        const [bd, ad] = rl.stdout.trim().split(/\s+/).map(Number);
        behindDefault = bd || 0;
        aheadOfDefault = ad || 0;
      }
    }

    // Description of the change vs default.
    let commitSubjects = [];
    let stat = null;
    let conflictsWithDefault = null; // true/false once known; null = not checked / unknown
    if (!isDefault && aheadOfDefault > 0) {
      const logRes = await git(dir, 'log', `${defaultBranch}..${name}`, '--format=%s', '-n', '20');
      commitSubjects = logRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const statRes = await git(dir, 'diff', '--shortstat', `${defaultBranch}...${name}`);
      stat = parseShortstat(statRes.stdout);
      // Dry-run the merge into default without touching the working tree.
      // Exit 0 = clean, 1 = conflicts; anything else (e.g. old git) = unknown.
      const mt = await git(dir, 'merge-tree', '--write-tree', '--name-only', defaultBranch, name);
      if (mt.code === 0) conflictsWithDefault = false;
      else if (mt.code === 1) conflictsWithDefault = true;
    }

    const b = {
      name,
      isCurrent: name === currentBranch,
      isDefault,
      hasUpstream: !!upstream,
      upstream: upstream || null,
      ahead: t.ahead,
      behind: t.behind,
      gone: t.gone,
      merged: mergedSet.has(name) && !isDefault,
      aheadOfDefault,
      behindDefault,
      conflictsWithDefault,
      lastCommit: { sha, date, author, subject },
      description: isDefault ? 'Default branch.' : describeChange(commitSubjects, stat),
      stat,
    };
    b.recommendation = recommendLocalBranch(b, {
      isDefault,
      uncommittedCount: b.isCurrent ? workingTree.count : 0,
    });
    return b;
  });

  // Default branch first, then current, then by last commit date desc.
  branches.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return (b.lastCommit.date || '').localeCompare(a.lastCommit.date || '');
  });

  let note = null;
  if (branches.length === 0) {
    note = `No commits yet — the repository was initialized but nothing has been committed${
      workingTree.count ? ` (${workingTree.count} untracked/uncommitted file(s) present)` : ''
    }. Make an initial commit to start tracking work.`;
  }

  return { defaultBranch, currentBranch, workingTree, branches, note };
}

// ---------------------------------------------------------------------------
// Remote (GitHub) status
// ---------------------------------------------------------------------------

// Collapse a PR's statusCheckRollup (a mix of GitHub Actions CheckRuns and
// legacy StatusContexts) into one overall CI state.
function rollupChecks(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0)
    return { state: 'none', total: 0, failing: 0, pending: 0, passing: 0 };
  let failing = 0, pending = 0, passing = 0;
  for (const c of rollup) {
    if (c.status || c.conclusion) {
      // CheckRun: status QUEUED|IN_PROGRESS|COMPLETED, conclusion SUCCESS|FAILURE|…
      const status = String(c.status || '').toUpperCase();
      const concl = String(c.conclusion || '').toUpperCase();
      if (status && status !== 'COMPLETED') pending++;
      else if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl)) failing++;
      else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(concl)) passing++;
      else pending++;
    } else {
      // StatusContext: state SUCCESS|FAILURE|ERROR|PENDING|EXPECTED
      const state = String(c.state || '').toUpperCase();
      if (['FAILURE', 'ERROR'].includes(state)) failing++;
      else if (state === 'SUCCESS') passing++;
      else pending++;
    }
  }
  const state = failing > 0 ? 'failure' : pending > 0 ? 'pending' : passing > 0 ? 'success' : 'none';
  return { state, total: rollup.length, failing, pending, passing };
}

function recommendRemoteBranch(b, pr, defaultBranch) {
  if (b.name === defaultBranch) return { level: 'ok', text: 'Default branch on GitHub.' };
  if (pr) {
    const checks = b.checks;
    if (pr.isDraft) return { level: 'info', text: `Draft PR #${pr.number} open — mark ready when finished.` };
    if (checks && checks.state === 'failure')
      return { level: 'action', text: `PR #${pr.number} — CI failing (${checks.failing} of ${checks.total} check(s)); fix before merging.` };
    if (pr.reviewDecision === 'CHANGES_REQUESTED')
      return { level: 'action', text: `PR #${pr.number} has changes requested — address review feedback.` };
    if (b.mergeable === 'CONFLICTING')
      return { level: 'action', text: `PR #${pr.number} has merge conflicts — resolve them before it can be merged.` };
    if (pr.reviewDecision === 'APPROVED') {
      if (checks && checks.state === 'pending')
        return { level: 'info', text: `PR #${pr.number} approved — waiting on CI to finish.` };
      return { level: 'action', text: `PR #${pr.number} is approved${checks && checks.state === 'success' ? ' & CI is green' : ''} — merge it.` };
    }
    if (checks && checks.state === 'pending')
      return { level: 'info', text: `PR #${pr.number} open — CI running; get it reviewed.` };
    return { level: 'action', text: `PR #${pr.number} open — get it reviewed & merged.` };
  }
  if (b.aheadBy > 0)
    return { level: 'action', text: `${b.aheadBy} commit(s) ahead of ${defaultBranch} with no PR — open one.` };
  if (b.behindBy > 0 && b.aheadBy === 0)
    return { level: 'cleanup', text: `Fully merged / behind ${defaultBranch} with no unique commits — delete this remote branch.` };
  return { level: 'info', text: 'No open PR.' };
}

async function remoteStatus(owner, repo) {
  const nwo = `${owner}/${repo}`;

  const repoInfo = await ghJson(['api', `repos/${nwo}`]);
  if (!repoInfo) return { error: `Could not read GitHub repo ${nwo}.` };
  const defaultBranch = repoInfo.default_branch;

  const branchList =
    (await ghJson(['api', `repos/${nwo}/branches`, '--paginate'])) || [];

  const prs =
    (await ghJson([
      'pr',
      'list',
      '--repo',
      nwo,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,headRefName,baseRefName,url,isDraft,reviewDecision,createdAt,additions,deletions,changedFiles,mergeable,statusCheckRollup',
    ])) || [];
  const prByHead = new Map(prs.map((p) => [p.headRefName, p]));

  const branches = await mapLimit(branchList, 5, async (br) => {
    const name = br.name;
    const isDefault = name === defaultBranch;
    let aheadBy = 0;
    let behindBy = 0;
    let subjects = [];
    let stat = null;
    let lastCommit = { sha: br.commit ? br.commit.sha.slice(0, 7) : '', date: '', author: '', subject: '' };

    if (!isDefault) {
      const cmp = await ghJson(['api', `repos/${nwo}/compare/${defaultBranch}...${name}`]);
      if (cmp) {
        aheadBy = cmp.ahead_by || 0;
        behindBy = cmp.behind_by || 0;
        const commits = cmp.commits || [];
        subjects = commits.slice(-20).map((c) => (c.commit.message || '').split('\n')[0]).reverse();
        stat = {
          files: (cmp.files || []).length,
          insertions: (cmp.files || []).reduce((s, f) => s + (f.additions || 0), 0),
          deletions: (cmp.files || []).reduce((s, f) => s + (f.deletions || 0), 0),
        };
        const lc = commits[commits.length - 1];
        if (lc)
          lastCommit = {
            sha: lc.sha.slice(0, 7),
            date: lc.commit.author ? lc.commit.author.date : '',
            author: lc.commit.author ? lc.commit.author.name : '',
            subject: (lc.commit.message || '').split('\n')[0],
          };
      }
    } else {
      const c = await ghJson(['api', `repos/${nwo}/commits/${defaultBranch}`]);
      if (c)
        lastCommit = {
          sha: c.sha.slice(0, 7),
          date: c.commit.author ? c.commit.author.date : '',
          author: c.commit.author ? c.commit.author.name : '',
          subject: (c.commit.message || '').split('\n')[0],
        };
    }

    const pr = prByHead.get(name) || null;
    const checks = pr ? rollupChecks(pr.statusCheckRollup) : null;
    const b = {
      name,
      isDefault,
      protected: !!br.protected,
      aheadBy,
      behindBy,
      lastCommit,
      checks,
      mergeable: pr ? pr.mergeable : null,
      pr: pr
        ? {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            isDraft: pr.isDraft,
            reviewDecision: pr.reviewDecision,
            base: pr.baseRefName,
            checks,
            mergeable: pr.mergeable,
          }
        : null,
      description: isDefault ? 'Default branch.' : describeChange(subjects, stat),
      stat,
    };
    b.recommendation = recommendRemoteBranch(b, pr, defaultBranch);
    return b;
  });

  branches.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return (b.lastCommit.date || '').localeCompare(a.lastCommit.date || '');
  });

  return {
    nameWithOwner: nwo,
    defaultBranch,
    isPrivate: repoInfo.private,
    url: repoInfo.html_url,
    pushedAt: repoInfo.pushed_at,
    openPRs: prs.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      headRefName: p.headRefName,
      baseRefName: p.baseRefName,
      isDraft: p.isDraft,
      reviewDecision: p.reviewDecision,
      createdAt: p.createdAt,
      additions: p.additions,
      deletions: p.deletions,
      changedFiles: p.changedFiles,
      mergeable: p.mergeable,
      checks: rollupChecks(p.statusCheckRollup),
    })),
    branches,
  };
}

// ---------------------------------------------------------------------------
// Branch detail (files changed + diffs + commits)
// ---------------------------------------------------------------------------

const US = String.fromCharCode(31); // unit separator
const RS = String.fromCharCode(30); // record separator

// Reject anything that could be a flag or shell/path trickery. Git branch
// names allow letters, digits, and ._/- ; we forbid a leading dash.
function isSafeRef(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 256 && !name.startsWith('-') && /^[A-Za-z0-9._/-]+$/.test(name);
}

// A safe single path segment / repo name (no slashes, no traversal).
function isSafeName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 256 && name !== '.' && name !== '..' && /^[A-Za-z0-9._-]+$/.test(name);
}

function isPrNumber(n) {
  return Number.isInteger(n) && n > 0 && n < 10000000;
}

const PATCH_CAP = 800; // max patch lines returned per file

function capPatch(patch) {
  if (!patch) return { patch: '', truncated: false };
  const lines = patch.split('\n');
  if (lines.length <= PATCH_CAP) return { patch, truncated: false };
  return { patch: lines.slice(0, PATCH_CAP).join('\n'), truncated: true };
}

async function localBranchDetail(dir, defaultBranch, name) {
  const range = `${defaultBranch}...${name}`;

  // Commits unique to this branch.
  const logRes = await git(dir, 'log', range, `--format=%H${US}%s${US}%an${US}%aI${US}%b${RS}`, '-n', '100');
  const commits = logRes.stdout
    .split(RS)
    .map((r) => r.replace(/^\n/, '').trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, subject, author, date, body] = rec.split(US);
      return { sha: (sha || '').slice(0, 7), subject, author, date, body: (body || '').trim() };
    });

  // File list with status + numstat.
  const nameStatus = await git(dir, 'diff', '--name-status', '-M', range);
  const numstat = await git(dir, 'diff', '--numstat', range);
  const stats = {};
  for (const line of numstat.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)) {
    const [add, del, ...rest] = line.split('\t');
    stats[rest.join('\t')] = { additions: add === '-' ? null : +add, deletions: del === '-' ? null : +del };
  }

  const files = [];
  for (const line of nameStatus.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)) {
    const parts = line.split('\t');
    const code = parts[0];
    const file = parts[parts.length - 1];
    const st = stats[file] || { additions: null, deletions: null };
    files.push({ file, status: code[0], additions: st.additions, deletions: st.deletions });
  }

  // Patches per file (capped count + size).
  const withPatch = await mapLimit(files.slice(0, 80), 6, async (f) => {
    const dres = await git(dir, 'diff', '-M', range, '--', f.file);
    const { patch, truncated } = capPatch(dres.stdout);
    return { ...f, patch, truncated };
  });
  for (let i = withPatch.length; i < files.length; i++) withPatch.push({ ...files[i], patch: '', truncated: false, omitted: true });

  return { scope: 'local', name, defaultBranch, commits, files: withPatch };
}

async function remoteBranchDetail(owner, repo, name) {
  const nwo = `${owner}/${repo}`;
  const repoInfo = await ghJson(['api', `repos/${nwo}`]);
  if (!repoInfo) return { error: `Could not read GitHub repo ${nwo}.` };
  const defaultBranch = repoInfo.default_branch;

  // If this branch has an open PR, show the PR's own diff — that is the change
  // under review, independent of how far the default branch has moved since.
  const prs = await ghJson(['pr', 'list', '--repo', nwo, '--head', name, '--state', 'open', '--json', 'number,baseRefName']);
  if (prs && prs.length) {
    const num = prs[0].number;
    const prFiles = (await ghJson(['api', `repos/${nwo}/pulls/${num}/files`, '--paginate'])) || [];
    const prCommits = (await ghJson(['api', `repos/${nwo}/pulls/${num}/commits`, '--paginate'])) || [];
    const commits = prCommits
      .slice()
      .reverse()
      .map((c) => ({
        sha: c.sha.slice(0, 7),
        subject: (c.commit.message || '').split('\n')[0],
        body: (c.commit.message || '').split('\n').slice(1).join('\n').trim(),
        author: c.commit.author ? c.commit.author.name : '',
        date: c.commit.author ? c.commit.author.date : '',
      }));
    const files = prFiles.map((f) => {
      const { patch, truncated } = capPatch(f.patch || '');
      return {
        file: f.filename,
        status: (f.status || 'M')[0].toUpperCase(),
        additions: f.additions,
        deletions: f.deletions,
        patch,
        truncated,
        omitted: !f.patch && f.status !== 'removed',
      };
    });
    return { scope: 'remote', name, defaultBranch, prNumber: num, base: prs[0].baseRefName, commits, files };
  }

  const cmp = await ghJson(['api', `repos/${nwo}/compare/${defaultBranch}...${name}`]);
  if (!cmp) return { error: `Could not compare ${defaultBranch}...${name} (the branch may have been deleted or lives on a fork).` };

  const commits = (cmp.commits || [])
    .slice()
    .reverse()
    .map((c) => ({
      sha: c.sha.slice(0, 7),
      subject: (c.commit.message || '').split('\n')[0],
      body: (c.commit.message || '').split('\n').slice(1).join('\n').trim(),
      author: c.commit.author ? c.commit.author.name : '',
      date: c.commit.author ? c.commit.author.date : '',
    }));

  const files = (cmp.files || []).map((f) => {
    const { patch, truncated } = capPatch(f.patch || '');
    return {
      file: f.filename,
      status: (f.status || 'M')[0].toUpperCase(),
      additions: f.additions,
      deletions: f.deletions,
      patch,
      truncated,
      omitted: !f.patch && f.status !== 'removed',
    };
  });

  return { scope: 'remote', name, defaultBranch, commits, files };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function getProject(id) {
  const projects = await listProjects();
  return projects.find((p) => p.id === id) || null;
}

app.get('/api/projects', async (req, res) => {
  try {
    const projects = await listProjects();
    res.json({ projects, root: PROJECTS_ROOT, readOnly });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const projects = await listProjects();
    const project = projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const out = { project };

    if (project.hasLocal && project.path) {
      out.local = await localStatus(project.path);
    }
    if (project.hasRemote && project.owner && project.repo) {
      out.remote = await remoteStatus(project.owner, project.repo);
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e), stack: e.stack });
  }
});

// Branch detail: files changed, per-file diff, and commit list.
app.get('/api/projects/:id/branch', async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { scope, name } = req.query;
    if (!isSafeRef(name)) return res.status(400).json({ error: 'Invalid branch name' });

    if (scope === 'local') {
      if (!project.hasLocal) return res.status(400).json({ error: 'No local checkout' });
      const def = await detectDefaultBranch(project.path);
      return res.json(await localBranchDetail(project.path, def, name));
    }
    if (scope === 'remote') {
      if (!project.hasRemote) return res.status(400).json({ error: 'No remote' });
      return res.json(await remoteBranchDetail(project.owner, project.repo, name));
    }
    res.status(400).json({ error: 'Unknown scope' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Push a local branch to origin (sets upstream).
app.post('/api/projects/:id/push', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasLocal) return res.status(400).json({ error: 'No local checkout' });
    const { branch } = req.body || {};
    if (!isSafeRef(branch)) return res.status(400).json({ error: 'Invalid branch name' });
    const verify = await git(project.path, 'rev-parse', '--verify', `refs/heads/${branch}`);
    if (!verify.ok) return res.status(400).json({ error: `Local branch ${branch} not found` });

    const r = await git(project.path, 'push', '-u', 'origin', branch);
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Push failed', output });
    res.json({ ok: true, output: output || `Pushed ${branch} to origin.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Merge: local => merge branch into default (clean tree required);
//        remote => merge the branch's open PR via gh.
app.post('/api/projects/:id/merge', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { branch, scope } = req.body || {};
    if (!isSafeRef(branch)) return res.status(400).json({ error: 'Invalid branch name' });

    if (scope === 'remote') {
      if (!project.hasRemote) return res.status(400).json({ error: 'No remote' });
      const nwo = `${project.owner}/${project.repo}`;
      const prs = await ghJson(['pr', 'list', '--repo', nwo, '--state', 'open', '--head', branch, '--json', 'number']);
      if (!prs || !prs.length) return res.status(400).json({ error: `No open PR found for ${branch}.` });
      const num = prs[0].number;
      const r = await run('gh', ['pr', 'merge', String(num), '--repo', nwo, '--merge']);
      const output = (r.stdout + '\n' + r.stderr).trim();
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Merge failed', output });
      return res.json({ ok: true, output: output || `Merged PR #${num}.` });
    }

    // local merge into default
    if (!project.hasLocal) return res.status(400).json({ error: 'No local checkout' });
    const dir = project.path;
    const def = await detectDefaultBranch(dir);
    if (branch === def) return res.status(400).json({ error: 'Cannot merge the default branch into itself' });
    const status = await git(dir, 'status', '--porcelain');
    if (status.stdout.trim()) return res.status(400).json({ error: 'Working tree is dirty — commit or stash changes before merging.' });

    const co = await git(dir, 'checkout', def);
    if (!co.ok) return res.status(500).json({ ok: false, error: `Could not checkout ${def}`, output: (co.stderr || '').trim() });
    const mg = await git(dir, 'merge', '--no-edit', branch);
    const output = (mg.stdout + '\n' + mg.stderr).trim();
    if (!mg.ok) {
      const g = (...a) => git(dir, ...a);
      const conflicted = (await g('diff', '--name-only', '--diff-filter=U')).stdout.trim();

      // Conflicts + an API key → let Claude resolve them, then finish the merge.
      if (conflicted && resolve.hasApiKey()) {
        const r = await resolve.resolveCurrentConflicts({ dir, git: g, ours: def, theirs: branch, operation: 'merge' });
        if (!r.ok) {
          await g('merge', '--abort');
          return res.status(409).json({ ok: false, bail: true, error: `Couldn't auto-resolve the conflict (${r.reason})${r.file ? ` in ${r.file}` : ''}. Merge aborted, repo left clean — resolve it by hand.`, output });
        }
        const commit = await g('commit', '--no-edit');
        if (!commit.ok) {
          await g('merge', '--abort');
          return res.status(500).json({ ok: false, error: 'Resolved the conflicts but could not finish the merge commit — aborted, repo left clean.', output: (commit.stdout + '\n' + commit.stderr).trim() });
        }
        return res.json({
          ok: true,
          resolved: true,
          output: `Merged ${branch} into ${def} — Claude auto-resolved ${r.files.length} conflicted file(s).`,
          summary: r.files.map((f) => `• ${f.file}: ${f.explanation}`).join('\n'),
          note: `You are now on ${def}. Review the resolution, then push to publish. To undo: git reset --hard HEAD~1.`,
        });
      }

      await g('merge', '--abort');
      return res.status(409).json({
        ok: false,
        error: conflicted
          ? 'Merge conflict — aborted, repo left clean. Set an Anthropic API key (Working on now ▸ Settings) to let Claude resolve conflicts automatically.'
          : 'Merge failed — aborted, repo left clean.',
        output,
      });
    }
    res.json({ ok: true, output: output || `Merged ${branch} into ${def}.`, note: `You are now on ${def}; push to publish.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Rebase a local branch onto the default branch (replay its commits on top of
// the latest default). Local-only: rebasing needs a working checkout. Requires a
// clean tree; on conflict the rebase is aborted so the repo is left clean.
app.post('/api/projects/:id/rebase', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.hasLocal) return res.status(400).json({ error: 'No local checkout — rebase runs against a local clone.' });
    const { branch } = req.body || {};
    if (!isSafeRef(branch)) return res.status(400).json({ error: 'Invalid branch name' });

    const dir = project.path;
    const def = await detectDefaultBranch(dir);
    if (branch === def) return res.status(400).json({ error: 'Cannot rebase the default branch onto itself' });
    const verify = await git(dir, 'rev-parse', '--verify', `refs/heads/${branch}`);
    if (!verify.ok) return res.status(400).json({ error: `Local branch ${branch} not found` });
    const status = await git(dir, 'status', '--porcelain');
    if (status.stdout.trim()) return res.status(400).json({ error: 'Working tree is dirty — commit or stash changes before rebasing.' });

    // `git rebase <upstream> <branch>` checks out <branch> and replays its
    // unique commits on top of <upstream> (the default branch).
    const rb = await git(dir, 'rebase', def, branch);
    let output = (rb.stdout + '\n' + rb.stderr).trim();
    if (!rb.ok) {
      const g = (...a) => git(dir, ...a);
      const conflicted = (await g('diff', '--name-only', '--diff-filter=U')).stdout.trim();

      if (!(conflicted && resolve.hasApiKey())) {
        await g('rebase', '--abort');
        return res.status(409).json({
          ok: false,
          error: conflicted
            ? 'Rebase hit conflicts — aborted, repo left clean. Set an Anthropic API key (Working on now ▸ Settings) to let Claude resolve them automatically.'
            : 'Rebase hit conflicts — aborted, repo left clean. Resolve them manually, then retry.',
          output,
        });
      }

      // Rebase replays commits one at a time, so each replayed commit can raise a
      // fresh conflict: resolve → continue → repeat until it finishes or bails.
      const allResolved = [];
      let guard = 0;
      while (true) {
        if (++guard > 50) {
          await g('rebase', '--abort');
          return res.status(409).json({ ok: false, error: 'Rebase needed too many resolution rounds — aborted, repo left clean.', output });
        }
        const r = await resolve.resolveCurrentConflicts({ dir, git: g, ours: def, theirs: branch, operation: 'rebase' });
        if (!r.ok) {
          await g('rebase', '--abort');
          return res.status(409).json({ ok: false, bail: true, error: `Couldn't auto-resolve the rebase conflict (${r.reason})${r.file ? ` in ${r.file}` : ''}. Rebase aborted, repo left clean — resolve it by hand.`, output });
        }
        allResolved.push(...r.files);
        // GIT_EDITOR=true keeps `--continue` from opening an editor for the message.
        const cont = await run('git', ['-C', dir, 'rebase', '--continue'], { env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } });
        output = (cont.stdout + '\n' + cont.stderr).trim();
        if (cont.ok) break; // rebase finished
        const still = (await g('diff', '--name-only', '--diff-filter=U')).stdout.trim();
        if (!still) {
          await g('rebase', '--abort');
          return res.status(500).json({ ok: false, error: 'Rebase could not continue after resolving — aborted, repo left clean.', output });
        }
        // else: the next replayed commit conflicts too → loop and resolve again
      }

      const seen = new Set();
      const uniq = allResolved.filter((f) => (seen.has(f.file) ? false : seen.add(f.file)));
      return res.json({
        ok: true,
        resolved: true,
        output: `Rebased ${branch} onto ${def} — Claude auto-resolved conflicts in ${uniq.length} file(s).`,
        summary: uniq.map((f) => `• ${f.file}: ${f.explanation}`).join('\n'),
        note: `You are now on ${branch}, rebased onto the latest ${def}. Review the resolution before pushing (a rebased branch needs a force-push).`,
      });
    }
    res.json({ ok: true, output: output || `Rebased ${branch} onto ${def}.`, note: `You are now on ${branch}, rebased onto the latest ${def}.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Pull a local branch from origin, fast-forward only (so it can never create a
// merge commit or leave conflicts). Checks the branch out first if needed.
app.post('/api/projects/:id/pull', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasLocal) return res.status(400).json({ error: 'No local checkout — pull runs against a local clone.' });
    const { branch } = req.body || {};
    if (!isSafeRef(branch)) return res.status(400).json({ error: 'Invalid branch name' });

    const dir = project.path;
    const verify = await git(dir, 'rev-parse', '--verify', `refs/heads/${branch}`);
    if (!verify.ok) return res.status(400).json({ error: `Local branch ${branch} not found` });
    const status = await git(dir, 'status', '--porcelain');
    if (status.stdout.trim()) return res.status(400).json({ error: 'Working tree is dirty — commit or stash changes before pulling.' });

    const cur = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
    if (cur !== branch) {
      const co = await git(dir, 'checkout', branch);
      if (!co.ok) return res.status(500).json({ ok: false, error: `Could not checkout ${branch}`, output: (co.stderr || '').trim() });
    }
    const pl = await git(dir, 'pull', '--ff-only');
    const output = (pl.stdout + '\n' + pl.stderr).trim();
    if (!pl.ok) return res.status(409).json({ ok: false, error: 'Pull is not a fast-forward (local and remote have diverged) — rebase or merge manually.', output });
    res.json({ ok: true, output: output || `Pulled ${branch} from origin.`, note: cur !== branch ? `Checked out ${branch} to pull it.` : undefined });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Open a pull request for a branch. For a local branch we push it first (so the
// head exists on the remote), then let `gh pr create --fill` derive title/body
// from the commits and target the repo's default branch.
app.post('/api/projects/:id/create-pr', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.hasRemote || !project.owner || !project.repo)
      return res.status(400).json({ error: 'This project has no GitHub remote — cannot open a PR.' });
    const { branch, scope } = req.body || {};
    if (!isSafeRef(branch)) return res.status(400).json({ error: 'Invalid branch name' });
    const nwo = `${project.owner}/${project.repo}`;

    if (scope === 'local') {
      if (!project.hasLocal) return res.status(400).json({ error: 'No local checkout' });
      const dir = project.path;
      const verify = await git(dir, 'rev-parse', '--verify', `refs/heads/${branch}`);
      if (!verify.ok) return res.status(400).json({ error: `Local branch ${branch} not found` });
      const push = await git(dir, 'push', '-u', 'origin', branch);
      if (!push.ok) return res.status(500).json({ ok: false, error: 'Could not push the branch before opening a PR.', output: (push.stdout + '\n' + push.stderr).trim() });
    }

    const r = await run('gh', ['pr', 'create', '--repo', nwo, '--head', branch, '--fill']);
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) {
      const exists = /already exists/i.test(output);
      return res.status(exists ? 409 : 500).json({ ok: false, error: exists ? 'A pull request already exists for this branch.' : 'Could not open a pull request.', output });
    }
    const url = (r.stdout.match(/https?:\/\/\S+/) || [])[0] || '';
    res.json({ ok: true, output: url || output || `Opened a PR for ${branch}.`, url });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Fetch the latest from origin and prune stale remote-tracking branches, so the
// ahead/behind counts on the dashboard reflect reality. It only updates tracking
// refs (one-way: GitHub → your local refs) and never touches a branch you work
// on, so — unlike push/pull/merge — it is exempt from the read-only gate and the
// dashboard also runs it on a background timer.
app.post('/api/projects/:id/fetch', async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasLocal) return res.status(400).json({ error: 'No local checkout to fetch.' });
    const r = await git(project.path, 'fetch', '--all', '--prune');
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Fetch failed', output });
    res.json({ ok: true, output: output || 'Fetched latest from origin (pruned stale branches).' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Open a project's folder, a terminal, or an editor on it. This is a local OS
// convenience that never touches git or GitHub, so — like /api/settings — it is
// exempt from the read-only gate.
app.post('/api/projects/:id/open', async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasLocal || !project.path) return res.status(400).json({ error: 'No local checkout to open.' });
    const { what } = req.body || {};
    if (!['folder', 'terminal', 'editor'].includes(what)) return res.status(400).json({ error: 'what must be folder | terminal | editor' });
    if (!fs.existsSync(project.path)) return res.status(400).json({ error: 'Project path no longer exists.' });
    const r = await openLocation(project.path, what);
    if (!r.ok) return res.status(500).json({ ok: false, error: r.error || 'Could not open.' });
    res.json({ ok: true, output: `Opened ${what}.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Delete a branch (local or remote).
app.post('/api/projects/:id/delete-branch', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { branch, scope, force } = req.body || {};
    if (!isSafeRef(branch)) return res.status(400).json({ error: 'Invalid branch name' });

    if (scope === 'remote') {
      if (!project.hasRemote) return res.status(400).json({ error: 'No remote' });
      const nwo = `${project.owner}/${project.repo}`;
      const r = await run('gh', ['api', '-X', 'DELETE', `repos/${nwo}/git/refs/heads/${branch}`]);
      if (!r.ok) return res.status(500).json({ ok: false, error: 'Remote delete failed', output: (r.stderr || '').trim() });
      return res.json({ ok: true, output: `Deleted remote branch ${branch}.` });
    }

    if (!project.hasLocal) return res.status(400).json({ error: 'No local checkout' });
    const dir = project.path;
    const cur = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (cur.stdout.trim() === branch)
      return res.status(400).json({ error: `${branch} is currently checked out — switch branches before deleting it.` });

    // `git branch -d` checks merged-into-HEAD, but our recommendation cares about
    // merged-into-default. If the branch is fully contained in the default branch,
    // deletion loses nothing, so use -D safely. Otherwise honor -d / needsForce.
    const def = await detectDefaultBranch(dir);
    const mergedRes = await git(dir, 'branch', '--merged', def, '--format=%(refname:short)');
    const mergedIntoDefault = mergedRes.stdout.split('\n').map((s) => s.trim()).includes(branch);

    const flag = force || mergedIntoDefault ? '-D' : '-d';
    const r = await git(dir, 'branch', flag, branch);
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) {
      const notMerged = /not fully merged/i.test(output);
      return res.status(notMerged ? 409 : 500).json({ ok: false, error: notMerged ? 'Branch is not fully merged into the default branch.' : 'Delete failed', output, needsForce: notMerged });
    }
    res.json({ ok: true, output: output || `Deleted local branch ${branch}.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Clone a GitHub repo that has no local checkout yet into the projects root, so
// it becomes a first-class local project.
app.post('/api/projects/:id/clone', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.hasLocal) return res.status(400).json({ error: 'This project already has a local checkout.' });
    if (!project.hasRemote || !project.nameWithOwner || !project.repo) return res.status(400).json({ error: 'No GitHub repo to clone.' });
    if (!isSafeName(project.repo)) return res.status(400).json({ error: 'Unsafe repository name.' });

    const dir = path.join(PROJECTS_ROOT, project.repo);
    if (fs.existsSync(dir)) return res.status(400).json({ error: `A folder named "${project.repo}" already exists in ${PROJECTS_ROOT}.` });

    const r = await run('gh', ['repo', 'clone', project.nameWithOwner, dir]);
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Clone failed', output });
    projectCache = { ts: 0, data: null };
    res.json({ ok: true, output: output || `Cloned ${project.nameWithOwner} to ${dir}.`, newId: `local:${project.repo}` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Publish a local repo that has no remote to GitHub (creates the repo under your
// account, wires up origin, and pushes).
app.post('/api/projects/:id/publish', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasLocal) return res.status(400).json({ error: 'No local checkout to publish.' });
    if (project.hasRemote) return res.status(400).json({ error: 'This project already has a GitHub remote.' });
    const name = project.label;
    if (!isSafeName(name)) return res.status(400).json({ error: 'Folder name is not a valid GitHub repo name.' });

    const { private: priv } = req.body || {};
    const visibility = priv === false ? '--public' : '--private';
    const r = await run('gh', ['repo', 'create', name, '--source', project.path, '--remote', 'origin', '--push', visibility]);
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Publish failed', output });
    projectCache = { ts: 0, data: null };
    res.json({ ok: true, output: output || `Published ${name} to GitHub (${priv === false ? 'public' : 'private'}).` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Submit a review on a PR: approve / request changes / comment.
app.post('/api/projects/:id/pr-review', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasRemote || !project.owner || !project.repo) return res.status(400).json({ error: 'No GitHub remote on this project.' });
    const { number, action, body } = req.body || {};
    if (!isPrNumber(number)) return res.status(400).json({ error: 'Invalid PR number' });
    const flag = { approve: '--approve', 'request-changes': '--request-changes', comment: '--comment' }[action];
    if (!flag) return res.status(400).json({ error: 'action must be approve | request-changes | comment' });
    if ((action === 'request-changes' || action === 'comment') && !(body && body.trim()))
      return res.status(400).json({ error: 'A comment body is required for this review action.' });

    const nwo = `${project.owner}/${project.repo}`;
    const args = ['pr', 'review', String(number), '--repo', nwo, flag];
    if (body && body.trim()) args.push('--body', body);
    const r = await run('gh', args);
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Review submission failed', output });
    res.json({ ok: true, output: output || `Submitted "${action}" review on PR #${number}.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Toggle a PR between draft and ready-for-review.
app.post('/api/projects/:id/pr-ready', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasRemote || !project.owner || !project.repo) return res.status(400).json({ error: 'No GitHub remote on this project.' });
    const { number, draft } = req.body || {};
    if (!isPrNumber(number)) return res.status(400).json({ error: 'Invalid PR number' });
    const nwo = `${project.owner}/${project.repo}`;
    const args = ['pr', 'ready', String(number), '--repo', nwo];
    if (draft) args.push('--undo'); // --undo converts a ready PR back to draft
    const r = await run('gh', args);
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not change PR draft state', output });
    res.json({ ok: true, output: output || (draft ? `Converted PR #${number} to draft.` : `Marked PR #${number} ready for review.`) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Re-run the failed jobs of the latest workflow run for a branch.
app.post('/api/projects/:id/rerun-checks', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasRemote || !project.owner || !project.repo) return res.status(400).json({ error: 'No GitHub remote on this project.' });
    const { branch } = req.body || {};
    if (!isSafeRef(branch)) return res.status(400).json({ error: 'Invalid branch name' });
    const nwo = `${project.owner}/${project.repo}`;

    const runs = await ghJson(['run', 'list', '--repo', nwo, '--branch', branch, '--limit', '1', '--json', 'databaseId,status,conclusion']);
    if (!runs || !runs.length) return res.status(400).json({ error: `No workflow run found for ${branch}.` });
    const runId = runs[0].databaseId;
    const r = await run('gh', ['run', 'rerun', String(runId), '--failed', '--repo', nwo]);
    const output = (r.stdout + '\n' + r.stderr).trim();
    if (!r.ok) return res.status(500).json({ ok: false, error: 'Could not re-run checks', output });
    res.json({ ok: true, output: output || `Re-running failed jobs for the latest run on ${branch}.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Check a branch / PR out in the local clone so you can run it. By PR number we
// use `gh pr checkout`; by branch name we switch to a local branch, fetching it
// from origin first if it doesn't exist locally yet.
app.post('/api/projects/:id/checkout', denyWhenReadOnly, async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project || !project.hasLocal) return res.status(400).json({ error: 'No local checkout — there is nowhere to check this out.' });
    const dir = project.path;
    const { scope, prNumber } = req.body || {};
    const name = (req.body && (req.body.name || req.body.branch)) || null;

    const status = await git(dir, 'status', '--porcelain');
    if (status.stdout.trim()) return res.status(400).json({ error: 'Working tree is dirty — commit or stash changes before switching branches.' });

    if (prNumber != null) {
      if (!isPrNumber(prNumber)) return res.status(400).json({ error: 'Invalid PR number' });
      // gh infers the repo from the local clone's origin; run it in the repo dir.
      const r = await run('gh', ['pr', 'checkout', String(prNumber)], { cwd: dir });
      const output = (r.stdout + '\n' + r.stderr).trim();
      if (!r.ok) return res.status(500).json({ ok: false, error: `Could not check out PR #${prNumber}`, output });
      return res.json({ ok: true, output: output || `Checked out PR #${prNumber}.`, note: `You are now on the PR's branch.` });
    }

    if (!isSafeRef(name)) return res.status(400).json({ error: 'Invalid branch name' });
    const cur = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
    if (cur === name) return res.status(400).json({ error: `${name} is already checked out.` });

    const hasLocalBranch = (await git(dir, 'rev-parse', '--verify', `refs/heads/${name}`)).ok;
    if (!hasLocalBranch) await git(dir, 'fetch', 'origin', name); // create origin/<name> so checkout can track it
    const co = await git(dir, 'checkout', name);
    const output = (co.stdout + '\n' + co.stderr).trim();
    if (!co.ok) return res.status(500).json({ ok: false, error: `Could not check out ${name}`, output });
    res.json({ ok: true, output: output || `Checked out ${name}.`, note: `You are now on ${name}.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/refresh', (req, res) => {
  projectCache = { ts: 0, data: null };
  sessions.invalidate();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Cross-project "needs attention" rollup
// ---------------------------------------------------------------------------

// A deliberately cheap, git-only scan of one local repo: enough to flag what
// needs attention without the per-branch diff/rev-list work that localStatus
// does for the one repo you have open.
async function localAttention(dir) {
  const def = await detectDefaultBranch(dir);
  const items = [];

  const st = await git(dir, 'status', '--porcelain');
  const dirty = st.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).length;
  if (dirty) items.push({ level: 'action', text: `${dirty} uncommitted change(s)` });

  const stash = await git(dir, 'stash', 'list');
  const stashN = stash.stdout.split('\n').filter(Boolean).length;
  if (stashN) items.push({ level: 'info', text: `${stashN} stash(es) parked` });

  const SEP = '<<GHSEP>>';
  const ref = await git(dir, 'for-each-ref', `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(upstream:track)`, 'refs/heads');
  let unpushed = 0, gone = 0;
  for (const line of ref.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean)) {
    const [name, up, track] = line.split(SEP);
    const t = parseTrack(track);
    if (name === def) {
      if (t.ahead) items.push({ level: 'action', text: `default branch ${name} is ${t.ahead} commit(s) unpushed` });
      continue;
    }
    if (!up || t.ahead) unpushed++;
    else if (t.gone) gone++;
  }
  if (unpushed) items.push({ level: 'action', text: `${unpushed} branch(es) with unpushed work / no upstream` });
  if (gone) items.push({ level: 'cleanup', text: `${gone} branch(es) whose upstream is gone — deletable` });

  const merged = await git(dir, 'branch', '--merged', def, '--format=%(refname:short)');
  const mergedN = merged.stdout.split('\n').map((s) => s.trim()).filter((b) => b && b !== def).length;
  if (mergedN) items.push({ level: 'cleanup', text: `${mergedN} branch(es) merged into ${def} — safe to delete` });

  return items;
}

app.get('/api/summary', async (req, res) => {
  try {
    const projects = await listProjects();
    const byNwo = new Map();
    for (const p of projects) if (p.nameWithOwner) byNwo.set(p.nameWithOwner.toLowerCase(), p);

    const map = new Map(); // id -> { id, label, nameWithOwner, items[] }
    const entryFor = (id, label, nameWithOwner) => {
      if (!map.has(id)) map.set(id, { id, label, nameWithOwner: nameWithOwner || null, items: [] });
      return map.get(id);
    };
    const entryForNwo = (nwo) => {
      const p = byNwo.get(nwo.toLowerCase());
      return p ? entryFor(p.id, p.label, p.nameWithOwner) : entryFor(`remote:${nwo}`, nwo, nwo);
    };

    // Local half — fast, runs git only.
    const locals = projects.filter((p) => p.hasLocal && p.path);
    await mapLimit(locals, 6, async (p) => {
      const items = await localAttention(p.path);
      if (items.length) entryFor(p.id, p.label, p.nameWithOwner).items.push(...items);
    });

    // Remote half — two cheap cross-repo searches (one gh call each).
    const mine = (await ghJson(['search', 'prs', '--author=@me', '--state=open', '--limit', '100', '--json', 'repository,number,title,url,isDraft'])) || [];
    const reviews = (await ghJson(['search', 'prs', '--review-requested=@me', '--state=open', '--limit', '100', '--json', 'repository,number,title,url'])) || [];

    const mineByRepo = new Map();
    for (const pr of mine) {
      const k = pr.repository.nameWithOwner;
      if (!mineByRepo.has(k)) mineByRepo.set(k, []);
      mineByRepo.get(k).push(pr);
    }
    for (const [nwo, list] of mineByRepo) {
      const drafts = list.filter((p) => p.isDraft).length;
      entryForNwo(nwo).items.push({
        level: 'action',
        text: `${list.length} open PR(s) you authored${drafts ? ` (${drafts} draft)` : ''}`,
        prs: list.map((p) => ({ number: p.number, title: p.title, url: p.url })),
      });
    }
    for (const pr of reviews) {
      entryForNwo(pr.repository.nameWithOwner).items.push({
        level: 'action',
        text: `your review is requested: PR #${pr.number} — ${pr.title}`,
        url: pr.url,
      });
    }

    const W = { action: 3, cleanup: 2, info: 1 };
    const out = [...map.values()]
      .filter((e) => e.items.length)
      .map((e) => ({ ...e, score: e.items.reduce((s, i) => s + (W[i.level] || 1), 0) }))
      .sort((a, b) => b.score - a.score);

    res.json({ projects: out, scannedLocal: locals.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// PRs awaiting your review — the basis for the optional desktop notifications.
// One cheap cross-repo gh call; the client diffs successive polls itself.
app.get('/api/notifications', async (req, res) => {
  try {
    const reviews = (await ghJson(['search', 'prs', '--review-requested=@me', '--state=open', '--limit', '50', '--json', 'repository,number,title,url,updatedAt'])) || [];
    res.json({
      reviewRequested: reviews.map((p) => ({
        key: `${p.repository.nameWithOwner}#${p.number}`,
        repo: p.repository.nameWithOwner,
        number: p.number,
        title: p.title,
        url: p.url,
        updatedAt: p.updatedAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// "Working on now" — every local Claude Code session you have typed into in the
// last 14 days, summarized and ordered most-recent-first. Pure local read.
app.get('/api/sessions', async (req, res) => {
  try {
    res.json(await sessions.scanSessions());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Settings for the optional Anthropic API key that upgrades session summaries
// from the local heuristic to a Claude-written one. GET never returns the key
// itself — only whether one is set and where it came from. POST writes it to a
// local config file (not a git/GitHub change, so it is exempt from read-only).
app.get('/api/settings', (req, res) => res.json(sessions.getSettingsInfo()));
app.post('/api/settings', (req, res) => {
  const { anthropicApiKey } = req.body || {};
  if (anthropicApiKey != null && typeof anthropicApiKey !== 'string')
    return res.status(400).json({ error: 'Body must be { "anthropicApiKey": "<key>" | "" }' });
  res.json(sessions.setApiKey(anthropicApiKey));
});

// Read-only switch. GET reports the current state; POST { readOnly: bool } sets it.
app.get('/api/readonly', (req, res) => res.json({ readOnly }));
app.post('/api/readonly', (req, res) => {
  const { readOnly: want } = req.body || {};
  if (typeof want !== 'boolean') return res.status(400).json({ error: 'Body must be { "readOnly": true | false }' });
  readOnly = want;
  console.log(`  Read-only mode ${readOnly ? 'ENABLED — no changes will be made' : 'DISABLED — push/merge/delete are now allowed'}.`);
  res.json({ readOnly });
});

async function checkTooling() {
  const warn = [];
  if (!(await run('git', ['--version'])).ok) warn.push('git was not found on PATH — local repo scanning will not work.');
  const gh = await run('gh', ['--version']);
  if (!gh.ok) warn.push('gh (GitHub CLI) was not found on PATH — GitHub data and actions will not work.');
  else if (!(await run('gh', ['auth', 'status'])).ok) warn.push('gh is installed but not authenticated — run `gh auth login`. GitHub data will be unavailable until then.');
  return warn;
}

// Launch a detached GUI/console command via the platform shell, resolving ok
// unless the spawn itself fails almost immediately (e.g. binary not found).
function shellOpen(command) {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, { detached: true, stdio: 'ignore', shell: true });
      let settled = false;
      child.on('error', (e) => { if (!settled) { settled = true; resolve({ ok: false, error: e.message }); } });
      child.unref();
      setTimeout(() => { if (!settled) { settled = true; resolve({ ok: true }); } }, 400);
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// First editor on PATH from a small priority list (VS Code, then JetBrains, then
// Sublime). Returns the launch command, or null if none is installed.
async function findEditor() {
  const candidates = ['code', 'webstorm', 'idea', 'subl'];
  const lookup = process.platform === 'win32' ? (c) => run('cmd', ['/c', 'where', c]) : (c) => run('which', [c]);
  for (const c of candidates) {
    const r = await lookup(c);
    if (r.ok && r.stdout.trim()) return c;
  }
  return null;
}

async function openLocation(dir, what) {
  const q = `"${dir}"`;
  const plat = process.platform;
  if (what === 'folder') {
    if (plat === 'win32') return shellOpen(`explorer ${q}`);
    if (plat === 'darwin') return shellOpen(`open ${q}`);
    return shellOpen(`xdg-open ${q}`);
  }
  if (what === 'terminal') {
    if (plat === 'win32') return shellOpen(`start "" cmd /k cd /d ${q}`);
    if (plat === 'darwin') return shellOpen(`open -a Terminal ${q}`);
    return shellOpen(`x-terminal-emulator --working-directory=${q}`);
  }
  if (what === 'editor') {
    const editor = await findEditor();
    if (!editor) return { ok: false, error: 'No supported editor found on PATH (looked for code, webstorm, idea, subl).' };
    return shellOpen(`${editor} ${q}`);
  }
  return { ok: false, error: 'Unknown target' };
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* ignore */ }
}

// A double-clicked .exe closes its console the instant the process exits, so any
// startup error would vanish before it can be read. When packaged (and attached
// to a real console), pause so the message stays on screen until acknowledged.
let started = false;
function holdOpenThenExit(code) {
  if (IS_PACKAGED && process.stdin.isTTY) {
    process.stdout.write('  Press Enter to close this window…');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(code));
  } else {
    process.exit(code);
  }
}

const MAX_PORT_TRIES = 10;

function listenWithFallback(port, triesLeft) {
  const server = app.listen(port);

  server.on('listening', async () => {
    started = true;
    const actual = server.address().port;
    const url = `http://localhost:${actual}`;
    console.log(`\n  GitHubHelper dashboard running at  ${url}`);
    if (actual !== PORT) console.log(`  (port ${PORT} was busy — using ${actual} instead)`);
    console.log(`  Scanning local projects under      ${PROJECTS_ROOT}`);
    const warnings = await checkTooling();
    if (warnings.length) {
      console.log('');
      for (const w of warnings) console.log(`  ⚠ ${w}`);
    }
    console.log('');
    if (IS_PACKAGED && !process.env.NO_OPEN) {
      console.log('  Opening your browser…  (press Ctrl+C to stop the dashboard)\n');
      openBrowser(url);
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      // Only an explicitly requested port is treated as fatal; the default
      // wanders to the next free port so a double-click "just works".
      if (!PORT_EXPLICIT && triesLeft > 0) {
        console.log(`  Port ${port} is in use — trying ${port + 1}…`);
        return listenWithFallback(port + 1, triesLeft - 1);
      }
      console.error(`\n  Port ${port} is already in use. Start with a different port, e.g.:\n    githubhelper --port 5000\n`);
      return holdOpenThenExit(1);
    }
    console.error(`\n  Could not start the dashboard: ${e.message}\n`);
    holdOpenThenExit(1);
  });
}

// Surface a crash during startup instead of letting the window flash and close.
// Once the server is up the console is already open, so a stray async error is
// logged without taking the running dashboard down with it.
process.on('uncaughtException', (e) => {
  if (started) {
    console.error(`\n  ⚠ Unexpected error (dashboard still running): ${e.stack || e.message}\n`);
    return;
  }
  console.error(`\n  Failed to start: ${e.stack || e.message}\n`);
  holdOpenThenExit(1);
});

// A stray rejected promise would otherwise take Node down (its default), which
// looks like "Failed to fetch" in the browser. Once the server is up, log it and
// keep running — same policy as uncaughtException above.
process.on('unhandledRejection', (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  if (started) {
    console.error(`\n  ⚠ Unhandled promise rejection (dashboard still running): ${e.stack || e.message}\n`);
    return;
  }
  console.error(`\n  Failed to start: ${e.stack || e.message}\n`);
  holdOpenThenExit(1);
});

listenWithFallback(PORT, MAX_PORT_TRIES);
