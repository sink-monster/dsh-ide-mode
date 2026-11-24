# DSH IDE Mode

IDE mode plugin for DeepSeek Harness. It adds a switch to the top-left corner of
the conversation header. Turn it on and the main area becomes a workspace:
Explorer, Search, Source control, an editor and a terminal drawer. The
conversation stays open in its own column and keeps streaming.

![IDE mode](docs/images/screenshot.png)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-62%20%2B%20145%20checks-brightgreen.svg)](#testing)
[![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](package.json)

## Features

**Mode switch.** The switch sits in `conversation.header.leading`, and the
workspace also appears in the shell's panel list. Turning the mode on selects a
`main` panel owned by this plugin; turning it off selects the conversation. The
sidebar, the conversation and other plugins keep their own layout.

**Explorer.** Shows the session working directory one level at a time, reading
on demand and caching until refresh. Files and folders can be created from the
header. Hidden entries are opt-in.

**Search.** The same input box runs two searches. Name matches file names,
case-insensitively. Content searches inside files and lists one row per hit with
the line number, the file and the trimmed line; clicking a row opens the file.
Files larger than 512 KB and files containing a NUL byte are skipped, the walk
stops after 8000 files, and generated directories (`node_modules`, `dist`,
`.git`, `target`, virtualenvs) are not entered.

**Source control.** Runs the system `git` in the session directory: branch,
upstream, ahead/behind, staged and changed groups, stage and unstage per row and
per group, a commit box, inline diff per path, discard, branch switching and
commit history.

**GitHub.** The remote row shows the provider badge (`GitHub` for github.com) and
the `owner/repo` the workspace pushes to, with fetch, pull (fast-forward only)
and push. Clicking it opens the repository in the browser; with a GitHub remote,
each commit in the history links to its page.

![GitHub remote and sync](docs/images/git-remote.png)

**Editor.** Monospace text with a line-number gutter, two-space Tab and a dirty
marker. Save writes to disk, Revert restores the loaded text. Switching files
while the buffer has unsaved edits asks first, with save, discard and cancel.
Binary and oversized files are reported instead of loaded.

**Terminal drawer.** One command per request, run in the session directory, with
output and exit code. Clicking anywhere in the drawer focuses the prompt; `↑` and
`↓` walk history, `Esc` clears the line. Commands time out after two minutes.

**Layout memory.** Rail panel, drawer state, and the conversation column's
visibility and width are stored in `localStorage` under
`dsh-ide-mode:layout`. Each field is checked on read and falls back on its own if
the stored value is invalid.

**Translations.** All interface strings ship in Simplified Chinese and English
through the shell's i18n namespace `ide-mode`.

## Tech stack

No build step and no runtime dependencies; both halves are plain source files.

| Layer | Implementation |
| --- | --- |
| Language | JavaScript, native ESM |
| Host | Node.js with the Cordis plugin API (`name` / `inject` / `apply`), `ctx.connection`, `ctx.subprocess`, `ctx.webServer` |
| Host I/O | `node:fs/promises`, `node:path`, `node:child_process`; `git` is spawned with an argument array, not through a shell |
| Client | React 18 loaded by the DSH module loader, hooks, `React.createElement` (no JSX, no bundler) |
| Shell APIs | `ctx.slots` (`main`, `conversation.header.leading`, `sidebar.panellist`), `ctx.layout`, `ctx.shortcuts`, `ctx.i18n` |
| Styles | One CSS string scoped to `.dide-*` classes, using the shell design tokens (`--dsw-alias-*`) so themes and density settings apply |
| Packaging | DSH bundle: `cordis.patch.yml` inserts the host row, `package.json#dsh.client` serves the browser half |
| Tests | Two `node:` scripts with assertion helpers, 62 and 145 checks |

## Installation

**From GitHub**

```bash
dsh plugin --profile desktop add github:sink-monster/dsh-ide-mode
```

Then add the package to the profile's bundle list in
`profiles/<name>/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-ide-mode"]
    }
  }
}
```

**From a tarball**

```bash
git clone https://github.com/sink-monster/dsh-ide-mode.git
cd dsh-ide-mode && pnpm pack          # dsh-ide-mode-1.1.0.tgz
dsh plugin --profile desktop add ./dsh-ide-mode-1.1.0.tgz
```

**For development**

```bash
git clone https://github.com/sink-monster/dsh-ide-mode.git
dsh plugin --profile desktop add ./dsh-ide-mode
```

`dsh plugin` forwards its arguments to `pnpm` inside the profile directory, so
any spec pnpm accepts works. Reload the window afterwards; in the packaged
desktop app use `Ctrl+Shift+I` and run `location.reload()`, or restart the app.

### Requirements

- DeepSeek Harness with `dsh-web-app`, since the plugin registers into `main`,
  `conversation.header.leading` and `sidebar.panellist`.
- Git on `PATH`, or in one of the checked locations: `D:\Soft Ware\Git\cmd\git.exe`,
  `Program Files\Git\…`, a portable `PortableGit`, or the ops shell bundle. Only
  a regular file is accepted.
- A current Chromium, WebKit or Firefox build for the client half.

## Usage

| Action | How |
| --- | --- |
| Enter or leave IDE mode | the top-left switch, or the IDE mode row in the panel list |
| Keyboard shortcut for the toggle | Settings → Shortcuts → `ide-mode.toggle` (no default binding) |
| Save the open file | `Ctrl+S` / `⌘S`, or File → Save |
| Commit | `Ctrl+Enter` / `⌘Enter` in the commit box |
| Run a command | type in the drawer prompt, press `Enter`; `↑` `↓` for history, `Esc` to clear |
| Open the repository | click the remote row |
| Resize the conversation column | drag the separator next to it |

## HTTP routes

All routes are same-origin and pass through the composition's `connection` fence
(host and origin check plus browser authentication) before the body is read.

| Route | Purpose |
| --- | --- |
| `POST /ide-mode/git/status` | branch, upstream, divergence, porcelain-v1 rows |
| `POST /ide-mode/git/index` | stage or unstage paths |
| `POST /ide-mode/git/commit` | commit the index with a message |
| `POST /ide-mode/git/diff` | working-tree or staged diff for one path |
| `POST /ide-mode/git/discard` | discard worktree changes, or unstage everything |
| `POST /ide-mode/git/branch` | list local branches, or switch |
| `POST /ide-mode/git/log` | recent commits |
| `POST /ide-mode/git/init` | create a repository in the workspace root |
| `POST /ide-mode/git/remote` | push remote as host, owner and repo |
| `POST /ide-mode/git/sync` | fetch, pull `--ff-only`, or push |
| `POST /ide-mode/exec` | run one shell command |
| `POST /ide-mode/fs/list` | list a directory |
| `POST /ide-mode/fs/search` | search file names or file contents |
| `POST /ide-mode/fs/read` | read a file as UTF-8 |
| `POST /ide-mode/fs/write` | create or overwrite a file |
| `POST /ide-mode/fs/mkdir` | create a directory |
| `POST /ide-mode/fs/delete` | remove a file or directory tree |

Filesystem routes take the workspace root from the caller and reject a target
that resolves outside it. Git receives `--` before pathspecs and refuses a path
starting with `-`.

## Project layout

```
dsh-ide-mode/
├─ index.js            host routes, git resolution, path containment
├─ client.js           browser half: slots, panels, IDE shell, CSS
├─ cordis.patch.yml    bundle entry (`ide-mode`)
├─ locale/{zh,en}.json interface strings
├─ docs/DETAIL.md      behaviour reference
└─ test/               activation.test.mjs, host.test.mjs
```

The plugin does not read another plugin's DOM or stylesheet. It registers a
`main` panel, asks `ctx.layout` to select it, and renders the conversation
through the `conversation.content` factory slot, so streaming, tools and the
composer behave as they do in normal mode.

## Testing

```bash
node test/activation.test.mjs   # loads client.js against a DOM stub (62 checks)
node test/host.test.mjs         # drives the host routes with fixtures (145 checks)
```

`npm test` runs both. The activation suite evaluates `client.js` with
`new Function` against stub `window`, `document` and `localStorage` objects, so
syntax errors surface immediately. The host suite calls the route handlers with a
fake `subprocess` provider and asserts on the argument array each Git call
receives.

## Limits

- Text editing only: no syntax highlighting, no language server.
- One buffer at a time; switching files asks before dropping unsaved edits.
- Source control covers the working tree plus one remote operation (fetch, pull
  `--ff-only`, push). Rebase, merge conflicts and credential prompts are not
  handled. Discard only touches the worktree and never runs `--hard`.
- The terminal drawer keeps no state between commands (`cd` does not persist) and
  is not a PTY.
- Content search reads line by line and does not follow symlinks out of the
  workspace.

## License

[MIT](LICENSE) © 2026 sink-monster