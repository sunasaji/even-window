// Unit tests for the pure halves of the input path: the key-name translation, the gesture →
// action dispatcher (docs/glasses.md) and the X11 backend's xdotool argv table. No X server
// involved.

import { describe, expect, it } from 'vitest'
import { isInputKind, keyNameToChord } from '../src/server/input.ts'
import { gestureAction } from '../src/server/main.ts'
import {
  TYPE_DELAY_NON_ASCII_MS,
  typeDelay,
  typeTimeoutMs,
  x11RatpoisonKey,
  xdoArgs,
} from '../src/server/platform/x11/input.ts'
import type { AppBinding } from '../src/shared/bindings.ts'
import { DEFAULT_SWIPE } from '../src/shared/bindings.ts'
import { SCREEN_H, SCREEN_W } from '../src/shared/geom.ts'
import type { Mod } from '../src/shared/keys.ts'

describe('keyNameToChord', () => {
  it('maps the names whose xdotool spelling differs', () => {
    expect(keyNameToChord('Enter')).toBe('Return')
    expect(keyNameToChord('PageUp')).toBe('Page_Up')
    expect(keyNameToChord('PageDown')).toBe('Page_Down')
    expect(keyNameToChord('BTab')).toBe('ISO_Left_Tab')
    expect(keyNameToChord('BSpace')).toBe('BackSpace')
    expect(keyNameToChord('Space')).toBe('space')
  })

  it('passes arrows, F-keys and bare characters through', () => {
    expect(keyNameToChord('Up')).toBe('Up')
    expect(keyNameToChord('Down')).toBe('Down')
    expect(keyNameToChord('F7')).toBe('F7')
    expect(keyNameToChord('a')).toBe('a')
  })

  it('expands modifier prefixes, including stacked ones', () => {
    expect(keyNameToChord('C-a')).toBe('ctrl+a')
    expect(keyNameToChord('M-x')).toBe('alt+x')
    expect(keyNameToChord('C-M-S-Delete')).toBe('ctrl+alt+shift+Delete')
    expect(keyNameToChord('C-Enter')).toBe('ctrl+Return')
  })
})

describe('xdoArgs', () => {
  it('builds the key / type invocations with --clearmodifiers', () => {
    expect(xdoArgs('key', 'Return')).toEqual(['key', '--clearmodifiers', 'Return'])
    // `--` so a leading-dash payload is never parsed as a flag.
    expect(xdoArgs('type', '-rf hello')).toEqual(['type', '--clearmodifiers', '--', '-rf hello'])
  })

  it('does a double-click in one invocation', () => {
    expect(xdoArgs('dblclick', '1')).toEqual(['click', '--repeat', '2', '--delay', '120', '1'])
  })

  it('validates the mouse button, defaulting to 1', () => {
    expect(xdoArgs('click', '3')).toEqual(['click', '3'])
    expect(xdoArgs('click', '5')).toEqual(['click', '5'])
    expect(xdoArgs('click', '9')).toEqual(['click', '1'])
    expect(xdoArgs('click', 'rm -rf /')).toEqual(['click', '1'])
    expect(xdoArgs('down', '2')).toEqual(['mousedown', '2'])
    expect(xdoArgs('up', '2')).toEqual(['mouseup', '2'])
  })

  // The one pair of kinds that deliberately leaves state in the X server (docs/protocol.md):
  // `keydown ctrl` → `mousedown N` → `mouseup N` → `keyup ctrl` is ctrl+press-and-hold, which
  // xdotool's mouse verbs cannot express on their own.
  it('holds a modifier with keydown/keyup and does not clear modifiers doing it', () => {
    expect(xdoArgs('keydown', 'ctrl')).toEqual(['keydown', 'ctrl'])
    expect(xdoArgs('keyup', 'ctrl')).toEqual(['keyup', 'ctrl'])
    expect(xdoArgs('keydown', 'alt')).toEqual(['keydown', 'alt'])
    // `--clearmodifiers` would release the very modifier the sequence exists to hold, i.e. the
    // feature would silently do nothing. `key` and `type` keep it; these two must not have it.
    for (const k of ['keydown', 'keyup']) {
      expect(xdoArgs(k, 'ctrl')).not.toContain('--clearmodifiers')
    }
    expect(xdoArgs('key', 'ctrl+c')).toContain('--clearmodifiers')
  })

  it('clamps pointer coordinates to the 576x288 panel', () => {
    expect(xdoArgs('move', '100,50')).toEqual(['mousemove', '100', '50'])
    expect(xdoArgs('move', '99999,99999')).toEqual([
      'mousemove',
      String(SCREEN_W),
      String(SCREEN_H),
    ])
    expect(xdoArgs('move', '-20,-1')).toEqual(['mousemove', '0', '0'])
    expect(xdoArgs('move', 'abc,def')).toEqual(['mousemove', '0', '0'])
    expect(xdoArgs('move', '12.6,33.2')).toEqual(['mousemove', '13', '33'])
  })

  it('clamps clickat too, and keeps move+click atomic', () => {
    expect(xdoArgs('clickat', '10,20,3')).toEqual(['mousemove', '10', '20', 'click', '3'])
    expect(xdoArgs('clickat', '900,900')).toEqual(['mousemove', '576', '288', 'click', '1'])
  })

  it('returns null for an unknown kind', () => {
    expect(xdoArgs('exec', 'sh')).toBeNull()
    expect(xdoArgs('', '')).toBeNull()
  })
})

describe('isInputKind', () => {
  it('accepts exactly the documented kinds', () => {
    for (const k of [
      'key',
      'type',
      'click',
      'dblclick',
      'move',
      'clickat',
      'down',
      'up',
      'keydown',
      'keyup',
    ]) {
      expect(isInputKind(k)).toBe(true)
    }
    for (const k of ['exec', 'spawn', 'KEY', '']) expect(isInputKind(k)).toBe(false)
  })
})

// A bound wheel is not a bound key, and the whole point of the branch is that the difference
// is invisible at the storage layer: both are a `Chord`, and `xdotool key WheelUp` would be
// accepted and do nothing (src/shared/keys.ts). So the router must decide, not the injector.
describe('gestureAction — a swipe bound to the wheel', () => {
  const wheelUp = {
    up: { mods: [] as Mod[], key: 'WheelUp' },
    down: { mods: [] as Mod[], key: 'WheelDown' },
  }

  it('routes to the wheel action with the X11 button, never to a key', () => {
    expect(gestureAction('up', 1, wheelUp)).toEqual({
      kind: 'wheel',
      button: 4,
      mods: [],
      repeat: 1,
    })
    expect(gestureAction('down', 1, wheelUp)).toEqual({
      kind: 'wheel',
      button: 5,
      mods: [],
      repeat: 1,
    })
  })

  it('carries the burst count as notches', () => {
    expect(gestureAction('up', 4, wheelUp)).toMatchObject({ kind: 'wheel', button: 4, repeat: 4 })
  })

  it('carries the modifiers, so ctrl+wheel (zoom in most clients) is bindable', () => {
    const b = {
      up: { mods: ['ctrl'] as Mod[], key: 'WheelUp' },
      down: { mods: [] as Mod[], key: 'Down' },
    }
    expect(gestureAction('up', 1, b)).toEqual({
      kind: 'wheel',
      button: 4,
      mods: ['ctrl'],
      repeat: 1,
    })
    // …and the other half of the same binding is still an ordinary key.
    expect(gestureAction('down', 1, b)).toEqual({ kind: 'key', key: 'Down', repeat: 1 })
  })

  it('leaves tap alone — only the swipes carry a binding', () => {
    expect(gestureAction('tap', 1, wheelUp)).toEqual({ kind: 'key', key: 'Return', repeat: 1 })
  })
})

describe('gestureAction', () => {
  it('maps swipes to arrow keys', () => {
    expect(gestureAction('up')).toEqual({ kind: 'key', key: 'Up', repeat: 1 })
    expect(gestureAction('down')).toEqual({ kind: 'key', key: 'Down', repeat: 1 })
  })

  it('maps tap to Return and never repeats it', () => {
    expect(gestureAction('tap')).toEqual({ kind: 'key', key: 'Return', repeat: 1 })
    expect(gestureAction('tap', 7)).toEqual({ kind: 'key', key: 'Return', repeat: 1 })
  })

  it('handles double without injecting (the glasses open their context menu)', () => {
    expect(gestureAction('double')).toEqual({ kind: 'client' })
    expect(gestureAction('double', 3)).toEqual({ kind: 'client' })
  })

  it('does not route long press or its release — named, logged, bound to nothing', () => {
    // The device emits long press and its release. `GestureName` includes them so the client
    // can name and log them; this route deliberately does not act on them.
    expect(gestureAction('long')).toBeNull()
    expect(gestureAction('longRelease')).toBeNull()
  })

  it('honours move-N count', () => {
    expect(gestureAction('down', 5)).toEqual({ kind: 'key', key: 'Down', repeat: 5 })
    expect(gestureAction('up', '3')).toEqual({ kind: 'key', key: 'Up', repeat: 3 })
  })

  it('clamps a bad or absent count to 1 and caps a runaway one', () => {
    for (const bad of [undefined, null, 0, -4, NaN, 'x', {}, 0.4]) {
      expect(gestureAction('up', bad)).toEqual({ kind: 'key', key: 'Up', repeat: 1 })
    }
    expect(gestureAction('up', 1e9)).toEqual({ kind: 'key', key: 'Up', repeat: 64 })
  })

  it('rejects anything that is not a gesture', () => {
    for (const g of ['swipeUp', 'Tap', 'left', '', 'tap ']) expect(gestureAction(g)).toBeNull()
  })
})

// The binding arrives as a parameter, so the mapping stays pure — the file on disk and the
// focused window are the route's problem (docs/glasses.md).
describe('gestureAction with a per-app swipe binding', () => {
  const VIM: AppBinding = {
    up: { mods: ['ctrl'], key: 'u' },
    down: { mods: ['ctrl'], key: 'd' },
  }

  // The no-binding call and the default-binding call produce the same action.
  it('is exactly Up/Down when nothing is bound', () => {
    expect(gestureAction('up')).toEqual(gestureAction('up', 1, DEFAULT_SWIPE))
    expect(gestureAction('down')).toEqual(gestureAction('down', 1, DEFAULT_SWIPE))
    expect(gestureAction('up', 1, DEFAULT_SWIPE)).toEqual({ kind: 'key', key: 'Up', repeat: 1 })
  })

  it('sends the bound chord, modifiers and all', () => {
    expect(gestureAction('up', 1, VIM)).toEqual({ kind: 'key', key: 'ctrl+u', repeat: 1 })
    expect(gestureAction('down', 1, VIM)).toEqual({ kind: 'key', key: 'ctrl+d', repeat: 1 })
  })

  // The move-N repeat applies to whatever is bound — a swipe burst means "N times", and the
  // router cannot know which keys mind. The editor warns; this pins the behaviour.
  it('repeats the bound key, not a hard-coded arrow', () => {
    expect(gestureAction('down', 4, VIM)).toEqual({ kind: 'key', key: 'ctrl+d', repeat: 4 })
  })

  it('leaves tap and double alone — a swipe binding is only for swipes', () => {
    expect(gestureAction('tap', 1, VIM)).toEqual({ kind: 'key', key: 'Return', repeat: 1 })
    expect(gestureAction('double', 1, VIM)).toEqual({ kind: 'client' })
  })

  // What the key catalogue is for: `xdotool key ctrl+-` does not parse, `ctrl+minus` does, and
  // the stored name is already the xdotool spelling so nothing has to translate it here.
  it('passes a punctuation keysym straight through to the xdotool spelling', () => {
    const font: AppBinding = {
      up: { mods: ['shift'], key: 'KP_Add' },
      down: { mods: ['shift'], key: 'KP_Subtract' },
    }
    expect(gestureAction('up', 1, font)).toEqual({ kind: 'key', key: 'shift+KP_Add', repeat: 1 })
    expect(gestureAction('down', 2, font)).toEqual({
      kind: 'key',
      key: 'shift+KP_Subtract',
      repeat: 2,
    })
  })
})

// The window manager's keyboard (X11 backend). Only the refusal path is testable without an
// X server: it is what stands between the glasses menu and an arbitrary keystroke. The
// accepted path's argv is pinned by `ratpoisonArgs` in tests/shared.glassMenu.test.ts.
describe('x11RatpoisonKey', () => {
  it('refuses anything outside the catalogue without spawning xdotool', async () => {
    for (const bad of ['Q', 'escape', 'delete', '', 'ctrl+T', undefined, null, 42, {}]) {
      expect(await x11RatpoisonKey(bad), String(bad)).toBe(false)
    }
  })
})

describe('non-ASCII is typed slower, because xdotool drops it at the default speed', () => {
  // At the default 12 ms xdotool drops non-ASCII characters; 40 ms was lossless in 8/8 runs.
  // ASCII needs no keycode remapping and keeps the default. See TYPE_DELAY_NON_ASCII_MS.
  it('adds no delay for ASCII — the common case keeps its speed', () => {
    expect(typeDelay('git log --oneline | head -20')).toEqual([])
    expect(typeDelay('')).toEqual([])
    expect(xdoArgs('type', 'ls -la')).toEqual(['type', '--clearmodifiers', '--', 'ls -la'])
  })

  it('adds the delay as soon as one character is outside ASCII', () => {
    expect(typeDelay('あ')).toEqual(['--delay', String(TYPE_DELAY_NON_ASCII_MS)])
    expect(typeDelay('git のログ')).toEqual(['--delay', String(TYPE_DELAY_NON_ASCII_MS)])
    // Accented Latin needs the same remapping as kana does.
    expect(typeDelay('café')).toEqual(['--delay', String(TYPE_DELAY_NON_ASCII_MS)])
  })

  it('puts the delay before the `--`, so the text is still never read as a flag', () => {
    expect(xdoArgs('type', '-rf これ')).toEqual([
      'type',
      '--clearmodifiers',
      '--delay',
      String(TYPE_DELAY_NON_ASCII_MS),
      '--',
      '-rf これ',
    ])
  })

  it('leaves every other kind alone', () => {
    expect(xdoArgs('key', 'Return')).toEqual(['key', '--clearmodifiers', 'Return'])
    expect(xdoArgs('keydown', 'ctrl')).toEqual(['keydown', 'ctrl'])
  })
})

describe('typeTimeoutMs', () => {
  it('keeps the base timeout for a short string', () => {
    expect(typeTimeoutMs('')).toBe(2000)
    expect(typeTimeoutMs('ls')).toBeLessThan(2100)
  })

  it('outlasts xdotool typing a long transcript at its own delay', () => {
    // 141 characters at 40 ms each is 5.6 s of typing. Ending xdotool before that leaves a
    // key down, and X auto-repeat then fills the field with one character.
    const text = '音声テスト。'.repeat(24).slice(0, 141)
    expect([...text]).toHaveLength(141)
    expect(typeTimeoutMs(text)).toBeGreaterThan(141 * TYPE_DELAY_NON_ASCII_MS * 2)
  })

  it('counts characters, not UTF-16 units, and gives ASCII the shorter delay', () => {
    expect(typeTimeoutMs('😀')).toBe(2000 + TYPE_DELAY_NON_ASCII_MS * 3)
    expect(typeTimeoutMs('a'.repeat(100))).toBe(2000 + 100 * 12 * 3)
  })
})
