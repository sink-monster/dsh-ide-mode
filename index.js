/**
 * Host half of `dsh-ide-mode`.
 *
 * The IDE chrome itself is browser code (see `client.js`). What cannot live in
 * the page is everything that needs this machine: a real `git` binary, a real
 * shell, and real file writes. Seven routes serve those, all behind the
 * composition's `connection` trust fence.
 *
 * - `POST /ide-mode/git/status` — branch/upstream/divergence and porcelain-v1 rows.
 * - `POST /ide-mode/git/index`  — stage or unstage explicit paths.
 * - `POST /ide-mode/git/commit` — commit the index with one message.
 * - `POST /ide-mode/git/diff`   — one path's unified diff (untracked files included).
 * - `POST /ide-mode/git/discard` — revert worktree paths, or unstage everything.
 * - `POST /ide-mode/git/branch` — list local branches, or switch to one.
 * - `POST /ide-mode/git/log`    — the newest commits, one line each.
 * - `POST /ide-mode/git/init`   — create a repository in a workspace that has none.
 * - `POST /ide-mode/exec`       — run one shell command in a workspace directory.
 * - `POST /ide-mode/fs/list`    — list one directory's direct children.
 * - `POST /ide-mode/fs/search`  — find files by name, or grep text, under the root.
 * - `POST /ide-mode/fs/read`    — read one file as UTF-8 text (binary refused).
 * - `POST /ide-mode/fs/write`   — create or overwrite one file.
 * - `POST /ide-mode/fs/mkdir`   — create one directory (parents included).
 * - `POST /ide-mode/fs/delete`  — remove one file or directory tree.
 *
 * Every route asks `ctx.connection.requestRejection(req)` first: that is the
 * Host/Origin fence against DNS rebinding and cross-site calls, plus browser
 * authentication. Each then validates its own JSON body at the wire — media
 * type, a byte ceiling, and per-operation fields.
 *
 * Containment is one rule for every filesystem route: the caller names a
 * `root` (the Session's workspace directory) and a target, and the target must
 * already be inside that root. Git and exec use the same `root` as their
 * working directory, and a target there can never be re-read as an option:
 * git receives `--` before pathspecs and refuses a leading `-`.
 */

import { access, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Rows past this many are dropped and reported. */
const MAX_ENTRIES = 2000

/** stdout budget for one command. */
const MAX_STDOUT_BYTES = 512 * 1024

/** stderr budget: enough for a fatal message, never a whole log. */
const MAX_STDERR_BYTES = 64 * 1024

/** Small request bodies (git, exec): anything larger is hostile. */
const SMALL_BODY_BYTES = 16 * 1024

/** File writes carry content, so their ceiling is separate and much higher. */
const WRITE_BODY_BYTES = 8 * 1024 * 1024

/** Commit messages stay one short paragraph. */
const MAX_MESSAGE_BYTES = 5000

/** One shell command line. */
const MAX_COMMAND_BYTES = 8000

/** Paths per stage/unstage call. */
const MAX_PATHS = 500

/** A command that outlives this is terminated and reported as timed out. */
const EXEC_TIMEOUT_MS = 120_000

/** One directory listing is cut to this many children. */
const MAX_CHILDREN = 5000

/** Search reports at most this many matches. */
const MAX_MATCHES = 500

/** Directories a search may descend into before it gives up. */
const MAX_SEARCH_DIRECTORIES = 4000

/** A file past this is skipped by a content search instead of being read. */
const MAX_SEARCH_BYTES = 512 * 1024

/** Files one content search may read before it reports truncation. */
const MAX_SEARCH_FILES = 8000

/** Names never descended into: they are huge, generated, or not source. */
const SEARCH_SKIP = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv',
  '.idea', '.gradle', 'coverage', '.pytest_cache', 'vendor', 'Pods',
])

/** A text file past this is refused instead of loaded into the editor. */
const MAX_EDIT_BYTES = 4 * 1024 * 1024

/** Route spellings, mirrored in `client.js` (document-relative there). */
const STATUS_PATH = '/ide-mode/git/status'
const INDEX_PATH = '/ide-mode/git/index'
const COMMIT_PATH = '/ide-mode/git/commit'
const DIFF_PATH = '/ide-mode/git/diff'
const DISCARD_PATH = '/ide-mode/git/discard'
const BRANCH_PATH = '/ide-mode/git/branch'
const LOG_PATH = '/ide-mode/git/log'
/** `git init` for a workspace that has no repository yet. */
const INIT_PATH = '/ide-mode/git/init'
const EXEC_PATH = '/ide-mode/exec'
const LIST_PATH = '/ide-mode/fs/list'
const SEARCH_PATH = '/ide-mode/fs/search'
const READ_PATH = '/ide-mode/fs/read'
const WRITE_PATH = '/ide-mode/fs/write'
const MKDIR_PATH = '/ide-mode/fs/mkdir'
const DELETE_PATH = '/ide-mode/fs/delete'

/** Git runs with a fixed, locale-independent posture so its output parses. */
const GIT_GLOBAL_ARGS = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false']

/**
 * Well-known Git install locations, checked when `git` is not on PATH.
 *
 * The GUI host is often launched from a shell — or from an installer — whose
 * PATH never learned about Git: spawning `git` then fails with ENOENT and every
 * repository route answers 500. These candidates cover the normal installers
 * plus the portable bundle DSH already ships for its own shells.
 * @returns {string[]} absolute paths to try, in order.
 */
function gitCandidates() {
  const home = homedir()
  if (process.platform !== 'win32') {
    return [
      '/usr/bin/git',
      '/usr/local/bin/git',
      '/opt/homebrew/bin/git',
      '/opt/local/bin/git',
    ]
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  // Explicit secondary roots: this machine keeps its tools on D:, and the user
  // asked for Git under `D:\Soft Ware`, so that path is a first-class candidate.
  const extraRoots = [
    join('D:\\', 'Soft Ware'),
    join('D:\\', 'Software'),
    join('D:\\', 'Program Files'),
    join('C:\\', 'Soft Ware'),
  ]
  return [
    join(programFiles, 'Git', 'cmd', 'git.exe'),
    join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
    ...extraRoots.map(root => join(root, 'Git', 'cmd', 'git.exe')),
    ...extraRoots.map(root => join(root, 'Git', 'bin', 'git.exe')),
    ...extraRoots.map(root => join(root, 'PortableGit', 'cmd', 'git.exe')),
    ...extraRoots.map(root => join(root, 'Git', 'mingw64', 'bin', 'git.exe')),
    join(home, 'scoop', 'shims', 'git.exe'),
    join(home, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
    // The portable shell bundle DSH provisions for its own terminals.
    join(home, '.dsh', 'dsh-ops', 'shells', 'niubash-prepared'),
  ]
}

/**
 * Resolve the `git` executable once per Host lifetime.
 *
 * Resolution order: whatever PATH already answers (the normal case), then the
 * well-known install locations above. A missing Git is remembered so the page
 * can say so once instead of failing every poll.
 * @param attempts - optional override list, for tests.
 * @returns {Promise<{ path: string } | { path: null, reason: string }>} the
 *   program to spawn, or the reason none was found.
 */
export async function resolveGit(attempts) {
  // A candidate is only spawnable when it is a regular file that the account may
  // execute. `access(X_OK)` alone is not enough on Windows: directories inherit
  // the execute bit, so a directory would "pass" and `spawn` would then fail
  // with ENOENT — the portable-bundle parent directory did exactly that.
  const canRun = async (candidate) => {
    try {
      const info = await stat(candidate)
      if (!info.isFile()) return false
      await access(candidate, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (attempts !== undefined) {
    for (const candidate of attempts) if (await canRun(candidate)) return { path: candidate }
    return { path: null, reason: 'git-not-found' }
  }
  // PATH first: the caller's environment is the authority when it has an answer.
  const pathValue = process.env.PATH ?? ''
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `git${extension.toLowerCase()}`)
      if (await canRun(candidate)) return { path: candidate }
    }
  }
  for (const candidate of gitCandidates()) {
    if (await canRun(candidate)) return { path: candidate }
    // The portable bundle nests its binaries one level down, per hash.
    if (candidate.endsWith('niubash-prepared')) {
      try {
        for (const child of await readdir(candidate)) {
          const nested = join(candidate, child, 'winuxcmd', 'usr', 'bin', 'git.exe')
          if (await canRun(nested)) return { path: nested }
        }
      } catch {
        // No portable bundle on this machine; the other candidates stand.
      }
    }
  }
  return { path: null, reason: 'git-not-found' }
}

/** Windows drive path, POSIX root, or UNC share. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/

/** Cordis function-plugin name. */
export const name = 'ide-mode'

/** Required Host services: the route carrier, the trust fence, the process provider. */
export const inject = ['webServer', 'connection', 'subprocess']

/** JSON response (no-store: repository and terminal state are live facts). */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the one supported method. */
function sendMethodNotAllowed(res) {
  res.statusCode = 405
  res.setHeader('allow', 'POST')
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param req - the incoming request.
 * @param limit - inclusive byte ceiling.
 * @returns the body text, or null past the ceiling (the stream is drained so the refusal is readable).
 */
async function readBoundedBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Read one JSON request body.
 * @param req - the incoming request.
 * @param limit - inclusive byte ceiling.
 * @returns the parsed object, or null when the body is unusable.
 */
async function readJson(req, limit) {
  const mediaType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (mediaType !== 'application/json') return null
  const text = await readBoundedBody(req, limit)
  if (text === null) return null
  try {
    const body = JSON.parse(text)
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null
  } catch {
    return null
  }
}

/** One absolute path string, or null. */
function readAbsolute(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 4096) return null
  return ABSOLUTE_PATH.test(trimmed) ? trimmed : null
}

/**
 * Whether a resolved target lies inside a resolved root.
 * @param root - resolved root directory.
 * @param target - resolved candidate.
 * @returns true for the root itself and anything below it.
 */
function within(root, target) {
  const left = process.platform === 'win32' ? root.toLowerCase() : root
  const right = process.platform === 'win32' ? target.toLowerCase() : target
  if (left === right) return true
  return right.startsWith(left.endsWith(sep) ? left : `${left}${sep}`)
}

/**
 * Resolve a root plus a target, refusing an escape from the root.
 * @param rootValue - wire `root`.
 * @param targetValue - wire `path`; absolute or root-relative.
 * @returns `{ root, target }` resolved, or null when either is unusable or the target escapes.
 */
function readScopedPath(rootValue, targetValue) {
  const rootRaw = readAbsolute(rootValue)
  if (rootRaw === null) return null
  if (typeof targetValue !== 'string') return null
  const targetText = targetValue.trim()
  if (targetText.length === 0 || targetText.length > 4096) return null
  const root = resolve(rootRaw)
  const target = isAbsolute(targetText) ? resolve(targetText) : resolve(root, targetText)
  return within(root, target) ? { root, target } : null
}

/**
 * Repository paths, refused when they could be read as options.
 * @param value - the wire field.
 * @returns the paths, or null when any entry is unusable.
 */
function readPaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS) return null
  const paths = []
  for (const entry of value) {
    if (typeof entry !== 'string') return null
    const trimmed = entry.trim()
    if (trimmed.length === 0 || trimmed.length > 4096) return null
    if (trimmed.startsWith('-')) return null
    paths.push(trimmed)
  }
  return paths
}

/**
 * One repository-relative path, as a pathspec array, or null when unusable.
 *
 * An omitted path means "the whole repository": the caller passes an empty
 * array, which is what `git diff --` reads as everything.
 * @param rootValue - the request's root (unused beyond validation).
 * @param value - the wire field, or undefined.
 * @returns a zero-or-one element pathspec, or null when refused.
 */
function readWorkPath(rootValue, value) {
  if (value === undefined || value === null) return []
  const paths = readPaths([value])
  return paths === null ? null : paths
}

/**
 * Read one tracked-or-untracked file's text for the diff preview.
 * @param root - resolved root directory.
 * @param relative - repository-relative path.
 * @returns the UTF-8 text, or null when it is outside, binary, or oversized.
 */
async function readGitFile(root, relative) {
  const scoped = readScopedPath(root, relative)
  if (scoped === null) return null
  try {
    const info = await stat(scoped.target)
    if (!info.isFile() || info.size > MAX_EDIT_BYTES) return null
    const buffer = await readFile(scoped.target)
    if (buffer.includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

/**
 * Case-insensitive content search under one workspace root.
 *
 * A content scan costs far more than a name walk, so it is bounded twice: by
 * files read and by matches kept. Binary files are skipped with the same NUL
 * probe the reader uses — a work tree carries plenty of them, and a match
 * inside one is never what the caller wanted. Each hit carries enough to draw
 * a row without a second round trip.
 *
 * @param root - resolved root directory.
 * @param query - already lowercased, trimmed, non-empty needle.
 * @param limit - maximum hits to keep.
 * @returns hits as `{ path, line, text }` plus whether the walk was cut short.
 */
async function searchContents(root, query, limit) {
  const queue = [root]
  const matches = []
  let directories = 0
  let files = 0
  let truncated = false
  while (queue.length > 0) {
    const directory = queue.shift()
    directories += 1
    if (directories > MAX_SEARCH_DIRECTORIES) { truncated = true; break }
    let dirents
    try {
      dirents = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (SEARCH_SKIP.has(dirent.name)) continue
        queue.push(resolve(directory, dirent.name))
        continue
      }
      if (!dirent.isFile()) continue
      if (files >= MAX_SEARCH_FILES) { truncated = true; break }
      const target = resolve(directory, dirent.name)
      let text
      try {
        const info = await stat(target)
        if (!info.isFile() || info.size > MAX_SEARCH_BYTES) continue
        files += 1
        const buffer = await readFile(target)
        if (buffer.includes(0)) continue
        text = buffer.toString('utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (!line.toLowerCase().includes(query)) continue
        matches.push({ path: target, line: index + 1, text: line.trim().slice(0, 200) })
        if (matches.length >= limit) { truncated = true; break }
      }
      if (matches.length >= limit) break
    }
    if (matches.length >= limit) break
  }
  return { matches, truncated }
}

/**
 * Parse `git status --porcelain=v1 -z --branch` output.
 * @param text - NUL-framed porcelain.
 * @returns branch facts and change rows; rename origins are consumed, not reported.
 */
export function parsePorcelain(text) {
  const tokens = text.split('\0')
  const entries = []
  let branch
  let upstream
  let ahead
  let behind
  let detached = false
  let index = 0
  if (tokens.length > 0 && tokens[0].startsWith('## ')) {
    const header = tokens[0].slice(3)
    index = 1
    const bracket = header.indexOf(' [')
    const namePart = bracket === -1 ? header : header.slice(0, bracket)
    const track = bracket === -1 ? undefined : header.slice(bracket + 2).replace(/\]$/, '')
    if (namePart.startsWith('HEAD (no branch)')) {
      detached = true
    } else {
      const dots = namePart.indexOf('...')
      const head = dots === -1 ? namePart : namePart.slice(0, dots)
      branch = head.replace(/^No commits yet on /, '')
      if (dots !== -1) upstream = namePart.slice(dots + 3)
    }
    if (track !== undefined) {
      for (const piece of track.split(',')) {
        const match = /^(ahead|behind) (\d+)$/.exec(piece.trim())
        if (match === null) continue
        if (match[1] === 'ahead') ahead = Number(match[2])
        else behind = Number(match[2])
      }
    }
  }
  while (index < tokens.length) {
    const token = tokens[index]
    index += 1
    if (token === '' || token.length < 3) continue
    const xy = token.slice(0, 2)
    const path = token.slice(3)
    // A rename or copy row carries its origin path as the NEXT field.
    if (xy[0] === 'R' || xy[0] === 'C') index += 1
    entries.push({ path, xy })
  }
  return { branch, upstream, ahead, behind, detached, entries }
}

/** Register every IDE-mode route behind the connection trust fence. */
export function apply(ctx) {
  /** Memoized git resolution: one probe per Host lifetime, not one per request. */
  let gitProgram
  const gitExecutable = async () => {
    gitProgram ??= await resolveGit()
    return gitProgram
  }

  /**
   * Run one git command in one directory.
   * @param cwd - absolute directory.
   * @param args - argv after the global options; never shell-interpreted.
   * @returns exit code, bounded output, and whether stdout was cut.
   * @throws {Error} when no git executable exists on this machine.
   */
  const runGit = async (cwd, args) => {
    const program = await gitExecutable()
    if (program.path === null) {
      const error = new Error('git executable not found; install Git or add it to PATH')
      error.code = 'GIT_NOT_FOUND'
      throw error
    }
    const handle = ctx.subprocess.spawn({
      argv: [program.path, ...GIT_GLOBAL_ARGS, '-C', cwd, ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: MAX_STDOUT_BYTES },
        stderr: { maxBytes: MAX_STDERR_BYTES },
      },
      graceMs: 5000,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout?.readFrom(0)
    const err = handle.collected.stderr?.readFrom(0)
    return {
      code: outcome.exitCode,
      stdout: out?.text ?? '',
      stderr: err?.text ?? '',
      truncated: out?.truncated === true,
    }
  }

  /**
   * Turn a git failure into one reply reason the page can act on.
   * @param result - the command outcome.
   * @returns a reason token and a short detail.
   */
  const failureOf = (result) => {
    const detail = result.stderr.trim().slice(0, 400)
    if (/not a git repository/i.test(detail)) return { reason: 'not-a-repo', detail }
    if (/could not resolve host|unable to access|authentication failed/i.test(detail)) {
      return { reason: 'network', detail }
    }
    return { reason: 'git-failed', detail: detail === '' ? `git exited with code ${String(result.code)}` : detail }
  }

  /**
   * Shared admission: trust fence, method, parsed body, and one validated root.
   * @param req - the incoming request.
   * @param res - the response, already answered when null is returned.
   * @param limit - body ceiling for this route.
   * @returns the body and its resolved root, or null.
   */
  const admit = async (req, res, limit) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return null
    }
    if (req.method !== 'POST') {
      sendMethodNotAllowed(res)
      return null
    }
    const body = await readJson(req, limit)
    if (body === null) {
      sendJson(res, 400, { reason: 'bad-request' })
      return null
    }
    const rootRaw = readAbsolute(body.root)
    if (rootRaw === null) {
      sendJson(res, 400, { reason: 'bad-root' })
      return null
    }
    return { body, root: resolve(rootRaw) }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      try {
        const result = await runGit(admitted.root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal'])
        const failure = result.code === 0 ? undefined : failureOf(result)
        if (failure?.reason === 'not-a-repo') {
          sendJson(res, 200, { isRepo: false, entries: [] })
          return
        }
        if (failure !== undefined) {
          sendJson(res, 502, failure)
          return
        }
        const parsed = parsePorcelain(result.stdout)
        const entries = parsed.entries.slice(0, MAX_ENTRIES)
        sendJson(res, 200, {
          isRepo: true,
          ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
          ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
          ...(parsed.ahead === undefined ? {} : { ahead: parsed.ahead }),
          ...(parsed.behind === undefined ? {} : { behind: parsed.behind }),
          detached: parsed.detached,
          entries,
          truncated: parsed.entries.length > entries.length || result.truncated,
        })
      } catch (error) {
        console.warn('[ide-mode] git status failed:', error)
        sendJson(res, 500, { reason: 'git-unavailable', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: git status')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INDEX_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const action = admitted.body.action
      if (action !== 'stage' && action !== 'unstage') {
        sendJson(res, 400, { reason: 'bad-action' })
        return
      }
      const paths = readPaths(admitted.body.paths)
      if (paths === null) {
        sendJson(res, 400, { reason: 'bad-paths' })
        return
      }
      try {
        // `--` first: everything after it is a pathspec, never an option.
        const args = action === 'stage'
          ? ['add', '-A', '--', ...paths]
          : ['restore', '--staged', '--', ...paths]
        const result = await runGit(admitted.root, args)
        if (result.code !== 0) {
          sendJson(res, 502, failureOf(result))
          return
        }
        sendJson(res, 200, { ok: true, action, paths })
      } catch (error) {
        console.warn('[ide-mode] git index failed:', error)
        sendJson(res, 500, { reason: 'git-unavailable', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: git index')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: COMMIT_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const raw = admitted.body.message
      if (typeof raw !== 'string') {
        sendJson(res, 400, { reason: 'bad-message' })
        return
      }
      const message = raw.trim()
      if (message.length === 0 || Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
        sendJson(res, 400, { reason: 'bad-message' })
        return
      }
      try {
        // `-m` carries the message as one argv element: no shell, no quoting rules.
        const result = await runGit(admitted.root, ['commit', '-m', message])
        if (result.code !== 0) {
          const nothing = /nothing to commit|no changes added to commit/i.test(result.stdout + result.stderr)
          sendJson(res, 409, nothing ? { reason: 'nothing-to-commit' } : failureOf(result))
          return
        }
        sendJson(res, 200, { ok: true, summary: result.stdout.trim().slice(0, 2000) })
      } catch (error) {
        console.warn('[ide-mode] git commit failed:', error)
        sendJson(res, 500, { reason: 'git-unavailable', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: git commit')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DIFF_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      // `staged` diffs HEAD against the index; the default diffs the index
      // against the worktree. Both are read-only and bounded.
      const staged = admitted.body.staged === true
      const scoped = readWorkPath(admitted.root, admitted.body.path)
      if (scoped === null) {
        sendJson(res, 400, { reason: 'bad-path' })
        return
      }
      try {
        const args = staged
          ? ['diff', '--cached', '--no-color', '--', ...scoped]
          : ['diff', '--no-color', '--', ...scoped]
        const result = await runGit(admitted.root, args)
        if (result.code !== 0) {
          sendJson(res, 502, failureOf(result))
          return
        }
        // An untracked file has no diff; show its content as an all-added patch
        // so the editor can still preview it.
        if (result.stdout.trim() === '' && scoped.length === 1) {
          const untracked = await readGitFile(admitted.root, scoped[0])
          if (untracked !== null) {
            sendJson(res, 200, { kind: 'untracked', text: untracked, truncated: false })
            return
          }
        }
        sendJson(res, 200, { kind: 'diff', text: result.stdout, truncated: result.truncated })
      } catch (error) {
        console.warn('[ide-mode] git diff failed:', error)
        sendJson(res, 500, { reason: 'git-unavailable', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: git diff')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DISCARD_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const action = admitted.body.action
      if (action !== 'discard' && action !== 'unstage-all') {
        sendJson(res, 400, { reason: 'bad-action' })
        return
      }
      const paths = action === 'discard' ? readPaths(admitted.body.paths) : []
      if (paths === null) {
        sendJson(res, 400, { reason: 'bad-paths' })
        return
      }
      try {
        // Discard = restore the index/worktree copy. Never `--hard`, never a
        // whole-tree reset: only the paths the page named.
        const args = action === 'discard'
          ? ['restore', '--worktree', '--', ...paths]
          : ['reset']
        const result = await runGit(admitted.root, args)
        if (result.code !== 0) {
          sendJson(res, 502, failureOf(result))
          return
        }
        sendJson(res, 200, { ok: true, action, paths })
      } catch (error) {
        console.warn('[ide-mode] git discard failed:', error)
        sendJson(res, 500, { reason: 'git-unavailable', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: git discard')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BRANCH_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const action = admitted.body.action ?? 'list'
      try {
        if (action === 'list') {
          const result = await runGit(admitted.root, [
            'for-each-ref', '--format=%(HEAD)%00%(refname:short)%00%(upstream:short)', 'refs/heads',
          ])
          if (result.code !== 0) {
            sendJson(res, 502, failureOf(result))
            return
          }
          const branches = result.stdout.split('\n').filter(Boolean).map(line => {
            const [head, name, upstream] = line.split('\0')
            return { name, current: head === '*', ...(upstream === '' || upstream === undefined ? {} : { upstream }) }
          })
          sendJson(res, 200, { branches, truncated: result.truncated })
          return
        }
        if (action === 'switch') {
          const name = admitted.body.name
          if (typeof name !== 'string' || name.trim() === '' || name.length > 255 || name.startsWith('-')) {
            sendJson(res, 400, { reason: 'bad-branch' })
            return
          }
          const result = await runGit(admitted.root, ['switch', name.trim()])
          if (result.code !== 0) {
            sendJson(res, 502, failureOf(result))
            return
          }
          sendJson(res, 200, { ok: true, name: name.trim() })
          return
        }
        sendJson(res, 400, { reason: 'bad-action' })
      } catch (error) {
        console.warn('[ide-mode] git branch failed:', error)
        sendJson(res, 500, { reason: 'git-unavailable', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: git branch')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LOG_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const limit = Number.isSafeInteger(admitted.body.limit) && admitted.body.limit > 0
        ? Math.min(admitted.body.limit, 100)
        : 30
      try {
        const result = await runGit(admitted.root, [
          'log', `-${String(limit)}`, '--pretty=format:%h%x00%an%x00%ar%x00%s%x00%D',
        ])
        if (result.code !== 0) {
          sendJson(res, 502, failureOf(result))
          return
        }
        const commits = result.stdout.split('\n').filter(Boolean).map(line => {
          const [hash, author, when, subject, refs] = line.split('\0')
          return { hash, author, when, subject, ...(refs === '' || refs === undefined ? {} : { refs }) }
        })
        sendJson(res, 200, { commits, truncated: result.truncated })
      } catch (error) {
        console.warn('[ide-mode] git log failed:', error)
        sendJson(res, 500, { reason: 'git-unavailable', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: git log')

  // A workspace without a repository is the normal first state of a folder, so
  // the pane offers `git init` instead of a dead end. Only the index-free part
  // runs: no commit, no identity, nothing that could fail after a partial write.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INIT_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      try {
        const result = await runGit(admitted.root, ['init'])
        if (result.code !== 0) {
          sendJson(res, 502, failureOf(result))
          return
        }
        sendJson(res, 200, { ok: true, detail: result.stdout.trim().split('\n').slice(0, 4) })
      } catch (error) {
        console.warn('[ide-mode] git init failed:', error)
        sendJson(res, 500, { reason: 'git-unavailable', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: git init')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EXEC_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const raw = admitted.body.command
      if (typeof raw !== 'string') {
        sendJson(res, 400, { reason: 'bad-command' })
        return
      }
      const command = raw.trim()
      if (command.length === 0 || Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
        sendJson(res, 400, { reason: 'bad-command' })
        return
      }
      const scoped = readScopedPath(admitted.root, admitted.body.cwd ?? admitted.root)
      if (scoped === null) {
        sendJson(res, 400, { reason: 'bad-cwd' })
        return
      }
      const deadline = new AbortController()
      const timer = setTimeout(() => { deadline.abort() }, EXEC_TIMEOUT_MS)
      try {
        // The shell interprets the line exactly as either platform expects.
        const argv = process.platform === 'win32'
          ? ['cmd.exe', '/d', '/s', '/c', command]
          : ['/bin/sh', '-lc', command]
        const handle = ctx.subprocess.spawn({
          argv,
          cwd: scoped.target,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: MAX_STDOUT_BYTES },
            stderr: { maxBytes: MAX_STDERR_BYTES },
          },
          graceMs: 3000,
          signal: deadline.signal,
        })
        const outcome = await handle.done
        const out = handle.collected.stdout?.readFrom(0)
        const err = handle.collected.stderr?.readFrom(0)
        sendJson(res, 200, {
          code: outcome.exitCode,
          signal: outcome.signal,
          timedOut: deadline.signal.aborted,
          stdout: out?.text ?? '',
          stderr: err?.text ?? '',
          truncated: out?.truncated === true || err?.truncated === true,
          cwd: scoped.target,
        })
      } catch (error) {
        console.warn('[ide-mode] exec failed:', error)
        sendJson(res, 500, { reason: 'exec-failed', detail: String(error?.message ?? error).slice(0, 400) })
      } finally {
        clearTimeout(timer)
      }
    },
  }), 'ide-mode: exec')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: LIST_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const scoped = readScopedPath(admitted.root, admitted.body.path ?? admitted.root)
      if (scoped === null) {
        sendJson(res, 400, { reason: 'bad-path' })
        return
      }
      try {
        const dirents = await readdir(scoped.target, { withFileTypes: true })
        const entries = []
        for (const dirent of dirents) {
          if (entries.length >= MAX_CHILDREN) break
          const isDirectory = dirent.isDirectory()
          entries.push({
            name: dirent.name,
            type: isDirectory ? 'directory' : dirent.isFile() ? 'file' : 'other',
            hidden: dirent.name.startsWith('.'),
          })
        }
        entries.sort((left, right) => {
          const byKind = (left.type === 'directory' ? 0 : 1) - (right.type === 'directory' ? 0 : 1)
          return byKind !== 0 ? byKind : left.name.localeCompare(right.name)
        })
        sendJson(res, 200, {
          path: scoped.target,
          entries,
          truncated: dirents.length > entries.length,
        })
      } catch (error) {
        const code = error?.code
        if (code === 'ENOENT') { sendJson(res, 404, { reason: 'not-found' }); return }
        if (code === 'ENOTDIR') { sendJson(res, 400, { reason: 'not-a-directory' }); return }
        console.warn('[ide-mode] list failed:', error)
        sendJson(res, 500, { reason: 'list-failed', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: fs list')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SEARCH_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const raw = admitted.body.query
      if (typeof raw !== 'string') {
        sendJson(res, 400, { reason: 'bad-query' })
        return
      }
      const query = raw.trim().toLowerCase()
      if (query.length === 0 || query.length > 200) {
        sendJson(res, 400, { reason: 'bad-query' })
        return
      }
      // Two shapes of the same route: `name` (the default) matches paths, and
      // `content` greps text inside files. Anything else falls back to `name`,
      // so an older client keeps working against a newer Host.
      const mode = admitted.body.mode === 'content' ? 'content' : 'name'
      try {
        if (mode === 'content') {
          const found = await searchContents(admitted.root, query, MAX_MATCHES)
          sendJson(res, 200, {
            root: admitted.root,
            mode,
            matches: found.matches,
            truncated: found.truncated,
          })
          return
        }
        // Breadth-first, bounded on both directories visited and matches kept,
        // so one search over a monorepo cannot pin the Host.
        const queue = [admitted.root]
        const matches = []
        let visited = 0
        let truncated = false
        while (queue.length > 0) {
          const directory = queue.shift()
          visited += 1
          if (visited > MAX_SEARCH_DIRECTORIES) { truncated = true; break }
          let dirents
          try {
            dirents = await readdir(directory, { withFileTypes: true })
          } catch {
            continue
          }
          for (const dirent of dirents) {
            if (dirent.isDirectory()) {
              if (SEARCH_SKIP.has(dirent.name)) continue
              queue.push(resolve(directory, dirent.name))
              continue
            }
            if (!dirent.isFile()) continue
            if (!dirent.name.toLowerCase().includes(query)) continue
            matches.push(resolve(directory, dirent.name))
            if (matches.length >= MAX_MATCHES) { truncated = true; break }
          }
          if (matches.length >= MAX_MATCHES) break
        }
        sendJson(res, 200, { root: admitted.root, mode, matches, truncated })
      } catch (error) {
        console.warn('[ide-mode] search failed:', error)
        sendJson(res, 500, { reason: 'search-failed', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: fs search')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: READ_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const scoped = readScopedPath(admitted.root, admitted.body.path)
      if (scoped === null) {
        sendJson(res, 400, { reason: 'bad-path' })
        return
      }
      try {
        const info = await stat(scoped.target)
        if (!info.isFile()) { sendJson(res, 400, { reason: 'not-a-file' }); return }
        if (info.size > MAX_EDIT_BYTES) {
          sendJson(res, 413, { reason: 'too-large', bytes: info.size, limit: MAX_EDIT_BYTES })
          return
        }
        // One read plus one NUL probe: the editor refuses binary content, and a
        // text file must not arrive with replacement characters.
        const buffer = await readFile(scoped.target)
        if (buffer.includes(0)) { sendJson(res, 415, { reason: 'binary' }); return }
        const text = buffer.toString('utf8')
        sendJson(res, 200, {
          path: scoped.target,
          text,
          bytes: info.size,
          modifiedAt: info.mtimeMs,
        })
      } catch (error) {
        const code = error?.code
        if (code === 'ENOENT') { sendJson(res, 404, { reason: 'not-found' }); return }
        if (code === 'EISDIR') { sendJson(res, 400, { reason: 'not-a-file' }); return }
        console.warn('[ide-mode] read failed:', error)
        sendJson(res, 500, { reason: 'read-failed', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: fs read')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: WRITE_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, WRITE_BODY_BYTES)
      if (admitted === null) return
      const scoped = readScopedPath(admitted.root, admitted.body.path)
      if (scoped === null) {
        sendJson(res, 400, { reason: 'bad-path' })
        return
      }
      const content = admitted.body.content
      if (typeof content !== 'string') {
        sendJson(res, 400, { reason: 'bad-content' })
        return
      }
      try {
        // A new file may name a folder that does not exist yet; creating the
        // chain here is what makes "new file src/a/b.ts" work from the explorer.
        await mkdir(dirname(scoped.target), { recursive: true })
        await writeFile(scoped.target, content, 'utf8')
        sendJson(res, 200, { ok: true, path: scoped.target, bytes: Buffer.byteLength(content, 'utf8') })
      } catch (error) {
        console.warn('[ide-mode] write failed:', error)
        sendJson(res, 500, { reason: 'write-failed', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: fs write')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MKDIR_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const scoped = readScopedPath(admitted.root, admitted.body.path)
      if (scoped === null || scoped.target === scoped.root) {
        sendJson(res, 400, { reason: 'bad-path' })
        return
      }
      try {
        await mkdir(scoped.target, { recursive: true })
        sendJson(res, 200, { ok: true, path: scoped.target })
      } catch (error) {
        console.warn('[ide-mode] mkdir failed:', error)
        sendJson(res, 500, { reason: 'mkdir-failed', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: fs mkdir')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DELETE_PATH,
    handler: async (req, res) => {
      const admitted = await admit(req, res, SMALL_BODY_BYTES)
      if (admitted === null) return
      const scoped = readScopedPath(admitted.root, admitted.body.path)
      if (scoped === null || scoped.target === scoped.root) {
        sendJson(res, 400, { reason: 'bad-path' })
        return
      }
      try {
        await rm(scoped.target, { recursive: true, force: true })
        sendJson(res, 200, { ok: true, path: scoped.target })
      } catch (error) {
        console.warn('[ide-mode] delete failed:', error)
        sendJson(res, 500, { reason: 'delete-failed', detail: String(error?.message ?? error).slice(0, 400) })
      }
    },
  }), 'ide-mode: fs delete')
}
