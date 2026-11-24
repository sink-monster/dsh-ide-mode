/**
 * Browser-half activation test.
 *
 * The plugin bundle only registers a factory, so a syntax check proves nothing
 * about whether `apply` runs: a wrong `inject` entry, a renamed service, or a
 * throwing `ctx.get` all fail silently in the page. This harness evaluates the
 * real bundle against a stub loader and a stub context, then asserts what
 * `apply` actually did — the registrations it made, the reflective faces it
 * read, and the mode transitions it performs.
 *
 * Run: node test/activation.test.mjs
 */
import { readFileSync } from 'node:fs'

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

/** Minimal React stand-in: enough for the module body and simple renders. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect() {},
  useMemo: factory => factory(),
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  Fragment: 'Fragment',
}

/**
 * Evaluate the bundle and return its exported plugin.
 * @param {Record<string, string>} [seed] - entries preloaded into localStorage.
 * @returns {{ plugin: object, disposeStyles: () => void, storage: object }}
 */
function loadBundle(seed = {}) {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const rows = []
  const style = { removed: false, setAttribute() {}, textContent: '' }

  globalThis.window = globalThis
  globalThis.window.__ModuleLoader__ = { load: row => rows.push(row) }
  globalThis.document = {
    createElement: () => ({ ...style, remove() { style.removed = true } }),
    head: { append() {} },
  }
  globalThis.localStorage = {
    store: new Map(Object.entries(seed)),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
    setItem(key, value) { this.store.set(key, value) },
  }

  new Function(source)()
  if (rows.length !== 1) throw new Error(`expected one registered row, saw ${String(rows.length)}`)
  const plugin = rows[0].factory(request => {
    if (request === 'react') return React
    throw new Error(`unexpected module request: ${request}`)
  })
  return { plugin, row: rows[0], style, storage: globalThis.localStorage }
}

/**
 * Reproduce the shortcut registry's default validation.
 *
 * Rules from `dsh-client-shortcuts` (`configuration.ts` `bindingIssue`, and the
 * profile loop in `client/registry.ts`): every profile a default names is
 * checked, so ONE rejected profile throws for the whole registration.
 * @param {object} definition - the command being registered.
 * @throws {Error} when a declared default would be rejected.
 */
function assertRegistrable(definition) {
  const defaults = definition.defaults ?? {}
  const reserved = ['Escape', 'Tab', 'Space', 'Backspace', 'Delete',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
  for (const [profile, binding] of Object.entries(defaults)) {
    const [runtime, platform] = profile.split(':')
    const mods = binding.modifiers.map(m => (
      m === 'primary' ? (platform === 'macos' ? 'meta' : 'control') : m))
    // Desktop on Windows/macOS admits anything (configuration.ts line 98).
    if (runtime === 'desktop' && (platform === 'windows' || platform === 'macos')) continue
    if (mods.length === 0 || mods.every(m => m === 'shift')) {
      throw new Error(`Reserved shortcut default: ${definition.id} (${profile}: modifier-required)`)
    }
    if ((platform === 'windows' || platform === 'macos') && mods.length >= 3) continue
    const primary = mods.includes(platform === 'macos' ? 'meta' : 'control')
    const reservedChord = reserved.includes(binding.code)
      || (primary && ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'KeyH'].includes(binding.code))
      || (primary && binding.code === 'KeyA' && !mods.includes('shift'))
      || (platform !== 'macos' && mods.includes('meta'))
      || (platform === 'macos' && mods.includes('control') && mods.includes('meta'))
      || (platform === 'macos' && mods.includes('alt') && !primary)
    if (reservedChord) {
      throw new Error(`Reserved shortcut default: ${definition.id} (${profile}: reserved ${binding.code})`)
    }
  }
}

/**
 * Build a stub Client context that records every interaction.
 * @param {object} options - provided-face overrides.
 * @returns {object} the context plus its log.
 */
const pluginOptions = {}
function makeContext(options = {}) {
  const log = []
  const effects = []
  const provided = {
    sidebarRight: {
      mounted: {
        value: options.mountedSessionId,
        getSnapshot() { return this.value },
        subscribe: () => () => {},
      },
      openTabs: {
        value: options.openTabs ?? [],
        getSnapshot() { return this.value },
        subscribe: () => () => {},
      },
      openTab: (kind, opts) => { log.push(['openTab', kind, opts]) },
      // Mirrors the real controller: openTabIn places a tab that then shows up
      // in the openTabs inventory. Without this, "did it land" checks in the
      // plugin would never turn true and the retry loop would spin forever.
      openTabIn(sessionId, kind, opts) {
        log.push(['openTabIn', sessionId, kind, opts])
        this.openTabs.value = [...this.openTabs.value, { sessionId, kind, tabId: 'tab-1', contentId: 'c-1' }]
      },
    },
    sidebarRightTabs: {
      register: (definition) => { log.push(['tabType', definition.kind, definition.priority, definition.multiple]); return () => {} },
    },
    shortcuts: {
      // Mirror of `ShortcutRegistry.register`'s default validation. Without it
      // this harness would happily accept a binding the real app rejects — the
      // exact blind spot that hid the Ctrl+Tab failure.
      register: (definition) => {
        assertRegistrable(definition)
        log.push(['shortcut', definition.id, definition.regions, definition.defaults])
        return () => {}
      },
    },
    ...options.provided,
  }
  const ctx = {
    get: name => provided[name],
    // Cordis `ctx.inject(['svc'], scope => ...)` runs the callback only once
    // every named service exists, with a scope whose properties ARE the
    // services. A missing one defers, which is exactly the cold-start race this
    // plugin must survive.
    inject(names, callback) {
      const ready = names.every(name => provided[name] !== undefined)
      log.push(['inject-services', names.join(','), ready])
      if (!ready) return { dispose() {} }
      const scope = {
        ...ctx,
        ...Object.fromEntries(names.map(name => [name, provided[name]])),
      }
      callback(scope)
      return { dispose() {} }
    },
    locale: {
      register: (ns) => { log.push(['locale', ns]); return () => {} },
      bind: ns => key => `${ns}.${key}`,
    },
    effect: (fn) => { const disposer = fn(); effects.push(disposer); return () => {} },
    on: () => () => {},
    layout: {
      selectPanel: id => log.push(['selectPanel', id]),
      toggleSidebar: () => log.push(['toggleSidebar']),
      openRightbar: (track, fullscreen) => log.push(['openRightbar', track, fullscreen]),
      closeRightbar: () => log.push(['closeRightbar']),
      panelInfo: {
        value: { activePanelId: options.activePanelId ?? null },
        getSnapshot() { return this.value },
        subscribe: () => () => {},
      },
    },
    sessions: {
      list: {
        getSnapshot: () => {
          const byId = options.byId ?? {}
          return { byId, ids: Object.keys(byId) }
        },
        subscribe: () => () => {},
      },
    },
    shortcuts: undefined,
    slots: {
      inject(key, callback) {
        log.push(['inject', key])
        try {
          const result = callback()
          if (result !== null && typeof result === 'object' && Symbol.iterator in result) {
            for (const _disposer of result) { /* drain the generator */ }
          }
        } catch (error) {
          log.push(['INJECT_THREW', key, error.message])
        }
        return () => {}
      },
      register(options_, component) {
        if (options_?.name === 'main') pluginOptions.main = options_
        log.push(['register', options_.name, options_.key ?? options_.id ?? null, typeof component])
        return () => {}
      },
    },
  }
  return { ctx, log, effects, provided }
}

// ── The bundle registers exactly one factory ───────────────────────────────
const { plugin, row, storage } = loadBundle()
eq(row.id, 'dsh-ide-mode', 'the bundle registers under its package name')
ok(typeof plugin.apply === 'function', 'the plugin exports apply')
ok(Array.isArray(plugin.inject), 'the plugin declares inject')

// ── inject names only real Services ────────────────────────────────────────
// `sidebarRight` and `sidebarRightTabs` are provided reflectively; naming them
// here would leave the plugin waiting forever. This is the exact defect that
// made a previous build never activate.
ok(!plugin.inject.includes('sidebarRight'), 'sidebarRight is not injected (it is reflectively provided)')
ok(!plugin.inject.includes('sidebarRightTabs'), 'sidebarRightTabs is not injected (it is reflectively provided)')
ok(!plugin.inject.includes('shortcuts'), 'shortcuts is not injected (read reflectively, so an absent one cannot block activation)')
for (const name of ['slots', 'locale', 'layout', 'sessions']) {
  ok(plugin.inject.includes(name), `${name} is injected`)
}

// ── apply registers every seat and command ─────────────────────────────────
{
  const { ctx, log } = makeContext({})
  plugin.apply(ctx)

  const injections = log.filter(entry => entry[0] === 'inject').map(entry => entry[1])
  eq(injections, ['main', 'ide-mode.chat', 'sidebar.session.action'],
    'the three seats are injected, and only where a declaration exists')

  const threw = log.filter(entry => entry[0] === 'INJECT_THREW')
  eq(threw, [], 'no injected declaration threw')

  const registrations = log.filter(entry => entry[0] === 'register')
  eq(registrations.map(entry => [entry[1], entry[2]]), [
    ['main', 'ide-mode'],
    ['ide-mode.chat', null],
    ['sidebar.session.action', 'ide-mode'],
  ], 'the workspace panel, the embedded chat body, and the session row layer are registered')

  ok(registrations.every(entry => entry[3] === 'function'), 'every registration supplies a component')

  const mainOptions = pluginOptions.main
  ok(mainOptions !== undefined && mainOptions.children !== undefined,
    'the main panel declares its session child (the kit then carries SessionProvider)')
  eq(mainOptions?.children?.['ide-mode.chat']?.scope, 'session',
    'the declared child is session-scoped, so the embedded body sees the Session binding')

  const shortcut = log.find(entry => entry[0] === 'shortcut')
  ok(shortcut !== undefined, 'the mode command is registered')
  eq(shortcut[1], 'ide-mode.toggle', 'its id is stable')
  eq(shortcut[2], ['page', 'terminal'], 'it never claims the editor region')

  // A REGISTRATION GUARD, not a preference.
  //
  // `ShortcutRegistry.register` validates every profile a default names, and one
  // rejected profile throws for the whole registration — which is exactly how
  // this plugin failed to activate. `Tab` is reserved outright, and macOS
  // rejects Alt-without-primary, so no single cross-platform chord satisfies
  // all six profiles. Declaring no default is what makes registration
  // unconditional; the user binds it in Settings → Shortcuts.
  eq(shortcut[3], {}, 'the command declares NO default binding (it must never throw)')

  // The old right-Sidebar route must stay gone: the shipped rightbar hides
  // every Session view while a non-conversation panel fills the main column,
  // so a tab placed there can never be the IDE chat.
  ok(!log.some(entry => entry[0] === 'inject-services'), 'no service injection is awaited (no rightbar faces)')
  ok(!log.some(entry => entry[0] === 'openRightbar'), 'no rightbar priming is issued')
  ok(!log.some(entry => entry[0] === 'openTabIn'), 'no rightbar tab is opened')
}

// ── The guard itself is proven, not assumed ────────────────────────────────
//
// A harness that accepts everything cannot catch a rejected binding. These two
// probes pin the rules down: the chord that actually broke activation must be
// refused, and the shape we ship must be admitted.
{
  let refused = false
  try {
    assertRegistrable({
      id: 'probe.tab',
      defaults: {
        'desktop:windows': { code: 'Tab', modifiers: ['control'] },
        'web:windows': { code: 'Tab', modifiers: ['control'] },
      },
    })
  } catch { refused = true }
  ok(refused, 'the validator refuses Ctrl+Tab (the defect that broke activation)')

  let macAltRefused = false
  try {
    assertRegistrable({
      id: 'probe.mac-alt',
      defaults: { 'web:macos': { code: 'KeyI', modifiers: ['alt'] } },
    })
  } catch { macAltRefused = true }
  ok(macAltRefused, 'the validator refuses macOS Alt-without-primary')

  let accepted = true
  try { assertRegistrable({ id: 'probe.empty', defaults: {} }) } catch { accepted = false }
  ok(accepted, 'a command with no default binding is always registrable')
}

// ── A trimmed composition stays usable ─────────────────────────────────────
//
// The chat column needs no reflective face at all: the session reference comes
// from `sessions` (an injected Service), the scope provider and the factory
// renderer come from the slot kit. A composition missing any of the optional
// extras still gets the workspace, the switch, and the command.
{
  const { ctx, log } = makeContext({
    provided: { shortcuts: undefined },
    activePanelId: 'ide-mode',
  })
  plugin.apply(ctx)
  ok(log.some(entry => entry[0] === 'register' && entry[1] === 'main'),
    'the workspace works without the shortcuts service')
  ok(log.some(entry => entry[0] === 'register' && entry[1] === 'ide-mode.chat'),
    'the embedded chat slot is registered anyway')
  ok(!log.some(entry => entry[0] === 'INJECT_THREW'), 'and nothing threw')
}

// ── The switch drives the mode transition ──────────────────────────────────
{
  storage.store.clear()
  const { ctx, log } = makeContext({ mountedSessionId: 'session-1' })
  plugin.apply(ctx)
  log.length = 0

  // The panel, session-row, and chat-body components are registered above; the
  // transition itself is exercised through the shortcut command, which is the
  // one handler reachable without a renderer.
  // The session the workspace would edit: one retained by the main view.
  const { ctx: ctx2, log: log2 } = makeContext({
    byId: { 'session-1': { displayTitle: 'One', retainedBy: { mainView: 1 } } },
  })
  let toggle
  ctx2.get('shortcuts').register = def => {
    if (def.id === 'ide-mode.toggle') toggle = def
    return () => {}
  }
  plugin.apply(ctx2)
  ok(toggle !== undefined, 'the toggle command resolves a target')

  const first = toggle.resolve({ region: 'page', modal: null, target: null })
  eq(first.status, 'handled', 'the toggle handles its gesture')

  const requests = log2.map(entry => entry[0] === 'selectPanel' ? `selectPanel:${String(entry[1])}` : entry[0])
  ok(requests.includes('selectPanel:ide-mode'), 'entering IDE mode selects the workspace panel')
  ok(requests.includes('toggleSidebar'), 'entering IDE mode collapses the left column')
  ok(!log2.some(entry => entry[0] === 'openRightbar' || entry[0] === 'openTabIn'),
    'entering IDE mode touches nothing in the shipped rightbar')
  eq(storage.getItem('dsh-ide-mode:enabled'), '1', 'the mode is remembered')

  // The layout's selection is what the switch reads, so handing it back the
  // Conversation is what ends the mode.
  ctx2.layout.panelInfo.value = { activePanelId: 'ide-mode' }
  const second = toggle.resolve({ region: 'page', modal: null, target: null })
  eq(second.status, 'handled', 'the toggle handles the reverse gesture')
  const back = log2.filter(entry => entry[0] === 'selectPanel').map(entry => entry[1])
  ok(back.includes(null), 'leaving IDE mode returns the Conversation')
  eq(storage.getItem('dsh-ide-mode:enabled'), '0', 'the remembered mode follows')
}

// ── A stored layout is a hint, never a requirement ─────────────────────────
//
// The layout is read while the module body runs, before any component exists.
// One bad field throwing there would leave the panel unregistered and IDE mode
// coming up empty, so a corrupt or stale entry must degrade to the default and
// the plugin must still activate.
{
  const seeds = [
    ['corrupt JSON', '{not json'],
    ['every field the wrong shape',
      JSON.stringify({ section: 'bogus', terminal: 'nope', chatVisible: 'yes', chatWidth: 99999 })],
    ['a layout from a newer build',
      JSON.stringify({ section: 'git', terminal: 'expanded', chatVisible: false, chatWidth: 600, future: 1 })],
  ]
  for (const [label, seed] of seeds) {
    let loaded
    try {
      loaded = loadBundle({ 'dsh-ide-mode:layout': seed })
      ok(true, `a ${label} does not stop the bundle from loading`)
    } catch (error) {
      ok(false, `a ${label} does not stop the bundle from loading`, error.message)
      continue
    }
    const { ctx, log } = makeContext({})
    loaded.plugin.apply(ctx)
    ok(log.some(entry => entry[0] === 'register' && entry[1] === 'main'),
      `the workspace still registers over a ${label}`)
  }
}

// ── The two stored keys stay apart ─────────────────────────────────────────
// The mode flag and the layout share one storage area, so a shared key would
// let a layout write flip the mode (or the reverse) after a reload.
{
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  ok(source.includes("const PERSIST_KEY = 'dsh-ide-mode:enabled'"), 'the mode flag keeps its key')
  ok(source.includes("const LAYOUT_KEY = 'dsh-ide-mode:layout'"), 'the layout has its own namespaced key')
}

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
if (failures > 0) {
  console.error(`${String(failures)} failed`)
  process.exitCode = 1
}
