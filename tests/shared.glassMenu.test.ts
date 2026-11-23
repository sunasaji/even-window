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
  isRatpoisonKey,
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

/** The ordinary case: a window is focused, nothing armed. */
const ST: MenuState = { mods: [], invert: false, hasWindow: true }

const utf8 = (s: string) => new TextEncoder().encode(s).length

describe('the row budget', () => {
  // The panel's capacity (10 full lines = header + 9 rows) is the limit that binds, for a
  // level and for the root list alike.
  it('fits the overlay panel, and the root list has the same budget', () => {
    expect(LEVEL_MAX_ROWS).toBe(9)
    expect(ROOT_MAX_ROWS).toBe(LEVEL_MAX_ROWS)
    expect(LEVEL_MAX_CONTENT).toBe(LEVEL_MAX_ROWS - 1)
  })

  it('is spent by every reachable level, Back included', () => {
    for (const id of reachableLevels(ST)) {
      const rows = levelRows(id, ST)
      expect(rows, id).not.toBeNull()
      expect(rows!.length, `${id} has ${String(rows!.length)} rows`).toBeLessThanOrEqual(
        LEVEL_MAX_ROWS,
      )
      expect(rows!.length, id).toBeGreaterThan(1) // content + Back; a Back-only level is a dead end
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

  it('ends every level with exactly one Back row', () => {
    for (const id of reachableLevels(ST)) {
      const rows = levelRows(id, ST)!
      expect(rows[rows.length - 1], id).toEqual({ label: BACK_LABEL, token: BACK_TOKEN })
      expect(rows.filter(r => r.token === BACK_TOKEN).length, id).toBe(1)
    }
  })

  it('never repeats a token within a level', () => {
    for (const id of reachableLevels(ST)) {
      const tokens = levelRows(id, ST)!.map(r => r.token)
      expect(new Set(tokens).size, id).toBe(tokens.length)
    }
  })

  // ASCII only: the firmware font's coverage is unknown, and tofu is indistinguishable from a
  // broken menu. The 32-byte cap is the root list's label limit.
  it('labels in plain ASCII, within the label cap', () => {
    for (const id of reachableLevels(ST)) {
      for (const r of levelRows(id, ST)!) {
        expect(r.label, `${id}: ${r.label}`).toMatch(/^[\x20-\x7e]+$/)
        expect(utf8(r.label), `${id}: ${r.label}`).toBeLessThanOrEqual(32)
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

  // The two actions that cannot be undone must never be one pick deep.
  it('puts both irreversible actions behind a confirm level', () => {
    const kill = RP_KEYS.find(k => k.destructive)!
    for (const id of reachableLevels(ST)) {
      const rows = levelRows(id, ST)!
      const direct = rows.filter(r => r.token === 'exit' || r.token === `rp:${kill.key}`)
      if (direct.length) expect(['cexit', 'rpkill'], `${id} acts directly`).toContain(id)
    }
    // And the confirm levels are reachable, so the actions are not merely hidden.
    expect((levelRows('cexit', ST) ?? []).map(r => r.token)).toContain('exit')
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
      BACK_LABEL,
    ])
    // 12 function keys page 6+6 rather than 9+3, and the row spells both pages out.
    expect(levelRows('kfn', ST)!.map(r => r.label)).toEqual([
      'F1 F2 F3 F4 F5 F6',
      'F7 F8 F9 F10 F11 F12',
      BACK_LABEL,
    ])
    expect(levelRows('kfn/0', ST)!.map(r => r.label)).toEqual([
      'F1',
      'F2',
      'F3',
      'F4',
      'F5',
      'F6',
      BACK_LABEL,
    ])
    // 26 letters page 7+7+7+5; 10 digits page 5+5 (not 8+2). Single-character pages are
    // enumerated, spaced (the panel font is proportional) and carry no `...`: on the
    // punctuation page `.` is itself a selectable character.
    expect(levelRows('kletters', ST)!.map(r => r.label)).toEqual([
      'a b c d e f g',
      'h i j k l m n',
      'o p q r s t u',
      'v w x y z',
      BACK_LABEL,
    ])
    expect(levelRows('kdigits', ST)!.map(r => r.label)).toEqual([
      '0 1 2 3 4',
      '5 6 7 8 9',
      BACK_LABEL,
    ])
    expect(levelRows('kpunct', ST)!.map(r => r.label)[0]).toBe('- = [ ] \\ ;')
  })

  it('drops a page index that is out of range rather than clamping it', () => {
    expect(levelRows('kfn/2', ST)).toBeNull()
    expect(levelRows('kfn/-1', ST)).toBeNull()
    expect(levelRows('kfn/x', ST)).toBeNull()
  })

  it('shows the sticky modifiers armed', () => {
    expect(levelRows('kmods', ST)!.map(r => r.label)).toEqual([
      '[ ] Ctrl',
      '[ ] Alt',
      '[ ] Shift',
      BACK_LABEL,
    ])
    const armed: MenuState = { ...ST, mods: ['ctrl', 'shift'] }
    expect(levelRows('kmods', armed)!.map(r => r.label)).toEqual([
      '[x] Ctrl',
      '[ ] Alt',
      '[x] Shift',
      BACK_LABEL,
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
    expect(parseToken('exit')).toEqual({ kind: 'exit' })
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
    for (const token of ['rp:question', 'close', 'exit', 'invert']) {
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
      expect(utf8(r.label)).toBeLessThanOrEqual(32)
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
