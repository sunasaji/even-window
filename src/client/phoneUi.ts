// even-window — the phone helper UI: `mountUi` and the element refs it fills in.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { SCREEN_H, SCREEN_W } from '../shared/geom.ts'
import { submitChordLabel } from '../shared/keys.ts'
import { activeWin, buildAppPanel, newlineChordFor, submitChordFor } from './bindingsEditor.ts'
import { button, pillRow, setLit, toast } from './chrome.ts'
import { ackKeys, renderKeys } from './clients.ts'
import {
  copyLog,
  LOG_BUFFER_MAX,
  log,
  logAtBottom,
  logFollow,
  logLines,
  logStamp,
  setFollow,
} from './debugLog.ts'
import { fontStep, onDouble, onSwipe, onTap, ringFire, submitText } from './gestures.ts'
import { renderPageWarning } from './glassPage.ts'
import { submitOffHintText, takeHint } from './hints.ts'
import { fieldEnterAction, wireHardwareKeyboard } from './hwKeyboard.ts'
import { KEY_PROBE, mountKeyProbe } from './keyProbe.ts'
import { pairingHooks, setPairingPrompted } from './main.ts'
import { wireMirrorTouch } from './mirrorTouch.ts'
import { buildKeyPad } from './oskb.ts'
import { glassInCase, lensLabel, lensOn, overrideCase, setLensOn } from './overlay.ts'
import { openPairingDialog } from './pairingUI.ts'
import { openAppsPalette, openTaskPalette, openWindowPalette, renderAppsEntry } from './palette.ts'
import { SERVER, setServer } from './serverLink.ts'
import {
  applyMirrorMode,
  invert,
  MIRROR_HINT,
  mirrorChoice,
  mirrorLabel,
  setInvert,
  setMirrorMode,
} from './settings.ts'
import { connFoldToggledByUser, invertLabel, renderConnSummary, renderStatus } from './statusUi.ts'
import { startStream, sttReady } from './stream.ts'
import { openTour, registerTourTarget } from './tour.ts'
import { onVoiceBtn, voiceResolve } from './voice.ts'
import { closeVPad, openVPad, SUBMIT_HINT_MS, SUBMIT_HOLD_MS, vpadOpen } from './vpad.ts'
import { closeVRing, openVRing, vRingOpen } from './vring.ts'

export let lensBtn: HTMLButtonElement | null = null
export let voiceBtn: HTMLButtonElement | null = null
/** The box and the one submit path, published by `mountUi` so the dialog can reach them. */
export let textBox: HTMLTextAreaElement | null = null
export let fireSubmit: ((via: string) => void) | null = null

// The phone helper (docs/phone-ui.md). A phone held in one hand, laid out top to bottom: a
// title row, the live glasses preview, a text box + Submit, wrapped rows of native buttons,
// the `keys` keyboard, then `▶ app`, `▶ connection` (URL + pairing + status) and `▶ log`.
//
// The preview draws only the mirror; this client's own status lives in `▶ connection`. The
// mirror is also the surface tapped and dragged to drive the nested X (`wireMirrorTouch`).
//
// A phone WebView registers at most ~1.6 on-screen taps per second, and the dropped ones never
// reach the DOM. Ring and temple gestures bypass that (they arrive over BLE through
// `onEvenHubEvent`), which is why the glasses gestures are the intended control path and this
// surface is the fallback.

export let statusEl: HTMLElement | null = null
export let connSumEl: HTMLElement | null = null
export let connDetailsEl: HTMLDetailsElement | null = null
let serverFieldEl: HTMLInputElement | null = null

/** Show the current server in the `connection` field after it changed somewhere else (a
 *  pasted pairing URL, the server-address card). */
export function syncServerField(): void {
  if (serverFieldEl) serverFieldEl.value = SERVER
}
export let logEl: HTMLElement | null = null
export let logCountEl: HTMLElement | null = null
export let followBtn: HTMLButtonElement | null = null
export let mirrorEl: HTMLCanvasElement | null = null
export let invertBtn: HTMLButtonElement | null = null
export let mirrorBtn: HTMLButtonElement | null = null
/** The "the glasses are not connected / refused to make a page" bar (`renderPageWarning`). */
export let pageWarnEl: HTMLElement | null = null
export let pageWarnText: HTMLElement | null = null
export let keysTableEl: HTMLElement | null = null
export let keysNoteEl: HTMLElement | null = null
export let keysAckBtn: HTMLButtonElement | null = null
/** The title row's `apps` button and its count. */
export let appsBtn: HTMLButtonElement | null = null
export let appsCountEl: HTMLElement | null = null

// `task`: the window switcher on the phone (docs/phone-ui.md, docs/decisions/phone-palettes.md).
// The same choice as the glasses' root list, but with the list visible on the phone:
//   * every window with its whole title, so the rows come from `mruOrderWindows` over the raw
//     list, never from `buildMenuItems` (whose truncation and cap exist for the firmware);
//   * no launcher rows (the `apps` button holds the whole set) and no `Menu...` row (the
//     `window` button is that way in).
// `task` = which window to go to; `window` = what to do to the one you are on.
export let taskBtn: HTMLButtonElement | null = null

// `window`: the WM rows on the phone. A bypass for `Menu... > Window...` on the glasses, not a
// second implementation: the rows come from `windowPanelRows` (the same `RP_KEYS` catalogue,
// same order) and the actions go through `runRowToken`. Every row is a server route, so the
// palette works while `glassLinkUp` is false.
//
// It closes after acting, by the same rule as the glasses (`rowMenuEffect`): the result of a WM
// key lands on the mirror the palette is covering. Repetition is a swipe binding's job.
export let windowBtn: HTMLButtonElement | null = null
export let vringBtn: HTMLButtonElement | null = null
export let vpadBtn: HTMLButtonElement | null = null

export function mountUi(): void {
  const app = document.getElementById('app')
  if (!app) return
  app.innerHTML = ''
  // `#app` is the full-height scroller (index.html) and this `<main>` is the measured column.
  // Padding and max-width on `#app` itself would fight the `height:100%; overflow-y:auto` that
  // makes the column scroll inside the WebView.
  const ui = document.createElement('main')
  ui.style.cssText =
    'padding:12px;font:13px/1.5 system-ui;color:#E5E5E5;' +
    'max-width:720px;margin:0 auto;width:100%;box-sizing:border-box'
  app.appendChild(ui)

  // iOS only applies `:active` while an element or an ancestor has a touchstart listener. This
  // no-op one enables the press-to-invert feedback (index.html), which is what makes a
  // native-sized target confirmable.
  document.addEventListener(
    'touchstart',
    () => {
      /* enables :active on iOS */
    },
    { passive: true },
  )

  // The title row, with the palette openers at its right end: the one position that is always
  // on screen without scrolling.
  const titleRow = document.createElement('div')
  titleRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 0 4px'
  const title = document.createElement('h1')
  title.textContent = 'even-window'
  // Ellipsised rather than wrapped: on a narrow phone the title gives way to the buttons.
  title.style.cssText =
    'font-size:16px;margin:0;flex:1;min-width:0;white-space:nowrap;overflow:hidden;' +
    'text-overflow:ellipsis'
  // `?`: the tour (tour.ts), which also opens by itself on a device's first run. Beside the
  // title rather than among the palette openers: it is about the page, not an action.
  const helpBtn = button(
    '?',
    () => {
      openTour(sttReady, '? button')
    },
    'a short tour of this screen and the glasses gestures',
  )
  helpBtn.setAttribute('aria-haspopup', 'dialog')
  helpBtn.setAttribute('aria-label', 'tour')
  // A native pill, like every other control in a row of controls.
  appsBtn = button(
    'apps ',
    () => {
      openAppsPalette()
    },
    'the launcher — the whole scanned set, filtered, anchored to the top of the visible screen',
  )
  appsBtn.setAttribute('aria-haspopup', 'dialog')
  appsCountEl = document.createElement('span')
  appsCountEl.style.cssText = 'font:11px ui-monospace,monospace;opacity:.7'
  appsBtn.appendChild(appsCountEl)
  renderAppsEntry()
  // The title row holds the three palette openers and nothing else: `task`, `window`, `apps`.
  // A title plus four native buttons does not fit a 390px phone, so the mirror-mode button is
  // in the tools row beside `◐ invert`.
  taskBtn = button(
    'task',
    () => {
      openTaskPalette()
    },
    'the window switcher — every window, whole titles, most recently focused first; works with ' +
      'the glasses off',
  )
  taskBtn.setAttribute('aria-haspopup', 'dialog')
  // The WM rows, reachable without the lens.
  windowBtn = button(
    'window',
    () => {
      openWindowPalette()
    },
    'the window-manager rows the glasses show under `Menu... > Window...` — flat, and they work ' +
      'with the glasses off',
  )
  windowBtn.setAttribute('aria-haspopup', 'dialog')
  titleRow.append(title, helpBtn, taskBtn, windowBtn, appsBtn)
  registerTourTarget('palettes', [taskBtn, windowBtn, appsBtn])
  ui.appendChild(titleRow)

  // Above the preview, because it explains a mirror that never lights up. Not a toast: it must
  // persist.
  pageWarnEl = document.createElement('div')
  pageWarnEl.style.cssText =
    'display:none;margin:0 0 6px;padding:7px 9px;border-radius:6px;' +
    'background:#2a2320;color:#ffd9b0;font:11px/1.45 system-ui;' +
    'align-items:center;gap:8px'
  pageWarnEl.style.display = 'none'
  pageWarnText = document.createElement('span')
  pageWarnText.style.cssText = 'flex:1;min-width:0'
  // No buttons: neither a page reload nor the in-app exit recovers this state (the dead record
  // lives in the host, not in the page), and a control that does nothing is worse than none.
  // See docs/notes/2026-10-glasses-link-and-establish.md.
  pageWarnEl.append(pageWarnText)
  ui.appendChild(pageWarnEl)
  renderPageWarning()

  // The live glasses preview: the same grey bytes the pump pushes, drawn in the panel's green
  // (`drawMirror`), and nothing else. Diagnostic text here would read as device output.
  //
  // Square corners: the canvas stands for a physical 576x288 panel whose corners are square.
  //
  // It is also a touch surface (`wireMirrorTouch`): tap = click, drag = press-drag-release at the
  // absolute pixel under the finger. `touch-action:none` makes a finger drag a drag on the nested
  // X rather than a scroll of this column.
  mirrorEl = document.createElement('canvas')
  mirrorEl.width = SCREEN_W
  mirrorEl.height = SCREEN_H
  mirrorEl.style.cssText =
    `width:100%;max-width:${String(SCREEN_W)}px;display:block;` +
    'image-rendering:pixelated;background:#000;border:1px solid #333;touch-action:none'
  mirrorEl.title =
    'tap = click, drag = press-drag-release, at the pixel you touch.' +
    " Right button, the wheel and the arrow on the lens are vPad's — open it for those." +
    ' (A finger dragged across the mirror does not page scroll this column — that is what' +
    ' makes a drag a drag. Swipe anywhere else to scroll.)'
  ui.appendChild(mirrorEl)
  wireMirrorTouch(mirrorEl)
  registerTourTarget('mirror', mirrorEl)

  // Text input + Submit. One `{kind:'type'}` injection carries a whole string into the focused
  // nested-X window, so this is the only text path not rationed by the touch-rate ceiling.
  const textRow = document.createElement('div')
  // `stretch` rather than `flex-start`: the buttons beside the box are a column (voice over
  // Submit), which has to be as tall as the box for Submit to sit on its bottom edge.
  // `position:relative` is the anchor for the hold hint under Submit (see `holdHint`).
  textRow.style.cssText = 'margin:8px 0;display:flex;gap:6px;align-items:stretch;position:relative'
  const text = document.createElement('textarea')
  text.rows = 3
  text.placeholder = 'type into the window…'
  text.spellcheck = false
  text.autocapitalize = 'off'
  text.setAttribute('autocorrect', 'off')
  // `ui-monospace`: what is composed here is usually a shell command for a monospace terminal.
  text.style.cssText =
    'flex:1;min-width:0;padding:7px 9px;background:#111;color:#E5E5E5;' +
    'border:1px solid #333;border-radius:6px;font:16px/1.4 ui-monospace,monospace;' +
    'resize:vertical;min-height:38px;box-sizing:border-box'
  /** One submit path for the button and the key. Two would drift on "did it clear the box",
   *  which is how a line gets sent twice. */
  const fire = (via: string, bare = false): void => {
    // Sent as written, newlines included: both keys are per-app, so a line break becomes the
    // app's own line break (docs/phone-ui.md).
    const v = text.value
    if (v.trim() === '') {
      log(`submit (${via}): nothing to type`)
      return
    }
    text.value = ''
    // The one place the voice dialog is resolved by a submit, whichever path got here (the
    // glasses row, this button, or Ctrl+Enter in the box). `voiceResolve` does not clear the
    // box (that is Cancel's job); the line above already did.
    voiceResolve(`submit (${via})`)
    // Resolved at the moment of firing, against the window that has focus now, never from a
    // cached copy: the submit key is a per-app setting and the app can change.
    //
    // `bare` is the long press on Submit: this one send skips the app's key (see `holdHint`).
    // It does not touch the setting.
    const w = activeWin()
    const press = bare ? null : submitChordFor(w).chord
    void submitText(v, press, newlineChordFor(w).chord ?? { mods: [], key: 'Return' }).then(ok => {
      // The default submit key is `off`: the text lands but nothing runs, which a first-time
      // user reads as a broken Submit. Say where the setting is, a few times per device
      // (hints.ts). Not after a hold-send, which asked for exactly this.
      if (ok && press === null && !bare && takeHint('submit-off')) toast(submitOffHintText(), 6000)
    })
  }
  // Published so the voice dialog can reach the box and the one submit path.
  textBox = text
  fireSubmit = fire
  // Hold Submit = send without the app's submit key, a one-off that leaves the setting alone
  // (docs/decisions/phone-submit-key.md).
  //
  // It only exists when there is something to omit: with the app on `off` a tap already types
  // without running, so there is no hint and no arming.
  //
  // The release sends, not the threshold: an armed hold is still cancellable by sliding off the
  // button (`pointermove` below). The armed send is the safe direction: it types and does not
  // run.
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let hintTimer: ReturnType<typeof setTimeout> | null = null
  let holdArmed = false
  /** The hold already sent on `pointerup`; swallow the `click` that follows it. Cleared on the
   *  next `pointerdown` as well, because a cancelled gesture may never produce that click. */
  let holdSent = false
  const submit = button('Submit', () => {
    if (holdSent) {
      holdSent = false
      return
    }
    fire('button')
  })
  // The only CSS on this button. iOS answers a long press on a control with the selection
  // callout / magnifier, which would cover the hint and can swallow the release. Nothing here
  // touches size, colour or shape.
  submit.style.cssText =
    'touch-action:manipulation;-webkit-touch-callout:none;' +
    'user-select:none;-webkit-user-select:none'
  // Under the button, and `pointer-events:none` so the hint can never intercept the gesture.
  // Absolutely positioned against `textRow`: a hint that reflows the column would move the
  // button out from under the finger holding it.
  const holdHint = document.createElement('div')
  holdHint.style.cssText =
    'display:none;position:absolute;top:100%;right:0;margin-top:4px;' +
    'z-index:30;pointer-events:none;white-space:nowrap;background:#2a2a2a;color:#E5E5E5;' +
    'border:1px solid #555;border-radius:6px;padding:4px 8px;font:11px/1.3 system-ui;' +
    'box-shadow:0 2px 8px rgba(0,0,0,.5)'
  const endHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
    if (hintTimer !== null) {
      clearTimeout(hintTimer)
      hintTimer = null
    }
    holdArmed = false
    holdHint.style.display = 'none'
    setLit(submit, false)
  }
  submit.addEventListener('pointerdown', () => {
    endHold()
    holdSent = false
    const press = submitChordFor(activeWin())
    if (!press.chord) return // nothing to leave out
    const name = submitChordLabel(press)
    // The hint waits out a tap, so it does not flash on every ordinary send. The delay is
    // shorter than the hold itself.
    hintTimer = setTimeout(() => {
      hintTimer = null
      holdHint.textContent = `hold → send without ${name}`
      holdHint.style.display = 'block'
    }, SUBMIT_HINT_MS)
    holdTimer = setTimeout(() => {
      holdTimer = null
      holdArmed = true
      holdHint.textContent = `release → send without ${name}`
      holdHint.style.display = 'block'
      // The row's own latched look (`filter:invert(1)`): the same visual for "armed" everywhere.
      setLit(submit, true)
    }, SUBMIT_HOLD_MS)
  })
  submit.addEventListener('pointerup', () => {
    const armed = holdArmed
    endHold()
    if (!armed) return // an ordinary tap: the `click` handler sends
    holdSent = true
    fire('hold')
  })
  // Slide off to cancel. A touch pointer is implicitly captured by the element that took the
  // `pointerdown`, so `pointerleave` does not arrive while the finger is down and the hit test
  // is done by hand. Releasing outside also means no `click`, so this cancels the whole gesture.
  submit.addEventListener('pointermove', e => {
    if (holdTimer === null && hintTimer === null && !holdArmed) return
    const r = submit.getBoundingClientRect()
    const inside =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!inside) endHold()
  })
  submit.addEventListener('pointercancel', () => {
    endHold()
  })
  // Ctrl+Enter submits; a bare Enter breaks the line (see `fieldEnterAction` for the IME
  // guard). The app's `submit` setting still decides which key follows the text, exactly as it
  // does for the button.
  //
  // Two layers: `Enter` here makes a line break in the phone's own textarea; what that break
  // becomes in the nested X is the app's `newline` setting. Neither follows the other.
  text.title = 'Enter = new line · Ctrl+Enter = Submit'
  text.addEventListener('keydown', e => {
    // Only `submit` is intercepted: a `newline` must reach the textarea, which knows where the
    // caret and the selection are.
    if (fieldEnterAction(e) !== 'submit') return
    e.preventDefault()
    fire('Ctrl+Enter')
  })
  // The voice dialog, started from the phone (the glasses route is a long press). Hidden until
  // `GET /api/health` says a recogniser is configured.
  //
  // While recording it is `■ stop` (`syncVoiceBtn`), so the phone can end what it started.
  // Otherwise it is disabled while the dialog is up: the transcript is in this box, and Submit
  // sends it.
  voiceBtn = button(
    '🎤 voice',
    onVoiceBtn,
    'record from the mic (tap again to stop), then confirm — the transcript lands in this box',
  )
  voiceBtn.style.display = sttReady ? '' : 'none'
  // Voice on top, Submit on the bottom edge. `space-between` puts Submit on the box's bottom
  // edge: the two buttons keep their native height and the gap absorbs the box's height, so a
  // `resize:vertical` drag moves Submit down with the corner. The submit-key picker is in
  // `▶ app`, whose folded summary shows the key Submit will press.
  const sideCol = document.createElement('div')
  sideCol.style.cssText =
    'display:flex;flex-direction:column;justify-content:space-between;' + 'gap:6px;flex:0 0 auto'
  sideCol.append(voiceBtn, submit)
  textRow.append(text, sideCol, holdHint)
  ui.appendChild(textRow)

  // Row 1: the four routed gestures, plus the font pair. dn/up/tap/dbl take the same code path
  // the ring and temple drive (ringFire → onSwipe / onTap / onDouble). font −/+ press the
  // focused app's `fontsize` pair (see `fontStep`). Six per row comes out of the native button
  // metrics plus the 6px gap.
  const gestures = pillRow(
    button(
      '▼ dn',
      () => {
        ringFire('swipe +1', () => onSwipe(1))
      },
      'swipe down → Down key',
    ),
    button(
      '▲ up',
      () => {
        ringFire('swipe -1', () => onSwipe(-1))
      },
      'swipe up → Up key',
    ),
    button(
      '● tap',
      () => {
        void onTap()
      },
      'tap → Return',
    ),
    button(
      '●● dbl',
      () => {
        void onDouble()
      },
      'double-tap → open the menu; inside it, up one level (and close at the top)',
    ),
    button(
      'font −',
      () => {
        void fontStep(-1)
      },
      'smaller text in the focused app — the keys are its `fontsize` setting in ▶ app',
    ),
    button(
      'font +',
      () => {
        void fontStep(1)
      },
      'bigger text in the focused app — the keys are its `fontsize` setting in ▶ app',
    ),
  )
  gestures.id = 'gestures'
  ui.appendChild(gestures)
  registerTourTarget('gestures', gestures)

  // Row 2: the tools.
  const keyPad = buildKeyPad()
  const keysBtn = button(
    'keys',
    () => {
      const on = keyPad.style.display === 'none'
      keyPad.style.display = on ? 'flex' : 'none'
      setLit(keysBtn, on)
    },
    'on-screen keyboard → POST /api/desktop/input',
  )
  // vRing is the gesture surface (the same four actions as row 1, on one big target) and vPad
  // is the pointer surface. Mutually exclusive.
  vringBtn = button(
    'vRing',
    () => {
      if (vRingOpen) closeVRing()
      else openVRing()
    },
    'virtual R1 — full-screen swipe/tap pad driving the real gesture path',
  )
  vpadBtn = button(
    'vPad',
    () => {
      if (vpadOpen) closeVPad()
      else openVPad()
    },
    "virtual trackpad → move / click / hold the pointer (Ctrl+hold for xterm's menus)",
  )
  // Polarity flip. On a see-through panel this is how light-background content becomes usable,
  // so it sits with the other primary controls.
  invertBtn = button(
    invertLabel(),
    () => {
      setInvert(!invert)
      if (invertBtn) invertBtn.textContent = invertLabel()
    },
    'flip black/white — the lens is emissive, so dark = transparent',
  )
  // Next to `invert`: both change how the preview is drawn.
  //
  // Toggles the choice, not the effective mode: with the glasses link down the effective mode
  // is pinned to colour (`effectiveMirrorMode`), so reading it here would make the button a
  // no-op. `applyMirrorMode` also disables it in that state.
  mirrorBtn = button(
    mirrorLabel(),
    () => {
      setMirrorMode(mirrorChoice === 'color' ? 'green' : 'color')
    },
    MIRROR_HINT,
  )
  // The lens latch, last in the row: the one control that changes what the glasses are doing.
  // Named `lens`, not `mirror`: the phone's preview keeps updating (it is painted by
  // `processTile`, not by the pump).
  lensBtn = button(
    lensLabel(),
    () => {
      // The case override comes first: while the button shows `lens:case` the latch is already
      // on, so toggling it would turn the lens off, the opposite of what the press means.
      if (lensOn && glassInCase) {
        overrideCase()
        return
      }
      setLensOn(!lensOn)
    },
    'pause the glasses: the tiles stop being pushed and the panel is blanked (black is no ' +
      "emission), which is the one real lever on the G2's battery. The phone keeps everything " +
      '— task / window / apps / keys / vPad — so this is a mode, not a loss of control.',
  )
  // Not in this row: `copy` (the log panel owns it), `pair` (inside `▶ connection`), and the
  // submit key (a per-app setting in `▶ app`). There is no hardware-keyboard toggle
  // (docs/decisions/phone-hardware-keyboard.md).
  const tools = pillRow(keysBtn, vringBtn, vpadBtn, invertBtn, mirrorBtn, lensBtn)
  tools.id = 'tools'
  ui.appendChild(tools)
  applyMirrorMode() // the label and the disabled state, now that the button exists
  registerTourTarget('tools', tools)
  ui.appendChild(keyPad)

  // `▶ app`: the per-app binding editor, directly under the rows whose pills it governs, and
  // folded. Its summary line carries what this app does right now, the submit key first.
  // The Submit card spotlights the text row together with this fold, where the submit key is.
  const appPanel = buildAppPanel()
  ui.appendChild(appPanel)
  registerTourTarget('text', textRow, appPanel)

  // The launcher is the `apps` button in the title row, which opens a palette anchored to the
  // top of the visible viewport: a filter box down here would sit where the soft keyboard
  // covers the list it filters (see `openAppsPalette`).

  // `▶ connection`: which server (the base URL), how this device is trusted by it (pairing),
  // and whether it is working (the status line). `SERVER` and `?server=` keep their names;
  // those mean the URL.
  //
  // The status line lives here, not in the preview, because it is this client's own
  // bookkeeping and must not look like something the glasses display.
  const srv = document.createElement('details')
  connSumEl = document.createElement('summary')
  srv.appendChild(connSumEl)
  statusEl = document.createElement('div')
  statusEl.style.cssText =
    'margin:6px 0 0;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'color:#5f6;white-space:pre-wrap;word-break:break-word'
  srv.appendChild(statusEl)
  const srvRow = document.createElement('div')
  srvRow.style.cssText = 'display:flex;gap:6px;margin-top:6px'
  const field = document.createElement('input')
  serverFieldEl = field
  field.value = SERVER
  field.style.cssText =
    'flex:1;min-width:0;padding:7px 9px;font:16px ui-monospace,monospace;' +
    'background:#000;color:#E5E5E5;border:1px solid #333;border-radius:6px'
  srvRow.append(
    field,
    button('apply', () => {
      setServer(field.value)
      field.value = SERVER
      startStream()
    }),
  )
  srv.appendChild(srvRow)

  // Pairing. The button is inside the fold because three things keep the path open for a new
  // device:
  //   1. the client auto-opens this dialog on the first 401 (`maybePromptPairing`);
  //   2. a `?pair=<code>` URL opens the dialog itself (`maybeStartPairing`), before any request;
  //   3. if either is dismissed, the summary line says so (`renderConnSummary`) and this
  //      disclosure opens itself the first time the server refuses us.
  // The button stays unconditional: a device that cannot reach the server never learns its auth
  // state, and that is the device that needs the manual entry point.
  const pairRow = document.createElement('div')
  pairRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px'
  pairRow.append(
    button(
      'pair',
      () => {
        setPairingPrompted(true)
        openPairingDialog(pairingHooks)
      },
      'enrol this device with the server (once per device)',
    ),
  )
  const pairNote = document.createElement('span')
  pairNote.style.cssText = 'font:11px/1.35 system-ui;color:#888'
  pairNote.textContent =
    'enrol this device — once per device, and only after you approve it' + ' on the server'
  pairRow.appendChild(pairNote)
  srv.appendChild(pairRow)

  // Who is enrolled (docs/security.md). A key enrolled by someone other than the operator
  // grants full RCE on the host, so the list has a permanent row here and a red summary line
  // outside the fold.
  //
  // Nothing here changes server state: the only action is "mark as seen", which writes to this
  // device's localStorage. Enrolling and revoking stay on the host (`ew-auth`), so a stolen
  // session token can neither enrol a second key nor revoke the operator's.
  const keysHead = document.createElement('div')
  keysHead.style.cssText = 'display:flex;gap:8px;align-items:baseline;margin-top:10px'
  const keysTitle = document.createElement('div')
  keysTitle.style.cssText = 'font:600 11px system-ui;color:#bdbdbd'
  keysTitle.textContent = 'enrolled keys'
  keysAckBtn = button(
    'mark as seen',
    () => ackKeys(),
    'remember this exact set of keys on this device, and clear the warning',
  )
  keysAckBtn.style.display = 'none'
  keysHead.append(keysTitle, keysAckBtn)
  srv.appendChild(keysHead)
  keysTableEl = document.createElement('div')
  keysTableEl.style.cssText = 'margin-top:4px'
  srv.appendChild(keysTableEl)
  keysNoteEl = document.createElement('div')
  keysNoteEl.style.cssText = 'margin-top:4px;font:10px/1.45 system-ui;color:#888'
  srv.appendChild(keysNoteEl)
  renderKeys()

  // Opens itself when the connection needs a human, and closes itself when that is resolved,
  // unless the user used it: a tap or a key anywhere in the fold, its summary included, makes
  // the fold theirs (connFold.ts). So an address typed here leaves it open, while one entered
  // on the server-address card closes it. The `toggle` event is not used for this, because it
  // also fires for our own changes.
  srv.addEventListener('pointerdown', connFoldToggledByUser)
  srv.addEventListener('keydown', connFoldToggledByUser)
  connDetailsEl = srv
  renderConnSummary()
  ui.appendChild(srv)

  // The hardware-keyboard listener, installed once at mount. Its gate is `kbdShouldHandle`.
  wireHardwareKeyboard()

  // `?keyprobe=1`, directly above the log it writes into. Mounted only when asked for (see
  // `queryFlag`); it adds document-level key and pointer listeners.
  if (KEY_PROBE) mountKeyProbe(ui)

  // The log panel, behind a `▶ log` disclosure: newest at the bottom, pinned there until
  // scrolled up (and re-pinned when scrolled back), selectable, copyable, capped at
  // LOG_BUFFER_MAX, and forwarded to the server's stdout only under `?debug=1`.
  const logBox = document.createElement('details')
  logBox.style.cssText = 'margin:0'

  const logBar = document.createElement('summary')
  logBar.textContent = 'log '
  logCountEl = document.createElement('span')
  logCountEl.style.cssText = 'font:11px ui-monospace,monospace;color:#777'
  logCountEl.textContent = `${logLines.length}/${LOG_BUFFER_MAX}`
  logBar.appendChild(logCountEl)
  logBox.appendChild(logBar)

  const logTools = document.createElement('div')
  logTools.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 0'
  const copyBtn = button('copy', () => {
    copyLog(copyBtn)
  })
  followBtn = button('follow:on', () => {
    setFollow(!logFollow)
  })
  const clearBtn = button('clear', () => {
    logLines.length = 0
    if (logEl) logEl.textContent = ''
    if (logCountEl) logCountEl.textContent = `0/${LOG_BUFFER_MAX}`
  })
  // One step down in size from the main rows.
  for (const b of [copyBtn, followBtn, clearBtn]) b.style.cssText = 'font:11px system-ui'
  logTools.append(copyBtn, followBtn, clearBtn)
  logBox.appendChild(logTools)

  logEl = document.createElement('div')
  // `user-select:text` opts the log back into selection (the page disables it; index.html).
  // `overscroll-behavior:contain` stops a scroll at the end of the panel from dragging the
  // whole page. 38vh, because the log is the primary hardware-debugging surface.
  logEl.style.cssText = [
    'margin:4px 0 0',
    'padding:8px',
    'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#cfe',
    'background:#111',
    'border:1px solid #333',
    'border-radius:8px',
    'white-space:pre-wrap',
    'word-break:break-word',
    'height:38vh',
    'min-height:8em',
    'overflow:auto',
    'overscroll-behavior:contain',
    '-webkit-overflow-scrolling:touch',
    'user-select:text',
    '-webkit-user-select:text',
  ].join(';')
  // Scrolling away from the bottom turns following off; scrolling back turns it on again. The
  // button is the explicit override.
  logEl.addEventListener('scroll', () => {
    if (!logEl) return
    const at = logAtBottom(logEl)
    if (at !== logFollow) setFollow(at)
  })
  logBox.appendChild(logEl)
  // While the disclosure is shut the panel has no scroll geometry, so `appendLogLine`'s
  // `scrollTop = scrollHeight` is a no-op and the view would open at the oldest lines. Snap to
  // the newest line on open.
  logBox.addEventListener('toggle', () => {
    if (logBox.open && logEl && logFollow) logEl.scrollTop = logEl.scrollHeight
  })
  ui.appendChild(logBox)

  // Replay whatever was logged before the DOM existed (boot resolves the flags first).
  for (const e of logLines) {
    const row = document.createElement('div')
    row.textContent = `${logStamp(e.t)}  ${e.m}`
    logEl.appendChild(row)
  }
  setFollow(true)

  renderStatus()
}
