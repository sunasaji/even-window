// pinhole-window — the servers this device can open, and whether it is at the list of them.
//
// The app starts at the list (the root): nothing is mirrored until a server is opened, even
// when there is only one. That makes the list the top of the app, where a double-tap leaves it,
// and keeps every gesture inside a server meaning what it always did
// (docs/decisions/root-is-the-server-list.md). No DOM and no network here.

import { keep } from './durableKv.ts'

/** Where the list is kept: localStorage, mirrored to the bridge's durable store (durableKv.ts). */
export const TARGETS_KEY = 'ew.targets'
/** The header and nine rows fill the panel, so the list has no pages. */
export const TARGETS_MAX = 9

/** Pure: the stored JSON as a list of server origins; anything malformed is an empty list. */
export function parseTargets(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, TARGETS_MAX)
  } catch {
    return []
  }
}

/** The longest label a row shows whole. A tailnet origin with its scheme and port is about 40
 *  characters; anything longer is cut so the firmware does not fold the row. */
const ROW_CHARS = 46

/** Pure: the list with `server` in it. An address already listed stays where it is; a full
 *  list drops its oldest entry. */
export function withTarget(list: readonly string[], server: string): string[] {
  if (!server || list.includes(server)) return [...list]
  return [...list, server].slice(-TARGETS_MAX)
}

/** Pure: the list without `server`. */
export function withoutTarget(list: readonly string[], server: string): string[] {
  return list.filter(s => s !== server)
}

/** Pure: how a server is named in a row: its origin, scheme included, because `http` and
 *  `https` on one host are two different servers to this client. */
export function targetLabel(server: string): string {
  return server.replace(/\/$/, '')
}

/** Pure: the lens text of the list. A label wider than a line is cut, since the firmware would
 *  fold it and push the last rows off the panel. */
export function rootText(list: readonly string[], sel: number, name = 'PinholeWindow'): string {
  if (list.length === 0)
    return [
      `${name} — add a server`,
      'On the phone, in this app:',
      '- paired before: enter the server URL',
      '- first time, on the PC:',
      '    node scripts/ew-auth.mjs pair URL',
      '    scan its QR code, tap Copy, paste here',
      '',
      'double-tap: exit',
    ].join('\n')
  const rows = list.map((s, i) => {
    const label = targetLabel(s)
    return `${i === sel ? '>' : ' '} ${label.length > ROW_CHARS ? `${label.slice(0, ROW_CHARS - 1)}…` : label}`
  })
  return [`${name}  (tap=open  dbl=exit)`, ...rows].join('\n')
}

let targets: string[] = []

export function targetList(): readonly string[] {
  return targets
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

function store(next: string[]): void {
  targets = next
  keep(TARGETS_KEY, JSON.stringify(next))
}

/** True when the list changed. */
export function addTarget(server: string): boolean {
  const next = withTarget(targets, server)
  if (next.length === targets.length && next.every((s, i) => s === targets[i])) return false
  store(next)
  return true
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
