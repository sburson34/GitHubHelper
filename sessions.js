'use strict';

/**
 * "Working on now" — scans the local Claude Code session transcripts under
 * ~/.claude/projects and summarizes each session: what it is about, what the
 * last command was for, whether it is still running or done, and (for done
 * ones) how recently it finished.
 *
 * This is a pure read over local transcript files — it never writes to git or
 * GitHub, so it sits comfortably inside the dashboard's read-only, one-way
 * ethos. The only thing it ever writes is the optional API key the user types
 * into Settings (a local config file, not a git/GitHub mutation), which is why
 * that write is intentionally outside the read-only gate in server.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Only show sessions touched within this window (most-recent-first).
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// A transcript written this recently is actively being generated → "running".
const ACTIVE_MS = 90 * 1000;
// A session that a live CLI window is *probably* attached to, but sitting idle
// at a prompt, can be older than ACTIVE_MS — still treat the most-recent ones
// as running, but only within this sanity window.
const IDLE_WINDOW_MS = 30 * 60 * 1000;
// Server-side scan cache. Short, so the heuristic auto-refresh (every ~5s) sees
// fresh data while bursts of duplicate calls (rapid tab toggles) still coalesce.
const CACHE_MS = 2500;

const CONFIG_DIR = path.join(os.homedir(), '.githubhelper');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ---------------------------------------------------------------------------
// Small concurrency cap (same shape as server.js's mapLimit; kept local so this
// module stays self-contained and avoids a circular require on server.js).
// ---------------------------------------------------------------------------
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 0 }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// API key settings (env wins; otherwise a local config file)
// ---------------------------------------------------------------------------
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function getApiKey() {
  const env = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (env) return env;
  const fromFile = (readConfig().anthropicApiKey || '').trim();
  return fromFile || null;
}

function getSettingsInfo() {
  const env = (process.env.ANTHROPIC_API_KEY || '').trim();
  const fromFile = (readConfig().anthropicApiKey || '').trim();
  return {
    hasApiKey: !!(env || fromFile),
    source: env ? 'env' : fromFile ? 'file' : null,
  };
}

/** Save (or, with an empty value, clear) the API key in the local config file.
 *  Never touches the environment variable. Returns the new settings info. */
function setApiKey(value) {
  const cfg = readConfig();
  const v = (value || '').trim();
  if (v) cfg.anthropicApiKey = v;
  else delete cfg.anthropicApiKey;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  invalidate(); // force the next scan to re-summarize under the new key
  return getSettingsInfo();
}

// ---------------------------------------------------------------------------
// Transcript text cleaning + heuristic focus
// ---------------------------------------------------------------------------

// Strip the wrappers Claude Code adds around slash-commands and injected
// context so the heuristic sees what the human actually meant to say.
function cleanPromptText(raw) {
  let s = String(raw || '');
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  s = s.replace(/<local-command-std(out|err)>[\s\S]*?<\/local-command-std(out|err)>/gi, ' ');
  // A slash-command carries its real intent in <command-args>; prefer that
  // (and drop the command name itself — the args are what the user meant).
  const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  if (args && args[1].trim()) {
    s = args[1].trim();
  } else {
    s = s.replace(/<command-(name|message|args)>[\s\S]*?<\/command-(name|message|args)>/gi, ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Short replies and bare confirmations are answers to the assistant's
// questions, not the task itself — skip them when divining current focus.
const SKIP_RE = /^(y|n|yes|no|ok(ay)?|sure|yep|nope|do it|go ahead|continue|proceed|stop|thanks?|please|the (first|second|third|last|other) one|that one|option \d+|\d+|[a-c])\.?$/i;

function isSkippable(text) {
  const t = text.trim();
  if (t.length < 25) return true;
  return SKIP_RE.test(t);
}

// From the cleaned user prompts, surface the most recent substantive one — the
// prompt that actually drove the work (i.e. the one that spawned the questions),
// not the short answers that followed it.
function deriveFocus(prompts, aiTitle) {
  const recent = prompts.slice(-10);
  for (let i = recent.length - 1; i >= 0; i--) {
    if (!isSkippable(recent[i])) return recent[i];
  }
  if (aiTitle) return aiTitle;
  return prompts.length ? prompts[prompts.length - 1] : '';
}

// ---------------------------------------------------------------------------
// LLM summary (only when an API key is configured; falls back to heuristic)
// ---------------------------------------------------------------------------
const llmCache = new Map(); // sessionId -> { stamp: lastActivity, summary }

async function summarizeWithClaude(prompts, key) {
  const recent = prompts.filter((p) => !isSkippable(p)).slice(-10);
  if (!recent.length) return null;
  const list = recent.map((p, i) => `${i + 1}. ${p.slice(0, 500)}`).join('\n');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{
          role: 'user',
          content:
            'Below are the most recent things a developer typed into a coding session ' +
            '(trivial one-word replies already removed). In ONE short sentence (max ~12 words), ' +
            'say what they are currently working on. Reply with only that sentence, no preamble.\n\n' + list,
        }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content || []).map((b) => b.text || '').join('').trim();
    return text || null;
  } catch {
    return null; // network/timeout/abort — caller falls back to the heuristic
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Live-process scan (best effort) — find which sessions are open right now
// ---------------------------------------------------------------------------
// Two kinds of live Claude processes exist on Windows:
//   • node.exe running claude-agent-sdk\cli.js … --session-id <uuid>
//       → carries the exact session id, so we can mark that session precisely.
//   • claude.exe (…\claude-code\bin\claude.exe)
//       → the interactive terminal CLI. It exposes NO cwd and NO session id, so
//         all we can learn is *how many* are open. We use that count to mark the
//         top-N most-recently-active sessions as running (see computeStatus).
// Limitation: the count→session mapping is a heuristic (a CLI window can't be
// tied to a specific transcript from its command line), bounded by IDLE_WINDOW_MS.
function scanLiveProcesses() {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='claude.exe'\" " +
      '| Select-Object Name,CommandLine | ConvertTo-Json -Compress';
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024 * 8 },
      (err, stdout) => {
        const out = { sessionIds: new Set(), cliCount: 0 };
        if (err || !stdout) return resolve(out);
        let rows;
        try { rows = JSON.parse(stdout); } catch { return resolve(out); }
        if (!Array.isArray(rows)) rows = [rows];
        for (const r of rows) {
          const cl = r && r.CommandLine ? String(r.CommandLine) : '';
          const name = (r && r.Name ? String(r.Name) : '').toLowerCase();
          // Interactive Claude Code CLI windows.
          if (name === 'claude.exe' && /claude-code[\\/]bin/i.test(cl)) { out.cliCount++; continue; }
          // SDK/ACP agents expose --session-id <uuid>: an exact match.
          const m = cl.match(/--session-id[ =]([0-9a-fA-F-]{36})/);
          if (m && /claude/i.test(cl)) out.sessionIds.add(m[1].toLowerCase());
        }
        resolve(out);
      });
  });
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

// Reverse the ~/.claude/projects folder encoding for a display fallback only —
// it is lossy (it can't tell '\' from '.' or a literal '-'), so we prefer the
// real `cwd` recorded inside the transcript whenever one is present.
function decodeFolder(name) {
  let s = name.replace(/^([A-Za-z])--/, '$1:\\');
  s = s.replace(/-/g, '\\');
  return s;
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ');
  }
  return '';
}

// Parse one transcript file into the fields we need. Tolerant of bad lines.
function parseTranscript(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }

  const prompts = []; // cleaned external user prompts, in order
  let lastActivity = ''; // max ISO timestamp seen (ISO-8601 UTC sorts lexically)
  let lastTool = null; // { name, description, command }
  let aiTitle = '';
  let cwd = '';

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.timestamp && rec.timestamp > lastActivity) lastActivity = rec.timestamp;
    if (rec.cwd && !cwd) cwd = rec.cwd;
    if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;

    if (rec.type === 'user' && rec.userType === 'external' && rec.message) {
      const cleaned = cleanPromptText(extractText(rec.message.content));
      if (cleaned) prompts.push(cleaned);
    }

    if (rec.type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
      for (const block of rec.message.content) {
        if (block && block.type === 'tool_use') {
          const input = block.input || {};
          lastTool = {
            name: block.name || 'tool',
            description: input.description || '',
            command: input.command || input.cmd || '',
          };
        }
      }
    }
  }

  if (!prompts.length) return null; // user never typed anything → skip
  return { prompts, lastActivity, lastTool, aiTitle, cwd };
}

function lastCommandText(t) {
  if (!t.lastTool) {
    // No tool call yet — fall back to the most recent thing the user asked.
    const p = t.prompts[t.prompts.length - 1] || '';
    return p.slice(0, 140);
  }
  const { name, description, command } = t.lastTool;
  if (description) return `${name}: ${description}`;
  if (command) return `${name}: ${command.replace(/\s+/g, ' ').slice(0, 120)}`;
  return name;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
let scanCache = { ts: 0, data: null };
function invalidate() { scanCache = { ts: 0, data: null }; }

async function scanSessions() {
  const now = Date.now();
  if (scanCache.data && now - scanCache.ts < CACHE_MS) return scanCache.data;

  const key = getApiKey();
  const summarySource = key ? 'claude' : 'heuristic';

  // 1. Collect candidate transcripts (top-level *.jsonl only; skip subagents),
  //    pre-filtered to the time window by mtime so we never read stale files.
  const candidates = [];
  let projectFolders = [];
  try {
    projectFolders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory());
  } catch {
    projectFolders = []; // no ~/.claude/projects yet
  }

  for (const folder of projectFolders) {
    const dir = path.join(PROJECTS_DIR, folder.name);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, e.name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (now - stat.mtimeMs > WINDOW_MS) continue; // outside the 14-day window
      candidates.push({
        file,
        folder: folder.name,
        mtimeMs: stat.mtimeMs,
        sessionId: e.name.replace(/\.jsonl$/i, '').toLowerCase(),
      });
    }
  }

  // 2. Parse transcripts + scan live processes concurrently.
  const [parsed, live] = await Promise.all([
    mapLimit(candidates, 8, async (c) => {
      const t = parseTranscript(c.file);
      return t ? { ...c, ...t } : null;
    }),
    scanLiveProcesses(),
  ]);

  let sessions = parsed.filter(Boolean).filter((s) => {
    // Final window check against the transcript's own last activity if present.
    if (!s.lastActivity) return now - s.mtimeMs <= WINDOW_MS;
    return now - new Date(s.lastActivity).getTime() <= WINDOW_MS;
  });

  // Most-recent-first.
  sessions.sort((a, b) => {
    const at = a.lastActivity ? new Date(a.lastActivity).getTime() : a.mtimeMs;
    const bt = b.lastActivity ? new Date(b.lastActivity).getTime() : b.mtimeMs;
    return bt - at;
  });

  // 3. Status. Precise where a live process exposes the session id; otherwise
  //    the top `cliCount` most-recent sessions (within IDLE_WINDOW_MS) stand in
  //    for the open interactive CLI windows.
  let cliSlots = live.cliCount;
  const rows = sessions.map((s, idx) => {
    const finishedAt = s.lastActivity || new Date(s.mtimeMs).toISOString();
    const age = now - new Date(finishedAt).getTime();
    let running = false;
    if (live.sessionIds.has(s.sessionId)) running = true;
    else if (age <= ACTIVE_MS) running = true;
    else if (cliSlots > 0 && age <= IDLE_WINDOW_MS) { running = true; cliSlots--; }

    const projectPath = s.cwd || decodeFolder(s.folder);
    return {
      sessionId: s.sessionId,
      project: projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath,
      projectPath,
      about: key ? null : deriveFocus(s.prompts, s.aiTitle), // LLM fills in below
      aiTitle: s.aiTitle || '',
      lastCommand: lastCommandText(s),
      status: running ? 'running' : 'done',
      finishedAt,
      _prompts: s.prompts, // internal, stripped before returning
    };
  });

  // 4. LLM summaries (cached by sessionId + lastActivity so unchanged sessions
  //    never re-call). On any failure we keep the heuristic focus.
  if (key) {
    await mapLimit(rows, 5, async (r) => {
      const cached = llmCache.get(r.sessionId);
      if (cached && cached.stamp === r.finishedAt) { r.about = cached.summary; return; }
      const summary = await summarizeWithClaude(r._prompts, key);
      const value = summary || deriveFocus(r._prompts, r.aiTitle);
      llmCache.set(r.sessionId, { stamp: r.finishedAt, summary: value });
      r.about = value;
    });
  }

  for (const r of rows) delete r._prompts;

  const data = { sessions: rows, generatedAt: new Date().toISOString(), summarySource, hasApiKey: !!key };
  scanCache = { ts: now, data };
  return data;
}

module.exports = { scanSessions, getSettingsInfo, setApiKey, invalidate, getApiKey };
