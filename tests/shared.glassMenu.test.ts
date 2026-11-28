// Unit tests for the hierarchical glasses menu (src/shared/glassMenu.ts).
//
// Most of this file walks the whole tree, because these failures are whole-tree properties:
//
//   * a level that overflows the panel,
//   * a `sub:` pointing at a level that does not exist,
//   * a `key:` leaf outside the closed catalogue, which sends nothing,
//   * a label that is not ASCII and may render as tofu,
//   * a destructive row reachable in one pick.
//
// The gesture rule and the paging are pinned as ordinary tables.

import { describe, expect, it } from 'vitest'
import { ROOT_MAX_ROWS } from '../src/client/menuModel.ts'
import {
  BACK_LABEL,
  BACK_TOKEN,
  balancedChunk,
  CONFIRM_LABEL,
  clickInput,
  fitUnits,
  indexLabel,
  isRatpoisonKey,
  LAUNCH_ID,
  LEVEL_MAX_CONTENT,
  LEVEL_MAX_ROWS,
  levelRows,
  MENU_ROOT_ID,
  MENU_ROOT_TOKEN,
  type MenuState,
  menuActionFor,
  pageLabel,
  parseToken,
  pathHeader,
  ROW_LABEL_UNITS,
  RP_KEYS,
  RP_LEVEL_LABEL,
  RP_PREFIX,
  ratpoisonArgs,
  reachableLevels,
  resumablePath,
  rowMenuEffect,
  windowPanelRows,
} from '../src/shared/glassMenu.ts'
import { KEYS } from '../src/shared/keys.ts'
import { glassWidth } from '../src/shared/voiceDialog.ts'

/** The ordinary case: a window is focused, nothing armed. */
const ST: MenuState = { mods: [], invert: false, hasWindow: true }

describe('the row budget', () => {
  // The panel's capacity (10 full lines = header + 9 rows) is the limit that binds, for a
  // level and for the root list alike.
  it('fits the overlay panel, and the root list has the same budget', () => {
    expect(LEVEL_MAX_ROWS).toBe(9)
    expect(ROOT_MAX_ROWS).toBe(LEVEL_MAX_ROWS)
    // No level spends a row on `< Back`: a double-tap ascends.
    expect(LEVEL_MAX_CONTENT).toBe(LEVEL_MAX_ROWS)
  })

  it('is spent by every reachable level', () => {
    for (const id of reachableLevels(ST)) {
      const rows = levelRows(id, ST)
      expect(rows, id).not.toBeNull()
      expect(rows!.length, `${id} has ${String(rows!.length)} rows`).toBeLessThanOrEqual(
        LEVEL_MAX_ROWS,
      )
      expect(rows!.filter(r => r.token !== BACK_TOKEN).length, id).toBeGreaterThan(0) // no dead end
    }
  })
})

describe('the tree', () => {
  it('reaches every level it names (no dead sub: targets)', () => {
    const levels = reachableLevels(ST)
    for (const id of levels) {
      for (const r of levelRows(id, ST)!) {
        const t = parseToken(r.token)
        expect(t, `${id}: ${r.token}`).not.toBeNull()
        if (t?.kind === 'sub') {
          expect(levelRows(t.id, ST), `${id} -> ${t.id}`).not.toBeNull()
          expect(levels, `${id} -> ${t.id}`).toContain(t.id)
        }
      }
    }
  })

  // A double-tap ascends, and the header says so, so a level spends no row on it. A
  // confirmation keeps the row: its only other row is the action, and the cursor needs
  // somewhere to rest that does nothing.
  it('gives a Back row to the confirmation levels and to no other', () => {
    for (const id of reachableLevels(ST)) {
      const rows = levelRows(id, ST)!
      const backs = rows.filter(r => r.token === BACK_TOKEN)
      if (id === 'rpkill') {
        expect(rows[rows.length - 1], id).toEqual({ label: BACK_LABEL, token: BACK_TOKEN })
        expect(backs.length, id).toBe(1)
      } else {
        expect(backs.length, id).toBe(0)
      }
    }
  })

  it('never repeats a token within a level', () => {
    for (const id of reachableLevels(ST)) {
      const tokens = levelRows(id, ST)!.map(r => r.token)
      expect(new Set(tokens).size, id).toBe(tokens.length)
    }
  })

  // ASCII only: the firmware font's coverage is unknown, and tofu is indistinguishable from a
  // broken menu. The cap is the width of a row.
  it('labels in plain ASCII, within the row width', () => {
    for (const id of reachableLevels(ST)) {
      for (const r of levelRows(id, ST)!) {
        expect(r.label, `${id}: ${r.label}`).toMatch(/^[\x20-\x7e]+$/)
        expect(glassWidth(r.label), `${id}: ${r.label}`).toBeLessThanOrEqual(ROW_LABEL_UNITS)
      }
    }
  })

  it('offers no window action when there is no window', () => {
    const none: MenuState = { ...ST, hasWindow: false }
    const tokens = (id: string) => (levelRows(id, none) ?? []).map(r => r.token)
    expect(tokens(MENU_ROOT_ID)).not.toContain('close')
    // Kill acts on the focused window too, so it is hidden along with Close Window.
    expect(tokens('rp').join('|')).not.toContain('rpkill')
    // The ordinary state has both.
    expect((levelRows(MENU_ROOT_ID, ST) ?? []).map(r => r.token)).toContain('close')
  })

  // The action that cannot be undone must never be one pick deep. Leaving the app is not in
  // this menu at all: `Disconnect` goes back to the server list, which is undone by a tap.
  it('puts the irreversible action behind a confirm level', () => {
    const kill = RP_KEYS.find(k => k.destructive)!
    for (const id of reachableLevels(ST)) {
      const rows = levelRows(id, ST)!
      const direct = rows.filter(r => r.token === `rp:${kill.key}`)
      if (direct.length) expect(['rpkill'], `${id} acts directly`).toContain(id)
      expect(
        rows.map(r => r.token),
        id,
      ).not.toContain('exit')
    }
    // And the confirm levels are reachable, so the actions are not merely hidden.
    expect(levelRows('cexit', ST)).toBeNull()
    expect(levelRows(MENU_ROOT_ID, ST)!.map(r => r.token)).toContain('disconnect')
    expect((levelRows('rpkill', ST) ?? []).map(r => r.token)).toContain(`rp:${kill.key}`)
  })

  it("does not know the root level: that is buildMenuItems' job", () => {
    expect(levelRows('root', ST)).toBeNull()
    // It owns the row that enters the hierarchy, so the two agree on one token.
    expect(parseToken(MENU_ROOT_TOKEN)).toEqual({ kind: 'sub', id: MENU_ROOT_ID })
  })
})

describe('the Keys levels', () => {
  // Coverage: a key added to the catalogue with no home in the menu would be bindable to a
  // swipe and unreachable from the glasses, so set equality is pinned. The wheel entries are
  // excluded: they are pointer buttons and this menu only sends keys. Any other new group
  // still has to appear here.
  it('reach every key in the catalogue, and nothing else', () => {
    const leaves = new Set<string>()
    for (const id of reachableLevels(ST)) {
      for (const r of levelRows(id, ST)!) {
        const t = parseToken(r.token)
        if (t?.kind === 'key') leaves.add(t.key)
      }
    }
    expect([...leaves].sort()).toEqual(
      KEYS.filter(k => !k.wheel)
        .map(k => k.name)
        .sort(),
    )
  })

  it('page the long groups and leave the short ones flat', () => {
    // nav is 8 keys: under the content budget, so the level is the leaves.
    const move = levelRows('kmove', ST)!
    expect(move.map(r => r.label)).toEqual([
      'Up',
      'Down',
      'Left',
      'Right',
      'PgUp',
      'PgDn',
      'Home',
      'End',
    ])
    // 12 function keys page 6+6 rather than 9+3, and the row spells both pages out.
    expect(levelRows('kfn', ST)!.map(r => r.label)).toEqual([
      'F1 F2 F3 F4 F5 F6',
      'F7 F8 F9 F10 F11 F12',
    ])
    expect(levelRows('kfn/0', ST)!.map(r => r.label)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6'])
    // 26 letters page 9+9+8; 10 digits page 5+5 (not 9+1). Single-character pages are
    // enumerated, spaced (the panel font is proportional) and carry no `...`: on the
    // punctuation page `.` is itself a selectable character.
    expect(levelRows('kletters', ST)!.map(r => r.label)).toEqual([
      'a b c d e f g h i',
      'j k l m n o p q r',
      's t u v w x y z',
    ])
    expect(levelRows('kdigits', ST)!.map(r => r.label)).toEqual(['0 1 2 3 4', '5 6 7 8 9'])
    expect(levelRows('kpunct', ST)!.map(r => r.label)[0]).toBe('- = [ ] \\ ;')
  })

  it('drops a page index that is out of range rather than clamping it', () => {
    expect(levelRows('kfn/2', ST)).toBeNull()
    expect(levelRows('kfn/-1', ST)).toBeNull()
    expect(levelRows('kfn/x', ST)).toBeNull()
  })

  it('shows the sticky modifiers armed', () => {
    expect(levelRows('kmods', ST)!.map(r => r.label)).toEqual(['[ ] Ctrl', '[ ] Alt', '[ ] Shift'])
    const armed: MenuState = { ...ST, mods: ['ctrl', 'shift'] }
    expect(levelRows('kmods', armed)!.map(r => r.label)).toEqual([
      '[x] Ctrl',
      '[ ] Alt',
      '[x] Shift',
    ])
  })

  it('marks the invert toggle from live state', () => {
    const on = levelRows(MENU_ROOT_ID, { ...ST, invert: true })!
    expect(on.find(r => r.token === 'invert')?.label).toBe('[x] Invert')
    expect(levelRows(MENU_ROOT_ID, ST)!.find(r => r.token === 'invert')?.label).toBe('[ ] Invert')
  })
})

describe('the ratpoison catalogue', () => {
  it('is a closed set', () => {
    for (const k of RP_KEYS) expect(isRatpoisonKey(k.key)).toBe(true)
    // Plausible things a caller might send instead. `delete` is the ratpoison command name,
    // not a key; the route takes keys.
    for (const bad of ['', 'x', 'Q', 'escape', 'delete', 'C-t', 'ctrl+T', 'question?']) {
      expect(isRatpoisonKey(bad), bad).toBe(false)
    }
    expect(isRatpoisonKey(undefined)).toBe(false)
    expect(isRatpoisonKey(42)).toBe(false)
  })

  it('sends the prefix and the key as one invocation', () => {
    expect(ratpoisonArgs('question')).toEqual([RP_PREFIX, 'question'])
    expect(ratpoisonArgs('ctrl+t')).toEqual([RP_PREFIX, 'ctrl+t']) // C-t C-t = `other`
    expect(ratpoisonArgs('Q')).toBeNull()
  })

  it('has every entry reachable from the menu', () => {
    const reached = new Set<string>()
    for (const id of reachableLevels(ST)) {
      for (const r of levelRows(id, ST)!) {
        const t = parseToken(r.token)
        if (t?.kind === 'rp') reached.add(t.key)
      }
    }
    expect([...reached].sort()).toEqual(RP_KEYS.map(k => k.key).sort())
  })
})

describe('parseToken', () => {
  it('names the kinds the action router switches on', () => {
    expect(parseToken('back')).toEqual({ kind: 'back' })
    expect(parseToken('close')).toEqual({ kind: 'close' })
    expect(parseToken('disconnect')).toEqual({ kind: 'disconnect' })
    expect(parseToken('invert')).toEqual({ kind: 'invert' })
    expect(parseToken('sub:keys')).toEqual({ kind: 'sub', id: 'keys' })
    expect(parseToken('key:Page_Up')).toEqual({ kind: 'key', key: 'Page_Up' })
    expect(parseToken('mod:ctrl')).toEqual({ kind: 'mod', mod: 'ctrl' })
    expect(parseToken('click:wheelup')).toEqual({ kind: 'click', action: 'wheelup' })
    expect(parseToken('rp:question')).toEqual({ kind: 'rp', key: 'question' })
  })

  // Refusal, not coercion: an unparseable token is dropped and logged. Validating the
  // argument here stops a mistyped leaf from reaching xdotool.
  it('refuses what it cannot name', () => {
    for (const bad of [
      '',
      'sub',
      'sub:',
      ':keys',
      'nope:1',
      'Back',
      'BACK',
      'key:',
      'key:Enter',
      'key:PageUp',
      'key:nonsense', // tmux-ish spellings are not the catalogue
      'mod:super',
      'mod:',
      'click:middle',
      'rp:Q',
      'rp:',
    ]) {
      expect(parseToken(bad), bad).toBeNull()
    }
  })
})

describe('gestures while a level is open', () => {
  // The depth boundary is the rule: ascend while nested, close at the top.
  it('maps tap and swipe to the obvious things', () => {
    expect(menuActionFor('tap', 1)).toBe('enter')
    expect(menuActionFor('tap', 3)).toBe('enter')
    expect(menuActionFor('swipe-up', 2)).toBe('up')
    expect(menuActionFor('swipe-down', 2)).toBe('down')
  })

  it('ascends on a double-tap while nested and closes at the top', () => {
    expect(menuActionFor('double', 1)).toBe('close') // the top level closes
    expect(menuActionFor('double', 2)).toBe('ascend')
    expect(menuActionFor('double', 9)).toBe('ascend')
  })
})

describe('paging helpers', () => {
  it('balances rather than leaving a runt page', () => {
    expect(balancedChunk([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 8).map(p => p.length)).toEqual([5, 5])
    expect(
      balancedChunk(
        Array.from({ length: 26 }, (_v, i) => i),
        8,
      ).map(p => p.length),
    ).toEqual([7, 7, 7, 5])
    expect(
      balancedChunk(
        Array.from({ length: 12 }, (_v, i) => i),
        8,
      ).map(p => p.length),
    ).toEqual([6, 6])
  })

  it('keeps a short list in one page and an empty list in none', () => {
    expect(balancedChunk([1, 2, 3], 8)).toEqual([[1, 2, 3]])
    expect(balancedChunk([1, 2, 3], 3)).toEqual([[1, 2, 3]])
    expect(balancedChunk([], 8)).toEqual([])
  })

  it('cannot be made to loop on a zero page size', () => {
    expect(balancedChunk([1, 2], 0)).toEqual([[1, 2]])
    expect(balancedChunk([1, 2], -1)).toEqual([[1, 2]])
  })

  // Spaced, and with no descend marker: on the punctuation page a trailing `...` would read
  // as three more selectable dots.
  it('enumerates a page of single characters, spaced and unmarked', () => {
    expect(pageLabel(['a', 'b', 'c'])).toBe('a b c')
    expect(pageLabel(['-', '=', '['])).toBe('- = [')
    expect(pageLabel(['a'])).toBe('a')
  })

  // Multi-character entries are enumerated too, not shown as a range.
  it('enumerates multi-character entries the same way', () => {
    expect(pageLabel(['F1', 'F2', 'F3', 'F4', 'F5', 'F6'])).toBe('F1 F2 F3 F4 F5 F6')
    expect(pageLabel(['KP +', 'KP -'])).toBe('KP + KP -')
  })
})

describe('the overlay header', () => {
  it('reads as the rows the user picked, without their descend marker', () => {
    expect(pathHeader(['Menu...'])).toBe('Menu')
    expect(pathHeader(['Menu...', 'Keys...', 'Chars...'])).toBe('Menu > Keys > Chars')
    expect(pathHeader([])).toBe('')
  })
})

describe('pointer rows', () => {
  it('know that xdotool buttons 4 and 5 are the wheel', () => {
    expect(clickInput('click')).toEqual({ kind: 'click', arg: '1' })
    expect(clickInput('dblclick')).toEqual({ kind: 'dblclick', arg: '1' })
    expect(clickInput('hold')).toEqual({ kind: 'down', arg: '1' })
    expect(clickInput('release')).toEqual({ kind: 'up', arg: '1' })
    expect(clickInput('wheelup')).toEqual({ kind: 'click', arg: '4' })
    expect(clickInput('wheeldown')).toEqual({ kind: 'click', arg: '5' })
  })
})

// ── what a row does to the menu itself ─────────────────────────────────────────────────────
//
// The open menu blanks all four tiles, so a row whose effect lands on the desktop is invisible
// behind it. The rule: close unless the row's job is unfinished.

describe('rowMenuEffect', () => {
  it('stays open only for navigation and the sticky modifiers', () => {
    expect(rowMenuEffect('sub:keys')).toBe('stay')
    expect(rowMenuEffect(BACK_TOKEN)).toBe('stay')
    expect(rowMenuEffect('mod:ctrl')).toBe('stay')
  })

  // The Keys branch is the one exception to "a finished operation returns to the top": typing
  // is a sequence, and Click-hold needs a cheap Click-release.
  it('remembers the level for the Keys branch, and only for it', () => {
    expect(rowMenuEffect('key:Return')).toBe('resume')
    expect(rowMenuEffect('click:hold')).toBe('resume')
    expect(rowMenuEffect('click:wheelup')).toBe('resume')
  })

  // Everything else ends the interaction; repetition belongs on a per-app swipe binding.
  it('returns to the top for a finished operation', () => {
    for (const token of ['rp:question', 'close', 'disconnect', 'invert']) {
      expect(rowMenuEffect(token), token).toBe('reset')
    }
  })

  // An unparseable token does nothing, so it must not dismiss the menu either.
  it('leaves the menu alone for a token it cannot parse', () => {
    expect(rowMenuEffect('nope:1')).toBe('stay')
  })

  // The whole tree, so a row added later cannot inherit the wrong rule unnoticed.
  it('classifies every row in the tree', () => {
    for (const id of reachableLevels(ST)) {
      for (const r of levelRows(id, ST)!) {
        const t = parseToken(r.token)!
        const want =
          t.kind === 'sub' || t.kind === 'back' || t.kind === 'mod'
            ? 'stay'
            : t.kind === 'key' || t.kind === 'click'
              ? 'resume'
              : 'reset'
        expect(rowMenuEffect(r.token), `${id}: ${r.label}`).toBe(want)
      }
    }
  })
})

describe('resumablePath', () => {
  it('keeps a path whose levels all still exist', () => {
    expect(resumablePath([MENU_ROOT_ID, 'keys', 'kchars'], ST)).toEqual([
      MENU_ROOT_ID,
      'keys',
      'kchars',
    ])
  })

  // The level that can vanish under a remembered path: Kill is hidden once there is no window.
  it('trims at the first level the state no longer has', () => {
    const none: MenuState = { ...ST, hasWindow: false }
    expect(resumablePath([MENU_ROOT_ID, 'rp', 'rpkill'], ST)).toEqual([
      MENU_ROOT_ID,
      'rp',
      'rpkill',
    ])
    expect(resumablePath([MENU_ROOT_ID, 'rp', 'rpkill'], none)).toEqual([MENU_ROOT_ID, 'rp'])
  })

  it('gives up entirely on a path that no longer resolves at all', () => {
    expect(resumablePath(['nosuchlevel', 'keys'], ST)).toEqual([])
    expect(resumablePath([], ST)).toEqual([])
  })
})

// ── the phone's `window` palette (docs/phone-ui.md) ────────────────────────────────────────
//
// The palette is the same catalogue, in the same order, with the same tokens as the glasses
// level; it must not become a second implementation of the WM rows.

describe('windowPanelRows: the same rows, minus what is glasses-specific', () => {
  it('is the RP_KEYS catalogue in its own order, one row each', () => {
    const rows = windowPanelRows(ST)
    expect(rows.filter(r => r.token.startsWith('rp:')).map(r => r.token)).toEqual(
      RP_KEYS.map(k => `rp:${k.key}`),
    )
    // The labels are the catalogue's too.
    expect(rows.filter(r => r.token.startsWith('rp:')).map(r => r.label)).toEqual(
      RP_KEYS.map(k => k.label),
    )
  })

  it('carries `confirm` on exactly the destructive entries', () => {
    const rows = windowPanelRows(ST)
    const confirmed = rows.filter(r => r.confirm).map(r => r.token)
    expect(confirmed).toEqual(RP_KEYS.filter(k => k.destructive).map(k => `rp:${k.key}`))
    // The token is the same one the glasses' confirm level sends, so `runRowToken` cannot
    // tell the two surfaces apart.
    const kill = RP_KEYS.find(k => k.destructive)!
    expect((levelRows('rpkill', ST) ?? []).map(r => r.token)).toContain(`rp:${kill.key}`)
    expect(confirmed).toContain(`rp:${kill.key}`)
  })

  it('has Close Window inline: the row is here, not one level up as on the glasses', () => {
    expect(windowPanelRows(ST).map(r => r.token)).toContain('close')
    // On the glasses it lives in the level above the catalogue.
    expect((levelRows(MENU_ROOT_ID, ST) ?? []).map(r => r.token)).toContain('close')
    expect((levelRows('rp', ST) ?? []).map(r => r.token)).not.toContain('close')
  })

  it('hides every row that needs a window when there is none', () => {
    const rows = windowPanelRows({ ...ST, hasWindow: false })
    expect(rows.map(r => r.token)).not.toContain('close')
    expect(rows.some(r => r.confirm)).toBe(false)
    expect(rows.length).toBe(RP_KEYS.filter(k => !k.destructive).length)
  })

  it('has no Back row, no descents and no pages: those are glasses properties', () => {
    for (const s of [ST, { ...ST, hasWindow: false }]) {
      for (const r of windowPanelRows(s)) {
        expect(r.token).not.toBe(BACK_TOKEN)
        expect(r.token.startsWith('sub:'), r.token).toBe(false)
        expect(r.label).not.toContain('...')
      }
    }
  })

  it('is ASCII and within the label cap, like every row in this file', () => {
    for (const r of [...windowPanelRows(ST), { label: CONFIRM_LABEL }]) {
      expect(r.label).toMatch(/^[\x20-\x7e]+$/)
      expect(glassWidth(r.label)).toBeLessThanOrEqual(ROW_LABEL_UNITS)
    }
  })

  it('every token it emits is one `runRowToken` acts on (no navigation kinds)', () => {
    for (const r of windowPanelRows(ST)) {
      const t = parseToken(r.token)
      expect(t, r.token).not.toBeNull()
      expect(['rp', 'close']).toContain(t!.kind)
      // `reset` = the surface closes afterwards.
      expect(rowMenuEffect(r.token)).toBe('reset')
    }
  })
})

describe('the level is called `Window...`, never `Ratpoison...`', () => {
  it('names the job on the row and the implementation only in the code', () => {
    expect(RP_LEVEL_LABEL).toBe('Window...')
    const labels = (levelRows(MENU_ROOT_ID, ST) ?? []).map(r => r.label)
    expect(labels).toContain(RP_LEVEL_LABEL)
    // Singular: the phone's `task` palette lists windows; this level acts on the focused one.
    expect(labels).not.toContain('Windows...')
    // No label anywhere in the tree names the window manager.
    for (const id of reachableLevels(ST)) {
      for (const r of levelRows(id, ST)!) {
        expect(r.label.toLowerCase(), `${id}: ${r.label}`).not.toContain('ratpoison')
      }
    }
    // The token still names it, matching the server's closed set.
    expect((levelRows(MENU_ROOT_ID, ST) ?? []).find(r => r.label === RP_LEVEL_LABEL)?.token).toBe(
      'sub:rp',
    )
  })
})

describe('Menu... level — the root list page turns', () => {
  const ST2: MenuState = { mods: [], invert: false, hasWindow: true }

  it('ends with Prev Page / Next Page only while the root list is paged', () => {
    const one = levelRows(MENU_ROOT_ID, ST2)!.map(r => r.label)
    expect(one.at(-1)).toBe('Disconnect')
    expect(one).not.toContain('Next Page')
    // The fullest it gets: every optional row present.
    const full: MenuState = { ...ST2, rootPaged: true, apps: [{ id: 'a', name: 'a' }] }
    const paged = levelRows(MENU_ROOT_ID, full)!
    expect(paged.slice(-3).map(r => r.label)).toEqual(['Disconnect', 'Prev Page', 'Next Page'])
    expect(paged.length).toBeLessThanOrEqual(LEVEL_MAX_ROWS)
    // Only the Menu... level.
    expect(levelRows('keys', full)!.map(r => r.label)).not.toContain('Next Page')
  })

  it('parses the page tokens as navigation that keeps the menu up', () => {
    expect(parseToken('page:prev')).toEqual({ kind: 'page', dir: -1 })
    expect(parseToken('page:next')).toEqual({ kind: 'page', dir: 1 })
    expect(parseToken('page:up')).toBeNull()
    expect(rowMenuEffect('page:next')).toBe('stay')
  })
})

describe('Launch... — every application, whatever the count', () => {
  const pad = (i: number) => String(i).padStart(3, '0')
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `x11:app${pad(i)}`, name: `App ${pad(i)}` }))
  const st = (n: number): MenuState => ({ ...ST, apps: many(n) })
  /** Every `app:` id reachable from `Launch...`, in the order the rows are met. */
  const leaves = (s: MenuState): string[] => {
    const out: string[] = []
    const walk = (id: string) => {
      const rows = levelRows(id, s)
      expect(rows, id).not.toBeNull()
      expect(rows!.length, id).toBeLessThanOrEqual(LEVEL_MAX_ROWS)
      for (const r of rows!) {
        expect(glassWidth(r.label), `${id}: ${r.label}`).toBeLessThanOrEqual(ROW_LABEL_UNITS)
        const t = parseToken(r.token)
        if (t?.kind === 'sub') walk(t.id)
        else if (t?.kind === 'app') out.push(t.id)
        else throw new Error(`${id}: unexpected ${r.token}`)
      }
    }
    walk(LAUNCH_ID)
    return out
  }

  it('sits under Window... and only when there is something to launch', () => {
    expect(levelRows(MENU_ROOT_ID, ST)!.map(r => r.label)).not.toContain('Launch...')
    expect(levelRows(LAUNCH_ID, ST)).toBeNull()
    const labels = levelRows(MENU_ROOT_ID, st(1))!.map(r => r.label)
    expect(labels.indexOf('Launch...')).toBe(labels.indexOf('Window...') + 1)
  })

  it('lists up to nine applications directly, in name order whatever the case', () => {
    const s: MenuState = {
      ...ST,
      apps: [
        { id: 'c', name: 'xterm' },
        { id: 'a', name: 'Firefox' },
        { id: 'b', name: 'gedit' },
      ],
    }
    expect(levelRows(LAUNCH_ID, s)).toEqual([
      { label: 'Firefox', token: 'app:a' },
      { label: 'gedit', token: 'app:b' },
      { label: 'xterm', token: 'app:c' },
    ])
  })

  // The count is whatever the machine has installed, so no count may overflow a level or
  // lose an application: 81 fills two levels exactly, 82 needs a third.
  it.each([1, 9, 10, 81, 82, 300, 800])('reaches each of %i applications once', n => {
    expect(leaves(st(n))).toEqual(many(n).map(a => a.id))
  })

  it('adds a level only when the pages no longer fit in one', () => {
    const depth = (s: MenuState): number => {
      let id = LAUNCH_ID
      for (let d = 1; ; d++) {
        const t = parseToken(levelRows(id, s)![0]!.token)
        if (t?.kind !== 'sub') return d
        id = t.id
      }
    }
    expect([9, 10, 81, 82].map(n => depth(st(n)))).toEqual([1, 2, 2, 3])
  })

  it('names a page by its range and the start of each name in it', () => {
    const names = ['Files', 'Firefox', 'Firefox ESR', 'GIMP', 'Gnome Terminal']
    expect(indexLabel('Files', 'Gnome Terminal', names)).toEqual({
      // As much of each name as lets them all fit; neighbours that start alike are listed once.
      label: 'Fi-Gn (Files|Firefox|GIMP|Gnome Te)',
      crumb: 'Fi-Gn',
    })
    // Alike whatever the case, which is how the names are ordered.
    expect(indexLabel('Rofi', 'rxvt', ['Rofi', 'rofi theme', 'Rofi Theme', 'rxvt']).label).toBe(
      'Ro-rx (Rofi|rofi the|rxvt)',
    )
    const row = levelRows(LAUNCH_ID, st(10))![0]!
    expect(row.label).toBe('Ap-Ap (App 000|App 001|App 002|App 003|App 004)')
    expect(row.crumb).toBe('Ap-Ap')
  })

  const listed = (label: string) => label.slice(label.indexOf('(') + 1, -1).split('|')

  it('shortens every entry before it leaves one out', () => {
    const names = Array.from({ length: 9 }, (_, i) => `${'abcdefgh'[i]}oooooooo`)
    const { label } = indexLabel(names[0]!, names[8]!, names)
    const parts = listed(label)
    expect(parts).toHaveLength(9)
    expect(parts[0]).toMatch(/^ao{3,6}$/) // shorter than the eight it would take alone
    expect(indexLabel('aoooooooo', 'boooooooo', names.slice(0, 2)).label).toBe(
      'ao-bo (aooooooo|booooooo)',
    )
    expect(glassWidth(label)).toBeLessThanOrEqual(ROW_LABEL_UNITS)
  })

  it('cuts the list at the width budget and says so', () => {
    const names = Array.from({ length: 9 }, (_, i) => `${'ABCDEFGH J'[i === 8 ? 9 : i]}WWWWWWW`)
    const { label } = indexLabel(names[0]!, names[8]!, names)
    const parts = listed(label)
    expect(parts.at(-1)).toBe('...')
    expect(parts.length).toBeLessThan(10)
    expect(parts[0]).toBe('AWWW') // the shortest an entry gets
    expect(glassWidth(label)).toBeLessThanOrEqual(ROW_LABEL_UNITS)
  })

  // An index row is mostly `|` and lower case; a row of capitals is far wider per character.
  it('weighs narrow glyphs and capitals, so the budget is a width and not a count', () => {
    expect(fitUnits('W'.repeat(80), ROW_LABEL_UNITS).length).toBeLessThan(
      fitUnits('i'.repeat(200), ROW_LABEL_UNITS).length / 2,
    )
  })

  it('counts a CJK name as wide, and never splits a character', () => {
    const jp = [
      'ファイル',
      'テキストエディター',
      '端末',
      '設定',
      '電卓',
      '画像ビューアー',
      '文書',
      '表計算',
    ]
    const { label, crumb } = indexLabel('テキストエディター', '表計算', jp)
    expect(crumb).toBe('テキ-表計')
    expect(label.endsWith('...)')).toBe(true)
    expect(glassWidth(label)).toBeLessThanOrEqual(ROW_LABEL_UNITS)
    expect(fitUnits('あいう', 5)).toBe('あい')
    const long: MenuState = { ...ST, apps: [{ id: 'j', name: 'あ'.repeat(40) }] }
    expect(levelRows(LAUNCH_ID, long)![0]!.label).toBe(
      'あ'.repeat(Math.floor(ROW_LABEL_UNITS / 2.25)),
    )
  })

  it('falls back to the id for a nameless entry and drops one with no id', () => {
    const s: MenuState = {
      ...ST,
      apps: [
        { id: 'x11:foo', name: ' ' },
        { id: '', name: 'ghost' },
      ],
    }
    expect(levelRows(LAUNCH_ID, s)).toEqual([{ label: 'x11:foo', token: 'app:x11:foo' }])
  })

  it('launches and returns to the root list, and forgets a path the list no longer has', () => {
    expect(parseToken('app:x11:foo')).toEqual({ kind: 'app', id: 'x11:foo' })
    expect(parseToken('app:')).toBeNull()
    expect(rowMenuEffect('app:x11:foo')).toBe('reset')
    const path = [MENU_ROOT_ID, LAUNCH_ID, 'launch/1']
    expect(resumablePath(path, st(20))).toEqual(path)
    expect(resumablePath(path, st(5))).toEqual([MENU_ROOT_ID, LAUNCH_ID])
    expect(levelRows('launch/x', st(20))).toBeNull()
    expect(levelRows('launch/0/0', st(20))).toBeNull()
  })
})
