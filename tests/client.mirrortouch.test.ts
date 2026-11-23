// even-window — mirror touch: absolute aim on the preview, without opening vPad.
//
//   1. The arithmetic. `mirrorPixel` turns a finger on a phone into a pixel on a 576x288 panel,
//      and every way it can be wrong is silent: a fractional coordinate is dropped by the index
//      plane, a point clamped to 576 belongs to no tile, and a degenerate rectangle divides by
//      zero and injects `NaN`. The output is also checked against the server's own `xdoArgs`.
//   2. A source audit of the gesture's injection sites. The handlers need a DOM, a bridge and
//      an X server to run, so their invariants are read out of the source: the aiming `move` is
//      in the same queued step as the press, the lift drops where the finger ended, the button
//      is never a literal, the release cannot be skipped, no `dblclick` is wired, and the arrow
//      stays vPad's.

import { describe, expect, it } from 'vitest'
import { MIRROR_BUTTON, mirrorPixel } from '../src/client/mirrorTouch.ts'
import { padClickatArg } from '../src/client/vpad.ts'
import { xdoArgs } from '../src/server/platform/x11/input.ts'
import { SCREEN_H, SCREEN_W } from '../src/shared/geom.ts'
import { clientSource } from './helpers/source.ts'

const src = clientSource()
/** The whole mirror-touch section, by name: the mapping, the gesture's steps and the wiring. */
const MT = src.fns(
  'mirrorPixel',
  'mirrorAim',
  'mirrorTap',
  'mirrorDragOpen',
  'mirrorDragEnd',
  'wireMirrorTouch',
)
/** Code only: the comments in that section describe what it refuses to do, so an audit that
 *  checks for absence must not read them. */
const MT_CODE = MT.code()
/** `mountUi`'s preview block, where the canvas is built and the surface is wired. */
const PREVIEW = src
  .fn('mountUi')
  .between(
    "mirrorEl = document.createElement('canvas')",
    "const textRow = document.createElement('div')",
  )

/** A phone-width mirror: 576 panel pixels drawn into 288 CSS px, 10px down the page. */
const RECT = { left: 0, top: 10, width: 288, height: 144 }

describe('mirrorPixel — the finger → panel-pixel mapping', () => {
  it('maps the rectangle onto the panel, scale included', () => {
    expect(mirrorPixel(RECT, 0, 10)).toEqual({ x: 0, y: 0 })
    expect(mirrorPixel(RECT, 144, 82)).toEqual({ x: 288, y: 144 })
    // One CSS pixel is two panel pixels at this width.
    expect(mirrorPixel(RECT, 1, 11)).toEqual({ x: 2, y: 2 })
  })

  it("subtracts the rectangle's own offset (the mirror is not at the origin)", () => {
    const r = { left: 16, top: 100, width: 288, height: 144 }
    expect(mirrorPixel(r, 16, 100)).toEqual({ x: 0, y: 0 })
    expect(mirrorPixel(r, 160, 172)).toEqual({ x: 288, y: 144 })
  })

  it('returns integers: a fractional index is dropped silently by the plane', () => {
    for (const [x, y] of [
      [0.5, 10.5],
      [73.3, 41.9],
      [287.99, 153.99],
    ] as const) {
      const p = mirrorPixel(RECT, x, y)
      expect(p).not.toBeNull()
      expect(Number.isInteger(p?.x)).toBe(true)
      expect(Number.isInteger(p?.y)).toBe(true)
    }
  })

  it('floors rather than rounds, so a point cannot leave the quadrant it is in', () => {
    // 143.9 CSS px is panel x=287.8: the last pixel of the left half, not the first of the
    // right one. `Math.round` would move it across the quadrant boundary.
    expect(mirrorPixel(RECT, 143.9, 10)).toEqual({ x: 287, y: 0 })
  })

  it('clamps to the last pixel, never to the bound (576/288 belong to no tile)', () => {
    expect(mirrorPixel(RECT, 288, 154)).toEqual({ x: SCREEN_W - 1, y: SCREEN_H - 1 })
    expect(mirrorPixel(RECT, 10_000, 10_000)).toEqual({ x: SCREEN_W - 1, y: SCREEN_H - 1 })
  })

  it('clamps a drag that left the canvas instead of going negative or NaN', () => {
    // Pointer capture keeps delivering moves from outside the rectangle; "past the left edge"
    // reads as "the edge".
    expect(mirrorPixel(RECT, -40, -40)).toEqual({ x: 0, y: 0 })
  })

  it('answers null for a rectangle with no area: a mirror that is not laid out yet', () => {
    expect(mirrorPixel({ left: 0, top: 0, width: 0, height: 144 }, 5, 5)).toBeNull()
    expect(mirrorPixel({ left: 0, top: 0, width: 288, height: 0 }, 5, 5)).toBeNull()
    // The alternative to null is NaN reaching the X server.
    expect(mirrorPixel({ left: 0, top: 0, width: NaN, height: NaN }, 5, 5)).toBeNull()
  })
})

describe('MIRROR_BUTTON: one button, no mode', () => {
  it("is the left button: right-click is vPad's job", () => {
    expect(MIRROR_BUTTON).toBe(1)
  })

  it('the server turns the tap this surface sends into a left click at that pixel', () => {
    const p = mirrorPixel(RECT, 144, 82)
    expect(p).not.toBeNull()
    expect(xdoArgs('clickat', padClickatArg(p?.x ?? -1, p?.y ?? -1, MIRROR_BUTTON))).toEqual([
      'mousemove',
      '288',
      '144',
      'click',
      '1',
    ])
  })

  it("and the drag's press/release are that same button on its own", () => {
    expect(xdoArgs('down', String(MIRROR_BUTTON))).toEqual(['mousedown', '1'])
    expect(xdoArgs('up', String(MIRROR_BUTTON))).toEqual(['mouseup', '1'])
  })
})

describe("source audit: the gesture's injection sites", () => {
  it('never writes a button literal: every site names MIRROR_BUTTON', () => {
    // A wrong button number is not an error anywhere in the stack (the server defaults it to 1),
    // so a site that was never threaded through says nothing at all.
    expect(MT.has('padClickatArg(p.x, p.y, MIRROR_BUTTON)')).toBe(true)
    expect(MT.has('padPress(MIRROR_BUTTON, mods, tag)')).toBe(true)
    expect(MT_CODE.has(/padClickatArg\([^)]*,\d\)/)).toBe(false)
    expect(MT_CODE.has(/padPress\(\d/)).toBe(false)
  })

  it("does not read vPad's latch: a Right latched there must not change a mirror tap", () => {
    expect(MT_CODE.has('padButton,')).toBe(false)
    expect(MT_CODE.has('padButton)')).toBe(false)
  })

  it('aims and presses in one queued step, aim first', () => {
    // `padMove` is fire-and-forget, so an aiming move sent that way can be overtaken by the
    // `down` that follows, and the drag would start at the previous position.
    const open = src.fn('mirrorDragOpen')
    expect(open.has('padQueue(async () => {')).toBe(true)
    expect(open.indexOf("padTry('move'")).toBeGreaterThan(-1)
    expect(open.indexOf("padTry('move'")).toBeLessThan(open.indexOf('padPress('))
  })

  it('drops the drag where the finger ended, in one step with the release', () => {
    const dragEnd = src.fn('mirrorDragEnd')
    expect(dragEnd.indexOf("padTry('move'")).toBeGreaterThan(-1)
    expect(dragEnd.indexOf("padTry('move'")).toBeLessThan(dragEnd.indexOf('padRelease('))
    expect(dragEnd.has('padQueue(async () => {')).toBe(true)
  })

  it('takes the `keys` arm synchronously, so two quick taps cannot share one one-shot', () => {
    // Never inside the queued step (the same shape vPad's own audit pins).
    expect(MT.count('takeKeyMods()')).toBe(2) // the tap, and the drag
    for (const name of ['mirrorTap', 'mirrorDragOpen', 'mirrorDragEnd']) {
      // From the queued step to the end of its function: the take is not in there.
      const queued = src.fn(name).from('padQueue(async () => {')
      expect(queued.has('takeKeyMods'), name).toBe(false)
    }
  })

  it('names the composed modifier in the log tag, like every other injection here', () => {
    // A `ctrl+click` that logs as a `click` is indistinguishable from the arm not working.
    expect(MT.has('`${modPrefix(mods)}mirror tap (${padButtonName(MIRROR_BUTTON)})`')).toBe(true)
    expect(MT.has('`${modPrefix(mods)}mirror drag (${padButtonName(MIRROR_BUTTON)})`')).toBe(true)
  })

  it('presses and releases only through the module-scope guard', () => {
    // No `x11Inject('down')` of its own: `padPress`/`padRelease` are the only code that holds
    // anything, which is what lets closeVPad, a cancel and a failed injection all undo it.
    expect(MT_CODE.has(/x11Inject\('(?:down|up|keydown|keyup)'/)).toBe(false)
    expect(MT_CODE.has(/padTry\('(?:down|up|keydown|keyup)'/)).toBe(false)
  })

  it('releases on a cancel unconditionally: a held button must not survive it', () => {
    const endFn = src
      .fn('wireMirrorTouch')
      .between('const end = (e: PointerEvent', "el.addEventListener('pointerdown'")
    expect(endFn.has("padQueue(() => padRelease('mirror contact cancelled'))")).toBe(true)
    // A cancel is not a tap: the platform took the contact away, so nothing is clicked.
    expect(endFn.has('if (!lift) { padQueue')).toBe(true)
    expect(endFn.indexOf('if (!lift)')).toBeGreaterThan(-1)
    expect(endFn.indexOf('if (!lift)')).toBeLessThan(endFn.indexOf('mirrorTap('))
  })

  it('wires no `dblclick`: two taps are two clicks, judged by the X client', () => {
    expect(MT_CODE.has('dblclick')).toBe(false)
    expect(MT_CODE.has('lastTapEnd')).toBe(false)
  })

  it('never shows the arrow: turning `cursor.shown` on belongs to vPad', () => {
    // The pointer belief is kept true (`mirrorAim`) so a later vPad open starts from the real
    // position (vPad's first move is absolute), but nothing is drawn on the lens.
    expect(MT.has('function mirrorAim')).toBe(true)
    expect(MT.has('cursor.x = p.x\ncursor.y = p.y')).toBe(true)
    expect(MT_CODE.has(/cursor\.shown=/)).toBe(false)
  })

  it('repaints if something else is showing the arrow, so the lens cannot go stale', () => {
    // `window.ewCursor.show(true)` can show the arrow. A moved cursor that is not repainted
    // leaves the lens drawing an arrow where the pointer no longer is. The repaint is the only
    // one here, and it is behind the read.
    expect(MT.has('if (cursor.shown) refreshCursorTiles()')).toBe(true)
    expect(MT_CODE.count('refreshCursorTiles()')).toBe(1)
  })

  it('stands down while vPad is open, but only at the press', () => {
    const down = src
      .fn('wireMirrorTouch')
      .between("el.addEventListener('pointerdown'", "el.addEventListener('pointermove'")
    expect(down.has('if (vpadOpen) return')).toBe(true)
    // A gesture already in flight runs to its lift: stranding a held button would be worse
    // than finishing a drag the user started.
    const move = src
      .fn('wireMirrorTouch')
      .between("el.addEventListener('pointermove'", "el.addEventListener('pointerup'")
    expect(move.has('vpadOpen')).toBe(false)
  })

  it('ignores a second finger and a physical right/middle button', () => {
    const down = src
      .fn('wireMirrorTouch')
      .between("el.addEventListener('pointerdown'", "el.addEventListener('pointermove'")
    expect(down.has('if (mtPtr !== null) return')).toBe(true)
    expect(down.has("if (e.pointerType === 'mouse' && e.button !== 0) return")).toBe(true)
  })

  it("coalesces the drag's moves at the pad's own rate, and reuses its travel threshold", () => {
    // The pad's constants, not a second set to tune.
    expect(MT.has('PAD_MOVE_MS')).toBe(true)
    expect(MT.has('PAD_MOVE_THRESH')).toBe(true)
    expect(src.code().has(/constMIRROR_(?:MOVE_MS|MOVE_THRESH|TAP_MS)/)).toBe(false)
  })
})

describe("source audit: the canvas gives up the platform's touch defaults", () => {
  it('carries `touch-action:none`, which is what makes a drag a drag', () => {
    expect(PREVIEW.has('touch-action:none')).toBe(true)
  })

  it('and cancels the touch defaults `preventDefault` on a pointer cannot reach', () => {
    // Selection, the callout and the scroll are defaults of the underlying `touchstart`;
    // cancelling `pointerdown` suppresses only the compatibility mouse events.
    expect(MT.has("suppressNativeTouchGestures(el, 'mirror touch', () => false)")).toBe(true)
  })

  it('is wired exactly once, from mountUi, with no latch to forget', () => {
    expect(PREVIEW.has('wireMirrorTouch(mirrorEl)')).toBe(true)
    expect(src.count('wireMirrorTouch(')).toBe(2) // the definition and that call
    // No pill, no persisted flag: the only gate is vPad.
    expect(src.has(/mirrorTouchOn|ew\.mtouch/)).toBe(false)
  })

  it('tells the user what it costs, on the element itself', () => {
    // The mirror can no longer start a page scroll, and the title says so.
    expect(PREVIEW.has('mirrorEl.title =')).toBe(true)
    expect(PREVIEW.has('page scroll')).toBe(true)
  })
})
