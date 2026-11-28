// pinhole-window — the glasses page: containers, establish / re-establish, link and device status,
// and `pushImage`, the one path every image push takes.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.

import type { DeviceStatus, EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { pageEstablished } from '../shared/establishPage.ts'
import {
  CONTAINER_TOTAL,
  EVENT_LAYER_ID,
  OVERLAY_LAYER_ID,
  SCREEN_H,
  SCREEN_W,
  TILE_H,
  TILE_W,
  TILES,
  tileContainerId,
  tileOrigin,
  tileZOrder,
  Z_EVENT_LAYER,
  Z_OVERLAY,
} from '../shared/geom.ts'
import { DEBUG_EVENTS, log, logForwarder } from './debugLog.ts'
import { bridge, type SdkModule, sdk } from './main.ts'
import {
  maybeShowStartupHint,
  overlayContent,
  setGlassInCase,
  setOverlaySkipLogged,
  superseded,
  syncOverlay,
} from './overlay.ts'
import { pageWarnEl, pageWarnText } from './phoneUi.ts'
import { kickPump, setForcePending } from './pump.ts'
import { applyMirrorMode } from './settings.ts'
import { renderStatus } from './statusUi.ts'
import { errText, sleep, withTimeout } from './util.ts'

// ── glasses page ───────────────────────────────────────────────────────────────────────────
// Layout (docs/glasses.md): container 1 is the full-screen transparent event-capture text
// layer, 2..5 the four 288x144 image tiles, 6 the overlay text layer. Ids and z-order are
// canonical in src/shared/geom.ts.
//
// Without `zOrderIndex` images composite above text regardless of push order, so a text overlay
// would be invisible under the tiles. `zOrderIndex` reverses that and is set on every container,
// because the SDK's rule is all-or-none.
//
// Input and overlay are separate containers: `isEventCapture:1` may live on exactly one
// container, and putting visible content on it risks changing capture behaviour
// (docs/decisions/separate-input-and-overlay-layers.md).

/** `{ zOrderIndex: n }` for every container. A spread rather than a bare field so omission stays
 *  expressible: an explicit `undefined` could reach the payload and trip the SDK's all-or-none
 *  validator. */
function z(index: number): { zOrderIndex?: number } {
  return { zOrderIndex: index }
}

/** id 1 — the transparent input-capture layer. Registered at establish with `content: ' '` and
 *  never pushed again; it takes no content parameter so that invariant is structural. */
function evLayer(): InstanceType<SdkModule['TextContainerProperty']> {
  if (!sdk) throw new Error('sdk not loaded')
  return new sdk.TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    containerID: EVENT_LAYER_ID,
    containerName: 'input',
    content: ' ',
    isEventCapture: 1,
    ...z(Z_EVENT_LAYER),
  })
}

/** id 6 — the overlay text layer. Same full-screen geometry, but `isEventCapture: 0`: it is a
 *  display surface only, so it can never interfere with gesture delivery. */
function ovLayer(): InstanceType<SdkModule['TextContainerProperty']> {
  if (!sdk) throw new Error('sdk not loaded')
  return new sdk.TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: SCREEN_W,
    height: SCREEN_H,
    borderWidth: 0,
    borderColor: 0,
    paddingLength: 0,
    containerID: OVERLAY_LAYER_ID,
    containerName: 'overlay',
    content: ' ',
    isEventCapture: 0,
    ...z(Z_OVERLAY),
  })
}

function tileObjects(): InstanceType<SdkModule['ImageContainerProperty']>[] {
  if (!sdk) throw new Error('sdk not loaded')
  const mod = sdk
  return Array.from({ length: TILES }, (_v, i) => {
    const [x, y] = tileOrigin(i)
    return new mod.ImageContainerProperty({
      xPosition: x,
      yPosition: y,
      width: TILE_W,
      height: TILE_H,
      containerID: tileContainerId(i),
      containerName: `tile${i}`,
      ...z(tileZOrder(i)),
    })
  })
}

export let established = false
let establishing = false

/** The payload every create/rebuild sends. Built fresh each time so no container instance is
 *  shared across two bridge calls. */
function pageObjects(): {
  containerTotalNum: number
  textObject: InstanceType<SdkModule['TextContainerProperty']>[]
  imageObject: InstanceType<SdkModule['ImageContainerProperty']>[]
} {
  return {
    containerTotalNum: CONTAINER_TOTAL,
    // Both text containers are registered blank; id 1 is never pushed again.
    textObject: [evLayer(), ovLayer()],
    imageObject: tileObjects(),
  }
}

/** The only `rebuildPageContainer` call site in the client (docs/glasses.md). Two callers:
 *  `establishPage()` (the mandatory follow-up rebuild that makes the created containers live)
 *  and `reestablishPage()` (the retry, which only runs while `established` is false). The frame
 *  pump, the invert flip and the overlay transitions must not call it: rebuild churn on a live
 *  page makes the right lens go black. */
async function rebuildPage(tag: string): Promise<boolean> {
  if (!sdk || !bridge) return false
  const rb = await withTimeout(
    Promise.resolve(bridge.rebuildPageContainer(new sdk.RebuildPageContainer(pageObjects()))),
    8000,
    'rebuild',
  )
  // A success return means the host accepted the payload, not that the glasses show it.
  log(
    `rebuild(${tag}) => ${String(rb)} ${rb === true ? '(accepted — not proof anything was drawn)' : '(REFUSED)'}`,
  )
  return rb === true
}

/** Decode `StartUpPageCreateResult`: 0 success · 1 invalid · 2 oversize · 3 outOfMemory.
 *  The SDK's `fromInt` maps anything out of range to `invalid`, so 1 also covers a host answer
 *  the SDK cannot parse; it is not by itself evidence that a validation rule failed. */
export function createResultLabel(c: unknown): string {
  if (c === 0) return '(accepted — not proof anything was drawn)'
  if (c === 2) return '(REFUSED: oversize — the page payload is too big)'
  if (c === 3) return '(REFUSED: outOfMemory — the glasses could not hold the page)'
  if (c === 1) return '(REFUSED: invalid — SDK validation, OR a host answer this SDK cannot parse)'
  return '(REFUSED: unknown result — not one of 0/1/2/3)'
}

/** Create the start-up page and then always rebuild it once. `createStartUpPageContainer` may
 *  be called once per glasses-UI lifetime, and on a reload the host answers 0 without making the
 *  containers live; only `rebuildPageContainer` does (src/shared/establishPage.ts). */
export async function establishPage(): Promise<boolean> {
  if (!sdk || !bridge) return false
  if (established || establishing) {
    log('establish skipped (already established)')
    return true
  }
  // `establishing` and `established` are separate: during the attempt the page is not yet
  // established, but a second entry to this function must still be refused.
  establishing = true
  try {
    return await establishOnce()
  } finally {
    establishing = false
  }
}

async function establishOnce(): Promise<boolean> {
  if (!sdk || !bridge) return false
  // The page payload is four tiles and two text containers; none depend on server state.
  const c = await withTimeout(
    Promise.resolve(
      bridge.createStartUpPageContainer(new sdk.CreateStartUpPageContainer(pageObjects())),
    ),
    8000,
    'create',
  )
  log(`create => ${c} ${createResultLabel(c)}`)
  const rb = await rebuildPage('establish')
  return markEstablished(pageEstablished(c, rb))
}

// ── when the glasses are not there at load ─────────────────────────────────────────────────
//
// A failed establish leaves `established` false and arms a retry. The retry is rebuild-only:
// `createStartUpPageContainer` may be called once per glasses-UI lifetime, and a second call
// answers 0 without making the containers live. Repeating the rebuild here does not break the
// no-rebuild rule, which protects a live page: a page that never established has no stream to
// disturb, and the retry stops the instant it succeeds.

/** First delay before retrying a failed establish, then doubling. */
export const ESTABLISH_RETRY_MIN_MS = 5000
/** The backoff ceiling while the link is up: a glass that is present and refusing. */
export const ESTABLISH_RETRY_MAX_MS = 60000
/** The ceiling while the link is down, when the user is likely reconnecting and the link check
 *  is cheap. See `scheduleReestablish`. */
export const ESTABLISH_RETRY_LINKDOWN_MAX_MS = 15000

let reestablishTimer: ReturnType<typeof setTimeout> | null = null
let reestablishDelay = ESTABLISH_RETRY_MIN_MS

/** How many establish attempts have been refused in a row. Drives the on-screen warning: one
 *  refusal at boot is ordinary, a run of them is a state the user has to be told about. */
let establishFails = 0

/** Record the outcome of an establish attempt, and arm the retry when it failed. The one place
 *  `established` is set. */
function markEstablished(ok: boolean): boolean {
  if (ok) {
    established = true
    establishFails = 0
    renderPageWarning()
    reestablishDelay = ESTABLISH_RETRY_MIN_MS
    // A page is proof of a link: this recovers a host that answers `getDeviceInfo()` with null
    // while the glasses are in fact there. The establish retry is not gated on the link so
    // that it can discover one.
    setGlassLink(true)
    // The first establish of this page load: point a first-time user at the gestures.
    maybeShowStartupHint()
    return true
  }
  established = false
  establishFails++
  renderPageWarning()
  scheduleReestablish()
  return false
}

/** The phone's warning bar for a missing link or a page that will not establish. The no-page
 *  text shows only when it is the real explanation: the link is up and at least two attempts
 *  have failed (the first refusal at boot can be a race with the bridge). It clears by itself
 *  once a page exists. */
export function renderPageWarning(): void {
  const el = pageWarnEl
  const txt = pageWarnText
  if (!el || !txt) return
  // The link first: a disconnected glass must be visible outside the folded connection panel.
  const linkDown = !glassLinkUp && !superseded
  const noPage = !established && establishFails >= 2 && glassLinkUp && !superseded
  // The stuck state: no link and no page after enough tries to rule out a slow start.
  const stuck = linkDown && !established && establishFails >= 2
  el.style.display = linkDown || noPage ? 'flex' : 'none'
  if (linkDown) {
    // In the stuck state the Even App reports "no device" while the glasses may show themselves
    // connected: the app's record of the device is stale, and its connection screen cannot be
    // reached while this app is in the foreground. Leaving the app, from the phone, is the lever.
    txt.textContent = stuck
      ? // Only the steps, and hedged: a reload is not known to never help.
        'the Even App has lost the glasses — a reload probably will not help. Quit pinhole-window' +
        ' from the phone, reconnect them in the Even App, then start it again; the glasses' +
        ' may need a reboot.'
      : 'the glasses are not connected — nothing is being sent to them. This screen re-checks' +
        ' every few seconds and picks up by itself. The phone still works: task / window / apps.'
    return
  }
  if (!noPage) return
  // A reload is named first: `create` may be called once per glasses-UI lifetime, so this page
  // has only `rebuild` left, while a fresh page load gets a fresh `create`.
  txt.textContent =
    `the glasses refused to make a page (${String(establishFails)} attempts).` +
    ' That is what a glass that is not connected looks like. Reconnect them, then reload' +
    ' this screen — a fresh screen gets a fresh attempt.'
}

function scheduleReestablish(): void {
  // `superseded` first: a superseded page must not keep retrying into glasses another instance
  // owns.
  if (superseded || established || reestablishTimer !== null || !sdk || !bridge) return
  // A shorter cap while the link is down: the ladder is then waiting for one cheap fact that
  // `refreshDeviceStatus` can ask for in milliseconds.
  const cap = glassLinkUp ? ESTABLISH_RETRY_MAX_MS : ESTABLISH_RETRY_LINKDOWN_MAX_MS
  const delay = Math.min(reestablishDelay, cap)
  reestablishDelay = Math.min(reestablishDelay * 2, cap)
  log(`page not established — retrying the rebuild in ${String(Math.round(delay / 1000))}s`)
  reestablishTimer = setTimeout(() => {
    reestablishTimer = null
    attemptReestablish()
  }, delay)
}

let reestablishBusy = false

/** One attempt, with its failure handled. The rejection is caught rather than `void`-ed
 *  (`rebuildPage` throws on its 8 s timeout), and the catch re-arms the retry ladder. */
function attemptReestablish(): void {
  // Re-entrancy guard: an attempt can flip the link up from inside itself
  // (`refreshDeviceStatus` → `onDeviceStatus` → `setGlassLink(true)` → `reestablishNow`), which
  // would otherwise start a second attempt on top of this one.
  if (reestablishBusy) return
  reestablishBusy = true
  void reestablishPage()
    .catch(e => {
      log(`re-establish failed: ${errText(e)}`)
      scheduleReestablish()
    })
    .finally(() => {
      reestablishBusy = false
    })
}

/** Try again now, with the backoff reset. The link coming back is the one event that changes
 *  the answer, so it must not wait out a backoff timer. */
function reestablishNow(why: string): void {
  if (established || superseded || !sdk || !bridge) return
  if (reestablishTimer !== null) {
    clearTimeout(reestablishTimer)
    reestablishTimer = null
  }
  reestablishDelay = ESTABLISH_RETRY_MIN_MS
  log(`re-establish now — ${why}`)
  attemptReestablish()
}

/** Pull the pending retry forward to the minimum delay. Only ever makes an existing ladder
 *  fire sooner; it never starts one. */
function reestablishSooner(): void {
  if (established || superseded || reestablishTimer === null) return
  clearTimeout(reestablishTimer)
  reestablishTimer = null
  reestablishDelay = ESTABLISH_RETRY_MIN_MS
  scheduleReestablish()
}

/** A page has just become live with container 6 blank (`ovLayer`), so whatever the overlay
 *  should show is stated again. Called from both places a page comes to life: the boot establish
 *  and the retry (`reestablishPage`). */
export function restateOverlayOnNewPage(): void {
  if (overlayContent() !== ' ') syncOverlay()
}

async function reestablishPage(): Promise<void> {
  if (established || !sdk || !bridge) return
  // Ask the host for the link state first (`refreshDeviceStatus`); the event stream may never
  // report a glass that came back.
  if (!glassLinkUp) await refreshDeviceStatus('retry')
  const rb = await rebuildPage('re-establish')
  if (!markEstablished(rb)) return
  log('page established on a retry — the glasses were not reachable when it loaded')
  // The new page's text container is blank, and the link-up resync ran before this page
  // existed, so the overlay is re-stated here.
  restateOverlayOnNewPage()
  // The containers have only just become live, so the diff baseline describes nothing on the
  // glass.
  setForcePending(true)
  kickPump()
}

// ── the glasses link (DeviceConnectType) ───────────────────────────────────────────────────
//
// `bridge` only says there is an Even App to talk to; this tracks whether the glasses are on
// the other end. Without it a dropped link costs a derive, an encode and a ~34 s push ladder
// per tile at the full frame rate.
//
// The default is "reachable": the state only moves on a host event, so an Even App that never
// sends one keeps the mirror on. Only `disconnected` and `connectionFailed` count as down;
// `connecting` and `none` are transient and leave the verdict alone. A reconnect resets the
// diff baseline and never rebuilds (docs/glasses.md).

/** Pure: a `DeviceStatus.connectType` → is the bridge worth pushing to? `null` means "no
 *  opinion, keep the current verdict" (`connecting`, `none`, anything the SDK does not name). */
export function pushableFromConnectType(raw: unknown): boolean | null {
  if (raw === 'connected') return true
  if (raw === 'disconnected' || raw === 'connectionFailed') return false
  return null
}

/** Is the glasses link believed to be up? Starts true (see the section note above). */
export let glassLinkUp = true
/** The SN `getDeviceInfo()` reported for the glasses, or null when it could not be read. */
let glassSn: string | null = null

function setGlassLink(up: boolean): void {
  if (glassLinkUp === up) return
  glassLinkUp = up
  // The mirror mode follows in both directions: green is derived inside the pump, which is
  // what stands down here (see `effectiveMirrorMode`).
  applyMirrorMode()
  renderPageWarning() // "reboot the glasses" is only advice while they are reachable
  renderStatus()
  if (!up) {
    log(
      'glasses link DOWN — pump stands down and image pushes are refused' +
        ' (nothing is listening, and the ladder costs ~34s a tile)',
    )
    flushLogNow()
    return
  }
  log(
    `glasses link UP — diff baseline reset, tiles flowing again (page=${established ? 'established' : 'no'})`,
  )
  flushLogNow()
  // No page yet: this is the moment to try again (see `reestablishNow`).
  if (!established) reestablishNow('the glasses link came back')
  setForcePending(true)
  kickPump()
  // Overlay writes are skipped while the link is down (`writeOverlayText`), so send the current
  // one now: a dialog, a menu, or a blank that clears a dialog closed in the meantime.
  setOverlaySkipLogged(false)
  syncOverlay()
}

/** Push the forwarded log to the server now instead of on its 700 ms timer, for lines that may
 *  be the last ones: the host app can die right after a BLE transition, taking the queue with
 *  it. Inert without `?debug=1`. */
export function flushLogNow(): void {
  void logForwarder.flush()
}

/** One device status from the host. Logged on change and acted on narrowly. */
export function onDeviceStatus(s: DeviceStatus): void {
  // The ring is a device too (`DeviceModel.Ring1`) and reports on this callback, so events are
  // filtered by the glasses' SN from `getDeviceInfo()`. When that lookup produced nothing,
  // every status is acted on rather than none.
  const sn = typeof s?.sn === 'string' ? s.sn : ''
  // An empty SN is not a foreign device: the status that follows a disconnect carries no sn,
  // and dropping it would keep the link down forever. Only a status naming a different device
  // is dropped.
  if (glassSn !== null && sn !== '' && sn !== glassSn) {
    // Logged once per foreign sn; every time under `?debug=1`.
    if (!otherDeviceSns.has(sn) || DEBUG_EVENTS) {
      otherDeviceSns.add(sn)
      log(`device status from sn=${sn} — not the glasses (${glassSn}), ignored`)
    }
    return
  }
  // One line per change (a status also arrives when the battery ticks). `isWearing`,
  // `batteryLevel` and `isCharging` are logged and not acted on: `isWearing` is unreliable on
  // hardware (see the note above `lensOn`).
  const line =
    `device: ${String(s?.connectType ?? '?')}` +
    ` battery=${s?.batteryLevel === undefined ? '?' : String(s.batteryLevel) + '%'}` +
    (s?.isCharging ? ' charging' : '') +
    ` wearing=${s?.isWearing === undefined ? '?' : String(s.isWearing)}` +
    (s?.isInCase ? ' in-case' : '')
  if (line !== lastDeviceLine) {
    lastDeviceLine = line
    log(line)
  }
  // Under `?debug=1` an unchanged status is logged too, so a quiet log means silence on the wire.
  else if (DEBUG_EVENTS) log(`${line} (unchanged)`)
  const up = pushableFromConnectType(s?.connectType)
  if (up !== null) setGlassLink(up)
  // `connecting` is not a verdict on the link (see `pushableFromConnectType`), only a hint that
  // the answer may change within seconds, so the pending retry is pulled forward.
  if (s?.connectType === 'connecting') reestablishSooner()
  // `=== true` only: `undefined` is "not in the case", because absence of evidence must not
  // pause the lens, and a `disconnected` record carries stale fields.
  setGlassInCase(s?.isInCase === true)
}

let lastDeviceLine = ''
const otherDeviceSns = new Set<string>()

/** Ask the host directly. The status stream cannot be relied on while the link is down (it can
 *  go silent after `connecting`), while `getDeviceInfo()` is a host IPC (~5 ms), not a BLE round
 *  trip, so the retry ladder can poll it freely. */
async function refreshDeviceStatus(tag: string): Promise<void> {
  if (!bridge) return
  try {
    const info = await withTimeout(Promise.resolve(bridge.getDeviceInfo()), 3000, 'deviceInfo')
    if (!info) {
      log(`deviceInfo (${tag}): still no device`)
      return
    }
    if (info.status) onDeviceStatus(info.status)
    else log(`deviceInfo (${tag}): a device with no status`)
  } catch (e) {
    log(`deviceInfo (${tag}) failed: ${errText(e)}`)
  }
}

/** Read the current status once, at boot, so a phone that opens the app with the glasses away
 *  does not spend an establish and a first drain discovering it. Non-fatal: every failure
 *  leaves the link at its default of "reachable". */
export async function seedDeviceStatus(br: EvenAppBridge): Promise<void> {
  let info: Awaited<ReturnType<EvenAppBridge['getDeviceInfo']>> = null
  try {
    info = await withTimeout(Promise.resolve(br.getDeviceInfo()), 3000, 'deviceInfo')
  } catch (e) {
    log(`deviceInfo failed: ${errText(e)} — the link state starts at "reachable"`)
    return
  }
  // "No device" from the host is evidence, unlike no answer at all, so the link starts down.
  // Not a one-way door: `markEstablished(true)` sets it back up if the establish retry succeeds.
  if (!info) {
    log(
      'deviceInfo: no device — treating the link as DOWN (the establish retry can still find one)',
    )
    setGlassLink(false)
    return
  }
  // The model by string, not `isGlasses()`: this object may have come through
  // `DeviceInfo.fromJson`, and a missing method would throw.
  const model = String(info.model ?? '?')
  const sn = typeof info.sn === 'string' ? info.sn : ''
  if ((model === 'g1' || model === 'g2') && sn) glassSn = sn
  log(
    `device info: model=${model} sn=${sn || '(none)'}` +
      (glassSn === null ? ' — not identified as glasses, so every status event is acted on' : ''),
  )
  if (info.status) onDeviceStatus(info.status)
}

// The rate limiter of the whole app: a push costs ~75 ms + 0.038 ms/byte (~26 KB/s) on a G2 at
// SDK 0.0.16 (docs/notes/2026-10-tile-transfer-timing.md). The ladder is sized for the
// absent-glass case: 4 attempts, 8 s each, 500 ms gaps, so a push fails after up to ~34 s.
interface PushResult {
  ok: boolean
  status: string
  attempts: number
  ms: number
}

export async function pushImage(id: number, name: string, bytes: Uint8Array): Promise<PushResult> {
  const t0 = Date.now()
  if (!sdk || !bridge) return { ok: false, status: 'nobridge', attempts: 0, ms: 0 }
  // Refused here, in the one place every image push passes through, so no caller can route
  // round it: the ladder is ~34 s per tile.
  if (!glassLinkUp) return { ok: false, status: 'linkdown', attempts: 0, ms: 0 }
  // No page, no push: an image into a container that was never made live cannot paint. (The
  // overlay text path does push before the establish, deliberately.)
  if (!established) return { ok: false, status: 'nopage', attempts: 0, ms: 0 }
  // A page that has been superseded does not touch the bridge again (`standDownSuperseded`).
  if (superseded) return { ok: false, status: 'superseded', attempts: 0, ms: 0 }
  const mod = sdk,
    br = bridge
  let last = ''
  for (let a = 1; a <= 4; a++) {
    // Abandon a ladder the link fell out of: the gate above only covers pushes that had not
    // started, and retrying `updateImageRawData` into a disconnected bridge has no value.
    if (!glassLinkUp) {
      return {
        ok: false,
        status: `linkdown(abandoned after ${String(a - 1)})`,
        attempts: a - 1,
        ms: Date.now() - t0,
      }
    }
    last = String(
      await withTimeout(
        Promise.resolve(
          br.updateImageRawData(
            new mod.ImageRawDataUpdate({
              containerID: id,
              containerName: name,
              imageData: bytes,
            }),
          ),
        ),
        8000,
        name,
      ).catch(e => `err(${errText(e)})`),
    )
    if (last === 'success') {
      return {
        ok: true,
        status: a > 1 ? `success(retry${a})` : 'success',
        attempts: a,
        ms: Date.now() - t0,
      }
    }
    if (a < 4) await sleep(500)
  }
  return { ok: false, status: last || 'fail', attempts: 4, ms: Date.now() - t0 }
}
