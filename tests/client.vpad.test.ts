// even-window — vPad: the mouse-button selector, the held modifier and the wheel.
//
//   1. The pure part: the pill table and the `clickat` argument, checked against the server's
//      own `xdoArgs`, the only authority on whether `"x,y,2"` means button 2.
//   2. A source audit of the pad's injection sites. A `clickat` with no button, or a `down`
//      with a hardcoded `'1'`, is not an error (`button()` in src/server/input.ts defaults to
//      1), so a site that was never threaded through keeps working on the left button and says
//      nothing. The pad needs a DOM, a bridge and an X server to run, so the test reads the
//      source.

import { describe, expect, it } from 'vitest'
import { padChromeTop } from '../src/client/chrome.ts'
import { modPrefix } from '../src/client/oskb.ts'
import { scrollNatLabel, twoFingerWheelDir } from '../src/client/settings.ts'
import {
  PAD_BUTTONS,
  PAD_WHEEL_MAX,
  PAD_WHEEL_PX,
  padButtonLabel,
  padButtonName,
  padClickatArg,
  padWheelButton,
} from '../src/client/vpad.ts'
import { xdoArgs } from '../src/server/platform/x11/input.ts'
import { clientSource, type Source } from './helpers/source.ts'

const src = clientSource()
/** `openVPad`'s body. */
const PAD = src.fn('openVPad')
/** The press/release machinery, which lives at module scope so `closeVPad` can reach it (the
 *  pad's closure dies with the overlay). */
const HOLD = src.fns(
  'padDown',
  'padSeq',
  'padQueue',
  'padTry',
  'padPress',
  'padRelease',
  'padArmedEl',
  'renderPadArmed',
)
/** `closeVPad`'s body, and only that: the audits below are about what close's own release does
 *  and does not do. */
const CLOSE = src.fn('closeVPad')
/** Code only, comments stripped. The comments explain what the code refuses to do ("not
 *  `if (dragging)`", "no early return"), so an audit that checks for absence must not read
 *  them. */
function codeOnly(s: Source): Source {
  return s.code()
}

describe('PAD_BUTTONS: the three pills', () => {
  it('offers exactly left / middle / right, in that order', () => {
    expect(PAD_BUTTONS.map(p => p.b)).toEqual([1, 2, 3])
    expect(PAD_BUTTONS.map(p => p.name)).toEqual(['left', 'middle', 'right'])
  })

  it('never offers 4 or 5: those are the wheel, which has its own control', () => {
    // Neither scroll path uses this latch: the two-finger drag and the right-edge strip both
    // send `click 4`/`5` through `wheelNotch`. A selector that could land on 4 would turn every
    // tap into a scroll.
    for (const p of PAD_BUTTONS) expect(p.b).toBeLessThanOrEqual(3)
  })

  it('labels name the button and its number, so a pill and a log line can be matched up', () => {
    expect(PAD_BUTTONS.map(p => p.label)).toEqual(['Left (1)', 'Middle (2)', 'Right (3)'])
    // Not confusable with the gesture pills (`● tap` / `●● dbl`) in the row behind the overlay.
    for (const p of PAD_BUTTONS) expect(p.label).not.toMatch(/[●▲▼]/)
  })

  it('every pill carries a title that says what the button is for', () => {
    for (const p of PAD_BUTTONS) expect(p.title.length).toBeGreaterThan(10)
  })

  it('padButtonLabel / padButtonName are total (an unknown number still prints)', () => {
    expect(padButtonLabel(2)).toBe('Middle (2)')
    expect(padButtonName(3)).toBe('right')
    expect(padButtonLabel(9)).toBe('button 9')
    expect(padButtonName(9)).toBe('9')
  })
})

// A 44px box at `top:8` reaches y=52 and would cover the top of a mirror whose edge is at
// y=44; `controlAt` would also make that strip deaf to the pad.
describe('padChromeTop: the corner controls clear the mirror', () => {
  it('lifts the box so its 44px hit rectangle ends at the mirror, not past it', () => {
    expect(padChromeTop(44)).toBe(0)
    expect(padChromeTop(50)).toBe(6)
  })

  it('leaves the resting inset alone when there is room (a scrolled column)', () => {
    expect(padChromeTop(100)).toBe(8)
    expect(padChromeTop(600)).toBe(8)
  })

  it('never goes negative: a reachable button beats one pushed off screen', () => {
    expect(padChromeTop(20)).toBe(0)
    expect(padChromeTop(0)).toBe(0)
  })

  it('does nothing without a mirror to clear', () => {
    expect(padChromeTop(null)).toBe(8)
  })
})

describe('source audit: the corner chrome is 32px of ink in a 44px target', () => {
  it('keeps the 44px touch target', () => {
    // The transparent border is what grows the hit box back to 44 without growing the ring,
    // and `background-clip:padding-box` is what stops the fill painting under it.
    expect(src.has('width:32px;height:32px;border-radius:22px;border:6px solid transparent;')).toBe(
      true,
    )
    expect(src.has('background-clip:padding-box')).toBe(true)
  })

  it('positions both vPad corners from the same computed top', () => {
    expect(PAD.has('const chromeTop = padChromeTop(')).toBe(true)
    expect(PAD.has("close.style.cssText = cornerCss('right')")).toBe(true)
    expect(PAD.has("natBtn.style.cssText = cornerCss('left')")).toBe(true)
  })

  it('gives vRing the same chrome: it frames the same mirror through the same hole', () => {
    const ring = src.fn('openVRing')
    expect(ring.has('PAD_CHROME_CSS')).toBe(true)
    expect(ring.has('padChromeTop(')).toBe(true)
  })
})

describe('padClickatArg: the client/server agreement on "x,y[,button]"', () => {
  it('rounds the coordinates and appends the button', () => {
    expect(padClickatArg(10.4, 20.6, 2)).toBe('10,21,2')
    expect(padClickatArg(0, 0, 1)).toBe('0,0,1')
  })

  it('the server parses each button out of it', () => {
    for (const b of [1, 2, 3] as const) {
      expect(xdoArgs('clickat', padClickatArg(100, 50, b))).toEqual([
        'mousemove',
        '100',
        '50',
        'click',
        String(b),
      ])
    }
  })

  it('and the down/up form the pad sends is the button on its own', () => {
    expect(xdoArgs('down', '2')).toEqual(['mousedown', '2'])
    expect(xdoArgs('up', '2')).toEqual(['mouseup', '2'])
  })
})

describe('source audit: every vPad injection site is threaded through the latch', () => {
  it('the pad closure contains no button press/release of its own', () => {
    // `padPress` and `padRelease` (module scope) are the only code that presses or releases
    // anything, which is what lets `closeVPad`, which cannot see this closure, guarantee the
    // release.
    expect(PAD.has(/x11Inject\('(?:down|up|keydown|keyup)'/)).toBe(false)
    expect(HOLD.count(/padTry\('(?:down|up|keydown|keyup)'/)).toBe(4)
  })

  it('the hold presses the latch, never a literal button', () => {
    const sites = PAD.matches(/padPress\(([^,]+),/)
    expect(sites.length).toBeGreaterThanOrEqual(2) // the hold, and the click's modifiers
    for (const s of sites) expect(s).toMatch(/padPress\((?:padButton|null),/)
  })

  it('the release uses the recorded button, so a latch change mid-hold cannot strand it', () => {
    expect(HOLD.has("await padTry('up', String(h.btn)")).toBe(true)
  })

  it('the only `clickat` formats its argument with padClickatArg', () => {
    expect(PAD.count("'clickat'")).toBe(1)
    expect(PAD.has("padTry('clickat', padClickatArg(cursor.x, cursor.y, btn),")).toBe(true)
    // Its only latched caller passes the latch, not a literal.
    expect(PAD.has('clickAt(padButton)')).toBe(true)
  })

  it('the one hardcoded button is the physical right mouse button, and it is commented', () => {
    const literals = PAD.matches(/clickAt\(\d\)/)
    expect(literals).toEqual(['clickAt(3)'])
    expect(PAD.between('function openVPad', 'clickAt(3)').has('not the latch')).toBe(true)
  })
})

describe('source audit: a long press is not a right click', () => {
  it('a held press puts the latched button down instead of right-clicking', () => {
    expect(PAD.has('padPress(padButton, mods, tag)')).toBe(true)
    expect(PAD.has('press-and-hold (${padButtonName(padButton)})')).toBe(true)
    // The hold shares the release path with tap-then-drag, so movement keeps tracking.
    expect(PAD.has('dragging = true')).toBe(true)
    expect(
      PAD.has(
        "if (dragging) { sendMove(true); dragging = false; padQueue(() => padRelease('drop'))",
      ),
    ).toBe(true)
  })

  it('the hold timer re-arms if it fired early (timers can fire early under load)', () => {
    const hold = PAD.between('const holdElapsed', 'const onDown')
    expect(hold.has('held < PAD_TAP_MS')).toBe(true)
    expect(hold.has('setTimeout(holdElapsed, PAD_TAP_MS - held)')).toBe(true)
  })

  it('the hint and the open line say press-and-hold, not right-click', () => {
    // Pinned on the wording, not the line breaks: where the hint wraps is a layout decision.
    // What must not drift is that both entrances are named in one statement and the result is
    // stated once.
    expect(PAD.has("['press and hold', 'button down, keep moving']")).toBe(true)
    expect(PAD.has("['tap, then drag', 'the same as press and hold']")).toBe(true)
    expect(PAD.has('press-and-hold (or tap-then-drag)=button held, tracking')).toBe(true)
    expect(PAD.has('long-press = right-click')).toBe(false)
  })

  // Press-and-hold and tap-then-drag are one state reached two ways, so the hint states it
  // once and does not use a separate word (`hold-drag`) for it.
  it('the hint does not present the hold twice, and does not say hold-drag', () => {
    const code = codeOnly(PAD) // comments may name it; the code must not
    expect(code.has('tap then drag = hold-drag')).toBe(false)
    expect(code.has('hold-drag')).toBe(false)
    // Exactly one line of the hint is about holding the button.
    const hint = PAD.between('const hintRows', 'hint.append')
    expect(hint.count('button down')).toBe(1)
  })
})

// Ctrl / Alt + press-and-hold. The feature is three injections in the right order with a
// release that cannot be skipped, so the order and the unconditionality are pinned.
describe('modPrefix: one spelling for a composed modifier', () => {
  it('builds the xdotool chord prefix, and nothing for an empty arm', () => {
    expect(modPrefix([])).toBe('')
    expect(modPrefix(['ctrl'])).toBe('ctrl+')
    expect(modPrefix(['ctrl', 'alt'])).toBe('ctrl+alt+')
  })

  it('is the server-parseable spelling: `key` takes the same prefix', () => {
    // The keys panel composes `ctrl+c` for `xdotool key`; the pad composes `ctrl` for
    // `xdotool keydown`. One prefix function, so a log line and a keysym cannot drift apart.
    expect(modPrefix(['ctrl']) + 'c').toBe('ctrl+c')
    expect(xdoArgs('key', modPrefix(['ctrl']) + 'c')).toEqual(['key', '--clearmodifiers', 'ctrl+c'])
  })
})

describe('source audit: the held modifier cannot be left down', () => {
  it('the modifiers go down before the button and come up after it, in reverse order', () => {
    const press = src.fn('padPress')
    // keydown … then the button.
    expect(press.indexOf("padTry('keydown'")).toBeGreaterThan(-1)
    expect(press.indexOf("padTry('keydown'")).toBeLessThan(press.indexOf("padTry('down'"))
    const rel = src.fn('padRelease')
    // mouseup first, then the modifiers, reversed.
    expect(rel.indexOf("padTry('up'")).toBeGreaterThan(-1)
    expect(rel.indexOf("padTry('up'")).toBeLessThan(rel.indexOf("padTry('keyup'"))
    expect(rel.has('[...h.mods].reverse()')).toBe(true)
  })

  it('the record is written before the injection and cleared before the release', () => {
    const press = src.fn('padPress')
    // `held.push(m)` precedes the keydown it describes: a keydown whose reply is lost still
    // happened on the X server, and the record is the only thing that knows to undo it.
    expect(press.indexOf('held.push(m)')).toBeGreaterThan(-1)
    expect(press.indexOf('held.push(m)')).toBeLessThan(press.indexOf("padTry('keydown'"))
    const rel = src.fn('padRelease')
    // Cleared first → idempotent, so a close racing a pointerup cannot double-release.
    expect(rel.has('const h = padDown\npadDown = null')).toBe(true)
  })

  it('every release is awaited and none of them can short-circuit on a failure', () => {
    const rel = codeOnly(src.fn('padRelease'))
    // Exactly one `return`: the `if (!h)` early-out when nothing is held. No `if (!ok) return`
    // between the releases, which is how a failed `mouseup` would strand the Ctrl behind it.
    expect(rel.count('return')).toBe(1)
    expect(rel.count('await padTry(')).toBe(2)
    // padTry swallows a throw as well, so a future x11Inject that rejects cannot strand Ctrl.
    expect(HOLD.has('try { await x11Inject(kind, arg, tag) } catch')).toBe(true)
  })

  it('the sequences are serialised, so a release can never overtake its press', () => {
    expect(HOLD.has('padSeq = padSeq.then(fn).catch(')).toBe(true)
    // Every call site queues; nothing calls padPress/padRelease directly off the chain.
    const calls = PAD.count(/pad(?:Press|Release)\(/) + CLOSE.count(/pad(?:Press|Release)\(/)
    const queued = PAD.count('padQueue(') + CLOSE.count('padQueue(')
    expect(calls).toBeGreaterThanOrEqual(6)
    expect(queued).toBeGreaterThanOrEqual(6)
  })

  it('closeVPad releases unconditionally: the pad closure is gone by then', () => {
    expect(CLOSE.has("padQueue(() => padRelease('pad closed'))")).toBe(true)
    // Not behind a state test: `padRelease` is a no-op when nothing is held, so there is
    // nothing to gate on and a gate is what would make it skippable.
    // (Neither `if (…) padQueue(() => padRelease(…))` nor the same thing in braces.)
    expect(CLOSE.has(/if\([^)]*\)\{?(?:padQueue\(\(\)=>)?padRelease/)).toBe(false)
  })

  it('a pointercancel releases unconditionally too', () => {
    const cancel = codeOnly(PAD.between('const onCancel', "ov.addEventListener('pointerdown'"))
    expect(cancel.has("padQueue(() => padRelease('pointer cancelled'))")).toBe(true)
    expect(cancel.has('if (dragging)')).toBe(false)
  })

  it('the arm is one-shot: taken (and disarmed) synchronously at the gesture', () => {
    // Inside the queued step it would be taken after the fact, so two quick taps could both
    // claim the same arm and the overlay's armed line would lag the gesture.
    expect(PAD.has('const mods = takeKeyMods()')).toBe(true)
    // The click, the hold and the wheel drag: every gesture that injects takes the arm.
    expect(PAD.count('takeKeyMods()')).toBe(3)
    for (const m of PAD.matches(/padQueue\(async\(\)=>\{[\s\S]*?\}\)/)) {
      expect(m).not.toContain('takeKeyMods')
    }
    expect(src.has('keyMod.ctrl = false; keyMod.alt = false; syncMods()')).toBe(true)
  })

  it('the log line and the overlay both name the armed modifier', () => {
    // `ctrl+press-and-hold (left)`, not `press-and-hold (left)`: a composed injection that logs
    // like an uncomposed one is indistinguishable from the feature not working.
    expect(PAD.has('`${modPrefix(mods)}press-and-hold (${padButtonName(padButton)})${why}`')).toBe(
      true,
    )
    expect(PAD.has('`${modPrefix(mods)}click (${padButtonName(btn)})`')).toBe(true)
    expect(PAD.has("armed=${armed.join('+')} (one-shot)")).toBe(true)
    expect(HOLD.has('armed (one-shot) — next tap = ')).toBe(true)
    // The keys panel's green fill is behind a full-screen overlay, so the pad renders it itself
    // and `syncMods` drives that too (one state, two readouts).
    expect(src.fn('syncMods').has('renderPadArmed()')).toBe(true)
  })

  it('a second finger releases any hold before the two-finger scroll starts', () => {
    const down = PAD.between('const onDown', 'const onMove')
    expect(down.has("padQueue(() => padRelease('two-finger scroll'))")).toBe(true)
    // The desktop mouse wheel over the pad is onSwipe, which never sees a modifier or a button.
    expect(PAD.has('onSwipe(dir)')).toBe(true)
  })
})

// The wheel. The strip and the two-finger drag both inject the X11 wheel (buttons 4/5) at the
// pointer. Pinned here:
//
//   1. the direction mapping, against the server's own argv: a wheel click with the wrong
//      button number is not an error anywhere, it scrolls the other way;
//   2. the strip is not in the `controls` table, which is also the touch-suppression
//      exemption: a gesture surface that stops suppressing drags the page behind the overlay;
//   3. the drag releases what it composed, through the same single guard as every other gesture.
describe('padWheelButton: the direction → X11 button mapping', () => {
  it('up is 4 and down is 5 (the X protocol numbering)', () => {
    expect(padWheelButton(-1)).toBe(4)
    expect(padWheelButton(1)).toBe(5)
  })

  it('the server turns each one into a real wheel click', () => {
    expect(xdoArgs('click', String(padWheelButton(-1)))).toEqual(['click', '4'])
    expect(xdoArgs('click', String(padWheelButton(1)))).toEqual(['click', '5'])
  })

  it('and they are outside the selector, which stops at 3', () => {
    // Otherwise the latch could land on a wheel button and every tap would become a scroll.
    for (const p of PAD_BUTTONS) expect(p.b).not.toBe(padWheelButton(-1) as number)
  })

  it('the step is coarse, because a wheel notch is several lines', () => {
    // A wheel notch is several lines in most clients (xterm: 5), so one notch takes more
    // finger travel than a comfortable tap target is tall.
    expect(PAD_WHEEL_PX).toBeGreaterThanOrEqual(44)
    expect(PAD_WHEEL_MAX).toBeGreaterThan(0)
  })
})

describe('source audit: the wheel strip', () => {
  const STRIP = PAD.between('const wheelBar', 'const ptrs = new Map')
  /** The strip's code, comments stripped, for the absence checks below. */
  const STRIP_CODE = codeOnly(STRIP)

  it('aims before it scrolls: a forced `move` opens the drag', () => {
    // A wheel click lands on the window under the pointer. `move` is coalesced, so the drag has
    // to force one out.
    const start = STRIP.between('const wheelStart', 'const wheelMove')
    expect(start.has('sendMove(true)')).toBe(true)
    expect(start.indexOf('sendMove(true)')).toBeGreaterThan(-1)
    expect(start.indexOf('sendMove(true)')).toBeLessThan(start.indexOf('takeKeyMods()'))
  })

  it("injects through the pad's own queue, so a notch cannot overtake the move that aimed it", () => {
    expect(STRIP.has("padQueue(() => padTry('click', String(b),")).toBe(true)
    // The button comes from the mapping, never from a literal at the site.
    expect(STRIP.has('const b = padWheelButton(dir)')).toBe(true)
    expect(STRIP_CODE.has(/padTry\('click','[45]'/)).toBe(false)
  })

  // The strip's sign is fixed; the two-finger gesture's is a setting. Dragging a
  // scrollbar-shaped strip down scrolls down, and that is not a convention.
  it('finger down = wheel down on the strip, which is not a convention but a scrollbar', () => {
    const move = STRIP.between('const wheelMove', 'const wheelEnd')
    expect(move.has('const dir: -1 | 1 = wheelAccum < 0 ? -1 : 1')).toBe(true)
    // No toggle reaches the strip.
    expect(move.has('padScrollNatural')).toBe(false)
    expect(move.has('twoFingerWheelDir')).toBe(false)
  })

  it('maps finger travel to a wheel button in each convention', () => {
    // `scrollAccum < 0` is "fingers went up"; -1 is wheel up (padWheelButton → 4).
    expect(twoFingerWheelDir(-30, false)).toBe(-1) // classic: fingers drive the wheel
    expect(twoFingerWheelDir(30, false)).toBe(1)
    expect(padWheelButton(twoFingerWheelDir(-30, false))).toBe(4)
    expect(padWheelButton(twoFingerWheelDir(-30, true))).toBe(5) // natural: content follows
  })

  // The default is natural, so out of the box the two-finger gesture and the strip turn the
  // wheel opposite ways for the same travel. That is deliberate: natural scrolling flips the
  // trackpad gesture and leaves the scrollbar alone.
  it('defaults to natural, and says so where the default is resolved', () => {
    expect(src.has("initFlag('scrollnat', SCROLLNAT_KEY, true)")).toBe(true)
    expect(src.has('let padScrollNatural = true')).toBe(true)
  })

  // The overlay acts on its chrome by geometry at `pointerup`, because a retargeted pointer
  // sequence may never produce a click. A control that also carried a click listener would run
  // twice under a finger, and a toggle that runs twice does nothing. (`selectPadButton`
  // survives the double path only because it is idempotent.) The simulator drives the page with
  // a mouse, which fires only one of the two paths, hence a source audit.
  it('the toggle has exactly one entry point: no click listener to double-fire', () => {
    const decl = PAD.between('const natBtn', 'ov.appendChild(natBtn)')
    expect(decl.has('addEventListener')).toBe(false)
    expect(decl.has('button(')).toBe(false) // the helper attaches a click handler
    expect(PAD.has('{ el: natBtn, act: flipScrollNat }')).toBe(true)
    expect(PAD.has('natBtn.click()')).toBe(false)
  })

  it('and the flip is reachable only from that table', () => {
    const calls = codeOnly(PAD).count('flipScrollNat')
    expect(calls).toBe(2) // the definition, and the table entry
  })

  it('the toggle flips the wheel, and the label shows the mapping rather than naming it', () => {
    expect(twoFingerWheelDir(-30, true)).toBe(1)
    expect(twoFingerWheelDir(30, true)).toBe(-1)
    expect(scrollNatLabel(false)).toBe('2f↑=wheel↑')
    expect(scrollNatLabel(true)).toBe('2f↑=wheel↓')
  })

  // The accumulator is drained by the direction the fingers went, so flipping the wheel must
  // not flip the drain: that would push the accumulator away from zero on every notch.
  it('drains the accumulator by travel, never by the (possibly inverted) wheel direction', () => {
    const scroll = PAD.from('const onMove').between('if (scrolling) {', 'if (!active) return')
    expect(scroll.has('const travel: -1 | 1 = scrollAccum < 0 ? -1 : 1')).toBe(true)
    expect(scroll.has('scrollAccum -= travel * PAD_WHEEL_PX')).toBe(true)
    expect(scroll.has('wheelNotch(twoFingerWheelDir(scrollAccum, padScrollNatural))')).toBe(true)
  })

  it('caps the notches per event, so a flick cannot queue dozens of injections', () => {
    const move = STRIP.between('const wheelMove', 'const wheelEnd')
    expect(move.has('Math.abs(wheelAccum) >= PAD_WHEEL_PX && n < PAD_WHEEL_MAX')).toBe(true)
  })

  it('releases what the drag composed, unconditionally, through the one guard', () => {
    expect(STRIP.has("padQueue(() => padRelease('wheel drag ended'))")).toBe(true)
    // The modifier is taken synchronously and pressed with btn=null (a wheel is not the latch).
    expect(STRIP.has('padQueue(() => padPress(null, mods, `${modPrefix(mods)}wheel drag`))')).toBe(
      true,
    )
    // Not behind an `if (mods.length)`: padPress with an empty arm still releases a stale hold.
    expect(STRIP_CODE.has(/if\(mods\.length\)\{?(?:padQueue\(\(\)=>)?padPress/)).toBe(false)
  })

  it('is not in the controls table: it must keep the touch suppression', () => {
    expect(PAD.has('controls.push({ el: wheelBar')).toBe(false)
    // No entry of the table, however it is written, is the strip.
    expect(PAD.has('{ el: wheelBar')).toBe(false)
    // Its hit test is geometric for `controlAt`'s reason (a capture retargets the DOM one).
    expect(STRIP.has('const inWheel = (x: number, y: number): boolean')).toBe(true)
    expect(STRIP.has('wheelBar.getBoundingClientRect()')).toBe(true)
  })

  it('takes only the first finger, so the two-finger scroll keeps working at the right edge', () => {
    const down = PAD.between('const onDown', 'const onMove')
    expect(down.has('if (wheelPtr === null && !ptrs.size && inWheel(e.clientX, e.clientY)')).toBe(
      true,
    )
    // Claimed before the press becomes one of the pad's contacts; otherwise the same finger
    // would also move the X pointer.
    expect(down.indexOf('wheelStart(e)')).toBeGreaterThan(-1)
    expect(down.indexOf('wheelStart(e)')).toBeLessThan(down.indexOf('ptrs.set('))
  })

  it("the strip pointer drives neither the pad's move nor its up", () => {
    const move = PAD.between('const onMove', 'const onUp')
    expect(move.has('if (e.pointerId === wheelPtr) { wheelMove(e); return }')).toBe(true)
    const up = PAD.between('const onUp', 'const onCancel')
    expect(
      up.has('if (e.pointerId === wheelPtr) { e.preventDefault(); wheelEnd(e, true); return }'),
    ).toBe(true)
    // The pad's own branches are reached only by a pointer that is in `ptrs`.
    expect(up.indexOf('wheelEnd(e, true)')).toBeGreaterThan(-1)
    expect(up.indexOf('wheelEnd(e, true)')).toBeLessThan(up.indexOf('const had = ptrs.delete'))
  })

  it("a cancel ends the strip without skipping the handler's unconditional release", () => {
    const cancel = codeOnly(PAD.between('const onCancel', "ov.addEventListener('pointerdown'"))
    expect(cancel.has('if (e.pointerId === wheelPtr) wheelEnd(e, false)')).toBe(true)
    expect(cancel.has('wheelEnd(e, false); return')).toBe(false) // no early return past the guard
    expect(cancel.has("padQueue(() => padRelease('pointer cancelled'))")).toBe(true)
  })

  it('a tap on an end is one notch, chosen by which half was hit', () => {
    const end = STRIP.from('const wheelEnd')
    expect(end.has('!wheelMoved && Date.now() - wheelAt <= PAD_TAP_MS')).toBe(true)
    expect(end.has('wheelNotch(e.clientY < r.top + r.height / 2 ? -1 : 1)')).toBe(true)
    // A cancel is not a tap.
    expect(end.has('if (lift && !wheelMoved')).toBe(true)
  })

  it('the fill has one pair of literals, so a drag cannot leave the strip lit', () => {
    // The "on" look is undone by writing the resting colour back, so there must be one copy of it.
    expect(STRIP.has('const WHEEL_BG =')).toBe(true)
    expect(STRIP_CODE.count('rgba(90,140,200')).toBe(2)
  })

  it('draws no thumb: there is no scroll position to report', () => {
    // X11 wheel clicks are fire-and-forget and the nested X cannot be asked how far an app has
    // scrolled, so a thumb would be invented state. The per-notch flash is the feedback instead.
    expect(STRIP_CODE.has('thumb')).toBe(false)
    expect(STRIP.has("g.style.color = '#5f6'")).toBe(true)
  })

  it("spans the mirror's bottom to the selector row, and cannot be squeezed to nothing", () => {
    expect(STRIP.has('rect ? Math.round(rect.bottom) + 8 : 64')).toBe(true)
    expect(STRIP.has('window.innerHeight - 200')).toBe(true)
    // The bottom is written as the selector row's own expression plus its height and a gap, so
    // no safe-area value can make the two overlap.
    expect(STRIP.has('bottom:calc(max(10px,env(safe-area-inset-bottom)) + 52px)')).toBe(true)
    const row = PAD.between('const selRow', 'const pills')
    expect(row.has('bottom:max(10px,env(safe-area-inset-bottom))')).toBe(true)
    // The hint reserves the strip's column with the strip's own inset expression, so a landscape
    // safe area moves both together.
    expect(PAD.has('right:calc(max(6px,env(safe-area-inset-right)) + 50px)')).toBe(true)
  })

  // A thumb curled over the side of the phone lands in the last few px of the screen. An inset
  // there would belong to the pad, so a reach that falls short would move the X pointer and
  // click. Hence flush, with the inset carried in the width: 0 + 44 + inset + the 6px gap = the
  // hint's `+ 50px`, pinned above.
  it('reaches the physical right edge, and keeps its 44px of aimable column doing it', () => {
    expect(STRIP.has('right:0;width:calc(44px + max(6px,env(safe-area-inset-right)))')).toBe(true)
    // The strip's own offset carries no inset.
    expect(STRIP_CODE.has('right:max(6px,env(safe-area-inset-right))')).toBe(false)
  })

  it('the hint says it is the wheel, and that it lands at the pointer', () => {
    const hint = PAD.between('const hintRows', 'hint.append')
    expect(hint.has("['right-edge strip', 'wheel at the pointer']")).toBe(true)
    // The two-finger drag is the same X11 wheel, and the hint says so.
    expect(hint.has("['two-finger drag', 'wheel;")).toBe(true)
    expect(hint.has('Up/Down keys')).toBe(false)
    // The hint names the control; the button carries the state, which changes while the pad is
    // open.
    expect(hint.has('corner button flips it')).toBe(true)
    expect(hint.has('scrollNatLabel')).toBe(false)
    // The open log line may carry the state: it is a timestamped record.
    expect(PAD.has('two fingers=wheel scroll (${scrollNatLabel(padScrollNatural)})')).toBe(true)
  })

  it('two fingers go through the same notch helper and constants as the strip', () => {
    // One implementation: if the strip's rate changes, the two-finger gesture changes with it.
    const scroll = PAD.from('const onMove').between('if (scrolling) {', 'if (!active) return')
    expect(scroll.has('Math.abs(scrollAccum) >= PAD_WHEEL_PX')).toBe(true)
    expect(scroll.has('wheelNotch(')).toBe(true)
    expect(scroll.has('onSwipe(')).toBe(false)
  })
})

describe("source audit: the pills get the ✕'s exemptions, from one table", () => {
  it('the touch gate is exempted by the shared geometric test, not by a second mechanism', () => {
    expect(PAD.has("suppressNativeTouchGestures(ov, 'vPad', inChrome)")).toBe(true)
    expect(
      PAD.has('const inChrome = (x: number, y: number): boolean => controlAt(x, y) !== null'),
    ).toBe(true)
    // One table, holding the ✕ and the pills.
    expect(PAD.has('const controls: { el: HTMLElement; act: () => void }[]')).toBe(true)
    expect(PAD.has('controls.push({ el: p.el, act: () => { selectPadButton(p.spec.b) } })')).toBe(
      true,
    )
    expect(PAD.count('const controlAt =')).toBe(1)
  })

  it("the pad's own pointerdown lets the chrome keep its press", () => {
    const down = PAD.between('const onDown', 'const onMove')
    expect(down.has('if (inChrome(e.clientX, e.clientY)) return')).toBe(true)
  })

  it('selection happens on pointerup by geometry (a capture cannot retarget a rectangle)', () => {
    const up = PAD.between('const onUp', 'const onCancel')
    expect(up.has('const hit = controlAt(e.clientX, e.clientY)')).toBe(true)
    expect(up.has('if (hit) { hit.act(); return }')).toBe(true)
    // Only when the press was on the chrome too, so a drag that ends over the row releases its
    // button instead of latching a new one and leaving the old one down.
    expect(up.has('if (!had) {')).toBe(true)
  })

  it('a hold timer that outlives the overlay cannot still inject a `down`', () => {
    const hold = PAD.between('const holdElapsed', 'const onDown')
    expect(hold.has('if (!vpadOpen ||')).toBe(true)
  })

  it('a latch change releases a held button first, so nothing can stay stuck down', () => {
    const sel = PAD.between('const selectPadButton', 'for (const p of pills) controls')
    expect(sel.has('if (b === padButton) return')).toBe(true) // idempotent
    expect(sel.has("padQueue(() => padRelease('button switch'))")).toBe(true)
    expect(sel.has('padButton = b')).toBe(true)
    expect(sel.has('syncPadButtons()')).toBe(true)
  })

  it('the latched pill is lit with setLit and named in words in the hint', () => {
    expect(PAD.has('setLit(p.el, p.spec.b === padButton)')).toBe(true)
    expect(PAD.has('hintBtn.textContent = `active button: ${padButtonLabel(padButton)}')).toBe(true)
  })

  it('there is no auto-revert to left: nothing assigns padButton outside selectPadButton', () => {
    expect(src.count(/padButton=(?!=)/)).toBe(1)
  })
})

// The pointer the glasses see. The pad drives the synthetic cursor the tiles are stamped with.
// Source-audited because neither half can be run in node, and a fault here is silent: the
// phone's own preview keeps drawing the arrow while the lens does not.

describe('source audit: the pad keeps the cursor on the panel and on whole pixels', () => {
  it('clamps to the last pixel (SCREEN_W/H - 1), not to the panel size', () => {
    // At exactly 576/288 `tileIndexAt` answers -1 (there is no quadrant there), so a cursor
    // parked on the bound would be in no tile and the arrow would not be drawn.
    expect(PAD.has('Math.min(SCREEN_W - 1, cursor.x + dx * s)')).toBe(true)
    expect(PAD.has('Math.min(SCREEN_H - 1, cursor.y + dy * s)')).toBe(true)
  })

  it('nothing indexes the index plane with the raw fractional cursor', () => {
    // `cursorTilePixel` is the one place `cursor.x/y` becomes a pixel, for the lens and for the
    // preview alike (see tests/client.overlay.test.ts).
    const stamp = codeOnly(src.fn('stampCursor'))
    expect(stamp.has('cursorTilePixel(cursor.x, cursor.y, i)')).toBe(true)
    expect(stamp.has(/cursor\.[xy]-/)).toBe(false)
    const mirror = codeOnly(src.fn('drawMirror'))
    expect(mirror.has('cursorTilePixel(cursor.x, cursor.y, i)')).toBe(true)
    expect(mirror.has('ctx.translate(cursor.x, cursor.y)')).toBe(false)
  })
})
