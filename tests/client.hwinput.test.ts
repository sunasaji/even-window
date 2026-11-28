// pinhole-window — the hardware keyboard path and the hover path for a real pointer.
//
// Both inject into a shell on the host (docs/security.md), so the rules that decide whether a
// keystroke is injected at all, and the arithmetic that decides where the pointer goes, are
// pure functions with tests rather than conditions buried in a DOM handler.
//
// What is pinned here:
//   * the gate: this app's own text fields keep their keystrokes, always;
//   * the split between text and chord (`ctrl+-` is not parseable by xdotool; `ctrl+minus` is);
//   * that the arrow keys are still spelled even though iOS never delivers them;
//   * the relative hover mapping, which must not route touch and must not park on a bound pixel.

import { describe, expect, it } from 'vitest'
import {
  fieldEnterAction,
  type HwKey,
  hwKeyPlan,
  KeyBatcher,
  kbdShouldHandle,
  kbdSwallowInField,
  tapDropsFocus,
} from '../src/client/hwKeyboard.ts'
import { hoverStep } from '../src/client/vpad.ts'
import { SCREEN_H, SCREEN_W } from '../src/shared/geom.ts'
import { clientSource } from './helpers/source.ts'

const src = clientSource()

const k = (over: Partial<HwKey> = {}): HwKey => ({
  key: 'a',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
})

// There is no keyboard mode: "keys go to the X unless a field here has focus" is the whole
// boundary, so these cases are the contract.
describe('kbdShouldHandle: the gate is the whole boundary', () => {
  it('passes keys through when nothing of ours has focus', () => {
    expect(kbdShouldHandle('BODY', false, false)).toBe(true)
    expect(kbdShouldHandle('none', false, false)).toBe(true)
    expect(kbdShouldHandle('BUTTON', false, false)).toBe(true)
  })

  it("never steals from this app's own controls: the text box must keep working", () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(kbdShouldHandle(tag, false, false)).toBe(false)
    }
  })

  it('covers contenteditable, which no tag test can see', () => {
    expect(kbdShouldHandle('DIV', true, false)).toBe(false)
  })

  it('stands down while the apps palette is open (its filter box is a text field)', () => {
    expect(kbdShouldHandle('BODY', false, true)).toBe(false)
  })
})

// Tab inside a text box would move the caret to a button, and the rest of the sentence would
// then go to the nested X because the field no longer has focus.
describe('kbdSwallowInField: keys dropped so a field cannot lose focus mid-sentence', () => {
  it('swallows Tab', () => {
    expect(kbdSwallowInField('Tab')).toBe(true)
  })

  it('swallows nothing a typist actually wants in a field', () => {
    for (const key of ['a', ' ', 'Enter', 'Backspace', 'Escape', 'ArrowLeft']) {
      expect(kbdSwallowInField(key)).toBe(false)
    }
  })
})

// iOS does not blur a text field when the tap lands on a plain button or a canvas, so the
// caret would stay in the box and keep every hardware key. The rule is one sentence: the keys
// go where the caret is, and a tap moves the caret.
describe('tapDropsFocus: a tap outside gives the keyboard back', () => {
  it('drops the focus a field is holding', () => {
    expect(tapDropsFocus('INPUT', false, false)).toBe(true)
    expect(tapDropsFocus('TEXTAREA', false, false)).toBe(true)
    expect(tapDropsFocus('DIV', true, false)).toBe(true) // contenteditable
  })

  it('leaves a tap inside the field alone: that is how you place a caret', () => {
    expect(tapDropsFocus('INPUT', false, true)).toBe(false)
    expect(tapDropsFocus('DIV', true, true)).toBe(false)
  })

  it('does nothing when no field had focus', () => {
    expect(tapDropsFocus('BODY', false, false)).toBe(false)
    expect(tapDropsFocus('BUTTON', false, false)).toBe(false)
  })

  // One definition of "a field" for both halves.
  it('agrees with the gate about what a field is', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'DIV', 'BODY', 'BUTTON']) {
      expect(tapDropsFocus(tag, false, false)).toBe(!kbdShouldHandle(tag, false, false))
    }
  })
})

// The box sends its newlines through, so a bare Enter is the line break and the send is
// Ctrl+Enter, which keeps submitting possible without leaving the keyboard.
describe('fieldEnterAction: Enter in the box', () => {
  const ev = (
    over: Partial<Parameters<typeof fieldEnterAction>[0]> = {},
  ): Parameters<typeof fieldEnterAction>[0] => ({
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    ...over,
  })

  it('breaks the line on a bare Enter', () => {
    expect(fieldEnterAction(ev())).toBe('newline')
  })

  // The keyboard path must be able to send without a tap on the phone.
  it('submits on Ctrl+Enter, and on Cmd+Enter for a Mac keyboard', () => {
    expect(fieldEnterAction(ev({ ctrlKey: true }))).toBe('submit')
    expect(fieldEnterAction(ev({ metaKey: true }))).toBe('submit')
  })

  it('breaks the line on Shift+Enter and on Alt+Enter, both', () => {
    expect(fieldEnterAction(ev({ shiftKey: true }))).toBe('newline')
    expect(fieldEnterAction(ev({ altKey: true }))).toBe('newline')
  })

  // The first Enter of a Japanese conversion commits the candidate; acting on it would insert
  // the wrong break and eat the keystroke choosing the candidate. Both the standard signal and
  // the legacy one are honoured, and the guard beats the submit chord too.
  it('never acts while an IME is composing', () => {
    expect(fieldEnterAction(ev({ isComposing: true }))).toBe('pass')
    expect(fieldEnterAction(ev({ keyCode: 229 }))).toBe('pass')
    expect(fieldEnterAction(ev({ isComposing: true, shiftKey: true }))).toBe('pass')
    expect(fieldEnterAction(ev({ isComposing: true, ctrlKey: true }))).toBe('pass')
  })

  it('ignores every other key', () => {
    for (const key of ['a', 'Tab', 'Escape', 'NumpadEnter']) {
      expect(fieldEnterAction(ev({ key }))).toBe('pass')
    }
  })
})

describe('hwKeyPlan: one hardware key → one injection', () => {
  it('sends a bare character as text', () => {
    expect(hwKeyPlan(k({ key: 'a' }))).toEqual({ kind: 'type', arg: 'a' })
    expect(hwKeyPlan(k({ key: ' ' }))).toEqual({ kind: 'type', arg: ' ' })
    expect(hwKeyPlan(k({ key: 'あ' }))).toEqual({ kind: 'type', arg: 'あ' })
  })

  it('does not add shift to a character: the platform already applied it', () => {
    // The event for shift+2 carries "@"; `shift+at` would be a different key entirely.
    expect(hwKeyPlan(k({ key: '@', shiftKey: true }))).toEqual({ kind: 'type', arg: '@' })
  })

  it('sends a modified character as a chord, by X keysym name and not by glyph', () => {
    // `xdotool key ctrl+-` is not parseable; `ctrl+minus` is. The on-screen keypad has the same
    // rule.
    expect(hwKeyPlan(k({ key: '-', ctrlKey: true }))).toEqual({ kind: 'key', arg: 'ctrl+minus' })
    expect(hwKeyPlan(k({ key: 'c', ctrlKey: true }))).toEqual({ kind: 'key', arg: 'ctrl+c' })
    expect(hwKeyPlan(k({ key: 'x', ctrlKey: true, altKey: true }))).toEqual({
      kind: 'key',
      arg: 'ctrl+alt+x',
    })
  })

  it('translates named keys into xdotool spellings, not DOM ones', () => {
    expect(hwKeyPlan(k({ key: 'Enter' }))).toEqual({ kind: 'key', arg: 'Return' })
    expect(hwKeyPlan(k({ key: 'Backspace' }))).toEqual({ kind: 'key', arg: 'BackSpace' })
    expect(hwKeyPlan(k({ key: 'PageUp' }))).toEqual({ kind: 'key', arg: 'Page_Up' })
  })

  it('adds shift to a named key, where the glyph never changes', () => {
    expect(hwKeyPlan(k({ key: 'Tab', shiftKey: true }))).toEqual({ kind: 'key', arg: 'shift+Tab' })
  })

  // On iOS the arrows never arrive, not even as caret movement. The entries stay because a
  // different keyboard or phone may deliver them.
  it('still spells the arrows, which iOS never delivers', () => {
    expect(hwKeyPlan(k({ key: 'ArrowUp' }))).toEqual({ kind: 'key', arg: 'Up' })
    expect(hwKeyPlan(k({ key: 'ArrowLeft', ctrlKey: true }))).toEqual({
      kind: 'key',
      arg: 'ctrl+Left',
    })
  })

  it('passes F-keys through, and refuses anything else it cannot name', () => {
    expect(hwKeyPlan(k({ key: 'F7' }))).toEqual({ kind: 'key', arg: 'F7' })
    expect(hwKeyPlan(k({ key: 'BrightnessUp' }))).toBe(null)
  })

  it('ignores a modifier pressed alone: it is a prefix, not a keystroke', () => {
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) {
      expect(hwKeyPlan(k({ key }))).toBe(null)
    }
  })

  it('ignores the identity-less keys the iOS bug reports describe', () => {
    expect(hwKeyPlan(k({ key: 'Unidentified' }))).toBe(null)
    expect(hwKeyPlan(k({ key: '' }))).toBe(null)
  })
})

// One POST per keystroke caps the typist at one character per round trip. A fixed coalescing
// window is either latency added to the first key or too short to batch on a slow link, so the
// batch is defined by the round trip instead. These tests drive it with promises they resolve
// by hand, to observe what happens while a request is in flight.
describe('KeyBatcher: ordered, and batched by the round trip itself', () => {
  interface Call {
    kind: string
    arg: string
    resolve: () => void
  }

  const harness = (): { calls: Call[]; b: KeyBatcher } => {
    const calls: Call[] = []
    const b = new KeyBatcher(
      (kind, arg) =>
        new Promise<void>(res => {
          calls.push({ kind, arg, resolve: res })
        }),
    )
    return { calls, b }
  }
  /** Let the promise chain advance as far as it can with nothing new resolved. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  it('sends the first character immediately: nothing is held back on an idle link', async () => {
    const { calls, b } = harness()
    b.char('a')
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'type', arg: 'a' })
  })

  it('batches everything typed while a request is in flight into one injection', async () => {
    const { calls, b } = harness()
    b.char('a')
    await settle()
    for (const ch of 'bcdef') b.char(ch) // the round trip has not come back yet
    await settle()
    expect(calls).toHaveLength(1) // still just the 'a'
    calls[0]?.resolve()
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ kind: 'type', arg: 'bcdef' })
  })

  it('never has two requests in flight at once, however fast the typing', async () => {
    const { calls, b } = harness()
    for (const ch of 'hello world') b.char(ch)
    await settle()
    expect(calls).toHaveLength(1)
  })

  // Text that overtakes a chord is a different command. Typing "a", ctrl+c, "b" must arrive in
  // that order even though the 'b' is queued while the flush for 'a' is still pending.
  it('keeps a chord in order with the text around it', async () => {
    const { calls, b } = harness()
    b.char('a')
    await settle() // 'a' is in flight
    b.char('x') // joins the next batch
    b.chord('ctrl+c') // closes the buffer: 'x' goes before the chord
    b.char('b') // typed after the chord → after it
    calls[0]?.resolve()
    await settle()
    for (let i = 1; i < calls.length; i++) {
      calls[i]?.resolve()
      await settle()
    }
    expect(calls.map(c => `${c.kind}:${c.arg}`)).toEqual([
      'type:a',
      'type:x',
      'key:ctrl+c',
      'type:b',
    ])
  })

  it('flushes on demand (the page is going away) and keeps nothing behind', async () => {
    const { calls, b } = harness()
    b.char('a')
    await settle()
    b.char('q')
    expect(b.pending()).toBe('q')
    b.flushNow()
    expect(b.pending()).toBe('')
    calls[0]?.resolve()
    await settle()
    expect(calls[1]).toMatchObject({ kind: 'type', arg: 'q' })
  })

  it('survives a failed injection: the chain keeps draining', async () => {
    const calls: { kind: string; arg: string }[] = []
    let fail = true
    const b = new KeyBatcher((kind, arg) => {
      calls.push({ kind, arg })
      if (fail) {
        fail = false
        return Promise.reject(new Error('offline'))
      }
      return Promise.resolve()
    })
    b.char('a')
    await settle()
    b.char('b')
    await settle()
    expect(calls.map(c => c.arg)).toEqual(['a', 'b'])
  })
})

// The pointer is purely relative. The OS draws its own cursor disc that this page can neither
// move nor hide, and the wearer looks at the glasses, so the physical cursor's position is
// ignored and only its movement is read.
describe('hoverStep: the pointer reads movement, never position', () => {
  const cur = { x: 100, y: 50 }

  it('is null on the first sample: a position is not a move', () => {
    expect(hoverStep(null, 10, 10, 1, cur)).toBe(null)
  })

  it('adds the travel, scaled by the mirror', () => {
    expect(hoverStep({ x: 10, y: 10 }, 20, 30, 1, cur)).toEqual({ x: 110, y: 70 })
    expect(hoverStep({ x: 10, y: 10 }, 20, 30, 2, cur)).toEqual({ x: 120, y: 90 })
  })

  it('moves back as well as forward', () => {
    expect(hoverStep({ x: 20, y: 20 }, 10, 15, 1, cur)).toEqual({ x: 90, y: 45 })
  })

  it('clamps to the last pixel at both ends, like every other cursor write', () => {
    expect(hoverStep({ x: 0, y: 0 }, 9999, 9999, 1, cur)).toEqual({
      x: SCREEN_W - 1,
      y: SCREEN_H - 1,
    })
    expect(hoverStep({ x: 0, y: 0 }, -9999, -9999, 1, cur)).toEqual({ x: 0, y: 0 })
  })

  // The same travel produces the same step wherever the physical cursor is. Nothing in the
  // signature can express "where on the screen".
  it('gives the same step for the same travel, anywhere on the screen', () => {
    const a = hoverStep({ x: 5, y: 5 }, 15, 25, 1, cur)
    const b = hoverStep({ x: 605, y: 705 }, 615, 725, 1, cur)
    expect(a).toEqual(b)
  })
})

// Structural: the parts that have no pure surface.

describe('the keyboard path has no mode left to get wrong (source scan)', () => {
  it('kept no latch: the gate is the only thing deciding', () => {
    expect(src.has('kbdArmed')).toBe(false)
    expect(src.has('setKbd(')).toBe(false)
  })

  it('announces itself once, since there is no pill to read', () => {
    expect(src.has('kbd: hardware keys go to the window')).toBe(true)
    expect(src.has('kbdAnnounced = true')).toBe(true)
  })

  it('returns focus on pointerup, never pointerdown (a blur re-lays out the column)', () => {
    const body = src.fn('wireHardwareKeyboard')
    expect(body.has("document.addEventListener('pointerup'")).toBe(true)
    expect(body.has("document.addEventListener('pointerdown'")).toBe(false)
    expect(body.has('tapDropsFocus(')).toBe(true)
  })

  it('submits the box from one path, so the button, Enter and the hold cannot drift', () => {
    // What would drift is "did it clear the box", which is how a line gets sent twice. The hold
    // is a third caller of the same `fire()`: it passes `bare` and does not inject on its own.
    const box = src
      .fn('mountUi')
      .between("const textRow = document.createElement('div')", 'textRow.append(')
    expect(box.has('const fire = (via: string, bare = false)')).toBe(true)
    expect(box.has("fire('Ctrl+Enter')")).toBe(true)
    expect(box.has("fire('hold')")).toBe(true)
    expect(box.has('x11Inject(')).toBe(false)
  })

  it('flushes pending text when the page goes away, rather than carrying it across', () => {
    expect(src.has("if (document.visibilityState === 'hidden') kbdBatcher.flushNow()")).toBe(true)
  })

  // Ordering and batching are tested above against a fake. A source scan adds only that the
  // handler routes through the batcher at all, with no bare `x11Inject` on the key path.
  it('routes every key through the batcher, never straight at x11Inject', () => {
    const body = src.fn('wireHardwareKeyboard')
    expect(body.has('kbdBatcher.char(')).toBe(true)
    expect(body.has('kbdBatcher.chord(')).toBe(true)
    expect(body.has('x11Inject(')).toBe(false)
  })

  it('has no fixed coalescing window to mis-tune', () => {
    expect(src.has('KBD_COALESCE_MS')).toBe(false)
  })

  it('cancels the keys it consumed, or Tab walks the focus ring', () => {
    const body = src.fn('wireHardwareKeyboard')
    expect(body.has('e.preventDefault()')).toBe(true)
  })
})

describe('the pointer path is relative and touch-only-by-exception (source scan)', () => {
  const pad = src.fn('openVPad')

  it('has no absolute mapping in the code', () => {
    // Comments may name it; only the executable half is checked.
    expect(src.code().has('absFromRect')).toBe(false)
  })

  it('reads hover only for a mouse: a finger has no hover', () => {
    expect(pad.count('hoverStep(')).toBeGreaterThanOrEqual(1)
    // On the squashed text: every call is shortly preceded by the mouse test.
    const gated = pad.text
      .split('hoverStep(')
      .slice(0, -1)
      .every(before => /pointerType(===|!==)'mouse'/.test(before.slice(-300)))
    expect(gated).toBe(true)
  })

  it('keeps PAD_GAIN for the finger and withholds it from the pointer', () => {
    expect(pad.has('PAD_GAIN')).toBe(true)
    expect(pad.has("(e.pointerType === 'mouse' ? 1 : PAD_GAIN)")).toBe(true)
  })
})
