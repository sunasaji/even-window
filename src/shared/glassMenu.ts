// The hierarchical glasses menu: every level below the root list, as pure data.
//
// Here: the levels, their rows and tokens, paging, the row budget, the gesture→action rule,
// the window-manager key catalogue and the token parser. Not here: the root list (windows,
// apps and `Menu...`), built by `buildMenuItems` in src/client/menuModel.ts, and the path
// stack, which is client state. The client draws every level into the overlay container
// (docs/decisions/client-drawn-glasses-menu.md).
//
// Labels are ASCII only: the firmware font's coverage is unknown, and a label rendered as
// tofu is indistinguishable from a broken menu. Toggle markers are part of the label.

import type { Mod } from './keys.ts'
import { isBindableKey, KEYS, MODS } from './keys.ts'

// ── the root list's label limit ────────────────────────────────────────────────────────────
// Defined once here; src/client/menuModel.ts re-exports it.
/** A root-list label is cut to this many UTF-8 bytes, which keeps it on one line. */
export const MENU_ITEM_MAX_BYTES = 32

// ── the row budget ─────────────────────────────────────────────────────────────────────────
//
// The panel shows ten full text lines (an eleventh is clipped at the bottom edge), which a
// level spends as 1 header + 8 content rows + 1 `< Back`. Counted off the simulator's
// framebuffer and confirmed on a G2. The root list spends the same nine rows under its own
// header (`rootPages` in src/client/menuModel.ts).
export const LEVEL_MAX_ROWS = 9
/** Rows a level may fill with content: the budget minus the `< Back` row every level carries. */
export const LEVEL_MAX_CONTENT = LEVEL_MAX_ROWS - 1

/** The `< Back` row's label. ASCII `<`, per the ASCII-only rule. */
export const BACK_LABEL = '< Back'
/** The token every level's ascend row carries. */
export const BACK_TOKEN = 'back'

/** Suffix marking a row that descends rather than acts. Three dots, not `…`: ASCII only. */
const SUB = '...'

export interface MenuRow {
  /** ASCII, <= 32 UTF-8 bytes. Carries its own marker for a toggle (`[x]` / `[ ]`). */
  label: string
  /** What the row does. Parse with `parseToken`, never with a bare `startsWith`. */
  token: string
}

/** The live state every level is a pure function of. */
export interface MenuState {
  /** Sticky modifiers currently armed, applied to the next key and then cleared by the client. */
  mods: readonly Mod[]
  /** The polarity toggle's current value, so `Invert` can show `[x]` / `[ ]`. */
  invert: boolean
  /** Is there a focused window? Rows that act on one (`Close Window`, `Kill`) are omitted
   *  when there is not. */
  hasWindow: boolean
}

// ── gestures while a level is open ─────────────────────────────────────────────────────────
// A double-tap ascends while nested and closes at the top level.

export type MenuGesture = 'tap' | 'swipe-up' | 'swipe-down' | 'double'
export type MenuAction = 'enter' | 'up' | 'down' | 'ascend' | 'close'

/** What a gesture does while the hierarchical menu is up. `depth` = the path stack's length
 *  (1 = the top level). */
export function menuActionFor(g: MenuGesture, depth: number): MenuAction {
  switch (g) {
    case 'tap':
      return 'enter'
    case 'swipe-up':
      return 'up'
    case 'swipe-down':
      return 'down'
    case 'double':
      return depth > 1 ? 'ascend' : 'close'
  }
}

// ── paging ─────────────────────────────────────────────────────────────────────────────────

/** Split `list` into the fewest pages of at most `size`, balanced so the last page is never
 *  a runt (10 items at size 9 → 5+5). Pure; `size <= 0` yields one page. */
export function balancedChunk<T>(list: readonly T[], size: number): T[][] {
  if (list.length === 0) return []
  if (size <= 0 || list.length <= size) return [[...list]]
  const pages = Math.ceil(list.length / size)
  const per = Math.ceil(list.length / pages)
  const out: T[][] = []
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per))
  return out
}

/** A page row's complete label: every entry it holds, space-separated (the panel font is
 *  proportional), not a range. It carries no `...` marker: on the punctuation page the dots
 *  would read as selectable characters. */
export function pageLabel(labels: readonly string[]): string {
  return labels.length === 0 ? '?' : labels.join(' ')
}

// ── the ratpoison key catalogue (closed set) ───────────────────────────────────────────────
//
// Each row sends the ratpoison prefix followed by one key. The set is closed and validated
// server-side: the client names a key, never a command. It holds what the glasses cannot
// reach another way (window switching, launching and graceful close have their own paths).
// Keys that need free-form typing, frame operations and diagnostics are left out.

/** The level's label on both surfaces. The label names the job; the code (`rp:` tokens,
 *  `RP_KEYS`, `POST /api/wm/key`) names the window manager. Singular: the phone's `task`
 *  palette lists windows, this level acts on the focused one. */
export const RP_LEVEL_LABEL = 'Window' + SUB

export interface RatpoisonKey {
  /** The keysequence sent after the prefix, in xdotool spelling (`question`, `K`, `ctrl+t`). */
  key: string
  /** ASCII, <= 32 bytes. */
  label: string
  /** True when picking it must pass through a confirmation level. */
  destructive?: true
}

/** The ratpoison prefix (the generated rc keeps the default), sent ahead of the chosen key. */
export const RP_PREFIX = 'ctrl+t'

export const RP_KEYS: readonly RatpoisonKey[] = [
  { key: 'question', label: 'Help (keys)' },
  { key: 'ctrl+t', label: 'Other (last win)' }, // C-t C-t = `other`
  { key: 'n', label: 'Next window' },
  { key: 'p', label: 'Prev window' },
  // No `w` (the WM's own window list): the root list already names and switches windows, and
  // the row budget is eight.
  { key: 'c', label: 'New terminal' }, // the rc rebinds `c` to the default terminal client
  { key: 'l', label: 'Redisplay' },
  { key: 'b', label: 'Banish pointer' },
  { key: 'K', label: 'Kill (force)', destructive: true },
]

const RP_BY_KEY: ReadonlyMap<string, RatpoisonKey> = new Map(RP_KEYS.map(k => [k.key, k]))

/** The gate, mirroring `isBindableKey`: the server calls this before injecting, so a key
 *  outside the catalogue cannot reach the WM. */
export function isRatpoisonKey(key: unknown): key is string {
  return typeof key === 'string' && RP_BY_KEY.has(key)
}

/** The xdotool `key` arguments for one catalogue entry: the prefix, then the key, as two
 *  arguments of one invocation. Two spawns would race through ratpoison's prefix grab. */
export function ratpoisonArgs(key: string): string[] | null {
  return isRatpoisonKey(key) ? [RP_PREFIX, key] : null
}

// ── pointer actions ────────────────────────────────────────────────────────────────────────

export type ClickAction = 'click' | 'dblclick' | 'hold' | 'release' | 'wheelup' | 'wheeldown'

/** A pointer row → the `POST /api/desktop/input` body. Pure. Buttons 4/5 are the wheel. Every
 *  action lands at the current pointer position. */
export function clickInput(a: ClickAction): { kind: string; arg: string } {
  switch (a) {
    case 'click':
      return { kind: 'click', arg: '1' }
    case 'dblclick':
      return { kind: 'dblclick', arg: '1' }
    case 'hold':
      return { kind: 'down', arg: '1' }
    case 'release':
      return { kind: 'up', arg: '1' }
    case 'wheelup':
      return { kind: 'click', arg: '4' }
    case 'wheeldown':
      return { kind: 'click', arg: '5' }
  }
}

const CLICK_ROWS: readonly { a: ClickAction; label: string }[] = [
  { a: 'click', label: 'Click' },
  { a: 'dblclick', label: 'Double-click' },
  { a: 'hold', label: 'Click-hold' },
  { a: 'release', label: 'Click-release' },
  { a: 'wheelup', label: 'Wheel up' },
  { a: 'wheeldown', label: 'Wheel down' },
]

// ── tokens ─────────────────────────────────────────────────────────────────────────────────

export type MenuToken =
  | { kind: 'sub'; id: string }
  | { kind: 'back' }
  | { kind: 'key'; key: string }
  | { kind: 'mod'; mod: Mod }
  | { kind: 'click'; action: ClickAction }
  | { kind: 'rp'; key: string }
  | { kind: 'close' }
  | { kind: 'exit' }
  | { kind: 'invert' }

/** Parse a row's token. `null` for anything unrecognised, which the caller must log and drop. */
export function parseToken(token: string): MenuToken | null {
  if (token === BACK_TOKEN) return { kind: 'back' }
  if (token === 'close') return { kind: 'close' }
  if (token === 'exit') return { kind: 'exit' }
  if (token === 'invert') return { kind: 'invert' }
  const i = token.indexOf(':')
  if (i <= 0) return null
  const head = token.slice(0, i)
  const arg = token.slice(i + 1)
  if (!arg) return null
  if (head === 'sub') return { kind: 'sub', id: arg }
  if (head === 'key') return isBindableKey(arg) ? { kind: 'key', key: arg } : null
  if (head === 'rp') return isRatpoisonKey(arg) ? { kind: 'rp', key: arg } : null
  if (head === 'mod')
    return (MODS as readonly string[]).includes(arg) ? { kind: 'mod', mod: arg as Mod } : null
  if (head === 'click') {
    return CLICK_ROWS.some(r => r.a === arg) ? { kind: 'click', action: arg as ClickAction } : null
  }
  return null
}

// ── what a row does to the menu itself ─────────────────────────────────────────────────────
//
// The open menu blanks the mirror (docs/decisions/blank-tiles-under-overlay.md), so any row
// whose effect lands on the desktop is invisible until the menu closes. Picking a row
// therefore closes the menu unless the row is navigation. The menu is for one-shot
// operations; repetition belongs on a swipe binding.
//
//   'stay'    sub / back (navigation) and mod (arms a modifier for the next key).
//   'resume'  keys and pointer actions: the menu closes, but the level is remembered so the
//             next open returns to it. Typing is a sequence, and Click-hold / Click-release
//             are a pair.
//   'reset'   everything else: the next open starts at the root list.

export type RowEffect = 'stay' | 'resume' | 'reset'

/** What picking this row does to the menu itself. Pure; the single source for the rule above. */
export function rowMenuEffect(token: string): RowEffect {
  const t = parseToken(token)
  if (!t) return 'stay' // unknown token: nothing happened, so nothing changes
  if (t.kind === 'sub' || t.kind === 'back' || t.kind === 'mod') return 'stay'
  if (t.kind === 'key' || t.kind === 'click') return 'resume'
  return 'reset'
}

/** The longest prefix of a remembered path whose levels all still exist, so resuming never
 *  lands on a level the state has removed. Pure; `[]` means "resume at the root list". */
export function resumablePath(path: readonly string[], s: MenuState): string[] {
  const out: string[] = []
  for (const id of path) {
    if (!levelRows(id, s)) break
    out.push(id)
  }
  return out
}

// ── the levels ─────────────────────────────────────────────────────────────────────────────

/** The level the root list's `Menu...` row descends into. */
export const MENU_ROOT_ID = 'menu'
/** The root list's row that enters the hierarchy, shown at the tail of the window list. */
export const MENU_ROOT_LABEL = 'Menu' + SUB
export const MENU_ROOT_TOKEN = 'sub:' + MENU_ROOT_ID

// The key catalogue's labels are written for the phone. For the glasses, `−` `×` `÷` are folded
// to ASCII operators, and any label that is still not ASCII falls back to its keysym.
const LABEL_FOLD: Readonly<Record<string, string>> = { '−': '-', '×': '*', '÷': '/' }
const ASCII = /^[\x20-\x7e]+$/

/** One key catalogue entry's row label: its folded label when that is ASCII, else the keysym. */
function keyLabel(label: string, name: string): string {
  const folded = [...label].map(c => LABEL_FOLD[c] ?? c).join('')
  return ASCII.test(folded) ? folded : name
}

/** One group of the key catalogue as leaf rows, labelled as in the bindings picker. */
function keyRows(group: string): MenuRow[] {
  return KEYS.filter(k => k.group === group).map(k => ({
    label: keyLabel(k.label, k.name),
    token: 'key:' + k.name,
  }))
}

/** `alnum` holds letters and digits; they page separately. */
function alnumRows(kind: 'letters' | 'digits'): MenuRow[] {
  const digit = (s: string) => /^[0-9]$/.test(s)
  return keyRows('alnum').filter(r => (kind === 'digits' ? digit(r.label) : !digit(r.label)))
}

/** A paged group: the rows themselves when they fit in one page, else one row per page.
 *  Page N of level `id` is `<id>/N`. */
function paged(id: string, rows: readonly MenuRow[]): MenuRow[] {
  const pages = balancedChunk(rows, LEVEL_MAX_CONTENT)
  if (pages.length <= 1) return rows.map(r => ({ ...r }))
  return pages.map((p, i) => ({
    // No `...` marker on a page row (see `pageLabel`).
    label: pageLabel(p.map(r => r.label)),
    token: `sub:${id}/${String(i)}`,
  }))
}

/** The page a `<id>/N` level holds, or null when N is out of range (dropped, not clamped). */
function pageOf(rows: readonly MenuRow[], n: string): MenuRow[] | null {
  const pages = balancedChunk(rows, LEVEL_MAX_CONTENT)
  const i = Number(n)
  if (!Number.isInteger(i) || i < 0 || i >= pages.length) return null
  return (pages[i] ?? []).map(r => ({ ...r }))
}

/** `[x] ` / `[ ] `: a toggle's state, in ASCII. */
function mark(on: boolean): string {
  return on ? '[x] ' : '[ ] '
}

/** The content rows of one level, without the `< Back` row that `levelRows` appends.
 *  `null` = no such level; the caller drops the token. */
function levelContent(id: string, s: MenuState): MenuRow[] | null {
  // The level the root list descends into. Destructive rows are last and behind a confirm.
  if (id === MENU_ROOT_ID) {
    const out: MenuRow[] = [
      { label: 'Keys' + SUB, token: 'sub:keys' },
      { label: RP_LEVEL_LABEL, token: 'sub:rp' },
      { label: mark(s.invert) + 'Invert', token: 'invert' },
    ]
    if (s.hasWindow) out.push({ label: 'Close Window', token: 'close' })
    out.push({ label: 'Exit' + SUB, token: 'sub:cexit' })
    return out
  }
  // Keys: the groups of src/shared/keys.ts, one row each, plus the sticky modifiers and the
  // pointer actions.
  if (id === 'keys') {
    return [
      { label: 'Mods' + SUB, token: 'sub:kmods' },
      { label: 'Move' + SUB, token: 'sub:kmove' },
      { label: 'Edit' + SUB, token: 'sub:kedit' },
      { label: 'Func' + SUB, token: 'sub:kfn' },
      { label: 'Chars' + SUB, token: 'sub:kchars' },
      { label: 'Clicks' + SUB, token: 'sub:kclick' },
    ]
  }
  // Sticky and one-shot: the client applies them to the next key and clears them.
  if (id === 'kmods') {
    return MODS.map(m => ({
      label: mark(s.mods.includes(m)) + (m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : 'Shift'),
      token: 'mod:' + m,
    }))
  }
  // There is no `wheel` level: the key catalogue's wheel group is reached from vPad or a swipe
  // binding, not from this keyboard menu. tests/shared.glassMenu.test.ts pins the exclusion.
  if (id === 'kmove') return paged('kmove', keyRows('nav'))
  if (id === 'kedit') return paged('kedit', keyRows('edit'))
  if (id === 'kfn') return paged('kfn', keyRows('fn'))
  if (id === 'kchars') {
    return [
      { label: 'Letters' + SUB, token: 'sub:kletters' },
      { label: 'Digits' + SUB, token: 'sub:kdigits' },
      { label: 'Punct' + SUB, token: 'sub:kpunct' },
      { label: 'Keypad' + SUB, token: 'sub:kkeypad' },
    ]
  }
  if (id === 'kletters') return paged('kletters', alnumRows('letters'))
  if (id === 'kdigits') return paged('kdigits', alnumRows('digits'))
  if (id === 'kpunct') return paged('kpunct', keyRows('punct'))
  if (id === 'kkeypad') return paged('kkeypad', keyRows('keypad'))
  if (id === 'kclick') return CLICK_ROWS.map(r => ({ label: r.label, token: 'click:' + r.a }))
  // `Window...` (RP_LEVEL_LABEL): the catalogue in its own order, destructive entry behind a confirm.
  if (id === 'rp') {
    return RP_KEYS.filter(k => !k.destructive || s.hasWindow).map(k =>
      k.destructive
        ? { label: k.label + SUB, token: 'sub:rpkill' }
        : { label: k.label, token: 'rp:' + k.key },
    )
  }
  // The two confirmations: ordinary levels whose only content row is the action, so `< Back`
  // or a double-tap cancels.
  if (id === 'rpkill') {
    // Gated on `hasWindow` like the row that leads here, so a remembered path
    // (`resumablePath`) cannot resume on a kill with nothing to kill.
    if (!s.hasWindow) return null
    const k = RP_KEYS.find(x => x.destructive)
    return k ? [{ label: CONFIRM_LABEL, token: 'rp:' + k.key }] : null
  }
  if (id === 'cexit') return [{ label: 'Exit the app - confirm', token: 'exit' }]
  // Paged children: `<id>/N`.
  const slash = id.lastIndexOf('/')
  if (slash > 0) {
    const base = id.slice(0, slash)
    const n = id.slice(slash + 1)
    if (base === 'kmove') return pageOf(keyRows('nav'), n)
    if (base === 'kedit') return pageOf(keyRows('edit'), n)
    if (base === 'kfn') return pageOf(keyRows('fn'), n)
    if (base === 'kletters') return pageOf(alnumRows('letters'), n)
    if (base === 'kdigits') return pageOf(alnumRows('digits'), n)
    if (base === 'kpunct') return pageOf(keyRows('punct'), n)
    if (base === 'kkeypad') return pageOf(keyRows('keypad'), n)
  }
  return null
}

/** What a destructive row says once armed: a confirm level on the glasses, the row itself
 *  on the phone. */
export const CONFIRM_LABEL = 'Kill it - confirm'

/** One row of a phone panel: a menu row that may need arming first. */
export interface PanelRow extends MenuRow {
  /** Picking it must be confirmed: the palette arms the row and acts on the second tap. */
  confirm?: true
}

/** The rows of the phone's `window` palette: the catalogue of the glasses' `Window...` level
 *  in the same order, plus `Close Window`. It is a separate builder because `< Back`, the
 *  confirm level and the row budget are properties of the glasses surface; the phone arms a
 *  destructive row in place and scrolls. `Keys...`, `Invert` and `Exit...` are absent
 *  (docs/phone-ui.md). */
export function windowPanelRows(s: MenuState): PanelRow[] {
  const out: PanelRow[] = RP_KEYS.filter(k => !k.destructive || s.hasWindow).map(k =>
    k.destructive
      ? { label: k.label, token: 'rp:' + k.key, confirm: true as const }
      : { label: k.label, token: 'rp:' + k.key },
  )
  if (s.hasWindow) out.push({ label: 'Close Window', token: 'close' })
  return out
}

/** The rows of one level, `< Back` last; `null` = no such level. The cursor opens on row 1,
 *  so the useful rows come first and `< Back` is one wrapping swipe-up away. */
export function levelRows(id: string, s: MenuState): MenuRow[] | null {
  const content = levelContent(id, s)
  if (!content) return null
  return [...content, { label: BACK_LABEL, token: BACK_TOKEN }]
}

/** Every level id reachable from `MENU_ROOT_ID`, in discovery order. Used by the test that
 *  walks the tree. */
export function reachableLevels(s: MenuState): string[] {
  const seen: string[] = []
  const queue = [MENU_ROOT_ID]
  while (queue.length) {
    const id = queue.shift()
    if (id === undefined || seen.includes(id)) continue
    const rows = levelRows(id, s)
    if (!rows) continue
    seen.push(id)
    for (const r of rows) {
      const t = parseToken(r.token)
      if (t?.kind === 'sub') queue.push(t.id)
    }
  }
  return seen
}

/** The breadcrumb the overlay draws as its header (`Menu > Keys > Chars`), built from the
 *  labels of the rows the user picked. */
export function pathHeader(labels: readonly string[]): string {
  const trail = labels.map(l => (l.endsWith(SUB) ? l.slice(0, -SUB.length) : l))
  return trail.join(' > ')
}
