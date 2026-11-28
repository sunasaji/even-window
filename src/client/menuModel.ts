// pinhole-window — the window switcher's root list as data: items, MRU order, signature (pure).
//
// A leaf: it imports no other client module, so anything may use it at load time.

import {
  fitUnits,
  LEVEL_MAX_ROWS,
  MENU_ROOT_LABEL,
  MENU_ROOT_PAGED_LABEL,
  ROW_LABEL_UNITS,
} from '../shared/glassMenu.ts'
import type { WinInfo } from '../shared/types.ts'
import { glassWidth, plainText } from '../shared/voiceDialog.ts'

// ── window switcher ────────────────────────────────────────────────────────────────────────
//
// The root list — `Menu...`, then windows, then the curated launcher rows — is drawn by the
// client into container 6 with `textContainerUpgrade` (a differential push, never a rebuild)
// and opened by a double-tap. Everything below it is the hierarchy in src/shared/glassMenu.ts.
// The firmware's `menuObject` is not used: it is one flat level of one-shot items, and this
// menu has levels and a list that changes (docs/decisions/client-drawn-glasses-menu.md).

/** Reserved `itemID` for the root's first row, `Menu...`. Fixed rather than positional so it
 *  never collides with a window item and never moves when the window set changes. Window items
 *  start at 2. */
export const MENU_ENTRY_ID = 1

/** Rows under the root list's header: the same budget a level has. */
export const ROOT_MAX_ROWS = LEVEL_MAX_ROWS
/** Windows and apps on each page: every row but `Menu...`. Pages are turned from inside the
 *  `Menu...` level (`Prev Page` / `Next Page`), so a page spends no row on it. */
export const ROOT_PAGE_SIZE = ROOT_MAX_ROWS - 1

// ── the curated launcher slots ─────────────────────────────────────────────────────────────
//
// The root list carries a short set: the most recently launched apps, kept server-side
// (src/server/appRecency.ts), as many as the server keeps. MRU needs no write route and no
// empty state (it is seeded with the default client), at the cost that it cannot be pinned.
// Every other application is under `Menu... > Launch...` (src/shared/glassMenu.ts).
//
// Windows come first and the apps follow them (`rootPages`). Both count towards the pages, so
// an app row is never dropped for space: it moves to the next page instead.
export const MENU_MAX_APPS = 8

/** Prefix that distinguishes "launch this" from "switch to this" in the root list: the label is
 *  the only styling a row has. It comes out of the row's width budget. */
export const MENU_APP_PREFIX = '+ '

/** The mark the overlay puts before the focused window's label. Its width comes out of a
 *  window row's budget, so the row is as wide focused as not. */
export const ACTIVE_MARK = '*'

// ── what a window row says ─────────────────────────────────────────────────────────────────
//
// A title alone can say very little: a terminal's is often just `~`. So a short title is
// followed by the application in brackets, `~ (XTerm)`.
//
// Both halves are plain `WinInfo` fields, filled by the backend for whatever the OS calls
// them (docs/platform.md); nothing here knows which OS that is. The phone's `task` palette
// shows the same name in its dim column.

/** The application a window belongs to, as the user would name it: the class it declares, else
 *  its process name. '' when the backend resolved neither. */
export function windowAppName(w: WinInfo): string {
  return w.cls || w.app || ''
}

/** Pure: a window's row label, at most `units` wide. The title, then the application in
 *  brackets when the whole of it fits and the title does not already name it; a long title is
 *  cut and stands alone, since the room is better spent on it. */
export function windowLabel(w: WinInfo, units: number): string {
  const name = plainText(windowAppName(w))
  const title = plainText(w.title).trim()
  if (!title) return fitUnits(name || w.wid, units)
  if (name && !title.toLowerCase().includes(name.toLowerCase())) {
    const both = `${title} (${name})`
    if (glassWidth(both) <= units) return both
  }
  return fitUnits(title, units)
}

// Select by `wid`, never by the window-manager number: the server's window-set comparison
// excludes that number, so a renumber emits no `{t:'windows'}` event and a cached number would
// go stale silently. `wid` is stable for the window's lifetime, so `WinInfo.id` is never
// retained here.
export interface MenuItem {
  /** Non-zero and unique within a built list. */
  itemID: number
  /** At most `ROW_LABEL_UNITS` wide, less the active marker. Never carries that marker: the overlay adds its own at render
   *  time, from `active`, which keeps focus out of `menuSignature`. */
  itemName: string
  /** `window` = switch to `wid`; `app` = launch `appId`; `menu` = descend into the hierarchy
   *  (Disconnect and the page turns live inside it — they are not root rows). */
  kind: 'window' | 'app' | 'menu'
  /** X window id, the only selector ever posted. `null` (not `''`) for anything that is not a
   *  window. */
  wid: string | null
  /** `LauncherEntry.id` for a launcher row, `null` otherwise. The id is the whole request: the
   *  server owns the argv, so nothing on the glasses can name a command. */
  appId: string | null
  /** Is this the focused window? Presentation only (the overlay's `*`), and deliberately
   *  absent from `menuSignature`. */
  active: boolean
}

/** One curated launcher row. Only an id and a label reach the glasses. */
export interface MenuApp {
  id: string
  name: string
}

/** Build the root list's items: every window, then the curated launcher rows, then `Menu...`.
 *  Nothing is dropped for space here; `rootPages` lays the list out on the panel, and puts
 *  `Menu...` first: it is used more than a window switch, and the cursor opens on it.
 *
 *  ids are allocated sequentially from 2 and never reused within a list. They identify a row
 *  for the debug surface (`ewMenu.items`) and `mruOrderItems`; the drawn order is `rootRows`. */
export function buildMenuItems(
  list: readonly WinInfo[],
  apps: readonly MenuApp[] = [],
): MenuItem[] {
  const out: MenuItem[] = []
  for (const w of list) {
    // No wid → not selectable by the stable key, so it must not become a menu entry at all.
    if (!w.wid) continue
    out.push({
      // +2: id 1 is reserved for the entry row, so these run from 2 and stay unique.
      itemID: out.length + 2,
      itemName: windowLabel(w, ROW_LABEL_UNITS - glassWidth(ACTIVE_MARK)),
      kind: 'window',
      wid: w.wid,
      appId: null,
      active: w.active,
    })
  }
  for (const a of apps.slice(0, MENU_MAX_APPS)) {
    if (!a.id) continue
    out.push({
      itemID: out.length + 2,
      itemName: fitUnits(MENU_APP_PREFIX + (a.name || a.id), ROW_LABEL_UNITS),
      kind: 'app',
      wid: null,
      appId: a.id,
      active: false,
    })
  }
  out.push({
    itemID: MENU_ENTRY_ID,
    itemName: MENU_ROOT_LABEL,
    kind: 'menu',
    wid: null,
    appId: null,
    active: false,
  })
  return out
}

// ── MRU: which rows are nearest the hand ───────────────────────────────────────────────────
//
// The root list's window rows are drawn in focus-recency order (`{t:'windows'}.recent`, kept by
// the server) rather than window-number order, so the previous window is the row next to the
// current one.
//
// This is a display order and nothing else: `buildMenuItems` still allocates `itemID`s in the
// server's order, so `menuSignature` does not move when focus does.
//
// The order is frozen while the menu is open (`menuRootOrder` in menu.ts): focus can move from
// outside this app, and a list that re-sorted under the cursor would hand the next tap to a
// different window.

/** `wid → position` from a recency list (index 0 = most recent). A duplicate keeps its first
 *  position. A missing list is an empty map (the identity ordering), never a throw: this is
 *  reached from the double-tap handler. */
function mruRank(recent: readonly string[] | undefined): Map<string, number> {
  const rank = new Map<string, number>()
  ;(recent ?? []).forEach((wid, i) => {
    if (!rank.has(wid)) rank.set(wid, i)
  })
  return rank
}

/** Pure: the window list in MRU order, for the phone's `task` palette. Not `mruOrderItems` over
 *  `buildMenuItems`: that path cuts labels to the panel's width, which is a property of the lens. Windows with no wid are dropped (no stable key to select by).
 *  Unranked windows sort after every ranked one, keeping their relative order. */
export function mruOrderWindows(
  list: readonly WinInfo[],
  recent: readonly string[] | undefined,
): WinInfo[] {
  const rank = mruRank(recent)
  return list
    .filter(w => w.wid)
    .map((w, i) => ({ w, i, r: rank.get(w.wid ?? '') ?? rank.size }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.w)
}

/** Pure: the items re-ordered for display — window rows by `recent` (an wid order, most recent
 *  first), everything else untouched at the tail. A window whose wid is not in `recent` sorts
 *  after every window that is, keeping its relative position. */
export function mruOrderItems(
  items: readonly MenuItem[],
  recent: readonly string[] | undefined,
): MenuItem[] {
  const rank = mruRank(recent)
  const wins: { it: MenuItem; r: number; i: number }[] = []
  const rest: MenuItem[] = []
  items.forEach((it, i) => {
    if (it.kind === 'window') wins.push({ it, i, r: rank.get(it.wid ?? '') ?? rank.size })
    else rest.push(it)
  })
  // Stable: ties (two unranked windows) keep the order they arrived in. `Array.sort` is
  // stable per spec, but the index tiebreak says so at the point it matters.
  wins.sort((a, b) => a.r - b.r || a.i - b.i)
  return [...wins.map(w => w.it), ...rest]
}

// ── pages: the root list on a ten-line panel ───────────────────────────────────────────────
//
// The panel shows a header and nine rows. Every page opens with `Menu...` and holds up to
// eight windows and apps under it. With several pages the row reads `Menu/Prev/Next...`: the
// page turns are the last two rows of the level it enters, so a page spends no row on them,
// and the way into the hierarchy (and from there to Disconnect) is on every page.
//
// Windows and apps are paged together, windows first: apps are never dropped for lack of
// room, they go onto a further page. At most `MENU_MAX_APPS` of them (`buildMenuItems`).

/** Pure: lay the display-ordered items (`mruOrderItems`) out as pages. Always at least one
 *  page, and every page starts with the `Menu...` row when the list has one. */
export function rootPages(ordered: readonly MenuItem[]): MenuItem[][] {
  const rows = [
    ...ordered.filter(it => it.kind === 'window'),
    ...ordered.filter(it => it.kind === 'app'),
  ]
  const head = ordered.filter(it => it.kind === 'menu')
  const pages: MenuItem[][] = []
  for (let i = 0; i === 0 || i < rows.length; i += ROOT_PAGE_SIZE) {
    pages.push(rows.slice(i, i + ROOT_PAGE_SIZE))
  }
  const label = pages.length > 1 ? MENU_ROOT_PAGED_LABEL : MENU_ROOT_LABEL
  return pages.map(p => [...head.map(it => ({ ...it, itemName: label })), ...p])
}

/** Stable signature of the item list, so a real change can be told from a restatement; it
 *  gates the log line in `rebuildMenu`. `active` is excluded: focus changes are the most
 *  frequent window event and do not change the list. */
export function menuSignature(items: readonly MenuItem[]): string {
  return items
    .map(it => `${it.itemID}:${it.kind}:${it.wid ?? ''}:${it.appId ?? ''}:${it.itemName}`)
    .join('|')
}
