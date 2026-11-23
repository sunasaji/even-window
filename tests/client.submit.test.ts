// The Submit button's hold gesture (docs/phone-ui.md).
//
// Holding Submit sends the line without the app's submit key. The wiring is pointer events on a
// DOM node, which cannot be called from here, so it is pinned by one assertion on the numbers
// and a source scan for the invariants that would break silently (a double send, a send that
// cannot be cancelled, a hint that eats the tap).

import { describe, expect, it } from 'vitest'
import { sendPlan } from '../src/client/gestures.ts'
import { SUBMIT_HINT_MS, SUBMIT_HOLD_MS } from '../src/client/vpad.ts'
import type { Chord } from '../src/shared/keys.ts'
import { clientSource } from './helpers/source.ts'

const RET: Chord = { mods: [], key: 'Return' }
const S_RET: Chord = { mods: ['shift'], key: 'Return' }
const C_RET: Chord = { mods: ['ctrl'], key: 'Return' }
/** Just the verbs, which is what the order is about. */
const steps = (text: string, press: Chord | null, nl: Chord): string[] =>
  sendPlan(text, press, nl).map(s => `${s.kind} ${s.arg}`)

const src = clientSource()
/** The `pointerdown` … `pointercancel` block, which is the whole gesture: from the hold's own
 *  state to the first thing `mountUi` does after wiring it. */
const hold = src.fn('mountUi').between('let holdTimer:', 'text.title =')

describe('the hold timings', () => {
  // The other way round, the hint would appear only after the gesture had already armed.
  it('show the hint before the hold arms, never after', () => {
    expect(SUBMIT_HINT_MS).toBeLessThan(SUBMIT_HOLD_MS)
  })

  // Long enough that an ordinary send does not flash the hint, short enough to stay a tap.
  it('wait out a tap before saying anything', () => {
    expect(SUBMIT_HINT_MS).toBeGreaterThanOrEqual(100)
  })

  // One answer to "how long is a hold" on this screen: the pad's.
  it("reuse the pad's hold threshold rather than inventing a second one", () => {
    expect(src.has('export const SUBMIT_HOLD_MS = PAD_TAP_MS')).toBe(true)
  })
})

describe('the hold sends once, and only what was asked for', () => {
  it('sends through fire() with `bare`, never its own injection', () => {
    expect(hold.has("fire('hold')")).toBe(true)
    expect(hold.has('submitText(')).toBe(false)
    expect(hold.has('x11Inject(')).toBe(false)
  })

  // The `click` that follows a `pointerup` would otherwise send the same line a second time,
  // once without the submit key and once with it.
  it('swallows the click that follows the release', () => {
    expect(hold.has('holdSent = true')).toBe(true)
    expect(hold.has('if (holdSent) { holdSent = false; return }')).toBe(true)
    // A gesture that never produces that click must not leave the flag armed for the next tap,
    // which would silently drop a real send.
    expect(hold.has('holdSent = false\n    const press')).toBe(true)
  })

  it('arms nothing when the app presses nothing anyway', () => {
    expect(hold.has('if (!press.chord) return')).toBe(true)
  })

  // A touch pointer is implicitly captured, so `pointerleave` never arrives while the finger
  // is down: without the hand-rolled hit test there is no way to back out of an armed hold.
  it('can be cancelled by sliding off the button', () => {
    expect(hold.has("submit.addEventListener('pointermove'")).toBe(true)
    expect(hold.has('if (!inside) endHold()')).toBe(true)
    expect(hold.has("submit.addEventListener('pointercancel', () => { endHold() })")).toBe(true)
  })

  it('names the key it is leaving out, rather than saying "auto"', () => {
    expect(hold.has('hold → send without ${name}')).toBe(true)
    expect(hold.has('release → send without ${name}')).toBe(true)
    expect(hold.has('submitChordLabel(press)')).toBe(true)
  })

  // The hint sits under the finger's own button. If it could take the pointer it would end the
  // gesture it is describing.
  it('cannot intercept the gesture it explains', () => {
    expect(hold.has('pointer-events:none')).toBe(true)
    expect(hold.has('position:absolute')).toBe(true)
  })
})

// sendPlan: what a boxful of text becomes. A line break is a keystroke on this path, and which
// keystroke is a per-app setting, so the order of type/key injections is the whole behaviour
// of the send.

describe('sendPlan: one line', () => {
  it('types it, then presses the submit key', () => {
    expect(steps('echo hi', RET, RET)).toEqual(['type echo hi', 'key Return'])
  })

  it('types it and presses nothing when the app is on `off` (the default)', () => {
    expect(steps('echo hi', null, RET)).toEqual(['type echo hi'])
  })

  it('is nothing at all for an empty or whitespace-only box', () => {
    for (const t of ['', '   ', '\n', ' \n\t '])
      expect(sendPlan(t, RET, RET), JSON.stringify(t)).toEqual([])
  })
})

describe('sendPlan: several lines', () => {
  // In a terminal the break is Return, so two lines are two commands.
  it('presses the newline key between the lines: one fewer break than lines', () => {
    expect(steps('a\nb\nc', null, RET)).toEqual([
      'type a',
      'key Return',
      'type b',
      'key Return',
      'type c',
    ])
  })

  // A chat box, where Return would send each line and only `S-Enter` breaks one.
  it("uses the app's own break, so a chat box gets one message and not three", () => {
    expect(steps('a\nb\nc', C_RET, S_RET)).toEqual([
      'type a',
      'key shift+Return',
      'type b',
      'key shift+Return',
      'type c',
      'key ctrl+Return',
    ])
  })

  it('treats a blank line as the break alone, never an empty `type`', () => {
    expect(steps('a\n\nb', null, RET)).toEqual(['type a', 'key Return', 'key Return', 'type b'])
    expect(sendPlan('a\n\nb', null, RET).every(s => s.arg !== '')).toBe(true)
  })

  // The trailing newline is real. With the default `submit:off` it is the only way to end a
  // line, so trimming it would leave an unconfigured app unable to run anything.
  it('keeps a trailing newline as a break', () => {
    expect(steps('echo hi\n', null, RET)).toEqual(['type echo hi', 'key Return'])
    expect(steps('echo hi\n', C_RET, RET)).toEqual([
      'type echo hi',
      'key Return',
      'key ctrl+Return',
    ])
  })

  it('reads CRLF as one break, not two', () => {
    expect(steps('a\r\nb', null, RET)).toEqual(['type a', 'key Return', 'type b'])
  })

  // Leading blank lines are the user's; nothing here trims the middle of the box.
  it('sends the box as written, including a leading break', () => {
    expect(steps('\na', null, RET)).toEqual(['key Return', 'type a'])
  })
})
