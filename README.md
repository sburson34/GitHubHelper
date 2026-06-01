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

There is **no AI/Claude and no API key** involved at runtime — the analysis is rule-based logic over what `git` and `gh` report.

## Requirements

On whatever machine you run it:

- **[git](https://git-scm.com/)** — required for the local half (scanning repos, branch status, pushing).
- **[GitHub CLI (`gh`)](https://cli.github.com/)**, authenticated once with `gh auth login` — required for the GitHub half (remote branches, PRs, and the merge-PR / delete-remote / push actions).
- **[Node.js](https://nodejs.org/) 20+** — only if you run from source or build the executable. **Not needed** to run the prebuilt `.exe`.

> The dashboard can only show the local branches of repos that physically live on the machine it runs on — it shells out to `git`/`gh` there. The GitHub half works from anywhere you're signed in.

## Quick start (no source, no Node)

### Easiest — the launcher (auto-downloads, self-updates)

1. From the [latest release](https://github.com/sburson34/GitHubHelper/releases/latest), download **`githubhelper.cmd`** (it's tiny).
2. Drop it in your projects folder and **double-click it**.
3. It downloads the latest **`githubhelper.exe`** right next to itself (no browser, no Downloads folder) and launches the dashboard in your browser.

```
githubhelper.cmd                 download if missing, then run
githubhelper.cmd update          force-refresh to the newest release, then run
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

1. **Pick a project** from the search box at the top (type to filter; ↑/↓ + Enter to choose).
2. Review the **Local** and **GitHub** tables. Each row is one branch; the colored left edge reflects the recommendation (orange = action needed, purple = cleanup, green = OK, blue = info).
3. **Click a row** to open its details — expand any file to see its diff, and read the commits unique to the branch.
4. Use the **Push / Merge / Delete** buttons in a row's Actions column. Each asks for confirmation; results show as a toast and the table refreshes.
5. **↻ Refresh** re-scans projects. Your last-selected project is remembered, and you can deep-link one with `?p=<id>`.

## Configuration

| Option | How | Default |
| --- | --- | --- |
| Projects folder to scan | `--root <dir>` or `PROJECTS_ROOT` env | the current dir if it holds repos, else its parent |
| Port | `--port <n>` or `PORT` env | `4317` |
| Don't auto-open the browser | `NO_OPEN=1` env | opens when run as the `.exe` |

## Building the standalone executable

Produces `dist/githubhelper.exe` — a single self-contained file (Node runtime + server + UI bundled). The target machine still needs `git` + authenticated `gh`, but no Node or source.

```bash
npm run build:exe
```

Under the hood: esbuild bundles `server.js` + Express + the web assets into one file, and Node's Single Executable Application tooling (`postject`) injects it into a copy of the `node` binary.

## Cutting a release

One command bumps the version, rebuilds the exe, commits/tags/pushes, and publishes a GitHub Release with `githubhelper.exe` + `githubhelper.cmd` attached. Requires a clean working tree and authenticated `gh`.

```bash
npm run release            # patch: 1.0.1 -> 1.0.2
npm run release minor      # 1.0.1 -> 1.1.0
npm run release major      # 1.0.1 -> 2.0.0
npm run release 1.4.2      # explicit version
```

## How it works

- **Backend** (`server.js`, Express): discovers local git repos under the projects root and your GitHub repos (`gh repo list`), merges them into one list, and — on demand for the selected project only — gathers branch status by running `git` and `gh`. Mutating actions (push/merge/delete) validate the branch name and run the matching `git`/`gh` command.
- **Frontend** (`public/`): a single dark-themed page (vanilla JS) — searchable picker, branch tables, detail modal with diffs, and inline actions.
- **Packaging** (`build.js`, `release.js`): bundles everything into a standalone `.exe` and publishes it via GitHub Releases.

## Project layout

```
server.js          Express backend (API + static serving)
public/            index.html, styles.css, app.js (the dashboard UI)
build.js           builds dist/githubhelper.exe (Node SEA + esbuild + postject)
release.js         npm run release — version bump + build + tag + GitHub Release
githubhelper.cmd   launcher that downloads + runs the latest exe
```
