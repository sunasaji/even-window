// pinhole-window — the OS-neutral half of window handling: the per-window identity cache, the
// focus-recency order, launch attribution, and thin pass-throughs to the backend
// (`platform.windows`), which is the only thing that talks to the window manager.

import type { WinInfo } from '../shared/types.ts'
import { appIdOfWindow, claimWindow, pruneClaims } from './launches.ts'
import { platform } from './platform/index.ts'
import type { WinIdent, WinSel } from './platform/types.ts'

export type { WinIdent, WinSel } from './platform/types.ts'

/** Pure: an identity string for a window set, used to suppress no-op `windows` SSE frames
 *  from the 1 Hz poll. Compares wid + title + active (docs/protocol.md). The backend's short
 *  handle (`WinInfo.id`) is excluded: a close may renumber survivors without the visible set
 *  changing. */
export function windowsKey(list: readonly WinInfo[]): string {
  return list.map(w => `${w.wid}\u0001${w.title}\u0001${w.active ? 1 : 0}`).join('\u0002')
}

// ── focus recency (the glasses menu's MRU order) ────────────────────────────────────────
//
// The glasses' window list is ordered most-recently-focused first. The order is kept here
// because the 1 Hz poll already observes focus (`WinInfo.active`), and so that it survives a
// WebView reload and is the same for every phone.
//
// It rides alongside the wire list as its own array of window ids; the list itself is never
// re-sorted, because `windowsKey` is computed in list order and would move on every focus
// change. Windows not focused since this server started sort last, in the backend's order.

/** Pure: fold one window-list observation into the recency order, most recent first.
 *  Dead window ids are dropped, the active window moves to the head, and windows never seen before
 *  land at the tail in list order — a window that opens without taking focus must not jump
 *  the queue. Idempotent, so every `listWindows()` call may fold. */
export function mruFold(prev: readonly string[], list: readonly WinInfo[]): string[] {
  const live = new Set<string>()
  for (const w of list) if (w.wid) live.add(w.wid)
  const out: string[] = []
  const seen = new Set<string>()
  const keep = (wid: string) => {
    if (!wid || seen.has(wid) || !live.has(wid)) return
    seen.add(wid)
    out.push(wid)
  }
  // The active window first, so it heads the order whether or not it was in `prev` at all.
  for (const w of list) if (w.active) keep(w.wid)
  for (const wid of prev) keep(wid)
  for (const w of list) keep(w.wid)
  return out
}

/** The focus-recency order, most recent first. Rebuilt by every `listWindows()` call. */
let winMru: string[] = []

/** The current recency order (window ids, most recent first). Only live windows appear. */
export function windowsMru(): string[] {
  return [...winMru]
}

// ── the per-window identity cache ───────────────────────────────────────────────────────
//
// Cached per wid: what cannot change while the window exists — the owning pid, its `comm` and
// its executable path. Filled on first sighting and dropped when the window goes, so identity
// costs one backend lookup per window lifetime. Per-app swipe bindings (docs/glasses.md)
// resolve at gesture time from the actual focus, which is affordable only as a cache hit.
//
// Negatives are cached too: a window that exposes no pid would otherwise be re-resolved on
// every poll. The cost is that a window which sets its properties late keeps an empty identity
// until it is closed.

const EMPTY_IDENT: WinIdent = { pid: 0, comm: '', exe: '' }

const identByWid = new Map<string, WinIdent>()

/** Drop cache entries for windows that no longer exist. Called from `listWindows`, which has
 *  the live list in hand anyway — so a recycled wid can never answer with a dead app. */
function pruneIdents(live: readonly WinInfo[]): void {
  if (identByWid.size === 0) return
  const alive = new Set(live.map(w => w.wid))
  for (const wid of identByWid.keys()) if (!alive.has(wid)) identByWid.delete(wid)
}

/** Has this window been identified before? Launch attribution needs the distinction: only a
 *  window the server has never seen can be the one a launch just produced. */
export function knownWindow(wid: string): boolean {
  return identByWid.has(wid)
}

/** The cached identity of `wid`, resolving it if this is the first sighting. */
export async function windowIdent(wid: string): Promise<WinIdent> {
  if (!wid) return EMPTY_IDENT
  const hit = identByWid.get(wid)
  if (hit) return hit
  const id = await platform.windows.identify(wid)
  identByWid.set(wid, id)
  return id
}

/** The window that has input focus right now, with its identity. Asks the backend instead of
 *  reading the 1 Hz window cache: a key is injected into whatever holds focus at this instant,
 *  so a list up to a second old would send the previous app's key on the first swipe after a
 *  window switch. `wid` is '' when the backend cannot say; the caller then uses the default
 *  binding. */
export async function focusedApp(): Promise<{ wid: string } & WinIdent> {
  const wid = await platform.windows.focusedId()
  if (!wid) return { wid: '', ...EMPTY_IDENT }
  return { wid, ...(await windowIdent(wid)) }
}

/** List the managed windows, each carrying whatever identity it admits. Identity is resolved
 *  once per window lifetime, so an idle desktop costs one enumeration per poll. */
export async function listWindows(): Promise<WinInfo[]> {
  const list = await platform.windows.enumerate()
  pruneIdents(list)
  pruneClaims(list.map(w => w.wid))
  // The recency order is folded here because every caller that wants a live list comes
  // through this function (the backend's own selector resolution enumerates for itself, side-
  // effect free). A switch is picked up by the `pollWindows()` the route fires after it.
  winMru = mruFold(winMru, list)
  for (const w of list) {
    // Fresh means "first sighting", and it is load-bearing: offering every unclaimed window
    // would let a pending launch be taken by an already-open copy of the same program.
    const fresh = !knownWindow(w.wid)
    const id = await windowIdent(w.wid)
    if (id.comm) w.app = id.comm
    if (id.exe) w.exe = id.exe
    // Attribution is offered here because this is the one place that sees a window for the
    // first time with its pid in hand.
    const appId = fresh ? claimWindow(w.wid, id.pid) : appIdOfWindow(w.wid)
    if (appId) w.appId = appId
  }
  return list
}

/** Switch to a window (`POST /api/windows`). The backend resolves the selector. */
export function selectWindow(sel: WinSel): Promise<boolean> {
  return platform.windows.select(sel)
}

/** Close a window gracefully (`POST /api/windows/close`). No selector: the current window. */
export function closeWindow(sel?: WinSel): Promise<boolean> {
  return platform.windows.close(sel)
}

/** Start a program on the mirrored desktop. Returns the child's pid, or 0 on failure. */
export function spawnApp(cmd: string, args: readonly string[] = []): number {
  return platform.windows.spawn(cmd, args)
}
