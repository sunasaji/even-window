// pinhole-window — the window switcher: its state and the presenter that walks the menu levels.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.

import {
  clickInput,
  levelRows,
  MENU_ROOT_ID,
  MENU_ROOT_LABEL,
  type MenuRow,
  type MenuState,
  type MenuToken,
  parseToken,
  pathHeader,
  resumablePath,
  rowMenuEffect,
} from '../shared/glassMenu.ts'
import { chordCommand, chordToXdo, MODS, type Mod, wheelButton } from '../shared/keys.ts'
import type { LauncherEntry, WinInfo } from '../shared/types.ts'
import { renderAppPanel } from './bindingsEditor.ts'
import { toast } from './chrome.ts'
import { log } from './debugLog.ts'
import { noteExitAsked } from './exitCurtain.ts'
import { bridge } from './main.ts'
import {
  buildMenuItems,
  MENU_APP_PREFIX,
  MENU_MAX_APPS,
  type MenuApp,
  type MenuItem,
  menuSignature,
  mruOrderItems,
  rootPages,
} from './menuModel.ts'
import {
  glassCovered,
  measuringLink,
  mirrorPaused,
  overlayBusy,
  startupHint,
  syncOverlay,
} from './overlay.ts'
import { palettePanelUpdate, renderAppsEntry } from './palette.ts'
import { enterRoot } from './root.ts'
import { apiPost } from './serverLink.ts'
import { invert, setInvert } from './settings.ts'
import { renderStatus } from './statusUi.ts'
import { availMsg } from './stream.ts'
import { errText, withTimeout } from './util.ts'
import { voiceActive } from './voice.ts'

export let windows: WinInfo[] = []
/** Focus recency (window ids, most recent first) from `{t:'windows'}`. Only the root list's display
 *  order reads it; see `mruOrderItems`. */
export let winRecent: string[] = []
/** The launchable set and the recency order, from `{t:'apps'}` (docs/protocol.md). The head of
 *  `appRecent` is the root list's `+` rows; the full list is the phone's `apps` palette and
 *  the glasses' `Launch...` level. */
export let apps: LauncherEntry[] = []
let appRecent: string[] = []

/** The curated launcher rows for the glasses, in recency order. Resolved against the live list
 *  so an id the server has since dropped (hidden in apps.conf, package removed) cannot appear. */
export function menuApps(): MenuApp[] {
  const out: MenuApp[] = []
  for (const id of appRecent) {
    const a = apps.find(x => x.id === id)
    if (a) out.push({ id: a.id, name: a.name })
    if (out.length >= MENU_MAX_APPS) break
  }
  return out
}
/** Seeded with the entry row alone rather than `[]`, so a double-tap before the first
 *  `{t:'windows'}` still opens a list with a way into the hierarchy on it. */
export let menuItems: MenuItem[] = buildMenuItems([])
let menuSig = menuSignature(menuItems)
export let menuOpen = false
export let menuSel = 0
export function setMenuSel(v: number): void {
  menuSel = v
}

export function overlayActive(): boolean {
  return (
    menuOpen ||
    voiceActive() ||
    availMsg !== null ||
    overlayBusy ||
    measuringLink ||
    glassCovered ||
    mirrorPaused() !== null ||
    startupHint
  )
}

/** A fresh window set from SSE. The items are always rebuilt, because `active` has to stay
 *  fresh for the overlay; no path here touches the bridge. */
export function setWindows(list: WinInfo[], recent?: readonly string[]): void {
  windows = list
  // Display order only (see `mruOrderItems`). Taken even while the menu is open: the open list
  // renders by the frozen `menuRootOrder`, and this is what the next open will use.
  //
  // Normalised at the boundary: a server older than this client sends no `recent`, and an
  // `undefined` here would throw in `openMenu`. `[]` degrades to the server's own order.
  winRecent = Array.isArray(recent) ? [...recent] : []
  rebuildMenu('windows')
  // The open palette, if it shows windows: `task` lists them and `window` hides the rows that
  // need one.
  palettePanelUpdate('windows')
  // The focused app is half of what the app panel shows (which binding is in force), so a
  // window switch has to repaint it.
  renderAppPanel()
}

/** A fresh launchable set / recency order from SSE (`{t:'apps'}`). Same path as a window
 *  change: the items are rebuilt and, if the signature moved, logged. */
export function setApps(list: LauncherEntry[], recentIds: string[]): void {
  apps = list
  appRecent = recentIds
  renderAppsEntry()
  palettePanelUpdate('apps')
  rebuildMenu('apps')
}

/** Rebuild `menuItems` from the current windows + curated apps and publish if it changed. */
function rebuildMenu(why: 'windows' | 'apps'): void {
  const next = buildMenuItems(windows, menuApps())
  const sig = menuSignature(next)
  const changed = sig !== menuSig
  menuSig = sig
  menuItems = next
  // A window closing can remove the page the list was on.
  menuPage = Math.min(menuPage, rootPagesNow().length - 1)
  // Clamp the cursor only while the root list is what it indexes; inside a level, an unrelated
  // window opening must not move the highlight.
  if (menuPath.length === 0) menuSel = Math.min(menuSel, Math.max(0, rootRows().length - 1))
  if (changed) {
    const n = menuItems.filter(it => it.kind === 'app').length
    log(`${why}: ${menuItems.length} menu item(s) (${n} launcher)`)
  }
  // A level is a function of the window set too (`hasWindow` hides Close Window / Kill), so it
  // is re-derived, not just repainted.
  if (menuOpen) {
    if (menuPath.length) refreshLevel()
    else syncOverlay()
  }
  renderStatus()
}

// ── the hierarchy (src/shared/glassMenu.ts), as the client drives it ───────────────────────
//
// `menuPath` is the whole state machine. Empty means the root list (tasks); one entry
// per level descended, each carrying the row label it was entered by (for the header) and the
// cursor position to restore when it is popped.
//
// A level change is one `textContainerUpgrade` of a different string: the tiles under it are
// already black, so descending pushes zero images
// (docs/decisions/client-drawn-glasses-menu.md).

interface MenuLevel {
  /** The level id in glassMenu's tree. */
  id: string
  /** The label of the row that entered it — the header is built from these. */
  label: string
  /** The cursor position in the parent, restored on ascend. */
  backSel: number
}

export let menuPath: MenuLevel[] = []
/** The rows of the level currently displayed. Empty while the root list is showing. */
export let menuLevelRows: MenuRow[] = []
/** Sticky modifiers for the Keys levels: armed by `Mods...`, applied to the next key, then
 *  cleared. Kept in `MODS` order by construction so a chord has one spelling. */
export let keyMods: Mod[] = []

/** The snapshot every level is a pure function of. */
export function menuState(): MenuState {
  return {
    mods: keyMods,
    invert,
    hasWindow: activeWindow() !== null,
    rootPaged: rootPageCount() > 1,
    apps,
  }
}

/** The focused window, or null. The one place the menu resolves "this window": rows that act
 *  on one are hidden without it, and those that act post its `wid` (clients select by wid,
 *  never by the recycled window-manager number; docs/protocol.md). */
export function activeWindow(): WinInfo | null {
  return windows.find(w => w.active && w.wid) ?? null
}

/** How many rows the surface is showing — the root list's current page or a level. */
export function menuRowCount(): number {
  return menuPath.length === 0 ? rootRows().length : menuLevelRows.length
}

/** The recency order the open root list renders by, frozen at `openMenu` so a focus change from
 *  outside cannot re-sort the rows under the cursor. While the menu is shut, `rootRows()` reads
 *  the live `winRecent` instead. */
export let menuRootOrder: string[] = []

/** Which page of the root list is up. Reset by `openMenu`, turned by `Prev Page` / `Next Page`
 *  in the `Menu...` level. */
export let menuPage = 0

/** The root list in display order, laid out as pages (`rootPages`): never empty. */
function rootPagesNow(): MenuItem[][] {
  return rootPages(mruOrderItems(menuItems, menuOpen ? menuRootOrder : winRecent))
}

/** How many pages the root list has, for the header. */
export function rootPageCount(): number {
  return rootPagesNow().length
}

/** The root list as drawn: the rows of the current page. The one accessor for it: the overlay
 *  renderer and the selection path must index the same array, or a tap lands on a row the user
 *  is not looking at. */
export function rootRows(): MenuItem[] {
  const pages = rootPagesNow()
  return pages[Math.min(menuPage, pages.length - 1)] ?? []
}

/** Re-derive the current level's rows in place, keeping the cursor. For a toggle (`Mods...`,
 *  `Invert`) whose own label is what changed. */
function refreshLevel(): void {
  const top = menuPath[menuPath.length - 1]
  if (!top) return
  menuLevelRows = levelRows(top.id, menuState()) ?? []
  if (menuSel >= menuLevelRows.length) menuSel = Math.max(0, menuLevelRows.length - 1)
  syncOverlay()
}

/** Descend. `label` is the row that was picked, for the header. */
function pushLevel(id: string, label: string): void {
  const rows = levelRows(id, menuState())
  if (!rows) {
    log(`menu: no such level ${id}, ignored`)
    return
  }
  menuPath.push({ id, label, backSel: menuSel })
  menuLevelRows = rows
  menuSel = 0
  menuOpen = true
  log(`menu level ${pathHeader(menuPath.map(p => p.label))} (${String(rows.length)} rows)`)
  syncOverlay()
}

/** Ascend one level; at the root list, close. The double-tap's whole behaviour (`menuActionFor`)
 *  resolves to one of these two. */
export function popLevel(): void {
  const gone = menuPath.pop()
  if (!gone) {
    closeMenu()
    return
  }
  const top = menuPath[menuPath.length - 1]
  menuLevelRows = top ? (levelRows(top.id, menuState()) ?? []) : []
  menuSel = Math.min(gone.backSel, Math.max(0, menuRowCount() - 1))
  syncOverlay()
}

/** Where an action left the user, so the next open can put them back. Null after a close the
 *  user asked for (a double-tap at the root list). */
let menuResume: { path: MenuLevel[]; sel: number } | null = null

export function openMenu(): void {
  if (menuOpen) return
  menuOpen = true
  menuPath = []
  menuLevelRows = []
  // Freeze the display order for as long as this open lasts, before anything reads
  // `rootRows()`.
  menuRootOrder = [...winRecent]
  // Resume, if an action closed the menu so its result could be seen: one double-tap puts the
  // same row back under the cursor. Re-derived against live state and trimmed to the deepest
  // level that still exists, so resuming can never land nowhere.
  const keep = menuResume
  if (keep) {
    const ok = resumablePath(
      keep.path.map(p => p.id),
      menuState(),
    )
    const path = keep.path.slice(0, ok.length)
    const top = path[path.length - 1]
    if (top) {
      menuPath = path
      menuLevelRows = levelRows(top.id, menuState()) ?? []
      menuSel = Math.min(keep.sel, Math.max(0, menuLevelRows.length - 1))
      log(`menu resumed at ${pathHeader(menuPath.map(p => p.label))}`)
      syncOverlay()
      return
    }
  }
  // The cursor opens on `Menu...`, the first row of the first page: it is used more than a
  // window switch. MRU puts the focused window under it and the previous one next.
  menuPage = 0
  menuSel = 0
  syncOverlay()
}

/** `reason` decides whether the level is remembered:
 *   'resume' — a Keys-branch row, where the next thing the user does is usually another one.
 *              Close so the result is visible, but remember where we were.
 *   'done'   — everything else: the user closed it, or an operation finished. Forget, so the
 *              next open starts at the window list, like any desktop menu. */
export function closeMenu(reason: 'done' | 'resume' = 'done'): void {
  if (!menuOpen) return
  menuOpen = false
  menuResume = reason === 'resume' && menuPath.length ? { path: [...menuPath], sel: menuSel } : null
  menuPath = []
  menuLevelRows = []
  // The sticky modifiers go either way: a Ctrl armed and then abandoned must not be waiting for
  // the next key the user sends by some other path.
  keyMods = []
  syncOverlay()
}

export function moveMenu(delta: number): void {
  const n = menuRowCount()
  if (!n) return
  menuSel = (((menuSel + delta) % n) + n) % n
  syncOverlay()
}

/** Overlay selection: the root list acts and closes (a window switch has nowhere to go back to);
 *  a level hands the row to `activateRow`, which decides for itself whether the level stays. */
export async function chooseMenu(): Promise<void> {
  if (menuPath.length === 0) {
    // The same array the overlay drew (display order), read before `closeMenu` releases the
    // frozen order.
    const it = rootRows()[menuSel]
    closeMenu()
    if (it) await activateMenuItem(it)
    return
  }
  const row = menuLevelRows[menuSel]
  if (row) await activateRow(row)
}

/** Act on one level row. The token is parsed by `parseToken`; an unparseable one is logged and
 *  dropped, because acting on a row we cannot name is acting on a row the user is not shown.
 *
 *  What happens to the menu is decided by `rowMenuEffect` (pure, in glassMenu.ts): stay /
 *  resume / reset. The menu blanks the mirror, so every row whose result lands on the mirrored
 *  screen closes it; only the Keys branch is remembered. */
async function activateRow(row: MenuRow): Promise<void> {
  const t = parseToken(row.token)
  if (!t) {
    log(`menu row "${row.label}": unknown token ${row.token}, ignored`)
    return
  }
  // Close first, then act: the menu is blanking the four tiles, so a row that changes the
  // mirrored screen must get out of the way before it happens, or the pump is still standing
  // down for the first frames. Closing resets the diff baseline and repaints.
  const modsAtPick = [...keyMods] // closeMenu clears the sticky modifiers; the key needs them
  const effect = rowMenuEffect(row.token)
  if (effect !== 'stay') closeMenu(effect === 'resume' ? 'resume' : 'done')
  switch (t.kind) {
    // Navigation stays here: the path stack is this presenter's state. Everything below the
    // `mod` case is the row's effect, which is the same wherever it was picked (`runRowToken`).
    case 'sub':
      pushLevel(t.id, row.crumb ?? row.label)
      return
    case 'back':
      popLevel()
      return
    case 'page':
      turnRootPage(t.dir)
      return
    case 'mod': {
      const on = keyMods.includes(t.mod)
      keyMods = MODS.filter(m => (m === t.mod ? !on : keyMods.includes(m)))
      log(`menu mods: ${keyMods.length ? keyMods.join('+') : 'none'}`)
      refreshLevel()
      return
    }
    default:
      await runRowToken(t, modsAtPick, 'menu')
      return
  }
}

/** `Prev Page` / `Next Page`: back out to the root list on the neighbouring page, wrapping,
 *  with the cursor on its `Menu...` row so the next turn is the same few gestures again. */
function turnRootPage(dir: 1 | -1): void {
  const n = rootPageCount()
  menuPage = (((menuPage + dir) % n) + n) % n
  menuPath = []
  menuLevelRows = []
  menuSel = 0
  log(`menu page ${String(menuPage + 1)}/${String(n)}`)
  syncOverlay()
}

/** Do what a row says: the half of a row's behaviour that is the same on every surface. The
 *  phone's `window` palette offers the same rows as the glasses' `Window...` level, so the
 *  effect is written once. Navigation (`sub` / `back`) and the sticky modifiers (`mod`) are not
 *  here: they belong to the presenter that drew the level.
 *
 *  `mods` is passed in because the overlay's close clears them before the key is sent; `where`
 *  only reaches the log. */
export async function runRowToken(
  t: MenuToken,
  mods: readonly Mod[],
  where: string,
): Promise<void> {
  switch (t.kind) {
    // Unreachable from `activateRow` (it handles these itself) and meaningless here; named so
    // the switch stays exhaustive and a future caller cannot pass one in silently.
    case 'sub':
    case 'back':
    case 'page':
    case 'mod':
      log(`${where}: ${t.kind} is navigation, not an action — ignored`)
      return
    case 'key': {
      // One-shot modifiers, from the snapshot the caller took: the overlay's close clears
      // `keyMods` before we get here, and arming Ctrl then picking `c` must not send a bare `c`.
      const chord = { mods: [...mods], key: t.key }
      // The wheel is not a key. No level offers it, but `isBindableKey` accepts the name, so a
      // hand-made token would otherwise send a key that is accepted and does nothing.
      const b = wheelButton(t.key)
      if (b !== null) {
        const r = await apiPost<{ ok?: boolean }>('/api/desktop/input', {
          kind: 'click',
          arg: String(b),
        })
        log(
          `${where} wheel ${chordCommand(chord)} => ${r?.ok ? 'ok' : 'failed'}` +
            (mods.length ? ' (modifiers are not composed on this path)' : ''),
        )
        return
      }
      const arg = chordToXdo(chord)
      const r = await apiPost<{ ok?: boolean }>('/api/desktop/input', { kind: 'key', arg })
      log(`${where} key ${arg} => ${r?.ok ? 'ok' : 'failed'}`)
      return
    }
    case 'click': {
      const body = clickInput(t.action)
      const r = await apiPost<{ ok?: boolean }>('/api/desktop/input', body)
      log(`${where} ${body.kind} ${body.arg} => ${r?.ok ? 'ok' : 'failed'}`)
      return
    }
    case 'rp': {
      const r = await apiPost<{ ok?: boolean; msg?: string }>('/api/wm/key', { key: t.key })
      log(`${where} ratpoison ${t.key} => ${r?.ok ? 'ok' : (r?.msg ?? 'failed')}`)
      return
    }
    // A `Launch...` row. The name is looked up for the toast; only the id is posted.
    case 'app':
      await launchApp(t.id, apps.find(a => a.id === t.id)?.name ?? t.id)
      return
    // On the glasses this also closes the menu (`rowMenuEffect`), since the menu covers the
    // mirror whose derivation it changes. On the phone the palette stays up.
    case 'invert':
      setInvert(!invert)
      return
    case 'close': {
      const w = activeWindow()
      if (!w?.wid) {
        log(`${where} close: no focused window, refused`)
        return
      }
      const r = await apiPost<{ ok?: boolean; msg?: string }>('/api/windows/close', { wid: w.wid })
      log(`${where} close ${w.wid} => ${r?.ok ? 'ok' : (r?.msg ?? 'failed')}`)
      return
    }
    // Back to the server list: nothing to resume into, so it forgets rather than remembers.
    case 'disconnect':
      menuResume = null
      enterRoot('Disconnect in the menu')
      return
  }
}

/** Leave the app from the glasses: a double-tap at the server list (root.ts), and the only use of
 *  `shutDownPageContainer` in the client. That call exits the app; it is not page recovery and
 *  must never be reached from an error path (docs/glasses.md). `exitMode: 1` pops the
 *  foreground interaction layer and lets the user decide, so a stray selection is cancellable.
 *  It is not an escape hatch for a page that never established: there it answers `false`, and
 *  `exitMode: 0` answers `true` without the app closing. */
export async function exitApp(): Promise<void> {
  if (!bridge) {
    log('exit: no bridge')
    return
  }
  try {
    const ok = await withTimeout(Promise.resolve(bridge.shutDownPageContainer(1)), 8000, 'shutdown')
    log(`exit (shutDownPageContainer(1)) => ${String(ok)}`)
    // The system's dialog follows on the lens; the phone stands aside for it (exitCurtain.ts).
    if (ok) noteExitAsked()
  } catch (e) {
    log(`exit failed: ${errText(e)}`)
  }
}

/** Launch one scanned application. The one launch path: the glasses menu's `+ …` rows and the
 *  phone's apps list both come here. Only the id goes on the wire; the server resolves it to
 *  argv (including the terminal wrapper for a `Terminal=true` entry). */
export async function launchApp(
  id: string,
  label: string,
  btn?: HTMLButtonElement,
): Promise<boolean> {
  const restore = btn?.textContent ?? ''
  if (btn) {
    btn.textContent = `${label} — launching…`
    btn.disabled = true
  }
  toast(`launching ${label}…`)
  log(`launch ${id}`)
  const r = await apiPost<{ ok?: boolean; msg?: string; name?: string }>('/api/spawn', { id })
  const ok = r?.ok === true
  log(`launch ${id} => ${ok ? 'ok' : (r?.msg ?? 'no answer')}`)
  // The window itself arrives through the 1 Hz poll, so say that rather than implying the
  // mirror is already showing it.
  toast(ok ? `${label} started — watch the mirror` : `launch failed: ${r?.msg ?? 'no answer'}`)
  if (btn) {
    btn.disabled = false
    btn.textContent = restore
  }
  return ok
}

/** Act on one root-list item selected from the overlay. */
async function activateMenuItem(it: MenuItem): Promise<void> {
  // The hierarchy's entrance: the first row of the root list. (Disconnect lives inside the hierarchy
  // behind a confirm level, src/shared/glassMenu.ts.) The breadcrumb says `Menu` whatever the
  // row read, since `Menu/Prev/Next...` is the same level.
  if (it.kind === 'menu') {
    pushLevel(MENU_ROOT_ID, MENU_ROOT_LABEL)
    return
  }
  // A launcher row posts nothing but the id; no command string is constructed here.
  if (it.kind === 'app') {
    if (!it.appId) {
      log(`launch ${it.itemName} => no app id, refused`)
      return
    }
    // Strip the `+ ` the label carries for the glasses: the toast is a sentence, not a menu row.
    await launchApp(
      it.appId,
      it.itemName.startsWith(MENU_APP_PREFIX)
        ? it.itemName.slice(MENU_APP_PREFIX.length)
        : it.itemName,
    )
    return
  }
  if (!it.wid) {
    log(`select ${it.itemName} => no wid, refused`)
    return
  }
  await selectWindow(it.wid, it.itemName)
}

/** Switch to one window by wid. The one place that route is called from, so the glasses' root
 *  list and the phone's `task` palette cannot select by different keys. `wid` is stable for the
 *  window's lifetime; the window manager recycles its numbers, so a stale one would switch to
 *  the wrong window (docs/protocol.md). */
export async function selectWindow(wid: string, label: string): Promise<boolean> {
  const r = await apiPost<{ ok?: boolean; msg?: string }>('/api/windows', { wid })
  log(`select ${label} => ${r?.ok ? 'ok' : (r?.msg ?? 'failed')}`)
  return r?.ok === true
}
