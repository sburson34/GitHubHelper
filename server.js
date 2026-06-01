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
const { execFile } = require('child_process');

const PORT = process.env.PORT || 4317;
// Default to the parent of this repo (the WebstormProjects folder) so every
// sibling project is discoverable. Override with PROJECTS_ROOT.
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.dirname(process.cwd());

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Run a binary with args, never throwing — returns {ok, stdout, stderr, code}. */
function run(cmd, args, opts = {}) {
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
  const workingTree = {
    clean: dirtyLines.length === 0,
    count: dirtyLines.length,
    staged: dirtyLines.filter((l) => l[0] !== ' ' && l[0] !== '?').length,
    unstaged: dirtyLines.filter((l) => l[1] !== ' ' && l[1] !== '?').length,
    untracked: dirtyLines.filter((l) => l.startsWith('??')).length,
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
    if (!isDefault && aheadOfDefault > 0) {
      const logRes = await git(dir, 'log', `${defaultBranch}..${name}`, '--format=%s', '-n', '20');
      commitSubjects = logRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const statRes = await git(dir, 'diff', '--shortstat', `${defaultBranch}...${name}`);
      stat = parseShortstat(statRes.stdout);
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

function recommendRemoteBranch(b, pr, defaultBranch) {
  if (b.name === defaultBranch) return { level: 'ok', text: 'Default branch on GitHub.' };
  if (pr) {
    if (pr.isDraft) return { level: 'info', text: `Draft PR #${pr.number} open — mark ready when finished.` };
    if (pr.reviewDecision === 'APPROVED')
      return { level: 'action', text: `PR #${pr.number} is approved — merge it.` };
    if (pr.reviewDecision === 'CHANGES_REQUESTED')
      return { level: 'action', text: `PR #${pr.number} has changes requested — address review feedback.` };
    return { level: 'action', text: `PR #${pr.number} open${pr.aheadBy ? '' : ''} — get it reviewed & merged.` };
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
      'number,title,headRefName,baseRefName,url,isDraft,reviewDecision,createdAt,additions,deletions,changedFiles,mergeable',
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
    const b = {
      name,
      isDefault,
      protected: !!br.protected,
      aheadBy,
      behindBy,
      lastCommit,
      pr: pr
        ? {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            isDraft: pr.isDraft,
            reviewDecision: pr.reviewDecision,
            base: pr.baseRefName,
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
    res.json({ projects, root: PROJECTS_ROOT });
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
app.post('/api/projects/:id/push', async (req, res) => {
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
app.post('/api/projects/:id/merge', async (req, res) => {
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
      await git(dir, 'merge', '--abort');
      return res.status(409).json({ ok: false, error: 'Merge conflict — aborted, repo left clean.', output });
    }
    res.json({ ok: true, output: output || `Merged ${branch} into ${def}.`, note: `You are now on ${def}; push to publish.` });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Delete a branch (local or remote).
app.post('/api/projects/:id/delete-branch', async (req, res) => {
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

app.post('/api/refresh', (req, res) => {
  projectCache = { ts: 0, data: null };
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n  GitHubHelper dashboard running at  http://localhost:${PORT}`);
  console.log(`  Scanning local projects under      ${PROJECTS_ROOT}\n`);
});
