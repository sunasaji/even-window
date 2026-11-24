// even-window — the text overlay: lens / case pause, instance supersede, link baseline, and the
// serialised show/hide transition.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.

import { OVERLAY_LAYER_ID, TILE_H, TILE_W, TILES, tileContainerId } from '../shared/geom.ts'
import { pathHeader } from '../shared/glassMenu.ts'
import { LatestAsyncWriter } from '../shared/latestAsyncWriter.ts'
import { voiceOverlay } from '../shared/voiceDialog.ts'
import { log } from './debugLog.ts'
import { established, flushLogNow, glassLinkUp, pushImage, renderPageWarning } from './glassPage.ts'
import { STARTUP_HINT_MS, startupHintText, takeHint } from './hints.ts'
import {
  formatLinkBase,
  LINK_BASE_PUSHES,
  linkBasePattern,
  linkBaseVerdict,
  medianOf,
} from './linkBase.ts'
import { bridge, sdk } from './main.ts'
import {
  menuItems,
  menuLevelRows,
  menuOpen,
  menuPage,
  menuPath,
  menuRowCount,
  menuSel,
  rootPageCount,
  rootRows,
} from './menu.ts'
import { showSupersededOverlay } from './palette.ts'
import { lensBtn } from './phoneUi.ts'
import { kickPump, lastTiles, pumpQuiesce, setForcePending } from './pump.ts'
import { sameBytes, TILE_NAMES } from './pumpStats.ts'
import { applyMirrorMode } from './settings.ts'
import { renderStatus, setStatus, syncPreviewOverlay } from './statusUi.ts'
import { availMsg, stopStream, sttReady } from './stream.ts'
import { encodeTilePng } from './tiles.ts'
import { errText, withTimeout } from './util.ts'
import { voice } from './voice.ts'

/** `overlayBusy` holds the pump down across a hide transition: `menuOpen` is already false by
 *  then, so without it an arriving tile could repaint before id 6 has actually gone blank. */
export let overlayBusy = false

// ── pausing the lens (the glasses' own battery) ────────────────────────────────────────────
//
// A pause is a text overlay, like the `X unavailable` notice: `overlayActive()` halts the pump,
// the show transition blanks the four tiles (black is no emission on this panel, so a paused
// lens is at its lowest power), and the hide transition resets the diff baseline and repaints.
// Never a rebuild.
//
// Two things pause the lens: the user's latch (`lensOn`) and `isInCase`, which the hardware
// reports correctly in both directions while the link stays `connected`. A sensor-driven pause
// needs an escape hatch: while paused for the case the button reads `lens:case`, and one press
// overrides the sensor for the session. `isWearing` is deliberately not used: on a G2 it is
// wrong in both directions (a stale `true` after removal, `false` while worn), so it is only
// logged.

// ── who owns the glasses (docs/decisions/glasses-instance-supersede.md) ────────────────────
//
// An Even App that restarts can leave its previous page running, so two live instances share
// one bridge and one pair of glasses. This page cannot see the other; the server sees both,
// arbitrates (src/server/instances.ts) and tells the loser, which stands down and says why on
// its own screen.

/** This page load's identity, minted once. Sent as `?inst=` on the stream, which is what makes
 *  "the same id came back" mean "the old page is still running". */
export const INSTANCE_ID = `ew-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
/** Has a newer instance taken over? One-way: nothing clears it but a reload. */
export let superseded = false

/** The latch: does the user want the lens driven at all? Not persisted: a lens that stays dark
 *  across a WebView teardown with no explanation looks like a broken app. Session state, not a
 *  setting. */
export let lensOn = true
/** Are the glasses in their case? `DeviceStatus.isInCase`; `undefined` means no, because
 *  absence of evidence must not pause the lens. */
export let glassInCase = false
/** Do we still believe `isInCase`? Cleared for the session by a user who disagrees. */
let caseTrust = true

/** Stand this instance down for good: a newer page load owns the glasses. Everything stops: the
 *  stream is closed, the bridge paths are gated on `superseded`, and an undismissable overlay
 *  covers the UI, because controls here would act through a bridge this page no longer owns.
 *
 *  Not `shutDownPageContainer`: that exits the app the new instance is running in. One-way
 *  except by reload, which mints a fresh instance id and takes the glasses back. */
export function standDownSuperseded(by: string): void {
  if (superseded) return
  superseded = true
  log(
    `SUPERSEDED by instance ${by || '(unknown)'} — this page is standing down` +
      ' (a newer WebView owns the glasses; reload here to take them back)',
  )
  flushLogNow()
  stopStream()
  renderPageWarning() // the curtain explains this page now; the bar must not add noise
  setStatus('superseded — a newer instance owns the glasses')
  renderStatus()
  showSupersededOverlay(by)
}

/** Why the lens is paused, or null when it is live. A reason rather than a boolean: the notice
 *  and the status line both print it. The link being down is not here: it must not push a
 *  notice, so it gates `pumpTiles` and `pushImage` directly. */
export function mirrorPaused(): string | null {
  if (!lensOn) return 'lens:off on the phone'
  // The lens text names the control that resumes it.
  if (glassInCase) return 'in the case — press lens:case on the phone to override'
  return null
}

/** `isInCase` from the host. Separate from the latch because they are different authorities. */
export function setGlassInCase(v: boolean): void {
  if (!caseTrust || glassInCase === v) return
  glassInCase = v
  log(
    `glasses ${v ? 'in the case — lens pauses (a closed box is nobody looking)' : 'out of the case — lens resumes'}`,
  )
  applyMirrorMode()
  syncOverlay()
}

/** The user says the case sensor is wrong. One press, and we stop believing it this session. */
export function overrideCase(): void {
  if (!glassInCase) return
  glassInCase = false
  caseTrust = false
  log('lens:case overridden — the case sensor is ignored from now on')
  applyMirrorMode()
  syncOverlay()
}

/** Is the frame pump able to run at all? The input to `effectiveMirrorMode`, because the green
 *  preview is derived inside the pump. */
export function pumpLive(): boolean {
  return glassLinkUp && mirrorPaused() === null
}

/** Three states, because the button's job changes with them: `off` = the latch is down and a
 *  press raises it; `case` = the sensor paused us and a press overrides it; `on` = running, and
 *  a press pauses. */
export function lensLabel(): string {
  return `lens:${!lensOn ? 'off' : glassInCase ? 'case' : 'on'}`
}

export function setLensOn(on: boolean): void {
  if (lensOn === on) return
  lensOn = on
  if (lensBtn) lensBtn.textContent = lensLabel()
  log(
    `lens ${on ? 'ON — baseline reset, tiles flow again' : 'OFF — tiles blanked, pump stands down'}` +
      ` (the phone keeps working: task / window / apps / keys / vPad)`,
  )
  applyMirrorMode()
  // Show the notice (blanking the tiles under it) or hide it (reset the baseline and repaint),
  // serialised with every other transition.
  syncOverlay()
}

// ── the startup hint (hints.ts) ────────────────────────────────────────────────────────────
//
// The mirror carries no hint of its own, so the double-tap that opens everything else is
// invisible to a first-time user. The first time a page load establishes, on the first few
// launches per device, the lens shows the gestures for `STARTUP_HINT_MS`. Any gesture closes
// it: swipe and tap are consumed (their effect could not be seen under the text), a double-tap
// goes on to open the menu. A lowest-priority notice: the menu, the dialog, `X unavailable`
// and a pause all draw over it, and its timer runs regardless.

/** Is the startup hint on the lens? */
export let startupHint = false
/** Considered once per page load, so a re-establish never shows it again. */
let startupHintConsidered = false
let startupHintTimer: ReturnType<typeof setTimeout> | null = null

/** Called when the page establishes. Shows the hint if this device is still due one. */
export function maybeShowStartupHint(): void {
  if (startupHintConsidered) return
  startupHintConsidered = true
  if (!takeHint('startup')) return
  log(`startup hint ON for ${String(STARTUP_HINT_MS)} ms (hints.ts; any gesture closes it)`)
  startupHint = true
  startupHintTimer = setTimeout(() => {
    startupHintTimer = null
    dismissStartupHint()
  }, STARTUP_HINT_MS)
  syncOverlay()
}

/** Take the hint down. True when it was up, so a gesture that only closed it can stop there.
 *  `sync: false` for a caller that is redrawing the overlay itself (`syncOverlay`), so the lens
 *  goes hint → menu without a blank in between. */
export function dismissStartupHint(sync = true): boolean {
  if (!startupHint) return false
  startupHint = false
  if (startupHintTimer !== null) {
    clearTimeout(startupHintTimer)
    startupHintTimer = null
  }
  log('startup hint OFF')
  if (sync) syncOverlay()
  return true
}

// ── a foreground layer is covering the panel ───────────────────────────────────────────────
//
// `FOREGROUND_ENTER`/`EXIT` (shared/evenEvent.ts `foregroundChange`) say a layer, most often a
// phone notification, came and went. Pushing under it is wasted, and `lastTiles` advancing
// behind it could leave a quadrant stale, so the cover joins `overlayActive()`.
//
// Unlike every other cover, leaving it does not reset the diff baseline: the firmware
// composites the banner above the image containers without writing into them, so `lastTiles`
// stays true and a cover costs zero pushes when nothing changed. Nothing is drawn and nothing
// is rebuilt.
//
// Trade-off: the banner covers only the top of the panel but the pump stands down for all four
// quadrants, so the visible lower half freezes for the ~5 s a banner lasts. The app is never
// told the banner's height.
export let glassCovered = false

export function setGlassCovered(on: boolean): void {
  if (glassCovered === on) return
  glassCovered = on
  if (on) {
    log('foreground layer entered — pump stands down (nothing can be seen under it)')
    renderStatus()
    return
  }
  // No baseline reset: the layer is composited above the image containers and never writes
  // into them, so `lastTiles` is still true. The kick delivers any quadrant that changed while
  // the pump stood down. If a quadrant ever stays stale after a banner, set `forcePending` here.
  log('foreground layer left — resuming (the layer did not touch the containers)')
  renderStatus()
  kickPump()
}

/** Held for the few seconds of a link baseline. Without it an SSE tile arriving mid-measurement
 *  kicks the pump and puts a content push among the fixed-payload samples. */
export let measuringLink = false

/** Measure how fast this session's link is, with a payload that never changes. Runs with
 *  `?stats=1` rather than a flag of its own, so no measurement run lacks a baseline. ~3.5 s of
 *  frozen mirror, then normal streaming. Never throws into the caller. */
export async function measureLinkBaseline(at: 'start' | 'end'): Promise<void> {
  if (!bridge) return
  measuringLink = true
  try {
    // Announced before the pattern is visible, so the mosaic never appears against a silent
    // log.
    log(
      `linkbase(${at}): ${LINK_BASE_PUSHES} fixed-pattern pushes — the bright mosaic on the` +
        ' glass is the test pattern, not a fault; content repaints when it ends',
    )
    const bytes = await encodeTilePng(linkBasePattern(TILE_W, TILE_H))
    const ms: number[] = []
    for (let k = 0; k < LINK_BASE_PUSHES; k++) {
      const t = k % TILES
      const r = await pushImage(tileContainerId(t), `tile${t}`, bytes)
      if (r.ok) {
        ms.push(r.ms)
        lastTiles[t] = bytes
      }
    }
    log(formatLinkBase(ms, bytes.length, at))
    if (at === 'start') linkBaseStart = medianOf(ms)
    else log(linkBaseVerdict(linkBaseStart, medianOf(ms)))
  } catch (e) {
    log(`linkbase(${at}) failed: ${errText(e)} — this run cannot be compared with another`)
  } finally {
    measuringLink = false
    setForcePending(true) // the baseline overwrote the quadrants; repaint from content
    kickPump()
  }
}

/** The start baseline's median, so the end one can be read against it. */
let linkBaseStart = 0

/** Stats windows before the closing baseline: six is a minute. */
export const LINK_BASE_END_AFTER = 6

// The text-container write path: container 6, never container 1 (the input layer is not pushed
// after establish). LatestAsyncWriter keyed on the container id keeps writes serial and
// latest-wins, so a burst of selection moves collapses to the final content.
const textWriter = new LatestAsyncWriter<number, string>()

/** Said once per link-down period, not once per skipped write (the dialog redraws at 1 Hz). */
export let overlaySkipLogged = false
export function setOverlaySkipLogged(v: boolean): void {
  overlaySkipLogged = v
}

function writeOverlayText(content: string): Promise<void> {
  return textWriter.write(OVERLAY_LAYER_ID, content, async v => {
    if (!sdk || !bridge) return
    // Not while the link is down, the same gate `pushImage` has: each write could sit out the
    // 8 s timeout, and the voice dialog redraws once a second. The lens is brought up to date
    // when the link returns (`setGlassLink` → `syncOverlay`).
    if (!glassLinkUp) {
      if (!overlaySkipLogged) {
        overlaySkipLogged = true
        log('overlay text not pushed — the glasses link is down (re-sent when it returns)')
      }
      return
    }
    try {
      // The boolean host status is logged: a refused push and an accepted-but-undrawn one both
      // look like "the overlay never appeared" otherwise.
      const ok = await withTimeout(
        Promise.resolve(
          bridge.textContainerUpgrade(
            new sdk.TextContainerUpgrade({
              containerID: OVERLAY_LAYER_ID,
              containerName: 'overlay',
              contentOffset: 0,
              contentLength: v.length,
              content: v,
            }),
          ),
        ),
        8000,
        'text',
      )
      // `=> false` before the page exists is expected: an SSE `avail` event can land before
      // `establishPage` finishes, and the host refuses a push to a container it has not created.
      log(
        `overlay text => ${String(ok)} (${v.length} chars)${established ? '' : ' [pre-establish, expected]'}`,
      )
    } catch (e) {
      log(`overlay text push failed: ${errText(e)}`)
    }
  })
}

// ── blanking the tiles under the overlay (docs/decisions/blank-tiles-under-overlay.md) ─────
//
// Standing the pump down stops new frames but does not darken the panel: the G2 keeps lighting
// whatever each image container last held, so overlay text would sit on a bright frozen frame.
// Once the pump has quiesced, the show transition pushes an all-black image to each tile; black
// is no emission, so the text ends up on an unlit field.
//
// Full-screen rather than just the menu's rows: lit text right above and below would still
// smear, the menu covers nearly the whole panel anyway (`LEVEL_MAX_ROWS` in
// src/shared/glassMenu.ts), and a whole-tile blank is one pre-encoded constant.

/** The all-black 288x144 tile, encoded once for the lifetime of the page. Polarity-independent:
 *  it is not content but "this quadrant emits nothing", so it is level 0 whatever `invert` is. */
let blackTile: Promise<Uint8Array> | null = null

function blackTileBytes(): Promise<Uint8Array> {
  if (blackTile) return blackTile
  // Through the same encoder as every other push, so the blank is byte-comparable with
  // `lastTiles`.
  blackTile = encodeTilePng(new Uint8Array(TILE_W * TILE_H))
  return blackTile
}

/** Which tiles need the black push. Pure, so a test pins both properties: nothing is pushed
 *  when blanking is not in effect, and a tile already holding black is not re-pushed (every
 *  selection move re-runs the show transition).
 *
 *  `last` is the pump's baseline (`lastTiles`); a successful blank writes the black bytes into
 *  it, and the hide path's `resetBaseline` un-records it. */
export function blankTilePlan(
  last: ReadonlyArray<Uint8Array | null>,
  black: Uint8Array,
  overlayInFront: boolean,
): number[] {
  if (!overlayInFront) return []
  const out: number[] = []
  for (let i = 0; i < TILES; i++) if (!sameBytes(last[i] ?? null, black)) out.push(i)
  return out
}

/** Push the black constant to every tile that is not already black. Serial, through the same
 *  `pushImage` the pump uses. Safe against a concurrent push because the caller has awaited
 *  `standDown()` and `overlayActive()` is true for the whole show transition. */
async function blankTilesForOverlay(): Promise<void> {
  // Link down: every push would be refused and leave `lastTiles` unchanged, so the plan would
  // come back full on every show. The link-up resync (`setGlassLink` → `syncOverlay`) blanks
  // for real when there is a lens.
  if (!glassLinkUp) return
  let black: Uint8Array
  try {
    black = await blackTileBytes()
  } catch (e) {
    log(`black tile encode failed: ${errText(e)} — overlay drawn over the frozen frame`)
    return
  }
  const plan = blankTilePlan(lastTiles, black, true)
  if (plan.length === 0) {
    log('tiles already blank — nothing to push')
    return
  }
  const t0 = Date.now()
  let bytes = 0
  for (const i of plan) {
    const r = await pushImage(tileContainerId(i), `tile${i}`, black)
    if (r.ok) lastTiles[i] = black
    bytes += black.length
    log(`blank ${TILE_NAMES[i] ?? i}=${r.status}/${black.length}B/${r.ms}ms`)
  }
  log(`tiles blanked: ${plan.length} push(es)/${bytes}B in ${Date.now() - t0}ms`)
}

// ── overlay transition ordering (docs/glasses.md) ──────────────────────────────────────────
// The two transitions are not symmetric, and the order within each is load-bearing:
//
//   show: stand the pump down (and wait for the in-flight push) → blank the tiles → write id 6.
//   hide: write id 6 back to ' ' → reset the diff baseline → repaint all four tiles.
//
// The blank goes between the stand-down and the text: earlier it would race an in-flight frame
// that re-lights the quadrant, later it would paint over the text. Hide needs no unblank step:
// the baseline reset re-sends the newest bytes for all four quadrants.
//
// `PlaneOps` exists so a unit test pins the ordering; production calls the same function.

export interface PlaneOps {
  /** Stop the tile pump and wait until no push is in flight. */
  standDown(): Promise<void>
  /** Push the all-black constant to every tile that is not already black, so the overlay is
   *  read on an unlit field instead of over the frozen last frame. Show only. */
  blankTiles(): Promise<void>
  /** `textContainerUpgrade` on container 6. */
  writeOverlay(content: string): Promise<void>
  /** Clear the per-tile diff baseline so every tile re-sends. Never a rebuild. */
  resetBaseline(): void
  /** Kick the pump to repaint the newest bytes per quadrant. */
  repaintTiles(): void
}

/** `content === ' '` means "hide"; anything else means "show". */
export async function applyOverlayTransition(content: string, ops: PlaneOps): Promise<void> {
  if (content !== ' ') {
    await ops.standDown()
    await ops.blankTiles()
    await ops.writeOverlay(content)
    return
  }
  await ops.standDown()
  await ops.writeOverlay(' ')
  ops.resetBaseline()
  ops.repaintTiles()
}

/** The overlay's text — everything container 6 shows. The voice dialog and the menu come first
 *  (`interactiveOverlay`); then the two notices, which only the glasses get. */
export function overlayContent(): string {
  const acted = interactiveOverlay()
  if (acted !== null) return acted
  if (availMsg !== null) return `X unavailable\n${availMsg}`
  // The pause notice, last before blank: anything above it is more urgent.
  const paused = mirrorPaused()
  // It names the control, not just the state, so the notice can be acted on.
  if (paused !== null) return `mirror paused — ${paused}\ntask / window / apps still work there`
  if (startupHint) return startupHintText(sttReady)
  return ' ' // blank again — the content container 6 was established with
}

/** The overlay text a person acts on — the voice dialog, else the menu — or null. It is also
 *  what the phone preview copies (`syncPreviewOverlay`, docs/phone-ui.md); the notices in
 *  `overlayContent` are about the lens and are not copied. The active marker is applied here,
 *  from `MenuItem.active`, rather than baked into `itemName`. */
export function interactiveOverlay(): string | null {
  // The dialog first: it is modal while up, and a double-tap cancels it rather than reaching
  // the menu underneath (`voiceGestureRoute`).
  if (voice) return voiceOverlay(voice)
  if (menuOpen) {
    // Inside a level the header is the breadcrumb. The hint says what the double-tap does
    // here, because its meaning changes with depth (`menuActionFor`).
    if (menuPath.length > 0) {
      const head = `${pathHeader(menuPath.map(p => p.label))}  (dbl=${menuPath.length > 1 ? 'up' : 'close'})`
      const rows = menuLevelRows.map((r, i) => `${i === menuSel ? '>' : ' '} ${r.label}`)
      return [head, ...rows].join('\n')
    }
    // The root list holds windows and `+ launcher` rows: "Tasks" covers both.
    // One short line: it is drawn by the firmware's text metrics on a 576px panel.
    // The page number appears only when there is more than one page.
    const pages = rootPageCount()
    const page = pages > 1 ? ` ${String(menuPage + 1)}/${String(pages)}` : ''
    const head = menuItems.length > 1 ? `Tasks${page}  (tap=go  dbl=close)` : 'Nothing to show'
    // `rootRows()`, not `menuItems`: the window rows are drawn most-recently-focused first
    // (`mruOrderItems`), and `chooseMenu` indexes the same array.
    const rows = rootRows().map(
      (it, i) => `${i === menuSel ? '>' : ' '} ${it.active ? '*' : ''}${it.itemName}`,
    )
    return [head, ...rows].join('\n')
  }
  return null
}

/** The real ops. `resetBaseline` is also where `overlayBusy` is released, so the pump only runs
 *  again once id 6 is confirmed blank, even with tiles arriving mid-transition. */
const planeOps: PlaneOps = {
  standDown: () => pumpQuiesce(),
  blankTiles: () => blankTilesForOverlay(),
  writeOverlay: content => writeOverlayText(content),
  resetBaseline: () => {
    overlayBusy = false
    setForcePending(true)
  },
  repaintTiles: () => {
    kickPump()
  },
}

/** Serialises overlay transitions so a rapid sequence can never interleave two orderings. The
 *  text writes themselves are additionally latest-wins (LatestAsyncWriter). */
let overlayTxn: Promise<void> = Promise.resolve()

export function syncOverlay(): void {
  // The menu or the voice dialog coming up retires the startup hint, whoever opened it (the
  // glasses, a phone pill, a palette): the hint must not reappear when they close.
  if (startupHint && interactiveOverlay() !== null) dismissStartupHint(false)
  renderStatus()
  syncPreviewOverlay()
  const content = overlayContent()
  // Logs the decision itself, so a failure to decide to show the overlay can be told from a
  // failure to draw it.
  log(
    content === ' '
      ? `overlay HIDE (menuOpen=${menuOpen} availDown=${availMsg !== null})`
      : `overlay SHOW (menuOpen=${menuOpen} sel=${menuSel + 1}/${menuRowCount()} availDown=${availMsg !== null})`,
  )
  // Hiding: hold the pump down until id 6 has actually gone blank (menuOpen is already false).
  if (content === ' ') overlayBusy = true
  overlayTxn = overlayTxn.catch(() => {}).then(() => applyOverlayTransition(content, planeOps))
  void overlayTxn.catch(e => {
    overlayBusy = false // never leave the pump wedged on a failed transition
    log(`overlay transition failed: ${errText(e)}`)
  })
}
