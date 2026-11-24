// First-use hints (src/client/hints.ts): the per-device show budget, the lens text fitting the
// panel, and the wiring that would break silently (a hint that never retires, a swipe that both
// closes the hint and sends a key, a Submit toast after a hold-send).

import { afterEach, describe, expect, it } from 'vitest'
import {
  HINT_SHOWS,
  hintDue,
  retireHint,
  startupHintText,
  submitOffHintText,
  takeHint,
} from '../src/client/hints.ts'
import { glassWidth, LINE_UNITS, PANEL_LINES } from '../src/shared/voiceDialog.ts'
import { clientSource } from './helpers/source.ts'

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: k => m.get(k) ?? null,
    key: i => [...m.keys()][i] ?? null,
    removeItem: k => {
      m.delete(k)
    },
    setItem: (k, v) => {
      m.set(k, v)
    },
  }
}

const g = globalThis as { localStorage?: Storage }
afterEach(() => {
  delete g.localStorage
})

describe('hint budget', () => {
  it('is due until it has been shown HINT_SHOWS times', () => {
    expect(hintDue(0)).toBe(true)
    expect(hintDue(HINT_SHOWS - 1)).toBe(true)
    expect(hintDue(HINT_SHOWS)).toBe(false)
  })

  it('counts each showing per hint and then retires', () => {
    g.localStorage = memoryStorage()
    for (let i = 0; i < HINT_SHOWS; i++) expect(takeHint('startup')).toBe(true)
    expect(takeHint('startup')).toBe(false)
    // Independent budgets.
    expect(takeHint('submit-off')).toBe(true)
  })

  it('retireHint ends it early', () => {
    g.localStorage = memoryStorage()
    retireHint('submit-off')
    expect(takeHint('submit-off')).toBe(false)
  })

  it('shows the hint when storage is unavailable rather than throwing', () => {
    expect(takeHint('startup')).toBe(true)
    expect(takeHint('startup')).toBe(true)
  })
})

describe('hint text', () => {
  it('fits the panel without the firmware folding a line', () => {
    for (const voice of [false, true]) {
      const lines = startupHintText(voice).split('\n')
      expect(lines.length).toBeLessThanOrEqual(PANEL_LINES)
      for (const l of lines) expect(glassWidth(l)).toBeLessThan(LINE_UNITS)
    }
  })

  it('mentions the long press only when there is a recogniser', () => {
    expect(startupHintText(true)).toContain('voice')
    expect(startupHintText(false)).not.toContain('voice')
  })

  it('names the double-tap menu and where the submit key is set', () => {
    expect(startupHintText(false)).toContain('double-tap')
    expect(submitOffHintText()).toContain('app')
  })
})

describe('wiring', () => {
  const src = clientSource()

  it('a swipe or tap that closes the hint goes no further', () => {
    expect(src.count('if (dismissStartupHint()) return')).toBe(2)
  })

  // Without it the pump pushes tiles under the hint and they draw over its text.
  it('holds the tile pump while the hint is up', () => {
    expect(src.fn('overlayActive').has('startupHint')).toBe(true)
  })

  it('the menu or the voice dialog retires the hint', () => {
    expect(
      src.has('if (startupHint && interactiveOverlay() !== null) dismissStartupHint(false)'),
    ).toBe(true)
  })

  it('the Submit toast skips a hold-send and a send that pressed a key', () => {
    expect(src.has("ok && press === null && !bare && takeHint('submit-off')")).toBe(true)
  })
})
