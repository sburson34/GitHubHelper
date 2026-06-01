'use strict';

/**
 * Claude-driven merge/rebase conflict resolution.
 *
 * When a merge or rebase leaves conflicts, the server hands the currently
 * conflicted files here. For each one we ask Claude to produce the fully
 * resolved file (integrating both sides' intent, no markers left). If Claude
 * resolves every file we stage them and the caller completes the operation; if
 * Claude judges any file too ambiguous — or the file is binary / too large / a
 * non-content (rename/delete) conflict — we bail so the caller aborts and leaves
 * the repo clean. The user explicitly prefers "let Claude resolve and summarize,
 * only ask me when it really can't decide" — so the bail path is the exception.
 */

const fs = require('fs');
const path = require('path');
const { getApiKey } = require('./sessions');

const MODEL = 'claude-sonnet-4-6';
const MAX_FILES = 20;                 // beyond this, bail — too big to auto-resolve
const MAX_FILE_BYTES = 48 * 1024;     // ~12k output tokens; bigger files bail
const MAX_TOKENS = 16000;
const REQUEST_TIMEOUT_MS = 90 * 1000;

const BEGIN = '---BEGIN RESOLVED FILE---';
const END = '---END RESOLVED FILE---';
// A conflict marker at the start of a line (7 of < = >).
const MARKER_RE = /^(<{7}|={7}|>{7})/m;
const NUL = String.fromCharCode(0); // for a cheap binary-file check

function hasApiKey() {
  return !!getApiKey();
}

function buildPrompt({ file, content, ours, theirs, operation }) {
  return [
    `You are resolving a git ${operation} conflict in the file \`${file}\`.`,
    `The current branch side ("ours") is \`${ours}\`; the incoming side ("theirs") is \`${theirs}\`.`,
    'Below is the file exactly as git left it, with conflict markers',
    '(<<<<<<<, =======, >>>>>>>). Produce the correct fully-merged file that',
    "integrates the intent of BOTH sides. Keep the code valid and don't drop",
    'functionality from either side. Remove every conflict marker.',
    '',
    'If — and only if — the two sides make genuinely contradictory semantic',
    'changes that you cannot safely reconcile without a human decision, do NOT',
    'guess: reply with CANNOT_RESOLVE and explain the conflict.',
    '',
    'Reply in EXACTLY this format and nothing else:',
    '',
    'DECISION: RESOLVED        (or: DECISION: CANNOT_RESOLVE)',
    'EXPLANATION: <one or two sentences: what you merged, or why you cannot>',
    `${BEGIN}`,
    '<the full resolved file content — omit this block entirely if CANNOT_RESOLVE>',
    `${END}`,
    '',
    `----- ${file} (with conflict markers) -----`,
    content,
  ].join('\n');
}

function parseResponse(text) {
  const decision = /DECISION:\s*(RESOLVED|CANNOT_RESOLVE)/i.exec(text);
  const expMatch = /EXPLANATION:\s*(.+?)(?:\n*---BEGIN|\n*$)/is.exec(text);
  const explanation = expMatch ? expMatch[1].replace(/\s+/g, ' ').trim() : '';

  if (decision && /CANNOT/i.test(decision[1])) {
    return { resolved: false, reason: explanation || 'Claude judged it too ambiguous to resolve safely' };
  }
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    return { resolved: false, reason: explanation || 'Claude did not return a resolved file' };
  }
  let body = text.slice(begin + BEGIN.length, end);
  body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, ''); // drop the fence newlines
  if (MARKER_RE.test(body)) {
    return { resolved: false, reason: 'the proposed resolution still contained conflict markers' };
  }
  return { resolved: true, content: body, explanation: explanation || 'merged both sides' };
}

async function resolveFile(params) {
  const key = getApiKey();
  if (!key) return { resolved: false, reason: 'no API key set' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: buildPrompt(params) }],
      }),
    });
    if (!res.ok) {
      return { resolved: false, reason: `Claude API error ${res.status}` };
    }
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    return parseResponse(text);
  } catch (e) {
    return { resolved: false, reason: 'Claude request failed: ' + (e.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve every currently-conflicted file in `dir`, staging each as it goes.
 *  - `git` is a function bound to the repo: (...args) => Promise<{ok,stdout,...}>.
 *  - Returns { ok: true, files: [{file, explanation}] } when all are resolved,
 *    or { ok: false, bail: true, file?, reason } when the caller should abort.
 */
async function resolveCurrentConflicts({ dir, git, ours, theirs, operation }) {
  const u = await git('diff', '--name-only', '--diff-filter=U');
  const files = u.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!files.length) return { ok: false, bail: true, reason: 'no conflicted files were found' };
  if (files.length > MAX_FILES) {
    return { ok: false, bail: true, reason: `${files.length} files conflict — too many to auto-resolve safely` };
  }

  const resolved = [];
  for (const file of files) {
    const abs = path.join(dir, file);
    let content;
    try {
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE_BYTES) {
        return { ok: false, bail: true, file, reason: `${file} is too large (${Math.round(st.size / 1024)} KB) to auto-resolve` };
      }
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      return { ok: false, bail: true, file, reason: `could not read ${file}` };
    }
    if (content.indexOf(NUL) !== -1) {
      return { ok: false, bail: true, file, reason: `${file} appears to be binary` };
    }
    if (!MARKER_RE.test(content)) {
      // Unmerged but no text markers → rename/delete/add-add: needs a human.
      return { ok: false, bail: true, file, reason: `${file} is a rename/delete conflict, not a text conflict` };
    }

    const r = await resolveFile({ file, content, ours, theirs, operation });
    if (!r.resolved) {
      return { ok: false, bail: true, file, reason: r.reason || `Claude could not resolve ${file}` };
    }
    try {
      fs.writeFileSync(abs, r.content);
    } catch {
      return { ok: false, bail: true, file, reason: `could not write the resolved ${file}` };
    }
    const add = await git('add', '--', file);
    if (!add.ok) {
      return { ok: false, bail: true, file, reason: `git add failed for ${file}` };
    }
    resolved.push({ file, explanation: r.explanation });
  }

  return { ok: true, files: resolved };
}

module.exports = { hasApiKey, resolveCurrentConflicts, MODEL };
