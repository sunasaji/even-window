// even-window — the window switcher's root list as data: items, MRU order, signature (pure).
//
// A leaf: it imports no other client module, so anything may use it at load time.

import { MENU_ITEM_MAX_BYTES, MENU_MAX_ITEMS, MENU_ROOT_LABEL } from '../shared/glassMenu.ts'
import type { WinInfo } from '../shared/types.ts'

// ── window switcher ────────────────────────────────────────────────────────────────────────
//
// The root list — windows, then the curated launcher rows, then `Menu...` — is drawn by the
// client into container 6 with `textContainerUpgrade` (a differential push, never a rebuild)
// and opened by a double-tap. Everything below it is the hierarchy in src/shared/glassMenu.ts.
// The firmware's `menuObject` is not used: a page may carry a z plan or that menu, never both
// (docs/decisions/client-drawn-glasses-menu.md).

// The two item limits live in src/shared/glassMenu.ts, where the hierarchy is built.
// Re-exported so the menu tests can assert the client has no copy of its own.
export { MENU_ITEM_MAX_BYTES, MENU_MAX_ITEMS }

/** Reserved `itemID` for the root's last row, `Menu...`. Fixed rather than positional so it
 *  never collides with a window item and never moves when the window set changes. Window items
 *  start at 2. */
export const MENU_ENTRY_ID = 1

/** Windows and apps share this many slots: one of the ten is always the `Menu...` row. */
export const MENU_MAX_WINDOWS = MENU_MAX_ITEMS - 1

// ── the curated launcher slots ─────────────────────────────────────────────────────────────
//
// The full application list lives on the phone; the glasses get a short set: the most recently
// launched apps, kept server-side (src/server/appRecency.ts). MRU needs no write route and no
// empty state (it is seeded with the default client), at the cost that it cannot be pinned.
//
// Windows come first and apps take only the slack: `appSlots = min(MENU_MAX_APPS, 9 - windows)`.
// The menu is the only way to reach a window from the glasses, while every app stays reachable
// on the phone.
export const MENU_MAX_APPS = 3

/** Prefix that distinguishes "launch this" from "switch to this" in the root list: the label is
 *  the only styling a row has. Two characters out of the 32-byte budget. */
export const MENU_APP_PREFIX = '+ '

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a character. `for..of` iterates
 *  code points, so neither a surrogate pair nor a multi-byte sequence is cut in half. */
export function truncateUtf8(s: string, maxBytes = MENU_ITEM_MAX_BYTES): string {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= maxBytes) return s
  let used = 0
  let out = ''
  for (const ch of s) {
    const n = enc.encode(ch).length
    if (used + n > maxBytes) break
    used += n
    out += ch
  }
  return out
}

// Select by `wid`, never by the window-manager number: the server's window-set comparison
// excludes that number, so a renumber emits no `{t:'windows'}` event and a cached number would
// go stale silently. `wid` is stable for the window's lifetime, so `WinInfo.id` is never
// retained here.
export interface MenuItem {
  /** Non-zero and unique within a list. */
  itemID: number
  /** <= 32 UTF-8 bytes. Never carries the active marker: the overlay adds its own at render
   *  time, from `active`, which keeps focus out of `menuSignature`. */
  itemName: string
  /** `window` = switch to `wid`; `app` = launch `appId`; `menu` = descend into the hierarchy
   *  (Exit lives inside it, behind a confirm level — it is not a root row). */
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

/** How many of the nine shared slots the launcher gets, given the window count. Windows have
 *  priority; see the MENU_MAX_APPS note. */
export function menuAppSlots(windowCount: number): number {
  return Math.max(0, Math.min(MENU_MAX_APPS, MENU_MAX_WINDOWS - windowCount))
}

/** Build the root list: the windows, then the curated launcher rows, then `Menu...`.
 *
 *  The entry row is last in display order but holds the fixed id 1. Last rather than first
 *  because the cursor opens on a window and the list wraps, so one swipe-up reaches it.
 *
 *  ids are allocated sequentially from 2 and never reused within a list. They identify a row
 *  for the debug surface (`ewMenu.items`) and `mruOrderItems`; the drawn order is `rootRows`. */
export function buildMenuItems(
  list: readonly WinInfo[],
  apps: readonly MenuApp[] = [],
): MenuItem[] {
  const out: MenuItem[] = []
  for (let i = 0; i < list.length && out.length < MENU_MAX_WINDOWS; i++) {
    const w = list[i]
    if (!w) continue
    // No wid → not selectable by the stable key, so it must not become a menu entry at all.
    if (!w.wid) continue
    const label = w.title || w.cls || w.app || w.wid
    out.push({
      // +2: id 1 is reserved for the entry row, so these run 2..10 and stay unique.
      itemID: out.length + 2,
      itemName: truncateUtf8(label),
      kind: 'window',
      wid: w.wid,
      appId: null,
      active: w.active,
    })
  }
  const slots = menuAppSlots(out.length)
  for (const a of apps.slice(0, slots)) {
    if (!a.id) continue
    out.push({
      itemID: out.length + 2,
      itemName: truncateUtf8(MENU_APP_PREFIX + (a.name || a.id)),
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
 *  `buildMenuItems`: that path truncates to `MENU_MAX_WINDOWS` and 32-byte labels, which are
 *  properties of the lens. Windows with no wid are dropped (no stable key to select by).
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

/** Stable signature of the item list, so a real change can be told from a restatement; it
 *  gates the log line in `rebuildMenu`. `active` is excluded: focus changes are the most
 *  frequent window event and do not change the list. */
export function menuSignature(items: readonly MenuItem[]): string {
  return items
    .map(it => `${it.itemID}:${it.kind}:${it.wid ?? ''}:${it.appId ?? ''}:${it.itemName}`)
    .join('|')
}
