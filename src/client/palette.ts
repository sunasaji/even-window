// pinhole-window — the palette shell and the apps / task / window palettes.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import {
  CONFIRM_LABEL,
  parseToken,
  RP_LEVEL_LABEL,
  RP_PREFIX,
  windowPanelRows,
} from '../shared/glassMenu.ts'
import type { LauncherEntry, WinInfo } from '../shared/types.ts'
import { button, setLit, toast } from './chrome.ts'
import { log } from './debugLog.ts'
import {
  activeWindow,
  apps,
  launchApp,
  menuApps,
  menuState,
  runRowToken,
  selectWindow,
  setApps,
  windows,
  winRecent,
} from './menu.ts'
import { MENU_MAX_APPS, mruOrderWindows, windowAppName } from './menuModel.ts'
import { INSTANCE_ID } from './overlay.ts'
import { appsBtn, appsCountEl, taskBtn, windowBtn } from './phoneUi.ts'
import { apiGet } from './serverLink.ts'
import { closeVPad } from './vpad.ts'
import { closeVRing } from './vring.ts'

/** The open palette's re-render hook, set by its `open…Palette()` and cleared on close, with
 *  the stream events it wants to hear about. A palette reads module state when it opens, so an
 *  event that lands while it is shut loses nothing. */
let palettePanel: { on: readonly ('apps' | 'windows')[]; render: () => void } | null = null

/** Tell the open palette that one of its inputs moved. */
export function palettePanelUpdate(ev: 'apps' | 'windows'): void {
  if (palettePanel?.on.includes(ev)) palettePanel.render()
}

// The palettes (docs/phone-ui.md, docs/decisions/phone-palettes.md). Three top-anchored lists
// share one shell (`openPaletteShell` / `closePalette` / `layoutPalette`): `apps` (the launcher,
// the full scanned set; the glasses get only MENU_MAX_APPS of them), `task` (the window list)
// and `window` (the WM rows). Each supplies only its header controls, rows and filter.
//
// Keyboard: the soft keyboard shrinks the visual viewport and leaves the layout viewport alone,
// and `position:fixed` is laid out against the layout viewport, so a fixed panel does not
// reflow for the keyboard. The panel is therefore placed and sized from `window.visualViewport`,
// re-read on its `resize` and `scroll` events (iOS fires only `scroll` when the keyboard moves
// the visual viewport). The header and filter box keep their size; the list absorbs the
// difference. Without `visualViewport` it falls back to `documentElement.clientWidth/Height`
// plus `window.resize` / `orientationchange`.
//
// The palettes deliberately do not use `OVERLAY_TOUCH_CSS` or `suppressNativeTouchGestures()`.
// Those are for the gesture surfaces (vRing, vPad). A palette needs native scrolling in the
// list and a native caret, selection and soft keyboard in the filter box.
//
// A row is a `div[role=button][tabindex=0]`, not a native button: it keeps the affordance
// (click, Enter/Space, focus ring, role) and drops the button box, so a list reads as a list.
//
// One palette at a time: the history entry, the `popstate` handler, the Escape handler and the
// `kbdShouldHandle` gate are all single-valued. `openPaletteShell` closes whatever is up first.
/** The superseded curtain's z-index, above the palettes, vPad/vRing and the toast: the one
 *  surface in this app that must not be reachable past. */
const SUPERSEDED_Z = 10001

/** The undismissable "a newer instance owns the glasses" curtain.
 *
 *  Opaque and full-screen: a control still visible here would act through a bridge this page
 *  has given up, on a device another page is driving.
 *
 *  Its only control reloads, which mints a new instance id and takes the glasses back. That is
 *  the supported way to resolve it from the phone. */
export function showSupersededOverlay(by: string): void {
  if (typeof document === 'undefined' || document.getElementById('ew-superseded')) return
  const el = document.createElement('div')
  el.id = 'ew-superseded'
  el.setAttribute('role', 'alertdialog')
  el.style.cssText =
    'position:fixed;inset:0;background:#0d0d0d;display:flex;' +
    'flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;' +
    `box-sizing:border-box;text-align:center;z-index:${String(SUPERSEDED_Z)}`
  const h = document.createElement('div')
  h.style.cssText = 'font:600 16px/1.4 system-ui;color:#E5E5E5'
  h.textContent = 'another instance owns the glasses'
  const p = document.createElement('div')
  p.style.cssText = 'font:13px/1.6 system-ui;color:#9a9a9a;max-width:34em'
  // The whole explanation, because this screen appears without the user doing anything: the
  // Even App can leave an old page running.
  p.textContent =
    'A newer app screen opened and took over. This one has stopped pushing to the ' +
    'glasses so the two cannot fight over them — which is what leaves the lens blank until the ' +
    'glasses are rebooted. Close this screen, or take the glasses back here.'
  const id = document.createElement('div')
  id.style.cssText = 'font:11px ui-monospace,monospace;color:#6a6a6a'
  id.textContent = `this: ${INSTANCE_ID}   ·   owner: ${by || '(unknown)'}`
  const take = button(
    'take over here',
    () => {
      location.reload()
    },
    'reload this screen, which makes it the newest instance',
  )
  el.append(h, p, id, take)
  document.body.appendChild(el)
}

const PALETTE_BACKDROP_Z = 55
const PALETTE_Z = 56

/** Matching rows beyond this many are not shown. The DOM nodes are built once per `{t:'apps'}`,
 *  so this caps paint, not allocation; the note tells the user to narrow the filter. */
const APPS_RENDER_MAX = 120

/** The row styles. Injected once, because hairline separators, the press tint and the focus
 *  ring are pseudo-class and sibling rules an inline style cannot express.
 *
 *  Uniform height: both spans on one line with `white-space:nowrap` + `text-overflow:ellipsis`.
 *  `:active` works on a plain div because `mountUi` installs a no-op document `touchstart`
 *  listener.
 *
 *  32px: at the iPhone's keyboard-up geometry (260px of list box) that fits 8 rows, where 36
 *  fits 7 and 30 still only 8. The rows span the full width, so only the vertical dimension is
 *  under the usual 44pt target.
 *
 *  The name does not shrink (`flex:0 0 auto`, capped at 62%) and the command takes what is left
 *  (`flex:1 1 0`, right-aligned): the name is how an entry is found, the command only tells two
 *  entries with the same name apart. */
const PALETTE_CSS = `
.ew-plist .ew-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 10px;
  box-sizing:border-box;cursor:pointer}
.ew-plist .ew-row + .ew-row{border-top:1px solid #272727}
.ew-plist .ew-row:active{background:#2d3542}
.ew-plist .ew-row:focus-visible{outline:2px solid #9ecbff;outline-offset:-2px}
.ew-plist .ew-name{flex:0 0 auto;max-width:62%;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;font:14px/1.2 system-ui;color:#E5E5E5}
.ew-plist .ew-cmd{flex:1 1 0;min-width:0;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;font:11px/1.2 ui-monospace,monospace;color:#8f8f8f;text-align:right}
`

function ensurePaletteCss(): void {
  if (document.getElementById('ew-palette-css')) return
  const st = document.createElement('style')
  st.id = 'ew-palette-css'
  st.textContent = PALETTE_CSS
  document.head.appendChild(st)
}

/** The open palette's panel, or null. Doubles as the "is any palette open?" flag. */
export let paletteEl: HTMLElement | null = null
/** Removes every listener the open palette installed (visualViewport, window, document). */
let paletteDetach: (() => void) | null = null
/** True while our history entry is the current one, so the back gesture can close the palette
 *  without navigating the page away. See the back-gesture note in `openPaletteShell`. */
let palettePushedState = false
/** Who opened the palette that is up: focus returns here and the pill is unlit on close. */
let paletteOpener: HTMLButtonElement | null = null
/** The open palette's own id (`apps` / `task` / `window`), for the log lines. */
let paletteName = ''
/** The open palette's footer note, folded away by `layoutPalette` when the keyboard is up. */
let paletteNoteEl: HTMLElement | null = null

/** `apps 46` on the button at the right end of the title row. Updated on every `{t:'apps'}`,
 *  whether or not the palette is open. */
export function renderAppsEntry(): void {
  if (appsCountEl) appsCountEl.textContent = apps.length ? String(apps.length) : '—'
  if (appsBtn)
    appsBtn.setAttribute('aria-expanded', paletteName === 'apps' && paletteEl ? 'true' : 'false')
}

/** Keyboard detection threshold, in CSS px. The keyboard shrinks the visual viewport and leaves
 *  the layout viewport alone, so a visual viewport this much shorter than
 *  `documentElement.clientHeight` means a keyboard (or another inset) is up. Well above browser
 *  chrome jitter and far below any keyboard. Without `visualViewport` the two heights are equal
 *  and the test is always false. */
const PALETTE_KEYBOARD_SHRINK = 120

/** Place and size the panel against the visible rectangle. Idempotent and cheap; called on
 *  `visualViewport` resize/scroll and at the end of a render.
 *
 *  Keyboard down: `maxHeight` only, so a short list makes a short panel and the backdrop below
 *  it is the "tap outside to close" target.
 *  Keyboard up: `height` as well, so the panel owns every pixel the keyboard left. That also
 *  removes the strip of backdrop above the keys, where a mis-tap would close the palette. */
function layoutPalette(): void {
  const panel = paletteEl
  if (!panel) return
  const vv = window.visualViewport
  const left = vv ? vv.offsetLeft : 0
  const top = vv ? vv.offsetTop : 0
  const w = vv ? vv.width : document.documentElement.clientWidth
  const h = vv ? vv.height : document.documentElement.clientHeight
  const layoutH = document.documentElement.clientHeight
  const keyboard = layoutH - h >= PALETTE_KEYBOARD_SHRINK
  panel.style.left = `${String(Math.round(left))}px`
  panel.style.top = `${String(Math.round(top))}px`
  panel.style.width = `${String(Math.round(w))}px`
  panel.style.maxHeight = `${String(Math.round(h))}px`
  panel.style.height = keyboard ? `${String(Math.round(h))}px` : ''
  // The backdrop is opaque and hides the page, so it has to reach everywhere: `inset:0` covers
  // the layout viewport, and the min-height covers a WebView that puts the visual viewport's
  // bottom below it.
  const bd = panel.parentElement
  if (bd) bd.style.minHeight = `${String(Math.round(Math.max(layoutH, top + h)))}px`
  // The footer note is folded away while the keyboard is up, where the space is worth more as
  // rows. `keep` is set by the render when the note carries the truncation warning, which no
  // other part of the UI says.
  const note = paletteNoteEl
  if (note) note.style.display = keyboard && note.dataset.keep !== '1' ? 'none' : ''
}

/** Tear down the open palette. `keepHistory` hands our history entry to the next palette
 *  instead of popping it, which the swap in `openPaletteShell` needs.
 *
 *  `history.back()` dispatches `popstate` asynchronously, so popping here and pushing in the
 *  next palette would deliver the queued `popstate` to the new palette, which would read it as
 *  a back gesture and close itself. One entry stands for "a palette is open", whichever it is. */
function closePalette(why = 'closed', keepHistory = false): void {
  if (!paletteEl) return
  const back = palettePushedState
  const name = paletteName
  const opener = paletteOpener
  palettePushedState = keepHistory && back
  paletteDetach?.()
  paletteDetach = null
  palettePanel = null
  document.getElementById('ew-palette-backdrop')?.remove()
  paletteEl = null
  paletteNoteEl = null
  paletteOpener = null
  paletteName = ''
  // Focus goes back to the control that opened the palette. Otherwise it lands on <body> when
  // the focused row or filter box is removed, stranding a keyboard user and leaving a phone
  // keyboard up with nothing to type into.
  opener?.focus({ preventScroll: true })
  setLit(opener, false)
  renderAppsEntry()
  log(`${name} palette CLOSE (${why})`)
  // Pop our own history entry so the back stack does not accumulate one dead entry per open.
  // Only if the entry is still ours: `history.back()` past it would navigate the page, and a
  // reload re-runs `createStartUpPageContainer`, which must not happen while streaming
  // (docs/glasses.md). Not at all when the next palette is taking the entry.
  if (back && !keepHistory && isPaletteHistoryState()) history.back()
}

function isPaletteHistoryState(): boolean {
  const s: unknown = history.state
  return typeof s === 'object' && s !== null && (s as { ewPalette?: unknown }).ewPalette === true
}

/** What one palette has to say about itself. The backdrop, the keyboard arithmetic, the scroll
 *  indicator and the exits are the same for all three. */
interface PaletteSpec {
  /** `apps` / `task` / `window`. Becomes the panel's element id and the word in the log. */
  id: string
  /** The dialog's accessible name, and the heading text. */
  label: string
  /** The pill that opened it: it is lit while the palette is up and takes focus back on close. */
  opener: HTMLButtonElement | null
  /** Extra header controls, between the heading and the ✕. */
  controls?: readonly HTMLElement[]
  /** The filter box's placeholder. Omitted = no filter box, which is right for a short list:
   *  the soft keyboard would cover the rows it is filtering. */
  filter?: string
}

/** The handles a palette's own code needs back. */
interface PaletteShell {
  panel: HTMLElement
  /** The dim count beside the heading. */
  countEl: HTMLElement
  /** The scrolling list the rows go into. Carries `ew-plist`, so `PALETTE_CSS` styles them. */
  list: HTMLElement
  /** The footer note. Set `dataset.keep = '1'` for text that must survive the keyboard. */
  note: HTMLElement
  /** The filter box, or null when the spec asked for none. */
  filter: HTMLInputElement | null
  /** Re-fit the panel to the visible rectangle and re-sync the indicator. Call at the end of a
   *  render: the fit changes `clientHeight` and the render changes `scrollHeight`, and the
   *  thumb is a function of both. */
  fit: () => void
}

function openPaletteShell(spec: PaletteSpec): PaletteShell {
  // One at a time. Toggling the same palette shut is the caller's job; a different one open
  // here is replaced, and the replacement inherits its history entry (see `closePalette`).
  closePalette('replaced by ' + spec.id, true)
  // Not on top of a gesture pad: vRing and vPad own the touch layer, and a palette must not be
  // driven through their touch gate.
  closeVRing()
  closeVPad()
  ensurePaletteCss()

  // The backdrop is both the cover and the "tap outside" target. The panel is its child so one
  // `remove()` tears the whole thing down; the hit test is `e.target === backdrop`, so a tap on
  // the panel is ignored here.
  //
  // Opaque, not a dim: the page's own pill rows must not show through. One shade darker than
  // the panel (#1b1b1b), so the panel's edge stays visible and the area below a short panel
  // reads as "outside".
  const backdrop = document.createElement('div')
  backdrop.id = 'ew-palette-backdrop'
  backdrop.style.cssText =
    'position:fixed;inset:0;background:#0d0d0d;' + `z-index:${String(PALETTE_BACKDROP_Z)}`
  backdrop.addEventListener('pointerdown', e => {
    if (e.target === backdrop) closePalette('tapped outside')
  })

  // `role=dialog` with no `aria-modal`: this does not trap focus. The exits are ✕, tap outside,
  // the back gesture, and Escape.
  //
  // Tap-outside exists only when the panel is shorter than the screen. With the keyboard up the
  // panel takes the whole visible rectangle; ✕, Escape and the back gesture are unconditional.
  const panel = document.createElement('div')
  panel.id = `ew-${spec.id}`
  panel.tabIndex = -1
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', spec.label)
  panel.style.cssText =
    'position:fixed;display:flex;flex-direction:column;gap:6px;' +
    'box-sizing:border-box;padding:8px;background:#1b1b1b;border-bottom:1px solid #333;' +
    `z-index:${String(PALETTE_Z)};box-shadow:0 6px 18px rgba(0,0,0,.5)`
  backdrop.appendChild(panel)

  // The measured column, matching `main` in `mountUi`: full-width on a phone, capped on a
  // tablet. `flex:1 1 auto` so it grows as well as shrinks: with the keyboard up the panel has
  // an explicit height, and the space must go to the rows.
  const col = document.createElement('div')
  col.style.cssText =
    'display:flex;flex-direction:column;gap:6px;min-height:0;flex:1 1 auto;' +
    'width:100%;max-width:720px;margin:0 auto'
  panel.appendChild(col)

  // Header: name + count, the palette's own controls, ✕.
  const head = document.createElement('div')
  head.style.cssText = 'display:flex;align-items:center;gap:8px'
  const heading = document.createElement('div')
  heading.style.cssText = 'flex:1;min-width:0;font:12px/1.6 ui-monospace,monospace;color:#999'
  heading.textContent = `${spec.label} `
  const countEl = document.createElement('span')
  countEl.style.cssText = 'color:#777'
  heading.appendChild(countEl)
  const close = document.createElement('button')
  close.textContent = '✕'
  close.setAttribute('aria-label', `close the ${spec.id} palette`)
  // The same construction as `PAD_CHROME_CSS`: a 32px visible circle inside a 44px touch
  // target. The 6px transparent border with `background-clip:padding-box` grows the hit box
  // without growing the ring.
  close.style.cssText =
    'width:32px;height:32px;border-radius:50%;border:6px solid transparent;' +
    'background:#222;background-clip:padding-box;color:#E5E5E5;font:15px system-ui;' +
    'box-shadow:0 0 0 1px #555 inset;box-sizing:content-box;padding:0'
  close.addEventListener('click', () => {
    closePalette('✕')
  })
  head.append(heading, ...(spec.controls ?? []), close)
  col.appendChild(head)

  let filter: HTMLInputElement | null = null
  // The filter box, when the palette asked for one.
  if (spec.filter !== undefined) {
    // Not auto-focused: focusing raises the keyboard, and the first thing wanted on open is
    // usually to look at the list.
    const filterEl = document.createElement('input')
    filterEl.placeholder = spec.filter
    filterEl.spellcheck = false
    filterEl.autocapitalize = 'off'
    filterEl.setAttribute('autocorrect', 'off')
    filterEl.setAttribute('enterkeyhint', 'done')
    filterEl.setAttribute('aria-label', spec.filter)
    // 14px, deliberately under index.html's global `input, textarea { font-size: 16px }`. That
    // rule prevents iOS Safari's zoom-on-focus; it can be overridden here because the viewport
    // sets `maximum-scale=1`, which the focus zoom cannot exceed. If a WebView zooms anyway,
    // put this back to 16px.
    filterEl.style.cssText =
      'width:100%;box-sizing:border-box;padding:6px 9px;' +
      'font:14px ui-monospace,monospace;background:#000;color:#E5E5E5;' +
      'border:1px solid #333;border-radius:6px'
    col.appendChild(filterEl)
    filter = filterEl
  }

  // The list. `flex:1;min-height:0` is what makes the keyboard arithmetic work: the panel's
  // max-height follows the visual viewport and this is the child that gives way, so the header
  // and filter box never move. `position:relative` anchors the scroll indicator below.
  const listWrap = document.createElement('div')
  listWrap.style.cssText = 'position:relative;flex:1 1 auto;min-height:0;display:flex'

  const list = document.createElement('div')
  list.className = 'ew-plist'
  list.style.cssText =
    'flex:1 1 auto;min-width:0;overflow-y:auto;background:#111;' +
    'border:1px solid #333;border-radius:8px;overscroll-behavior:contain;' +
    '-webkit-overflow-scrolling:touch'
  listWrap.appendChild(list)

  // Scroll indicator, drawn here rather than styled: iOS shows its overlay scrollbar only while
  // a finger is moving and ignores `::-webkit-scrollbar` for it, so at rest nothing would show
  // how long the list is.
  //
  // A 3px track inside the list's right edge with a thumb whose size is the visible fraction
  // and whose position is the scrolled fraction. `pointer-events:none`: it is an indicator, not
  // a control. Hidden when everything fits.
  const bar = document.createElement('div')
  bar.style.cssText =
    'position:absolute;top:3px;right:3px;bottom:3px;width:3px;border-radius:2px;' +
    'background:#2a2a2a;pointer-events:none;opacity:0;transition:opacity .15s'
  const thumb = document.createElement('div')
  thumb.style.cssText = 'position:absolute;left:0;width:100%;border-radius:2px;background:#6b6b6b'
  bar.appendChild(thumb)
  listWrap.appendChild(bar)

  /** Size and place the thumb from the list's own scroll metrics. Cheap enough for every scroll
   *  event. */
  const syncScrollBar = (): void => {
    const vh = list.clientHeight
    const sh = list.scrollHeight
    if (sh <= vh + 1) {
      bar.style.opacity = '0'
      return
    }
    bar.style.opacity = '1'
    const track = vh - 6 // the bar is inset 3px top and bottom
    const h = Math.max(24, Math.round(track * (vh / sh)))
    const max = track - h
    thumb.style.height = `${h}px`
    thumb.style.top = `${Math.round(max * (list.scrollTop / (sh - vh)))}px`
  }
  list.addEventListener('scroll', syncScrollBar, { passive: true })

  col.appendChild(listWrap)

  // Hidden while the keyboard is up (layoutPalette), where the space is worth more as rows.
  const note = document.createElement('div')
  note.style.cssText = 'font:11px/1.35 system-ui;color:#888'
  col.appendChild(note)

  document.body.appendChild(backdrop)
  paletteEl = panel
  paletteOpener = spec.opener
  paletteName = spec.id
  paletteNoteEl = note
  // An empty panel, fitted, so it does not appear at the wrong size for a frame. The caller's
  // first render ends in `fit()` and does it again with the rows in place.
  layoutPalette()
  setLit(spec.opener, true)
  panel.focus({ preventScroll: true })

  // The listeners, and their removal. The keyboard raising and lowering resizes the list
  // without any content change, so the indicator has to follow the fit here too.
  const onViewport = (): void => {
    layoutPalette()
    syncScrollBar()
  }
  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', onViewport)
    vv.addEventListener('scroll', onViewport)
  }
  // Also for the fallback path without visualViewport, and for rotation, which changes the
  // layout viewport too.
  window.addEventListener('resize', onViewport)
  window.addEventListener('orientationchange', onViewport)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePalette('Escape')
    }
  }
  document.addEventListener('keydown', onKey)
  // The back gesture. A same-document `pushState` entry is popped by the system back swipe
  // without reloading the page (a reload would re-establish the page container;
  // docs/glasses.md). `popstate` means the entry is already gone, so the close must not call
  // `history.back()` again.
  const onPop = (): void => {
    palettePushedState = false
    closePalette('back gesture')
  }
  window.addEventListener('popstate', onPop)
  paletteDetach = () => {
    if (vv) {
      vv.removeEventListener('resize', onViewport)
      vv.removeEventListener('scroll', onViewport)
    }
    window.removeEventListener('resize', onViewport)
    window.removeEventListener('orientationchange', onViewport)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('popstate', onPop)
  }
  // Already ours when a palette was just replaced: a second entry would make the back gesture
  // need two swipes to leave.
  if (!palettePushedState) {
    try {
      history.pushState({ ewPalette: true }, '')
      palettePushedState = true
    } catch {
      palettePushedState = false // a WebView that refuses pushState keeps ✕ / tap-outside
    }
  }

  return {
    panel,
    countEl,
    list,
    note,
    filter,
    fit: () => {
      layoutPalette()
      syncScrollBar()
    },
  }
}

/** Is the launcher the palette that is up? For the tour, which opens and closes it. */
export function appsPaletteOpen(): boolean {
  return paletteName === 'apps' && paletteEl !== null
}

export function openAppsPalette(): void {
  if (paletteName === 'apps' && paletteEl) {
    closePalette('toggled off')
    return
  }
  // `GET /api/apps?rescan=1` re-runs the package scan, so that a hand-edited apps.conf takes
  // effect without restarting the server.
  const rescan = button(
    'rescan',
    () => {
      void doRescan()
    },
    'GET /api/apps?rescan=1 — re-read apps.conf and re-scan installed packages',
  )
  rescan.style.cssText = 'font:11px system-ui'
  const shell = openPaletteShell({
    id: 'apps',
    label: 'apps',
    opener: appsBtn,
    controls: [rescan],
    filter: 'filter name or command…',
  })
  const { countEl, list, note } = shell
  const filter = shell.filter
  if (!filter) return // unreachable: the spec above asks for a box

  // Rows are built once per app list and filtered by toggling `display`: rebuilding on every
  // keystroke would throw away the scroll position and re-lay-out the list under the thumb.
  let rows: { el: HTMLElement; hay: string }[] = []
  let builtFor: LauncherEntry[] | null = null

  const buildRows = (): void => {
    list.textContent = ''
    rows = []
    builtFor = apps
    for (const a of apps) {
      const argv = [a.cmd, ...a.args].join(' ')
      const row = document.createElement('div')
      row.className = 'ew-row'
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      row.title = `${argv}${a.terminal ? '  (wrapped in a terminal)' : ''}  [${a.note}]`
      const nameEl = document.createElement('span')
      nameEl.className = 'ew-name'
      nameEl.textContent = a.name
      // The command stays on the row because two entries can share a display name (a deb and a
      // snap Firefox) and the command is what tells them apart. One line, ellipsised, with the
      // full argv in the tooltip and the aria-label. It is omitted when it would repeat the
      // name verbatim.
      const cmdEl = document.createElement('span')
      cmdEl.className = 'ew-cmd'
      const cmdText = `${a.terminal ? 'term: ' : ''}${argv}`
      cmdEl.textContent = cmdText
      const showsCmd = cmdText !== a.name
      row.append(nameEl)
      if (showsCmd) row.appendChild(cmdEl)
      row.setAttribute('aria-label', `${a.name} — ${cmdText}`)

      let busy = false
      const act = (): void => {
        if (busy) return
        busy = true
        row.setAttribute('aria-busy', 'true')
        // The dim column doubles as the per-row progress readout, so a row that normally has
        // no command text borrows it for the duration.
        if (!showsCmd) row.appendChild(cmdEl)
        cmdEl.textContent = 'launching…'
        void launchApp(a.id, a.name).then(ok => {
          busy = false
          row.removeAttribute('aria-busy')
          cmdEl.textContent = cmdText
          if (!showsCmd) cmdEl.remove()
          // On success the interesting surface is the mirror behind this panel (and the toast
          // over it), so close. A failure keeps the list up.
          if (ok) closePalette('launched')
        })
      }
      row.addEventListener('click', act)
      row.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault() // Space would scroll the list
        act()
      })
      rows.push({ el: row, hay: `${a.name}\n${argv}\n${a.id}`.toLowerCase() })
      list.appendChild(row)
    }
  }

  const empty = document.createElement('div')
  empty.style.cssText = 'padding:10px;font:12px/1.5 system-ui;color:#888'

  const render = (): void => {
    if (builtFor !== apps) buildRows()
    // Every whitespace-separated token must match the name, the command or the id. The command
    // is included because the path is what distinguishes duplicates (`firefox snap`).
    const terms = filter.value
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 0)
    let hits = 0
    let shown = 0
    for (const r of rows) {
      const hit = terms.every(t => r.hay.includes(t))
      if (hit) hits++
      const show = hit && shown < APPS_RENDER_MAX
      if (show) shown++
      r.el.style.display = show ? '' : 'none'
    }
    countEl.textContent = terms.length
      ? `${String(hits)}/${String(apps.length)}`
      : String(apps.length)
    if (!apps.length) {
      empty.textContent = 'no applications scanned yet — the list arrives over the stream'
      list.appendChild(empty)
    } else if (!hits) {
      empty.textContent = `nothing matches ${filter.value.trim()}`
      list.appendChild(empty)
    } else {
      empty.remove()
    }
    const more =
      hits > shown ? ` (showing ${String(shown)} of ${String(hits)}; narrow the filter)` : ''
    const curated = menuApps()
      .map(m => m.name)
      .join(', ')
    note.textContent =
      `tap to launch on the mirrored desktop${more}.` +
      ` glasses menu shows the ${String(MENU_MAX_APPS)} most recent${curated ? `: ${curated}` : ' (none yet)'}.`
    // The truncation warning is the one thing here the header's `hits/total` cannot say, so it
    // survives the keyboard.
    note.dataset.keep = more ? '1' : ''
    // The note's presence changes the column's height, so re-run the fit.
    shell.fit()
  }

  const doRescan = async (): Promise<void> => {
    rescan.disabled = true
    const prev = rescan.textContent ?? 'rescan'
    rescan.textContent = 'scanning…'
    const r = await apiGet<{ list?: LauncherEntry[]; recent?: string[]; errors?: string[] }>(
      '/api/apps?rescan=1',
    )
    if (r?.list) {
      setApps(r.list, r.recent ?? [])
      const errs = r.errors ?? []
      toast(errs.length ? `apps.conf: ${errs[0] ?? ''}` : `${String(r.list.length)} applications`)
      for (const e of errs) log(`apps.conf: ${e}`)
    } else {
      toast('rescan failed')
    }
    rescan.textContent = prev
    rescan.disabled = false
  }

  filter.addEventListener('input', render)
  palettePanel = { on: ['apps'], render }
  render()

  renderAppsEntry()
  log(
    `apps palette OPEN — ${String(apps.length)} scanned · filter matches name and command · ` +
      `sized to visualViewport (${window.visualViewport ? 'live' : 'ABSENT — full-viewport fallback'})`,
  )
}

export function openTaskPalette(): void {
  if (paletteName === 'task' && paletteEl) {
    closePalette('toggled off')
    return
  }
  // A filter box, unlike `window`: this list grows with the session, and a title is what tells
  // two xterms apart.
  const shell = openPaletteShell({
    id: 'task',
    label: 'task',
    opener: taskBtn,
    filter: 'filter by title or class…',
  })
  const { countEl, list, note, filter } = shell
  if (!filter) return // unreachable: the spec above asks for a box

  const render = (): void => {
    // Read the live order on every render. The glasses freeze it while the menu is open
    // (`menuRootOrder`) because a list that re-sorts under a cursor hands the next tap to a
    // different window; here a thumb aims at a row it can see, and each row carries its own wid.
    const all = mruOrderWindows(windows, winRecent)
    const terms = filter.value
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 0)
    const hay = (w: WinInfo) => `${w.title}\n${w.cls}\n${w.app}`.toLowerCase()
    const rows = all.filter(w => terms.every(t => hay(w).includes(t)))
    list.textContent = ''
    countEl.textContent = terms.length
      ? `${String(rows.length)}/${String(all.length)}`
      : String(all.length)
    for (const w of rows) {
      const row = document.createElement('div')
      row.className = 'ew-row'
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      const nameEl = document.createElement('span')
      nameEl.className = 'ew-name'
      // The active marker is `*`, as on the glasses overlay.
      nameEl.textContent = (w.active ? '* ' : '') + (w.title || w.cls || w.app || w.wid)
      if (w.active) nameEl.style.color = '#9ad'
      // The dim column carries the class, which tells two windows with the same title apart.
      const clsEl = document.createElement('span')
      clsEl.className = 'ew-cmd'
      clsEl.textContent = windowAppName(w)
      row.append(nameEl, clsEl)
      row.setAttribute(
        'aria-label',
        `${w.title || w.cls} — ${w.cls}${w.active ? ' (current)' : ''}`,
      )
      const act = (): void => {
        const wid = w.wid
        if (!wid) return // `mruOrderWindows` drops these already
        closePalette('switched') // out of the way first: the result is the mirror
        void selectWindow(wid, w.title || w.cls || wid)
      }
      row.addEventListener('click', act)
      row.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault() // Space would scroll the list
        act()
      })
      list.appendChild(row)
    }
    if (!all.length) {
      const empty = document.createElement('div')
      empty.style.cssText = 'padding:10px;font:12px/1.5 system-ui;color:#888'
      empty.textContent = 'no managed windows — launch something from `apps`'
      list.appendChild(empty)
    }
    note.textContent = 'most recently focused first — the order the glasses list uses.'
    note.dataset.keep = ''
    shell.fit()
  }

  filter.addEventListener('input', render)
  palettePanel = { on: ['windows'], render }
  render()
  log(
    `task palette OPEN — ${String(mruOrderWindows(windows, winRecent).length)} windows, MRU order`,
  )
}

export function openWindowPalette(): void {
  if (paletteName === 'window' && paletteEl) {
    closePalette('toggled off')
    return
  }
  // No filter box (see `PaletteSpec.filter`): nine rows, and the keyboard would cover them.
  const shell = openPaletteShell({ id: 'window', label: 'window', opener: windowBtn })
  const { countEl, list, note } = shell

  /** The row armed for confirmation, if any. One at a time: arming a second disarms the first. */
  let armed: string | null = null

  const render = (): void => {
    const rows = windowPanelRows(menuState())
    list.textContent = ''
    countEl.textContent = String(rows.length)
    for (const r of rows) {
      const isArmed = armed === r.token
      const row = document.createElement('div')
      row.className = 'ew-row'
      row.setAttribute('role', 'button')
      row.tabIndex = 0
      const nameEl = document.createElement('span')
      nameEl.className = 'ew-name'
      nameEl.textContent = isArmed ? CONFIRM_LABEL : r.label
      // The dim right-hand column carries what the row sends, in the WM's own spelling
      // (`C-t n`): the labels are English phrases, and the command is what identifies the row
      // to someone who knows the keystroke.
      const cmdEl = document.createElement('span')
      cmdEl.className = 'ew-cmd'
      cmdEl.textContent = isArmed ? 'tap again' : rowSendsLabel(r.token)
      if (isArmed) {
        nameEl.style.color = '#ff6b57'
        cmdEl.style.color = '#ff6b57'
      }
      row.append(nameEl, cmdEl)
      row.setAttribute('aria-label', `${r.label} — ${rowSendsLabel(r.token)}`)
      const act = (): void => {
        if (r.confirm && !isArmed) {
          armed = r.token
          log(`window palette: ${r.label} ARMED — tap again to confirm`)
          render()
          return
        }
        const t = parseToken(r.token)
        if (!t) {
          log(`window palette row "${r.label}": unknown token ${r.token}, ignored`)
          return
        }
        // Close first, then act (the glasses' rule, see `activateRow`): whatever this does lands
        // on the mirror behind the panel.
        closePalette('acted')
        void runRowToken(t, [], 'window palette')
      }
      row.addEventListener('click', act)
      row.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault() // Space would scroll the list
        act()
      })
      list.appendChild(row)
    }
    const w = activeWindow()
    note.textContent = w?.title
      ? `acting on: ${w.title}. ${RP_LEVEL_LABEL.replace('...', '')} on the glasses shows the same rows.`
      : 'no focused window — the rows that need one are hidden.'
    note.dataset.keep = ''
    shell.fit()
  }

  palettePanel = { on: ['windows'], render }
  render()
  log(
    `window palette OPEN — ${String(windowPanelRows(menuState()).length)} rows` +
      ` (the glasses' ${RP_LEVEL_LABEL} level, flat: no Back, no paging, Close Window inline)`,
  )
}

/** What a row will send, in the spelling the user would type. The one place that formats it. */
function rowSendsLabel(token: string): string {
  const t = parseToken(token)
  if (!t) return ''
  // `ctrl+t c` reads as `C-t c`, in both halves: the catalogue's `ctrl+t` key (the `other`
  // command, the prefix twice) must print as `C-t C-t`.
  const emacs = (k: string) => k.replace('ctrl+', 'C-')
  if (t.kind === 'rp') return `${emacs(RP_PREFIX)} ${emacs(t.key)}`
  if (t.kind === 'close') return 'delete window'
  return ''
}
