/**
 * Host-half smoke test: loads `index.js` against a fake Cordis context and
 * exercises every registered route through its handler, so the wire validation,
 * path confinement, and subprocess argv are verified without a live Host.
 *
 * Run: node test/host.test.mjs
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply, parsePorcelain, parseRemoteUrl, parseRemotes } from '../index.js'

let failures = 0
let checks = 0

/** Assert one fact. */
function ok(condition, label, extra) {
  checks += 1
  if (condition) return
  failures += 1
  console.error(`FAIL  ${label}${extra === undefined ? '' : ` — ${extra}`}`)
}

/** Assert deep equality by JSON. */
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}`)
}

/** Build a fake req carrying a JSON body. */
function request(body, options = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const req = Readable.from([Buffer.from(text, 'utf8')])
  req.method = options.method ?? 'POST'
  req.headers = { 'content-type': options.contentType ?? 'application/json' }
  req.resume = () => {}
  return req
}

/** Build a fake res capturing the reply. */
function response() {
  const captured = { statusCode: 0, body: undefined, headers: {} }
  return {
    captured,
    set statusCode(value) { captured.statusCode = value },
    get statusCode() { return captured.statusCode },
    setHeader(name, value) { captured.headers[name.toLowerCase()] = value },
    end(text) {
      captured.body = text === undefined ? undefined : JSON.parse(text)
    },
  }
}

/**
 * Build a fake context: routes are collected, subprocess spawns are answered by
 * a scripted responder, and the trust fence can be told to reject.
 */
function makeContext({ reject = false, git = {}, spawn } = {}) {
  const routes = new Map()
  const spawned = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => { disposer?.() }
    },
    connection: {
      requestRejection() { return reject ? 403 : undefined },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
    subprocess: {
      spawn(spec) {
        spawned.push(spec)
        const answer = (spawn ?? defaultSpawn)(spec)
        return {
          done: Promise.resolve({ exitCode: answer.exitCode, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: answer.stdout ?? '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: answer.stderr ?? '', nextOffset: 0, lossy: false }) },
          },
          terminate() {},
          waitForExit: () => Promise.resolve(true),
        }
      },
    },
  }
  apply(ctx)
  return { routes, spawned, ctx }
}

/** Default spawn responder: git answers like a clean repo, shells echo. */
function defaultSpawn(spec) {
  if (isGitArgv(spec.argv)) {
    return { exitCode: 0, stdout: '## main...origin/main [ahead 2]\u0000 M src/a.ts\u0000?? b.txt\u0000', stderr: '' }
  }
  return { exitCode: 0, stdout: `ran:${spec.argv.slice(-1)[0]}\n`, stderr: '' }
}

/**
 * Whether an argv is the resolved git executable.
 *
 * The Host resolves git to an absolute path (PATH first, then well-known
 * install locations), so the fixture cannot match on the literal string `git`.
 */
function isGitArgv(argv) {
  return /[\\/]git(?:\.exe)?$/i.test(argv[0] ?? '')
}

/** Call one route with a body. */
async function call(routes, path, body, options) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`no route ${path}`)
  const req = request(body, options)
  const res = response()
  await route.handler(req, res)
  return { status: res.captured.statusCode, body: res.captured.body, headers: res.captured.headers }
}

const work = await mkdtemp(join(tmpdir(), 'dsh-ide-mode-test-'))

try {
  // ── Trust fence ────────────────────────────────────────────────────────
  {
    const { routes } = makeContext({ reject: true })
    const reply = await call(routes, '/ide-mode/git/status', { root: work })
    eq(reply.status, 403, 'a rejected request answers 403 before any work')
  }

  // ── Method and media-type validation ───────────────────────────────────
  {
    const { routes, spawned } = makeContext()
    const wrongMethod = await call(routes, '/ide-mode/git/status', { root: work }, { method: 'GET' })
    eq(wrongMethod.status, 405, 'GET is refused')

    const wrongType = await call(routes, '/ide-mode/fs/list', { root: work }, { contentType: 'text/plain' })
    eq(wrongType.status, 400, 'a non-JSON media type is refused')

    const badJson = await call(routes, '/ide-mode/fs/list', 'not json')
    eq(badJson.status, 400, 'malformed JSON is refused')

    const relative = await call(routes, '/ide-mode/fs/list', { root: 'relative/path' })
    eq(relative.status, 400, 'a relative root is refused')

    const huge = await call(routes, '/ide-mode/fs/list', { root: work, pad: 'x'.repeat(20000) })
    eq(huge.status, 400, 'a body past the ceiling is refused')
    eq(spawned.length, 0, 'no command ran for any refused request')
  }

  // ── Path confinement ───────────────────────────────────────────────────
  {
    const { routes } = makeContext()
    const escape = await call(routes, '/ide-mode/fs/read', { root: work, path: '../../etc/passwd' })
    eq(escape.status, 400, 'a target above the root is refused')

    const absoluteEscape = await call(routes, '/ide-mode/fs/read', { root: work, path: '/etc/passwd' })
    ok(absoluteEscape.status === 400 || absoluteEscape.status === 404, 'an absolute target outside the root is refused')

    const execEscape = await call(routes, '/ide-mode/exec', { root: work, command: 'x', cwd: '/etc' })
    eq(execEscape.status, 400, 'an exec cwd outside the root is refused')
  }

  // ── Git status parsing and reply shape ─────────────────────────────────
  {
    const { routes, spawned } = makeContext()
    const reply = await call(routes, '/ide-mode/git/status', { root: work })
    eq(reply.status, 200, 'status answers 200')
    eq(reply.body.branch, 'main', 'branch is parsed')
    eq(reply.body.upstream, 'origin/main', 'upstream is parsed')
    eq(reply.body.ahead, 2, 'ahead count is parsed')
    eq(reply.body.behind, undefined, 'an absent behind count stays absent')
    eq(reply.body.entries, [{ path: 'src/a.ts', xy: ' M' }, { path: 'b.txt', xy: '??' }], 'rows are parsed')
    const argv = spawned[0].argv
    ok(argv.includes('--porcelain=v1') && argv.includes('-z') && argv.includes('--branch'), 'porcelain flags reach git')
    // argv[0] is whichever absolute git the Host resolved: PATH first, then the
    // well-known install locations. The flag block still leads the rest.
    ok(/[\\/]git(?:\.exe)?$/i.test(argv[0]), 'argv[0] is a resolved git executable')
    eq(argv.slice(1, 4), ['--no-pager', '-c', 'color.ui=false'], 'global flags lead the argv')
  }

  // ── Git rename rows consume the origin token ───────────────────────────
  {
    const parsed = parsePorcelain('## main\u0000R  new.ts\u0000old.ts\u0000 M keep.ts\u0000')
    eq(parsed.entries, [{ path: 'new.ts', xy: 'R ' }, { path: 'keep.ts', xy: ' M' }], 'a rename origin is dropped, not reported')
  }

  // ── Git: not a repository ──────────────────────────────────────────────
  {
    const { routes } = makeContext({
      spawn: spec => (isGitArgv(spec.argv)
        ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
        : { exitCode: 0, stdout: '' }),
    })
    const reply = await call(routes, '/ide-mode/git/status', { root: work })
    eq(reply.status, 200, 'the not-a-repo case is a readable answer')
    eq(reply.body.isRepo, false, 'isRepo is false')
    eq(reply.body.entries, [], 'no rows are invented')
  }

  // ── Git index: paths are refused when they look like options ───────────
  {
    const { routes, spawned } = makeContext()
    const bad = await call(routes, '/ide-mode/git/index', { root: work, action: 'stage', paths: ['--upload-pack=evil'] })
    eq(bad.status, 400, 'a path beginning with - is refused')
    eq(spawned.length, 0, 'the refused path never reached git')

    const good = await call(routes, '/ide-mode/git/index', { root: work, action: 'stage', paths: ['src/a.ts'] })
    eq(good.status, 200, 'a normal path is staged')
    const argv = spawned[0].argv
    ok(argv.includes('--'), 'a -- terminator precedes the pathspec')
    eq(argv.slice(argv.indexOf('--')), ['--', 'src/a.ts'], 'the pathspec follows the terminator')

    const unstage = await call(routes, '/ide-mode/git/index', { root: work, action: 'unstage', paths: ['src/a.ts'] })
    eq(unstage.status, 200, 'unstage is accepted')
    ok(spawned[1].argv.includes('restore') && spawned[1].argv.includes('--staged'), 'unstage uses restore --staged')

    const badAction = await call(routes, '/ide-mode/git/index', { root: work, action: 'drop', paths: ['a'] })
    eq(badAction.status, 400, 'an unknown action is refused')
  }

  // ── Git commit ─────────────────────────────────────────────────────────
  {
    const { routes, spawned } = makeContext()
    const empty = await call(routes, '/ide-mode/git/commit', { root: work, message: '   ' })
    eq(empty.status, 400, 'an empty message is refused')

    const reply = await call(routes, '/ide-mode/git/commit', { root: work, message: 'feat: add ide mode' })
    eq(reply.status, 200, 'a commit answers 200')
    const argv = spawned[0].argv
    eq(argv.slice(argv.indexOf('-m')), ['-m', 'feat: add ide mode'], 'the message is one argv element')
  }

  // ── Git commit: nothing staged ─────────────────────────────────────────
  {
    const { routes } = makeContext({
      spawn: () => ({ exitCode: 1, stdout: 'nothing to commit, working tree clean', stderr: '' }),
    })
    const reply = await call(routes, '/ide-mode/git/commit', { root: work, message: 'x' })
    eq(reply.status, 409, 'an empty index is a conflict, not a failure')
    eq(reply.body.reason, 'nothing-to-commit', 'the reason is actionable')
  }

  // ── Shell exec ─────────────────────────────────────────────────────────
  {
    const { routes, spawned } = makeContext()
    const reply = await call(routes, '/ide-mode/exec', { root: work, command: 'echo hi' })
    eq(reply.status, 200, 'exec answers 200')
    eq(reply.body.code, 0, 'the exit code is reported')
    ok(reply.body.stdout.includes('echo hi'), 'the command reached the child')
    eq(reply.body.cwd, work.replace(/\//g, '\\'), 'the child ran in the requested directory')
    const argv = spawned[0].argv
    ok(argv[0] === 'cmd.exe' || argv[0] === '/bin/sh', `a platform shell is used (${argv[0]})`)
    ok(argv.includes('echo hi'), 'the command is one argv element, not re-split')
    eq(spawned[0].cwd, reply.body.cwd, 'spawn cwd matches the reply')

    const empty = await call(routes, '/ide-mode/exec', { root: work, command: '  ' })
    eq(empty.status, 400, 'an empty command is refused')

    const tooLong = await call(routes, '/ide-mode/exec', { root: work, command: 'x'.repeat(9000) })
    eq(tooLong.status, 400, 'an oversized command is refused')
  }

  // ── Filesystem: list ───────────────────────────────────────────────────
  {
    const { routes } = makeContext()
    await mkdir(join(work, 'src'), { recursive: true })
    await writeFile(join(work, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
    await writeFile(join(work, '.env'), 'SECRET=1\n', 'utf8')

    const reply = await call(routes, '/ide-mode/fs/list', { root: work })
    eq(reply.status, 200, 'list answers 200')
    const names = reply.body.entries.map(entry => entry.name)
    ok(names.includes('src'), 'directories are listed')
    ok(names.includes('.env'), 'hidden entries are listed and flagged')
    const env = reply.body.entries.find(entry => entry.name === '.env')
    eq(env.hidden, true, 'a dotfile is marked hidden')
    const src = reply.body.entries.find(entry => entry.name === 'src')
    eq(src.type, 'directory', 'a directory reports its kind')
    eq(reply.body.entries[0].name, 'src', 'directories sort before files')

    const missing = await call(routes, '/ide-mode/fs/list', { root: work, path: 'nope' })
    eq(missing.status, 404, 'a missing directory answers 404')

    const fileAsDir = await call(routes, '/ide-mode/fs/list', { root: work, path: 'src/a.ts' })
    eq(fileAsDir.status, 400, 'a file listed as a directory is refused')
  }

  // ── Filesystem: read ───────────────────────────────────────────────────
  {
    const { routes } = makeContext()
    const reply = await call(routes, '/ide-mode/fs/read', { root: work, path: 'src/a.ts' })
    eq(reply.status, 200, 'read answers 200')
    eq(reply.body.text, 'export const a = 1\n', 'the text round-trips')
    ok(reply.body.path.endsWith('src\\a.ts') || reply.body.path.endsWith('src/a.ts'), 'the absolute path is returned')

    const binary = await call(routes, '/ide-mode/fs/read', { root: work, path: 'blob.bin' })
    await writeFile(join(work, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    const binaryAgain = await call(routes, '/ide-mode/fs/read', { root: work, path: 'blob.bin' })
    eq(binaryAgain.status, 415, 'a NUL-bearing file is refused as binary')
    ok(binary.status === 404, 'a missing file answers 404 first')

    const dirRead = await call(routes, '/ide-mode/fs/read', { root: work, path: 'src' })
    eq(dirRead.status, 400, 'a directory is not a text file')
  }

  // ── Filesystem: write, mkdir, delete ───────────────────────────────────
  {
    const { routes } = makeContext()
    const written = await call(routes, '/ide-mode/fs/write', { root: work, path: 'notes/today.md', content: '# hi\n' })
    eq(written.status, 200, 'a write creates the parent directory chain it names')
    eq(await readFile(join(work, 'notes', 'today.md'), 'utf8'), '# hi\n', 'the content reached disk')

    const made = await call(routes, '/ide-mode/fs/mkdir', { root: work, path: 'extra/deep' })
    eq(made.status, 200, 'mkdir creates the directory, parents included')

    const rewritten = await call(routes, '/ide-mode/fs/write', { root: work, path: 'notes/today.md', content: '# hi again\n' })
    eq(rewritten.status, 200, 'an existing file is overwritten')
    eq(await readFile(join(work, 'notes', 'today.md'), 'utf8'), '# hi again\n', 'the new content replaced the old')

    const rootMkdir = await call(routes, '/ide-mode/fs/mkdir', { root: work, path: '' })
    eq(rootMkdir.status, 400, 'mkdir on the root itself is refused')

    const removed = await call(routes, '/ide-mode/fs/delete', { root: work, path: 'notes' })
    eq(removed.status, 200, 'delete removes a tree')
    const gone = await call(routes, '/ide-mode/fs/list', { root: work, path: 'notes' })
    eq(gone.status, 404, 'the deleted tree is gone')

    const rootDelete = await call(routes, '/ide-mode/fs/delete', { root: work, path: '' })
    eq(rootDelete.status, 400, 'deleting the root itself is refused')
  }

  // ── Workspace search ───────────────────────────────────────────────────
  {
    const { routes } = makeContext()
    await mkdir(join(work, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(work, 'node_modules', 'dep', 'thing.ts'), '', 'utf8')
    await writeFile(join(work, 'src', 'Thing.test.ts'), '', 'utf8')

    const reply = await call(routes, '/ide-mode/fs/search', { root: work, query: 'thing' })
    eq(reply.status, 200, 'search answers 200')
    const names = reply.body.matches.map(match => match.split(/[\\/]/).pop())
    ok(names.includes('Thing.test.ts'), 'a case-insensitive name match is found')
    ok(!reply.body.matches.some(match => match.includes('node_modules')), 'node_modules is skipped')

    const emptyQuery = await call(routes, '/ide-mode/fs/search', { root: work, query: '   ' })
    eq(emptyQuery.status, 400, 'an empty query is refused')

    const noHits = await call(routes, '/ide-mode/fs/search', { root: work, query: 'zzz-nothing' })
    eq(noHits.body.matches, [], 'no match answers an empty list')

    // An old client sends no `mode` at all, so the reply must still name the
    // mode it actually served — otherwise the panel cannot tell a list of
    // paths from a list of hits.
    eq(reply.body.mode, 'name', 'a mode-less request is served as a name search')
  }

  // ── Workspace search: inside file contents ─────────────────────────────
  //
  // Content search is the shape that can hurt a workspace, so this block pins
  // the two bounds that keep it cheap: skip lists still apply, and a file that
  // is not text is never read as text.
  {
    const { routes } = makeContext()
    await mkdir(join(work, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(work, 'node_modules', 'dep', 'vendored.ts'),
      'const needleword = 1\n', 'utf8')
    await writeFile(join(work, 'src', 'deep.ts'),
      'export const alpha = 1\nconst needleword = 2\n', 'utf8')
    await writeFile(join(work, 'src', 'nul.ts'),
      Buffer.from(`needleword\u0000binary`, 'utf8'))

    const hits = await call(routes, '/ide-mode/fs/search',
      { root: work, query: 'needleword', mode: 'content' })
    eq(hits.status, 200, 'a content search answers 200')
    eq(hits.body.mode, 'content', 'the reply names the content mode')
    eq(hits.body.truncated, false, 'a small workspace is not truncated')

    const deep = hits.body.matches.find(match => match.path.endsWith('deep.ts'))
    ok(deep !== undefined, 'a hit inside a file is reported')
    eq(deep?.line, 2, 'the hit carries its 1-based line number')
    eq(deep?.text, 'const needleword = 2', 'the hit carries the trimmed line')

    ok(!hits.body.matches.some(match => match.path.includes('node_modules')),
      'content search still skips node_modules')
    ok(!hits.body.matches.some(match => match.path.endsWith('nul.ts')),
      'a file holding a NUL byte is never read as text')

    const caseHits = await call(routes, '/ide-mode/fs/search',
      { root: work, query: 'NEEDLEWORD', mode: 'content' })
    ok(caseHits.body.matches.length > 0, 'content matching is case-insensitive')

    const unknownMode = await call(routes, '/ide-mode/fs/search',
      { root: work, query: 'needleword', mode: 'nonsense' })
    eq(unknownMode.body.mode, 'name', 'an unknown mode falls back to the name search')
  }

  // ── Git diff: tracked, untracked, and a refused path ───────────────────
  {
    const { routes, spawned } = makeContext({
      spawn: (spec) => {
        if (isGitArgv(spec.argv) && spec.argv.includes('diff')) {
          return { exitCode: 0, stdout: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 2\n', stderr: '' }
        }
        return defaultSpawn(spec)
      },
    })
    const worktree = await call(routes, '/ide-mode/git/diff', { root: work, path: 'src/a.ts' })
    eq(worktree.status, 200, 'diff answers 200')
    eq(worktree.body.kind, 'diff', 'a tracked file answers a diff')
    ok(worktree.body.text.includes('+export const a = 2'), 'the patch text is returned')
    ok(!spawned[0].argv.includes('--cached'), 'the worktree diff does not read the index')

    const staged = await call(routes, '/ide-mode/git/diff', { root: work, path: 'src/a.ts', staged: true })
    eq(staged.status, 200, 'a staged diff answers 200')
    ok(spawned[1].argv.includes('--cached'), 'staged reads the index against HEAD')

    const whole = await call(routes, '/ide-mode/git/diff', { root: work })
    eq(whole.status, 200, 'an omitted path diffs the whole repository')
    eq(spawned[2].argv.slice(spawned[2].argv.indexOf('--')), ['--'], 'an omitted path is an empty pathspec')

    const escape = await call(routes, '/ide-mode/git/diff', { root: work, path: '--upload-pack=x' })
    eq(escape.status, 400, 'a path that looks like an option is refused')
  }

  // ── Git diff: an untracked file answers its own content ────────────────
  {
    await writeFile(join(work, 'untracked.txt'), 'fresh\n', 'utf8')
    const { routes } = makeContext({
      spawn: spec => (isGitArgv(spec.argv) && spec.argv.includes('diff')
        ? { exitCode: 0, stdout: '', stderr: '' }
        : defaultSpawn(spec)),
    })
    const reply = await call(routes, '/ide-mode/git/diff', { root: work, path: 'untracked.txt' })
    eq(reply.status, 200, 'an untracked file answers 200')
    eq(reply.body.kind, 'untracked', 'an untracked file is reported as such')
    eq(reply.body.text, 'fresh\n', 'the untracked content is returned')
  }

  // ── Git discard: paths only, never a whole-tree reset ──────────────────
  {
    const { routes, spawned } = makeContext()
    const bad = await call(routes, '/ide-mode/git/discard', { root: work, action: 'discard', paths: ['-f'] })
    eq(bad.status, 400, 'a path beginning with - is refused')
    eq(spawned.length, 0, 'the refused discard never reached git')

    const good = await call(routes, '/ide-mode/git/discard', { root: work, action: 'discard', paths: ['src/a.ts'] })
    eq(good.status, 200, 'a discard answers 200')
    ok(spawned[0].argv.includes('restore'), 'discard restores from the index')
    ok(!spawned[0].argv.includes('--hard'), 'discard never asks for a hard reset')
    eq(spawned[0].argv.slice(-2), ['--', 'src/a.ts'], 'the discard pathspec is explicit')

    const unknown = await call(routes, '/ide-mode/git/discard', { root: work, action: 'nuke' })
    eq(unknown.status, 400, 'an unknown discard action is refused')
  }

  // ── Git branch: list and switch ────────────────────────────────────────
  {
    const { routes, spawned } = makeContext({
      spawn: (spec) => {
        if (isGitArgv(spec.argv) && spec.argv.includes('for-each-ref')) {
          return { exitCode: 0, stdout: '*\u0000main\u0000origin/main\n \u0000feature\u0000\n', stderr: '' }
        }
        return defaultSpawn(spec)
      },
    })
    const list = await call(routes, '/ide-mode/git/branch', { root: work, action: 'list' })
    eq(list.status, 200, 'branch list answers 200')
    eq(list.body.branches, [
      { name: 'main', current: true, upstream: 'origin/main' },
      { name: 'feature', current: false },
    ], 'branches are parsed with their current flag and upstream')

    const switched = await call(routes, '/ide-mode/git/branch', { root: work, action: 'switch', name: 'feature' })
    eq(switched.status, 200, 'a switch answers 200')
    ok(spawned[1].argv.includes('switch') && spawned[1].argv.includes('feature'), 'switch names the branch')

    const optionish = await call(routes, '/ide-mode/git/branch', { root: work, action: 'switch', name: '--force' })
    eq(optionish.status, 400, 'a branch name that looks like an option is refused')

    const unknown = await call(routes, '/ide-mode/git/branch', { root: work, action: 'rename' })
    eq(unknown.status, 400, 'an unknown branch action is refused')
  }

  // ── Git log: bounded and parsed ────────────────────────────────────────
  {
    const { routes, spawned } = makeContext({
      spawn: (spec) => {
        if (isGitArgv(spec.argv) && spec.argv.includes('log')) {
          return { exitCode: 0, stdout: 'abc1234\u0000Ada\u00002 days ago\u0000feat: x\u0000HEAD -> main\n', stderr: '' }
        }
        return defaultSpawn(spec)
      },
    })
    const reply = await call(routes, '/ide-mode/git/log', { root: work, limit: 5 })
    eq(reply.status, 200, 'log answers 200')
    eq(reply.body.commits, [{ hash: 'abc1234', author: 'Ada', when: '2 days ago', subject: 'feat: x', refs: 'HEAD -> main' }], 'a commit row is parsed')
    ok(spawned[0].argv.includes('-5'), 'the requested limit reaches git')

    const capped = await call(routes, '/ide-mode/git/log', { root: work, limit: 9999 })
    eq(capped.status, 200, 'an oversized limit answers 200')
    ok(spawned[1].argv.includes('-100'), 'the limit is capped at 100')
  }

  // ── Git init: creates the repository a fresh folder lacks ──────────────
  {
    const { routes, spawned } = makeContext({
      spawn: (spec) => {
        if (isGitArgv(spec.argv) && spec.argv.includes('init')) {
          return { exitCode: 0, stdout: 'Initialized empty Git repository in X\n', stderr: '' }
        }
        return defaultSpawn(spec)
      },
    })
    const reply = await call(routes, '/ide-mode/git/init', { root: work })
    eq(reply.status, 200, 'init answers 200')
    eq(reply.body.ok, true, 'init reports success')
    ok(spawned[0].argv.includes('init'), 'init reaches git')

    const failed = await call((makeContext({
      spawn: (spec) => (isGitArgv(spec.argv) && spec.argv.includes('init')
        ? { exitCode: 128, stdout: '', stderr: 'fatal: x' }
        : defaultSpawn(spec)),
    })).routes, '/ide-mode/git/init', { root: work })
    eq(failed.status, 502, 'a failing init answers 502')
  }

  // ── Remote URL parsing: both spellings git writes ──────────────────────
  {
    eq(parseRemotes('origin\tgit@github.com:sink-monster/dsh-ide-mode.git (fetch)\norigin\tgit@github.com:sink-monster/dsh-ide-mode.git (push)\n'),
      { name: 'origin', url: 'git@github.com:sink-monster/dsh-ide-mode.git', host: 'github.com', owner: 'sink-monster', repo: 'dsh-ide-mode', web: 'https://github.com/sink-monster/dsh-ide-mode', provider: 'github' },
      'an scp remote becomes coordinates')
    eq(parseRemoteUrl('https://github.com/o/r.git'),
      { host: 'github.com', owner: 'o', repo: 'r', web: 'https://github.com/o/r', provider: 'github' },
      'an https remote becomes coordinates')
    eq(parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/sub/repo.git'),
      { host: 'gitlab.example.com', owner: 'group/sub', repo: 'repo', web: 'https://gitlab.example.com/group/sub/repo', provider: 'git' },
      'a port is not part of the host and nested groups survive')
    eq(parseRemoteUrl('not a url'), null, 'an unparseable remote is refused')
    eq(parseRemotes(''), null, 'no remotes yields null')
    eq(parseRemotes('upstream\thttps://github.com/a/b.git (fetch)\nupstream\thttps://github.com/a/b.git (push)\n').name, 'upstream', 'the first fetch URL stands in for a missing origin')
    eq(parseRemotes('origin\thttps://github.com/a/b.git (push)\n'), null, 'a push-only line is not a fetch remote')
  }

  // ── Git remote: which remote the workspace talks to ────────────────────
  {
    const { routes, spawned } = makeContext({
      spawn: (spec) => {
        if (isGitArgv(spec.argv) && spec.argv.includes('remote')) {
          return { exitCode: 0, stdout: 'origin\tgit@github.com:sink-monster/dsh-ide-mode.git (fetch)\norigin\tgit@github.com:sink-monster/dsh-ide-mode.git (push)\n', stderr: '' }
        }
        return defaultSpawn(spec)
      },
    })
    const reply = await call(routes, '/ide-mode/git/remote', { root: work })
    eq(reply.status, 200, 'remote answers 200')
    eq(reply.body.remote?.repo, 'dsh-ide-mode', 'the remote name is read from git')
    eq(reply.body.remote?.provider, 'github', 'a github remote is labelled')
    ok(spawned[0].argv.includes('remote'), 'remote reaches git')

    const none = await call((makeContext({
      spawn: (spec) => (isGitArgv(spec.argv) && spec.argv.includes('remote')
        ? { exitCode: 0, stdout: '', stderr: '' }
        : defaultSpawn(spec)),
    })).routes, '/ide-mode/git/remote', { root: work })
    eq(none.body.remote, null, 'a repository without remotes reports null')

    const outside = await call((makeContext({
      spawn: (spec) => (isGitArgv(spec.argv) && spec.argv.includes('remote')
        ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
        : defaultSpawn(spec)),
    })).routes, '/ide-mode/git/remote', { root: work })
    eq(outside.body.isRepo, false, 'a folder outside a repository reports isRepo false')
  }

  // ── Git sync: fetch, pull, push ────────────────────────────────────────
  {
    const remotes = 'origin\tgit@github.com:sink-monster/dsh-ide-mode.git (fetch)\n'
    const make = (overrides = {}) => makeContext({
      spawn: (spec) => {
        const args = spec.argv
        if (isGitArgv(args) && args.includes('remote')) return { exitCode: 0, stdout: remotes, stderr: '' }
        if (isGitArgv(args) && args.includes('rev-parse') && args.some(arg => arg.endsWith('@{upstream}'))) {
          return overrides.upstream ?? { exitCode: 0, stdout: 'origin/main\n', stderr: '' }
        }
        if (isGitArgv(args) && args.includes('rev-parse') && args.includes('--abbrev-ref')) {
          return overrides.head ?? { exitCode: 0, stdout: 'main\n', stderr: '' }
        }
        if (isGitArgv(args) && (args.includes('fetch') || args.includes('pull') || args.includes('push'))) {
          return overrides.sync ?? { exitCode: 0, stdout: 'done\n', stderr: '' }
        }
        return defaultSpawn(spec)
      },
    })

    const fetchContext = make()
    const fetched = await call(fetchContext.routes, '/ide-mode/git/sync', { root: work, action: 'fetch' })
    eq(fetched.status, 200, 'fetch answers 200')
    ok(fetchContext.spawned.some(spec => spec.argv.includes('fetch') && spec.argv.includes('--prune') && spec.argv.includes('origin')),
      'fetch prunes the named remote')

    const pullContext = make()
    const pulled = await call(pullContext.routes, '/ide-mode/git/sync', { root: work, action: 'pull' })
    eq(pulled.status, 200, 'pull answers 200')
    ok(pullContext.spawned.some(spec => spec.argv.includes('pull') && spec.argv.includes('--ff-only')),
      'pull never invents a merge commit')

    const pushContext = make()
    await call(pushContext.routes, '/ide-mode/git/sync', { root: work, action: 'push' })
    ok(pushContext.spawned.some(spec => spec.argv.includes('push') && !spec.argv.includes('-u')),
      'a branch with an upstream pushes plainly')

    const firstPush = make({ upstream: { exitCode: 128, stdout: '', stderr: 'fatal: no upstream configured\n' } })
    await call(firstPush.routes, '/ide-mode/git/sync', { root: work, action: 'push' })
    ok(firstPush.spawned.some(spec => spec.argv.includes('push') && spec.argv.includes('-u') && spec.argv.includes('main')),
      'a branch without an upstream sets it once')

    const detached = await call(make({ head: { exitCode: 0, stdout: 'HEAD\n', stderr: '' } }).routes,
      '/ide-mode/git/sync', { root: work, action: 'push' })
    eq(detached.status, 409, 'a detached head refuses to push')
    eq(detached.body.reason, 'detached', 'and says why')

    eq((await call(make().routes, '/ide-mode/git/sync', { root: work, action: 'force' })).status, 400,
      'an unknown sync action is refused')

    const rejected = await call(make({ sync: { exitCode: 1, stdout: '', stderr: ' ! [rejected] main -> main (fetch first)' } }).routes,
      '/ide-mode/git/sync', { root: work, action: 'push' })
    eq(rejected.status, 409, 'a rejected push is a conflict, not a broken pane')
    eq(rejected.body.reason, 'rejected', 'and says so')

    const noRemote = await call((makeContext({
      spawn: (spec) => (isGitArgv(spec.argv) && spec.argv.includes('remote')
        ? { exitCode: 0, stdout: '', stderr: '' }
        : defaultSpawn(spec)),
    })).routes, '/ide-mode/git/sync', { root: work, action: 'fetch' })
    eq(noRemote.status, 409, 'syncing without a remote is refused')
    eq(noRemote.body.reason, 'no-remote', 'and names the missing remote')
  }

  // ── Every route is registered ──────────────────────────────────────────
  {
    const { routes } = makeContext()
    const expected = [
      '/ide-mode/git/status', '/ide-mode/git/index', '/ide-mode/git/commit',
      '/ide-mode/git/diff', '/ide-mode/git/discard', '/ide-mode/git/branch', '/ide-mode/git/log',
      '/ide-mode/git/init',
      '/ide-mode/git/remote', '/ide-mode/git/sync',
      '/ide-mode/exec',
      '/ide-mode/fs/list', '/ide-mode/fs/search', '/ide-mode/fs/read',
      '/ide-mode/fs/write', '/ide-mode/fs/mkdir', '/ide-mode/fs/delete',
    ]
    eq([...routes.keys()].sort(), expected.sort(), 'every route is registered')
  }
} finally {
  await rm(work, { recursive: true, force: true })
}

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) {
  console.error(`${String(failures)} failed`)
  process.exitCode = 1
}
