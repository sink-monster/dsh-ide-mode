# IDE mode

A switch in the top-left corner turns the DSH web client into an IDE and back.
Normal mode is the shipped interface, unchanged.

## What the switch does

- **Normal mode** — the Conversation, exactly as it ships.
- **IDE mode** — the main column shows a workspace panel of this plugin:
  a File / Terminal bar, an Explorer / Search / Source control rail on the
  left, an editor in the middle, and a terminal drawer along the bottom.

The switch lives in the conversation header's leading seat, so it is present
before any Session exists and never moves. The mode is remembered in the
browser, and so is the workspace's arrangement (`dsh-ide-mode:layout`): the
panel the rail had selected, whether the drawer was closed / open / expanded,
whether the conversation column was showing, and how wide it was. Every stored
field is checked on the way back in — an unknown panel name, a wrong type, or
unparseable JSON falls back to that field's default instead of leaving the
panel unrendered.

Switching is deliberately quiet. Three things keep it from feeling like a jump:
the shell's own 300 ms column animation is muted for the 260 ms that follow a
switch (`html[data-dide-switching]`, set by `applyMode`), the IDE root fades in
over 150 ms with a 3 px lift (`@keyframes dide-enter`), and the embedded
conversation is mounted one frame later, so the panels paint before the
transcript is rendered. `prefers-reduced-motion` removes the fade entirely.

## Left: Explorer / Search / Source control

**Explorer** lists the Session's working directory one level at a time. Click a
folder to expand it (its contents are read on demand and cached until you
refresh), click a file to open it in the editor. Hidden entries are filtered
out until you enable them. The two buttons at the right of the header create a
file or a folder anywhere you type a path.

Opening another file never costs an unsaved edit: when the buffer differs from
what is on disk, the switch waits for a decision — **Save and open** (the write
has to reach disk first, so a failed save keeps the dialog up),
**Discard changes** (flagged as the destructive choice), or **Cancel**.
Clicking the file that is already open is not a decision, so it just refocuses.
The guard reads the same dirty flag the header's save state uses, so the two
can never disagree.

**Search** has two modes, chosen by the tabs under the box:

- **Name** matches every file *name* in the workspace, case-insensitively.
  Press Enter in the box to open the first match.
- **Content** greps the text of every file in the workspace and lists one row
  per hit with its line number, the file it belongs to, and the trimmed line.
  Clicking a row opens that file. Files above 512 KB and files that contain a
  NUL byte are skipped rather than read as text, and the walk stops after 8000
  files or once the match list is full — a search over a monorepo cannot stall
  the Host.

Both modes skip generated directories (`node_modules`, `dist`, `.git`,
`target`, virtualenvs, and peers), and both bound the visited-directory count.

**Source control** runs the system `git` in the Session's directory:

- the current branch, its upstream, and how far ahead or behind it is;
- **Staged** and **Changes** groups, with stage / unstage on each row and on
  each group header;
- a commit box — `Ctrl+Enter` (or `⌘+Enter`) commits the staged changes;
- clicking a path opens that file in the editor, shows that path's diff inline
  (untracked files included), and offers discard on a changes row;
- a branch menu that lists local branches and switches to one, plus a history
  button with the newest commits.

`git` is discovered once: every `PATHEXT` variant on `PATH`, then the usual
install locations (including `D:\Soft Ware\Git\cmd\git.exe` and a portable
`PortableGit`), then the nested `git.exe` inside the ops shell bundle. Only a
real file is accepted, so a directory that happens to satisfy an executable
probe is never spawned.

Without a repository the section says so and offers **Initialize repository**
(`git init`); the rest of the workspace is unaffected either way.

## Top: File and Terminal

**File** holds New file, New folder, Save, Revert, and Delete for the open
buffer. `Ctrl+S` saves from the editor as well.

**Terminal** opens, hides, and reveals the drawer.

## The editor

A plain monospace editor with a line-number gutter, two-space Tab indentation,
and a dirty marker in the footer. Save writes the file; Revert restores the text
that was loaded. A binary file, and a file above the size cap, are reported
instead of being loaded as text.

## The terminal

Each command is one round trip: it runs in the Session's working directory and
its output arrives with the exit code. Commands time out after two minutes and
output is bounded, so a runaway command cannot hold the page.

The prompt row is live in both drawer states — opening the drawer focuses it, and
a click anywhere in the output area, the header labels, or the prompt itself puts
the caret back in it, so typing never depends on hitting the input's own 20px
strip. `↑`/`↓` walk the commands already sent, `Esc` clears the line, `Enter`
runs it; an `Enter` chip appears on the right of the row only once there is
something to run. The row answers on its own: hover lifts it, focus turns it
white with a hairline brand outline, and while a command runs the `$` mark
pulses (still, under `prefers-reduced-motion`).

This drawer is deliberately *not* a PTY. Anything that needs a real terminal —
an interactive prompt, a full-screen TUI, an editor inside the shell — belongs
in the shipped right-Sidebar terminal, which is a genuine PTY and remains
available in both modes.

## How it is built

The mode is a main-panel selection, not DOM surgery: the plugin registers its
workspace as a `main` panel and asks `ctx.layout` to select it or the
Conversation. The conversation, the sidebar, and every other plugin keep their
own geometry and behaviour.

Host work travels over this plugin's own same-origin routes, all admitted
through the composition's `connection` trust fence before anything else runs:
Git status / index / commit / diff / discard / branch / log / init, one shell
command, and file list / search / read /
write / mkdir / delete. Every filesystem route takes the workspace root from
the caller and refuses a target that resolves outside it; Git receives `--`
before pathspecs, and a path that starts with `-` is refused outright. Commands
run through the composed `subprocess` provider as an argv array, never through
a shell.

## Limits worth knowing

- Text editing only, no syntax highlighting, no language server.
- The terminal drawer runs one command at a time and keeps no shell state
  between commands (`cd` does not persist).
- Search reads file contents only in **Content** mode, one line at a time, and
  never follows a symlink out of the workspace.
- One buffer at a time: switching files asks before dropping an unsaved edit
  instead of keeping both open.
- Git covers the working tree: status, index, commit, inline diff, discard,
  branch switch, log, and init. Remotes, push/pull, rebase, and merge resolvers
  are out of scope, and `discard` only ever touches the worktree — never `--hard`.
