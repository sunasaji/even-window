// even-window — the pure parts of the WebView client. Imported under the node environment,
// where `document` is undefined, so src/client/main.ts does not boot (no SDK, no bridge).

import { describe, expect, it } from 'vitest'
import { parseMirrorMode } from '../src/client/flags.ts'
import { ringGateAccept, VRING_LONG_BAND, vRingTapKind } from '../src/client/gestures.ts'
import {
  ACTIVE_MARK,
  buildMenuItems,
  MENU_APP_PREFIX,
  MENU_ENTRY_ID,
  MENU_MAX_APPS,
  type MenuApp,
  type MenuItem,
  menuSignature,
  mruOrderItems,
  mruOrderWindows,
  ROOT_MAX_ROWS,
  rootPages,
} from '../src/client/menuModel.ts'
import { NAV_SETTLE_MS, type NavClock, NavDebouncer } from '../src/client/navDebounce.ts'
import { charKeysym } from '../src/client/oskb.ts'
import { pickTile } from '../src/client/pump.ts'
import {
  ABBA_ARMS,
  formatLate,
  formatPumpStats,
  LATE_PERIOD_MS,
  newPumpStats,
  type PumpStats,
  parseEncodePath,
  percentile,
  sameBytes,
} from '../src/client/pumpStats.ts'
import { normaliseServer } from '../src/client/serverLink.ts'
import { createOk, pageEstablished, rebuildOk } from '../src/shared/establishPage.ts'
import { ROW_LABEL_UNITS } from '../src/shared/glassMenu.ts'
import type { WinInfo } from '../src/shared/types.ts'
import { glassWidth, LINE_UNITS } from '../src/shared/voiceDialog.ts'
import { clientSource } from './helpers/source.ts'

const bytes = (...n: number[]) => new Uint8Array(n)

// ── sameBytes ──────────────────────────────────────────────────────────────────────────────

describe('sameBytes (the pump diff)', () => {
  it('is true only for identical content', () => {
    expect(sameBytes(bytes(1, 2, 3), bytes(1, 2, 3))).toBe(true)
    expect(sameBytes(bytes(1, 2, 3), bytes(1, 2, 4))).toBe(false)
  })

  it('is false on a length mismatch', () => {
    expect(sameBytes(bytes(1, 2), bytes(1, 2, 3))).toBe(false)
    expect(sameBytes(bytes(1, 2, 3), bytes(1, 2))).toBe(false)
  })

  it('treats an absent baseline as different (first push must always go out)', () => {
    expect(sameBytes(null, bytes(1))).toBe(false)
    expect(sameBytes(undefined, bytes(1))).toBe(false)
  })

  it('two empty buffers are the same', () => {
    expect(sameBytes(bytes(), bytes())).toBe(true)
  })
})

// ── pickTile (the pump's round-robin dequeue) ──────────────────────────────────────────────
//
// What this pins is a starvation bound, not an order. A push takes ~330ms on hardware and
// capture runs at 10fps, so a quadrant holding something that moves is dirty again before its
// own push returns; an absolute 0..3 scan would re-select the busiest quadrant forever. The
// choice is a pure function because the real pump needs a bridge and real latency.

describe('pickTile (the pump dequeue)', () => {
  const none = new Set<number>()
  const dirty = [bytes(1), bytes(1), bytes(1), bytes(1)] // vs. an all-null baseline
  const clean: (Uint8Array | null)[] = [null, null, null, null]

  it('returns -1 when every tile is already on the glass', () => {
    expect(pickTile(dirty, dirty, none, 0)).toBe(-1)
    expect(pickTile(clean, clean, none, 2)).toBe(-1)
  })

  it('a tile with no bytes yet is not a candidate', () => {
    expect(pickTile(clean, clean, none, 0)).toBe(-1)
    expect(pickTile([null, bytes(1), null, null], clean, none, 0)).toBe(1)
  })

  it('walks TL, TR, BL, BR from the cursor', () => {
    expect(pickTile(dirty, clean, none, 0)).toBe(0)
    expect(pickTile(dirty, clean, none, 1)).toBe(1)
    expect(pickTile(dirty, clean, none, 2)).toBe(2)
    expect(pickTile(dirty, clean, none, 3)).toBe(3)
  })

  it('wraps past BR back to TL', () => {
    // Only TL is dirty, and the cursor has just served BR: it must come back round.
    const frames = [bytes(9), bytes(1), bytes(1), bytes(1)]
    const last: (Uint8Array | null)[] = [bytes(1), bytes(1), bytes(1), bytes(1)]
    expect(pickTile(frames, last, none, 3)).toBe(0)
    expect(pickTile(frames, last, none, 1)).toBe(0)
  })

  it('skips tiles parked by a failed push', () => {
    expect(pickTile(dirty, clean, new Set([0, 1]), 0)).toBe(2)
    expect(pickTile(dirty, clean, new Set([0, 1, 2, 3]), 0)).toBe(-1)
  })

  // ── the lazy half: a tile can be a candidate with no bytes yet ──────────────────────────
  // The encode happens at dequeue time, so between an arrival and its push a quadrant holds
  // indices and no bytes. `frames[t]` still holds the previous encode, which may equal the
  // glass, so without `pending` the tile would look clean while holding something new.

  it('picks a pending tile even though its bytes still match the glass', () => {
    const same = bytes(1)
    const frames = [same, same, same, same]
    const last: (Uint8Array | null)[] = [same, same, same, same]
    expect(pickTile(frames, last, none, 0)).toBe(-1) // nothing to do...
    expect(pickTile(frames, last, none, 0, [false, true, false, false])).toBe(1) // ...but TR
  })

  it('picks a pending tile that has no bytes at all yet', () => {
    const clean2: (Uint8Array | null)[] = [null, null, null, null]
    expect(pickTile(clean2, clean2, none, 0, [false, false, true, false])).toBe(2)
  })

  it('still honours the rotation among pending tiles', () => {
    const all = [true, true, true, true]
    const clean2: (Uint8Array | null)[] = [null, null, null, null]
    expect(pickTile(clean2, clean2, none, 0, all)).toBe(0)
    expect(pickTile(clean2, clean2, none, 2, all)).toBe(2)
    expect(pickTile(clean2, clean2, none, 3, all)).toBe(3)
  })

  it('does not pick a pending tile that is parked by a failed push', () => {
    // `failed` has to be checked before pending, or a tile whose encode or push just failed
    // spins the drain instead of being parked for it.
    const clean2: (Uint8Array | null)[] = [null, null, null, null]
    expect(pickTile(clean2, clean2, new Set([1]), 1, [false, true, true, false])).toBe(2)
    expect(pickTile(clean2, clean2, new Set([1, 2]), 1, [false, true, true, false])).toBe(-1)
  })

  it('treats an absent pending array as nothing pending', () => {
    expect(pickTile(dirty, clean, none, 0, [])).toBe(0)
    expect(pickTile(dirty, dirty, none, 0, [])).toBe(-1)
  })

  it('serves every dirty tile within 4 picks even when TL re-dirties after every push', () => {
    // TL is a video: the instant its push lands, a newer frame makes it dirty again. The other
    // three asked once and never change. Drive the pump's own loop.
    const frames = [bytes(0), bytes(1), bytes(1), bytes(1)]
    const last: (Uint8Array | null)[] = [null, null, null, null]
    let cursor = 0
    const served: number[] = []
    let tick = 1
    for (let step = 0; step < 4; step++) {
      const i = pickTile(frames, last, none, cursor)
      expect(i).toBeGreaterThanOrEqual(0)
      served.push(i)
      last[i] = frames[i]!
      cursor = (i + 1) % 4
      frames[0] = bytes(tick++) // TL moved again while that push was in flight
    }
    expect(served).toEqual([0, 1, 2, 3]) // documented order, and nobody starved
    expect(pickTile(frames, last, none, cursor)).toBe(0) // TL is next again, as it should be
  })
})

// ── labels are cut by width, on a character boundary ───────────────────────────────────────

describe('fitUnits: a root-list label on one line of the panel', () => {
  const label = (title: string, active = false) =>
    buildMenuItems([{ id: '1', wid: '0x1', title, cls: '', app: '', active }])[0]!.itemName

  it('leaves a title that fits untouched', () => {
    expect(label('xterm')).toBe('xterm')
    expect(label('日本語のタイトル')).toBe('日本語のタイトル')
  })

  it('cuts by width, so a CJK title runs as far across the panel as an ASCII one', () => {
    const ja = label('あ'.repeat(60))
    const en = label('a'.repeat(120))
    expect([...ja].length).toBe(24) // 32 bytes would be 10
    expect(en.length).toBe(48)
    for (const s of [ja, en]) {
      expect(glassWidth(`> ${ACTIVE_MARK}${s}`)).toBeLessThanOrEqual(LINE_UNITS)
      expect(glassWidth(s)).toBeGreaterThan(ROW_LABEL_UNITS - 4)
    }
  })

  it('gives fewer characters to a title in capitals than to one in narrow letters', () => {
    expect(label('W'.repeat(120)).length).toBeLessThan(label('i'.repeat(200)).length / 2)
  })

  // On a G2 a soft hyphen is drawn as `-`: a Wikipedia title with three of them, budgeted as
  // if they took no room, wrapped and pushed the list down a line.
  it('drops what is not meant to be seen, instead of guessing how the panel draws it', () => {
    expect(label('Tau\u00admata\u200bwha\ufeff')).toBe('Taumatawha')
    expect(label('two\nlines\ttab')).toBe('twolinestab')
    expect(label('~\u00ad', false)).toBe('~')
    const long = label(`${'a'.repeat(30)}\u00ad${'b'.repeat(60)}`)
    expect(long).not.toContain('\u00ad')
    expect(glassWidth(long)).toBeLessThanOrEqual(ROW_LABEL_UNITS)
  })

  it('never splits a surrogate pair', () => {
    const src = '\u{1F44D}'.repeat(80)
    const out = label(src)
    expect(out).not.toContain('\uFFFD')
    expect(src.startsWith(out)).toBe(true)
    expect(out.length % 2).toBe(0)
  })

  it('is as wide focused as not: the mark comes out of the budget', () => {
    expect(label('a'.repeat(120), true)).toBe(label('a'.repeat(120), false))
    expect(glassWidth(ACTIVE_MARK + label('a'.repeat(120), true))).toBeLessThanOrEqual(
      ROW_LABEL_UNITS,
    )
  })

  it('cuts a launcher row with its `+ ` counted', () => {
    const items = buildMenuItems([], [{ id: 'x', name: 'あ'.repeat(60) }])
    const row = items.find(i => i.kind === 'app')!.itemName
    expect(row.startsWith(MENU_APP_PREFIX)).toBe(true)
    expect(glassWidth(row)).toBeLessThanOrEqual(ROW_LABEL_UNITS)
  })
})

describe('windowLabel: a short title is followed by the application', () => {
  const w = (title: string, cls: string, app?: string): WinInfo => ({
    id: '1',
    wid: '0x1',
    title,
    cls,
    active: false,
    ...(app === undefined ? {} : { app }),
  })
  const label = (x: WinInfo) => buildMenuItems([x])[0]!.itemName

  // The case it is for: a terminal whose whole title is its directory.
  it('says which application a bare title belongs to', () => {
    expect(label(w('~', 'XTerm'))).toBe('~ (XTerm)')
    expect(label(w('~', '', 'kitty'))).toBe('~ (kitty)') // no class: the process name
  })

  it('does not repeat an application the title already names, whatever the case', () => {
    expect(label(w('Amazon — Mozilla Firefox', 'firefox'))).toBe('Amazon — Mozilla Firefox')
    expect(label(w('xterm', 'XTerm'))).toBe('xterm')
  })

  it('spends the row on a long title: the name is added whole or not at all', () => {
    const long = 'a'.repeat(46)
    expect(label(w(long, 'XTerm'))).toBe(long)
    expect(glassWidth(label(w('a'.repeat(200), 'XTerm')))).toBeLessThanOrEqual(ROW_LABEL_UNITS)
    expect(label(w('a'.repeat(200), 'XTerm'))).not.toContain('(')
  })

  it('falls back to the application, then the window id, when there is no title', () => {
    expect(label(w('', 'Firefox'))).toBe('Firefox')
    expect(label(w('  ', '', 'firefox'))).toBe('firefox')
    expect(label(w('', ''))).toBe('0x1')
    expect(label(w('~', ''))).toBe('~') // nothing known to add
  })
})

// ── window-switcher items ──────────────────────────────────────────────────────────────────

describe('buildMenuItems', () => {
  const win = (id: string, title: string, active = false): WinInfo => ({
    id,
    wid: `0x40000${id}`,
    cls: '',
    title,
    active,
  })

  it('keeps every window — the panel limit is the pages, not the list — with non-zero unique ids', () => {
    const items = buildMenuItems(
      Array.from({ length: 15 }, (_v, i) => win(String(i + 1), `w${i + 1}`)),
    )
    expect(items).toHaveLength(16)
    // Windows take 2.. in order; the entry row holds the reserved id 1 and sits last.
    expect(items.map(i => i.itemID)).toEqual([
      ...Array.from({ length: 15 }, (_v, i) => i + 2),
      MENU_ENTRY_ID,
    ])
    expect(new Set(items.map(i => i.itemID)).size).toBe(16)
    expect(items.every(i => i.itemID !== 0)).toBe(true)
    expect(items.filter(i => i.kind === 'menu')).toHaveLength(1)
  })

  // The entry row is the only way into Keys / Ratpoison / Close Window / Exit, so it must
  // exist with nothing else to show.
  it('always offers the entry row, even with no windows and no apps at all', () => {
    expect(buildMenuItems([])).toEqual([
      {
        itemID: MENU_ENTRY_ID,
        itemName: 'Menu...',
        kind: 'menu',
        wid: null,
        appId: null,
        active: false,
      },
    ])
  })

  it('cuts every label to the width of a row', () => {
    const items = buildMenuItems([win('1', 'あ'.repeat(40))])
    expect(items[0]).toBeDefined()
    expect(glassWidth(items[0]!.itemName)).toBeLessThanOrEqual(ROW_LABEL_UNITS)
  })

  it('carries active as a flag, not baked into itemName, and falls back to cls', () => {
    // The overlay draws the `*` marker from `active` at render time. Baking it into itemName
    // would make every focus change look like a list change to `menuSignature`.
    const items = buildMenuItems([
      win('1', 'bash', true),
      { id: '2', wid: '0x2', cls: 'Firefox', title: '', active: false },
    ])
    expect(items[0]!.itemName).toBe('bash')
    expect(items[0]!.active).toBe(true)
    expect(items[1]!.itemName).toBe('Firefox')
    expect(items[1]!.active).toBe(false)
  })

  it('drops windows with no wid — `sel` is never a fallback selector', () => {
    const items = buildMenuItems([
      { id: '1', wid: '', cls: 'XTerm', title: 'ghost', active: false },
      win('2', 'real'),
    ])
    expect(items.filter(i => i.kind === 'window').map(i => i.itemName)).toEqual(['real'])
  })

  it('signature changes only when the list really changes', () => {
    const a = buildMenuItems([win('1', 'bash'), win('2', 'vim')])
    const b = buildMenuItems([win('1', 'bash'), win('2', 'vim')])
    const c = buildMenuItems([win('1', 'bash'), win('2', 'less')])
    expect(menuSignature(a)).toBe(menuSignature(b))
    expect(menuSignature(a)).not.toBe(menuSignature(c))
  })

  it('the signature ignores focus — a window switch is not a list change', () => {
    // `active` flips for two windows on every selection; the signature decides whether
    // `rebuildMenu` logs a change.
    const before = buildMenuItems([win('1', 'bash', true), win('2', 'vim', false)])
    const after = buildMenuItems([win('1', 'bash', false), win('2', 'vim', true)])
    expect(menuSignature(before)).toBe(menuSignature(after))
    expect(before[0]!.active).not.toBe(after[0]!.active) // the flip really happened
  })

  it('the signature does change when a window opens or closes', () => {
    const one = buildMenuItems([win('1', 'bash')])
    const two = buildMenuItems([win('1', 'bash'), win('2', 'vim')])
    expect(menuSignature(one)).not.toBe(menuSignature(two))
  })
})

// ── MRU: the root list's display order ─────────────────────────────────────────────────────
//
// Recency re-orders what the overlay draws and nothing else. `buildMenuItems` keeps the
// server's order and the itemIDs that order allocates, so a row's `item:N` token names the
// same row whatever the display order.

describe('mruOrderItems — recency decides what is nearest the hand', () => {
  const win = (id: string, title: string, active = false): WinInfo => ({
    id,
    wid: `0x40000${id}`,
    cls: '',
    title,
    active,
  })
  const app = (id: string, name: string): MenuApp => ({ id, name })
  const labels = (items: readonly { itemName: string }[]) => items.map(i => i.itemName)

  // ratpoison lists by window number (roughly start order); recency is the order the user
  // actually moved through them, most recent first.
  it('draws the window rows most-recently-focused first', () => {
    const items = buildMenuItems([win('1', 'bash'), win('2', 'vim'), win('3', 'less')])
    expect(labels(mruOrderItems(items, ['0x400003', '0x400001', '0x400002']))).toEqual([
      'less',
      'bash',
      'vim',
      'Menu...',
    ])
  })

  it('leaves the launcher rows and the entry row exactly where buildMenuItems put them', () => {
    const items = buildMenuItems(
      [win('1', 'bash'), win('2', 'vim')],
      [app('x11:xcalc', 'xcalc'), app('x11:oclock', 'oclock')],
    )
    const out = mruOrderItems(items, ['0x400002', '0x400001'])
    expect(labels(out)).toEqual(['vim', 'bash', '+ xcalc', '+ oclock', 'Menu...'])
    // Windows first, then apps, then the entry row — the shape the renderer and the row budget
    // both assume. Re-ordering is a permutation within the window block.
    expect(out.map(i => i.kind)).toEqual(['window', 'window', 'app', 'app', 'menu'])
  })

  // A window that has never held focus, or one that opened while the menu was already up,
  // must not jump the queue and move the rows under the cursor.
  it('sorts windows missing from the order after the ranked ones, keeping their own order', () => {
    const items = buildMenuItems([win('1', 'bash'), win('2', 'vim'), win('3', 'less')])
    expect(labels(mruOrderItems(items, ['0x400003']))).toEqual(['less', 'bash', 'vim', 'Menu...'])
    expect(labels(mruOrderItems(items, []))).toEqual(['bash', 'vim', 'less', 'Menu...'])
  })

  it('ignores window ids in the order that are not on the list (a window that just closed)', () => {
    const items = buildMenuItems([win('1', 'bash'), win('2', 'vim')])
    expect(labels(mruOrderItems(items, ['0x4000099', '0x400002', '0x400001']))).toEqual([
      'vim',
      'bash',
      'Menu...',
    ])
  })

  it('is a permutation: same items, same count, every row kept', () => {
    const items = buildMenuItems([win('1', 'bash'), win('2', 'vim')], [app('x11:xcalc', 'xcalc')])
    const out = mruOrderItems(items, ['0x400002'])
    expect(out).toHaveLength(items.length) // menuRowCount() relies on exactly this
    expect(new Set(out)).toEqual(new Set(items)) // the same objects, re-ordered only
  })

  it("is a display order only — the registered payload keeps the server's order", () => {
    // The display order genuinely differs…
    const items = buildMenuItems([win('1', 'bash', true), win('2', 'vim')])
    const sig = menuSignature(items)
    expect(menuSignature(mruOrderItems(items, ['0x400002', '0x400001']))).not.toBe(sig)
    // …but `items` itself is a function of the window list alone. A focus flip — the one event
    // that moves recency — leaves it byte-identical, so switching never reads as a list change.
    expect(menuSignature(buildMenuItems([win('1', 'bash', false), win('2', 'vim', true)]))).toBe(
      sig,
    )
  })

  // `{t:'windows'}.recent` is optional on the wire: a client can be newer than the
  // long-running server it talks to. A missing order must not throw inside `openMenu()`.
  it('treats a missing order as "no recency known" — never a throw (an older server)', () => {
    const items = buildMenuItems([win('1', 'bash'), win('2', 'vim')])
    expect(() => mruOrderItems(items, undefined)).not.toThrow()
    expect(labels(mruOrderItems(items, undefined))).toEqual(['bash', 'vim', 'Menu...'])
    // …i.e. exactly the server's own order.
    expect(mruOrderItems(items, undefined)).toEqual(mruOrderItems(items, []))
  })

  it('leaves itemIDs attached to their own rows, so an `item:N` token still resolves', () => {
    const items = buildMenuItems([win('1', 'bash'), win('2', 'vim')])
    const out = mruOrderItems(items, ['0x400002', '0x400001'])
    expect(out[0]).toMatchObject({ itemName: 'vim', itemID: 3, wid: '0x400002' })
    expect(out[1]).toMatchObject({ itemName: 'bash', itemID: 2, wid: '0x400001' })
  })
})

// ── the curated launcher rows in the glasses menu ──────────────────────────────────────────
//
// The full list is on the phone; the glasses get the most-recently-launched few. These pin the
// two things that could go wrong silently: the budget share (windows must not lose a slot to a
// launcher) and the signature (a launcher row appearing is a list change, and a focus change
// still is not).

describe('rootPages — the root list on a ten-line panel', () => {
  const win = (id: string, title: string, active = false): WinInfo => ({
    id,
    wid: `0x4${id.padStart(5, '0')}`,
    cls: '',
    title,
    active,
  })
  const app = (id: string, name: string): MenuApp => ({ id, name })
  const wins = (n: number) => Array.from({ length: n }, (_v, i) => win(String(i + 1), `w${i + 1}`))
  const APPS = [app('x11:xcalc', 'xcalc'), app('x11:oclock', 'oclock'), app('x11:xeyes', 'xeyes')]
  const pagesOf = (n: number, apps: MenuApp[] = APPS) => rootPages(buildMenuItems(wins(n), apps))
  const kinds = (p: readonly MenuItem[]) => p.map(i => i.kind[0]).join('')

  // The regression this pins: header + rows must never exceed the ten lines the panel shows.
  it('never puts more rows on a page than the panel has under the header', () => {
    for (let n = 0; n <= 40; n++) {
      for (const p of pagesOf(n)) expect(p.length).toBeLessThanOrEqual(ROOT_MAX_ROWS)
    }
  })

  it('is one page while windows and apps fit together, Menu first', () => {
    expect(pagesOf(0).map(kinds)).toEqual(['maaa'])
    expect(pagesOf(1).map(kinds)).toEqual(['mwaaa']) // the ordinary case: the boot terminal
    expect(pagesOf(5).map(kinds)).toEqual(['mwwwwwaaa'])
    expect(pagesOf(8, []).map(kinds)).toEqual(['mwwwwwwww'])
    expect(pagesOf(8, [])[0]![0]).toMatchObject({ kind: 'menu', itemName: 'Menu...' })
  })

  // The regression this pins: an app row used to fill only the last page's slack, so with six
  // or more windows the recent apps vanished without a page to find them on.
  it('pages windows and apps together, so no app row is dropped for space', () => {
    expect(pagesOf(6).map(kinds)).toEqual(['mwwwwwwaa', 'ma'])
    expect(pagesOf(8).map(kinds)).toEqual(['mwwwwwwww', 'maaa'])
    expect(pagesOf(9).map(kinds)).toEqual(['mwwwwwwww', 'mwaaa'])
    expect(pagesOf(16).map(kinds)).toEqual(['mwwwwwwww', 'mwwwwwwww', 'maaa'])
    for (let n = 0; n <= 40; n++) {
      expect(
        pagesOf(n)
          .flat()
          .filter(i => i.kind === 'app'),
      ).toHaveLength(APPS.length)
    }
  })

  it('heads every page with Menu/Prev/Next... once paged, and has no More row', () => {
    expect(pagesOf(17).map(kinds)).toEqual(['mwwwwwwww', 'mwwwwwwww', 'mwaaa'])
    for (const p of pagesOf(17)) {
      expect(p[0]).toMatchObject({
        kind: 'menu',
        itemID: MENU_ENTRY_ID,
        itemName: 'Menu/Prev/Next...',
      })
    }
  })

  it('reaches every window exactly once, in the order it was given', () => {
    const items = mruOrderItems(buildMenuItems(wins(23), APPS), ['0x400023', '0x400009'])
    const shown = rootPages(items)
      .flat()
      .filter(i => i.kind === 'window')
      .map(i => i.itemName)
    expect(shown).toEqual(items.filter(i => i.kind === 'window').map(i => i.itemName))
    // Recency picks the first page: the two most recent head it, whatever their numbers.
    expect(shown.slice(0, 2)).toEqual(['w23', 'w9'])
  })

  it('still hands the launcher at most MENU_MAX_APPS rows, the entry row last', () => {
    const extra = Array.from({ length: MENU_MAX_APPS }, (_, i) => app(`x11:a${String(i)}`, 'a'))
    const items = buildMenuItems(wins(2), [...APPS, ...extra])
    expect(items.filter(i => i.kind === 'app')).toHaveLength(MENU_MAX_APPS) // the rest are dropped
    expect(items[items.length - 1]).toMatchObject({ kind: 'menu', itemID: MENU_ENTRY_ID })
    expect(new Set(items.map(i => i.itemID)).size).toBe(items.length)
  })

  it('marks a launcher row with `+ ` and carries the id, never a command', () => {
    const items = buildMenuItems([win('1', 'bash')], [app('x11:xfontsel', 'xfontsel')])
    const row = items.find(i => i.kind === 'app')
    expect(row).toMatchObject({
      itemID: 3,
      itemName: '+ xfontsel',
      kind: 'app',
      appId: 'x11:xfontsel',
      wid: null,
    })
    // Nothing on the glasses may name an argv: the id is the whole request.
    expect(JSON.stringify(items)).not.toContain('xterm -bg')
  })

  it('cuts a long app name to the width of a row, the prefix included', () => {
    const items = buildMenuItems([], [app('u:long', 'あ'.repeat(40))])
    const row = items.find(i => i.kind === 'app')
    expect(row).toBeDefined()
    expect(glassWidth(row!.itemName)).toBeLessThanOrEqual(ROW_LABEL_UNITS)
    expect(row!.itemName.startsWith('+ ')).toBe(true)
  })

  it('skips an app with no id rather than registering an unusable row', () => {
    const items = buildMenuItems([], [app('', 'nameless')])
    expect(items.filter(i => i.kind === 'app')).toHaveLength(0)
  })

  it('the signature moves when the launcher recency order moves — and only then', () => {
    const a = buildMenuItems(
      [win('1', 'bash')],
      [app('x11:xcalc', 'xcalc'), app('x11:oclock', 'oclock')],
    )
    const b = buildMenuItems(
      [win('1', 'bash')],
      [app('x11:oclock', 'oclock'), app('x11:xcalc', 'xcalc')],
    )
    expect(menuSignature(a)).not.toBe(menuSignature(b))
    // …and does not move when nothing moved.
    const again = buildMenuItems(
      [win('1', 'bash')],
      [app('x11:xcalc', 'xcalc'), app('x11:oclock', 'oclock')],
    )
    expect(menuSignature(a)).toBe(menuSignature(again))
  })

  it('still ignores focus with launcher rows present', () => {
    const apps = [app('x11:xcalc', 'xcalc')]
    const before = buildMenuItems([win('1', 'bash', true), win('2', 'vim', false)], apps)
    const after = buildMenuItems([win('1', 'bash', false), win('2', 'vim', true)], apps)
    expect(menuSignature(before)).toBe(menuSignature(after))
  })

  it('is backward compatible: no apps argument ⇒ the windows plus the one entry row', () => {
    expect(buildMenuItems([win('1', 'bash')]).map(i => i.kind)).toEqual(['window', 'menu'])
  })
})

// ── leading-edge swipe debounce ────────────────────────────────────────────────────────────

class FakeClock implements NavClock {
  t = 1_000
  private timers = new Map<number, { at: number; fn: () => void }>()
  private seq = 1

  now(): number {
    return this.t
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.seq++
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** Fire every timer due within `ms`, in due order, then park the clock at the end. */
  advance(ms: number): void {
    const target = this.t + ms
    for (;;) {
      let dueId = -1
      let dueAt = Infinity
      for (const [id, e] of this.timers)
        if (e.at <= target && e.at < dueAt) {
          dueId = id
          dueAt = e.at
        }
      if (dueId < 0) break
      const e = this.timers.get(dueId)!
      this.timers.delete(dueId)
      this.t = e.at
      e.fn()
    }
    this.t = target
  }
}

function harness() {
  const clock = new FakeClock()
  const sent: Array<[number, number]> = []
  const nav = new NavDebouncer((dir, count) => {
    sent.push([dir, count])
  }, clock)
  return { clock, sent, nav }
}

describe('NavDebouncer — leading edge, accumulate, re-lead', () => {
  it('settle window is 600ms', () => {
    expect(NAV_SETTLE_MS).toBe(600)
  })

  it('the first swipe fires immediately with count=1', () => {
    const { sent, nav } = harness()
    nav.queue(-1)
    expect(sent).toEqual([[-1, 1]])
  })

  it('follow-ups inside the window accumulate and flush as one move-N', () => {
    const { clock, sent, nav } = harness()
    nav.queue(1) // leading → immediate
    clock.advance(300)
    nav.queue(1)
    clock.advance(300)
    nav.queue(1)
    clock.advance(300)
    nav.queue(1)
    expect(sent).toEqual([[1, 1]]) // nothing extra yet — the burst is still accumulating
    clock.advance(NAV_SETTLE_MS) // settle → the timer flushes
    expect(sent).toEqual([
      [1, 1],
      [1, 3],
    ])
  })

  it('accumulates a realistic 1->7 burst at ~400ms intervals', () => {
    const { clock, sent, nav } = harness()
    for (let i = 0; i < 7; i++) {
      nav.queue(1)
      clock.advance(400)
    }
    clock.advance(NAV_SETTLE_MS)
    expect(sent).toEqual([
      [1, 1],
      [1, 6],
    ]) // 1 leading + 6 coalesced follow-ups = 7 moves
  })

  it('a direction change flushes the pending batch and re-leads immediately', () => {
    const { clock, sent, nav } = harness()
    nav.queue(1)
    clock.advance(200)
    nav.queue(1)
    clock.advance(200)
    nav.queue(1) // pending = 2
    clock.advance(200)
    nav.queue(-1) // direction change
    expect(sent).toEqual([
      [1, 1],
      [1, 2],
      [-1, 1],
    ])
    clock.advance(NAV_SETTLE_MS)
    expect(sent).toEqual([
      [1, 1],
      [1, 2],
      [-1, 1],
    ]) // nothing left over
  })

  it('an idle gap re-leads instead of accumulating', () => {
    const { clock, sent, nav } = harness()
    nav.queue(1)
    clock.advance(NAV_SETTLE_MS + 100)
    nav.queue(1)
    expect(sent).toEqual([
      [1, 1],
      [1, 1],
    ])
  })

  it('an explicit flush (tap/double) drains the batch before the settle fires', async () => {
    const { clock, sent, nav } = harness()
    nav.queue(1)
    clock.advance(100)
    nav.queue(1)
    clock.advance(100)
    nav.queue(1)
    await nav.flush()
    expect(sent).toEqual([
      [1, 1],
      [1, 2],
    ])
    clock.advance(NAV_SETTLE_MS)
    expect(sent).toEqual([
      [1, 1],
      [1, 2],
    ]) // the cancelled timer must not double-send
  })

  it('flush with nothing pending sends nothing', async () => {
    const { sent, nav } = harness()
    await nav.flush()
    expect(sent).toEqual([])
  })

  it('every swipe maps to exactly one server move', () => {
    const { clock, sent, nav } = harness()
    const swipes = 9
    for (let i = 0; i < swipes; i++) {
      nav.queue(-1)
      clock.advance(250)
    }
    clock.advance(NAV_SETTLE_MS)
    expect(sent.reduce((n, [, c]) => n + c, 0)).toBe(swipes)
  })
})

// ── de-burst gate ──────────────────────────────────────────────────────────────────────────

describe('vRingTapKind', () => {
  const W = 400
  const H = 800
  const bandTop = H * (1 - VRING_LONG_BAND)

  it('splits the pad into left = single and right = double', () => {
    expect(vRingTapKind(10, 300, W, H, true)).toBe('single')
    expect(vRingTapKind(199, 300, W, H, true)).toBe('single')
    expect(vRingTapKind(200, 300, W, H, true)).toBe('double')
    expect(vRingTapKind(390, 300, W, H, true)).toBe('double')
  })

  it('gives the bottom band to the long press on either side, when voice is on', () => {
    expect(vRingTapKind(10, bandTop, W, H, true)).toBe('long')
    expect(vRingTapKind(390, H - 1, W, H, true)).toBe('long')
    expect(vRingTapKind(10, bandTop - 1, W, H, true)).toBe('single')
  })

  it('leaves no dead band without voice: the halves reach the bottom edge', () => {
    expect(vRingTapKind(10, H - 1, W, H, false)).toBe('single')
    expect(vRingTapKind(390, H - 1, W, H, false)).toBe('double')
  })
})

describe('ringGateAccept', () => {
  it('swallows a same-kind burst inside the window', () => {
    expect(ringGateAccept({ kind: 'swipe +1', t: 1000 }, 'swipe +1', 1100, 140)).toBe(false)
    expect(ringGateAccept({ kind: 'swipe +1', t: 1000 }, 'swipe +1', 1140, 140)).toBe(true)
  })

  it('swallows the stray single that the Hub emits as a double-tap click edge', () => {
    expect(ringGateAccept({ kind: 'double', t: 1000 }, 'single', 1100, 90)).toBe(false)
    expect(ringGateAccept({ kind: 'double', t: 1000 }, 'single', 1200, 90)).toBe(true)
  })

  it('never swallows a double because of an adjacent single', () => {
    expect(ringGateAccept({ kind: 'single', t: 1000 }, 'double', 1001, 90)).toBe(true)
  })

  it('always accepts a deliberate change of gesture', () => {
    expect(ringGateAccept({ kind: 'swipe +1', t: 1000 }, 'swipe -1', 1001, 140)).toBe(true)
    expect(ringGateAccept({ kind: '', t: 0 }, 'single', 1000, 90)).toBe(true)
  })
})

// ── misc ───────────────────────────────────────────────────────────────────────────────────

describe('normaliseServer', () => {
  it('trims and drops trailing slashes', () => {
    expect(normaliseServer('  http://host:8787/ ')).toBe('http://host:8787')
    expect(normaliseServer('http://host:8787///')).toBe('http://host:8787')
    expect(normaliseServer('http://host:8787')).toBe('http://host:8787')
  })
})

describe('establishPage predicates', () => {
  it('create is OK only on 0', () => {
    expect(createOk(0)).toBe(true)
    for (const v of [1, 2, 3, true, '0', null, undefined]) expect(createOk(v)).toBe(false)
  })

  it('rebuild is OK only on true', () => {
    expect(rebuildOk(true)).toBe(true)
    for (const v of [false, 0, 1, 'true', null, undefined]) expect(rebuildOk(v)).toBe(false)
  })

  it('established when either call reports OK', () => {
    expect(pageEstablished(0, false)).toBe(true) // create success, rebuild refused
    expect(pageEstablished(1, true)).toBe(true) // create invalid (reload), rebuild made it live
    expect(pageEstablished(0, true)).toBe(true)
    expect(pageEstablished(1, false)).toBe(false)
    expect(pageEstablished(2, false)).toBe(false)
  })
})

// ── charKeysym (the on-screen keyboard's modified-character path) ───────────────────────────
// `{kind:'key'}` goes straight to `xdotool key --clearmodifiers` (no translation table on that
// route), and xdotool cannot parse a punctuation glyph in a chord. So an armed Ctrl/Alt has to
// name the keysym. Letters and digits need no entry.

describe('charKeysym (keys panel, modifier armed)', () => {
  it('names the punctuation keysyms xdotool needs in a chord', () => {
    expect(charKeysym('-')).toBe('minus')
    expect(charKeysym('=')).toBe('equal')
    expect(charKeysym('[')).toBe('bracketleft')
    expect(charKeysym('\\')).toBe('backslash')
    expect(charKeysym(' ')).toBe('space')
    expect(charKeysym('`')).toBe('grave')
    expect(charKeysym('/')).toBe('slash')
  })

  it('passes letters and digits through — xdotool takes those as they are', () => {
    for (const ch of ['a', 'z', 'Q', '0', '9']) expect(charKeysym(ch)).toBe(ch)
  })

  it('composes into the chords the panel actually sends', () => {
    expect('ctrl+' + charKeysym('c')).toBe('ctrl+c')
    expect('ctrl+alt+' + charKeysym('-')).toBe('ctrl+alt+minus')
  })
})

// ── the pump stats line (?stats=1) ─────────────────────────────────────────────────────────
//
// This line exists to be diffed between two hardware captures, which only works if the format
// is stable and the numbers mean what the reader assumes; both are pinned here.

describe('percentile (nearest-rank, over an unsorted sample)', () => {
  it('is 0 for an empty sample rather than NaN', () => {
    expect(percentile([], 0.5)).toBe(0)
    expect(percentile([], 0.9)).toBe(0)
  })

  it('does not care about input order', () => {
    const asc = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const shuffled = [7, 2, 10, 4, 1, 9, 3, 8, 5, 6]
    expect(percentile(shuffled, 0.5)).toBe(percentile(asc, 0.5))
    expect(percentile(shuffled, 0.9)).toBe(percentile(asc, 0.9))
  })

  it('picks the nearest rank at or above p, so p90 of 1..10 is 9', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(xs, 0.5)).toBe(5)
    expect(percentile(xs, 0.9)).toBe(9)
    expect(percentile(xs, 1)).toBe(10)
    expect(percentile(xs, 0)).toBe(1)
  })

  it('a single sample is every percentile of itself', () => {
    expect(percentile([42], 0.5)).toBe(42)
    expect(percentile([42], 0.9)).toBe(42)
  })

  it('does not disturb the caller`s array — it is still accumulating', () => {
    const xs = [3, 1, 2]
    percentile(xs, 0.5)
    expect(xs).toEqual([3, 1, 2])
  })
})

describe('formatPumpStats', () => {
  /** A healthy 10s window: ~10.4 pushes/s spread evenly over the four quadrants. */
  const healthy = (): PumpStats => ({
    published: 392,
    // 392 publishes, 104 encodes: 288 were coalesced away before the pump reached the tile and
    // none survived encoding only to match the glass. That is what healthy looks like.
    wasted: 288,
    wastedEncode: 0,
    pushed: [26, 26, 26, 26],
    failed: 0,
    pushMs: Array.from({ length: 104 }, (_, k) => 90 + (k % 7) * 4),
    deriveMs: Array.from({ length: 392 }, (_, k) => 0.34 + (k % 5) * 0.03),
    decodeMs: Array.from({ length: 392 }, (_, k) => 1.8 + (k % 4) * 0.2),
    encodeMs: Array.from({ length: 104 }, (_, k) => 2.0 + (k % 3) * 0.5),
    // A 10s window at LATE_PERIOD_MS=10 wants 1000 ticks. 104 encodes of ~2ms each is what a
    // main-thread encode looks like from the timer's side: ~104 blocks in the detectable band.
    lateMs: Array.from({ length: 104 }, (_, k) => 2 + (k % 3)),
    lateTicks: 1000,
    maxWaitMs: 390,
  })

  it('reports the per-quadrant counts in TL TR BL BR order — the fairness reading', () => {
    expect(formatPumpStats(healthy(), 10_000)).toContain('TL 26 TR 26 BL 26 BR 26')
  })

  it('makes starvation obvious without any arithmetic by the reader', () => {
    const starved = { ...healthy(), pushed: [104, 0, 0, 0] }
    const line = formatPumpStats(starved, 10_000)
    expect(line).toContain('TL 104 TR 0 BL 0 BR 0')
    expect(line).toContain('push 104@10.4/s') // same throughput, all of it one quadrant
  })

  it('states how much of the derive was thrown away — the coalescing rate', () => {
    // The rate at which coalescing is working.
    expect(formatPumpStats(healthy(), 10_000)).toContain('wasted 288/392 73%')
  })

  it('splits the waste that cost an encode out of the total — they have opposite remedies', () => {
    // `wasted` is a sum: 288/392 says coalescing is doing its job, and `enc` says whether
    // anything is silently re-encoding a tile the glass already has.
    expect(formatPumpStats(healthy(), 10_000)).toContain('wasted 288/392 73% enc 0')
    const faulty = { ...healthy(), published: 7, wasted: 5, wastedEncode: 5, pushed: [1, 1, 0, 0] }
    expect(formatPumpStats(faulty, 10_000)).toContain('wasted 5/7 71% enc 5')
  })

  it('does not let a healthy coalescing rate hide a fault, or the reverse', () => {
    // The two failure modes this separation exists to tell apart. Same `wasted` percentage in
    // both; only `enc` moves. Derived as `encode - push` these would be indistinguishable the
    // moment an overlay stood the pump down mid-drain.
    const coalescing = { ...healthy(), wasted: 288, wastedEncode: 0 }
    const reencoding = { ...healthy(), wasted: 288, wastedEncode: 288 }
    expect(formatPumpStats(coalescing, 10_000)).toContain('73% enc 0')
    expect(formatPumpStats(reencoding, 10_000)).toContain('73% enc 288')
  })

  it('cannot report waste above 100%', () => {
    // After a baseline reset the pump re-sends bytes nobody published again, so a
    // pushes-per-publish ratio could exceed one. Counting discarded publishes is bounded.
    const odd = { ...newPumpStats(), published: 4, wasted: 0, pushed: [2, 2, 2, 2] }
    const line = formatPumpStats(odd, 10_000)
    expect(line).toContain('push 8@0.8/s') // the re-sends are still reported as pushes
    expect(line).toContain('wasted 0/4 0%') // and nothing is claimed to be wasted
  })

  it('reports decode at the arrival rate — the one thing EW_FPS still controls', () => {
    // At 10fps a moving screen emits ~39 tiles/s against a pump that sends ~2.5, so this line
    // says whether lowering the capture rate would buy anything.
    const line = formatPumpStats(healthy(), 10_000)
    expect(line).toContain('decode 392@39.2/s')
  })

  it('reports the encode at its own rate, so what deferring it saved is readable', () => {
    // The derive runs at 39.2/s and the encode at 10.4/s: the gap is the work not done.
    const line = formatPumpStats(healthy(), 10_000)
    expect(line).toContain('derive 392@39.2/s')
    expect(line).toContain('encode 104@10.4/s')
  })

  it('reports the wait, not the gap between pushes', () => {
    expect(formatPumpStats(healthy(), 10_000)).toContain('maxwait 390ms')
    expect(formatPumpStats(healthy(), 10_000)).not.toContain('maxgap')
  })

  it('prints push ms whole and derive ms to 2dp — they differ by two orders of magnitude', () => {
    // A 0.4ms derive printed to whole milliseconds would read as "0" and the number this whole
    // line exists to track would be invisible.
    const line = formatPumpStats(healthy(), 10_000)
    expect(line).toContain('med 102 p90 114ms') // push: no false precision
    expect(line).toContain('med 0.40 p90 0.46ms') // derive: 2dp or it rounds to nothing
  })

  it('survives a window in which nothing happened at all', () => {
    // Printed rather than skipped: "nothing moved" and "the pump wedged" must not look alike.
    const line = formatPumpStats(newPumpStats(), 10_000)
    expect(line).toContain('push 0@0.0/s n/a')
    expect(line).toContain('TL 0 TR 0 BL 0 BR 0')
    expect(line).toContain('wasted n/a')
    expect(line).not.toContain('NaN')
    expect(line).not.toContain('Infinity')
  })

  it('counts failures separately from pushes, so a dead link is not read as a slow one', () => {
    const line = formatPumpStats({ ...healthy(), pushed: [0, 0, 0, 0], failed: 12 }, 10_000)
    expect(line).toContain('push 0@0.0/s')
    expect(line).toContain('fail 12')
  })

  it('scales the rates to the window it is given', () => {
    expect(formatPumpStats(healthy(), 20_000)).toContain('stats 20s: push 104@5.2/s')
  })

  it('reports main-thread occupancy, the one field that is not timed across an await', () => {
    // `encode` spans an await and `derive` is pinned to the phone's 1ms clock. This is the only
    // number on the line that says how much main thread the client actually took.
    expect(formatPumpStats(healthy(), 10_000)).toContain('late blk')
  })
})

describe('formatLate — main-thread occupancy', () => {
  const s = (lateMs: number[], lateTicks: number): PumpStats => ({
    ...newPumpStats(),
    lateMs,
    lateTicks,
  })

  /** A window of `ticks` ticks whose timer floor is `floor`ms, with `blocks` added on top. */
  const window = (ticks: number, floor: number, blocks: number[]): number[] => {
    const xs = Array.from({ length: ticks }, () => floor)
    blocks.forEach((b, i) => {
      xs[i] = floor + b
    })
    return xs
  }

  it('subtracts the timer floor, which is most of the raw total', () => {
    // 1000 ticks sitting at 2ms of pure scheduling jitter, plus three real 3ms blocks.
    const line = formatLate(s(window(1000, 2, [3, 3, 3]), 1000), 10_000)
    expect(line).toContain('blk9ms') // the blocks, and only the blocks
    expect(line).toContain('floor2')
    expect(line).toContain('Σ2009/1000t') // the raw number the floor is 99.6% of
  })

  it('separates two arms whose raw totals differ by only 3.7%', () => {
    // 825 ticks and Σ1740ms: ~2.1ms of timer imprecision on every tick, so the encode signal
    // is 3.7% of the raw number.
    const arm = (blocks: number[]) => formatLate(s(window(825, 2, blocks), 825), 10_000)
    const worker = arm([]) // deflate elsewhere
    const main = arm(Array.from({ length: 32 }, () => 2)) // 3.2/s x 2ms, on the thread
    expect(worker).toContain('blk0ms')
    expect(main).toContain('blk64ms')
    // The raw totals are 1650 and 1714 — a 3.7% difference, which is what failed to separate.
    expect(worker).toContain('Σ1650/')
    expect(main).toContain('Σ1714/')
  })

  it('uses p25 for the floor, so dense blocking cannot subtract the signal away', () => {
    // In the simulator the encode runs at 40/s against ~80 ticks/s: half the ticks are hit. A
    // median floor would sit inside the blocked population and erase most of what it measures.
    const half = Array.from({ length: 100 }, (_v, k) => (k % 2 === 0 ? 2 : 6))
    const line = formatLate(s(half, 100), 10_000)
    expect(line).toContain('floor2') // p25 is still in the clean half
    expect(line).toContain('blk200ms') // 50 blocks x 4ms survive
  })

  it('distinguishes a steady drip from one long stall at the same blocked total', () => {
    const drip = formatLate(
      s(
        window(
          1000,
          0,
          Array.from({ length: 30 }, () => 2),
        ),
        1000,
      ),
      10_000,
    )
    const stall = formatLate(s(window(1000, 0, [60]), 1000), 10_000)
    expect(drip).toContain('blk60ms')
    expect(stall).toContain('blk60ms')
    expect(drip).toContain('max 2ms')
    expect(stall).toContain('max 60ms')
  })

  it('says when the sampler itself was starved, so an undercount is not read as a quiet window', () => {
    // The failure that would otherwise report the busiest window as the calmest.
    expect(formatLate(s([5, 5], 1000), 10_000)).not.toContain('STARVED')
    expect(formatLate(s([5, 5], 300), 10_000)).toContain('SAMPLER STARVED')
  })

  it('survives a window with no ticks and one with no lateness at all', () => {
    expect(formatLate(s([], 0), 10_000)).toBe('n/a')
    const quiet = formatLate(
      s(
        Array.from({ length: 1000 }, () => 0),
        1000,
      ),
      10_000,
    )
    expect(quiet).toContain('blk0ms')
    expect(quiet).toContain('floor0')
    expect(quiet).toContain('max 0ms')
    expect(quiet).not.toContain('NaN')
  })

  it('does not blow the stack on a full sample array', () => {
    // `Math.max(...xs)` is a spread and STATS_SAMPLE_MAX is 4096 — the size at which that idiom
    // starts throwing on some engines. This is why the implementation reduces instead.
    const many = Array.from({ length: 4096 }, (_v, k) => (k % 7) + 1)
    expect(() => formatLate(s(many, 1000), 10_000)).not.toThrow()
  })
})

describe('parseEncodePath — the in-session A/B', () => {
  it('accepts the three paths and their numeric spellings', () => {
    expect(parseEncodePath('worker')).toBe('worker')
    expect(parseEncodePath('1')).toBe('worker')
    expect(parseEncodePath('main')).toBe('main')
    expect(parseEncodePath('0')).toBe('main')
    expect(parseEncodePath('abba')).toBe('abba')
    expect(parseEncodePath(' ABBA ')).toBe('abba')
  })

  it('decides nothing when absent or unparseable, like every other flag here', () => {
    // An unparseable value parses to null and decides nothing.
    for (const raw of [null, undefined, '', '  ', 'banana', 'true', 'yes']) {
      expect(parseEncodePath(raw)).toBeNull()
    }
  })
})

describe('ABBA_ARMS', () => {
  it('is ABBA and not ABAB, so a linear drift cancels exactly', () => {
    expect(ABBA_ARMS).toEqual(['worker', 'main', 'main', 'worker'])
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const at = (arm: string) => ABBA_ARMS.map((v, i) => (v === arm ? i : -1)).filter(i => i >= 0)
    expect(mean(at('worker'))).toBe(mean(at('main')))
  })

  it('gives both arms the same number of windows', () => {
    expect(ABBA_ARMS.filter(a => a === 'worker')).toHaveLength(2)
    expect(ABBA_ARMS.filter(a => a === 'main')).toHaveLength(2)
  })

  it('completes two blocks before the closing link baseline, so a run can self-certify', () => {
    // LINK_BASE_END_AFTER is 6 windows = 60s; two ABBA blocks are 8 windows = 80s. A run long
    // enough to be compared is therefore also long enough to be bracketed.
    expect(ABBA_ARMS.length * 2).toBeGreaterThan(6)
    expect(LATE_PERIOD_MS).toBe(10)
  })
})

// ── the mirror mode ────────────────────────────────────────────────────────────────────────
//
// Colour is the default and the cheap one: the server sends a 16-colour indexed PNG, so the
// colour mirror is a palette read per pixel. Green survives because it is the only way to
// judge polarity and contrast on an emissive see-through panel without wearing the glasses.

describe('parseMirrorMode', () => {
  it('accepts both spellings of colour, and the mono aliases', () => {
    for (const v of ['color', 'colour', 'COLOR', ' Colour '])
      expect(parseMirrorMode(v)).toBe('color')
    for (const v of ['green', 'grey', 'gray', 'mono']) expect(parseMirrorMode(v)).toBe('green')
  })

  it('takes 1/0, so the flag reads like the boolean ones when written that way', () => {
    expect(parseMirrorMode('1')).toBe('color')
    expect(parseMirrorMode('0')).toBe('green')
  })

  it('returns null for absent, so the next source decides', () => {
    expect(parseMirrorMode(null)).toBeNull()
    expect(parseMirrorMode(undefined)).toBeNull()
  })

  it('does not coerce an unknown value to the default', () => {
    // `?mirror=gren` must not read as a deliberate choice of anything, or a typo silently
    // becomes a setting nobody chose.
    for (const v of ['gren', 'colr', 'yes', '']) expect(parseMirrorMode(v)).toBeNull()
  })
})

// ── the stream must not be opened twice ────────────────────────────────────────────────────
//
// `startStreamAsync` closes the live EventSource and then awaits a ticket before opening the
// next one. A second caller inside that window finds nothing to stop and opens its own: both
// assign `es`, so the loser is open, receiving, and unreferenced. Boot makes two such calls.

describe('the stream open is guarded against its own await', () => {
  const fn = clientSource()
    .fn('startStreamAsync')
    .between('async function startStreamAsync', 'src.onopen =')

  it('takes a generation before the await and bails if superseded after it', () => {
    const iGen = fn.indexOf('const gen = ++streamGen')
    const iAwait = fn.indexOf('await streamTicket()')
    const iGuard = fn.indexOf('if (gen !== streamGen) return')
    const iOpen = fn.indexOf('new EventSource')
    expect(iGen).toBeGreaterThan(-1)
    expect(iAwait).toBeGreaterThan(iGen)
    expect(iGuard).toBeGreaterThan(iAwait)
    expect(iOpen).toBeGreaterThan(iGuard) // and the bail is before anything is opened
  })

  it('still closes the previous stream on the way in', () => {
    expect(fn.indexOf('stopStream()')).toBeGreaterThan(-1)
    expect(fn.indexOf('stopStream()')).toBeLessThan(fn.indexOf('await streamTicket()'))
  })
})

// ── mruOrderWindows — the same order, over the raw list (docs/phone-ui.md) ─────────────────
//
// The phone's `task` palette cannot use `mruOrderItems(buildMenuItems(...))`: that path
// cuts every label to the width of a lens row, which is a property of the lens. These cases pin
// that this one keeps whole titles and still agrees
// with the glasses about the order — the one thing the two surfaces must not disagree about.

describe('mruOrderWindows — every window, whole titles, same recency rule', () => {
  const win = (id: string, title: string, active = false): WinInfo => ({
    id,
    wid: `0x40000${id}`,
    cls: '',
    title,
    active,
  })
  const titles = (l: readonly WinInfo[]) => l.map(w => w.title)

  it('is most-recently-focused first', () => {
    const list = [win('1', 'bash'), win('2', 'vim'), win('3', 'less')]
    expect(titles(mruOrderWindows(list, ['0x400003', '0x400001', '0x400002']))).toEqual([
      'less',
      'bash',
      'vim',
    ])
  })

  it('agrees with the glasses: same inputs, same window order', () => {
    const list = [win('1', 'bash'), win('2', 'vim'), win('3', 'less')]
    const recent = ['0x400002', '0x400003', '0x400001']
    const glasses = mruOrderItems(buildMenuItems(list), recent)
      .filter(i => i.kind === 'window')
      .map(i => i.itemName)
    expect(titles(mruOrderWindows(list, recent))).toEqual(glasses)
  })

  it('keeps unranked windows after the ranked ones, in their own order (stable)', () => {
    const list = [win('1', 'bash'), win('2', 'vim'), win('3', 'less')]
    expect(titles(mruOrderWindows(list, ['0x400003']))).toEqual(['less', 'bash', 'vim'])
    expect(titles(mruOrderWindows(list, []))).toEqual(['bash', 'vim', 'less'])
    // No recency known at all is the identity, never a throw (`setWindows` can leave it empty).
    expect(titles(mruOrderWindows(list, undefined))).toEqual(['bash', 'vim', 'less'])
  })

  it('drops a window with no wid — there is no stable key to select it by', () => {
    const noxid = { id: '9', wid: '', cls: 'XTerm', title: 'ghost', active: false }
    expect(titles(mruOrderWindows([win('1', 'bash'), noxid], ['0x400001']))).toEqual(['bash'])
  })

  it("does not truncate — that is what makes it the phone's builder", () => {
    const long = 'x'.repeat(200)
    const many = Array.from({ length: 20 }, (_, i) => win(String(i), `${long}${String(i)}`))
    const out = mruOrderWindows(many, [])
    expect(out).toHaveLength(20)
    expect(out[0]?.title).toHaveLength(201)
    // …while the glasses' builder keeps every window too, but cuts each label.
    const glasses = buildMenuItems(many).filter(i => i.kind === 'window')
    expect(glasses).toHaveLength(20)
    expect(glasses[0]?.itemName).toHaveLength(48)
  })

  it('is a permutation of the selectable windows — the same objects', () => {
    const list = [win('1', 'bash'), win('2', 'vim')]
    const out = mruOrderWindows(list, ['0x400002'])
    expect(new Set(out)).toEqual(new Set(list))
  })
})
