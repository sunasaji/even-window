// even-window — vPad, the on-phone trackpad.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { SCREEN_H, SCREEN_W } from '../shared/geom.ts'
import type { InputKind } from '../shared/types.ts'
import {
  button,
  KEY_CHROME,
  OVERLAY_DIM,
  OVERLAY_TOUCH_CSS,
  PAD_CHROME_CSS,
  padChromeTop,
  setLit,
  suppressNativeTouchGestures,
} from './chrome.ts'
import { log } from './debugLog.ts'
import { onSwipe, padMove, x11Inject } from './gestures.ts'
import { modPrefix, takeKeyMods } from './oskb.ts'
import { mirrorEl, vpadBtn } from './phoneUi.ts'
import {
  padScrollNatural,
  persistScrollNatural,
  scrollNatLabel,
  setPadScrollNatural,
  twoFingerWheelDir,
} from './settings.ts'
import { cursor, refreshCursorTiles, refreshGrey, setCursorTile } from './tiles.ts'
import { errText } from './util.ts'
import { closeVRing } from './vring.ts'

// vPad drives the nested X pointer through `POST /api/desktop/input` (`move` / `clickat` / `down` /
// `up`); the glasses gestures are keys only. See docs/phone-ui.md and
// docs/decisions/phone-pointer-surfaces.md.
//
// Motion is relative, not absolute: the pad is the whole screen but the nested X is 576x288, so
// a direct mapping would be jumpy and unreachable at the edges.
//
// The pointer is composited client-side (`cursor`): the server captures without the mouse, so
// the pad shows itself on the glasses by driving the `cursor` state baked into each tile.

/** Pointer-move coalescing: at most one POST per this many ms while dragging. */
export const PAD_MOVE_MS = 55
/** Finger travel (CSS px) before a press becomes a drag rather than a tap. */
export const PAD_MOVE_THRESH = 6
/** A press shorter than this, with no travel, is a click; longer is a press-and-hold.
 *
 *  One threshold, so every contact resolves to exactly one of: tap-click, press-and-hold,
 *  drag-move, two-finger scroll. A second, longer threshold would leave a dead band. */
const PAD_TAP_MS = 300
/** A fresh press within this long after a tap starts a hold-drag (tap-then-drag). */
const PAD_PRIME_MS = 450

/** A press on `Submit` longer than this sends without the app's submit key. The pad's number,
 *  so "how long is a hold" has one answer on this screen. Short is acceptable because the
 *  gesture it arms is the harmless one: it types the line instead of running it. */
export const SUBMIT_HOLD_MS = PAD_TAP_MS
/** How long a press must last before the hint under `Submit` appears. Shorter than the hold,
 *  longer than a tap: an ordinary send must not flash it. */
export const SUBMIT_HINT_MS = 120
/** Relative gain: finger pixels → nested-X pixels, on top of the mirror's own scale. */
const PAD_GAIN = 1.25

// The wheel (the right-edge strip and the two-finger scroll).

/** Finger travel (CSS px) per wheel notch. A wheel notch is several lines in most clients
 *  (xterm's default is 5). 51 was tuned and confirmed by thumb on the phone (34 was too fast);
 *  do not re-derive it from a client's line count. */
export const PAD_WHEEL_PX = 51
/** Notches per `pointermove`. A flick arrives as a few large deltas, and without a cap one of
 *  them would queue dozens of injections that keep firing after the finger stopped. */
export const PAD_WHEEL_MAX = 4

/** The X11 button for a wheel direction: 4 = up, 5 = down, which `xdotool click` takes verbatim
 *  (`button()` in src/server/input.ts clamps to 1-5).
 *
 *  A function rather than two literals: a wheel click with the wrong button number is not an
 *  error anywhere in the stack, it scrolls the other way. The test pins it against `xdoArgs`. */
export function padWheelButton(dir: -1 | 1): 4 | 5 {
  return dir < 0 ? 4 : 5
}

// The mouse-button selector is modal, not momentary (docs/decisions/phone-vpad-button-selector.md).
//
// A latch, because "press a button, hold it, drag, release" is how Athena and Motif menus work
// (xfontsel, xterm's own menus), and a momentary click is down+up with nothing in between.
// A long press is therefore a hold of the latched button, never a right click.
//
// The cost is mode error, mitigated by: the latched pill is lit (`setLit`); the hint line names
// the active button; there is no auto-revert to left, and the latch survives close/reopen.

/** An X11 pointer button this pad can latch. Not 4/5: those are the wheel. */
export type PadButton = 1 | 2 | 3

/** The selector's three pills, in physical left-to-right order. The label carries the word and
 *  the number, the same number the server, xdotool and the log lines use. */
export const PAD_BUTTONS: ReadonlyArray<{
  readonly b: PadButton
  readonly label: string
  readonly name: string
  readonly title: string
}> = [
  { b: 1, label: 'Left (1)', name: 'left', title: 'Taps and holds use button 1 (select, drag)' },
  { b: 2, label: 'Middle (2)', name: 'middle', title: 'Button 2 — X11 primary-selection paste' },
  { b: 3, label: 'Right (3)', name: 'right', title: 'Button 3 — menus in most X clients' },
]

/** Pill text for a button number. Log lines and the hint reuse it, so they cannot disagree
 *  about what is latched. */
export function padButtonLabel(b: number): string {
  return PAD_BUTTONS.find(p => p.b === b)?.label ?? `button ${String(b)}`
}

/** Short name for a log tag: `x11 clickat (middle) => ok`. */
export function padButtonName(b: number): string {
  return PAD_BUTTONS.find(p => p.b === b)?.name ?? String(b)
}

/** The `clickat` argument, `"x,y[,button]"` (docs/protocol.md).
 *
 *  A named function so the button cannot be dropped at the call site: a `clickat` without one
 *  is not an error (the server defaults it to 1), so the omission would be silent.
 *  tests/client.vpad.test.ts feeds this into the server's own `xdoArgs`. */
export function padClickatArg(x: number, y: number, b: PadButton): string {
  return `${Math.round(x)},${Math.round(y)},${b}`
}

/** The latched button. Module scope so it survives close/reopen. */
let padButton: PadButton = 1

// Ctrl / Alt + press-and-hold. xterm's own menus open with Ctrl + a held mouse button, so the
// sequence is spelled out injection by injection: `keydown ctrl` → `mousedown N` → … →
// `mouseup N` → `keyup ctrl` (the `keydown` / `keyup` kinds in src/server/input.ts).
//
// A held modifier is dangerous state: if the pad closes, the pointer is cancelled, the latch
// moves or an injection fails, the `keyup` must still happen, or the nested X keeps Ctrl down
// and mangles every later keystroke. Three things make that unconditional, and they are why
// this lives at module scope rather than in `openVPad`'s closure:
//
//   1. `padDown` records what is pressed, and is written before the injection that presses it
//      (a `down` whose reply is lost still happened on the X server);
//   2. `padRelease` clears the record first and then releases everything it held, awaiting each
//      injection and never short-circuiting on a failure; `closeVPad` calls it unconditionally;
//   3. `padQueue` serialises the sequences, so a release can never overtake the press it is
//      releasing.

/** What vPad currently holds down in the nested X: the pointer button (null = modifiers only,
 *  for a click) and the modifier keysyms pressed for it, in press order. */
let padDown: { btn: PadButton | null; mods: readonly string[] } | null = null

/** One chain for every press/release the pad makes, so ordering is guaranteed across the
 *  `await`s. A rejection is logged and swallowed: the next queued step must still run, because
 *  that step is usually the release. */
let padSeq: Promise<void> = Promise.resolve()
export function padQueue(fn: () => Promise<void>): void {
  padSeq = padSeq.then(fn).catch((e: unknown) => {
    log(`vPad sequence failed: ${errText(e)}`)
  })
}

/** One injection that must not be able to abort a sequence. `x11Inject` resolves false instead
 *  of rejecting, but the release path must hold even if that changes. */
export async function padTry(kind: InputKind, arg: string, tag: string): Promise<void> {
  try {
    await x11Inject(kind, arg, tag)
  } catch (e) {
    log(`vPad ${kind} ${tag} threw: ${errText(e)}`)
  }
}

/** Press the modifiers (in order) and then, if given, the pointer button. `tag` is the log tag
 *  for the `down` itself, e.g. `ctrl+press-and-hold (left)`. */
export async function padPress(
  btn: PadButton | null,
  mods: readonly string[],
  tag: string,
): Promise<void> {
  // Nothing is pressed on top of something already pressed: that would lose the older record,
  // the only thing that knows how to release it.
  if (padDown) await padRelease('superseded')
  if (btn == null && !mods.length) return
  const held: string[] = []
  padDown = { btn, mods: held } // same array: it grows as each keysym goes down
  for (const m of mods) {
    held.push(m) // recorded before the injection, never after
    await padTry('keydown', m, `${m} · for ${tag}`)
  }
  if (btn != null) await padTry('down', String(btn), tag)
}

/** The guard. Release everything the pad holds, pointer button first, then the modifiers in
 *  reverse press order, unconditionally. Idempotent: the record is cleared first, so a second
 *  caller is a no-op. */
export async function padRelease(why: string): Promise<void> {
  const h = padDown
  padDown = null
  if (!h) return
  if (h.btn != null) await padTry('up', String(h.btn), `release ${padButtonName(h.btn)} · ${why}`)
  for (const m of [...h.mods].reverse()) await padTry('keyup', m, `release ${m} · ${why}`)
}

// ── latched modifiers ──────────────────────────────────────────────────────────────────────
// Ctrl / Alt / Shift have a pill each in the pad's top row. A lit pill goes with every tap,
// hold and wheel action until it is tapped again; closing the pad clears all three. They are
// lit on the pad itself, which is what makes a lasting modifier acceptable here: the `keys`
// panel is behind the overlay, so a modifier latched there would be invisible
// (docs/decisions/phone-vpad-latched-modifiers.md).
//
// The latch is this page's state only. On the X side a modifier is pressed for one action and
// released after it, through `padPress` / `padRelease`, so nothing stays down between actions.

const PAD_MODS = ['ctrl', 'alt', 'shift'] as const
export type PadMod = (typeof PAD_MODS)[number]
const padMod: Record<PadMod, boolean> = { ctrl: false, alt: false, shift: false }

/** The lit modifiers as xdotool keysyms, in a fixed order. A fresh array each call: a press
 *  keeps the one it was given until its release. */
export function padMods(): string[] {
  return PAD_MODS.filter(m => padMod[m])
}

/** Pure: the pills' state after `m` is tapped. Each pill is its own toggle; they combine. */
export function padModToggled(
  state: Readonly<Record<PadMod, boolean>>,
  m: PadMod,
): Record<PadMod, boolean> {
  return { ...state, [m]: !state[m] }
}

export let vpadOpen = false

/** A hover step: the previous hover sample plus the new point → the nested-X pixel the cursor
 *  moves to, or `null` when there is no previous sample (a position is not a move).
 *
 *  A Bluetooth trackpad on iOS reports `type=mouse` moves with no button pressed, so vPad has
 *  a hover path. It is relative: the wearer looks at the glasses, and the OS cursor's own
 *  position is ignored; only its movement is read (docs/notes/2026-10-vpad-pointer-and-wheel.md).
 *
 *  The scale is the mirror's own, with no `PAD_GAIN`: the gain compensates for a finger being
 *  a coarse instrument, and a pointer is not one.
 *
 *  The delta is computed from our own previous sample rather than `movementX/Y`, which an
 *  engine may report and never fill in.
 *
 *  Clamped to the last pixel: 576 and 288 belong to no tile, so a cursor parked on the bound
 *  would stop being drawn. */
export function hoverStep(
  prev: { x: number; y: number } | null,
  x: number,
  y: number,
  scale: number,
  cur: { x: number; y: number },
): { x: number; y: number } | null {
  if (!prev) return null
  return {
    x: Math.max(0, Math.min(SCREEN_W - 1, cur.x + (x - prev.x) * scale)),
    y: Math.max(0, Math.min(SCREEN_H - 1, cur.y + (y - prev.y) * scale)),
  }
}

export function openVPad(): void {
  if (vpadOpen) return
  closeVRing() // mutually exclusive with vRing (see openVRing)
  vpadOpen = true
  setLit(vpadBtn, true)
  cursor.shown = true
  refreshCursorTiles() // also seeds `cursorTile` for the incremental path
  // A Ctrl / Alt armed in `keys` before opening comes along as a lit pill. It is taken from
  // `keys`, so it is not also waiting there when the pad closes.
  for (const m of takeKeyMods()) if (m === 'ctrl' || m === 'alt') padMod[m] = true
  // The latched button is in the open line because it survives close/reopen, and so are the lit
  // modifiers: both change what the next tap injects. Press-and-hold and tap-then-drag are the
  // same state (the latched button held, movement still tracking) with one release path
  // (`padRelease`).
  const armed = padMods()
  log(
    `vPad OPEN — button=${padButtonLabel(padButton)}` +
      (armed.length ? ` · latched=${armed.join('+')}` : '') +
      ' · drag=move · tap=click · press-and-hold (or tap-then-drag)=button held, tracking' +
      ` · two fingers=wheel scroll (${scrollNatLabel(padScrollNatural)})` +
      ' · right-edge strip=the same wheel',
  )

  const ov = document.createElement('div')
  ov.style.cssText =
    `position:fixed;inset:0;z-index:9999;background:${OVERLAY_DIM};` +
    OVERLAY_TOUCH_CSS +
    'color:#9ecbff;font:13px/1.6 system-ui'

  // Both top corners clear the mirror. Read here because `rect` is declared further down.
  const chromeTop = padChromeTop(mirrorEl ? mirrorEl.getBoundingClientRect().top : null)
  const cornerCss = (side: 'left' | 'right'): string =>
    `position:absolute;top:max(${String(chromeTop)}px,env(safe-area-inset-top));` +
    `${side}:max(8px,env(safe-area-inset-${side}));z-index:2;`

  const close = button('✕', () => {
    closeVPad()
  })
  close.style.cssText = cornerCss('right') + PAD_CHROME_CSS
  ov.appendChild(close)

  // The scroll-direction toggle, in the other top corner. Not in the pill row: that row is a
  // modal selector in which every pill answers the same question.
  //
  // The label is the mapping. `setLit` is not used: this is a choice between two mappings, not
  // an on/off.
  //
  // It has no `click` listener. The chrome in this overlay is acted on by geometry at
  // `pointerup` (see `controlAt`), so a control that also had a click listener would run twice
  // on a touch, and a toggle that runs twice does nothing. The mouse path fires only one of the
  // two, so the simulator cannot show this. Its one entry point is the `controls` table.
  const natBtn = document.createElement('button')
  natBtn.textContent = scrollNatLabel(padScrollNatural)
  natBtn.title =
    'which way a two-finger drag turns the wheel. The right-edge strip is' +
    ' unaffected: dragging a scrollbar-shaped thing down scrolls down, and that is not a' +
    ' convention'
  const flipScrollNat = (): void => {
    setPadScrollNatural(!padScrollNatural)
    persistScrollNatural()
    natBtn.textContent = scrollNatLabel(padScrollNatural)
    log(
      `vPad two-finger scroll: ${scrollNatLabel(padScrollNatural)}` +
        ` (${padScrollNatural ? 'natural / phone-like' : 'classic / X11-like'})`,
    )
  }
  // The same 32px-ink-in-44px-box construction as the ✕, in pill form, so it ends above the
  // mirror rather than on it.
  natBtn.style.cssText =
    cornerCss('left') +
    'height:32px;padding:0 9px;border:6px solid transparent;border-radius:22px;' +
    'box-shadow:0 0 0 1px #555 inset;background:#222;background-clip:padding-box;' +
    'color:#E5E5E5;font:11px ui-monospace,monospace;box-sizing:content-box'
  ov.appendChild(natBtn)

  // Ctrl / Alt / Shift, after the scroll toggle in the same row. The same ink-in-a-box
  // construction, a little narrower so the row clears the ✕ on a 360px screen. Like the toggle
  // they have no `click` listener: their one entry point is the `controls` table.
  const modRow = document.createElement('div')
  modRow.style.cssText = cornerCss('left') + 'display:flex;align-items:center'
  // The toggle moves into the row; its own corner position is the row's now.
  natBtn.style.position = 'static'
  modRow.appendChild(natBtn)
  const modBtns = new Map<PadMod, HTMLButtonElement>()
  const paintMods = (): void => {
    for (const [m, b] of modBtns) {
      // Lit = the green of an armed key in `keys`, so the two read as the same thing.
      // `backgroundColor`, not the shorthand: that would reset `background-clip` and paint
      // the transparent border too.
      b.style.backgroundColor = padMod[m] ? '#2b6' : '#222'
      b.style.color = padMod[m] ? '#06210f' : '#E5E5E5'
      b.setAttribute('aria-pressed', padMod[m] ? 'true' : 'false')
    }
  }
  for (const m of PAD_MODS) {
    const b = document.createElement('button')
    b.textContent = m[0]?.toUpperCase() + m.slice(1)
    b.title = `hold ${m} for every tap, hold and wheel action until tapped again`
    b.style.cssText =
      // The same box as the toggle on every side: a border of unequal widths under one radius
      // draws the inner edge as an egg. The negative margin closes the doubled gap instead.
      'height:32px;padding:0 8px;border:6px solid transparent;margin-left:-6px;' +
      'border-radius:22px;box-shadow:0 0 0 1px #555 inset;background-clip:padding-box;' +
      'font:11px ui-monospace,monospace;box-sizing:content-box'
    modBtns.set(m, b)
    modRow.appendChild(b)
  }
  paintMods()
  ov.appendChild(modRow)
  const flipMod = (m: PadMod): void => {
    Object.assign(padMod, padModToggled(padMod, m))
    paintMods()
    const on = padMods()
    log(`vPad ${m} ${padMod[m] ? 'ON' : 'off'} — latched=${on.length ? on.join('+') : 'none'}`)
  }

  /** One table of the pad's own chrome (the ✕, the scroll toggle, the button pills) with the
   *  action each performs. Every exemption in this overlay reads this table and nothing else.
   *
   *  Geometry rather than `e.target`: the pad calls `setPointerCapture` on the overlay, and
   *  while a capture is live every pointer event is retargeted to it, so a press on the ✕
   *  arrives with `target === ov`. A hit rectangle cannot be retargeted.
   *
   *  The pills are in the same table for the same reason: a press on a pill must not fall
   *  through to the pad (it would inject a `clickat`), and a `touchend` cancelled over a pill
   *  would suppress the event its action rides on.
   *
   *  Takes coordinates rather than the event so the touch gate (which sees `Touch`, not
   *  `PointerEvent`) shares these rectangles. */
  const controls: { el: HTMLElement; act: () => void }[] = [
    {
      el: close,
      act: () => {
        closeVPad()
      },
    },
    // The toggle's only entry point: two entry points would flip it twice (see where `natBtn`
    // is built).
    { el: natBtn, act: flipScrollNat },
    ...PAD_MODS.map(m => ({
      el: modBtns.get(m) as HTMLElement,
      act: () => {
        flipMod(m)
      },
    })),
  ]
  const controlAt = (x: number, y: number): { act: () => void } | null => {
    for (const c of controls) {
      const r = c.el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return c
    }
    return null
  }
  const inChrome = (x: number, y: number): boolean => controlAt(x, y) !== null

  const hint = document.createElement('div')
  // Sits above the selector row, so the two never overlap on a short viewport.
  //
  // `right` reserves the wheel strip's column: the strip's width (44px plus the right
  // safe-area inset) and a 6px gap, written with the strip's own inset expression so both move
  // together. The block is centred on the pad's usable area.
  hint.style.cssText =
    'position:absolute;left:0;bottom:78px;' +
    'right:calc(max(6px,env(safe-area-inset-right)) + 50px);' +
    'text-align:center;pointer-events:none;padding:0 12px'
  const hintHead = document.createElement('div')
  hintHead.style.cssText = 'font-size:16px;color:#e5e5e5;margin-bottom:4px'
  hintHead.textContent = 'vPad — virtual trackpad'
  /** The latched button in words, not only as an inverted pill. */
  const hintBtn = document.createElement('div')
  hintBtn.style.cssText = 'color:#e5e5e5;margin-bottom:4px'
  // A table, gesture on the left and what it does on the right: the pad is used by glancing
  // at it, and a column of gestures can be scanned where sentences have to be read. Tap-then-
  // drag points at press-and-hold instead of repeating it: they reach the same state.
  const hintRows: readonly (readonly [string, string])[] = [
    ['drag', 'move the pointer'],
    ['tap', 'click'],
    ['press and hold', 'button down, keep moving'],
    ['tap, then drag', 'the same as press and hold'],
    // Names the control, not the state: the state is on the corner button's face and changes
    // while this overlay is up.
    ['two-finger drag', 'wheel; corner button flips it'],
    // The strip aims the same wheel by the pointer.
    ['right-edge strip', 'wheel at the pointer'],
    // A mouse / trackpad behaves differently from a finger here, so the hint says so.
    ['mouse / trackpad', 'moves the arrow, no press'],
  ]
  const hintRest = document.createElement('div')
  hintRest.style.cssText =
    'display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;text-align:left;' +
    'max-width:340px;margin:6px auto 0'
  for (const [gesture, effect] of hintRows) {
    // The mouse row is a size down: it is for the few who pair a pointing device, and its
    // label is the widest, which sets the width of the whole left column. The two longest
    // effects are a size down too; with their wording they fit one line on a 390px screen.
    const smallRow = gesture === 'mouse / trackpad'
    const smallEffect = smallRow || gesture === 'press and hold' || gesture === 'two-finger drag'
    const k = document.createElement('span')
    k.style.cssText =
      'color:#e5e5e5;font-weight:600;white-space:nowrap' + (smallRow ? ';font-size:12px' : '')
    k.textContent = gesture
    const v = document.createElement('span')
    if (smallEffect) v.style.fontSize = '12px'
    v.textContent = effect
    hintRest.append(k, v)
  }
  const hintFoot = document.createElement('div')
  // Wider than the table: it runs into the hint's side padding, which a short centred
  // paragraph does not need.
  hintFoot.style.cssText = 'color:#888;font-size:12px;line-height:1.5;margin:8px -8px 0'
  // Two sentences, two lines: left to wrap, the second starts with a lone ✕ at a line's end.
  hintFoot.style.whiteSpace = 'pre-line'
  hintFoot.textContent =
    'Ctrl / Alt / Shift at the top stay on until tapped again.\n' +
    '✕ closes; the pointer is drawn on the glasses too.'
  hint.append(hintHead, hintBtn, hintRest, hintFoot)
  ov.appendChild(hint)

  // A marker at the virtual pointer, placed over the preview canvas, so the phone gives
  // immediate feedback instead of waiting a capture frame.
  const dot = document.createElement('div')
  dot.style.cssText =
    'position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
    'border:2px solid #5f6;background:rgba(85,255,102,0.35);pointer-events:none;z-index:1'
  ov.appendChild(dot)
  let rect = mirrorEl ? mirrorEl.getBoundingClientRect() : null
  const placeDot = (): void => {
    if (!rect) return
    dot.style.left = `${rect.left + (cursor.x / SCREEN_W) * rect.width}px`
    dot.style.top = `${rect.top + (cursor.y / SCREEN_H) * rect.height}px`
  }
  // Keep the live mirror visible through the dim. pointer-events stay off the hole so the pad
  // still gets every touch.
  if (rect) {
    const hole = document.createElement('div')
    // Square hole: the 576x288 panel it frames has square corners.
    hole.style.cssText =
      `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
      `width:${rect.width}px;height:${rect.height}px;` +
      `box-shadow:0 0 0 9999px ${OVERLAY_DIM};pointer-events:none`
    ov.style.background = 'transparent'
    ov.insertBefore(hole, ov.firstChild)
  }
  placeDot()

  /** The previous hover sample (`hoverStep`). Null until the pointer produces its first move;
   *  never read by touch. */
  let hoverAt: { x: number; y: number } | null = null
  let active = false,
    moved = false,
    dragging = false,
    primed = false
  let sx = 0,
    sy = 0,
    lx = 0,
    ly = 0,
    startAt = 0,
    lastSend = 0,
    lastTapEnd = 0
  let scrolling = false,
    scrollLast = 0,
    scrollAccum = 0
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  const clearHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
  }

  const sendMove = (force: boolean): void => {
    const now = Date.now()
    if (!force && now - lastSend < PAD_MOVE_MS) return
    lastSend = now
    padMove(cursor.x, cursor.y)
    refreshCursorTiles() // re-bake the pointer into the affected tiles only
  }
  /** A click, optionally under the lit modifiers: `keydown ctrl` → `clickat` → `keyup ctrl`.
   *
   *  The modifiers are read synchronously here, not inside the queued step, so a pill tapped
   *  after this tap does not change it. */
  const clickAt = (btn: PadButton): void => {
    const mods = padMods()
    const tag = `${modPrefix(mods)}click (${padButtonName(btn)})`
    padQueue(async () => {
      await padPress(null, mods, tag)
      await padTry('clickat', padClickatArg(cursor.x, cursor.y, btn), tag)
      await padRelease(tag)
    })
  }
  /** Open a hold: the lit modifiers, then the latched button, left down until a release.
   *  `padPress` records before it injects and `padRelease` is the single way out. */
  const holdDown = (why: string): void => {
    const mods = padMods()
    const tag = `${modPrefix(mods)}press-and-hold (${padButtonName(padButton)})${why}`
    dragging = true
    padQueue(() => padPress(padButton, mods, tag))
  }

  // The button selector, at the bottom edge where a thumb rests, below the hint.
  const selRow = document.createElement('div')
  selRow.style.cssText =
    'position:absolute;left:0;right:0;z-index:2;' +
    'bottom:max(10px,env(safe-area-inset-bottom));' +
    'display:flex;gap:8px;justify-content:center;align-items:center'
  const pills = PAD_BUTTONS.map(spec => {
    const el = document.createElement('button')
    el.textContent = spec.label
    el.title = spec.title
    // A hand-picked 44px target: on a modal surface a mis-tap injects into the nested X.
    // `min-width` only equalises the three pills.
    //
    // Square corners need `appearance:none` (a native `<button>` is a rounded pill on iOS and
    // the UA sheet wins against a bare `border-radius:0`), which removes the native fill, hence
    // KEY_CHROME with the radius dropped. `setLit`'s `filter:invert(1)` still works on it.
    el.style.cssText =
      KEY_CHROME + 'border-radius:0;min-height:44px;min-width:92px;font:14px system-ui'
    selRow.appendChild(el)
    return { spec, el }
  })
  ov.appendChild(selRow)

  const syncPadButtons = (): void => {
    for (const p of pills) setLit(p.el, p.spec.b === padButton)
    // Short enough to stay on one line at 360px. The wheel paths do not take the latched button.
    hintBtn.textContent = `active button: ${padButtonLabel(padButton)} — taps and holds use it`
  }

  /** Latch a button. Idempotent, so it is safe to drive from the geometric `pointerup` path
   *  even if a stray `click` reaches it too. */
  const selectPadButton = (b: PadButton): void => {
    if (b === padButton) return
    // Never leave a button or a modifier stuck down on the X server: if the latch moves while
    // something is held, release it first. `padRelease` releases the recorded button rather
    // than re-reading the latch.
    dragging = false
    padQueue(() => padRelease('button switch'))
    padButton = b
    syncPadButtons()
    log(`vPad button => ${padButtonLabel(b)}`)
  }
  for (const p of pills)
    controls.push({
      el: p.el,
      act: () => {
        selectPadButton(p.spec.b)
      },
    })
  syncPadButtons()

  // The wheel strip: right edge, from under the mirror down to the pills.
  //
  // It injects the X11 wheel (`click 4` / `click 5`), which goes to the window under the
  // pointer.
  //
  // It is shaped like a scrollbar but has no thumb: X11 wheel clicks are fire-and-forget and the
  // scroll position is unknown. Instead each notch flashes the end it went towards, which shows
  // that the gesture fired (many X clients ignore the wheel).
  //
  // Geometry: top = under the mirror; bottom = one 8px gap above the selector row, written as
  // that row's own bottom expression so no safe-area value can make the two overlap.
  //
  // Flush with the physical edge (`right:0`), with no inset: a gap there would belong to the
  // pad, so a reach for the strip that falls short would become a pointer move and a click. The
  // width carries the inset instead (44px + the inset), so the strip's left edge, which the hint
  // reserves against, is independent of the safe area.
  const wheelBar = document.createElement('div')
  /** The strip's fill at rest, and while a drag owns it. One pair of literals, so the "on" look
   *  is always undone by writing the same "off" value back. */
  const WHEEL_BG = 'rgba(90,140,200,0.10)',
    WHEEL_BG_ON = 'rgba(90,140,200,0.24)'
  // Clamped so a landscape phone, where the mirror reaches far down the screen, cannot squeeze
  // the strip to nothing. ~100px of travel (2 notches) is the floor.
  const wheelTop = Math.max(
    56,
    Math.min(rect ? Math.round(rect.bottom) + 8 : 64, window.innerHeight - 200),
  )
  wheelBar.style.cssText =
    `position:fixed;top:${String(wheelTop)}px;` +
    'bottom:calc(max(10px,env(safe-area-inset-bottom)) + 52px);' +
    'right:0;width:calc(44px + max(6px,env(safe-area-inset-right)));' +
    'z-index:2;box-sizing:border-box;' +
    // Square, like the pills and the dim's hole.
    `border:1px solid #39506b;background:${WHEEL_BG};` +
    'display:flex;flex-direction:column;align-items:center;justify-content:space-between;' +
    // `overflow:hidden`: on the shortest strip the clamp allows, the vertical label would
    // otherwise push the ▼ past the bottom border. Clipping the word is the right loss.
    'overflow:hidden;padding:6px 0;color:#9ecbff;font:15px/1 system-ui'
  wheelBar.title =
    'wheel strip — drag for X11 wheel clicks (buttons 4/5) at the pointer;' +
    ' tap the top half for one notch up, the bottom half for one down'
  const wheelUp = document.createElement('div')
  wheelUp.textContent = '▲'
  const wheelDn = document.createElement('div')
  wheelDn.textContent = '▼'
  const wheelLbl = document.createElement('div')
  wheelLbl.textContent = 'wheel'
  // Vertical, because a 44px column cannot hold the word any other way.
  wheelLbl.style.cssText =
    'writing-mode:vertical-rl;font-size:11px;letter-spacing:2px;color:#7f93ad'
  wheelBar.append(wheelUp, wheelLbl, wheelDn)
  ov.appendChild(wheelBar)

  /** The strip's hit rectangle. Geometric, for `controlAt`'s reason: the pad captures the
   *  pointer on the overlay.
   *
   *  Not in the `controls` table, deliberately. That table is also the touch-suppression
   *  exemption, and the strip is a gesture surface like the pad itself: it must keep
   *  `touchstart.preventDefault()`, or a drag along it scrolls the page behind the overlay. It
   *  also needs the whole drag, not a `pointerup` action. */
  const inWheel = (x: number, y: number): boolean => {
    const r = wheelBar.getBoundingClientRect()
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
  }

  /** One notch. Queued like every other injection the pad makes, so it can never overtake the
   *  `move` that aimed it or the modifier press that composes it (`padQueue`).
   *
   *  Logged per notch: the rate is bounded (one per PAD_WHEEL_PX of travel, PAD_WHEEL_MAX per
   *  event), and a client that ignores the wheel otherwise looks like a strip that is not
   *  firing. */
  const wheelNotch = (dir: -1 | 1): void => {
    const b = padWheelButton(dir)
    padQueue(() =>
      padTry('click', String(b), `wheel ${dir < 0 ? 'up' : 'down'} (button ${String(b)})`),
    )
    const g = dir < 0 ? wheelUp : wheelDn
    g.style.color = '#5f6'
    setTimeout(() => {
      g.style.color = ''
    }, 140)
  }

  /** The pointer that owns the strip, or null. Separate from `ptrs` (the pad's own contacts): a
   *  strip drag must not move the X pointer, and a second finger landing on the strip must not
   *  open the pad's two-finger scroll. */
  let wheelPtr: number | null = null
  let wheelY = 0,
    wheelFrom = 0,
    wheelAccum = 0,
    wheelAt = 0,
    wheelMoved = false

  const wheelStart = (e: PointerEvent): void => {
    e.preventDefault()
    try {
      ov.setPointerCapture(e.pointerId)
    } catch {
      /* moves still arrive on the overlay */
    }
    wheelPtr = e.pointerId
    wheelY = wheelFrom = e.clientY
    wheelAccum = 0
    wheelAt = Date.now()
    wheelMoved = false
    wheelBar.style.background = WHEEL_BG_ON
    // Aim first. A wheel click lands on the window under the pointer; `move` is coalesced, so
    // this forces one out.
    sendMove(true)
    // The lit modifiers go with the whole drag (ctrl+wheel is zoom in most clients).
    // Read synchronously, pressed through `padPress` and released through the single guard, so
    // a close, a cancel or a failed injection mid-drag cannot leave Ctrl down.
    //
    // Unconditional rather than `if (mods.length)`: with an empty arm `padPress` presses nothing
    // but still releases anything the pad was holding.
    const mods = padMods()
    padQueue(() => padPress(null, mods, `${modPrefix(mods)}wheel drag`))
  }

  const wheelMove = (e: PointerEvent): void => {
    e.preventDefault()
    wheelAccum += e.clientY - wheelY
    wheelY = e.clientY
    if (Math.abs(e.clientY - wheelFrom) >= PAD_MOVE_THRESH) wheelMoved = true
    let n = 0
    while (Math.abs(wheelAccum) >= PAD_WHEEL_PX && n < PAD_WHEEL_MAX) {
      // Finger down = wheel down, like a scrollbar thumb. The two-finger toggle does not apply
      // to the strip.
      const dir: -1 | 1 = wheelAccum < 0 ? -1 : 1
      wheelNotch(dir)
      wheelAccum -= dir * PAD_WHEEL_PX
      n++
    }
  }

  /** End of a strip contact. `lift` = a real `pointerup` (a cancel is not a tap).
   *
   *  The tap: no travel, inside the tap ceiling, still on the strip → one notch, chosen by which
   *  half was hit. It is the only way to ask for a single notch. */
  const wheelEnd = (e: PointerEvent, lift: boolean): void => {
    wheelPtr = null
    wheelBar.style.background = WHEEL_BG
    try {
      ov.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (
      lift &&
      !wheelMoved &&
      Date.now() - wheelAt <= PAD_TAP_MS &&
      inWheel(e.clientX, e.clientY)
    ) {
      const r = wheelBar.getBoundingClientRect()
      wheelNotch(e.clientY < r.top + r.height / 2 ? -1 : 1)
    }
    padQueue(() => padRelease('wheel drag ended'))
  }

  const ptrs = new Map<number, { x: number; y: number }>()
  const midY = (): number => {
    let sum = 0
    for (const p of ptrs.values()) sum += p.y
    return ptrs.size ? sum / ptrs.size : 0
  }

  /** Press-and-hold: the press outlived the tap ceiling without travelling, so put the latched
   *  button down and leave it down. `onMove` keeps tracking (it only needs `active`), and the
   *  release goes out through the same `dragging` branch a tap-then-drag uses.
   *
   *  The elapsed-time recheck is needed: under frame-transfer load timers can fire far early
   *  (a 320ms timer in ~5ms), which would put the button down on a tap. The callback verifies
   *  the wall clock and re-arms for the remainder. */
  const holdElapsed = (): void => {
    holdTimer = null
    // `vpadOpen` too: a timer armed by one finger can outlive the pad if another pointer closes
    // it, and a `down` injected after the overlay is gone would never get its `up`.
    if (!vpadOpen || !active || moved || dragging) return
    const held = Date.now() - startAt
    if (held < PAD_TAP_MS) {
      holdTimer = setTimeout(holdElapsed, PAD_TAP_MS - held)
      return
    }
    sendMove(true)
    holdDown('')
  }

  const onDown = (e: PointerEvent): void => {
    // The pad's own chrome keeps its press: it is handled on `pointerup` by geometry, and
    // falling through here would inject a `clickat` into the nested X.
    if (inChrome(e.clientX, e.clientY)) return
    // The wheel strip owns a press that starts on it, and takes it before the press becomes one
    // of the pad's contacts; otherwise this finger would also move the X pointer.
    //
    // First finger only (`!ptrs.size`): with a contact already on the pad this is a two-finger
    // gesture, which the pad's own scroll path owns.
    if (
      wheelPtr === null &&
      !ptrs.size &&
      inWheel(e.clientX, e.clientY) &&
      !(e.pointerType === 'mouse' && e.button !== 0)
    ) {
      wheelStart(e)
      return
    }
    e.preventDefault()
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    try {
      ov.setPointerCapture(e.pointerId)
    } catch {
      /* keep move/up outside the pad */
    }
    // Desktop convenience, and the one hardcoded button in this pad: a physical right mouse
    // button is a right button, not the latch.
    if (e.pointerType === 'mouse' && e.button === 2) {
      clearHold()
      active = false
      dragging = false
      padQueue(() => padRelease('physical right button'))
      sendMove(true)
      clickAt(3)
      return
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (ptrs.size >= 2) {
      // second finger → two-finger scroll
      active = false
      moved = false
      clearHold()
      // The scroll path does not carry the latched button, and a second finger must not leave
      // the first one's hold down: `padPress` releases whatever is held before it presses. It
      // does carry the lit modifiers, for the whole scroll, like a drag on the strip.
      dragging = false
      const mods = padMods()
      padQueue(() => padPress(null, mods, `${modPrefix(mods)}two-finger scroll`))
      scrolling = true
      scrollAccum = 0
      scrollLast = midY()
      return
    }
    if (scrolling) return
    rect = mirrorEl ? mirrorEl.getBoundingClientRect() : rect
    // No snap on press: an absolute jump at the moment of clicking would move the target out
    // from under a click that was aimed on the glasses.
    sx = lx = e.clientX
    sy = ly = e.clientY
    startAt = Date.now()
    active = true
    moved = false
    primed = Date.now() - lastTapEnd < PAD_PRIME_MS // just tapped → this press is a drag
    // Armed even when primed: a primed press that does not move is still a hold.
    holdTimer = setTimeout(holdElapsed, PAD_TAP_MS)
  }

  const onMove = (e: PointerEvent): void => {
    if (e.pointerId === wheelPtr) {
      wheelMove(e)
      return
    } // the strip, not the pad
    if (!ptrs.has(e.pointerId)) {
      // Hover: nothing is pressed. A finger never gets here, but a trackpad moves before it
      // clicks. Only the movement is read (see `hoverStep`).
      if (e.pointerType !== 'mouse') return
      const rel = hoverStep(hoverAt, e.clientX, e.clientY, rect ? SCREEN_W / rect.width : 1, cursor)
      hoverAt = { x: e.clientX, y: e.clientY }
      if (!rel) return // first sample: a position, not a move
      cursor.x = rel.x
      cursor.y = rel.y
      placeDot()
      sendMove(false) // throttled like every other move
      return
    }
    e.preventDefault()
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (scrolling) {
      if (ptrs.size < 2) return
      const y = midY()
      scrollAccum += y - scrollLast
      scrollLast = y
      let n = 0
      while (Math.abs(scrollAccum) >= PAD_WHEEL_PX && n < PAD_WHEEL_MAX) {
        // Two directions, deliberately separate (see `twoFingerWheelDir`): `travel` drains the
        // accumulator and is always the way the fingers went; the wheel direction may be
        // inverted by the toggle. Draining by the wheel direction is a runaway when inverted.
        const travel: -1 | 1 = scrollAccum < 0 ? -1 : 1
        wheelNotch(twoFingerWheelDir(scrollAccum, padScrollNatural))
        scrollAccum -= travel * PAD_WHEEL_PX
        n++
      }
      return
    }
    if (!active) return
    const dx = e.clientX - lx,
      dy = e.clientY - ly
    lx = e.clientX
    ly = e.clientY
    // Kept current through the drag as well, so the first hover after a drag is measured from
    // where the pointer ended.
    if (e.pointerType === 'mouse') hoverAt = { x: e.clientX, y: e.clientY }
    // No `PAD_GAIN` for a pointer: a dragging trackpad must not change speed the moment a
    // button goes down.
    const s = (rect ? SCREEN_W / rect.width : 1) * (e.pointerType === 'mouse' ? 1 : PAD_GAIN)
    // Clamped to the last pixel on the panel, not to its width: `tileIndexAt` answers -1 at
    // exactly 576/288, so a cursor parked there would belong to no tile and not be drawn.
    cursor.x = Math.max(0, Math.min(SCREEN_W - 1, cursor.x + dx * s))
    cursor.y = Math.max(0, Math.min(SCREEN_H - 1, cursor.y + dy * s))
    if (
      !moved &&
      (Math.abs(e.clientX - sx) >= PAD_MOVE_THRESH || Math.abs(e.clientY - sy) >= PAD_MOVE_THRESH)
    ) {
      moved = true
      clearHold()
      if (primed && !dragging) {
        sendMove(true)
        // The same state the timer opens; the tag records which way in.
        holdDown(' after tap')
      }
    }
    if (moved) {
      placeDot()
      sendMove(false)
    }
  }

  const onUp = (e: PointerEvent): void => {
    // The strip's pointer is never in `ptrs`, so it must be handled here; otherwise the drag's
    // composed modifier would stay held and the tap notch unsent. `wheelEnd` releases the
    // capture itself.
    if (e.pointerId === wheelPtr) {
      e.preventDefault()
      wheelEnd(e, true)
      return
    }
    const had = ptrs.delete(e.pointerId)
    try {
      ov.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    // Act on the chrome here, not from a `click`: a retargeted pointer sequence may never
    // produce a click on the ✕ or a pill (see `controlAt`), and the overlay must always be
    // dismissable.
    //
    // Gated on `!had`, i.e. the press started on the chrome as well (`onDown` bails there, so
    // that pointer was never in `ptrs`). Without the gate, a press-drag that merely ends over
    // the selector row would latch a new button instead of releasing the one it holds.
    if (!had) {
      const hit = controlAt(e.clientX, e.clientY)
      if (hit) {
        hit.act()
        return
      }
    }
    if (e.pointerType === 'mouse' && e.button === 2) return
    e.preventDefault()
    if (scrolling) {
      if (ptrs.size < 2) {
        scrolling = false
        scrollAccum = 0
        padQueue(() => padRelease('two-finger scroll ended'))
      }
      return
    }
    if (!had || !active) return
    active = false
    clearHold()
    // One release path for both ways into a held button (the timer's press-and-hold and the
    // tap-then-drag), and for the modifiers held with it.
    if (dragging) {
      sendMove(true)
      dragging = false
      padQueue(() => padRelease('drop'))
      return
    }
    if (!moved && Date.now() - startAt <= PAD_TAP_MS) {
      sendMove(true)
      clickAt(padButton)
      lastTapEnd = Date.now()
    }
    // else: a pure reposition. The pointer moved and nothing was clicked.
  }

  const onCancel = (e: PointerEvent): void => {
    // No early return for the strip: `wheelEnd` queues its own release, and the unconditional
    // one at the bottom of this handler must always run (`padRelease` is idempotent).
    if (e.pointerId === wheelPtr) wheelEnd(e, false)
    ptrs.delete(e.pointerId)
    try {
      ov.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (ptrs.size < 2) {
      scrolling = false
      scrollAccum = 0
    }
    active = false
    clearHold()
    // Unconditional, not `if (dragging)`: a cancel is the platform taking the contact away, and
    // a held button or a held Ctrl must not survive it. `padRelease` is a no-op when nothing is
    // down.
    dragging = false
    padQueue(() => padRelease('pointer cancelled'))
  }

  ov.addEventListener('pointerdown', onDown, { passive: false })
  ov.addEventListener('pointermove', onMove, { passive: false })
  ov.addEventListener('pointerup', onUp, { passive: false })
  ov.addEventListener('pointercancel', onCancel, { passive: false })
  // The pointer handlers call `preventDefault()`, but on a touch that cancels only the
  // compatibility mouse events; selection and the long-press callout are defaults of the touch
  // event (see `suppressNativeTouchGestures`). The exemption is `inChrome`, the same table the
  // pointer handlers use: cancelling `touchend` over the ✕ or a pill would suppress the event
  // its action rides on.
  suppressNativeTouchGestures(ov, 'vPad', inChrome)
  // A desktop mouse wheel over the pad is the Up/Down key path (the gesture the ring sends),
  // except over the strip, where it is the X11 wheel like the strip's own drag.
  ov.addEventListener(
    'wheel',
    e => {
      e.preventDefault()
      if (!e.deltaY) return
      const dir: -1 | 1 = e.deltaY < 0 ? -1 : 1
      if (inWheel(e.clientX, e.clientY)) {
        sendMove(true)
        wheelNotch(dir)
        return
      }
      onSwipe(dir)
    },
    { passive: false },
  )
  ov.addEventListener('contextmenu', e => {
    e.preventDefault()
  })

  vpadEl = ov
  document.body.appendChild(ov)
}

let vpadEl: HTMLElement | null = null

export function closeVPad(): void {
  if (!vpadOpen) return
  vpadOpen = false
  setLit(vpadBtn, false)
  // The guard, unconditionally and first. Closing the pad removes the element the pointer
  // handlers live on, so the `pointerup` that would have released a held button or Ctrl may
  // never arrive. `padRelease` is a no-op when nothing is held.
  padQueue(() => padRelease('pad closed'))
  // A modifier that outlived the pad would be latched with nothing on screen to show it.
  for (const m of PAD_MODS) padMod[m] = false
  if (vpadEl) {
    vpadEl.remove()
    vpadEl = null
  }
  // Leave the pointer where it is on the server, but stop baking it into the glasses tiles: a
  // cursor frozen on the lens reads as a stuck app.
  cursor.shown = false
  refreshGrey() // all four tiles, so no stale arrow is left behind
  setCursorTile(-1)
  log('vPad CLOSE')
}
