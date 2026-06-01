'use strict';

const $ = (sel) => document.querySelector(sel);
const content = $('#content');
const rootInfo = $('#root-info');
const refreshBtn = $('#refresh-btn');
const searchInput = $('#project-search');
const listEl = $('#project-list');
const readonlyInput = $('#readonly-input');
const notifyBtn = $('#notify-btn');
const overviewToggle = $('#overview-toggle');
const overviewBody = $('#overview-body');

const STORAGE_KEY = 'ghhelper.selectedProject';
const NOTIFY_KEY = 'ghhelper.notify';

let allProjects = []; // full project list for the combobox
let selectedId = null; // currently selected project id
let activeIdx = -1; // keyboard-highlighted item in the combo list
let showAll = false; // when true, the combo shows every project (just focused)
let state = null; // { project, local, remote } for the selected project
let readOnly = true; // mirrors the server's read-only gate; starts safe (on)
let aiAvailable = false; // whether an Anthropic key is set (enables AI conflict resolution)
const lastFetched = {}; // project id -> timestamp of last successful git fetch

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const s = (Date.now() - d.getTime()) / 1000;
  const units = [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, secs] of units) {
    const v = Math.floor(s / secs);
    if (v >= 1) return `${v}${label} ago`;
  }
  return 'just now';
}

function badge(cls, text) {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

// ---------------------------------------------------------------------------
// Project list + searchable combobox
// ---------------------------------------------------------------------------

function projectTag(p) {
  if (p.type === 'remote-only') return 'GitHub only';
  if (!p.hasRemote) return 'local only';
  return 'local + GitHub';
}

async function loadProjects() {
  const res = await fetch('/api/projects');
  const data = await res.json();
  allProjects = data.projects || [];
  if (typeof data.readOnly === 'boolean') setReadOnlyUI(data.readOnly);
  rootInfo.textContent = `Scanning ${data.root} · ${allProjects.length} projects (${allProjects.filter((p) => p.hasLocal).length} local)`;

  // Whether an Anthropic key is set — gates AI merge/rebase conflict resolution.
  try { aiAvailable = !!(await (await fetch('/api/settings')).json()).hasApiKey; } catch { /* leave as-is */ }

  // Deep-link via ?p=<id> takes precedence over the last-used project.
  const fromUrl = new URLSearchParams(location.search).get('p');
  const saved = localStorage.getItem(STORAGE_KEY);
  const initial = (fromUrl && allProjects.some((p) => p.id === fromUrl)) ? fromUrl
    : (saved && allProjects.some((p) => p.id === saved)) ? saved : null;
  if (initial) selectProject(initial, false);
}

function filteredProjects() {
  // While the box just gained focus (showing the already-selected project's
  // name), show the full list. Only filter once the user actually types.
  if (showAll) return allProjects;
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return allProjects;
  return allProjects.filter((p) => p.label.toLowerCase().includes(q) || (p.nameWithOwner || '').toLowerCase().includes(q));
}

function renderList() {
  const items = filteredProjects();
  if (!items.length) {
    listEl.innerHTML = '<div class="combo-empty">No matching projects</div>';
    listEl.hidden = false;
    return;
  }
  listEl.innerHTML = items
    .map((p, i) => `
      <div class="combo-item ${i === activeIdx ? 'active' : ''} ${p.id === selectedId ? 'selected' : ''}" data-id="${esc(p.id)}">
        <span class="ci-name">${esc(p.label)}</span>
        <span class="ci-tag">${esc(projectTag(p))}</span>
      </div>`)
    .join('');
  listEl.hidden = false;
}

function openList() { activeIdx = -1; renderList(); }
function closeList() { listEl.hidden = true; activeIdx = -1; }

function selectProject(id, fromUser = true) {
  const p = allProjects.find((x) => x.id === id);
  if (!p) return;
  selectedId = id;
  searchInput.value = p.label;
  localStorage.setItem(STORAGE_KEY, id);
  closeList();
  loadProject(id);
}

searchInput.addEventListener('focus', () => { searchInput.select(); showAll = true; openList(); });
searchInput.addEventListener('input', () => { showAll = false; activeIdx = -1; renderList(); });
searchInput.addEventListener('keydown', (e) => {
  const items = filteredProjects();
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); renderList(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); renderList(); }
  else if (e.key === 'Enter') { e.preventDefault(); const pick = items[activeIdx] || items[0]; if (pick) selectProject(pick.id); }
  else if (e.key === 'Escape') { closeList(); searchInput.blur(); }
});
listEl.addEventListener('mousedown', (e) => {
  // mousedown (not click) so it fires before the input blur hides the list
  const item = e.target.closest('.combo-item');
  if (item) selectProject(item.dataset.id);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.combo')) closeList();
});

// ---------------------------------------------------------------------------
// Action availability (gates the inline buttons)
// ---------------------------------------------------------------------------

function actionAvailability(scope, b) {
  const wtClean = state && state.local && state.local.workingTree ? state.local.workingTree.clean : true;
  const def = scope === 'local' ? (state.local && state.local.defaultBranch) : (state.remote && state.remote.defaultBranch);
  const isCleanup = b.recommendation && b.recommendation.level === 'cleanup';
  const hasRemote = !!(state && state.project && state.project.hasRemote);
  // Branch names that already have an open PR (so we don't offer "Open PR" twice).
  const prHeads = new Set(((state && state.remote && state.remote.openPRs) || []).map((p) => p.headRefName));

  if (scope === 'local') {
    const conflicts = b.conflictsWithDefault === true;
    const mergeReason = b.isDefault ? 'this is the default branch'
      : b.aheadOfDefault <= 0 ? 'no commits ahead of default'
      : !wtClean ? 'working tree is dirty'
      : conflicts ? `⚠ merges into ${def} with conflicts — it will be aborted and the repo left clean`
      : `merge into ${def} locally`;
    return {
      push: !b.hasUpstream || b.ahead > 0,
      pushReason: !b.hasUpstream ? 'no upstream — push to create it' : b.ahead > 0 ? `${b.ahead} unpushed commit(s)` : 'nothing to push',
      pull: b.hasUpstream && b.behind > 0 && wtClean,
      pullReason: !b.hasUpstream ? 'no upstream to pull from' : b.behind <= 0 ? 'already up to date with origin' : !wtClean ? 'working tree is dirty' : `behind origin by ${b.behind} — pull (fast-forward only)`,
      createPr: hasRemote && !b.isDefault && b.aheadOfDefault > 0 && !prHeads.has(b.name),
      createPrReason: !hasRemote ? 'no GitHub remote on this project' : b.isDefault ? 'this is the default branch' : b.aheadOfDefault <= 0 ? 'no commits ahead of default' : prHeads.has(b.name) ? 'a PR is already open for this branch' : 'push (if needed) and open a PR',
      // A branch "needs a rebase" when the default branch has moved on since it
      // diverged (behindDefault > 0). Rebasing replays its commits on top.
      rebase: !b.isDefault && b.behindDefault > 0 && wtClean,
      rebaseReason: b.isDefault ? 'this is the default branch' : b.behindDefault <= 0 ? `up to date with ${def} — no rebase needed` : !wtClean ? 'working tree is dirty' : `behind ${def} by ${b.behindDefault} — rebase onto the latest ${def}`,
      checkout: !b.isCurrent && wtClean,
      checkoutReason: b.isCurrent ? 'already checked out' : !wtClean ? 'working tree is dirty' : 'switch to this branch',
      merge: !b.isDefault && b.aheadOfDefault > 0 && wtClean,
      mergeLabel: `Merge → ${def}`,
      mergeReason,
      del: isCleanup,
      delReason: isCleanup ? 'delete this branch' : 'only when recommendation is "delete"',
    };
  }
  const conflicts = b.mergeable === 'CONFLICTING';
  const hasLocal = !!(state && state.project && state.project.hasLocal);
  return {
    push: false,
    pushReason: 'remote branch — already on GitHub',
    pull: false,
    pullReason: 'remote branch — pull runs on a local checkout',
    createPr: !b.isDefault && b.aheadBy > 0 && !b.pr,
    createPrReason: b.isDefault ? 'this is the default branch' : b.pr ? `PR #${b.pr.number} is already open` : b.aheadBy <= 0 ? 'no commits ahead of default' : 'open a PR for this branch',
    rebase: false,
    rebaseReason: 'rebase runs against a local checkout',
    checkout: hasLocal && wtClean,
    checkoutReason: !hasLocal ? 'no local checkout to switch in' : !wtClean ? 'working tree is dirty' : 'check this branch out locally (fetches it first)',
    merge: !!b.pr,
    mergeLabel: b.pr ? `Merge PR #${b.pr.number}` : 'Merge PR',
    mergeReason: !b.pr ? 'no open PR for this branch' : conflicts ? `⚠ PR #${b.pr.number} has merge conflicts — resolve them first` : `merge PR #${b.pr.number}`,
    del: isCleanup,
    delReason: isCleanup ? 'delete this remote branch' : 'only when recommendation is "delete"',
  };
}

function actionsCell(scope, b) {
  const a = actionAvailability(scope, b);
  // Read-only mode greys out every action; its reason explains why.
  const RO_REASON = 'Read-only mode is on — turn it off to enable changes';
  const btn = (act, cls, label, enabled, reason) =>
    `<button class="row-action ${cls}" data-act="${act}" data-scope="${scope}" data-name="${esc(b.name)}" ${enabled && !readOnly ? '' : 'disabled'} title="${esc(readOnly ? RO_REASON : reason)}">${label}</button>`;
  return (
    btn('push', 'push', '⬆ Push', a.push, a.pushReason) +
    btn('pull', 'pull', '⬇ Pull', a.pull, a.pullReason) +
    btn('createPr', 'createpr', '＋ PR', a.createPr, a.createPrReason) +
    btn('checkout', 'checkout', '↳ Checkout', a.checkout, a.checkoutReason) +
    btn('rebase', 'rebase', '⤴ Rebase', a.rebase, a.rebaseReason) +
    btn('merge', 'merge', '⛙ Merge', a.merge, a.mergeReason) +
    btn('delete', 'delete', '🗑 Delete', a.del, a.delReason)
  );
}

// ---------------------------------------------------------------------------
// Render a project's status as tables
// ---------------------------------------------------------------------------

// CI rollup → badge. Returns '' when there are no checks.
function checksBadge(c) {
  if (!c || c.state === 'none') return '';
  if (c.state === 'success') return badge('b-checks-ok', '✓ CI');
  if (c.state === 'failure') return badge('b-checks-fail', `✗ CI ${c.failing}/${c.total}`);
  if (c.state === 'pending') return badge('b-checks-pending', '● CI');
  return '';
}

function reviewBadge(decision) {
  if (decision === 'APPROVED') return badge('b-review-ok', 'approved');
  if (decision === 'CHANGES_REQUESTED') return badge('b-review-changes', 'changes requested');
  if (decision === 'REVIEW_REQUIRED') return badge('b-review-req', 'review required');
  return '';
}

function localBadges(b) {
  const out = [];
  if (b.isDefault) out.push(badge('b-default', 'default'));
  if (b.isCurrent) out.push(badge('b-current', 'checked out'));
  if (b.merged) out.push(badge('b-merged', 'merged'));
  if (!b.hasUpstream) out.push(badge('b-nopush', 'never pushed'));
  else if (b.ahead > 0) out.push(badge('b-unpushed', `${b.ahead} unpushed`));
  if (b.gone) out.push(badge('b-gone', 'upstream gone'));
  if (b.behind > 0) out.push(badge('b-ahead', `${b.behind}↓ origin`));
  if (!b.isDefault && b.aheadOfDefault > 0) out.push(badge('b-ahead', `${b.aheadOfDefault}↑ default`));
  if (!b.isDefault && b.behindDefault > 0) out.push(badge('b-ahead', `${b.behindDefault}↓ default`));
  if (b.conflictsWithDefault === true) out.push(badge('b-conflict', 'conflicts default'));
  return out.join(' ');
}

function remoteBadges(b) {
  const out = [];
  if (b.isDefault) out.push(badge('b-default', 'default'));
  if (b.protected) out.push(badge('b-protected', 'protected'));
  if (b.pr) out.push(badge('b-pr', `PR #${b.pr.number}`));
  if (!b.isDefault && b.aheadBy > 0) out.push(badge('b-ahead', `${b.aheadBy}↑`));
  if (!b.isDefault && b.behindBy > 0) out.push(badge('b-ahead', `${b.behindBy}↓`));
  if (b.checks) { const cb = checksBadge(b.checks); if (cb) out.push(cb); }
  if (b.pr && b.pr.reviewDecision) { const rb = reviewBadge(b.pr.reviewDecision); if (rb) out.push(rb); }
  if (b.mergeable === 'CONFLICTING') out.push(badge('b-conflict', 'conflicts'));
  return out.join(' ');
}

function commitCell(c) {
  c = c || {};
  return `<div>${esc(c.sha || '')} ${esc((c.subject || '').slice(0, 60))}</div><div>${esc(c.author || '')} · ${timeAgo(c.date)}</div>`;
}

function branchRow(scope, b, badgesHtml) {
  const lvl = b.recommendation ? b.recommendation.level : 'info';
  return `
    <tr class="lvl-${lvl}" data-scope="${scope}" data-name="${esc(b.name)}">
      <td><a class="branch-link">${esc(b.name)}</a></td>
      <td class="col-state">${badgesHtml || ''}</td>
      <td class="col-change">${esc(b.description)}</td>
      <td class="col-commit">${commitCell(b.lastCommit)}</td>
      <td class="col-rec lvl-${lvl}">${b.recommendation ? esc(b.recommendation.text) : ''}</td>
      <td class="col-actions">${actionsCell(scope, b)}</td>
    </tr>`;
}

function tableHead() {
  return `<thead><tr>
    <th>Branch</th><th>State</th><th>Change</th><th>Last commit</th><th>Recommendation</th><th>Actions</th>
  </tr></thead>`;
}

function renderLocal(local) {
  if (!local) return '';
  const wt = local.workingTree;
  let wtHtml = '';
  if (wt) {
    const cls = wt.clean ? 'clean' : 'dirty';
    const stashNote = wt.stashCount ? ` · 📦 ${wt.stashCount} stash(es)` : '';
    const summary = (wt.clean
      ? '✓ Working tree clean — nothing uncommitted.'
      : `⚠ ${wt.count} uncommitted change(s) on <strong>${esc(local.currentBranch)}</strong> — ${wt.staged} staged, ${wt.unstaged} unstaged, ${wt.untracked} untracked.`) + stashNote;
    const fileList = !wt.clean
      ? `<div class="files">${wt.files.map((f) => `<div>${esc(f.status.padEnd(2))} ${esc(f.file)}</div>`).join('')}${wt.count > wt.files.length ? `<div>… ${wt.count - wt.files.length} more</div>` : ''}</div>`
      : '';
    wtHtml = `<div class="worktree ${cls}">${summary}${fileList}</div>`;
  }

  const rows = local.branches.map((b) => branchRow('local', b, localBadges(b))).join('');
  return `
    <div class="section">
      <h3>💻 Local <span class="count">· ${local.branches.length} branch(es) · default: ${esc(local.defaultBranch)}</span></h3>
      ${wtHtml}
      ${local.note ? `<div class="worktree dirty">⚠ ${esc(local.note)}</div>` : ''}
      ${local.branches.length ? `<table class="branch-table">${tableHead()}<tbody>${rows}</tbody></table>` : ''}
    </div>`;
}

function renderRemote(remote) {
  if (!remote) return '';
  if (remote.error) return `<div class="section"><h3>☁ GitHub</h3><div class="error">${esc(remote.error)}</div></div>`;

  const rows = remote.branches.map((b) => branchRow('remote', b, remoteBadges(b))).join('');
  const prs = remote.openPRs || [];
  const prSection = `
    <div class="section">
      <h3>🔀 Open Pull Requests <span class="count">· ${prs.length}</span></h3>
      ${prs.length ? prs.map(prRow).join('') : '<div class="empty">No open pull requests.</div>'}
    </div>`;

  return `
    <div class="section">
      <h3>☁ GitHub <span class="count">· ${remote.branches.length} branch(es) · ${remote.isPrivate ? 'private' : 'public'} · default: ${esc(remote.defaultBranch)}</span></h3>
      <table class="branch-table">${tableHead()}<tbody>${rows}</tbody></table>
    </div>
    ${prSection}`;
}

function ciText(c) {
  if (!c || c.state === 'none') return '';
  if (c.state === 'success') return '✓ CI green';
  if (c.state === 'failure') return `✗ CI failing (${c.failing}/${c.total})`;
  if (c.state === 'pending') return '● CI running';
  return '';
}

function prRow(p) {
  const review = p.reviewDecision ? ` · ${p.reviewDecision.replace('_', ' ').toLowerCase()}` : '';
  const draft = p.isDraft ? ' · draft' : '';
  const ci = ciText(p.checks) ? ` · ${ciText(p.checks)}` : '';
  const conflict = p.mergeable === 'CONFLICTING' ? ' · ⚠ conflicts' : '';

  const hasLocal = !!(state && state.project && state.project.hasLocal);
  const ro = readOnly ? 'disabled' : '';
  const roTitle = readOnly ? ' title="Read-only mode is on — turn it off to act on PRs"' : '';
  const d = `data-prnum="${p.number}" data-head="${esc(p.headRefName)}"`;
  const pbtn = (pract, label) => `<button class="pr-action" data-pract="${pract}" ${d} ${ro}${roTitle}>${label}</button>`;
  const actions = [
    pbtn('approve', '✓ Approve'),
    pbtn('request-changes', '✗ Request changes'),
    pbtn('comment', '💬 Comment'),
    p.isDraft ? pbtn('ready', '📣 Mark ready') : pbtn('undraft', '✏ To draft'),
    p.checks && p.checks.state === 'failure' ? pbtn('rerun', '↻ Re-run CI') : '',
    hasLocal ? pbtn('checkout', '↳ Checkout') : '',
  ].join('');

  return `
    <div class="pr-row">
      <div class="pr-row-main">
        <a href="${esc(p.url)}" target="_blank" rel="noopener">#${p.number} ${esc(p.title)}</a>
        <span class="meta">${esc(p.headRefName)} → ${esc(p.baseRefName)} · +${p.additions ?? '?'}/-${p.deletions ?? '?'} in ${p.changedFiles ?? '?'} files${review}${draft}${ci}${conflict} · ${timeAgo(p.createdAt)}</span>
      </div>
      <div class="pr-actions">${actions}</div>
    </div>`;
}

async function loadProject(id, opts = {}) {
  if (!id) {
    content.innerHTML = '<div class="placeholder"><p>Search for and select a project to see the full status of its branches.</p></div>';
    return;
  }
  // A silent reload (used by background auto-fetch) skips the spinner flash and
  // leaves the current view untouched on error, so it never disrupts the page.
  if (!opts.silent) content.innerHTML = '<div class="loading"><div class="spinner"></div>Gathering branch status…</div>';

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    state = data;
    const p = data.project;

    const links = [];
    if (data.remote && data.remote.url) links.push(`<a href="${esc(data.remote.url)}" target="_blank" rel="noopener">${esc(data.remote.nameWithOwner)} ↗</a>`);
    const metaBits = [];
    if (p.hasLocal) metaBits.push(`local: ${esc(p.path)}`);
    if (!p.hasLocal) metaBits.push('GitHub only — no local checkout');
    if (p.hasRemote && !p.hasLocal && p.description) metaBits.push(esc(p.description));

    const lf = lastFetched[p.id];
    const tools = [];
    if (p.hasLocal) {
      tools.push('<button class="tool-btn" data-tool="fetch" title="git fetch --all --prune — refresh ahead/behind (also runs automatically every 10 min while this project is open)">↓ Fetch</button>');
      tools.push('<button class="tool-btn" data-tool="folder" title="Open this project folder">📁 Folder</button>');
      tools.push('<button class="tool-btn" data-tool="terminal" title="Open a terminal here">⌨ Terminal</button>');
      tools.push('<button class="tool-btn" data-tool="editor" title="Open in your editor (VS Code / WebStorm / …)">📝 Editor</button>');
      if (!p.hasRemote) tools.push('<button class="tool-btn" data-tool="publish" title="Create a GitHub repo from this folder and push it">☁ Publish to GitHub</button>');
      tools.push(`<span class="fetch-when">${lf ? `fetched ${esc(timeAgo(new Date(lf).toISOString()))}` : 'auto-fetch on'}</span>`);
    } else if (p.hasRemote) {
      tools.push('<button class="tool-btn" data-tool="clone" title="Clone this GitHub repo into your projects folder">⬇ Clone locally</button>');
    }
    const toolbar = tools.length ? `<div class="proj-tools">${tools.join('')}</div>` : '';

    content.innerHTML = `
      <div class="proj-header">
        <h2>${esc(p.label)}</h2>
        ${links.join('')}
      </div>
      <div class="proj-meta">${metaBits.join(' · ')}</div>
      ${toolbar}
      ${renderLocal(data.local)}
      ${renderRemote(data.remote)}
      ${!data.local && !data.remote ? '<div class="empty">No status available for this project.</div>' : ''}
    `;
  } catch (e) {
    if (!opts.silent) content.innerHTML = `<div class="error">Failed to load project: ${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Delegated clicks: branch name → detail modal; action button → runAction
// ---------------------------------------------------------------------------

content.addEventListener('click', (e) => {
  // Project-level toolbar (fetch / open folder / terminal / editor).
  const tool = e.target.closest('.tool-btn[data-tool]');
  if (tool) { if (!tool.disabled) runTool(tool.dataset.tool); return; }
  // PR action-bar buttons (review / ready / rerun / checkout).
  const pa = e.target.closest('.pr-action');
  if (pa) { if (!pa.disabled) runPrAction(pa.dataset.pract, Number(pa.dataset.prnum), pa.dataset.head); return; }
  // A click on an action button (enabled or not) never opens the detail view.
  const act = e.target.closest('.row-action');
  if (act) { if (!act.disabled) runAction(act.dataset.act, act.dataset.scope, act.dataset.name); return; }
  // Anywhere else on a branch row opens that branch's details.
  const row = e.target.closest('tr[data-scope]');
  if (row) openBranch(row.dataset.scope, row.dataset.name);
});

// Project toolbar: fetch is a gated mutation; folder/terminal/editor are local
// OS conveniences that never touch git/GitHub.
async function runTool(tool) {
  const id = state && state.project && state.project.id;
  if (!id) return;

  if (tool === 'fetch') {
    // Fetch is one-way-safe, so it works even in read-only mode.
    showToast('info', 'Fetching latest from origin…', true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const r = await res.json();
      if (!res.ok || r.ok === false) { showToast('err', (r.error || 'Fetch failed') + (r.output ? '\n' + r.output : ''), true); return; }
      lastFetched[id] = Date.now();
      showToast('ok', r.output || 'Fetched.');
      await loadProject(id);
    } catch (e) { showToast('err', 'Error: ' + e.message, true); }
    return;
  }

  if (tool === 'clone') {
    if (readOnly) { showToast('info', 'Read-only mode is on — turn it off to clone.'); return; }
    if (!window.confirm(`Clone "${state.project.label}" into your projects folder?`)) return;
    showToast('info', 'Cloning…', true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const r = await res.json();
      if (r.readOnly) { setReadOnlyUI(true); }
      if (!res.ok || r.ok === false) { showToast('err', (r.error || 'Clone failed') + (r.output ? '\n' + r.output : ''), true); return; }
      showToast('ok', r.output || 'Cloned.');
      await loadProjects();
      if (r.newId) selectProject(r.newId);
    } catch (e) { showToast('err', 'Error: ' + e.message, true); }
    return;
  }

  if (tool === 'publish') {
    if (readOnly) { showToast('info', 'Read-only mode is on — turn it off to publish.'); return; }
    if (!window.confirm(`Publish "${state.project.label}" to GitHub?`)) return;
    const priv = window.confirm('Make the new repository PRIVATE?\n\nOK = private · Cancel = public');
    showToast('info', 'Publishing…', true);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(id)}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: priv }) });
      const r = await res.json();
      if (r.readOnly) { setReadOnlyUI(true); }
      if (!res.ok || r.ok === false) { showToast('err', (r.error || 'Publish failed') + (r.output ? '\n' + r.output : ''), true); return; }
      showToast('ok', r.output || 'Published.');
      await loadProjects();
      await loadProject(id);
    } catch (e) { showToast('err', 'Error: ' + e.message, true); }
    return;
  }

  // folder / terminal / editor — local OS conveniences.
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: tool }) });
    const r = await res.json();
    if (!res.ok || r.ok === false) { showToast('err', r.error || 'Could not open.', true); return; }
    showToast('ok', r.output || 'Opened.');
  } catch (e) { showToast('err', 'Error: ' + e.message, true); }
}

// ---------------------------------------------------------------------------
// Read-only switch
// ---------------------------------------------------------------------------

// Reflect a read-only value in the UI without hitting the server.
function setReadOnlyUI(val) {
  readOnly = !!val;
  readonlyInput.checked = readOnly;
  document.body.classList.toggle('readonly', readOnly);
}

readonlyInput.addEventListener('change', async () => {
  const want = readonlyInput.checked;
  try {
    const res = await fetch('/api/readonly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readOnly: want }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    setReadOnlyUI(r.readOnly);
    showToast(r.readOnly ? 'info' : 'ok',
      r.readOnly
        ? 'Read-only mode ON — the dashboard will not make any changes.'
        : 'Read-only mode OFF — push, merge, and delete are now enabled.');
    if (selectedId) loadProject(selectedId); // re-render so buttons grey/un-grey
  } catch (e) {
    setReadOnlyUI(readOnly); // revert the checkbox to the last known good state
    showToast('err', 'Could not change read-only mode: ' + e.message);
  }
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '↻ Refreshing…';
  await fetch('/api/refresh', { method: 'POST' });
  await loadProjects();
  if (selectedId) await loadProject(selectedId);
  refreshBtn.disabled = false;
  refreshBtn.textContent = '↻ Refresh';
});

// ---------------------------------------------------------------------------
// Cross-project "needs attention" overview
// ---------------------------------------------------------------------------

overviewToggle.addEventListener('click', () => {
  const willShow = overviewBody.hidden;
  overviewBody.hidden = !willShow;
  overviewToggle.setAttribute('aria-expanded', String(willShow));
  overviewToggle.textContent = `${willShow ? '▾' : '▸'} Across all projects — what needs attention`;
  if (willShow) loadSummary();
});

async function loadSummary() {
  overviewBody.innerHTML = '<div class="loading"><div class="spinner"></div>Scanning all projects…</div>';
  try {
    const res = await fetch('/api/summary');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = data.projects || [];
    const bar = `<div class="summary-bar"><button id="overview-rescan" class="tool-btn">↻ Rescan</button><span class="summary-meta">${list.length} project(s) need attention · ${data.scannedLocal} local repo(s) scanned</span></div>`;
    overviewBody.innerHTML = bar + (list.length
      ? list.map(renderSummaryRow).join('')
      : '<div class="empty">Nothing needs attention — everything looks clean. 🎉</div>');
  } catch (e) {
    overviewBody.innerHTML = `<div class="error">Failed to scan: ${esc(e.message)}</div>`;
  }
}

function renderSummaryRow(e) {
  const items = e.items.map((it) => {
    const link = it.url ? ` <a href="${esc(it.url)}" target="_blank" rel="noopener">↗</a>` : '';
    return `<li class="lvl-${esc(it.level)}">${esc(it.text)}${link}</li>`;
  }).join('');
  const known = allProjects.some((p) => p.id === e.id);
  return `
    <div class="summary-proj ${known ? 'clickable' : ''}" data-id="${esc(e.id)}">
      <div class="summary-head">
        <span class="summary-label">${esc(e.label)}</span>
        <span class="summary-count">${e.items.length} item(s)</span>
      </div>
      <ul class="summary-items">${items}</ul>
    </div>`;
}

overviewBody.addEventListener('click', (ev) => {
  if (ev.target.closest('#overview-rescan')) { loadSummary(); return; }
  if (ev.target.closest('a')) return; // let external links work
  const card = ev.target.closest('.summary-proj');
  if (!card) return;
  const id = card.dataset.id;
  if (allProjects.some((p) => p.id === id)) {
    setTab('projects');
    selectProject(id);
    overviewBody.hidden = true;
    overviewToggle.setAttribute('aria-expanded', 'false');
    overviewToggle.textContent = '▸ Across all projects — what needs attention';
  } else {
    showToast('info', 'That repo isn’t in your project list (no local checkout) — open it on GitHub via the ↗ link.');
  }
});

// ---------------------------------------------------------------------------
// Desktop notifications — PRs awaiting your review
// ---------------------------------------------------------------------------

const NOTIFY_MS = 5 * 60 * 1000; // poll every 5 minutes (one cheap gh call)
let notifyEnabled = false;
let notifyTimer = null;
let notifySeen = new Set();

async function pollNotifications(initial) {
  try {
    const res = await fetch('/api/notifications');
    if (!res.ok) return;
    const data = await res.json();
    const list = data.reviewRequested || [];
    if (initial) {
      // Seed the seen-set so we only alert on PRs that show up *after* enabling.
      notifySeen = new Set(list.map((x) => x.key));
      return;
    }
    for (const it of list) {
      if (notifySeen.has(it.key)) continue;
      notifySeen.add(it.key);
      const n = new Notification('Review requested', { body: `${it.repo} #${it.number}: ${it.title}`, tag: it.key });
      n.onclick = () => { window.open(it.url, '_blank', 'noopener'); window.focus(); };
    }
  } catch { /* ignore transient poll errors */ }
}

function setNotify(on) {
  notifyEnabled = on;
  localStorage.setItem(NOTIFY_KEY, on ? '1' : '');
  notifyBtn.classList.toggle('active', on);
  notifyBtn.textContent = on ? '🔔 On' : '🔔 Notify';
  notifyBtn.title = on
    ? 'Desktop notifications on — click to turn off'
    : 'Desktop notifications when a pull request is waiting on your review';
  if (notifyTimer) { clearInterval(notifyTimer); notifyTimer = null; }
  if (on) {
    pollNotifications(true);
    notifyTimer = setInterval(() => pollNotifications(false), NOTIFY_MS);
  }
}

notifyBtn.addEventListener('click', async () => {
  if (notifyEnabled) { setNotify(false); showToast('info', 'Desktop notifications off.'); return; }
  if (!('Notification' in window)) { showToast('err', 'This browser does not support desktop notifications.'); return; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') { showToast('err', 'Notification permission was denied — enable it in your browser to use this.'); return; }
  setNotify(true);
  showToast('ok', 'Notifications on — you’ll be alerted when a PR is waiting on your review.');
});

// ---------------------------------------------------------------------------
// Branch detail modal (files changed + diffs + commits)
// ---------------------------------------------------------------------------

function findBranch(scope, name) {
  const list = scope === 'local' ? state && state.local && state.local.branches : state && state.remote && state.remote.branches;
  return (list || []).find((b) => b.name === name) || null;
}

function ensureModal() {
  let overlay = document.querySelector('.modal-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = '<div class="modal"></div>';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  document.body.appendChild(overlay);
  return overlay;
}
function closeModal() {
  const o = document.querySelector('.modal-overlay');
  if (o) o.remove();
}

function renderDiff(patch, truncated) {
  if (!patch) return '<div class="omitted">No textual diff available (binary, empty, or omitted).</div>';
  const lines = patch.split('\n').map((ln) => {
    let cls = 'ctx';
    if (ln.startsWith('@@')) cls = 'hunk';
    else if (ln.startsWith('+') && !ln.startsWith('+++')) cls = 'add';
    else if (ln.startsWith('-') && !ln.startsWith('---')) cls = 'del';
    else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('new file') || ln.startsWith('deleted file') || ln.startsWith('rename ')) cls = 'hunk';
    return `<span class="${cls}">${esc(ln) || '&nbsp;'}</span>`;
  });
  return `<pre class="diff">${lines.join('')}${truncated ? '<span class="more">… diff truncated …</span>' : ''}</pre>`;
}

async function openBranch(scope, name) {
  if (!state) return;
  const b = findBranch(scope, name);
  const overlay = ensureModal();
  const modal = overlay.querySelector('.modal');

  modal.innerHTML = `
    <div class="modal-head">
      <span class="branch-name">${esc(name)}</span>
      <span class="badge ${scope === 'local' ? 'b-current' : 'b-pr'}">${scope}</span>
      <button class="close" title="Close (Esc)">×</button>
    </div>
    <div class="modal-body"><div class="loading"><div class="spinner"></div>Loading changes…</div></div>`;
  modal.querySelector('.close').addEventListener('click', closeModal);

  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(state.project.id)}/branch?scope=${scope}&name=${encodeURIComponent(name)}`);
    const d = await res.json();
    const body = modal.querySelector('.modal-body');
    if (d.error) { body.innerHTML = `<div class="error">${esc(d.error)}</div>`; return; }

    const recHtml = b && b.recommendation ? `<div class="rec lvl-${b.recommendation.level}">${esc(b.recommendation.text)}</div>` : '';
    const descHtml = b ? `<div class="card-desc">${esc(b.description)}</div>` : '';
    const prHtml = d.prNumber ? `<div class="card-desc">Showing the diff for PR #${d.prNumber} (base: ${esc(d.base)}).</div>` : '';

    const commitsHtml = d.commits.length
      ? d.commits.map((c) => `
          <div class="commit">
            <div class="subj">${esc(c.subject)}</div>
            ${c.body ? `<div class="body">${esc(c.body)}</div>` : ''}
            <div class="meta">${esc(c.sha)} · ${esc(c.author)} · ${timeAgo(c.date)}</div>
          </div>`).join('')
      : '<div class="empty">No commits unique to this branch (it is at or behind the default branch).</div>';

    const filesHtml = d.files.length
      ? d.files.map((f) => `
          <div class="file">
            <div class="file-head">
              <span class="chev">▸</span>
              <span class="fstat ${esc(f.status)}">${esc(f.status)}</span>
              <span class="fname">${esc(f.file)}</span>
              <span class="fnums">${f.additions != null ? '+' + f.additions : ''} ${f.deletions != null ? '-' + f.deletions : ''}</span>
            </div>
            ${f.omitted ? '<div class="omitted">Diff omitted (too large or binary).</div>' : renderDiff(f.patch, f.truncated)}
          </div>`).join('')
      : '<div class="empty">No files changed relative to the default branch.</div>';

    body.innerHTML = `
      ${descHtml}${prHtml}${recHtml}
      <div class="detail-section"><h4>Files changed (${d.files.length})</h4>${filesHtml}</div>
      <div class="detail-section"><h4>Commits (${d.commits.length})</h4>${commitsHtml}</div>`;

    body.querySelectorAll('.file-head').forEach((h) =>
      h.addEventListener('click', () => h.parentElement.classList.toggle('open')),
    );
  } catch (e) {
    modal.querySelector('.modal-body').innerHTML = `<div class="error">Failed to load: ${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Actions (push / merge / delete) with confirmation + toast feedback
// ---------------------------------------------------------------------------

let toastTimer = null;
function showToast(kind, text, sticky = false) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); document.body.appendChild(t); }
  t.className = 'toast ' + kind;
  t.textContent = text;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => t.remove(), 6000);
}

async function runAction(act, scope, name) {
  if (readOnly) {
    showToast('info', 'Read-only mode is on — no changes are made. Turn it off to push, rebase, merge, or delete.');
    return;
  }
  const id = state.project.id;

  const b = findBranch(scope, name);
  const conflicts = b && (b.conflictsWithDefault === true || b.mergeable === 'CONFLICTING');

  // How a conflict will be handled, given whether an API key is set.
  const conflictNote = conflicts
    ? (aiAvailable
      ? '\n\n⚠ This is expected to conflict — Claude will attempt to resolve it and summarize what it did (it lands as a local commit you can undo).'
      : '\n\n⚠ This is expected to CONFLICT. It will be aborted and your repo left clean. Set an Anthropic API key to let Claude auto-resolve it.')
    : '';

  let confirmMsg = null;
  if (act === 'delete') confirmMsg = `Delete ${scope} branch "${name}"? This cannot be undone.`;
  else if (act === 'merge') confirmMsg = (scope === 'remote'
    ? `Merge the open PR for "${name}" into ${state.remote.defaultBranch} on GitHub?`
    : `Merge "${name}" into ${state.local.defaultBranch} locally? You will end up on ${state.local.defaultBranch}.`)
    + (scope === 'local' ? conflictNote : '');
  else if (act === 'push') confirmMsg = `Push "${name}" to origin?`;
  else if (act === 'pull') confirmMsg = `Pull "${name}" from origin (fast-forward only)?${scope === 'local' && b && !b.isCurrent ? `\n\n"${name}" will be checked out to pull it.` : ''}`;
  else if (act === 'createPr') confirmMsg = `Open a pull request for "${name}"?${scope === 'local' ? ' It will be pushed to origin first if needed.' : ''}`;
  else if (act === 'checkout') confirmMsg = `Check out "${name}" in the local clone? Your current branch will be switched${scope === 'remote' ? ' (the branch is fetched from origin first)' : ''}.`;
  else if (act === 'rebase') confirmMsg = `Rebase "${name}" onto ${state.local.defaultBranch}? This replays ${name}'s commits on top of the latest ${state.local.defaultBranch}; you will end up on ${name}.`
    + (aiAvailable ? ' If it conflicts, Claude will resolve it and summarize.' : '');
  if (confirmMsg && !window.confirm(confirmMsg)) return;

  const endpoint = act === 'delete' ? 'delete-branch' : act === 'createPr' ? 'create-pr' : act;
  showToast('info', `Running ${act === 'createPr' ? 'open PR' : act} on ${name}…`, true);

  try {
    let res = await fetch(`/api/projects/${encodeURIComponent(id)}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: name, scope }),
    });
    let r = await res.json();

    if (!res.ok && r.needsForce) {
      if (window.confirm(`"${name}" is not fully merged into the default branch. Force-delete anyway (lose unmerged commits)?`)) {
        res = await fetch(`/api/projects/${encodeURIComponent(id)}/delete-branch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch: name, scope, force: true }),
        });
        r = await res.json();
      } else { showToast('info', 'Cancelled.'); return; }
    }

    if (r.readOnly) { setReadOnlyUI(true); loadProject(id); } // server refused: sync the switch

    if (!res.ok || r.ok === false) {
      showToast('err', (r.error || 'Failed') + (r.output ? '\n' + r.output : ''), true);
      return;
    }

    // A conflict resolved by Claude returns a per-file summary — show it sticky
    // so it stays up for review.
    const okText = (r.output || 'Done.') + (r.summary ? '\n\n' + r.summary : '') + (r.note ? '\n' + r.note : '');
    showToast('ok', okText, !!r.resolved);
    if (act === 'createPr' && r.url) window.open(r.url, '_blank', 'noopener');
    await loadProject(id); // re-render tables with fresh state
  } catch (e) {
    showToast('err', 'Error: ' + e.message, true);
  }
}

// PR-level actions from the Open Pull Requests list: review (approve / request
// changes / comment), toggle draft, re-run CI, and check the PR out locally.
async function runPrAction(pract, number, head) {
  if (readOnly) { showToast('info', 'Read-only mode is on — turn it off to act on PRs.'); return; }
  const id = state.project.id;

  let endpoint, body, runningLabel;
  if (pract === 'approve') {
    const note = window.prompt('Optional approval comment (leave blank for none):', '');
    if (note === null) return;
    endpoint = 'pr-review'; body = { number, action: 'approve', body: note }; runningLabel = `approving PR #${number}`;
  } else if (pract === 'request-changes') {
    const note = window.prompt('What changes are you requesting? (required)', '');
    if (note === null) return;
    if (!note.trim()) { showToast('info', 'A comment is required to request changes.'); return; }
    endpoint = 'pr-review'; body = { number, action: 'request-changes', body: note }; runningLabel = `requesting changes on PR #${number}`;
  } else if (pract === 'comment') {
    const note = window.prompt('Review comment (required):', '');
    if (note === null) return;
    if (!note.trim()) { showToast('info', 'Enter a comment first.'); return; }
    endpoint = 'pr-review'; body = { number, action: 'comment', body: note }; runningLabel = `commenting on PR #${number}`;
  } else if (pract === 'ready') {
    if (!window.confirm(`Mark PR #${number} ready for review?`)) return;
    endpoint = 'pr-ready'; body = { number, draft: false }; runningLabel = `marking PR #${number} ready`;
  } else if (pract === 'undraft') {
    if (!window.confirm(`Convert PR #${number} back to a draft?`)) return;
    endpoint = 'pr-ready'; body = { number, draft: true }; runningLabel = `converting PR #${number} to draft`;
  } else if (pract === 'rerun') {
    if (!window.confirm(`Re-run the failed CI jobs for PR #${number}?`)) return;
    endpoint = 'rerun-checks'; body = { branch: head }; runningLabel = `re-running CI for PR #${number}`;
  } else if (pract === 'checkout') {
    if (!window.confirm(`Check out PR #${number} locally? Your current branch will be switched.`)) return;
    endpoint = 'checkout'; body = { prNumber: number }; runningLabel = `checking out PR #${number}`;
  } else { return; }

  showToast('info', `Running: ${runningLabel}…`, true);
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const r = await res.json();
    if (r.readOnly) { setReadOnlyUI(true); loadProject(id); return; }
    if (!res.ok || r.ok === false) { showToast('err', (r.error || 'Failed') + (r.output ? '\n' + r.output : ''), true); return; }
    showToast('ok', (r.output || 'Done.') + (r.note ? '\n' + r.note : ''));
    await loadProject(id);
  } catch (e) { showToast('err', 'Error: ' + e.message, true); }
}

// ---------------------------------------------------------------------------
// "Working on now" tab — Claude Code sessions across all local projects
// ---------------------------------------------------------------------------

const TAB_KEY = 'ghhelper.activeTab';
let activeTab = 'projects';
// Session ids whose "What I'm working on" cell the user expanded — kept so the
// expansion survives the tab's periodic auto-refresh re-render.
const expandedAbout = new Set();

// Auto-refresh state. Heuristic mode polls every 5s (no API cost). Claude mode
// polls every 30s but only while the tab/window is focused, so it won't call
// Claude all night. After 10 consecutive unchanged refreshes we pause until the
// user hits Refresh (so an accidentally-left-open window stops on its own).
const HEURISTIC_MS = 5000;
const CLAUDE_MS = 30000;
const IDLE_PAUSE_AFTER = 10;
let sessionsTimer = null;
let sessionsMode = 'heuristic';
let sessionsLoading = false;
let lastSig = null;
let unchangedCount = 0;
let autoPaused = false;
let sessionsLoadedOnce = false; // have we ever rendered sessions successfully?
let sessionsFailures = 0;       // consecutive fetch failures (for graceful retry)

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('#projects-view').hidden = tab !== 'projects';
  $('#sessions-view').hidden = tab !== 'sessions';
  document.body.classList.toggle('tab-sessions', tab === 'sessions');
  localStorage.setItem(TAB_KEY, tab);
  if (tab === 'sessions') startSessionsAuto();
  else stopSessionsAuto();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

function stopSessionsAuto() {
  if (sessionsTimer) { clearTimeout(sessionsTimer); sessionsTimer = null; }
}

function startSessionsAuto() {
  autoPaused = false;
  unchangedCount = 0;
  loadSessions('init').finally(scheduleNext); // immediate load, then poll
}

function scheduleNext() {
  stopSessionsAuto();
  if (autoPaused || activeTab !== 'sessions') return;
  const interval = sessionsMode === 'claude' ? CLAUDE_MS : HEURISTIC_MS;
  sessionsTimer = setTimeout(sessionsTick, interval);
}

function sessionsTick() {
  // In Claude mode, skip the fetch when the window isn't focused — re-check on
  // the next tick instead of spending a Claude call on an unattended window.
  if (sessionsMode === 'claude' && !document.hasFocus()) { scheduleNext(); return; }
  loadSessions('auto').finally(scheduleNext);
}

function sessionSignature(list) {
  return JSON.stringify((list || []).map((s) => [s.sessionId, s.finishedAt, s.status, s.about, s.lastCommand]));
}

async function loadSessions(reason) {
  if (sessionsLoading) return;
  sessionsLoading = true;
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sessionsMode = data.summarySource === 'claude' ? 'claude' : 'heuristic';
    renderSessions(data);
    sessionsLoadedOnce = true;
    sessionsFailures = 0;

    const sig = sessionSignature(data.sessions);
    if (reason === 'auto') {
      if (sig === lastSig) {
        if (++unchangedCount >= IDLE_PAUSE_AFTER) { autoPaused = true; stopSessionsAuto(); }
      } else {
        unchangedCount = 0;
      }
    } else {
      unchangedCount = 0; // manual/init always resets the idle counter
      autoPaused = false;
    }
    lastSig = sig;
    updateSessionsStatus(data);
  } catch (e) {
    sessionsFailures++;
    // "Failed to fetch" means the server was briefly unreachable (e.g. it was
    // restarting or updating). Don't wipe a working view over a transient blip —
    // keep it, show a quiet "reconnecting" status, and let the poll retry. Only
    // fall back to a full error if we never loaded, or after several failures.
    if (sessionsLoadedOnce && sessionsFailures < 4) {
      const el = $('#sessions-status');
      if (el) el.innerHTML = `<span class="dot paused"></span>Lost connection to the dashboard — retrying… <span class="muted">(attempt ${sessionsFailures})</span>`;
    } else {
      $('#sessions-content').innerHTML = `<div class="error">Failed to load sessions: ${esc(e.message)}. Retrying…</div>`;
    }
  } finally {
    sessionsLoading = false;
  }
}

function updateSessionsStatus(data) {
  const n = (data.sessions || []).length;
  const el = $('#sessions-status');
  if (autoPaused) {
    el.innerHTML = `<span class="dot paused"></span>Auto-refresh paused — nothing changed for a while. Hit <strong>Refresh</strong> to resume. <span class="muted">· ${n} session(s)</span>`;
    return;
  }
  const mode = sessionsMode === 'claude'
    ? 'AI summaries on · refreshing every 30s while focused'
    : 'heuristic summaries · refreshing every 5s';
  el.innerHTML = `<span class="dot live"></span>${mode} <span class="muted">· ${n} session(s)</span>`;
}

function sessionHead() {
  return `<thead><tr>
    <th>Project</th><th>What I’m working on</th><th>Last command</th><th>Status</th><th>Finished</th>
  </tr></thead>`;
}

function sessionRow(s) {
  const running = s.status === 'running';
  const statusBadge = running
    ? '<span class="badge s-running">● running</span>'
    : '<span class="badge s-done">✓ done</span>';
  const finished = running ? '<span class="s-active">active now</span>' : timeAgo(s.finishedAt);
  const aiSub = s.aiTitle && s.aiTitle !== s.about ? `<div class="about-sub">${esc(s.aiTitle)}</div>` : '';
  // Clamp the summary to 4 lines unless the user has expanded this row.
  const clamp = expandedAbout.has(s.sessionId) ? '' : 'clamped';
  return `
    <tr class="${running ? 'lvl-ok' : 'lvl-info'}">
      <td class="col-proj" title="${esc(s.projectPath)}">${esc(s.project)}</td>
      <td class="col-about"><div class="about-text ${clamp}" data-sid="${esc(s.sessionId)}">${esc(s.about || '—')}</div>${aiSub}</td>
      <td class="col-lastcmd">${esc(s.lastCommand || '')}</td>
      <td class="col-status">${statusBadge}</td>
      <td class="col-finished">${finished}</td>
    </tr>`;
}

function renderSessions(data) {
  const list = data.sessions || [];
  const el = $('#sessions-content');
  if (!list.length) {
    el.innerHTML = '<div class="empty">No sessions you have typed into in the last 14 days.</div>';
    return;
  }
  el.innerHTML = `<table class="branch-table session-table">${sessionHead()}<tbody>${list.map(sessionRow).join('')}</tbody></table>`;
  markTruncatedAbouts();
}

// Flag clamped summaries that actually overflow 4 lines, so only those get the
// click-to-expand affordance (cursor + hover hint).
function markTruncatedAbouts() {
  document.querySelectorAll('#sessions-content .about-text.clamped').forEach((el) => {
    el.classList.toggle('truncated', el.scrollHeight - el.clientHeight > 2);
  });
}

// Click a summary to expand it to full text (and click again to re-clamp).
$('#sessions-content').addEventListener('click', (e) => {
  const about = e.target.closest('.about-text');
  if (!about) return;
  const sid = about.dataset.sid;
  if (about.classList.contains('clamped')) {
    about.classList.remove('clamped', 'truncated');
    if (sid) expandedAbout.add(sid);
  } else {
    about.classList.add('clamped');
    if (sid) expandedAbout.delete(sid);
    about.classList.toggle('truncated', about.scrollHeight - about.clientHeight > 2);
  }
});

// Manual refresh: bust the server-side caches, reset the idle counter, reload.
$('#sessions-refresh').addEventListener('click', async () => {
  autoPaused = false;
  unchangedCount = 0;
  await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
  loadSessions('manual').finally(scheduleNext);
});

// ---------------------------------------------------------------------------
// Settings: optional Anthropic API key for AI-written summaries
// ---------------------------------------------------------------------------

const settingsPanel = $('#settings-panel');
const apiKeyInput = $('#api-key-input');
const settingsNote = $('#settings-note');

$('#settings-btn').addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  if (!settingsPanel.hidden) loadSettings();
});

async function loadSettings() {
  try {
    const s = await (await fetch('/api/settings')).json();
    renderSettingsNote(s);
  } catch { /* ignore */ }
}

function renderSettingsNote(s) {
  if (s.hasApiKey) {
    settingsNote.textContent = s.source === 'env'
      ? 'A key is set via the ANTHROPIC_API_KEY environment variable — AI summaries are on.'
      : 'A key is saved — AI summaries are on.';
    apiKeyInput.placeholder = '•••••• key saved — type to replace';
  } else {
    settingsNote.textContent = 'No key set — using the built-in heuristic (free, refreshes every 5s).';
    apiKeyInput.placeholder = 'sk-ant-…';
  }
}

async function saveApiKey(value, okMsg) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicApiKey: value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    apiKeyInput.value = '';
    renderSettingsNote(s);
    showToast(s.hasApiKey ? 'ok' : 'info', okMsg);
    autoPaused = false;
    unchangedCount = 0;
    await fetch('/api/refresh', { method: 'POST' }).catch(() => {});
    loadSessions('manual').finally(scheduleNext);
  } catch (e) {
    showToast('err', 'Could not update the API key: ' + e.message);
  }
}

$('#api-key-save').addEventListener('click', () => {
  const v = apiKeyInput.value.trim();
  if (!v) { showToast('info', 'Enter a key first, or use Clear to remove the saved one.'); return; }
  saveApiKey(v, 'API key saved — summaries will now use Claude.');
});
$('#api-key-clear').addEventListener('click', () => saveApiKey('', 'API key cleared — using the heuristic.'));

// ---------------------------------------------------------------------------
// Background auto-fetch — keep ahead/behind counts live for the open project
// ---------------------------------------------------------------------------
// Mirrors GitHub Desktop: every 10 min the selected local project is fetched and
// its status quietly re-rendered. Fetch is one-way-safe (it only updates remote-
// tracking refs), so this runs regardless of read-only. We skip it when the tab
// is in the background or the window is unfocused, so an idle window stays quiet.

const AUTO_FETCH_MS = 10 * 60 * 1000;
let autoFetching = false;

async function autoFetchTick() {
  if (autoFetching) return;
  if (activeTab !== 'projects') return;
  if (!document.hasFocus()) return;
  if (!state || !state.project || !state.project.hasLocal) return;
  const id = state.project.id;
  autoFetching = true;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/fetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const r = await res.json().catch(() => ({}));
    if (res.ok && r.ok !== false) {
      lastFetched[id] = Date.now();
      // Only re-render if the user is still on the same project.
      if (state && state.project && state.project.id === id) await loadProject(id, { silent: true });
    }
  } catch { /* ignore transient fetch errors */ } finally {
    autoFetching = false;
  }
}

setInterval(autoFetchTick, AUTO_FETCH_MS);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadProjects();

// Re-enable notifications if they were on and the browser still grants permission.
if (localStorage.getItem(NOTIFY_KEY) && 'Notification' in window && Notification.permission === 'granted') {
  setNotify(true);
}

const initialTab = new URLSearchParams(location.search).get('tab')
  || (location.hash === '#sessions' ? 'sessions' : null)
  || localStorage.getItem(TAB_KEY)
  || 'projects';
setTab(initialTab === 'sessions' ? 'sessions' : 'projects');
