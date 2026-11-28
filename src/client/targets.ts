// pinhole-window — the servers this device can open, and whether it is at the list of them.
//
// The app starts at the list (the root): nothing is mirrored until a server is opened, even
// when there is only one. That makes the list the top of the app, where a double-tap leaves it,
// and keeps every gesture inside a server meaning what it always did
// (docs/decisions/root-is-the-server-list.md). No DOM and no network here.

import { fitUnits, ROW_LABEL_UNITS } from '../shared/glassMenu.ts'
import { keep } from './durableKv.ts'

/** Where the list is kept: localStorage, mirrored to the bridge's durable store (durableKv.ts). */
export const TARGETS_KEY = 'pw.targets'
/** Rows of the lens under its header. A longer list is shown a page at a time: the page is
 *  the one the cursor is on, so swiping past the last row of a page turns it. */
export const ROOT_PAGE_ROWS = 9

/** One server this device can open. `name` is what the person calls it; without one the row
 *  shows the origin. */
export interface Target {
  server: string
  name?: string
}

/** The longest name kept. It has to fit a row of the lens with the cursor in front of it. */
export const NAME_MAX = 24

/** Pure: a name as it is stored: trimmed, one line, at most `NAME_MAX` characters. */
export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX)
}

/** Pure: the stored JSON as a list of `{server, name?}`. Anything malformed is dropped. */
export function parseTargets(raw: string | null): Target[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: Target[] = []
  for (const x of v) {
    if (x && typeof x === 'object') {
      const o = x as { server?: unknown; name?: unknown }
      if (typeof o.server !== 'string' || o.server === '') continue
      const name = typeof o.name === 'string' ? cleanName(o.name) : ''
      out.push(name ? { server: o.server, name } : { server: o.server })
    }
  }
  return out
}

/** Pure: the list with `server` in it, at the end. An address already listed stays where it
 *  is, with its name. The list has no limit: the lens pages it and the phone scrolls it. */
export function withTarget(list: readonly Target[], server: string): Target[] {
  if (!server || list.some(t => t.server === server)) return [...list]
  return [...list, { server }]
}

/** Pure: the list without `server`. */
export function withoutTarget(list: readonly Target[], server: string): Target[] {
  return list.filter(t => t.server !== server)
}

/** Pure: the list with `server` named `name`; an empty name removes the name. */
export function withName(list: readonly Target[], server: string, name: string): Target[] {
  const n = cleanName(name)
  return list.map(t => (t.server !== server ? t : n ? { server, name: n } : { server }))
}

/** Pure: a server's origin as shown: scheme included, because `http` and `https` on one host
 *  are two different servers to this client. */
export function originLabel(server: string): string {
  return server.replace(/\/$/, '')
}

/** Pure: how a server is named in one word: its name, or its origin when it has none. */
export function targetLabel(t: Target): string {
  return t.name || originLabel(t.server)
}

/** Pure: a row of the lens: the name with the address in brackets after it, or the address
 *  alone. The panel is wide enough for both in the usual case, and the name comes first so that
 *  what is cut off, when something is, is the end of the address. */
export function lensLabel(t: Target): string {
  const origin = originLabel(t.server)
  return t.name ? `${t.name} (${origin})` : origin
}

/** Pure: how many pages a list of `n` takes on the lens (at least one). */
export function rootPages(n: number): number {
  return Math.max(1, Math.ceil(n / ROOT_PAGE_ROWS))
}

/** Pure: the page the cursor is on. */
export function rootPageOf(sel: number, n: number): number {
  if (n <= 0) return 0
  return Math.floor(Math.max(0, Math.min(n - 1, sel)) / ROOT_PAGE_ROWS)
}

/** Pure: the lens text of the list: the page the cursor is on. A label wider than a line is cut, since the firmware would
 *  fold it and push the last rows off the panel. */
export function rootText(list: readonly Target[], sel: number, name = 'PinholeWindow'): string {
  if (list.length === 0)
    return [
      `${name} — add a server`,
      'On the phone, in this app:',
      '- paired before: enter the server URL',
      '- first time, on the PC:',
      '    node scripts/pw-auth.mjs pair URL',
      '    scan its QR code, tap Copy, paste here',
      '',
      'double-tap: exit',
    ].join('\n')
  const pages = rootPages(list.length)
  const page = rootPageOf(sel, list.length)
  const from = page * ROOT_PAGE_ROWS
  const rows = list
    .slice(from, from + ROOT_PAGE_ROWS)
    .map((t, k) => `${from + k === sel ? '>' : ' '} ${fitUnits(lensLabel(t), ROW_LABEL_UNITS)}`)
  // The page number appears only when there is more than one page, as in the Tasks list.
  const at = pages > 1 ? ` ${String(page + 1)}/${String(pages)}` : ''
  return [`${name}${at}  (tap=open  dbl=exit)`, ...rows].join('\n')
}

let targets: Target[] = []

export function targetList(): readonly Target[] {
  return targets
}

/** Where `server` is in the list, or -1. */
export function targetIndex(server: string): number {
  return targets.findIndex(t => t.server === server)
}

/** Read the stored list. Called at boot, and again once the durable store has restored
 *  localStorage. */
export function loadTargets(): void {
  try {
    targets = parseTargets(localStorage.getItem(TARGETS_KEY))
  } catch {
    /* storage blocked: the list lives for this page load only */
  }
}

function store(next: Target[]): void {
  targets = next
  keep(TARGETS_KEY, JSON.stringify(next))
}

/** True when the list changed. */
export function addTarget(server: string): boolean {
  const next = withTarget(targets, server)
  if (next.length === targets.length) return false
  store(next)
  return true
}

/** Name a server, or clear its name with an empty string. */
export function renameTarget(server: string, name: string): void {
  store(withName(targets, server, name))
}

export function removeTarget(server: string): void {
  store(withoutTarget(targets, server))
  if (rootSel >= targets.length) rootSel = Math.max(0, targets.length - 1)
}

/** True while the app is at the list and no server is open. */
export let rootOpen = false
export function setRootOpen(v: boolean): void {
  rootOpen = v
}

/** The cursor in the list. */
export let rootSel = 0
export function setRootSel(i: number): void {
  rootSel = targets.length ? Math.max(0, Math.min(targets.length - 1, i)) : 0
}

/** Move the cursor, wrapping at both ends like the menu does. */
export function moveRoot(dir: -1 | 1): void {
  const n = targets.length
  if (n > 0) rootSel = (rootSel + dir + n) % n
}

/** How a server is called wherever one line names it: its name if it has one, else its origin. */
export function serverLabel(server: string): string {
  const t = targets.find(x => x.server === server)
  return t ? targetLabel(t) : originLabel(server)
}
