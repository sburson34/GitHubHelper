# GitHubHelper

A localhost dashboard that gives a complete picture of the status of every code change across your projects — both the repos checked out on your machine and your repos on GitHub.

Pick a project and you get, per branch: a plain-language summary of the change, whether it's committed / pushed / merged, how far it's ahead or behind, the latest commit, and a **recommendation for what to do next** — plus one-click **Push / Merge / Delete** actions and a click-through view of every file changed with its diff.

## Features

- **One searchable picker** for every project — local checkouts and your GitHub repos, merged into a single list.
- **Per-branch table** with columns for state (badges), change summary, last commit, recommendation, and actions.
- **Click any row** to open a detail view: files changed, per-file diffs, and the commits unique to that branch. For a branch with an open PR, it shows the PR's own diff.
- **Inline actions**, gated by the recommendation so you only see what's safe:
  - **Push** a local branch that has unpushed commits.
  - **Merge** a local branch into the default branch, or merge a branch's open PR on GitHub.
  - **Delete** a merged / stale branch (local or remote).
- **Recommendations** like *"Push 1 unpushed commit, then open a PR"*, *"Merged into main — safe to delete"*, *"PR #78 open — get it reviewed & merged"*.
- **Read-only mode** (a header toggle, **on by default**): while on, the dashboard only reads and reports — every push / merge / delete is refused, both in the UI and at the server. It's a one-way gate (git/GitHub → dashboard, never the reverse) and resets to on at every restart.
- **"Working on now" tab**: scans your local Claude Code session transcripts (`~/.claude/projects`) and shows what each session is about, its last command, whether it's still running or done, and how recently it finished — a quick view of what you have in flight.

The **branch-status analysis is rule-based** — no AI, no API key. The only optional AI is in the "Working on now" tab: if you provide an Anthropic API key it writes nicer session summaries via the Claude API; without one it falls back to a built-in heuristic.

## Requirements

On whatever machine you run it:

- **[git](https://git-scm.com/)** — required for the local half (scanning repos, branch status, pushing).
- **[GitHub CLI (`gh`)](https://cli.github.com/)**, authenticated once with `gh auth login` — required for the GitHub half (remote branches, PRs, and the merge-PR / delete-remote / push actions).
- **[Node.js](https://nodejs.org/) 20+** — only if you run from source or build the executable. **Not needed** to run the prebuilt `.exe`.
- **An Anthropic API key** — *optional*, only to get AI-written summaries in the "Working on now" tab. Set it in **Settings** in that tab, or via the `ANTHROPIC_API_KEY` env var.

> The dashboard can only show the local branches of repos that physically live on the machine it runs on — it shells out to `git`/`gh` there. The GitHub half works from anywhere you're signed in.

## Quick start (no source, no Node)

### Easiest — the launcher (auto-downloads, self-updates)

1. From the [latest release](https://github.com/sburson34/GitHubHelper/releases/latest), download **`githubhelper.cmd`** (it's tiny).
2. Drop it in your projects folder and **double-click it**.
3. It downloads the latest **`githubhelper.exe`** right next to itself (no browser, no Downloads folder) and launches the dashboard in your browser.

On each run it keeps the exe current: downloads it if missing, updates it when a newer release exists (stopping a running copy first if needed), otherwise just launches what you have. Works offline if you already have the exe.

```
githubhelper.cmd                 keep up to date, then run
githubhelper.cmd update          force a fresh download of the latest release, then run
githubhelper.cmd --port 5000     pass any flags through to the exe
```

### Or grab the exe directly

Download **`githubhelper.exe`** from the [latest release](https://github.com/sburson34/GitHubHelper/releases/latest), drop it in your projects folder, and double-click. It auto-detects the folder, starts the server, and opens your browser. Run it from anywhere with `githubhelper.exe --root C:\path\to\projects`.

> Windows SmartScreen may warn the first time (the binary is unsigned): **More info → Run anyway**.

## Run from source

```bash
git clone https://github.com/sburson34/GitHubHelper.git
cd GitHubHelper
npm install
npm start
```

Then open **http://localhost:4317**. Run from inside the repo and it scans the parent folder (your projects directory) by default.

## Usage

### Branches

1. **Pick a project** from the search box at the top (type to filter; ↑/↓ + Enter to choose).
2. Review the **Local** and **GitHub** tables. Each row is one branch; the colored left edge reflects the recommendation (orange = action needed, purple = cleanup, green = OK, blue = info).
3. **Click a row** to open its details — expand any file to see its diff, and read the commits unique to the branch.
4. To use the **Push / Merge / Delete** buttons in a row's Actions column, first turn **Read-only** off (top-right toggle) — it's on by default. Each action asks for confirmation; results show as a toast and the table refreshes.
5. **↻ Refresh** re-scans projects. Your last-selected project is remembered, and you can deep-link one with `?p=<id>`.

### Working on now

Switch to the **⚡ Working on now** tab for a live list of your local Claude Code sessions — what each is about, its last command, running vs. done, and how recently it finished. It auto-refreshes. Click **⚙ Settings** to paste an Anthropic API key for AI-written summaries (stored locally; leave empty to use the heuristic).

## Configuration

| Option | How | Default |
| --- | --- | --- |
| Projects folder to scan | `--root <dir>` or `PROJECTS_ROOT` env | the current dir if it holds repos, else its parent |
| Port | `--port <n>` or `PORT` env | `4317`; the default auto-falls back to the next free port if busy, while an explicitly set port is used as-is |
| Don't auto-open the browser | `NO_OPEN=1` env | opens when run as the `.exe` |
| Anthropic API key (session summaries) | **Settings** in the "Working on now" tab, or `ANTHROPIC_API_KEY` env | none (heuristic summaries). The key from Settings is saved to `~/.githubhelper/config.json` |
| Read-only mode | header toggle | on at every start |

## Building the standalone executable

Produces `dist/githubhelper.exe` — a single self-contained file (Node runtime + server + UI bundled). The target machine still needs `git` + authenticated `gh`, but no Node or source.

```bash
npm run build:exe
```

Under the hood: esbuild bundles `server.js` + Express + the web assets into one file, and Node's Single Executable Application tooling (`postject`) injects it into a copy of the `node` binary.

## Cutting a release

One command bumps the version, rebuilds the exe, commits/tags/pushes, and publishes a GitHub Release with `githubhelper.exe` + `githubhelper.cmd` attached. Requires a clean working tree and authenticated `gh`.

```bash
npm run release            # patch bump (default), e.g. 1.0.4 -> 1.0.5
npm run release minor      # 1.0.4 -> 1.1.0
npm run release major      # 1.0.4 -> 2.0.0
npm run release 1.4.2      # explicit version
```

## How it works

- **Backend** (`server.js`, Express): discovers local git repos under the projects root and your GitHub repos (`gh repo list`), merges them into one list, and — on demand for the selected project only — gathers branch status by running `git` and `gh`. Mutating actions validate the branch name and run the matching `git`/`gh` command. Read-only mode is enforced centrally: every command is classified, and anything that would change git/GitHub is refused while read-only is on.
- **Sessions** (`sessions.js`): reads local Claude Code transcripts under `~/.claude/projects` for the "Working on now" tab; optionally summarizes them via the Claude API when an Anthropic key is set. Pure local reads (plus writing the key to its own config file).
- **Frontend** (`public/`): a single dark-themed page (vanilla JS) — searchable picker, branch tables, detail modal with diffs, inline actions, the read-only toggle, and the sessions tab.
- **Packaging** (`build.js`, `release.js`): bundles everything into a standalone `.exe` and publishes it via GitHub Releases.

## Project layout

```
server.js          Express backend (API, static serving, read-only gate)
sessions.js        "Working on now" — Claude Code session scan + summaries
public/            index.html, styles.css, app.js (the dashboard UI)
build.js           builds dist/githubhelper.exe (Node SEA + esbuild + postject)
release.js         npm run release — version bump + build + tag + GitHub Release
githubhelper.cmd   launcher that keeps the exe current and runs it
```
