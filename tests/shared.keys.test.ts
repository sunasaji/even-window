// Unit tests for the closed key catalogue and the chord it forms (src/shared/keys.ts).
//
// The catalogue exists so that an invalid binding cannot be stored, so most of what is pinned
// here is refusal of plausible-looking names.

import { describe, expect, it } from 'vitest'
import {
  chordCommand,
  chordEq,
  chordLabel,
  chordToXdo,
  GROUP_LABEL,
  isBindableKey,
  isWheelChord,
  KEYS,
  keyDef,
  MODS,
  type Mod,
  NEWLINE_CHORDS,
  NEWLINE_DEFAULT,
  newlineChordById,
  normChord,
  SUBMIT_CHORDS,
  SUBMIT_DEFAULT,
  SUBMIT_GROUP_LABEL,
  submitChordById,
  submitChordLabel,
  wheelButton,
} from '../src/shared/keys.ts'

describe('the catalogue', () => {
  it('has no duplicate keysyms', () => {
    const names = KEYS.map(k => k.name)
    expect(new Set(names).size).toBe(names.length)
  })

  // `name` is the xdotool spelling, which lets chordToXdo be pure concatenation. A name such
  // as `Enter`, `PageUp` or `BSpace` would store fine and send nothing.
  it('stores xdotool spellings, not tmux-style ones', () => {
    expect(isBindableKey('Return')).toBe(true)
    expect(isBindableKey('Page_Up')).toBe(true)
    expect(isBindableKey('BackSpace')).toBe(true)
    expect(isBindableKey('Enter')).toBe(false)
    expect(isBindableKey('PageUp')).toBe(false)
    expect(isBindableKey('BSpace')).toBe(false)
  })

  it('refuses the names a human would plausibly invent', () => {
    for (const bad of ['Pagedown', 'ArrowUp', 'Ctrl', 'ctrl', 'UP', 'up', 'Super_L', '']) {
      expect(isBindableKey(bad)).toBe(false)
    }
    expect(isBindableKey(undefined)).toBe(false)
    expect(isBindableKey(42)).toBe(false)
  })

  it('carries a friendly label where the keysym is not one', () => {
    expect(keyDef('Return')?.label).toBe('Enter')
    expect(keyDef('Page_Up')?.label).toBe('PgUp')
    expect(keyDef('minus')?.label).toBe('-')
    expect(keyDef('nope')).toBeNull()
  })

  it('marks the keys whose Shift produces a different glyph', () => {
    expect(keyDef('a')?.shiftsToGlyph).toBe(true)
    expect(keyDef('2')?.shiftsToGlyph).toBe(true)
    expect(keyDef('minus')?.shiftsToGlyph).toBe(true)
    expect(keyDef('Up')?.shiftsToGlyph).toBeUndefined()
    expect(keyDef('F5')?.shiftsToGlyph).toBeUndefined()
  })

  it('covers the bindings the feature exists for', () => {
    for (const n of [
      'Up',
      'Down',
      'Page_Up',
      'Page_Down',
      'u',
      'd',
      'j',
      'k',
      'p',
      'n',
      'Left',
      'Right',
      'KP_Add',
      'KP_Subtract',
      'F7',
    ]) {
      expect(isBindableKey(n)).toBe(true)
    }
  })
})

describe('normChord', () => {
  it('accepts a bare key and defaults the modifiers to none', () => {
    expect(normChord({ key: 'Up' })).toEqual({ mods: [], key: 'Up' })
    expect(normChord({ key: 'Up', mods: [] })).toEqual({ mods: [], key: 'Up' })
  })

  // These three inputs are the same chord and must canonicalise to one record.
  it('canonicalises modifier order and de-duplicates', () => {
    const want = { mods: ['ctrl', 'alt'], key: 'u' }
    expect(normChord({ mods: ['ctrl', 'alt'], key: 'u' })).toEqual(want)
    expect(normChord({ mods: ['alt', 'ctrl'], key: 'u' })).toEqual(want)
    expect(normChord({ mods: ['alt', 'ctrl', 'ctrl', 'alt'], key: 'u' })).toEqual(want)
    expect(MODS).toEqual(['ctrl', 'alt', 'shift'])
  })

  it('refuses a key outside the catalogue and a mod outside MODS', () => {
    expect(normChord({ key: 'ArrowUp' })).toBeNull()
    expect(normChord({ mods: ['super'], key: 'u' })).toBeNull()
    expect(normChord({ mods: ['Ctrl'], key: 'u' })).toBeNull()
    expect(normChord({ mods: 'ctrl', key: 'u' })).toBeNull()
    expect(normChord({ mods: [], key: '' })).toBeNull()
    expect(normChord('C-u')).toBeNull() // the string form is a label, never a record
    expect(normChord(null)).toBeNull()
    expect(normChord({})).toBeNull()
  })
})

describe('chordToXdo / chordLabel', () => {
  it('spells what xdotool key takes', () => {
    expect(chordToXdo({ mods: [], key: 'Up' })).toBe('Up')
    expect(chordToXdo({ mods: ['ctrl'], key: 'u' })).toBe('ctrl+u')
    expect(chordToXdo({ mods: ['ctrl', 'alt', 'shift'], key: 'Delete' })).toBe(
      'ctrl+alt+shift+Delete',
    )
    // Punctuation is why the catalogue stores keysyms: `ctrl+-` does not parse.
    expect(chordToXdo({ mods: ['ctrl'], key: 'minus' })).toBe('ctrl+minus')
    expect(chordToXdo({ mods: ['shift'], key: 'KP_Add' })).toBe('shift+KP_Add')
  })

  it('spells the short human form', () => {
    expect(chordLabel({ mods: [], key: 'Return' })).toBe('Enter')
    expect(chordLabel({ mods: ['ctrl'], key: 'u' })).toBe('C-u')
    expect(chordLabel({ mods: ['alt'], key: 'k' })).toBe('M-k')
    expect(chordLabel({ mods: ['ctrl', 'alt', 'shift'], key: 'Delete' })).toBe('C-M-S-Del')
    expect(chordLabel({ mods: [], key: 'minus' })).toBe('-')
  })

  it('compares chords by content', () => {
    expect(chordEq({ mods: ['ctrl'], key: 'u' }, { mods: ['ctrl'], key: 'u' })).toBe(true)
    expect(chordEq({ mods: [], key: 'u' }, { mods: ['ctrl'], key: 'u' })).toBe(false)
    expect(chordEq({ mods: ['ctrl'], key: 'u' }, { mods: ['ctrl'], key: 'd' })).toBe(false)
  })
})

// ── the wheel, which is in the catalogue but is not a key ─────────────────────────────────
//
// A swipe bound to `Up` goes to the focused window; a swipe bound to the wheel goes to the
// window under the pointer. `xdotool key WheelUp` is accepted and does nothing, so the entry
// carries the button and everything that runs a chord must branch on it.

describe('the wheel entries', () => {
  it('are bindable, and carry the X11 button rather than a keysym', () => {
    expect(isBindableKey('WheelUp')).toBe(true)
    expect(isBindableKey('WheelDown')).toBe(true)
    expect(wheelButton('WheelUp')).toBe(4)
    expect(wheelButton('WheelDown')).toBe(5)
  })

  it('answer null for every real key, so the branch cannot fire by accident', () => {
    for (const k of ['Up', 'Down', 'Page_Up', 'Return', 'u', 'KP_Add']) {
      expect(wheelButton(k)).toBe(null)
    }
    expect(isWheelChord({ mods: [], key: 'Up' })).toBe(false)
    expect(isWheelChord({ mods: ['ctrl'], key: 'WheelDown' })).toBe(true)
  })

  it('live in their own group, so the picker shows them apart from the keys', () => {
    const def = keyDef('WheelUp')
    expect(def?.group).toBe('wheel')
    expect(GROUP_LABEL.wheel).toContain('wheel')
  })

  it('normalise like any other chord, modifiers included', () => {
    expect(normChord({ mods: ['ctrl'], key: 'WheelUp' })).toEqual({
      mods: ['ctrl'],
      key: 'WheelUp',
    })
  })
})

describe('chordCommand: the command a chord becomes', () => {
  it('is the xdotool key spelling for a key', () => {
    expect(chordCommand({ mods: [], key: 'Page_Up' })).toBe('Page_Up')
    expect(chordCommand({ mods: ['ctrl'], key: 'u' })).toBe('ctrl+u')
  })

  it('is a click for the wheel, never `key WheelUp`', () => {
    expect(chordCommand({ mods: [], key: 'WheelUp' })).toBe('click 4')
    expect(chordCommand({ mods: ['ctrl'], key: 'WheelDown' })).toBe('ctrl+click 5')
  })

  it('agrees with chordToXdo wherever a key is involved, so there is one truth', () => {
    for (const k of ['Up', 'Return', 'KP_Add', 'minus']) {
      const c = { mods: ['alt'] as Mod[], key: k }
      expect(chordCommand(c)).toBe(chordToXdo(c))
    }
  })
})

// ── the submit list ─────────────────────────────────────────────────────────────────────────
// A closed list for the same reason the key catalogue is: a stored value that is syntactically
// fine and sends nothing must not be representable. The shape of the list is pinned here.

describe('SUBMIT_CHORDS: what Submit may press after the text', () => {
  it('has no duplicate ids', () => {
    const ids = SUBMIT_CHORDS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // The id is the xdotool string, so there is no id→chord table to disagree with the chord.
  it('ids are exactly `chordToXdo` of the chord (and `off` for no chord)', () => {
    for (const s of SUBMIT_CHORDS) {
      expect(s.id).toBe(s.chord ? chordToXdo(s.chord) : 'off')
    }
  })

  // The client sends every chord here as `{kind:'key'}`. A wheel entry would send nothing,
  // and a chord outside the catalogue would be refused by the server.
  it('every chord is a real, canonical, non-wheel key chord', () => {
    for (const s of SUBMIT_CHORDS) {
      if (!s.chord) continue
      expect(normChord(s.chord)).toEqual(s.chord)
      expect(isWheelChord(s.chord)).toBe(false)
    }
  })

  it('offers exactly one way to press nothing, and it is first', () => {
    expect(SUBMIT_CHORDS.filter(s => s.chord === null).map(s => s.id)).toEqual(['off'])
    expect(SUBMIT_CHORDS[0]?.id).toBe('off')
  })

  // What an unconfigured app gets decides whether a line is typed or run, so the default is
  // pinned here and not left to the order of the list.
  it('defaults to pressing nothing: an unvisited app is typed into, not run', () => {
    expect(SUBMIT_DEFAULT.id).toBe('off')
    expect(SUBMIT_DEFAULT.chord).toBeNull()
    expect(SUBMIT_CHORDS).toContain(SUBMIT_DEFAULT)
    expect(submitChordById('off')).toBe(SUBMIT_DEFAULT)
  })

  // A list, not modifier toggles: toggles cannot express the non-Enter keys.
  it('covers the send keys a form actually uses, including the non-Enter ones', () => {
    for (const id of [
      'Return',
      'ctrl+Return',
      'shift+Return',
      'alt+Return',
      'Tab',
      'ctrl+s',
      'ctrl+d',
    ]) {
      expect(submitChordById(id)?.id).toBe(id)
    }
  })

  // It must not be able to express combinations outside the list.
  it('refuses an id outside the list, including a plausible modifier pile-up', () => {
    for (const bad of ['ctrl+alt+shift+Return', 'ctrl+Enter', 'Enter', 'ctrl+Tab', '', 'OFF']) {
      expect(submitChordById(bad)).toBeNull()
    }
  })

  it('groups every entry under a label the picker can show', () => {
    for (const s of SUBMIT_CHORDS) expect(SUBMIT_GROUP_LABEL[s.group]).toBeTruthy()
  })

  // The panel labels the row `submit`, so the option says only the chord, as `chordLabel`
  // spells it.
  it('labels each row with the chord alone', () => {
    expect(submitChordLabel(SUBMIT_DEFAULT)).toBe('off')
    expect(submitChordLabel(submitChordById('Return')!)).toBe('Enter')
    expect(submitChordLabel(submitChordById('ctrl+Return')!)).toBe('C-Enter')
    expect(submitChordLabel(submitChordById('shift+Return')!)).toBe('S-Enter')
    expect(submitChordLabel(submitChordById('alt+Return')!)).toBe('M-Enter')
    expect(submitChordLabel(submitChordById('ctrl+s')!)).toBe('C-s')
  })

  it('says where each one commits, for the log line on a phone', () => {
    for (const s of SUBMIT_CHORDS) expect(s.note.length).toBeGreaterThan(8)
  })
})

describe('NEWLINE_CHORDS: what may break a line', () => {
  // The same list, narrowed: `Tab`, `C-s`, `C-d` and `off` are not line breaks.
  it('is the Enter family and nothing else', () => {
    expect(NEWLINE_CHORDS.map(s => s.id)).toEqual([
      'Return',
      'ctrl+Return',
      'shift+Return',
      'alt+Return',
    ])
    expect(NEWLINE_CHORDS.every(s => s.chord !== null)).toBe(true)
  })

  it('is a subset of the submit list, sharing its entries rather than copying them', () => {
    for (const s of NEWLINE_CHORDS) expect(SUBMIT_CHORDS).toContain(s)
  })

  it('defaults to a bare Return: a terminal, a textarea and an editor all agree', () => {
    expect(NEWLINE_DEFAULT.id).toBe('Return')
    expect(NEWLINE_CHORDS).toContain(NEWLINE_DEFAULT)
  })

  it('gates ids the narrow way, where submitChordById would let them through', () => {
    expect(newlineChordById('shift+Return')?.id).toBe('shift+Return')
    for (const bad of ['off', 'Tab', 'ctrl+s', 'ctrl+d']) {
      expect(submitChordById(bad), bad).not.toBeNull() // fine as a submit key…
      expect(newlineChordById(bad), bad).toBeNull() // …never as a line break
    }
  })
})
