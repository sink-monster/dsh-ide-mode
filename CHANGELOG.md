# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-11-24

### Added

- **GitHub integration in Source control.** A remote row shows the provider
  badge (`GitHub` for `github.com`, otherwise the host name) and the
  `owner/repo` the workspace pushes to, with fetch, pull (`--ff-only`), and push
  next to it. Clicking the row opens the repository in the system browser; with a
  GitHub remote every commit in the history list links to its own page.
- `POST /ide-mode/git/remote` — the push remote as parsed coordinates
  (`host`, `owner`, `repo`, `web`, `provider`). Understands both scp
  (`git@host:owner/repo.git`) and URL forms, drops ports and the `.git` suffix,
  and keeps nested groups (`group/sub/repo`).
- `POST /ide-mode/git/sync` — one `fetch --prune` / `pull --ff-only` / `push`
  per call. Push uses the existing upstream when there is one and
  `-u <remote> <branch>` when there is not; detached HEAD, a missing remote, and
  a non-fast-forward rejection each come back as their own reason instead of a
  raw Git failure.

### Fixed

- The Source control refresh button reloads the change list **and** the remote,
  so a remote added outside the panel (`git remote add`) shows up on refresh
  instead of after a restart.

## [1.0.0] — 2026-11-24

### Added

- Mode switch between the shipped conversation and an IDE workspace, as a `main`
  panel selection plus a `sidebar.panellist` row.
- Explorer with create-file / create-folder and opt-in hidden entries.
- Search in two modes: file names, and file contents (line numbers, 512 KB and
  NUL-byte skips, bounded walk).
- Source control: status, stage/unstage, commit, inline diff, discard, branch
  switching, commit history, and `git init` for a workspace without a repository.
- Editor with line-number gutter, save/revert, binary and size guards, and an
  unsaved-buffer guard when switching files.
- Terminal drawer: one command per round trip, output with exit code, click-to-
  focus prompt row, `↑`/`↓` history, `Esc` to clear, two-minute ceiling.
- Remembered layout: rail panel, drawer state, conversation column visibility and
  width, validated field by field on read.
- Simplified Chinese and English strings through the shell's i18n namespace.

[1.1.0]: https://github.com/sink-monster/dsh-ide-mode/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/sink-monster/dsh-ide-mode/releases/tag/v1.0.0