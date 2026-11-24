/**
 * Browser half of `dsh-ide-mode`.
 *
 * One switch in the top-left corner turns the shell into an IDE and back.
 * Nothing shipped is replaced:
 *
 * - The switch lives in `conversation.header.leading` (root scope, always
 *   mounted, top-left) and stays visible in normal mode.
 * - IDE mode selects a `main` panel of this plugin's own (`key: 'ide-mode'`):
 *   the whole workspace — a File / Terminal bar, an Explorer / Search / Source
 *   control rail, the editor, and the terminal drawer.
 * - Normal mode selects `null`, the Conversation, exactly as before.
 * - A `sidebar.panellist` row makes the workspace reachable from the shell's
 *   own panel list and shows the active panel through the shipped state.
 *
 * The mode is a main-panel selection, not DOM surgery: the conversation keeps
 * its geometry, the sidebar keeps its behaviour, and nothing is patched.
 *
 * Host work travels over this plugin's own same-origin routes (`index.js`) —
 * Git, the terminal, and every file mutation. Nothing here reads another
 * plugin's DOM or stylesheet.
 */

window.__ModuleLoader__.load({
  id: 'dsh-ide-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'ide-mode'

    /** This plugin's main-panel key, shared by the panel, the switch, and the sidebar row. */
    const PANEL_KEY = 'ide-mode'

    /** localStorage key for the remembered mode. */
    const PERSIST_KEY = 'dsh-ide-mode:enabled'

    /** localStorage key for the remembered pane layout. */
    const LAYOUT_KEY = 'dsh-ide-mode:layout'

    /** Rail sections, in rail order. A stored section must be one of these. */
    const SECTIONS = ['explorer', 'search', 'git']

    /** Terminal drawer states. A stored state must be one of these. */
    const TERMINALS = ['none', 'open', 'expanded']

    /** The conversation column's drag range, in px. */
    const CHAT_MIN = 280
    const CHAT_MAX = 720

    // ── Host route spellings. Mirrored from index.js; keep both in sync. ────
    const ROUTE = {
      status: 'ide-mode/git/status',
      index: 'ide-mode/git/index',
      commit: 'ide-mode/git/commit',
      diff: 'ide-mode/git/diff',
      discard: 'ide-mode/git/discard',
      branch: 'ide-mode/git/branch',
      log: 'ide-mode/git/log',
      init: 'ide-mode/git/init',
      remote: 'ide-mode/git/remote',
      sync: 'ide-mode/git/sync',
      exec: 'ide-mode/exec',
      list: 'ide-mode/fs/list',
      search: 'ide-mode/fs/search',
      read: 'ide-mode/fs/read',
      write: 'ide-mode/fs/write',
      mkdir: 'ide-mode/fs/mkdir',
      remove: 'ide-mode/fs/delete',
    }

    // ── Copy ───────────────────────────────────────────────────────────────

    const zh = {
      'switch.off': 'Agent', 'switch.on': 'IDE',
      'switch.toggle': '在 Agent 与 IDE 之间切换',
      'switch.shortcut': '',
      'panel.title': 'IDE 工作区',
      'ide.chat': '会话',
      'ide.chatHint': '右侧是当前会话；在左侧编辑文件、跑命令，随时切回正常模式继续对话。',
      'ide.chatEmpty': '当前没有活动会话。回到正常模式发起对话后，这里会自动显示它。',
      'ide.chatShow': '显示会话',
      'ide.chatHide': '收起会话',
      'rail.explorer': '资源管理器', 'rail.search': '查找', 'rail.git': '源代码管理',
      'topbar.file': '文件', 'topbar.terminal': '终端',
      'file.new': '新建文件', 'file.newFolder': '新建文件夹', 'file.save': '保存',
      'file.revert': '撤销修改', 'file.delete': '删除',
      'file.refresh': '刷新', 'file.showHidden': '显示隐藏文件',
      'file.empty': '未打开文件',
      'file.emptyHint': '在左侧资源管理器里选一个文件，或用上方的「文件」菜单打开。',
      'file.binary': '这是二进制文件，无法在这里编辑。',
      'file.tooLarge': '该文件太大，无法在这里编辑（上限 {bytes}）。',
      'file.pathHint': '相对工作区的路径，例如 src/index.ts',
      'file.create': '创建', 'file.cancel': '取消',
      'file.modified': '有未保存的修改', 'file.saved': '已保存 {name}',
      'file.saveFailed': '保存 {name} 失败：{reason}',
      'file.deleted': '已删除 {name}',
      'file.deleteConfirm': '删除 {name}？此操作不可恢复。',
      'file.needOpen': '先打开一个文件',
      'file.unsavedTitle': '有未保存的修改',
      'file.unsavedBody': '「{name}」还有没保存的修改。要保存后再打开另一个文件吗？',
      'file.saveAndOpen': '保存并打开', 'file.discardUnsaved': '放弃修改',
      'terminal.title': '终端', 'terminal.clear': '清屏', 'terminal.stop': '停止',
      'terminal.running': '执行中…', 'terminal.exit': '已退出，代码 {code}',
      'terminal.hint': '输入命令后回车', 'terminal.needSession': '请先打开一个会话',
      'terminal.open': '打开终端', 'terminal.close': '收起终端',
      'terminal.failed': '命令失败：{reason}', 'terminal.collapsed': '终端已收起',
      'search.placeholder': '按文件名搜索', 'search.noResults': '没有匹配',
      'search.placeholderContent': '搜索文件内容',
      'search.modeName': '文件名', 'search.modeContent': '内容',
      'search.hintContent': '输入关键词，搜索工作区里所有文件的内容。',
      'search.line': '第 {line} 行',
      'search.searching': '搜索中…', 'search.hint': '输入关键词，搜索工作区里所有文件名。',
      'search.more': '结果已截断',
      'git.noRepo': '不是 Git 仓库',
      'git.noRepoHint': '该工作区没有仓库，无法列出更改。',
      'git.init': '初始化仓库', 'git.inited': '已初始化 Git 仓库',
      'git.initFailed': '初始化失败：{reason}',
      'git.clean': '没有更改', 'git.staged': '已暂存', 'git.changes': '更改',
      'git.stage': '暂存', 'git.unstage': '取消暂存',
      'git.stageAll': '全部暂存', 'git.unstageAll': '全部取消暂存',
      'git.commit': '提交', 'git.commitPlaceholder': '提交信息（Ctrl+Enter 提交）',
      'git.committing': '提交中…', 'git.committed': '已提交', 'git.nothing': '没有可提交的内容',
      'git.ahead': '领先 {count}', 'git.behind': '落后 {count}', 'git.detached': '分离头指针',
      'git.refresh': '刷新', 'git.failed': 'Git 失败：{reason}',
      'git.switchBranch': '切换分支', 'git.switched': '已切换到 {name}',
      'git.switchFailed': '切换分支失败：{reason}', 'git.branchFailed': '读取分支失败：{reason}',
      'git.discard': '放弃更改', 'git.discarded': '已放弃更改', 'git.discardFailed': '放弃更改失败：{reason}',
      'git.history': '最近提交', 'git.logFailed': '读取历史失败：{reason}', 'git.noDiff': '没有差异可显示',
      'git.stageFailed': '暂存失败：{reason}', 'git.unstageFailed': '取消暂存失败：{reason}',
      'git.commitFailed': '提交失败：{reason}',
      'git.fetch': '获取远端更新', 'git.pull': '拉取（仅快进）', 'git.push': '推送到远端',
      'git.fetched': '已获取远端更新', 'git.pulled': '已拉取', 'git.pushed': '已推送',
      'git.syncFailed': '同步失败：{reason}', 'git.noRemote': '没有配置远端',
      'git.rejected': '远端有你本地没有的提交，先拉取再推送',
      'git.openRemote': '在浏览器中打开仓库', 'git.openCommit': '在浏览器中打开提交',
      'common.loading': '加载中…', 'common.close': '关闭', 'common.cancel': '取消',
      'common.retry': '重试', 'common.none': '无',
    }

    const en = {
      'switch.off': 'Agent', 'switch.on': 'IDE',
      'switch.toggle': 'Switch between Agent and IDE',
      'switch.shortcut': '',
      'panel.title': 'IDE workspace',
      'ide.chat': 'Chat',
      'ide.chatHint': 'The Session sits on the right; edit files and run commands on the left, and switch back to normal mode to keep talking.',
      'ide.chatEmpty': 'No active Session. Start one in normal mode and it shows up here automatically.',
      'ide.chatShow': 'Show chat',
      'ide.chatHide': 'Hide chat',
      'rail.explorer': 'Explorer', 'rail.search': 'Search', 'rail.git': 'Source control',
      'topbar.file': 'File', 'topbar.terminal': 'Terminal',
      'file.new': 'New file', 'file.newFolder': 'New folder', 'file.save': 'Save',
      'file.revert': 'Revert', 'file.delete': 'Delete',
      'file.refresh': 'Refresh', 'file.showHidden': 'Show hidden files',
      'file.empty': 'No file open',
      'file.emptyHint': 'Pick a file in Explorer on the left, or open the File menu above.',
      'file.binary': 'This file is not text and cannot be edited here.',
      'file.tooLarge': 'This file is too large to edit here (limit {bytes}).',
      'file.pathHint': 'Path relative to the workspace, e.g. src/index.ts',
      'file.create': 'Create', 'file.cancel': 'Cancel',
      'file.modified': 'Unsaved changes', 'file.saved': 'Saved {name}',
      'file.saveFailed': 'Could not save {name}: {reason}',
      'file.deleted': 'Deleted {name}',
      'file.deleteConfirm': 'Delete {name}? This cannot be undone.',
      'file.needOpen': 'Open a file first',
      'file.unsavedTitle': 'Unsaved changes',
      'file.unsavedBody': '"{name}" has unsaved changes. Save before opening another file?',
      'file.saveAndOpen': 'Save and open', 'file.discardUnsaved': 'Discard changes',
      'terminal.title': 'Terminal', 'terminal.clear': 'Clear', 'terminal.stop': 'Stop',
      'terminal.running': 'Running…', 'terminal.exit': 'Exited with code {code}',
      'terminal.hint': 'Type a command and press Enter', 'terminal.needSession': 'Open a conversation first',
      'terminal.open': 'Open terminal', 'terminal.close': 'Hide terminal',
      'terminal.failed': 'Command failed: {reason}', 'terminal.collapsed': 'Terminal hidden',
      'search.placeholder': 'Search files by name', 'search.noResults': 'No matches',
      'search.placeholderContent': 'Search inside files',
      'search.modeName': 'Name', 'search.modeContent': 'Content',
      'search.hintContent': 'Type to search inside every file in the workspace.',
      'search.line': 'Line {line}',
      'search.searching': 'Searching…', 'search.hint': 'Type to search every file name in the workspace.',
      'search.more': 'Results were truncated',
      'git.noRepo': 'Not a Git repository',
      'git.noRepoHint': 'This workspace has no repository, so changes cannot be listed.',
      'git.init': 'Initialize repository', 'git.inited': 'Repository initialized',
      'git.initFailed': 'Initialization failed: {reason}',
      'git.clean': 'No changes', 'git.staged': 'Staged', 'git.changes': 'Changes',
      'git.stage': 'Stage', 'git.unstage': 'Unstage',
      'git.stageAll': 'Stage all', 'git.unstageAll': 'Unstage all',
      'git.commit': 'Commit', 'git.commitPlaceholder': 'Commit message (Ctrl+Enter commits)',
      'git.committing': 'Committing…', 'git.committed': 'Committed', 'git.nothing': 'Nothing to commit',
      'git.ahead': '{count} ahead', 'git.behind': '{count} behind', 'git.detached': 'detached HEAD',
      'git.refresh': 'Refresh', 'git.failed': 'Git failed: {reason}',
      'git.switchBranch': 'Switch branch', 'git.switched': 'Switched to {name}',
      'git.switchFailed': 'Switch failed: {reason}', 'git.branchFailed': 'Branches failed: {reason}',
      'git.discard': 'Discard changes', 'git.discarded': 'Changes discarded', 'git.discardFailed': 'Discard failed: {reason}',
      'git.history': 'Recent commits', 'git.logFailed': 'History failed: {reason}', 'git.noDiff': 'No differences to show',
      'git.stageFailed': 'Could not stage: {reason}', 'git.unstageFailed': 'Could not unstage: {reason}',
      'git.commitFailed': 'Could not commit: {reason}',
      'git.fetch': 'Fetch from remote', 'git.pull': 'Pull (fast-forward only)', 'git.push': 'Push to remote',
      'git.fetched': 'Fetched from remote', 'git.pulled': 'Pulled', 'git.pushed': 'Pushed',
      'git.syncFailed': 'Sync failed: {reason}', 'git.noRemote': 'No remote configured',
      'git.rejected': 'The remote has commits you do not have; pull before pushing',
      'git.openRemote': 'Open repository in browser', 'git.openCommit': 'Open commit in browser',
      'common.loading': 'Loading…', 'common.close': 'Close', 'common.cancel': 'Cancel',
      'common.retry': 'Retry', 'common.none': 'None',
    }

    /** Fill `{name}` placeholders; an unknown name keeps its braces so a bug stays visible. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
        Object.prototype.hasOwnProperty.call(values ?? {}, key) ? String(values[key]) : whole
      ))
    }

    // ── Styles ─────────────────────────────────────────────────────────────
    //
    // One stylesheet for the plugin. Every colour is a host alias token so
    // light and dark follow the theme; the few literals are shadows, the
    // switch knob, and the brand-on-primary foreground.

    const CSS = `
/* Mode switch ----------------------------------------------------------- */
.dide-switch {
  display: inline-flex; align-items: center; gap: 8px; flex: none;
  padding: 0; border: none; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 16px;
  -webkit-app-region: no-drag;
}
.dide-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 6px; }
.dide-switch-track {
  position: relative; width: 34px; height: 18px; border-radius: 999px; flex: none;
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l2);
  transition: background 140ms ease, border-color 140ms ease;
}
.dide-switch[data-on] .dide-switch-track {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dide-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.25);
  transition: transform 140ms cubic-bezier(0.4, 0, 0.2, 1);
}
.dide-switch[data-on] .dide-switch-knob { transform: translateX(16px); }
.dide-switch-label { white-space: nowrap; }
.dide-switch[data-on] .dide-switch-label { color: var(--dsw-alias-label-primary); }
.dide-switch-keys {
  flex: none; margin-left: 2px; padding: 1px 4px; border-radius: 4px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px; line-height: 12px; letter-spacing: 0.02em;
}
/* Rail presentation: the sidebar's 56px column leaves room for one glyph. */
.dide-switch-compact {
  width: 28px; height: 28px; justify-content: center; border-radius: var(--dsw-radius-sm);
}
.dide-switch-compact:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dide-switch-compact .dide-switch-glyph { display: inline-flex; }
/* The New-session row wraps this switch under its own button, so the row
   keeps one full-width primary control and the switch sits beneath it. */
.dide-session-action { display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 100%; min-width: 0; }
.dide-session-action > :first-child { min-width: 0; }
.dide-session-action-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dide-session-action-row > :first-child { flex: 1 1 auto; min-width: 0; }

/* Frame ----------------------------------------------------------------- */
.dide-root {
  display: flex; flex-direction: column; flex: 1; height: 100%;
  min-width: 0; min-height: 0;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  /* The mode switch replaces one full-size panel with another in a single
     commit; a short fade keeps that swap from reading as a hard cut. Pure
     paint: no layout, no timing dependency on anything the shell does. */
  animation: dide-enter 150ms cubic-bezier(0.2, 0, 0.2, 1) both;
}
@keyframes dide-enter {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .dide-root { animation: none; }
  .dide-term-prompt[data-busy] .dide-term-dollar { animation: none; }
}
/* The host ships no global border-box reset, so every plugin box sizes itself.
   Without this a row that is width:100% *and* padded overflows its pane by the
   padding and the pane grows a horizontal scrollbar. Scoped to this plugin's
   own class prefix: the embedded conversation keeps the host's box model. */
.dide-root,
.dide-root [class^='dide-'], .dide-root [class*=' dide-'],
.dide-dialog-mask [class^='dide-'], .dide-dialog-mask [class*=' dide-'] { box-sizing: border-box; }
/* The shell animates its grid tracks for 300ms whenever the sidebar collapses
   (the slow track duration on its [data-animating] frame). During a mode switch
   that means every frame of the slide re-lays-out this whole workspace — tree,
   panes, and the embedded conversation — which is what reads as a stutter.
   The switch drops that motion instead: the frame snaps to its final geometry
   and the fade above carries the transition. Removed again right after. */
html[data-dide-switching] [data-animating] { transition: none !important; }
html[data-dide-switching] [data-animating] * { transition-duration: 0s !important; }
.dide-topbar {
  display: flex; align-items: center; gap: 4px; flex: none;
  height: 38px; padding: 0 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dide-topbar-switch { margin-right: 2px; }
.dide-topbar-sep { width: 1px; height: 18px; margin: 0 4px; background: var(--dsw-alias-border-l1); flex: none; }
.dide-topbar-spacer { flex: 1; min-width: 8px; }
.dide-topbar-path {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 42%;
  font-size: 11px; color: var(--dsw-alias-label-secondary);
  direction: rtl; text-align: left;
}

.dide-menu-host { position: relative; display: inline-flex; }
.dide-topbar-button {
  display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px;
  border: none; border-radius: 6px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; white-space: nowrap;
}
.dide-topbar-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dide-topbar-button[data-open] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
.dide-topbar-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dide-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 220px;
  padding: 4px; border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l1);
  box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  display: flex; flex-direction: column;
}
.dide-menu-item {
  display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 8px;
  border: none; border-radius: 5px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left;
}
.dide-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dide-menu-item:disabled { color: var(--dsw-alias-state-idle-primary); cursor: default; background: transparent; }
.dide-menu-shortcut { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dide-menu-sep { height: 1px; margin: 4px 6px; background: var(--dsw-alias-border-l1); }

/* Body: rail + side pane + work area ------------------------------------ */
.dide-body { flex: 1; min-height: 0; display: flex; }
.dide-rail {
  flex: none; width: 40px; display: flex; flex-direction: column; gap: 2px; padding: 6px 0;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dide-rail-row {
  position: relative; display: flex; align-items: center; justify-content: center;
  height: 34px; margin: 0 5px; padding: 0; border: none; border-radius: 6px;
  background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary);
}
.dide-rail-row:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dide-rail-row[data-active] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-active); }
.dide-rail-row[data-active]::before {
  content: ''; position: absolute; left: -5px; top: 7px; bottom: 7px; width: 2px; border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
}
.dide-rail-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }

.dide-side {
  flex: none; width: 272px; min-width: 190px; display: flex; flex-direction: column;
  border-right: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); overflow: hidden;
}
.dide-pane {
  display: flex; flex-direction: column; min-height: 0; flex: 1;
  /* A recessed sidebar keeps the editor the brightest surface, the way an IDE
     separates rail, panel and canvas without drawing extra borders. */
  background: var(--dsw-alias-bg-layer-1);
}
.dide-pane-head {
  display: flex; align-items: center; gap: 2px; flex: none;
  height: 30px; padding: 0 6px 0 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
}
.dide-pane-head-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dide-pane-spacer { flex: 1; min-width: 4px; }
.dide-pane-body { flex: 1; min-height: 0; overflow: auto; padding: 0 4px 8px; }

.dide-icon-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 5px; flex: none;
  background: transparent; cursor: pointer; color: var(--dsw-alias-label-secondary);
}
.dide-icon-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dide-icon-button:disabled { color: var(--dsw-alias-state-idle-primary); cursor: default; }
.dide-icon-button[data-on] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }

.dide-tree-row {
  display: flex; align-items: center; gap: 4px; width: 100%;
  height: 22px; padding: 0 4px; border: none; border-radius: 4px;
  background: transparent; cursor: pointer; text-align: left;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; white-space: nowrap;
}
.dide-tree-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dide-tree-row[data-current] { background: var(--dsw-alias-interactive-bg-active); }
.dide-tree-row[data-hidden] { opacity: 0.62; }
.dide-tree-twist {
  display: inline-flex; justify-content: center; width: 12px; flex: none;
  color: var(--dsw-alias-label-secondary); transition: transform 120ms ease;
}
.dide-tree-twist[data-open] { transform: rotate(90deg); }
.dide-tree-name { overflow: hidden; text-overflow: ellipsis; }
.dide-tree-note { padding: 2px 0 2px 16px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dide-empty {
  padding: 14px 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px;
}
.dide-field {
  display: flex; align-items: center; gap: 6px; margin: 0 8px 6px; flex: none;
  height: 28px; padding: 0 8px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l1);
}
.dide-field input {
  flex: 1; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.dide-field input::placeholder { color: var(--dsw-alias-label-secondary); }
.dide-result {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%;
  padding: 4px 6px; border: none; border-radius: 4px; background: transparent; cursor: pointer;
  text-align: left; color: var(--dsw-alias-label-primary);
}
.dide-result:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dide-result-name { font-size: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dide-result-path { font-size: 10.5px; color: var(--dsw-alias-label-secondary); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
/* The name/content switch above the result list: two quiet chips, no border. */
.dide-tabs { display: flex; gap: 4px; flex: none; padding: 0 8px 6px; }
.dide-tab {
  border: none; background: transparent; cursor: pointer; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-family: inherit; color: var(--dsw-alias-label-secondary);
}
.dide-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dide-tab[data-active] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
/* A content hit carries a line and its text, so the row reads like a grep -n. */
.dide-result-line { color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.dide-result-dir { margin-left: 6px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dide-result-text {
  max-width: 100%; font-family: ui-monospace, monospace; font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Source control -------------------------------------------------------- */
.dide-git-head {
  display: flex; align-items: center; gap: 6px; flex: none; min-height: 30px;
  padding: 0 8px 0 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.dide-git-branch { display: inline-flex; align-items: center; gap: 5px; min-width: 0; font-size: 12px; }
.dide-git-branch span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dide-git-track { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
/* The remote line: one row that answers "where does this push to?" and holds the
   three commands that reach it. It sits under the branch row so a workspace with
   no remote simply has no second row. */
.dide-git-remote {
  display: flex; align-items: center; gap: 4px; flex: none; min-height: 28px;
  padding: 0 8px 0 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dide-git-remote-open {
  display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 2px 4px;
  border: none; border-radius: 4px; background: transparent; color: inherit;
  font: inherit; font-size: 11.5px; cursor: pointer;
}
.dide-git-remote-open:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dide-git-remote-open svg { color: var(--dsw-alias-label-secondary); }
.dide-git-remote-badge {
  flex: none; padding: 0 6px; height: 16px; display: inline-flex; align-items: center;
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
  font-size: 10px; letter-spacing: 0.02em; color: var(--dsw-alias-label-secondary);
}
.dide-git-remote[data-provider='github'] .dide-git-remote-badge { color: var(--dsw-alias-label-primary); }
.dide-git-remote-path {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, monospace;
}
.dide-icon-button[data-syncing] { color: var(--dsw-alias-brand-primary); animation: dide-pulse 900ms ease-in-out infinite; }
/* The branch chip is a menu button: it opens the branch inventory. */
.dide-git-branch-host { position: relative; display: flex; align-items: center; min-width: 0; }
button.dide-git-branch {
  border: none; background: transparent; color: inherit; padding: 2px 4px; border-radius: 4px;
  cursor: pointer; font: inherit;
}
button.dide-git-branch:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
button.dide-git-branch:disabled { cursor: default; }
.dide-git-menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 40; min-width: 180px; max-height: 280px;
  overflow-y: auto; padding: 4px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); box-shadow: 0 6px 20px var(--dsw-alias-border-l1, rgb(0 0 0 / 18%));
}
.dide-git-menu-row {
  display: block; width: 100%; text-align: left; border: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 5px 8px;
  border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dide-git-menu-row:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); }
.dide-git-menu-row[data-current] { color: var(--dsw-alias-brand-primary); font-weight: 600; cursor: default; }
/* Inline diff preview and commit history share the pane's scroll body. */
.dide-git-preview { flex: none; display: flex; flex-direction: column; max-height: 40%; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dide-git-preview-head {
  flex: none; display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 12px;
  background: var(--dsw-alias-bg-layer-2);
}
.dide-git-preview-title { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dide-git-diff {
  flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 8px 12px;
  font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); white-space: pre;
}
.dide-git-log { flex: none; max-height: 30%; overflow-y: auto; border-bottom: 1px solid var(--dsw-alias-border-l1); padding-bottom: 4px; }
.dide-git-log-row { display: flex; gap: 8px; align-items: baseline; padding: 3px 12px; font-size: 11px; }
.dide-git-log-hash { flex: none; font-family: ui-monospace, monospace; color: var(--dsw-alias-brand-primary); }
.dide-git-log-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.dide-git-log-when { flex: none; color: var(--dsw-alias-label-secondary); }
/* A commit row is a link only when the remote can resolve it; hover says so. */
.dide-git-log-row[role='button'] { cursor: pointer; border-radius: 4px; }
.dide-git-log-row[role='button']:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dide-git-log-link { flex: none; display: inline-flex; color: var(--dsw-alias-label-secondary); }
.dide-icon-button[data-on] { color: var(--dsw-alias-brand-primary); }
.dide-git-row[data-preview] { background: var(--dsw-alias-bg-layer-2); }
.dide-git-group { display: flex; flex-direction: column; padding: 4px 0; }
.dide-git-group-title {
  display: flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px;
  font-size: 11px; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: 0.04em;
}
.dide-git-group-title > span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dide-git-group-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
/* A count pill qualifies the group name without competing with it. */
.dide-git-count {
  flex: none; min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 10.5px; line-height: 16px; text-align: center; letter-spacing: 0;
  text-transform: none; font-variant-numeric: tabular-nums;
}
.dide-git-row {
  display: flex; align-items: center; gap: 4px; width: 100%; height: 24px;
  padding: 0 4px 0 10px; border: none; border-radius: 4px; background: transparent;
  cursor: pointer; text-align: left; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.dide-git-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dide-git-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dide-git-code {
  flex: none; width: 14px; text-align: center;
  font-family: ui-monospace, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary);
}
/* The status letter is the only signal a row carries before it is opened, so
   it gets the state colour instead of the same grey as the path. */
.dide-git-code[data-code='M'], .dide-git-code[data-code='R'] { color: var(--dsw-alias-state-warn-primary); }
.dide-git-code[data-code='A'], .dide-git-code[data-code='?'] { color: var(--dsw-alias-brand-primary); }
.dide-git-code[data-code='D'], .dide-git-code[data-code='U'] { color: var(--dsw-alias-state-error-primary); }
.dide-git-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Dimmed directory prefix, full-contrast name: the list stays scannable when
   every row sits in the same folder. */
.dide-git-dir { color: var(--dsw-alias-label-secondary); }
.dide-git-actions { display: inline-flex; gap: 0; opacity: 0; flex: none; }
.dide-git-row:hover .dide-git-actions, .dide-git-row:focus-within .dide-git-actions { opacity: 1; }
.dide-commit { display: flex; flex-direction: column; gap: 6px; padding: 8px; flex: none; border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dide-commit textarea {
  resize: vertical; min-height: 52px; max-height: 140px; padding: 6px 8px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; outline: none;
}
.dide-commit textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.dide-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 26px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); cursor: pointer;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px;
}
.dide-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dide-button:disabled { color: var(--dsw-alias-state-idle-primary); cursor: default; }
.dide-button[data-primary] {
  background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff;
}
.dide-button[data-primary]:disabled { opacity: 0.5; }

/* Work area: editor over terminal --------------------------------------- */
.dide-work { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.dide-editor { flex: 1; min-height: 0; display: flex; flex-direction: column; }
/* The canvas empty state: a quiet mark, then the two lines that tell a reader
   how to get a file here. Centred, never a bare line of grey text. */
.dide-editor-empty {
  margin: auto; padding: 24px; max-width: 400px;
  display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center;
}
.dide-editor-empty-mark {
  display: flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; margin-bottom: 4px; border-radius: 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
}
.dide-editor-empty-title { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dide-editor-empty-hint {
  font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-secondary);
}
.dide-editor-bar {
  display: flex; align-items: center; gap: 6px; flex: none;
  height: 30px; padding: 0 6px 0 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dide-editor-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: none; }
.dide-editor-dir { font-size: 10.5px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dide-editor-area { flex: 1; min-height: 0; display: flex; overflow: hidden; background: var(--dsw-alias-bg-base); }
.dide-gutter {
  flex: none; overflow: hidden; margin: 0; padding: 8px 8px 8px 10px; text-align: right;
  color: var(--dsw-alias-state-idle-primary);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 12px; line-height: 18px; user-select: none;
}
.dide-textarea {
  flex: 1; min-width: 0; resize: none; border: none; outline: none;
  padding: 8px 12px 8px 4px; background: transparent; color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 12px; line-height: 18px; tab-size: 2; white-space: pre; overflow: auto;
}
.dide-editor-foot {
  display: flex; align-items: center; gap: 8px; flex: none;
  height: 24px; padding: 0 8px 0 10px; font-size: 11px; color: var(--dsw-alias-label-secondary);
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dide-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); flex: none; }
.dide-notice { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dide-notice[data-bad] { color: var(--dsw-alias-state-error-primary); }

/* Terminal -------------------------------------------------------------- */
.dide-term { display: flex; flex-direction: column; min-height: 0; flex: none; }
/* Collapsed: the head plus the prompt row, so the reader can always type. */
.dide-term:not([data-expanded]) { flex: none; }
.dide-term[data-expanded] { flex: 1; min-height: 140px; }
.dide-term-head {
  display: flex; align-items: center; gap: 6px; flex: none; height: 30px; padding: 0 6px 0 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 11px; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: 0.04em;
}
.dide-term-out {
  flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 8px 12px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 12px; line-height: 17px; white-space: pre-wrap; word-break: break-word;
  cursor: text;
}
.dide-term[data-expanded] .dide-term-out { border-top: 0.5px solid var(--dsw-alias-border-l1); }
.dide-term-block { display: block; }
/* One command, one block: a hairline is enough to separate them without
   adding chrome between every prompt and its output. */
.dide-term-block + .dide-term-block {
  margin-top: 6px; padding-top: 6px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.dide-term-err { color: var(--dsw-alias-state-error-primary); }
.dide-term-meta { color: var(--dsw-alias-label-secondary); }
/* The exit line carries its own verdict: a dot that is grey when the command
   returned 0 and red otherwise, so a long transcript can be scanned. */
.dide-term-meta[data-code]::before {
  content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 6px;
  border-radius: 50%; vertical-align: middle;
  background: var(--dsw-alias-state-idle-primary, var(--dsw-alias-border-l1));
}
.dide-term-meta[data-code]:not([data-code='0'])::before { background: var(--dsw-alias-state-error-primary); }
.dide-term-prompt {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 0 10px 0 12px; min-height: 34px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  cursor: text;
  transition: background-color 120ms ease, box-shadow 120ms ease;
}
/* The caret is a 1px line at the bottom of a wide panel, so the bar itself has
   to answer "typing goes here": hover lifts it, focus outlines the whole row. */
.dide-term-prompt:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dide-term-prompt:focus-within {
  background: var(--dsw-alias-bg-base);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary);
}
.dide-term-dollar {
  flex: none; color: var(--dsw-alias-brand-primary);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 12.5px; font-weight: 600; line-height: 20px;
}
/* While a command runs the prompt mark breathes instead of pretending the
   line is idle. */
.dide-term-prompt[data-busy] .dide-term-dollar { animation: dide-pulse 900ms ease-in-out infinite; }
@keyframes dide-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.dide-term-prompt input {
  flex: 1; min-width: 0; height: 20px; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); cursor: text;
  caret-color: var(--dsw-alias-brand-primary);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.dide-term-prompt input::placeholder { color: var(--dsw-alias-label-secondary); }
/* The Enter hint only exists once there is something to run, so it never
   crowds an empty bar. */
.dide-term-key {
  flex: none; height: 18px; padding: 0 5px; border-radius: 4px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 10px; line-height: 17px; letter-spacing: 0.02em;
}

/* Embedded conversation -------------------------------------------------- */
/* The right column hosts the Session itself (the shipped embedded factory),
   not a right-Sidebar tab: the shipped rightbar hides every Session view
   while a non-conversation panel fills the main column, so hosting there can
   never show the chat in IDE mode. */
.dide-chatcol {
  flex: none; width: var(--dide-chat-width, 420px); min-width: 280px;
  display: flex; flex-direction: column; min-height: 0;
  border-left: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
.dide-chat-head {
  display: flex; align-items: center; gap: 6px; flex: none;
  height: 30px; padding: 0 6px 0 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font-size: 11px;
}
.dide-chat-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dide-chat-body { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.dide-chat-body > * { flex: 1; min-height: 0; min-width: 0; }
.dide-chat-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 16px; text-align: center;
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px;
}
.dide-chatsplit {
  flex: none; width: 5px; cursor: col-resize; display: flex; align-items: center; justify-content: center;
  background: transparent;
}
.dide-chatsplit:hover, .dide-chatsplit[data-drag] { background: var(--dsw-alias-interactive-bg-hover); }

/* Dialog ---------------------------------------------------------------- */
.dide-dialog-mask {
  position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.28); z-index: 60;
}
.dide-dialog {
  width: min(380px, calc(100vw - 32px)); padding: 14px; border-radius: 10px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: 0 16px 48px rgba(0,0,0,0.28);
  display: flex; flex-direction: column; gap: 10px;
}
.dide-dialog-title { font-size: 13px; font-weight: 600; }
/* The question itself: one sentence, never a block of policy prose. */
.dide-dialog-body { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dide-dialog-row { display: flex; justify-content: flex-end; gap: 8px; }
.dide-dialog .dide-field { margin: 0; }
/* The destructive choice reads as destructive before it is pressed. */
.dide-button[data-danger] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}
.dide-button[data-danger]:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .dide-switch-track, .dide-switch-knob, .dide-tree-twist { transition: none; }
}
`

    // ── Icons ──────────────────────────────────────────────────────────────

    /** 16px stroke glyph base, inheriting the surrounding text color. */
    function stroke(paths, size) {
      const side = size ?? 16
      return h('svg', {
        viewBox: '0 0 16 16', width: side, height: side, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
      }, ...paths.map((d, index) => h('path', { key: index, d })))
    }

    const ICON = {
      explorer: size => h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, h('path', { d: 'M2.5 3.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z' })),
      search: size => h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true, focusable: false,
      }, h('circle', { cx: 7, cy: 7, r: 4.2 }), h('path', { d: 'M10.2 10.2 13.5 13.5' })),
      git: size => h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true, focusable: false,
      }, h('circle', { cx: 4.5, cy: 4, r: 1.8 }), h('circle', { cx: 4.5, cy: 12, r: 1.8 }),
        h('circle', { cx: 11.5, cy: 8, r: 1.8 }), h('path', { d: 'M4.5 5.8v4.4' }),
        h('path', { d: 'M6.3 4.6c1.6.6 2.6 1.7 3.4 2.8' })),
      file: size => stroke(['M4 2.5h5l3 3v8h-8z', 'M9 2.5v3h3'], size),
      terminal: size => stroke(['M2.5 3.5h11v9h-11z', 'M5 6.5 7 8.5 5 10.5', 'M8.5 10.5h3'], size),
      chevron: size => stroke(['M6 4l4 4-4 4'], size),
      close: () => stroke(['M4 4l8 8', 'M12 4l-8 8']),
      save: () => stroke(['M3 3h7l3 3v7H3z', 'M5.5 3v3.5h4V3', 'M5.5 13V9.5h5V13']),
      refresh: () => stroke(['M13 8a5 5 0 1 1-1.6-3.7', 'M13 3v3h-3']),
      history: () => stroke(['M8 4.5V8l2.5 1.5', 'M13.2 8a5.2 5.2 0 1 1-1.5-3.7', 'M13.5 2.5v2.6h-2.6']),
      plus: () => stroke(['M8 3.5v9', 'M3.5 8h9']),
      minus: () => stroke(['M3.5 8h9']),
      trash: () => stroke(['M3 4.5h10', 'M5.5 4.5V3h5v1.5', 'M4.5 4.5 5 13h6l.5-8.5', 'M6.5 7v3.5', 'M9.5 7v3.5']),
      newFolder: () => stroke(['M2.5 3.5a1 1 0 0 1 1-1h3l1.2 1.5h4.8a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z', 'M8 6v4', 'M6 8h4']),
      eye: () => stroke(['M1.5 8S4 4.5 8 4.5 14.5 8 14.5 8 12 11.5 8 11.5 1.5 8 1.5 8z', 'M8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z']),
      expand: size => stroke(['M9.5 2.5h4v4', 'M13.5 2.5 9 7', 'M6.5 13.5h-4v-4', 'M2.5 13.5 7 9'], size),
      collapse: size => stroke(['M13.5 6.5h-4v-4', 'M9.5 6.5 14 2', 'M2.5 9.5h4v4', 'M6.5 9.5 2 14'], size),
      // Rail switch glyphs: a panel with its left column filled reads as
      // "conversation only", the split square reads as "workspace + chat".
      collapseRail: size => h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, h('rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.6 }), h('path', { d: 'M6 3v10' })),
      expandRail: size => h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinejoin: 'round', 'aria-hidden': true, focusable: false,
      }, h('rect', { x: 2, y: 3, width: 12, height: 10, rx: 1.6 }), h('path', { d: 'M9 3v10M2 8h7' })),
      // Remote glyphs: a cloud for fetch, arrows for the two that move a branch.
      cloud: () => stroke(['M4.6 12.2h6.6a2.6 2.6 0 0 0 .3-5.2 3.6 3.6 0 0 0-6.8-.9 2.9 2.9 0 0 0-.1 6.1z']),
      down: () => stroke(['M8 3.2v8.2', 'M4.6 8.2 8 11.6l3.4-3.4']),
      up: () => stroke(['M8 12.8V4.6', 'M4.6 8 8 4.6 11.4 8']),
      external: () => stroke(['M9.6 3.2h3.2v3.2', 'M12.8 3.2 7.2 8.8', 'M11.4 9.6v2.6a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1h2.6']),
    }

    // ── Host calls and path helpers ────────────────────────────────────────

    /**
     * POST one JSON body to a plugin route.
     * @param {string} route - document-relative route spelling.
     * @param {object} body - JSON body.
     * @returns {Promise<object>} the parsed reply.
     * @throws {Error} carrying `reason`, `detail`, and `limit` from the Host reply.
     */
    async function post(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        payload = {}
      }
      if (!response.ok) {
        const error = new Error(payload.detail ?? payload.reason ?? `HTTP ${String(response.status)}`)
        error.reason = payload.reason ?? 'http-error'
        error.detail = payload.detail ?? ''
        error.limit = payload.limit
        throw error
      }
      return payload
    }

    /** Human byte size. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '?'
      if (bytes < 1024) return `${String(bytes)} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /** Basename of a POSIX or Windows path. */
    function baseOf(path) {
      if (typeof path !== 'string') return ''
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return cut === -1 ? path : path.slice(cut + 1)
    }

    /** Parent of a POSIX or Windows path. */
    function parentOf(path) {
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      return cut <= 0 ? '' : path.slice(0, cut)
    }

    /**
     * Hand one https URL to the user's browser.
     * The desktop shell routes `window.open` targets through `shell.openExternal`,
     * so a plain call opens the real browser instead of a second app window.
     * @param url - absolute http(s) URL.
     */
    function openExternal(url) {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
      const opener = typeof window.open === 'function' ? window.open : undefined
      if (opener === undefined) return
      opener.call(window, url, '_blank', 'noopener,noreferrer')
    }

    /**
     * Split a repository-relative path into the directory prefix (including the
     * trailing separator, so it reads `src/`) and the trailing name. Change
     * lists dim the prefix and keep the name at full contrast, which is what
     * makes a flat list of `_tmp/`, `dsh-ide-mode/` and `extract_watch.py`
     * scannable.
     */
    function splitPath(path) {
      if (typeof path !== 'string') return { prefix: '', name: '' }
      const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      if (cut === -1) return { prefix: '', name: path }
      return { prefix: path.slice(0, cut + 1), name: path.slice(cut + 1) }
    }

    /** Join a root and a relative path with `/`, collapsing the seam. */
    function joinPath(root, relative) {
      if (relative === undefined || relative === '') return root
      return `${String(root).replace(/[\\/]+$/, '')}/${String(relative).replace(/^[\\/]+/, '')}`
    }

    /** Whether `path` names `root` or sits below it, ignoring case. */
    function isUnder(path, root) {
      const left = String(path).replace(/\\/g, '/').toLowerCase()
      const right = String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      return left === right || left.startsWith(`${right}/`)
    }

    /** Path of `path` relative to `root`, or the basename when it is outside. */
    function relativeTo(path, root) {
      if (root === undefined || !isUnder(path, root)) return baseOf(path)
      const rootLength = String(root).replace(/\\/g, '/').replace(/\/+$/, '').length
      return String(path).replace(/\\/g, '/').slice(rootLength + 1)
    }

    /** Split a porcelain `XY` into its two sides. */
    function splitStatus(xy) {
      const code = String(xy ?? '  ').padEnd(2, ' ')
      return {
        staged: code[0] === ' ' || code[0] === '?' ? '' : code[0],
        worktree: code[1] === ' ' || code[1] === '?' ? '' : code[1],
        untracked: code === '??',
      }
    }

    // ── The mode store ─────────────────────────────────────────────────────
    //
    // The mode is a property of the page, not of a Session or a slot
    // occurrence, so it lives at module scope and every seat reads it through
    // `useSyncExternalStore`. Published snapshots are immutable objects — uSES
    // compares by identity, so mutating one in place would strand subscribers.

    function readPersisted() {
      try {
        return window.localStorage.getItem(PERSIST_KEY) === '1'
      } catch {
        // A blocked storage leaves the mode off rather than throwing at boot.
        return false
      }
    }

    function writePersisted(enabled) {
      try {
        window.localStorage.setItem(PERSIST_KEY, enabled ? '1' : '0')
      } catch {
        // Persistence is a convenience; the in-memory flag still governs this page.
      }
    }

    /**
     * The remembered chrome, or the defaults.
     *
     * Only what a reload should carry is kept: which rail section was open, how
     * the terminal drawer sat, and the conversation column's visibility and
     * width. Every field is validated against its closed set, so a stale or
     * hand-edited entry cannot put the panel into a state it has no rendering
     * for — a bad value falls back to that field's default, not to nothing.
     *
     * @returns `{ section, terminal, chatVisible, chatWidth }`.
     */
    function readLayout() {
      const fallback = { section: 'explorer', terminal: 'none', chatVisible: true, chatWidth: 420 }
      let stored
      try {
        const raw = window.localStorage.getItem(LAYOUT_KEY)
        if (raw === null) return fallback
        stored = JSON.parse(raw)
      } catch {
        // Blocked storage, or a value that is not JSON: both mean "defaults".
        return fallback
      }
      if (stored === null || typeof stored !== 'object') return fallback
      return {
        section: SECTIONS.includes(stored.section) ? stored.section : fallback.section,
        terminal: TERMINALS.includes(stored.terminal) ? stored.terminal : fallback.terminal,
        chatVisible: typeof stored.chatVisible === 'boolean' ? stored.chatVisible : fallback.chatVisible,
        chatWidth: Number.isFinite(stored.chatWidth)
          ? Math.min(CHAT_MAX, Math.max(CHAT_MIN, Math.round(stored.chatWidth)))
          : fallback.chatWidth,
      }
    }

    function writeLayout(layout) {
      try {
        window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
      } catch {
        // A blocked storage only means the layout resets on the next reload.
      }
    }

    let state = {
      enabled: readPersisted(),
      // The chrome the user arranged: section, drawer, and conversation column.
      // Spread first so every later field keeps its explicit default.
      ...readLayout(),
      root: undefined,
      sessionId: undefined,
      /** `{ path, text, saved, phase, error? }` — the loaded buffer, never the keystroke text. */
      file: undefined,
      /** `{ path, name }` — a file waiting for the unsaved-buffer decision. */
      pendingOpen: undefined,
      /** Mirrors the editor's own dirty flag, published only when it flips. */
      dirty: false,
      notice: undefined,
      /** True while the column's drag handle is held down. */
      chatSplit: false,
    }
    const listeners = new Set()

    const store = {
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot() {
        return state
      },
      set(patch) {
        state = { ...state, ...patch }
        for (const listener of [...listeners]) listener()
      },
    }

    /** Bind the store to a selector. */
    function useIde(selector) {
      return useSyncExternalStore(store.subscribe, () => selector(state))
    }

    /** One transient status line in the work area's footer. */
    function notify(text, ok) {
      store.set({ notice: { text, ok: ok !== false, at: Date.now() } })
    }

    /**
     * The sidebar's expanded state as the shell last reported it.
     *
     * The shell hands `wide` to its New-session row on every render, which is
     * the only legitimate way to learn this without reading another plugin's
     * DOM. `observed` gates the collapse: before the row has rendered once,
     * a guessed state must not drive a toggle.
     */
    const sidebarState = { wide: true, observed: false, collapsedByIde: false }

    /**
     * The editor's imperative face.
     *
     * The textarea keeps the live text locally (a keystroke must not re-render
     * the tree and the Git list), so the top bar's Save/Revert reach the buffer
     * through this handle instead of through the store. It is written by the
     * mounted `EditorPane` and cleared when that pane unmounts.
     */
    const editorApi = { save: undefined, revert: undefined, text: () => '' }

    // ── The switch ─────────────────────────────────────────────────────────

    /**
     * The mode switch. It owns no copy of the mode: it reads the store (which
     * mirrors the layout's selection) and asks the layout service for the
     * panel, so every surface stays on one source of truth.
     *
     * `compact` is the rail presentation: the sidebar's own 56px column, where
     * only a square glyph fits. The switch stays reachable there, which is what
     * keeps it available after entering IDE mode collapses the column.
     */
    function ModeSwitch({ t, compact, onFlip, shortcutKeys }) {
      const enabled = useIde(snapshot => snapshot.enabled)
      // The chord is whatever the shell has bound for this command, so the
      // tooltip states the truth: an unbound command shows no keycap at all
      // rather than promising a chord that does nothing.
      const keys = shortcutKeys ?? []
      const hint = keys.length > 0 ? keys.join('+') : ''
      const label = enabled ? t('switch.on') : t('switch.off')
      const title = hint === '' ? label : `${label} · ${hint}`
      if (compact) {
        return h('button', {
          type: 'button',
          className: 'dide-switch dide-switch-compact',
          'data-on': enabled ? '' : undefined,
          role: 'switch',
          'aria-checked': enabled,
          'aria-label': hint === '' ? t('switch.toggle') : `${t('switch.toggle')} (${hint})`,
          title,
          onClick: onFlip,
        }, h('span', { className: 'dide-switch-glyph', 'aria-hidden': true },
          enabled ? ICON.collapseRail(18) : ICON.expandRail(18)))
      }
      return h('button', {
        type: 'button',
        className: 'dide-switch',
        'data-on': enabled ? '' : undefined,
        role: 'switch',
        'aria-checked': enabled,
        'aria-label': hint === '' ? t('switch.toggle') : `${t('switch.toggle')} (${hint})`,
        title,
        onClick: onFlip,
      },
        h('span', { className: 'dide-switch-track', 'aria-hidden': true },
          h('span', { className: 'dide-switch-knob' })),
        h('span', { className: 'dide-switch-label' }, label),
        hint !== '' && h('span', { className: 'dide-switch-keys', 'aria-hidden': true }, hint),
      )
    }

    /** Stable empty result so `useSyncExternalStore` sees one identity. */
    const EMPTY_KEYS = Object.freeze([])

    /** The command id this plugin owns. */
    const TOGGLE_COMMAND_ID = 'ide-mode.toggle'

    /**
     * The chord the shell currently has bound for the mode command.
     *
     * Read from the shipped catalog so a user rebind — or no binding at all —
     * is reflected instead of advertised wrongly. The catalog is an observable
     * snapshot; its `keys` are display strings already localized by the shell.
     * @param {object|undefined} shortcuts - the shortcuts service, when mounted.
     * @returns {readonly string[]} keycaps, empty while unbound.
     */
    function useBoundKeys(shortcuts) {
      const subscribe = useCallback(
        listener => (shortcuts === undefined ? () => {} : shortcuts.catalog.subscribe(listener)),
        [shortcuts],
      )
      const getSnapshot = useCallback(() => {
        if (shortcuts === undefined) return EMPTY_KEYS
        const row = shortcuts.catalog.getSnapshot().find(entry => entry.id === TOGGLE_COMMAND_ID)
        const keys = row?.keys
        return keys === undefined || keys.length === 0 ? EMPTY_KEYS : keys
      }, [shortcuts])
      return useSyncExternalStore(subscribe, getSnapshot)
    }

    // ── Shared controls ────────────────────────────────────────────────────

    /** One prompt dialog, used for new file and new folder. */
    function PromptDialog({ t, title, value, onChange, onCancel, onSubmit }) {
      const input = useRef(null)
      useEffect(() => {
        input.current?.focus()
        input.current?.select()
      }, [])
      return h('div', {
        className: 'dide-dialog-mask',
        onMouseDown: event => { if (event.target === event.currentTarget) onCancel() },
      },
        h('div', { className: 'dide-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': title },
          h('div', { className: 'dide-dialog-title' }, title),
          h('div', { className: 'dide-field' },
            h('input', {
              ref: input,
              value,
              placeholder: t('file.pathHint'),
              'aria-label': t('file.pathHint'),
              onChange: event => { onChange(event.target.value) },
              onKeyDown: (event) => {
                if (event.key === 'Enter') { event.preventDefault(); onSubmit() }
                if (event.key === 'Escape') { event.preventDefault(); onCancel() }
              },
            }),
          ),
          h('div', { className: 'dide-dialog-row' },
            h('button', { type: 'button', className: 'dide-button', onClick: onCancel }, t('file.cancel')),
            h('button', {
              type: 'button', className: 'dide-button', 'data-primary': '',
              disabled: String(value).trim() === '',
              onClick: onSubmit,
            }, t('file.create')),
          ),
        ),
      )
    }

    /**
     * One decision dialog: a title, a sentence, and the buttons that settle it.
     *
     * The caller owns every action, so this component knows nothing about
     * buffers, sessions, or Git — it only lays out the question and gives the
     * primary choice focus, which is what Enter should hit.
     * @param {object} props - `title`, `body`, `actions`, and `onCancel`.
     */
    function ConfirmDialog({ title, body, actions, onCancel }) {
      const primary = useRef(null)
      useEffect(() => {
        primary.current?.focus()
      }, [])
      return h('div', {
        className: 'dide-dialog-mask',
        onMouseDown: event => { if (event.target === event.currentTarget) onCancel() },
        onKeyDown: (event) => {
          if (event.key === 'Escape') { event.preventDefault(); onCancel() }
        },
      },
        h('div', { className: 'dide-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': title },
          h('div', { className: 'dide-dialog-title' }, title),
          h('div', { className: 'dide-dialog-body' }, body),
          h('div', { className: 'dide-dialog-row' },
            actions.map(action => h('button', {
              key: action.id,
              ref: action.primary === true ? primary : undefined,
              type: 'button',
              className: 'dide-button',
              'data-primary': action.primary === true ? '' : undefined,
              'data-danger': action.danger === true ? '' : undefined,
              onClick: action.onSelect,
            }, action.label)),
          ),
        ),
      )
    }

    /**
     * A menu anchored under its trigger's wrapper.
     * @param {object} props - `items`, `onDismiss`, and the closing hook.
     */
    function Menu({ items, onDismiss }) {
      const host = useRef(null)
      useEffect(() => {
        const onDown = (event) => {
          const anchor = host.current?.parentElement
          if (anchor !== undefined && anchor !== null && anchor.contains(event.target)) return
          onDismiss()
        }
        const onKey = (event) => { if (event.key === 'Escape') onDismiss() }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [onDismiss])
      return h('div', { className: 'dide-menu', role: 'menu', ref: host },
        items.map(item => (item.separator === true
          ? h('div', { key: item.id, className: 'dide-menu-sep' })
          : h('button', {
            key: item.id,
            type: 'button',
            className: 'dide-menu-item',
            role: 'menuitem',
            disabled: item.disabled === true,
            onClick: () => { onDismiss(); item.run() },
          },
            item.icon === undefined ? null : h('span', { style: { display: 'inline-flex', flex: 'none' } }, item.icon()),
            h('span', null, item.label),
            item.shortcut === undefined ? null : h('span', { className: 'dide-menu-shortcut' }, item.shortcut),
          ))),
      )
    }

    // ── Explorer ───────────────────────────────────────────────────────────

    /**
     * One directory row plus its expanded children.
     * @param {object} props - root, entry, depth, and the shared listing state.
     */
    function ExplorerRow({ t, root, entry, depth, listings, expanded, toggleExpanded, openFile, currentPath, showHidden }) {
      const absolutePath = joinPath(root, entry.path)
      const isDirectory = entry.type === 'directory'
      const isOpen = expanded.has(absolutePath)
      const listing = listings.get(absolutePath)
      if (entry.hidden && !showHidden) return null
      const indent = { paddingLeft: `${String(3 + depth * 10)}px` }
      return h('div', { role: 'none' },
        h('button', {
          type: 'button',
          className: 'dide-tree-row',
          role: 'treeitem',
          'aria-expanded': isDirectory ? isOpen : undefined,
          'data-current': !isDirectory && currentPath === absolutePath ? '' : undefined,
          'data-hidden': entry.hidden ? '' : undefined,
          style: indent,
          title: entry.path,
          onClick: () => { if (isDirectory) toggleExpanded(absolutePath); else openFile(absolutePath) },
        },
          h('span', { className: 'dide-tree-twist', 'data-open': isDirectory && isOpen ? '' : undefined },
            isDirectory ? ICON.chevron(9) : null),
          h('span', { style: { display: 'inline-flex', flex: 'none', opacity: isDirectory ? 1 : 0.75 } },
            isDirectory ? ICON.explorer(13) : ICON.file(13)),
          h('span', { className: 'dide-tree-name' }, entry.name),
        ),
        isDirectory && isOpen
          ? h('div', { role: 'group' },
            listing === undefined || listing.phase === 'loading'
              ? h('div', { className: 'dide-tree-note' }, t('common.loading'))
              : listing.phase === 'failed'
                ? h('div', { className: 'dide-tree-note' }, listing.error)
                : (listing.entries.length === 0
                  ? h('div', { className: 'dide-tree-note' }, t('common.none'))
                  : listing.entries.map(child => h(ExplorerRow, {
                    key: child.name,
                    t, root, depth: depth + 1, listings, expanded, toggleExpanded, openFile, currentPath, showHidden,
                    entry: {
                      name: child.name,
                      type: child.type,
                      hidden: child.hidden,
                      path: entry.path === '' ? child.name : `${entry.path}/${child.name}`,
                    },
                  }))))
          : null,
      )
    }

    /** Explorer: refresh, hidden toggle, create, and the recursive tree. */
    function ExplorerPane({ t, root, openFile, currentPath }) {
      const [listings, setListings] = useState(() => new Map())
      const [expanded, setExpanded] = useState(() => new Set())
      const [showHidden, setShowHidden] = useState(false)
      const [prompt, setPrompt] = useState(undefined)
      const loadedRoot = useRef(undefined)

      const load = useCallback(async (absolutePath) => {
        setListings((previous) => {
          const next = new Map(previous)
          next.set(absolutePath, { phase: 'loading', entries: previous.get(absolutePath)?.entries ?? [] })
          return next
        })
        try {
          const reply = await post(ROUTE.list, { root, path: absolutePath })
          setListings((previous) => {
            const next = new Map(previous)
            next.set(absolutePath, { phase: 'ready', entries: reply.entries, truncated: reply.truncated })
            return next
          })
        } catch (error) {
          setListings((previous) => {
            const next = new Map(previous)
            next.set(absolutePath, { phase: 'failed', entries: [], error: String(error.message ?? error) })
            return next
          })
        }
      }, [root])

      const toggleExpanded = useCallback((absolutePath) => {
        setExpanded((previous) => {
          const next = new Set(previous)
          if (next.has(absolutePath)) next.delete(absolutePath)
          else next.add(absolutePath)
          return next
        })
        if (!listings.has(absolutePath)) void load(absolutePath)
      }, [listings, load])

      /** Reload the root and every expanded level, keeping the tree's shape. */
      const refresh = useCallback(() => {
        const targets = [root, ...expanded]
        setListings(() => new Map())
        for (const target of targets) void load(target)
      }, [root, expanded, load])

      useEffect(() => {
        if (loadedRoot.current === root) return
        loadedRoot.current = root
        setListings(() => new Map())
        setExpanded(() => new Set())
        if (root !== undefined) void load(root)
      }, [root, load])

      const create = useCallback(async (kind, relative) => {
        const target = String(relative).trim()
        if (target === '') return
        try {
          if (kind === 'folder') {
            await post(ROUTE.mkdir, { root, path: target })
            setPrompt(undefined)
            refresh()
          } else {
            await post(ROUTE.write, { root, path: target, content: '' })
            setPrompt(undefined)
            refresh()
            openFile(joinPath(root, target.replace(/\\/g, '/')))
          }
        } catch (error) {
          notify(format(t('file.saveFailed'), { name: target, reason: String(error.message ?? error) }), false)
        }
      }, [root, refresh, openFile, t])

      if (root === undefined) return h('div', { className: 'dide-empty' }, t('terminal.needSession'))

      const rootListing = listings.get(root)
      return h('div', { className: 'dide-pane' },
        h('div', { className: 'dide-pane-head' },
          h('span', { className: 'dide-pane-head-title' }, t('rail.explorer')),
          h('span', { className: 'dide-pane-spacer' }),
          h('button', {
            type: 'button', className: 'dide-icon-button', title: t('file.new'), 'aria-label': t('file.new'),
            onClick: () => { setPrompt({ kind: 'file', value: '' }) },
          }, ICON.plus()),
          h('button', {
            type: 'button', className: 'dide-icon-button', title: t('file.newFolder'), 'aria-label': t('file.newFolder'),
            onClick: () => { setPrompt({ kind: 'folder', value: '' }) },
          }, ICON.newFolder()),
          h('button', {
            type: 'button', className: 'dide-icon-button', 'data-on': showHidden ? '' : undefined,
            title: t('file.showHidden'), 'aria-label': t('file.showHidden'), 'aria-pressed': showHidden,
            onClick: () => { setShowHidden(value => !value) },
          }, ICON.eye()),
          h('button', {
            type: 'button', className: 'dide-icon-button', title: t('file.refresh'), 'aria-label': t('file.refresh'),
            onClick: refresh,
          }, ICON.refresh()),
        ),
        h('div', { className: 'dide-pane-body', role: 'tree', 'aria-label': t('rail.explorer') },
          rootListing === undefined || rootListing.phase === 'loading'
            ? h('div', { className: 'dide-empty' }, t('common.loading'))
            : rootListing.phase === 'failed'
              ? h('div', { className: 'dide-empty' }, rootListing.error)
              : rootListing.entries.length === 0
                ? h('div', { className: 'dide-empty' }, t('common.none'))
                : rootListing.entries.map(entry => h(ExplorerRow, {
                  key: entry.name,
                  t, root, depth: 0, listings, expanded, toggleExpanded, openFile, currentPath, showHidden,
                  entry: { name: entry.name, type: entry.type, hidden: entry.hidden, path: entry.name },
                })),
        ),
        prompt !== undefined && h(PromptDialog, {
          t,
          title: prompt.kind === 'folder' ? t('file.newFolder') : t('file.new'),
          value: prompt.value,
          onChange: value => { setPrompt({ kind: prompt.kind, value }) },
          onCancel: () => { setPrompt(undefined) },
          onSubmit: () => { void create(prompt.kind, prompt.value) },
        }),
      )
    }

    // ── Search ─────────────────────────────────────────────────────────────

    /**
     * Workspace search: file names, or the text inside files.
     *
     * One route serves both shapes; the mode rides on the body so the Host can
     * pick its walk. Results keep the mode that produced them, because a
     * content hit carries a line and a name hit is a bare path — rendering one
     * as the other would throw away the line number.
     */
    function SearchPane({ t, root, openFile }) {
      const [query, setQuery] = useState('')
      const [mode, setMode] = useState('name')
      const [result, setResult] = useState({ phase: 'idle', matches: [] })

      useEffect(() => {
        const trimmed = query.trim()
        if (trimmed === '' || root === undefined) { setResult({ phase: 'idle', matches: [] }); return }
        setResult({ phase: 'searching', matches: [] })
        let live = true
        const timer = window.setTimeout(() => {
          post(ROUTE.search, { root, query: trimmed, mode }).then((reply) => {
            if (!live) return
            setResult({ phase: 'ready', matches: reply.matches, truncated: reply.truncated })
          }).catch((error) => {
            if (!live) return
            setResult({ phase: 'failed', matches: [], error: String(error.message ?? error) })
          })
        }, 220)
        return () => { live = false; window.clearTimeout(timer) }
      }, [query, root, mode])

      if (root === undefined) return h('div', { className: 'dide-empty' }, t('terminal.needSession'))

      const pathOf = match => (mode === 'name' ? match : match.path)
      const placeholder = mode === 'name' ? t('search.placeholder') : t('search.placeholderContent')

      return h('div', { className: 'dide-pane' },
        h('div', { className: 'dide-pane-head' },
          h('span', { className: 'dide-pane-head-title' }, t('rail.search')),
        ),
        h('div', { className: 'dide-field' },
          ICON.search(13),
          h('input', {
            value: query,
            placeholder,
            'aria-label': placeholder,
            onChange: event => { setQuery(event.target.value) },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && result.matches.length > 0) openFile(pathOf(result.matches[0]))
            },
          }),
        ),
        h('div', { className: 'dide-tabs' },
          h('button', {
            type: 'button', className: 'dide-tab',
            'data-active': mode === 'name' ? '' : undefined,
            'aria-pressed': mode === 'name' ? 'true' : 'false',
            onClick: () => { setMode('name') },
          }, t('search.modeName')),
          h('button', {
            type: 'button', className: 'dide-tab',
            'data-active': mode === 'content' ? '' : undefined,
            'aria-pressed': mode === 'content' ? 'true' : 'false',
            onClick: () => { setMode('content') },
          }, t('search.modeContent')),
        ),
        h('div', { className: 'dide-pane-body' },
          result.phase === 'idle'
            ? h('div', { className: 'dide-empty' }, mode === 'name' ? t('search.hint') : t('search.hintContent'))
            : result.phase === 'searching'
              ? h('div', { className: 'dide-empty' }, t('search.searching'))
              : result.phase === 'failed'
                ? h('div', { className: 'dide-empty' }, result.error)
                : result.matches.length === 0
                  ? h('div', { className: 'dide-empty' }, t('search.noResults'))
                  : mode === 'name'
                    ? result.matches.map(match => h('button', {
                      key: match,
                      type: 'button',
                      className: 'dide-result',
                      title: relativeTo(match, root),
                      onClick: () => { openFile(match) },
                    },
                      h('span', { className: 'dide-result-name' }, baseOf(match)),
                      h('span', { className: 'dide-result-path' }, parentOf(relativeTo(match, root))),
                    ))
                    // A content row is a location plus the line that matched, so
                    // the answer is readable without opening the file.
                    : result.matches.map(match => h('button', {
                      key: `${match.path}:${String(match.line)}`,
                      type: 'button',
                      className: 'dide-result',
                      'data-content': '',
                      title: `${relativeTo(match.path, root)}:${String(match.line)}`,
                      onClick: () => { openFile(match.path) },
                    },
                      h('span', { className: 'dide-result-name' },
                        baseOf(match.path),
                        h('span', { className: 'dide-result-line' }, `:${String(match.line)}`),
                        h('span', { className: 'dide-result-dir' }, parentOf(relativeTo(match.path, root)))),
                      h('span', { className: 'dide-result-text' }, match.text),
                    )),
          result.truncated === true && h('div', { className: 'dide-empty' }, t('search.more')),
        ),
      )
    }

    // ── Source control ─────────────────────────────────────────────────────

    /** Git: branch facts, staged/unstaged groups, and a commit box. */
    function GitPane({ t, root, openFile }) {
      const [status, setStatus] = useState({ phase: 'loading' })
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)
      /** Branch inventory + the switch control's open state. */
      const [branches, setBranches] = useState(undefined)
      const [branchMenu, setBranchMenu] = useState(false)
      /** The diff preview: `{ path, staged, phase, text, kind }`. */
      const [preview, setPreview] = useState(undefined)
      /** The last handful of commits, loaded on demand. */
      const [log, setLog] = useState(undefined)
      /** The remote the workspace pushes to, or null when none is configured. */
      const [remote, setRemote] = useState(undefined)
      /** Which remote button is running, so only that one reads as busy. */
      const [syncing, setSyncing] = useState(undefined)

      const load = useCallback(async () => {
        if (root === undefined) return
        setStatus(current => ({ ...current, phase: current.entries === undefined ? 'loading' : 'refreshing' }))
        try {
          const reply = await post(ROUTE.status, { root })
          setStatus({
            phase: 'ready',
            isRepo: reply.isRepo,
            branch: reply.branch,
            upstream: reply.upstream,
            ahead: reply.ahead,
            behind: reply.behind,
            detached: reply.detached,
            entries: reply.entries ?? [],
            truncated: reply.truncated,
          })
        } catch (error) {
          setStatus({ phase: 'failed', entries: [], error: String(error.message ?? error) })
        }
      }, [root])

      useEffect(() => { void load() }, [load])

      // The remote is a property of the repository, not of the change list, so it
      // loads once per workspace and again after a sync.
      const loadRemote = useCallback(async () => {
        if (root === undefined) {
          setRemote(null)
          return
        }
        try {
          const reply = await post(ROUTE.remote, { root })
          setRemote(reply.remote ?? null)
        } catch {
          // No remote is the ordinary state of a local-only repository.
          setRemote(null)
        }
      }, [root])

      useEffect(() => { void loadRemote() }, [loadRemote])

      // A folder that is not a repository yet is the ordinary first state, so the
      // empty state creates one instead of leaving the pane unusable.
      const initRepo = useCallback(async () => {
        setBusy(true)
        try {
          await post(ROUTE.init, { root })
          notify(t('git.inited'), true)
          await load()
        } catch (error) {
          notify(format(t('git.initFailed'), { reason: String(error.message ?? error) }), false)
        } finally {
          setBusy(false)
        }
      }, [root, load, t])

      const setIndex = useCallback(async (action, paths) => {
        if (paths.length === 0) return
        setBusy(true)
        try {
          await post(ROUTE.index, { root, action, paths })
          await load()
          if (preview !== undefined) setPreview(undefined)
        } catch (error) {
          const reason = String(error.message ?? error)
          notify(format(t(action === 'stage' ? 'git.stageFailed' : 'git.unstageFailed'), { reason }), false)
        } finally {
          setBusy(false)
        }
      }, [root, load, t, preview])

      const discard = useCallback(async (paths) => {
        if (paths.length === 0) return
        setBusy(true)
        try {
          await post(ROUTE.discard, { root, action: 'discard', paths })
          notify(t('git.discarded'), true)
          setPreview(undefined)
          await load()
        } catch (error) {
          notify(format(t('git.discardFailed'), { reason: String(error.message ?? error) }), false)
        } finally {
          setBusy(false)
        }
      }, [root, load, t])

      const showDiff = useCallback(async (path, staged) => {
        setPreview({ path, staged, phase: 'loading' })
        try {
          const reply = await post(ROUTE.diff, { root, path, staged })
          setPreview({ path, staged, phase: 'ready', text: reply.text, kind: reply.kind })
        } catch (error) {
          setPreview({ path, staged, phase: 'failed', error: String(error.message ?? error) })
        }
      }, [root])

      const loadBranches = useCallback(async () => {
        try {
          const reply = await post(ROUTE.branch, { root, action: 'list' })
          setBranches(reply.branches ?? [])
        } catch (error) {
          notify(format(t('git.branchFailed'), { reason: String(error.message ?? error) }), false)
          setBranches([])
        }
      }, [root, t])

      const switchBranch = useCallback(async (name) => {
        setBranchMenu(false)
        setBusy(true)
        try {
          await post(ROUTE.branch, { root, action: 'switch', name })
          notify(format(t('git.switched'), { name }), true)
          setBranches(undefined)
          await load()
        } catch (error) {
          notify(format(t('git.switchFailed'), { reason: String(error.message ?? error) }), false)
        } finally {
          setBusy(false)
        }
      }, [root, load, t])

      const loadLog = useCallback(async () => {
        setLog(previous => previous === undefined ? [] : previous)
        try {
          const reply = await post(ROUTE.log, { root, limit: 20 })
          setLog(reply.commits ?? [])
        } catch (error) {
          notify(format(t('git.logFailed'), { reason: String(error.message ?? error) }), false)
          setLog([])
        }
      }, [root, t])

      // Sync is the only pair of buttons that talks to another machine, so each
      // one reports its own outcome instead of a shared "something failed".
      const sync = useCallback(async (action) => {
        setBusy(true)
        setSyncing(action)
        try {
          await post(ROUTE.sync, { root, action })
          notify(t(action === 'fetch' ? 'git.fetched' : action === 'pull' ? 'git.pulled' : 'git.pushed'), true)
          await Promise.all([load(), loadRemote()])
        } catch (error) {
          const known = error.reason === 'no-remote' ? t('git.noRemote')
            : error.reason === 'detached' ? t('git.detached')
              : error.reason === 'rejected' ? t('git.rejected')
                : undefined
          notify(format(t('git.syncFailed'), { reason: known ?? String(error.message ?? error) }), false)
        } finally {
          setBusy(false)
          setSyncing(undefined)
        }
      }, [root, load, loadRemote, t])

      const commit = useCallback(async () => {
        const trimmed = message.trim()
        if (trimmed === '') return
        setBusy(true)
        try {
          await post(ROUTE.commit, { root, message: trimmed })
          setMessage('')
          notify(t('git.committed'), true)
          setLog(undefined)
          await load()
        } catch (error) {
          const reason = error.reason === 'nothing-to-commit' ? t('git.nothing') : String(error.message ?? error)
          notify(format(t('git.commitFailed'), { reason }), false)
        } finally {
          setBusy(false)
        }
      }, [root, message, load, t])

      if (root === undefined) return h('div', { className: 'dide-empty' }, t('terminal.needSession'))
      if (status.phase === 'loading') {
        return h('div', { className: 'dide-pane' },
          h('div', { className: 'dide-pane-head' }, h('span', { className: 'dide-pane-head-title' }, t('rail.git'))),
          h('div', { className: 'dide-empty' }, t('common.loading')))
      }
      if (status.phase === 'failed') {
        return h('div', { className: 'dide-pane' },
          h('div', { className: 'dide-pane-head' }, h('span', { className: 'dide-pane-head-title' }, t('rail.git'))),
          h('div', { className: 'dide-empty' }, format(t('git.failed'), { reason: status.error })),
          h('div', { className: 'dide-empty' },
            h('button', { type: 'button', className: 'dide-button', onClick: () => { void load() } }, t('common.retry'))))
      }
      if (status.isRepo === false) {
        return h('div', { className: 'dide-pane' },
          h('div', { className: 'dide-pane-head' }, h('span', { className: 'dide-pane-head-title' }, t('rail.git'))),
          h('div', { className: 'dide-empty' }, t('git.noRepo')),
          h('div', { className: 'dide-empty' }, t('git.noRepoHint')),
          h('div', { className: 'dide-empty' },
            h('button', {
              type: 'button', className: 'dide-button', disabled: busy, onClick: () => { void initRepo() },
            }, t('git.init'))))
      }

      const rows = (status.entries ?? []).map(entry => ({ ...entry, ...splitStatus(entry.xy), ...splitPath(entry.path) }))
      const staged = rows.filter(row => !row.untracked && row.staged !== '')
      const working = rows.filter(row => row.untracked || row.worktree !== '')
      const track = [
        status.ahead === undefined ? undefined : format(t('git.ahead'), { count: status.ahead }),
        status.behind === undefined ? undefined : format(t('git.behind'), { count: status.behind }),
      ].filter(Boolean).join(' · ')

      // One remote line: where this workspace pushes, and the three commands that
      // talk to it. Everything linkable is built from the remote URL git stores.
      const remoteReady = remote !== undefined && remote !== null
      const isGithub = remoteReady && remote.provider === 'github'
      const syncButton = (action, icon, label) => h('button', {
        key: action,
        type: 'button',
        className: 'dide-icon-button',
        title: label,
        'aria-label': label,
        disabled: busy || !remoteReady,
        'data-on': syncing === action ? '' : undefined,
        'data-syncing': syncing === action ? '' : undefined,
        onClick: () => { void sync(action) },
      }, icon)
      const remoteBar = remoteReady
        ? h('div', { className: 'dide-git-remote', 'data-provider': remote.provider },
          h('button', {
            type: 'button', className: 'dide-git-remote-open',
            title: t('git.openRemote'), 'aria-label': `${t('git.openRemote')} ${remote.web}`,
            onClick: () => { openExternal(remote.web) },
          },
            h('span', { className: 'dide-git-remote-badge' }, isGithub ? 'GitHub' : remote.host),
            h('span', { className: 'dide-git-remote-path' }, `${remote.owner}/${remote.repo}`),
            ICON.external()),
          h('span', { className: 'dide-pane-spacer' }),
          syncButton('fetch', ICON.cloud(), t('git.fetch')),
          syncButton('pull', ICON.down(), t('git.pull')),
          syncButton('push', ICON.up(), t('git.push')),
        )
        : null

      const group = (title, items, action) => h('div', { className: 'dide-git-group', key: title },
        h('div', { className: 'dide-git-group-title' },
          h('span', { className: 'dide-git-group-label' }, title,
            h('span', { className: 'dide-git-count' }, String(items.length))),
          h('button', {
            type: 'button', className: 'dide-icon-button', disabled: busy,
            title: t(action === 'stage' ? 'git.stageAll' : 'git.unstageAll'),
            'aria-label': t(action === 'stage' ? 'git.stageAll' : 'git.unstageAll'),
            onClick: () => { void setIndex(action, items.map(item => item.path)) },
          }, action === 'stage' ? ICON.plus() : ICON.minus()),
        ),
        items.map(item => h('div', {
          key: `${action}:${item.path}`,
          className: 'dide-git-row',
          role: 'button',
          tabIndex: 0,
          title: item.path,
          'data-preview': preview !== undefined && preview.path === item.path && preview.staged === (action === 'unstage') ? '' : undefined,
          onClick: () => {
            openFile(joinPath(root, item.path))
            void showDiff(item.path, action === 'unstage')
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openFile(joinPath(root, item.path))
              void showDiff(item.path, action === 'unstage')
            }
          },
        },
          h('span', {
            className: 'dide-git-code',
            'data-code': item.untracked ? 'U' : (action === 'stage' ? item.staged : item.worktree),
          }, item.untracked ? 'U' : (action === 'stage' ? item.staged : item.worktree)),
          h('span', { className: 'dide-git-path' },
            item.prefix === '' ? null : h('span', { className: 'dide-git-dir' }, item.prefix),
            item.name),
          h('span', { className: 'dide-git-actions' },
            h('button', {
              type: 'button', className: 'dide-icon-button', disabled: busy,
              title: t(action === 'stage' ? 'git.stage' : 'git.unstage'),
              'aria-label': `${t(action === 'stage' ? 'git.stage' : 'git.unstage')} ${item.path}`,
              onClick: (event) => {
                event.stopPropagation()
                void setIndex(action, [item.path])
              },
            }, action === 'stage' ? ICON.plus() : ICON.minus()),
            action === 'stage' && h('button', {
              type: 'button', className: 'dide-icon-button', disabled: busy,
              title: t('git.discard'), 'aria-label': `${t('git.discard')} ${item.path}`,
              onClick: (event) => {
                event.stopPropagation()
                void discard([item.path])
              },
            }, ICON.trash()),
          ),
        )),
      )

      return h('div', { className: 'dide-pane' },
        h('div', { className: 'dide-git-head' },
          h('div', { className: 'dide-git-branch-host' },
            h('button', {
              type: 'button', className: 'dide-git-branch', disabled: busy || status.detached === true,
              title: t('git.switchBranch'),
              'aria-haspopup': 'listbox',
              'aria-expanded': branchMenu,
              onClick: () => {
                setBranchMenu(value => !value)
                if (branches === undefined) void loadBranches()
              },
            },
              ICON.git(13),
              h('span', null, status.detached === true ? t('git.detached') : (status.branch ?? t('common.none'))),
            ),
            branchMenu && h('div', { className: 'dide-git-menu', role: 'listbox' },
              branches === undefined
                ? h('div', { className: 'dide-git-menu-row' }, t('common.loading'))
                : branches.map(branch => h('button', {
                  key: branch.name,
                  type: 'button', role: 'option',
                  className: 'dide-git-menu-row',
                  'aria-selected': branch.current,
                  'data-current': branch.current ? '' : undefined,
                  disabled: branch.current,
                  onClick: () => { void switchBranch(branch.name) },
                }, branch.name)),
            ),
          ),
          track !== '' && h('span', { className: 'dide-git-track' }, track),
          h('span', { className: 'dide-pane-spacer' }),
          h('button', {
            type: 'button', className: 'dide-icon-button',
            title: t('git.history'), 'aria-label': t('git.history'),
            'data-on': log !== undefined ? '' : undefined,
            disabled: busy,
            onClick: () => { if (log === undefined) void loadLog(); else setLog(undefined) },
          }, ICON.history()),
          h('button', {
            type: 'button', className: 'dide-icon-button', title: t('git.refresh'), 'aria-label': t('git.refresh'),
            disabled: busy || status.phase === 'refreshing',
            // A remote can appear outside the panel (`git remote add`), so a
            // refresh re-reads it alongside the change list.
            onClick: () => { void Promise.all([load(), loadRemote()]) },
          }, ICON.refresh()),
        ),
        remoteBar,
        preview !== undefined && h('div', { className: 'dide-git-preview' },
          h('div', { className: 'dide-git-preview-head' },
            h('span', { className: 'dide-git-preview-title' }, `${preview.staged ? t('git.staged') : t('git.changes')} · ${preview.path}`),
            h('span', { className: 'dide-pane-spacer' }),
            h('button', {
              type: 'button', className: 'dide-icon-button', title: t('common.cancel'), 'aria-label': t('common.cancel'),
              onClick: () => { setPreview(undefined) },
            }, ICON.close()),
          ),
          h('pre', { className: 'dide-git-diff' },
            preview.phase === 'loading'
              ? t('common.loading')
              : preview.phase === 'failed'
                ? preview.error
                : (preview.text === '' ? t('git.noDiff') : preview.text)),
        ),
        log !== undefined && h('div', { className: 'dide-git-log' },
          h('div', { className: 'dide-git-group-title' }, h('span', null, t('git.history'))),
          log.length === 0
            ? h('div', { className: 'dide-empty' }, t('common.none'))
            : log.map(entry => {
              // A commit has a page on the provider when the remote is GitHub.
              const link = isGithub ? `${remote.web}/commit/${entry.hash}` : undefined
              return h('div', {
                key: entry.hash,
                className: 'dide-git-log-row',
                title: link === undefined ? `${entry.hash} · ${entry.author}` : `${entry.hash} · ${entry.author} — ${t('git.openCommit')}`,
                ...(link === undefined ? {} : {
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => { openExternal(link) },
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    openExternal(link)
                  },
                }),
              },
                h('span', { className: 'dide-git-log-hash' }, entry.hash),
                h('span', { className: 'dide-git-log-subject' }, entry.subject),
                h('span', { className: 'dide-git-log-when' }, entry.when),
                link === undefined ? null : h('span', { className: 'dide-git-log-link' }, ICON.external()))
            }),
        ),
        h('div', { className: 'dide-pane-body' },
          rows.length === 0
            ? h('div', { className: 'dide-empty' }, t('git.clean'))
            : [
              staged.length > 0 ? group(t('git.staged'), staged, 'unstage') : null,
              working.length > 0 ? group(t('git.changes'), working, 'stage') : null,
            ],
          status.truncated === true && h('div', { className: 'dide-empty' }, t('search.more')),
        ),
        h('div', { className: 'dide-commit' },
          h('textarea', {
            value: message,
            placeholder: t('git.commitPlaceholder'),
            'aria-label': t('git.commitPlaceholder'),
            onChange: event => { setMessage(event.target.value) },
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void commit()
              }
            },
          }),
          h('div', { className: 'dide-dialog-row' },
            h('button', {
              type: 'button', className: 'dide-button', 'data-primary': '',
              disabled: busy || message.trim() === '' || staged.length === 0,
              onClick: () => { void commit() },
            }, busy ? t('git.committing') : t('git.commit')),
          ),
        ),
      )
    }

    // ── Editor ─────────────────────────────────────────────────────────────

    /**
     * The editor surface. It owns the live text (a keystroke must not re-render
     * the Explorer and the Git list), publishes the dirty flag only when it
     * flips, and hands its `save`/`revert` to `editorApi` so the File menu can
     * act on the same buffer.
     */
    function EditorPane({ t, file, root }) {
      const [text, setText] = useState(file?.text ?? '')
      const loaded = useRef(undefined)

      // A new target starts a new buffer; reloading the same target adopts the
      // Host's text, which is what a refreshed reader expects to see.
      useEffect(() => {
        const key = `${file?.path ?? ''}\u0000${file?.phase ?? ''}`
        if (loaded.current === key) return
        loaded.current = key
        setText(file?.text ?? '')
      }, [file?.path, file?.phase, file?.text])

      const dirty = file?.phase === 'ready' && text !== file.saved

      // Publish the flag, not the text: this re-renders the top bar once per
      // edit session instead of once per keystroke.
      useEffect(() => {
        if (state.dirty !== dirty) store.set({ dirty })
      }, [dirty])

      const save = useCallback(() => {
        const current = state.file
        if (current === undefined || current.phase !== 'ready' || root === undefined) return Promise.resolve(false)
        // Resolves `true` only on a write that reached disk: the unsaved-open
        // dialog stays put over a failed save instead of dropping the buffer.
        return post(ROUTE.write, { root, path: current.path, content: text }).then(() => {
          store.set({ file: { ...current, text, saved: text } })
          loaded.current = `${current.path}\u0000ready`
          notify(format(t('file.saved'), { name: baseOf(current.path) }), true)
          return true
        }).catch((error) => {
          notify(format(t('file.saveFailed'), { name: baseOf(current.path), reason: String(error.message ?? error) }), false)
          return false
        })
      }, [root, text, t])

      const revert = useCallback(() => {
        const current = state.file
        if (current === undefined || current.phase !== 'ready') return
        setText(current.saved)
      }, [])

      // The File menu reaches this buffer through the handle, never through the
      // store: the store holds the loaded text, not the text being typed.
      useEffect(() => {
        editorApi.save = save
        editorApi.revert = revert
        editorApi.text = () => text
        return () => {
          editorApi.save = undefined
          editorApi.revert = undefined
          editorApi.text = () => ''
        }
      }, [save, revert, text])

      const lines = useMemo(() => (text === '' ? 1 : text.split('\n').length), [text])
      const gutter = useMemo(
        () => Array.from({ length: lines }, (_, index) => String(index + 1)).join('\n'),
        [lines],
      )

      if (file === undefined) {
        return h('div', { className: 'dide-editor' },
          h('div', { className: 'dide-editor-empty' },
            h('span', { className: 'dide-editor-empty-mark' }, ICON.file(20)),
            h('div', { className: 'dide-editor-empty-title' }, t('file.empty')),
            h('div', { className: 'dide-editor-empty-hint' }, t('file.emptyHint'))))
      }
      if (file.phase === 'loading') {
        return h('div', { className: 'dide-editor' },
          h('div', { className: 'dide-empty', style: { margin: 'auto' } }, t('common.loading')))
      }
      if (file.phase === 'failed') {
        return h('div', { className: 'dide-editor' },
          h('div', { className: 'dide-editor-bar' },
            ICON.file(13),
            h('span', { className: 'dide-editor-name' }, baseOf(file.path))),
          h('div', { className: 'dide-empty', style: { margin: 'auto', textAlign: 'center', maxWidth: '420px' } }, file.error))
      }

      const relative = relativeTo(file.path, root)
      return h('div', { className: 'dide-editor' },
        h('div', { className: 'dide-editor-bar' },
          ICON.file(13),
          h('span', { className: 'dide-editor-name' }, baseOf(file.path)),
          h('span', { className: 'dide-editor-dir', title: relative }, parentOf(relative)),
          h('span', { className: 'dide-pane-spacer' }),
          h('button', {
            type: 'button', className: 'dide-icon-button', title: t('file.save'), 'aria-label': t('file.save'),
            disabled: !dirty, onClick: save,
          }, ICON.save()),
        ),
        h('div', { className: 'dide-editor-area' },
          h('pre', { className: 'dide-gutter', 'aria-hidden': true }, gutter),
          h('textarea', {
            className: 'dide-textarea',
            value: text,
            spellCheck: false,
            wrap: 'off',
            'aria-label': relative,
            onChange: event => { setText(event.target.value) },
            onKeyDown: (event) => {
              if (event.key === 'Tab') {
                event.preventDefault()
                const target = event.currentTarget
                const start = target.selectionStart
                const end = target.selectionEnd
                const next = `${text.slice(0, start)}  ${text.slice(end)}`
                setText(next)
                // The caret must land after the inserted indent, which is only
                // addressable once React has committed the new value.
                window.requestAnimationFrame(() => {
                  target.selectionStart = start + 2
                  target.selectionEnd = start + 2
                })
                return
              }
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault()
                save()
              }
            },
          }),
        ),
      )
    }

    // ── Terminal ───────────────────────────────────────────────────────────

    /**
     * Terminal drawer. Each command is one `POST /ide-mode/exec` round trip in
     * the workspace directory and arrives with its exit code, so there is no
     * PTY to leak and nothing to clean up on unmount. The shipped right
     * Sidebar's terminal remains the place for a fully interactive shell.
     */
    function TerminalPane({ t, root, expanded, onToggle }) {
      const [history, setHistory] = useState([])
      const [command, setCommand] = useState('')
      const [busy, setBusy] = useState(false)
      /** Index into the sent commands while walking history; undefined = live line. */
      const [cursor, setCursor] = useState(undefined)
      const body = useRef(null)
      const input = useRef(null)

      // Follow the newest output unless the reader is looking further up.
      useEffect(() => {
        const element = body.current
        if (element === null) return
        element.scrollTop = element.scrollHeight
      }, [history, busy, expanded])

      /**
       * Put the caret in the prompt row. A terminal has no "click the thin strip
       * to start typing" contract: the output area is mostly empty space, so a
       * bare input that only focuses when hit exactly loses every click that
       * lands anywhere else in the drawer. Every click inside the drawer routes
       * here instead.
       */
      const focusInput = useCallback(() => {
        const element = input.current
        if (element === null) return
        element.focus()
        const end = element.value.length
        element.setSelectionRange(end, end)
      }, [])

      // Opening the drawer is the reader's intent to type, in both the `open`
      // and `expanded` shapes, and on first mount for a session.
      useEffect(() => {
        if (root === undefined) return
        window.requestAnimationFrame(focusInput)
      }, [expanded, root, focusInput])

      const run = useCallback(async () => {
        const line = command.trim()
        if (line === '' || busy || root === undefined) return
        setCommand('')
        setCursor(undefined)
        setBusy(true)
        const id = `${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
        setHistory(previous => [...previous, { id, kind: 'command', text: line }])
        try {
          const reply = await post(ROUTE.exec, { root, command: line })
          setHistory(previous => [...previous, { id: `${id}:o`, kind: 'output', reply }])
        } catch (error) {
          setHistory(previous => [...previous, {
            id: `${id}:e`, kind: 'output',
            reply: { code: null, stdout: '', stderr: format(t('terminal.failed'), { reason: String(error.message ?? error) }) },
          }])
        } finally {
          setBusy(false)
          window.requestAnimationFrame(() => { input.current?.focus() })
        }
      }, [command, busy, root, t])

      if (root === undefined) return h('div', { className: 'dide-empty' }, t('terminal.needSession'))

      return h('section', {
        className: 'dide-term',
        'data-expanded': expanded ? '' : undefined,
        'aria-label': t('terminal.title'),
        // Clicking the output area, the labels, or the prompt row all mean "let
        // me type". Real buttons and the input itself keep their own behaviour,
        // and a drag-select in the output is never stolen.
        onClick: (event) => {
          const target = event.target
          if (!(target instanceof Element)) return
          if (target.closest('button, input, textarea, a, [role="menu"]') !== null) return
          if ((window.getSelection()?.toString() ?? '') !== '') return
          focusInput()
        },
      },
        h('div', { className: 'dide-term-head' },
          h('span', null, t('terminal.title')),
          h('span', { className: 'dide-pane-spacer' }),
          h('button', {
            type: 'button', className: 'dide-icon-button', title: t('terminal.clear'), 'aria-label': t('terminal.clear'),
            onClick: () => { setHistory([]) },
          }, ICON.trash()),
          h('button', {
            type: 'button', className: 'dide-icon-button',
            title: expanded ? t('terminal.close') : t('terminal.open'),
            'aria-label': expanded ? t('terminal.close') : t('terminal.open'),
            onClick: onToggle,
          }, expanded ? ICON.collapse(13) : ICON.expand(13)),
        ),
        expanded && h('pre', { className: 'dide-term-out', ref: body },
          history.length === 0 && h('span', { className: 'dide-term-meta' }, `${root}\n${t('terminal.hint')}\n\n`),
          history.map(block => (block.kind === 'command'
            ? h('span', { key: block.id, className: 'dide-term-block' },
              h('span', { style: { color: 'var(--dsw-alias-brand-primary)' } }, '$ '),
              block.text, '\n')
            : h('span', { key: block.id, className: 'dide-term-block' },
              block.reply.stdout,
              block.reply.stderr === '' ? null : h('span', { className: 'dide-term-err' }, block.reply.stderr),
              h('span', {
                className: 'dide-term-meta',
                // Drives the verdict dot. No code (interrupted) renders no dot,
                // because an unknown outcome is not a success.
                'data-code': block.reply.code === null || block.reply.code === undefined
                  ? undefined
                  : String(block.reply.code),
              },
              `${block.reply.code === null || block.reply.code === undefined
                ? t('terminal.stop')
                : format(t('terminal.exit'), { code: block.reply.code })}\n\n`)))),
          busy && h('span', { className: 'dide-term-meta' }, `${t('terminal.running')}\n`),
        ),
        // The prompt row is present whenever the drawer is open: `open` and
        // `expanded` differ only in how much output is visible, never in
        // whether the reader can type. A collapsed drawer renders neither.
        h('div', { className: 'dide-term-prompt', 'data-busy': busy ? '' : undefined },
          h('span', { className: 'dide-term-dollar' }, '$'),
          h('input', {
            ref: input,
            value: command,
            placeholder: busy ? t('terminal.running') : t('terminal.hint'),
            'aria-label': t('terminal.hint'),
            'data-ide-terminal-input': '',
            autoComplete: 'off',
            spellCheck: false,
            onChange: event => { setCommand(event.target.value) },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                void run()
                return
              }
              // A bare Escape clears the line; a second one is left to the
              // shell's own bindings.
              if (event.key === 'Escape' && command !== '') {
                event.preventDefault()
                event.stopPropagation()
                setCommand('')
                return
              }
              // Up/Down walk this drawer's own history, like a shell.
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                const sent = history.filter(block => block.kind === 'command').map(block => block.text)
                if (sent.length === 0) return
                event.preventDefault()
                event.stopPropagation()
                setCursor(cursorValue => {
                  const next = event.key === 'ArrowUp'
                    ? Math.max(0, (cursorValue ?? sent.length) - 1)
                    : Math.min(sent.length, (cursorValue ?? sent.length) + 1)
                  setCommand(sent[next] ?? '')
                  return next
                })
              }
            },
          }),
          // The Enter affordance appears only once the line has something to
          // run, so an empty bar stays a single quiet prompt mark.
          command !== '' && !busy && h('span', { className: 'dide-term-key' }, 'Enter'),
        ),
      )
    }

    // ── The IDE workspace panel ────────────────────────────────────────────

    /**
     * The `main` panel: File / Terminal bar, section rail, section pane, editor,
     * and the terminal drawer.
     * @param {object} props - framework hooks, copy, and injected layout actions.
     */
    function IdeWorkspace({ t, useSessions, onFlip, shortcuts, sessions, SessionProvider, renderSlot }) {
      const section = useIde(snapshot => snapshot.section)
      const file = useIde(snapshot => snapshot.file)
      const terminal = useIde(snapshot => snapshot.terminal)
      const dirty = useIde(snapshot => snapshot.dirty)
      const notice = useIde(snapshot => snapshot.notice)
      const root = useIde(snapshot => snapshot.root)
      const chatVisible = useIde(snapshot => snapshot.chatVisible)
      const chatWidth = useIde(snapshot => snapshot.chatWidth)
      const pendingOpen = useIde(snapshot => snapshot.pendingOpen)
      const [menu, setMenu] = useState(undefined)
      const [prompt, setPrompt] = useState(undefined)
      const boundKeys = useBoundKeys(shortcuts)

      // Remember the chrome a reload should carry. Debounced, because the
      // conversation column publishes a new width on every pointer move.
      useEffect(() => {
        const timer = window.setTimeout(() => {
          writeLayout({ section, terminal, chatVisible, chatWidth })
        }, 200)
        return () => { window.clearTimeout(timer) }
      }, [section, terminal, chatVisible, chatWidth])

      // The on-screen Session is the one the main column retains. The selector
      // returns PRIMITIVES only: a selector that builds a fresh object every
      // call makes `useSyncExternalStore` see a new snapshot each render, which
      // loops until React aborts the subtree — the panel would then never draw.
      const sessionCwd = useSessions((snapshot) => {
        const rows = snapshot?.byId ?? {}
        for (const id of snapshot?.ids ?? []) {
          const row = rows[id]
          if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return row.cwd
        }
        return undefined
      })
      const sessionId = useSessions((snapshot) => {
        const rows = snapshot?.byId ?? {}
        for (const id of snapshot?.ids ?? []) {
          const row = rows[id]
          if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return id
        }
        return undefined
      })

      useEffect(() => {
        if (sessionCwd === state.root && sessionId === state.sessionId) return
        // A different directory invalidates the buffer: it belongs to the
        // workspace that was on screen a moment ago.
        store.set({ root: sessionCwd, sessionId, file: undefined, dirty: false, pendingOpen: undefined })
      }, [sessionCwd, sessionId])

      /** Load one file into the buffer; the effect below performs the read. */
      const openFile = useCallback((absolutePath) => {
        store.set({ file: { path: absolutePath, text: '', saved: '', phase: 'loading' } })
      }, [])

      /**
       * Open a file, but never on top of an unsaved buffer without asking.
       *
       * The editor owns the live text and publishes only `dirty`; this guard
       * reads that flag and parks the target in the store, where the dialog
       * below settles it. Re-opening the file that is already loaded is not a
       * decision, so it goes straight through.
       */
      const requestOpen = useCallback((absolutePath) => {
        const current = state.file
        const unsaved = state.dirty === true && current !== undefined && current.phase === 'ready'
        if (!unsaved || current.path === absolutePath) {
          store.set({ pendingOpen: undefined })
          openFile(absolutePath)
          return
        }
        store.set({ pendingOpen: { path: absolutePath, name: baseOf(current.path) } })
      }, [openFile])

      /** Settle the unsaved-buffer dialog: cancel, discard, or save first. */
      const settlePendingOpen = useCallback((choice) => {
        const pending = state.pendingOpen
        if (pending === undefined) return
        if (choice === 'cancel') { store.set({ pendingOpen: undefined }); return }
        if (choice === 'discard') {
          store.set({ pendingOpen: undefined })
          openFile(pending.path)
          return
        }
        const saving = editorApi.save
        if (saving === undefined) {
          store.set({ pendingOpen: undefined })
          openFile(pending.path)
          return
        }
        void saving().then((saved) => {
          // A failed write keeps the dialog: the buffer is still unsaved.
          if (saved === false) return
          store.set({ pendingOpen: undefined })
          openFile(pending.path)
        })
      }, [openFile])

      // Every read of the open file is one effect, so a path change is the only
      // thing that starts a request and a superseded one cannot win the race.
      useEffect(() => {
        if (file === undefined || file.phase !== 'loading' || root === undefined) return
        let live = true
        post(ROUTE.read, { root, path: file.path }).then((reply) => {
          if (!live) return
          store.set({ file: { path: reply.path, text: reply.text, saved: reply.text, phase: 'ready' } })
        }).catch((error) => {
          if (!live) return
          const reason = error.reason === 'binary'
            ? t('file.binary')
            : error.reason === 'too-large'
              ? format(t('file.tooLarge'), { bytes: formatBytes(error.limit) })
              : String(error.message ?? error)
          store.set({ file: { path: file.path, text: '', saved: '', phase: 'failed', error: reason } })
        })
        return () => { live = false }
      }, [file?.path, file?.phase, root, t])

      const saveFile = useCallback(() => {
        if (editorApi.save === undefined) { notify(t('file.needOpen'), false); return }
        editorApi.save()
      }, [t])

      const revertFile = useCallback(() => {
        if (editorApi.revert === undefined) { notify(t('file.needOpen'), false); return }
        editorApi.revert()
      }, [t])

      const deleteFile = useCallback(() => {
        const current = state.file
        if (current === undefined || root === undefined) { notify(t('file.needOpen'), false); return }
        if (!window.confirm(format(t('file.deleteConfirm'), { name: baseOf(current.path) }))) return
        post(ROUTE.remove, { root, path: current.path }).then(() => {
          notify(format(t('file.deleted'), { name: baseOf(current.path) }), true)
          store.set({ file: undefined, dirty: false })
        }).catch((error) => { notify(String(error.message ?? error), false) })
      }, [root, t])

      const createEntry = useCallback((kind, relative) => {
        const target = String(relative).trim()
        if (target === '') return
        if (kind === 'folder') {
          post(ROUTE.mkdir, { root, path: target }).then(() => { setPrompt(undefined) })
            .catch((error) => { notify(String(error.message ?? error), false) })
          return
        }
        post(ROUTE.write, { root, path: target, content: '' }).then(() => {
          setPrompt(undefined)
          requestOpen(joinPath(root, target.replace(/\\/g, '/')))
        }).catch((error) => { notify(String(error.message ?? error), false) })
      }, [root, requestOpen])

      const relative = file !== undefined && root !== undefined ? relativeTo(file.path, root) : ''
      // The column header names the Session it hosts, so a reader with several
      // Sessions can tell which conversation is on the right.
      const chatTitle = useSessions((snapshot) => {
        const row = snapshot?.byId?.[sessionId]
        return row?.displayTitle ?? t('ide.chat')
      })
      const sections = [
        { id: 'explorer', label: t('rail.explorer'), icon: ICON.explorer },
        { id: 'search', label: t('rail.search'), icon: ICON.search },
        { id: 'git', label: t('rail.git'), icon: ICON.git },
      ]

      return h('div', { className: 'dide-root' },
        // ── Top bar: switch, File, Terminal ─────────────────────────────
        h('div', { className: 'dide-topbar' },
          h('span', { className: 'dide-topbar-switch' }, h(ModeSwitch, { t, onFlip, shortcutKeys: boundKeys })),
          h('span', { className: 'dide-topbar-sep', 'aria-hidden': true }),
          h('div', { className: 'dide-menu-host' },
            h('button', {
              type: 'button', className: 'dide-topbar-button', 'aria-haspopup': 'menu',
              'aria-expanded': menu === 'file', 'data-open': menu === 'file' ? '' : undefined,
              onClick: () => { setMenu(value => (value === 'file' ? undefined : 'file')) },
            }, ICON.file(13), h('span', null, t('topbar.file'))),
            menu === 'file' && h(Menu, {
              onDismiss: () => { setMenu(undefined) },
              items: [
                { id: 'new', label: t('file.new'), icon: ICON.plus, run: () => { setPrompt({ kind: 'file', value: '' }) } },
                { id: 'newFolder', label: t('file.newFolder'), icon: ICON.newFolder, run: () => { setPrompt({ kind: 'folder', value: '' }) } },
                { id: 'sep', separator: true },
                { id: 'save', label: t('file.save'), icon: ICON.save, shortcut: 'Ctrl+S', disabled: !dirty, run: saveFile },
                { id: 'revert', label: t('file.revert'), icon: ICON.refresh, disabled: !dirty, run: revertFile },
                { id: 'delete', label: t('file.delete'), icon: ICON.trash, disabled: file === undefined, run: deleteFile },
              ],
            }),
          ),
          h('div', { className: 'dide-menu-host' },
            h('button', {
              type: 'button', className: 'dide-topbar-button', 'aria-haspopup': 'menu',
              'aria-expanded': menu === 'terminal', 'data-open': terminal !== 'none' ? '' : undefined,
              onClick: () => { setMenu(value => (value === 'terminal' ? undefined : 'terminal')) },
            }, ICON.terminal(13), h('span', null, t('topbar.terminal'))),
            menu === 'terminal' && h(Menu, {
              onDismiss: () => { setMenu(undefined) },
              items: [
                {
                  id: 'open', label: t('terminal.open'), icon: ICON.terminal, disabled: root === undefined,
                  run: () => { store.set({ terminal: 'expanded' }) },
                },
                {
                  id: 'hide', label: t('terminal.close'), icon: ICON.collapse,
                  disabled: terminal === 'none', run: () => { store.set({ terminal: 'none' }) },
                },
              ],
            }),
          ),
          dirty && h('span', { className: 'dide-dot', title: t('file.modified'), 'aria-label': t('file.modified') }),
          h('span', { className: 'dide-topbar-spacer' }),
          h('span', { className: 'dide-topbar-path', title: root ?? '' }, root ?? ''),
        ),

        // ── Body ────────────────────────────────────────────────────────
        h('div', { className: 'dide-body' },
          h('nav', { className: 'dide-rail', 'aria-label': t('panel.title') },
            sections.map(item => h('button', {
              key: item.id,
              type: 'button',
              className: 'dide-rail-row',
              'data-active': section === item.id ? '' : undefined,
              title: item.label,
              'aria-label': item.label,
              'aria-current': section === item.id ? 'true' : undefined,
              onClick: () => { store.set({ section: item.id }) },
            }, item.icon(18))),
          ),
          h('div', { className: 'dide-side' },
            section === 'explorer' && h(ExplorerPane, { t, root, openFile: requestOpen, currentPath: file?.path }),
            section === 'search' && h(SearchPane, { t, root, openFile: requestOpen }),
            section === 'git' && h(GitPane, { t, root, openFile: requestOpen }),
          ),
          h('div', { className: 'dide-work' },
            h(EditorPane, { t, file, root }),
            terminal !== 'none' && h(TerminalPane, {
              t, root,
              expanded: terminal === 'expanded',
              onToggle: () => { store.set({ terminal: terminal === 'expanded' ? 'open' : 'expanded' }) },
            }),
            h('div', { className: 'dide-editor-foot' },
              dirty && h('span', { className: 'dide-dot', 'aria-hidden': true }),
              h('span', {
                className: 'dide-notice',
                'data-bad': notice !== undefined && notice.ok === false ? '' : undefined,
                title: notice?.text ?? relative,
              }, notice !== undefined ? notice.text : (relative === '' ? t('file.empty') : relative)),
              h('span', { className: 'dide-pane-spacer' }),
              h('button', {
                type: 'button', className: 'dide-icon-button', title: t('terminal.title'), 'aria-label': t('terminal.title'),
                'data-on': terminal !== 'none' ? '' : undefined,
                disabled: root === undefined,
                onClick: () => { store.set({ terminal: terminal === 'none' ? 'expanded' : 'none' }) },
              }, ICON.terminal(13)),
            ),
          ),
          // ── The conversation column ─────────────────────────────────────
          // The Session itself, retained by this panel and put into the
          // session scope — not a right-Sidebar tab, which the shell hides
          // whenever a non-conversation panel fills the main column.
          chatVisible && h('div', {
            className: 'dide-chatsplit',
            'data-drag': useIde(snapshot => snapshot.chatSplit) ? '' : undefined,
            role: 'separator', 'aria-orientation': 'vertical',
            'aria-label': t('ide.chat'),
            onMouseDown: event => {
              event.preventDefault()
              const startX = event.clientX
              const startWidth = state.chatWidth
              const move = moveEvent => {
                const next = Math.min(Math.max(startWidth + (startX - moveEvent.clientX), 280), 720)
                if (next !== state.chatWidth) store.set({ chatWidth: next })
              }
              const up = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
                store.set({ chatSplit: false })
              }
              store.set({ chatSplit: true })
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
            },
          }),
          chatVisible && h('div', { className: 'dide-chatcol', style: { '--dide-chat-width': `${String(chatWidth)}px` } },
            h('div', { className: 'dide-chat-head' },
              h('span', { className: 'dide-chat-title' }, chatTitle),
              h('span', { className: 'dide-pane-spacer' }),
              h('button', {
                type: 'button', className: 'dide-icon-button',
                title: t('ide.chatHide'), 'aria-label': t('ide.chatHide'),
                onClick: () => { store.set({ chatVisible: false }) },
              }, ICON.close()),
            ),
            sessionId === undefined
              ? h('div', { className: 'dide-chat-empty' }, t('ide.chatEmpty'))
              : h(EmbeddedConversation, { sessions, sessionId, SessionProvider, renderSlot, t }),
          ),
        ),

        // ── Unsaved buffer: the decision that was missing ──────────────────
        pendingOpen !== undefined && h(ConfirmDialog, {
          title: t('file.unsavedTitle'),
          body: format(t('file.unsavedBody'), { name: pendingOpen.name }),
          onCancel: () => { settlePendingOpen('cancel') },
          actions: [
            { id: 'cancel', label: t('file.cancel'), onSelect: () => { settlePendingOpen('cancel') } },
            {
              id: 'discard', label: t('file.discardUnsaved'), danger: true,
              onSelect: () => { settlePendingOpen('discard') },
            },
            {
              id: 'save', label: t('file.saveAndOpen'), primary: true,
              onSelect: () => { settlePendingOpen('save') },
            },
          ],
        }),

        // ── New file / folder prompt ─────────────────────────────────────
        prompt !== undefined && h(PromptDialog, {
          t,
          title: prompt.kind === 'folder' ? t('file.newFolder') : t('file.new'),
          value: prompt.value,
          onChange: value => { setPrompt({ kind: prompt.kind, value }) },
          onCancel: () => { setPrompt(undefined) },
          onSubmit: () => { createEntry(prompt.kind, prompt.value) },
        }),
      )
    }

    // ── The Session inside the IDE panel ───────────────────────────────────
    //
    // IDE mode keeps the Agent conversation usable instead of hiding it. The
    // right column hosts the Session ITSELF: this panel retains the session
    // (`sessions.retain`, its own `ide-mode` source), wraps the reference in
    // the scope adapter's `SessionProvider`, and renders the shipped
    // `conversation.content` factory with `variant: 'embedded'` — the exact
    // structure the shipped subagent sidebar chat uses. Inside that provider
    // the session binding materializes, so the factory receives `sessionId`,
    // `useSession`, `useConversation`, `useInput`, and `inputActions` from the
    // binding itself: streaming, tools, and the composer all behave identically
    // to the main conversation, with no dependency on the shipped rightbar —
    // whose Session views are hidden whenever a non-conversation panel fills
    // the main column (IDE mode by definition).

    /** Chat view: the strict Session body, as the sidebar chat tab renders it. */
    function FixedChatConversationView(props) {
      return props.renderSlot('conversation.session', { view: 'chat' })
    }

    /** Local Component map handed to the embedded content factory. */
    const EMBEDDED_CONTENT_SLOTS = { views: FixedChatConversationView }

    /**
     * The `ide-mode.chat` slot body: INSIDE the session scope, so the
     * binding's standard props and this entry's factory renderer are both at
     * hand. Purely a renderer — the retain and the phase ladder live with the
     * caller.
     * @param {object} props - binding hooks plus the entry kit.
     */
    function IdeChatBody({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }) {
      const session = useSession(value => value)
      const conversation = useConversation(value => value)
      const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
      const active = conversation.activeTargets.size > 0
        || (!session.blank && !session.awaitingFirstTurn)
        || session.running
      const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
      const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
      const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
      const phase = settling ? 'settling' : hero ? 'hero' : 'active'
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero }, {
        slots: EMBEDDED_CONTENT_SLOTS,
      })
    }

    /**
     * One retained Session reference with the lifetime of this component.
     *
     * The retain uses this plugin's own source name, so the reference is
     * counted under `ide-mode` in `retainedBy` and never holds the session
     * open after the panel unmounts.
     * @param {object} sessions - the Client sessions face.
     * @param {string} sessionId - the session to retain.
     * @returns {object|undefined} the reference, once ready-state settles.
     */
    function useSessionReference(sessions, sessionId) {
      const [reference, setReference] = useState(undefined)
      useEffect(() => {
        if (sessions === undefined || sessionId === undefined) { setReference(undefined); return }
        let live = true
        let held
        try {
          held = sessions.retain(sessionId, { source: 'ide-mode' })
        } catch (error) {
          console.warn('[ide-mode] could not retain the session:', error)
          return
        }
        setReference(held)
        held.ready.catch(error => {
          if (live) console.warn('[ide-mode] session opening failed:', error)
        })
        return () => {
          live = false
          try { held.release() } catch { /* already released */ }
        }
      }, [sessions, sessionId])
      return reference
    }

    /**
     * The right column: retain the Session under this plugin's own source and
     * put its reference into the session scope, then render the
     * `ide-mode.chat` slot — whose body sees the binding and renders the
     * shipped conversation factory. `SessionProvider` comes from this panel's
     * slot kit; `renderSlot` renders the child slot this panel owns.
     * @param {object} props - sessions face, session id, slot kit, and copy.
     */
    function EmbeddedConversation({ sessions, sessionId, SessionProvider, renderSlot, t }) {
      const reference = useSessionReference(sessions, sessionId)
      // Mounting the conversation factory is by far the most expensive part of
      // entering the mode (it renders the whole session history). Holding it
      // back by one frame lets the shell — rail, top bar, tree, panes — paint
      // first, so the switch responds immediately and the chat fades in behind
      // it instead of blocking the same commit.
      const [warm, setWarm] = useState(false)
      useEffect(() => {
        if (warm) return undefined
        let cancelled = false
        const frame = window.requestAnimationFrame(() => { if (!cancelled) setWarm(true) })
        return () => { cancelled = true; window.cancelAnimationFrame(frame) }
      }, [warm])
      if (reference === undefined || SessionProvider === undefined || renderSlot === undefined) {
        return h('div', { className: 'dide-chat-empty' }, t('ide.chatEmpty'))
      }
      return h(SessionProvider, { session: reference },
        h('div', { className: 'dide-chat-body' },
          warm
            ? renderSlot('ide-mode.chat', {})
            : h('div', { className: 'dide-chat-placeholder', 'data-ide-chat-pending': '' }),
        ),
      )
    }

    /**
     * Contain a render failure to this panel.
     *
     * Built defensively: `React.Component` is read at CALL time, not while this
     * factory runs, so a runtime whose React surface lacks class components
     * degrades to plain rendering instead of throwing at module load.
     * @param {object} props - the panel's slot props.
     */
    function IdeWorkspacePanel(props) {
      const Base = React.Component
      if (typeof Base !== 'function') return h(IdeWorkspace, props)
      const Boundary = memoizedBoundary(Base)
      return h(Boundary, null, h(IdeWorkspace, props))
    }

    /** One boundary class per React Component base, created once. */
    let boundaryCache
    function memoizedBoundary(Base) {
      if (boundaryCache !== undefined && boundaryCache.Base === Base) return boundaryCache.Class
      class WorkspaceBoundary extends Base {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) { return { error } }

        componentDidCatch(error, info) {
          console.error('[ide-mode] workspace render failed:', error, info?.componentStack)
        }

        render() {
          if (this.state.error === null) return this.props.children
          return h('div', {
            style: {
              padding: '24px', fontFamily: 'ui-monospace, monospace', fontSize: '12px',
              color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap', overflow: 'auto',
            },
          }, `[ide-mode] workspace render failed\n${String(this.state.error?.message ?? this.state.error)}\n\n${String(this.state.error?.stack ?? '')}`)
        }
      }
      boundaryCache = { Base, Class: WorkspaceBoundary }
      return WorkspaceBoundary
    }

    // ── Plugin body ────────────────────────────────────────────────────────

    return {
      // Keep this list to what the workspace itself cannot exist without.
      //
      // `shortcuts` is deliberately NOT injected: a name in `inject` makes
      // Cordis wait for that service before activating at all, and a
      // composition that does not mount it then leaves this plugin permanently
      // inactive with no error. It is read through `ctx.get()` with an
      // undefined check instead, so the workspace still works when it is
      // absent.
      inject: ['slots', 'locale', 'layout', 'sessions'],

      apply(ctx) {
        // A throw anywhere in the body must be visible: a silent failure here
        // is indistinguishable from "the plugin never loaded".
        try {
          applyBody(ctx)
        } catch (error) {
          try {
            console.error('[ide-mode] apply THREW:', error && error.message, error && error.stack)
          } catch { /* console unavailable */ }
          throw error
        }
      },
    }

    /** The real plugin body. */
    function applyBody(ctx) {
        // Boot trace. This bundle is served as an immutable artifact, so a
        // failure here is invisible in the page unless it reports itself; the
        // trace lines below are the only way to tell "apply never ran" from
        // "apply ran and threw at step N" without a debugger.
        const trace = (...parts) => { try { console.info('[ide-mode]', ...parts) } catch { /* console unavailable */ } }
        trace('apply: enter')

        // One stylesheet for every seat; the plugin's own effect removes it.
        try {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-ide-mode', '')
          style.textContent = CSS
          document.head.append(style)
          ctx.effect(() => () => { style.remove() }, 'ide-mode: stylesheet')
          trace('apply: stylesheet installed')
        } catch (error) {
          trace('apply: stylesheet FAILED', String(error && error.message))
        }

        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ide-mode: dictionaries')
          trace('apply: dictionaries registered')
        } catch (error) {
          trace('apply: dictionaries FAILED', String(error && error.message))
          throw error
        }
        const t = ctx.locale.bind(NS)

        // The optional faces. Each may be absent in a trimmed composition, so
        // every use site below guards it.
        const shortcuts = ctx.get('shortcuts')
        trace('apply: faces', JSON.stringify({ shortcuts: shortcuts !== undefined }))

        // ── Mode transitions ───────────────────────────────────────────────
        //
        // Entering IDE mode does two things in one gesture: the main column
        // shows the workspace (whose right column hosts the Session itself),
        // and the left sidebar collapses to its rail (its own expand control
        // stays, which is what keeps the rail reachable).
        //
        // Leaving restores the Conversation and the sidebar.

        /**
         * Collapse the left column without guessing whether it is already
         * collapsed. `ctx.layout` exposes a toggle and nothing else, so the
         * shell's `wide` report — recorded by the New-session HOC below — is
         * the state this reads. The toggle is one-way: entering IDE mode never
         * expands a sidebar the reader had closed.
         */
        const collapseSidebar = () => {
          if (sidebarState.observed && sidebarState.wide) {
            ctx.layout.toggleSidebar()
            sidebarState.collapsedByIde = true
            return
          }
          // Two narrow readings reach here: the shell says the column is
          // already a rail (nothing to do), or the row has not rendered yet.
          // In the second case the column starts expanded, so one toggle lands
          // on the rail.
          if (!sidebarState.observed) {
            ctx.layout.toggleSidebar()
            sidebarState.collapsedByIde = true
          }
        }

        /**
         * Select this plugin's main panel, surviving the layout's pruning pass.
         *
         * `ui-layout` calls `retainMainPanels()` on every `main` slot change and
         * drops a selection whose key is not in `ctx.slots.entries('main')` at
         * that instant. A brand-new plugin's registration can lag that pass, so
         * a single `selectPanel` is silently reset to the Conversation — which
         * is exactly the "sidebar collapsed but the panel never changed" symptom.
         *
         * Re-asserting on the next microtask wins that race without polling: by
         * then the registration from `slots.inject('main')` has landed.
         */
        const selectWorkspacePanel = () => {
          ctx.layout.selectPanel(PANEL_KEY)
          // One retry, only if the selection was pruned away.
          Promise.resolve().then(() => {
            if (state.enabled !== true) return
            if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_KEY) return
            try {
              ctx.layout.selectPanel(PANEL_KEY)
            } catch (error) {
              console.warn('[ide-mode] could not select the workspace panel:', error)
            }
          })
        }

        /**
         * Drop the shell's track animation for the duration of one switch.
         *
         * Collapsing the sidebar makes the shell animate its grid tracks for
         * 300ms. Entering or leaving the mode replaces the whole centre panel
         * in the same commit, so those 300ms are spent re-laying-out a heavy
         * workspace every frame — the stutter this flag removes. The panel's
         * own fade carries the transition instead. Re-enabled on a timer
         * because the shell settles its own animation state after ~600ms.
         */
        let switchMotionTimer
        const suppressShellMotion = () => {
          // Absent in a bare test harness, where the mode still has to flip.
          const root = typeof document === 'undefined' ? undefined : document.documentElement
          if (root === undefined || root === null) return
          root.setAttribute('data-dide-switching', '')
          globalThis.clearTimeout(switchMotionTimer)
          switchMotionTimer = globalThis.setTimeout(() => {
            root.removeAttribute('data-dide-switching')
          }, 260)
        }

        /**
         * The one entry point for both the switch and the shortcut.
         * @param {boolean} enabled - mode to enter.
         */
        const applyMode = (enabled) => {
          writePersisted(enabled)
          store.set({ enabled, ...(enabled ? {} : { terminal: 'none' }) })
          suppressShellMotion()
          if (enabled) {
            // Collapse first: the conversation column lives in the panel, and
            // the switch lives in the rail.
            collapseSidebar()
            selectWorkspacePanel()
            return
          }
          ctx.layout.selectPanel(null)
          // Restore only what this plugin collapsed, so a rail the reader chose
          // stays a rail.
          if (sidebarState.collapsedByIde && sidebarState.observed && !sidebarState.wide) {
            ctx.layout.toggleSidebar()
          }
          sidebarState.collapsedByIde = false
        }

        /** Flip the mode from wherever the gesture came. */
        const flipMode = () => { applyMode(!state.enabled) }

        // ── The workspace panel ────────────────────────────────────────────
        trace('apply: about to inject main seat')
        ctx.slots.inject('main', function* () {
          trace('inject(main): declaration live, registering panel')
          yield ctx.slots.register({
            name: 'main',
            key: PANEL_KEY,
            locale: NS,
            // The declared session child is what makes this entry's kit carry
            // `SessionProvider`: the right column needs it to put the retained
            // Session reference into the session scope before rendering the
            // conversation factory. The child slot itself is registered below.
            children: { 'ide-mode.chat': { kind: 'single', scope: 'session' } },
            inject: () => ({ onFlip: flipMode, shortcuts, sessions: ctx.sessions }),
          }, IdeWorkspacePanel)
          trace('inject(main): panel registered')
        })
        trace('apply: main seat injected')

        // ── The embedded conversation slot ─────────────────────────────────
        //
        // Rendered inside a `SessionProvider`, so the session binding's own
        // hooks (`sessionId`, `useSession`, `useConversation`, `useSessions`)
        // arrive as standard props, and this entry's kit adds
        // `renderFactorySlot`. The factory's inject plus the binding's props
        // are what make the composer live — nothing else is wired by hand.
        ctx.slots.inject('ide-mode.chat', function* () {
          yield ctx.slots.register({
            name: 'ide-mode.chat',
            locale: NS,
          }, IdeChatBody)
        })

        // ── The switch, in the sidebar's New-session row ───────────────────
        //
        // The HOC layer wraps the shell's own New-session button and adds the
        // switch beneath it, which is where the reference puts it: directly
        // under the brand and above New Session's peers. `wide` distinguishes
        // the expanded column from the 56px rail, so the switch degrades to a
        // single glyph exactly where the row does.
        ctx.slots.inject('sidebar.session.action', function* () {
          yield ctx.slots.register({
            name: 'sidebar.session.action',
            id: PANEL_KEY,
            order: -10,
            locale: NS,
            inject: () => ({ onFlip: flipMode, shortcuts }),
          }, function SessionActionLayer({ children, wide, onFlip, shortcuts: layerShortcuts, t: translate }) {
            const layerKeys = useBoundKeys(layerShortcuts)
            // Record the shell's own report: this row is the one place the
            // sidebar's expanded state reaches this plugin.
            sidebarState.wide = wide
            sidebarState.observed = true
            if (!wide) {
              // The rail's row is one 36px control wide; the shell renders New
              // Session as its own icon there, so the switch renders above it.
              return h('div', { className: 'dide-session-action' },
                h(ModeSwitch, { t: translate, compact: true, onFlip, shortcutKeys: layerKeys }),
                children,
              )
            }
            return h('div', { className: 'dide-session-action' },
              children,
              h('div', { className: 'dide-session-action-row' },
                h(ModeSwitch, { t: translate, onFlip, shortcutKeys: layerKeys }),
              ),
            )
          })
        })

        // ── The mode command ───────────────────────────────────────────────
        //
        // Deliberately declared with NO default binding.
        //
        // `ShortcutRegistry.register` validates every profile a default declares,
        // and two rules make the obvious choices impossible:
        //   * `Tab` sits on the reserved list, so no Ctrl/Cmd+Tab variant passes;
        //   * macOS rejects Alt-without-primary, which any cross-platform chord
        //     hits on the `web:macos` profile because `primary` resolves to Meta.
        // One rejected profile throws for the WHOLE registration — which is what
        // took this plugin down before. A command whose `defaults` is empty skips
        // validation entirely (`resolveShortcutDefault` returns undefined and the
        // registry continues), so the command is always registrable and the user
        // binds it in Settings → Shortcuts, where the shell reports conflicts
        // honestly instead of throwing during activation.
        trace('apply: shortcuts.register?', typeof shortcuts?.register)
        if (typeof shortcuts?.register === 'function') {
          try {
            ctx.effect(() => shortcuts.register({
              id: 'ide-mode.toggle',
              label: () => t('switch.toggle'),
              aliases: ['ide', 'toggle ide', '切换模式', 'switch mode'],
              defaults: {},
              // Page and terminal, never an editor: a bound chord must keep
              // working while the IDE terminal has focus.
              regions: ['page', 'terminal'],
              modals: [],
              resolve: () => {
                flipMode()
                return { status: 'handled', run: () => {} }
              },
            }), 'ide-mode: toggle command')
            trace('apply: shortcut command registered')
          } catch (error) {
            // Even an empty-default command could collide on a re-registration;
            // never let that take down the panels that are already live.
            trace('apply: shortcut registration refused', String(error && error.message))
          }
        }

        // ── Selection is the mirror of the mode ────────────────────────────
        ctx.effect(() => {
          const sync = () => {
            const enabled = ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_KEY
            if (state.enabled === enabled) return
            store.set({ enabled, ...(enabled ? {} : { terminal: 'none' }) })
          }
          sync()
          return ctx.layout.panelInfo.subscribe(sync)
        }, 'ide-mode: follow panel selection')

        // Restore the remembered mode once the panel registration above is live
        // in this same apply pass.
        ctx.effect(() => {
          if (!readPersisted()) return
          Promise.resolve().then(() => {
            try {
              applyMode(true)
            } catch (error) {
              console.error('[ide-mode] could not restore IDE mode:', error)
            }
          })
        }, 'ide-mode: restore mode')

        trace('apply: complete')
    }
  },
})
