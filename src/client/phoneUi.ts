// pinhole-window — the phone helper UI: `mountUi` and the element refs it fills in.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { SCREEN_H, SCREEN_W } from '../shared/geom.ts'
import { submitChordLabel } from '../shared/keys.ts'
import { forgetKey, revokeSelf } from './authClient.ts'
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
import { glassInCase, lensLabel, lensOn, overrideCase, setLensOn, syncOverlay } from './overlay.ts'
import { openPairingDialog } from './pairingUI.ts'
import {
  appsPaletteOpen,
  openAppsPalette,
  openTaskPalette,
  openWindowPalette,
  renderAppsEntry,
} from './palette.ts'
import { enterRoot, openTarget } from './root.ts'
import { SERVER, switchServer } from './serverLink.ts'
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
import { sttReady } from './stream.ts'
import {
  NAME_MAX,
  originLabel,
  removeTarget,
  renameTarget,
  rootOpen,
  rootSel,
  serverLabel,
  type Target,
  targetLabel,
  targetList,
} from './targets.ts'
import { openTour, registerTourDemo, registerTourTarget } from './tour.ts'
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
/** The server list at the top of the page, shown only at the root (`renderRootPanel`). */
let rootPanelEl: HTMLElement | null = null
/** Where the open server and `disconnect` are shown: the first row inside `connection`. */
let connServerEl: HTMLElement | null = null

/** By server: the row whose `…` is open, the one being renamed, the one whose `forget` is
 *  armed, and the one being forgotten right now. */
let rowMenu = ''
let renaming = ''
let forgetArmed = ''
let forgetting = ''

/** The server whose `forget` could not reach it, awaiting the answer to "discard anyway?". */
let forgetUnreached = ''

/** Forget a server. Its key is withdrawn on the server first, because the key is what signs
 *  that request. When the server cannot be told, nothing is discarded yet: the person is asked,
 *  since the enrolment would outlive the only thing that can withdraw it from here. */
async function forgetServer(server: string, label: string): Promise<void> {
  const r = await revokeSelf(server)
  forgetting = ''
  if (r === 'failed') {
    log(`root: forget ${server} — the server did not answer; asking before discarding the key`)
    forgetUnreached = server
    renderRootPanel()
    return
  }
  await discardServer(server)
  log(`root: forgot ${server} — key on the server: ${r}`)
  toast(
    r === 'revoked'
      ? `Forgot ${label}. Its key was revoked on the server.`
      : `Forgot ${label}. This app was not paired with it.`,
  )
}

/** Discard the key kept for a server and drop its row. */
async function discardServer(server: string): Promise<void> {
  await forgetKey(server)
  removeTarget(server)
  forgetUnreached = ''
  rowMenu = ''
  renderRootPanel()
  syncOverlay()
}

let forgetTimer: ReturnType<typeof setTimeout> | null = null
/** How long an armed `forget` waits for its second tap. */
const FORGET_ARM_MS = 4000

/** Redraw the server list from `targets.ts`. Safe before the page is mounted.
 *
 *  At the list the card stands where the mirror is, and the mirror is hidden: it would show
 *  the same list as text, and nothing below it works until a server is open. Inside a server
 *  the mirror is back and the open server, with `disconnect`, is the first row of the
 *  `connection` fold, because leaving a server is rare. */
export function renderRootPanel(): void {
  const top = rootPanelEl
  if (!top) return
  top.replaceChildren()
  connServerEl?.replaceChildren()
  top.style.display = rootOpen ? '' : 'none'
  if (mirrorEl) mirrorEl.style.display = rootOpen ? 'none' : 'block'
  if (connServerEl) connServerEl.style.display = rootOpen ? 'none' : ''
  renderConnSummary() // it names the open server
  const line = (text: string, color = '#aaa'): HTMLElement => {
    const d = document.createElement('div')
    d.style.cssText = `font:13px/1.4 system-ui;color:${color}`
    d.textContent = text
    return d
  }
  if (!rootOpen) {
    if (!connServerEl) return
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px'
    const name = line(`● ${serverLabel(SERVER)}`, '#9e9')
    name.style.cssText +=
      ';flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    row.append(
      name,
      button(
        'disconnect',
        () => {
          enterRoot('disconnect on the phone')
        },
        'back to the list of servers',
      ),
    )
    connServerEl.append(row)
    return
  }
  const list = targetList()
  const head = line(list.length ? 'Choose a server to open' : 'No server yet', '#e5e5e5')
  head.style.cssText += ';font-weight:600;font-size:15px'
  top.append(head)
  // The rows scroll inside the card once there are more than about five, so that a long list
  // does not push the text box and the buttons down the page. `top` is shadowed below: every
  // row goes into this box.
  const rowsBox = document.createElement('div')
  rowsBox.style.cssText =
    `max-height:${String(ROOT_ROWS_MAX_PX)}px;overflow-y:auto;overscroll-behavior:contain;` +
    '-webkit-overflow-scrolling:touch;padding-right:2px'
  top.append(rowsBox)
  let cursorRow: HTMLElement | null = null
  renderRows(list, rowsBox, row => {
    cursorRow = row
  })
  // Keep the row under the glasses' cursor in view when the list is longer than the box.
  ;(cursorRow as HTMLElement | null)?.scrollIntoView({ block: 'nearest' })
  const foot = line(
    list.length
      ? 'To add one: under connection below, type its URL and apply, or tap pair and paste a pairing URL.'
      : 'Under connection below: type the server URL and apply, or tap pair and paste a pairing URL.',
  )
  foot.style.cssText += ';margin-top:8px'
  top.append(foot)
}

/** The height the rows may take before they scroll: about five rows. */
const ROOT_ROWS_MAX_PX = 290

/** One row per server, with its `…` actions, into `top`. `onCursor` is given the row the
 *  glasses' cursor is on. */
function renderRows(
  list: readonly Target[],
  top: HTMLElement,
  onCursor: (row: HTMLElement) => void,
): void {
  list.forEach((t, i) => {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:stretch;gap:6px;margin-top:8px'
    if (i === rootSel) onCursor(row)
    if (renaming === t.server) {
      const field = document.createElement('input')
      field.value = t.name ?? ''
      field.maxLength = NAME_MAX
      field.setAttribute('placeholder', 'a name for this server')
      field.setAttribute('aria-label', `name for ${originLabel(t.server)}`)
      field.style.cssText =
        'flex:1;min-width:0;padding:7px 9px;font:16px system-ui;' +
        'background:#000;color:#E5E5E5;border:1px solid #a78bfa;border-radius:6px'
      const save = (): void => {
        renameTarget(t.server, field.value)
        renaming = ''
        renderRootPanel()
        syncOverlay()
      }
      field.addEventListener('keydown', e => {
        if (e.key === 'Enter') save()
      })
      row.append(
        field,
        button('save', save, 'keep this name; empty shows the address again'),
        button(
          'cancel',
          () => {
            renaming = ''
            renderRootPanel()
          },
          'leave the name as it was',
        ),
      )
      top.append(row)
      setTimeout(() => {
        field.focus()
      }, 0)
      return
    }
    const open = button(
      '',
      () => {
        openTarget(t.server)
      },
      'open this server',
    )
    open.style.cssText +=
      ';flex:1;min-width:0;text-align:left;padding:8px 10px;overflow:hidden;line-height:1.3'
    const main = document.createElement('div')
    main.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    main.textContent = `${i === rootSel ? '▸ ' : ''}${targetLabel(t)}`
    open.append(main)
    // Under a name, the address it stands for: a name alone does not say where it leads.
    if (t.name) {
      const sub = document.createElement('div')
      sub.style.cssText =
        'font:11px ui-monospace,monospace;opacity:.7;overflow:hidden;text-overflow:ellipsis;' +
        'white-space:nowrap'
      sub.textContent = originLabel(t.server)
      open.append(sub)
    }
    // `name` and `forget` are rare, so they sit behind `…` and the row is one target to open.
    const expanded = rowMenu === t.server
    const more = button(
      '…',
      () => {
        rowMenu = expanded ? '' : t.server
        forgetArmed = ''
        forgetUnreached = ''
        renderRootPanel()
      },
      'name or forget this server',
    )
    more.setAttribute('aria-label', `more for ${targetLabel(t)}`)
    more.setAttribute('aria-expanded', String(expanded))
    more.style.cssText += ';min-width:44px;font-weight:700'
    row.append(open, more)
    top.append(row)
    if (!expanded) return
    const acts = document.createElement('div')
    acts.style.cssText = 'display:flex;gap:6px;margin:4px 0 0 14px;align-items:center'
    const edit = button(
      'name',
      () => {
        renaming = t.server
        rowMenu = ''
        renderRootPanel()
      },
      'give this server a name',
    )
    // Two taps: the first arms the button, as the destructive rows of the palettes do.
    const armed = forgetArmed === t.server
    const del = button(
      forgetting === t.server ? 'forgetting…' : armed ? 'forget — tap again' : 'forget',
      () => {
        if (forgetting) return
        if (forgetTimer !== null) clearTimeout(forgetTimer)
        forgetTimer = null
        if (forgetArmed !== t.server) {
          forgetArmed = t.server
          forgetTimer = setTimeout(() => {
            forgetArmed = ''
            forgetTimer = null
            renderRootPanel()
          }, FORGET_ARM_MS)
          renderRootPanel()
          return
        }
        forgetArmed = ''
        forgetting = t.server
        renderRootPanel()
        void forgetServer(t.server, targetLabel(t))
      },
      'forget this server: this app’s key is revoked on the server and discarded here. Tap twice',
    )
    if (armed) del.style.cssText += ';background:#7a1f1f;color:#fff;border-color:#c33'
    acts.append(edit, del)
    top.append(acts)
    if (forgetUnreached !== t.server) return
    // The server could not be told. Discarding the key now leaves its enrolment behind.
    const ask = document.createElement('div')
    ask.style.cssText =
      'margin:6px 0 0 14px;padding:8px;border:1px solid #c33;border-radius:6px;' +
      'font:13px/1.45 system-ui;color:#e5e5e5;background:#2a1414'
    const why = document.createElement('div')
    why.textContent =
      'The server did not answer, so it could not be told. ' +
      'If you forget it now, the key in this app (what this app logs in with) is deleted, ' +
      'but the key on the server (what lets this app in) is not revoked and stays enrolled. ' +
      'To remove that one you will have to run this on the PC:'
    const cmd = document.createElement('div')
    cmd.style.cssText =
      'margin:6px 0;font:12px ui-monospace,monospace;color:#cfe;user-select:text;' +
      '-webkit-user-select:text'
    cmd.textContent = 'node scripts/pw-auth.mjs list\nnode scripts/pw-auth.mjs revoke <id>'
    cmd.style.whiteSpace = 'pre'
    const q = document.createElement('div')
    q.style.cssText = 'font-weight:600'
    q.textContent = 'Forget it now anyway?'
    const btns = document.createElement('div')
    btns.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap'
    const anyway = button(
      'forget anyway',
      () => {
        log(`root: forgot ${t.server} — its key stays enrolled on the server (confirmed)`)
        void discardServer(t.server)
      },
      'delete the key in this app and leave the one on the server',
    )
    anyway.style.cssText += ';background:#7a1f1f;color:#fff;border-color:#c33'
    btns.append(
      button(
        'keep it',
        () => {
          forgetUnreached = ''
          renderRootPanel()
        },
        'change nothing; try again when the server is reachable',
      ),
      button(
        'try again',
        () => {
          forgetUnreached = ''
          forgetting = t.server
          renderRootPanel()
          void forgetServer(t.server, targetLabel(t))
        },
        'ask the server again',
      ),
      anyway,
    )
    ask.append(why, cmd, q, btns)
    top.append(ask)
    return
  })
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
  title.textContent = 'PinholeWindow'
  // Ellipsised rather than wrapped: on a narrow phone the title gives way to the buttons.
  title.style.cssText =
    'font-size:14px;margin:0;flex:1;min-width:0;white-space:nowrap;overflow:hidden;' +
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
  // The launcher toggles: opening it when it is up would close it, so both hooks check first.
  registerTourDemo('apps', {
    open: () => {
      if (!appsPaletteOpen()) openAppsPalette()
      return null
    },
    close: () => {
      if (appsPaletteOpen()) openAppsPalette()
    },
  })
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
  // The server list takes the mirror's place while no server is open (`renderRootPanel`).
  rootPanelEl = document.createElement('div')
  rootPanelEl.id = 'pw-servers'
  rootPanelEl.style.cssText =
    `max-width:${String(SCREEN_W)}px;box-sizing:border-box;padding:12px;` +
    'border:1px solid #a78bfa;border-radius:8px;background:#161616'
  ui.appendChild(rootPanelEl)
  renderRootPanel()
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
  // The tour opens each of these for one card. `keys` is left as the user had it; the two
  // pads are always closed afterwards, because the tour cannot open over an open pad.
  let keysOpenedByTour = false
  registerTourDemo('keys', {
    open: () => {
      keysOpenedByTour = keyPad.style.display === 'none'
      if (keysOpenedByTour) keysBtn.click()
      return keyPad
    },
    close: () => {
      if (keysOpenedByTour && keyPad.style.display !== 'none') keysBtn.click()
      keysOpenedByTour = false
    },
  })
  registerTourDemo('vring', {
    open: () => {
      openVRing()
      return null
    },
    close: closeVRing,
  })
  registerTourDemo('vpad', {
    open: () => {
      openVPad()
      return null
    },
    close: closeVPad,
  })
  const tools = pillRow(keysBtn, vringBtn, vpadBtn, invertBtn, mirrorBtn, lensBtn)
  tools.id = 'tools'
  ui.appendChild(tools)
  applyMirrorMode() // the label and the disabled state, now that the button exists
  registerTourTarget('tools', tools)
  ui.appendChild(keyPad)

  // `▶ app`: the per-app binding editor, directly under the rows whose pills it governs, and
  // folded. Its summary line carries what this app does right now, the submit key first.
  // The tour gives the text row and this fold a card each: the fold is where the submit key is.
  const appPanel = buildAppPanel()
  ui.appendChild(appPanel)
  registerTourTarget('text', textRow)
  registerTourTarget('app', appPanel)

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
  connServerEl = document.createElement('div')
  connServerEl.style.cssText = 'margin:6px 0 0'
  srv.appendChild(connServerEl)
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
      // Adds the address to the server list and opens it.
      switchServer(field.value)
      field.value = SERVER
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
      'enrol this app with the server (once per app or browser, per server)',
    ),
  )
  const pairNote = document.createElement('span')
  pairNote.style.cssText = 'font:11px/1.35 system-ui;color:#888'
  pairNote.textContent =
    'enrol this app — once per app or browser, and only after you approve it' + ' on the server'
  pairRow.appendChild(pairNote)
  srv.appendChild(pairRow)

  // Who is enrolled (docs/security.md). A key enrolled by someone other than the operator
  // grants full RCE on the host, so the list has a permanent row here and a red summary line
  // outside the fold.
  //
  // Nothing here changes server state: the only action is "mark as seen", which writes to this
  // device's localStorage. Enrolling and revoking stay on the host (`pw-auth`), so a stolen
  // session token can neither enrol a second key nor revoke the operator's.
  const keysHead = document.createElement('div')
  keysHead.style.cssText = 'display:flex;gap:8px;align-items:baseline;margin-top:10px'
  const keysTitle = document.createElement('div')
  keysTitle.style.cssText = 'font:600 11px system-ui;color:#bdbdbd'
  keysTitle.textContent = 'enrolled keys'
  keysAckBtn = button(
    'mark as seen',
    () => ackKeys(),
    'remember this exact set of keys in this app, and clear the warning',
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
