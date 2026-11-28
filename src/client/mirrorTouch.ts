// pinhole-window — touch on the mirror preview: tap and drag at absolute coordinates.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { SCREEN_H, SCREEN_W } from '../shared/geom.ts'
import { suppressNativeTouchGestures } from './chrome.ts'
import { log } from './debugLog.ts'
import { padMove } from './gestures.ts'
import { modPrefix, takeKeyMods } from './oskb.ts'
import { previewText } from './statusUi.ts'
import { cursor, refreshCursorTiles } from './tiles.ts'
import {
  PAD_MOVE_MS,
  PAD_MOVE_THRESH,
  type PadButton,
  padButtonLabel,
  padButtonName,
  padClickatArg,
  padPress,
  padQueue,
  padRelease,
  padTry,
  vpadOpen,
} from './vpad.ts'

// Mirror touch: absolute aim on the preview, with no overlay (docs/phone-ui.md,
// docs/decisions/phone-pointer-surfaces.md). It complements vPad rather than replacing it:
//
//   vPad          relative aim, while looking at the glasses: arrow, wheel, button selector.
//   mirror touch  absolute aim, while looking at the phone: left-button tap and drag only.
//
// It never shows the arrow on the lens (`cursor.shown` is untouched) but keeps `cursor.x/y`
// true, so a later vPad open starts from where the pointer is. There is no double-click kind:
// two quick taps are two `clickat` injections, and the X client decides whether they are one.
//
// The mirror is not a place to start a page scroll from: `touch-action:none` is what turns a
// finger drag into a drag on the nested X.

/** The button every mirror gesture uses. vPad's latch (`padButton`) is deliberately not read:
 *  right-click is vPad's job. Named because a wrong button number is not an error anywhere in
 *  the stack; it just does the wrong thing. */
export const MIRROR_BUTTON: PadButton = 1

/** Pure: a client point and the mirror's rectangle → the nested-X pixel under it.
 *
 *  Integer: `cursor` is stamped into a `Uint8Array` index plane, where a fractional subscript
 *  writes nothing, and the server rounds too. `Math.floor`, so a point cannot round up out of
 *  the quadrant `tileIndexAt` names for it. Clamped to the last pixel (576 and 288 belong to no
 *  tile), which also keeps a captured drag that leaves the canvas pinned to the edge.
 *
 *  `null` only for a degenerate rectangle (a mirror not laid out yet), which would otherwise
 *  inject `NaN`. */
export function mirrorPixel(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  const px = Math.floor(((x - rect.left) / rect.width) * SCREEN_W)
  const py = Math.floor(((y - rect.top) / rect.height) * SCREEN_H)
  return {
    x: Math.max(0, Math.min(SCREEN_W - 1, px)),
    y: Math.max(0, Math.min(SCREEN_H - 1, py)),
  }
}

/** The contact that owns the mirror, or null. One at a time: multi-finger gestures belong to
 *  vPad, so a second finger here is ignored. */
let mtPtr: number | null = null
/** Is the button held down for a drag? Only selects the lift's branch; `padDown` is the record
 *  that gets released. */
let mtDragging = false
/** Has this contact travelled past `PAD_MOVE_THRESH`? Until it has, it is a candidate tap and
 *  nothing has been injected. */
let mtMoved = false
/** Where the contact started, in client pixels: the travel test's origin. */
let mtFromX = 0,
  mtFromY = 0
/** Time of the last `padMove`, for coalescing at the pad's rate (PAD_MOVE_MS). */
let mtLastSend = 0
/** The mirror rectangle, read once at the press and reused for the whole gesture: the layout
 *  cannot change under a `touch-action:none` drag, and re-reading costs a reflow per event. */
let mtRect: { left: number; top: number; width: number; height: number } | null = null
/** The nested-X pixel this gesture last resolved to. The lift drops the drag here, not where
 *  the last coalesced move landed. */
let mtPoint = { x: 0, y: 0 }
/** The usage line is logged once per page, at the first use. */
let mtAnnounced = false

/** Keep the client's belief about the X pointer true without showing it.
 *
 *  `cursor.shown` is untouched, so this draws nothing. vPad's first move sends an absolute
 *  position, so a stale belief would teleport the pointer away from the thing just clicked. */
function mirrorAim(p: { x: number; y: number }): void {
  cursor.x = p.x
  cursor.y = p.y
  // If something else is showing the arrow (`window.pwCursor.show(true)`), it must not go
  // stale: the lens would draw the arrow where the pointer no longer is.
  if (cursor.shown) refreshCursorTiles()
}

/** A tap: one `clickat` at the pixel under the finger, under the `keys` arm if there is one.
 *
 *  Any duration: a contact that never travelled is a click whenever it is lifted. A tap ceiling
 *  would leave a dead band where a contact resolves to nothing.
 *
 *  The arm is taken synchronously, not inside the queued step, so two quick taps cannot both
 *  claim the same one-shot. */
function mirrorTap(p: { x: number; y: number }): void {
  const mods = takeKeyMods()
  const tag = `${modPrefix(mods)}mirror tap (${padButtonName(MIRROR_BUTTON)})`
  padQueue(async () => {
    await padPress(null, mods, tag)
    await padTry('clickat', padClickatArg(p.x, p.y, MIRROR_BUTTON), tag)
    await padRelease(tag)
  })
}

/** Open a drag: aim, then put the button down, both in one queued step.
 *
 *  `padMove` is fire-and-forget and not on the chain, so an aiming move sent that way could be
 *  overtaken by the `down` after it, and the drag would start at the previous pointer position.
 *
 *  Everything held goes through `padPress`, so `padRelease` can always undo it. */
function mirrorDragOpen(p: { x: number; y: number }): void {
  const mods = takeKeyMods()
  const tag = `${modPrefix(mods)}mirror drag (${padButtonName(MIRROR_BUTTON)})`
  mtDragging = true
  mtLastSend = Date.now()
  padQueue(async () => {
    await padTry('move', `${p.x},${p.y}`, tag)
    await padPress(MIRROR_BUTTON, mods, tag)
  })
}

/** End a drag: the final position and the release in one queued step, so the `up` cannot
 *  overtake the last coalesced `move` and drop at the wrong pixel. */
function mirrorDragEnd(p: { x: number; y: number }, why: string): void {
  mtDragging = false
  padQueue(async () => {
    await padTry('move', `${p.x},${p.y}`, `mirror drop · ${why}`)
    await padRelease(`mirror ${why}`)
  })
}

/** Wire the preview canvas as an absolute-coordinate touch surface. Called once, from
 *  `mountUi`; the only gate is vPad (see the `pointerdown` handler).
 *
 *  Pointer events plus `setPointerCapture`: a drag keeps arriving after the finger leaves the
 *  canvas, and `mirrorPixel` clamps it to the edge.
 *
 *  `pointerdown.preventDefault()` cancels only the compatibility mouse events. `touch-action:none`
 *  on the canvas (set in `mountUi`) handles the scroll and `suppressNativeTouchGestures` the
 *  rest, exempting nothing because this element has no chrome of its own. */
export function wireMirrorTouch(el: HTMLCanvasElement): void {
  const end = (e: PointerEvent, lift: boolean): void => {
    mtPtr = null
    mtRect = null
    try {
      el.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (mtDragging) {
      mirrorDragEnd(mtPoint, lift ? 'drop' : 'contact cancelled')
      return
    }
    // A cancel is not a tap (the platform took the contact away), so nothing is injected. The
    // release is queued unconditionally: `padRelease` is a no-op when nothing is held, and a
    // button must never be left down on the X server.
    if (!lift) {
      padQueue(() => padRelease('mirror contact cancelled'))
      return
    }
    if (!mtMoved) mirrorTap(mtPoint)
    // else: the contact travelled but never opened a drag. The travel test is what opens one,
    // so this cannot happen; doing nothing is the right default.
  }

  el.addEventListener(
    'pointerdown',
    e => {
      // The only gate, and only at the press: vPad owns the whole screen while it is open. A
      // gesture already in flight when vPad opens still runs to its lift, so no button is stranded.
      if (vpadOpen) return
      // The preview is showing the menu or the voice dialog. A touch here would click the nested-X
      // window behind the text; the gesture pills drive the dialog instead.
      if (previewText !== null) return
      if (mtPtr !== null) return // one contact only (see `mtPtr`)
      // A physical right or middle button is not remapped (right-click is vPad's job). Letting it
      // through also keeps the canvas's context menu.
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const r = el.getBoundingClientRect()
      const p = mirrorPixel(r, e.clientX, e.clientY)
      if (!p) return // not laid out yet
      e.preventDefault()
      if (!mtAnnounced) {
        mtAnnounced = true
        log(
          'mirror touch: absolute aim on the preview — tap=click, drag=press-drag-release' +
            ` · button=${padButtonLabel(MIRROR_BUTTON)} (right button and the arrow are vPad's)`,
        )
      }
      mtPtr = e.pointerId
      mtRect = r
      mtFromX = e.clientX
      mtFromY = e.clientY
      mtMoved = false
      mtDragging = false
      mtPoint = p
      mirrorAim(p)
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* moves still arrive on the canvas */
      }
      // Nothing is injected yet. A tap is `clickat`, move and click in one invocation
      // (src/server/input.ts); only a drag needs a separate aiming move.
    },
    { passive: false },
  )

  el.addEventListener(
    'pointermove',
    e => {
      if (e.pointerId !== mtPtr) return // a hover, or vPad's finger: not ours
      e.preventDefault()
      const p = mtRect ? mirrorPixel(mtRect, e.clientX, e.clientY) : null
      if (!p) return
      mtPoint = p
      mirrorAim(p)
      if (
        !mtMoved &&
        (Math.abs(e.clientX - mtFromX) >= PAD_MOVE_THRESH ||
          Math.abs(e.clientY - mtFromY) >= PAD_MOVE_THRESH)
      ) {
        mtMoved = true
        mirrorDragOpen(p)
        return // the open already aimed at this pixel
      }
      if (!mtDragging) return
      const now = Date.now()
      if (now - mtLastSend < PAD_MOVE_MS) return // the pad's own coalescing rate
      mtLastSend = now
      padMove(p.x, p.y)
    },
    { passive: false },
  )

  el.addEventListener(
    'pointerup',
    e => {
      if (e.pointerId !== mtPtr) return
      e.preventDefault()
      end(e, true)
    },
    { passive: false },
  )

  el.addEventListener(
    'pointercancel',
    e => {
      if (e.pointerId !== mtPtr) return
      end(e, false)
    },
    { passive: false },
  )

  suppressNativeTouchGestures(el, 'mirror touch', () => false)
}
