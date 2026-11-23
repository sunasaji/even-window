// even-window — shared phone-UI chrome: CSS constants, buttons, pills and the toast.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { log } from './debugLog.ts'

// Density: the gesture and tool rows put no CSS on their buttons. They are the platform's own
// `<button>` at the size the OS considers a control, which is what fits six to a phone row.
// A small target stays usable because:
//   * `touch-action: manipulation` on `html, body` (index.html) removes the 300ms
//     double-tap-to-zoom wait, so it registers on the first tap;
//   * `button:active { filter: invert(1) }` shows the press without changing the box (`filter`
//     is post-layout, so it cannot re-lay-out the row under a moving thumb);
//   * anything that needs a big target gets one explicitly (the vRing/vPad ✕ is 44x44).
// See docs/decisions/phone-native-button-chrome.md.

/** Shared chrome for every on-screen key. `appearance:none` is required for border-radius to
 *  take effect on iOS (Safari otherwise forces the native pill shape). Latched toggles
 *  (Ctrl / Alt / Shift) override `background` inline. */
export const KEY_CHROME =
  'appearance:none;-webkit-appearance:none;background:#e9e9e9;color:#111;' +
  'border:1px solid #c8c8c8;border-radius:6px;'

/** The dark field look for a native `<select>` (the pulldowns inside `▶ app`).
 *
 *  `color-scheme:dark` is load-bearing: without it a WebKitGTK WebView draws the select with a
 *  light native fill, ignoring `background` but honouring `color`, so the text is unreadable.
 *  It is scoped to these selects because a document-wide `color-scheme:dark` would also darken
 *  the native buttons, which are light on purpose. */
export const SELECT_CHROME =
  'background:#111;color:#E5E5E5;border:1px solid #333;border-radius:6px;' + 'color-scheme:dark;'

/** The overlay corner controls (vRing / vPad): 32px of ink inside a 44px touch target.
 *
 *  The hit box stays 44px via a transparent border, and `padChromeTop` lifts it so its bottom
 *  meets the mirror's top instead of covering the panel. `background-clip:padding-box` is
 *  load-bearing: without it the fill paints under the transparent border and the circle is
 *  visually 44px again. */
export const PAD_CHROME_CSS =
  'width:32px;height:32px;border-radius:22px;border:6px solid transparent;' +
  'box-shadow:0 0 0 1px #555 inset;background:#222;background-clip:padding-box;' +
  'color:#E5E5E5;font:15px system-ui;box-sizing:content-box;padding:0;'

/** Where an overlay's top-corner control sits, in CSS px from the viewport top.
 *
 *  `inset` is the resting position; the box is pulled up from it so that its 44px hit rectangle
 *  ends no later than the mirror's top edge. Clamped at 0 so the button stays on screen when
 *  the mirror leaves no room. */
export function padChromeTop(rectTop: number | null, boxH = 44, inset = 8): number {
  if (rectTop === null) return inset
  return Math.max(0, Math.min(inset, Math.round(rectTop) - boxH))
}

/** Shared CSS for a full-screen gesture overlay (vRing / vPad): the properties that stop the
 *  platform from claiming the contact (vPad's hold-drag has the shape of iOS's long-press
 *  selection gesture).
 *
 *    * `touch-action:none`: no panning/zooming. The effective value is the intersection down
 *      the ancestor chain, so it also covers the ✕ inside the overlay.
 *    * `user-select:none` (+ `-webkit-`): the overlay is not a selection host. Not enough alone;
 *      the page behind it must not be one either (index.html).
 *    * `-webkit-touch-callout:none`: no iOS long-press callout. */
export const OVERLAY_TOUCH_CSS =
  'touch-action:none;user-select:none;-webkit-user-select:none;' + '-webkit-touch-callout:none;'

/** The dim behind a full-screen gesture overlay (vPad / vRing).
 *
 *  One constant because each overlay paints it twice, as its own `background` when there is no
 *  mirror and as the box-shadow spread around the mirror hole, and all sites must match.
 *
 *  0.92 is the alpha at which the page's native light buttons (≈ `#EFEFEF`) lose their labels
 *  and remain only as faint rectangles; at 0.90 they still read as buttons. Not 1.0: the
 *  residual veil is the cue that the ✕ returns to the page. The hole over the mirror is never
 *  dimmed. */
export const OVERLAY_DIM = 'rgba(0,0,0,0.92)'

/** Cancel the native default of the touch events on a full-screen overlay.
 *
 *  Not redundant with `preventDefault()` in the pointer handlers: cancelling `pointerdown` only
 *  suppresses the compatibility mouse events. Scrolling, selection and the callout are defaults
 *  of the underlying `touchstart`, removed only by `touch-action` or `touchstart.preventDefault()`.
 *
 *  A gate only: it reads no state and adds no mapping. The first suppression per open is logged.
 *
 *  `exempt` is a geometric hit test, never `e.target`: under `setPointerCapture` the DOM target
 *  is retargeted to the overlay, and cancelling `touchend` inside a control would suppress its
 *  `click`. */
export function suppressNativeTouchGestures(
  ov: HTMLElement,
  tag: string,
  exempt: (x: number, y: number) => boolean,
): void {
  let logged = false
  const gate = (e: TouchEvent): void => {
    const t = e.touches[0] ?? e.changedTouches[0]
    if (t && exempt(t.clientX, t.clientY)) return
    // A move that the compositor already turned into a scroll arrives non-cancelable; calling
    // preventDefault() on it only logs a console error.
    if (!e.cancelable) return
    e.preventDefault()
    if (!logged) {
      logged = true
      log(`${tag}: native touch defaults suppressed (selection / callout / scroll)`)
    }
  }
  ov.addEventListener('touchstart', gate, { passive: false })
  ov.addEventListener('touchmove', gate, { passive: false })
  ov.addEventListener('touchend', gate, { passive: false })
}

/** A pill in the gesture / tool rows: a native button. No `style.cssText`, by design (see the
 *  density note above). */
export function button(label: string, fn: () => void, title = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  if (title) b.title = title
  b.addEventListener('click', fn)
  return b
}

/** Latched look for a toggle that is on (keys, vRing, vPad, ent): inverted, the same effect as
 *  press feedback. It works on a native button, where `border-color` would not, and is
 *  post-layout, so it cannot move the row. */
export function setLit(b: HTMLElement | null, on: boolean): void {
  if (!b) return
  b.style.filter = on ? 'invert(1)' : ''
}

/** A wrapping row of pills. The 6px gap is part of the density. */
export function pillRow(...kids: HTMLElement[]): HTMLDivElement {
  const d = document.createElement('div')
  d.style.cssText = 'margin:8px 0;display:flex;gap:6px;flex-wrap:wrap'
  d.append(...kids)
  return d
}

// The toast: transient feedback for a launch, whose result reaches the mirror only via the 1 Hz
// window poll. Above the vRing / vPad touch layers (9999), which dim the page and are where a
// launch from the glasses menu is driven from; below the pairing and server-guard screens.
// `pointer-events:none` so it never takes a gesture meant for the layer beneath it.
const TOAST_CSS =
  'display:none;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);' +
  'z-index:10000;pointer-events:none;max-width:90%;box-sizing:border-box;background:#2a2320;color:#ffd9b0;' +
  'border:1px solid #a5673a;border-radius:8px;padding:8px 12px;font:12px/1.4 system-ui;' +
  'box-shadow:0 2px 8px rgba(0,0,0,.5);'

const TOAST_MS = 2600

let toastEl: HTMLElement | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

export function toast(msg: string): void {
  if (!toastEl) {
    toastEl = document.createElement('div')
    toastEl.style.cssText = TOAST_CSS
    document.body.appendChild(toastEl)
  }
  toastEl.textContent = msg
  toastEl.style.display = 'block'
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastTimer = null
    if (toastEl) toastEl.style.display = 'none'
  }, TOAST_MS)
}
