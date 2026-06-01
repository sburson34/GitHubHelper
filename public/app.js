'use strict';

const $ = (sel) => document.querySelector(sel);
const content = $('#content');
const rootInfo = $('#root-info');
const refreshBtn = $('#refresh-btn');
const searchInput = $('#project-search');
const listEl = $('#project-list');

const STORAGE_KEY = 'ghhelper.selectedProject';

let allProjects = []; // full project list for the combobox
let selectedId = null; // currently selected project id
let activeIdx = -1; // keyboard-highlighted item in the combo list
let showAll = false; // when true, the combo shows every project (just focused)
let state = null; // { project, local, remote } for the selected project

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
  rootInfo.textContent = `Scanning ${data.root} · ${allProjects.length} projects (${allProjects.filter((p) => p.hasLocal).length} local)`;

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

  if (scope === 'local') {
    return {
      push: !b.hasUpstream || b.ahead > 0,
      pushReason: !b.hasUpstream ? 'no upstream — push to create it' : b.ahead > 0 ? `${b.ahead} unpushed commit(s)` : 'nothing to push',
      merge: !b.isDefault && b.aheadOfDefault > 0 && wtClean,
      mergeLabel: `Merge → ${def}`,
      mergeReason: b.isDefault ? 'this is the default branch' : b.aheadOfDefault <= 0 ? 'no commits ahead of default' : !wtClean ? 'working tree is dirty' : `merge into ${def} locally`,
      del: isCleanup,
      delReason: isCleanup ? 'delete this branch' : 'only when recommendation is "delete"',
    };
  }
  return {
    push: false,
    pushReason: 'remote branch — already on GitHub',
    merge: !!b.pr,
    mergeLabel: b.pr ? `Merge PR #${b.pr.number}` : 'Merge PR',
    mergeReason: b.pr ? `merge PR #${b.pr.number}` : 'no open PR for this branch',
    del: isCleanup,
    delReason: isCleanup ? 'delete this remote branch' : 'only when recommendation is "delete"',
  };
}

function actionsCell(scope, b) {
  const a = actionAvailability(scope, b);
  const btn = (act, cls, label, enabled, reason) =>
    `<button class="row-action ${cls}" data-act="${act}" data-scope="${scope}" data-name="${esc(b.name)}" ${enabled ? '' : 'disabled'} title="${esc(reason)}">${label}</button>`;
  return (
    btn('push', 'push', '⬆ Push', a.push, a.push ? a.pushReason : a.pushReason) +
    btn('merge', 'merge', '⛙ Merge', a.merge, a.mergeReason) +
    btn('delete', 'delete', '🗑 Delete', a.del, a.delReason)
  );
}

// ---------------------------------------------------------------------------
// Render a project's status as tables
// ---------------------------------------------------------------------------

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
  return out.join(' ');
}

function remoteBadges(b) {
  const out = [];
  if (b.isDefault) out.push(badge('b-default', 'default'));
  if (b.protected) out.push(badge('b-protected', 'protected'));
  if (b.pr) out.push(badge('b-pr', `PR #${b.pr.number}`));
  if (!b.isDefault && b.aheadBy > 0) out.push(badge('b-ahead', `${b.aheadBy}↑`));
  if (!b.isDefault && b.behindBy > 0) out.push(badge('b-ahead', `${b.behindBy}↓`));
  return out.join(' ');
}

function commitCell(c) {
  c = c || {};
  return `<div>${esc(c.sha || '')} ${esc((c.subject || '').slice(0, 60))}</div><div>${esc(c.author || '')} · ${timeAgo(c.date)}</div>`;
}

function branchRow(scope, b, badgesHtml) {
  const lvl = b.recommendation ? b.recommendation.level : 'info';
  return `
    <tr class="lvl-${lvl}">
      <td><a class="branch-link" data-scope="${scope}" data-name="${esc(b.name)}">${esc(b.name)}</a></td>
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
    const summary = wt.clean
      ? '✓ Working tree clean — nothing uncommitted.'
      : `⚠ ${wt.count} uncommitted change(s) on <strong>${esc(local.currentBranch)}</strong> — ${wt.staged} staged, ${wt.unstaged} unstaged, ${wt.untracked} untracked.`;
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

function prRow(p) {
  const review = p.reviewDecision ? ` · ${p.reviewDecision.replace('_', ' ').toLowerCase()}` : '';
  const draft = p.isDraft ? ' · draft' : '';
  return `
    <div class="pr-row">
      <a href="${esc(p.url)}" target="_blank" rel="noopener">#${p.number} ${esc(p.title)}</a>
      <span class="meta">${esc(p.headRefName)} → ${esc(p.baseRefName)} · +${p.additions ?? '?'}/-${p.deletions ?? '?'} in ${p.changedFiles ?? '?'} files${review}${draft} · ${timeAgo(p.createdAt)}</span>
    </div>`;
}

async function loadProject(id) {
  if (!id) {
    content.innerHTML = '<div class="placeholder"><p>Search for and select a project to see the full status of its branches.</p></div>';
    return;
  }
  content.innerHTML = '<div class="loading"><div class="spinner"></div>Gathering branch status…</div>';

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

    content.innerHTML = `
      <div class="proj-header">
        <h2>${esc(p.label)}</h2>
        ${links.join('')}
      </div>
      <div class="proj-meta">${metaBits.join(' · ')}</div>
      ${renderLocal(data.local)}
      ${renderRemote(data.remote)}
      ${!data.local && !data.remote ? '<div class="empty">No status available for this project.</div>' : ''}
    `;
  } catch (e) {
    content.innerHTML = `<div class="error">Failed to load project: ${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Delegated clicks: branch name → detail modal; action button → runAction
// ---------------------------------------------------------------------------

content.addEventListener('click', (e) => {
  const link = e.target.closest('.branch-link');
  if (link) { openBranch(link.dataset.scope, link.dataset.name); return; }
  const act = e.target.closest('.row-action');
  if (act && !act.disabled) runAction(act.dataset.act, act.dataset.scope, act.dataset.name);
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
  const id = state.project.id;

  let confirmMsg = null;
  if (act === 'delete') confirmMsg = `Delete ${scope} branch "${name}"? This cannot be undone.`;
  else if (act === 'merge') confirmMsg = scope === 'remote'
    ? `Merge the open PR for "${name}" into ${state.remote.defaultBranch} on GitHub?`
    : `Merge "${name}" into ${state.local.defaultBranch} locally? You will end up on ${state.local.defaultBranch}.`;
  else if (act === 'push') confirmMsg = `Push "${name}" to origin?`;
  if (confirmMsg && !window.confirm(confirmMsg)) return;

  const endpoint = act === 'delete' ? 'delete-branch' : act;
  showToast('info', `Running ${act} on ${name}…`, true);

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

    if (!res.ok || r.ok === false) {
      showToast('err', (r.error || 'Failed') + (r.output ? '\n' + r.output : ''), true);
      return;
    }

    showToast('ok', (r.output || 'Done.') + (r.note ? '\n' + r.note : ''));
    await loadProject(id); // re-render tables with fresh state
  } catch (e) {
    showToast('err', 'Error: ' + e.message, true);
  }
}

loadProjects();
