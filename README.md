# dsh-ide-mode

A switch in the top-left corner of the DSH web client that turns the shell into
an IDE and back. Normal mode is the shipped interface, unchanged.

- **Left**: Explorer (workspace tree, create file / folder), Search (file names
  or file contents across the workspace), Source control (branch, staged and
  changed files, stage / unstage, commit).
- **Top**: File (new / save / revert / delete) and Terminal (open / hide).
- **Middle**: a text editor with a line-number gutter.
- **Bottom**: a command drawer that runs in the Session's working directory.

## Install

From this directory:

```sh
dsh plugin --profile desktop add E:/dshproject/dsh-ide-mode
```

Or use **Plugins → Add plugin** and choose this folder, then enable **IDE mode**
in the list. The plugin is a bundle: its `cordis.patch.yml` inserts one Host row
(the Git / shell / filesystem routes) and its `dsh.client` declaration serves the
browser half.

## Where the switch appears

In the conversation header's leading seat, at the top-left of the main column,
before the Session title. It is present with and without an open Session.

Switching is instant, not animated by the shell: the IDE column fades in over
150 ms while the shell's own column transition is muted for that moment, and the
embedded conversation is mounted one frame later so the panels appear first.
`prefers-reduced-motion` skips the fade.

The mode and the workspace's arrangement are both remembered per browser: the
panel the rail had selected, the drawer state, whether the conversation column
was showing, and its width. A stored value that no longer makes sense is
dropped field by field, so a stale entry cannot leave the panel unrendered.

## Host routes

All are `POST`, JSON, same-origin, and admitted through the composition's
`connection` trust fence:

| Route | Purpose |
|---|---|
| `/ide-mode/git/status` | branch, upstream, ahead/behind, porcelain rows |
| `/ide-mode/git/index` | stage or unstage explicit paths |
| `/ide-mode/git/commit` | commit the index with one message |
| `/ide-mode/git/diff` | working-tree or staged diff for one path |
| `/ide-mode/git/discard` | discard worktree changes, or unstage everything |
| `/ide-mode/git/branch` | list local branches, or switch to one |
| `/ide-mode/git/log` | the newest commits |
| `/ide-mode/git/init` | create a repository in the workspace root |
| `/ide-mode/exec` | run one shell command in a workspace directory |
| `/ide-mode/fs/list` | list one directory's direct children |
| `/ide-mode/fs/search` | find files by name, or grep their contents, under the workspace root |
| `/ide-mode/fs/read` | read one file as UTF-8 (binary and oversized refused) |
| `/ide-mode/fs/write` | create or overwrite one file |
| `/ide-mode/fs/mkdir` | create one directory, parents included |
| `/ide-mode/fs/delete` | remove one file or directory tree |

Every filesystem route is confined to the `root` the caller names: a target that
resolves outside it is refused. Git receives `--` before pathspecs and rejects a
leading `-`; commands run as an argv array through `ctx.subprocess`, never
through a shell.

## Requirements

- DSH with the composition's `webServer`, `connection`, and `subprocess`
  services (the standard web and Desktop compositions have all three).
- A `git` binary, found without any setup: every `PATHEXT` variant on `PATH`,
  then the usual install locations (`D:\Soft Ware\Git\cmd\git.exe`,
  `PortableGit`, Program Files, scoop, and so on), then the nested `git.exe`
  inside the ops shell bundle. Only a real file is accepted, so a directory is
  never spawned. Without any git the section reports the failure and the rest of
  the workspace still works.

## Limits

Text editing only — no syntax highlighting, no language server. Source control
covers the worktree (status, index, commit, inline diff, discard, branch switch,
log, init); remotes, push/pull, and merge are out of scope, and discard never
touches the index beyond unstaging. Search reads contents only in **Content**
mode, one line at a time, skipping binary and oversized files. One file is open
at a time, and switching away from an unsaved buffer asks first. The command
drawer keeps no shell state between commands and is not a PTY; use the shipped
right-Sidebar terminal for an interactive shell.

See [docs/DETAIL.md](docs/DETAIL.md) for the full behaviour.
