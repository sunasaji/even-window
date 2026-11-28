// The glasses link gate: what a dropped BLE link does to the client
// (docs/decisions/glasses-link-gating.md).
//
// Two pure decisions are pinned, both asymmetric on purpose:
//   * `pushableFromConnectType`: only the two explicit failure states stand the pump down;
//     everything else, including `connecting`, leaves the verdict alone.
//   * `effectiveMirrorMode`: green is derived inside the pump, so with the pump down the
//     preview is pinned to colour.
// The rest are source assertions that the gates sit where no caller can route round them.

import { describe, expect, it } from 'vitest'
import { effectiveMirrorMode } from '../src/client/flags.ts'
import { pushableFromConnectType } from '../src/client/glassPage.ts'
import { clientSource } from './helpers/source.ts'

/** `DeviceConnectType` from the SDK, restated: importing the SDK under node touches `window`.
 *  A new SDK state has to be given a meaning here. */
const CONNECT_TYPES = [
  'none',
  'connecting',
  'connected',
  'disconnected',
  'connectionFailed',
] as const

describe('pushableFromConnectType — three answers, not two', () => {
  it('only `connected` is a yes', () => {
    expect(pushableFromConnectType('connected')).toBe(true)
  })

  it('the two explicit failures are a no', () => {
    expect(pushableFromConnectType('disconnected')).toBe(false)
    expect(pushableFromConnectType('connectionFailed')).toBe(false)
  })

  it('`connecting` and `none` have no opinion: they must not stand the pump down', () => {
    // Pushing at a glass on its way back costs a few hundred ms; reading a transient state as
    // "down" freezes the mirror if the host then goes quiet. `null` keeps the current verdict.
    expect(pushableFromConnectType('connecting')).toBeNull()
    expect(pushableFromConnectType('none')).toBeNull()
  })

  it('anything unrecognised also has no opinion (absence of evidence is not evidence)', () => {
    for (const v of [undefined, null, '', ' connected ', 'CONNECTED', 'ok', 0, 1, true, {}, []]) {
      expect(pushableFromConnectType(v)).toBeNull()
    }
  })

  it('every state this SDK names gets a deliberate answer', () => {
    const verdicts = CONNECT_TYPES.map(t => pushableFromConnectType(t))
    expect(verdicts).toEqual([null, null, true, false, false])
  })
})

describe('effectiveMirrorMode — green needs the pump', () => {
  it('a live pump draws what the user picked', () => {
    expect(effectiveMirrorMode('green', true)).toBe('green')
    expect(effectiveMirrorMode('color', true)).toBe('color')
  })

  it('a pump that is standing down pins the preview to colour', () => {
    // The green plane is written at dequeue, so with the pump gated off it would hold a stale frame.
    expect(effectiveMirrorMode('green', false)).toBe('color')
    expect(effectiveMirrorMode('color', false)).toBe('color')
  })

  it('is a pure view of the choice: it never mutates it, so the mode comes back', () => {
    const chosen = 'green' as const
    effectiveMirrorMode(chosen, false)
    expect(effectiveMirrorMode(chosen, true)).toBe('green')
  })
})

describe('where the gate is placed', () => {
  it('`pushImage` refuses before the ladder, in the one place every image push passes', () => {
    const src = clientSource()
    const body = src.fn('pushImage')
    // The refusal must be ahead of the retry loop.
    expect(body.indexOf("status: 'linkdown'")).toBeGreaterThan(-1)
    expect(body.indexOf("status: 'linkdown'")).toBeLessThan(body.indexOf('for (let a = 1; a <= 4'))
    // There is exactly one `updateImageRawData` call site, so no second pusher bypasses the gate.
    expect(src.count('updateImageRawData(new')).toBe(1)
  })

  it('the pump gates too, so the derive and the PNG encode are not paid either', () => {
    const src = clientSource()
    expect(
      src.has('if (pumping || !bridge || !glassLinkUp || !established || superseded) return'),
    ).toBe(true)
  })

  it('no page, no image push: a container that was never made live cannot paint', () => {
    // A push into a page that was never established runs into multi-second timeouts.
    const src = clientSource()
    const body = src.fn('pushImage')
    expect(body.has("status: 'nopage'")).toBe(true)
    expect(body.indexOf("status: 'nopage'")).toBeLessThan(body.indexOf('for (let a = 1; a <= 4'))
    // The overlay text path keeps its pre-establish push, which is deliberate and logged.
    expect(src.has('[pre-establish, expected]')).toBe(true)
  })

  it('a page that establishes is proof of a link, which balances "no device means down"', () => {
    const src = clientSource()
    expect(src.fn('markEstablished').has('setGlassLink(true)')).toBe(true)
    // So `getDeviceInfo() === null` can be taken as evidence without becoming one-way.
    expect(src.fn('seedDeviceStatus').has('setGlassLink(false)')).toBe(true)
  })

  it('the re-establish retry catches its own rejection and re-arms', () => {
    // `rebuildPage` throws on its timeout; an uncaught rejection would end the retry ladder.
    const src = clientSource()
    const body = src.fn('attemptReestablish')
    expect(body.has('void reestablishPage()')).toBe(true)
    expect(body.has('scheduleReestablish()')).toBe(true)
    // One attempt body, two callers: the timer and the link coming back.
    expect(src.count('attemptReestablish()')).toBe(3) // def + 2 callers
  })

  it('an attempt cannot re-enter itself when it discovers the link mid-flight', () => {
    // `refreshDeviceStatus` → `onDeviceStatus` → `setGlassLink(true)` → `reestablishNow` leads
    // from inside an attempt back to the top of one.
    const src = clientSource()
    const body = src.fn('attemptReestablish')
    expect(body.has('if (reestablishBusy) return')).toBe(true)
    expect(body.has('reestablishBusy = true')).toBe(true)
    expect(body.has('.finally(() => { reestablishBusy = false })')).toBe(true)
  })

  it('the retry re-reads the device, because the status stream goes quiet', () => {
    // After Bluetooth returns the host can report `connecting`, then `none`, then nothing; a
    // client waiting for a `connected` event would wait forever.
    const src = clientSource()
    const body = src.fn('reestablishPage')
    expect(body.has("if (!glassLinkUp) await refreshDeviceStatus('retry')")).toBe(true)
    // It asks before the rebuild, or the answer arrives one attempt too late.
    expect(body.indexOf('refreshDeviceStatus')).toBeLessThan(body.indexOf('rebuildPage'))
  })

  it('`connecting` pulls the retry forward without changing the verdict', () => {
    // Timing only: the link verdict is untouched (`pushableFromConnectType('connecting')` is null).
    const src = clientSource()
    expect(
      src.fn('onDeviceStatus').has("if (s?.connectType === 'connecting') reestablishSooner()"),
    ).toBe(true)
    const body = src.fn('reestablishSooner')
    // It never starts a ladder; it only makes a running one look sooner.
    expect(body.has('reestablishTimer === null) return')).toBe(true)
    expect(body.has('reestablishDelay = ESTABLISH_RETRY_MIN_MS')).toBe(true)
  })

  it('backs off less while the link is the thing being waited for', () => {
    const src = clientSource()
    const body = src.fn('scheduleReestablish')
    expect(body.has('glassLinkUp ? ESTABLISH_RETRY_MAX_MS : ESTABLISH_RETRY_LINKDOWN_MAX_MS')).toBe(
      true,
    )
  })

  it('the link coming back retries immediately instead of waiting out the backoff', () => {
    // Otherwise a reconnect waits out a backoff of up to a minute with a dead lens.
    const src = clientSource()
    const body = src.fn('setGlassLink')
    expect(body.has("if (!established) reestablishNow('the glasses link came back')")).toBe(true)
    const now = src.fn('reestablishNow')
    expect(now.has('reestablishDelay = ESTABLISH_RETRY_MIN_MS')).toBe(true) // backoff reset
    expect(now.has('clearTimeout(reestablishTimer)')).toBe(true) // no double attempt
    // It cannot recurse: `markEstablished(true)` sets `established` before calling
    // `setGlassLink(true)`, and this returns early on an established page.
    expect(now.has('if (established || superseded')).toBe(true)
  })

  it('the link gate is not folded into overlayActive(): the two mean different things', () => {
    // An overlay owns the plane while the glass is still listening; a dead link means do not
    // touch the bridge at all.
    const src = clientSource()
    const body = src.fn('overlayActive')
    expect(body.has('glassLinkUp')).toBe(false)
    // The lens pause does ride the overlay path: it draws a notice on a glass that is listening.
    expect(body.has('mirrorPaused()')).toBe(true)
  })

  it('the link state has one writer, and nothing infers it from a failed push', () => {
    const src = clientSource()
    expect(src.has('let glassLinkUp = true')).toBe(true)
    // A push can fail for reasons unrelated to the link, so inferring from one would flap.
    expect(src.count(/glassLinkUp=(?!=)/)).toBe(2) // the initialiser + setGlassLink
    // The definition plus three callers, counted over code only: the status handler, the boot
    // seed's "no device", and a successful establish.
    expect(src.code().count('setGlassLink(')).toBe(4)
    // `onDeviceStatus` is the only interpreter of a status; the event stream, the re-read and
    // the boot seed all funnel into it.
    expect(src.code().count('onDeviceStatus(')).toBeGreaterThanOrEqual(3)
    expect(src.count('pushableFromConnectType(')).toBe(2) // def + onDeviceStatus
  })

  it('both link transitions flush the forwarded log immediately', () => {
    // The host can die right after a BLE transition, taking a batched log queue with it.
    const src = clientSource()
    const body = src.fn('setGlassLink')
    expect(body.count('flushLogNow()')).toBe(2)
  })

  it('a reconnect resets the diff baseline and never rebuilds', () => {
    const src = clientSource()
    const body = src.fn('setGlassLink')
    expect(body.has('setForcePending(true)')).toBe(true)
    expect(body.has('kickPump()')).toBe(true)
    expect(body.has('rebuildPage')).toBe(false)
    expect(body.has('establishPage')).toBe(false)
  })

  it('the mirror follows the link in both directions without the user touching anything', () => {
    const src = clientSource()
    expect(src.fn('setGlassLink').has('applyMirrorMode()')).toBe(true)
    // `applyMirrorMode` is the only writer of the effective mode.
    expect(src.count(/mirrorMode=(?!=)/)).toBe(1)
  })

  it("the glasses microphone is not asked for while the link is down: the phone's is", () => {
    // The mic is chosen from the link verdict once, at start (`voiceMicFor`).
    const src = clientSource()
    const body = src.fn('voiceStart').between('async function voiceStart', 'audioControl(true')
    expect(body.has('voiceMicFor(glassLinkUp)')).toBe(true)
    expect(body.has('sdk.AudioInputSource.Phone')).toBe(true)
    expect(body.has("newVoiceState('opening', mic)")).toBe(true)
  })

  it('no overlay write or blanking push while the link is down', () => {
    const src = clientSource()
    expect(
      src
        .fn('writeOverlayText')
        .between('function writeOverlayText', 'textContainerUpgrade(new')
        .has('if (!glassLinkUp)'),
    ).toBe(true)
    expect(
      src
        .fn('blankTilesForOverlay')
        .between('async function blankTilesForOverlay', 'blackTileBytes()')
        .has('if (!glassLinkUp) return'),
    ).toBe(true)
  })

  it('a page that comes to life is told what the overlay holds: it was created blank', () => {
    // On the retry path the link-up resync runs before the rebuild, so an overlay that was up
    // while the page did not exist has to be restated once the page exists.
    const src = clientSource()
    const helper = src.fn('restateOverlayOnNewPage')
    expect(helper.has("if (overlayContent() !== ' ') syncOverlay()")).toBe(true)
    const retry = src.fn('reestablishPage')
    const ok = retry.indexOf('if (!markEstablished(rb)) return')
    expect(ok).toBeGreaterThan(-1)
    expect(retry.indexOf('restateOverlayOnNewPage()')).toBeGreaterThan(ok) // only once the page exists
    expect(retry.indexOf('restateOverlayOnNewPage()')).toBeLessThan(retry.indexOf('kickPump()'))
    // The boot establish uses the same call.
    const boot = src.fn('boot')
    expect(boot.has('restateOverlayOnNewPage()')).toBe(true)
    expect(boot.has('if (mirrorPaused() !== null) syncOverlay()')).toBe(false)
  })

  it('the lens is brought up to date when the link returns: it missed every write', () => {
    const src = clientSource()
    const up = src.fn('setGlassLink')
    // After the `if (!up) … return`, i.e. on the way up only.
    expect(up.indexOf('if (!up)')).toBeGreaterThan(-1)
    expect(up.indexOf('syncOverlay()')).toBeGreaterThan(up.indexOf('if (!up)'))
  })

  it('a device status from another SN (the ring) is ignored, not acted on', () => {
    const src = clientSource()
    const body = src.fn('onDeviceStatus')
    expect(body.has("glassSn !== null && sn !== '' && sn !== glassSn")).toBe(true)
  })

  it('an empty sn is accepted: the hardware sends one right after a disconnect', () => {
    // The status following `disconnected` carries no sn; dropping it would hide the link coming
    // back. A ring has an sn of its own, so the filter still excludes it.
    const src = clientSource()
    const body = src.fn('onDeviceStatus')
    expect(body.has("sn !== ''")).toBe(true)
  })

  it('a ladder the link fell out of is abandoned, not walked to the end', () => {
    // The entry gate only covers pushes that had not started; one already inside the ladder
    // would otherwise keep calling into a dead BLE stack.
    const src = clientSource()
    const body = src.fn('pushImage')
    const loop = body.indexOf('for (let a = 1; a <= 4')
    const check = body.indexOf('if (!glassLinkUp) {', loop)
    expect(loop).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(loop)
    expect(check).toBeLessThan(body.indexOf('withTimeout', loop))
    expect(body.has('linkdown(abandoned after ')).toBe(true)
  })

  it('a drain that started before the drop stops deriving and encoding', () => {
    const src = clientSource()
    const body = src.fn('pumpTiles')
    const mid = body.indexOf("pumpHalt('mid-drain')")
    const gate = body.indexOf('if (!glassLinkUp) break')
    expect(mid).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(mid)
    // It is ahead of the dequeue, so the derive and encode are not paid.
    expect(gate).toBeLessThan(body.indexOf('const i = pickTile'))
  })
})

// ── pausing the lens (docs/glasses.md) ─────────────────────────────────────────────────────
//
// The pause reuses the text overlay; these cases pin which reason uses which path.

describe('the lens pause rides the overlay path, not a second one', () => {
  const src = clientSource()

  it('is a notice + blanked tiles, which is the lowest-power thing the panel can show', () => {
    // Black is no emission on this panel, and the show transition blanks the tiles under the notice.
    const body = src.fn('overlayContent')
    expect(body.has('mirrorPaused()')).toBe(true)
    expect(body.has('mirror paused')).toBe(true)
    // It is the last branch before blank: everything above it is more urgent.
    expect(body.indexOf('availMsg !== null')).toBeGreaterThan(-1)
    expect(body.indexOf('availMsg !== null')).toBeLessThan(body.indexOf('const paused'))
  })

  it('never rebuilds, and never pushes outside the serialised transition', () => {
    const body = src.fn('setLensOn')
    expect(body.has('syncOverlay()')).toBe(true)
    expect(body.has('rebuildPage')).toBe(false)
    expect(body.has('pushImage')).toBe(false)
    expect(body.has('updateImageRawData')).toBe(false)
    // The hide transition owns the baseline reset and the repaint (`planeOps`).
    expect(body.has('forcePending')).toBe(false)
    expect(body.has('setForcePending')).toBe(false)
    expect(body.has('kickPump')).toBe(false)
  })

  it('names the pause in the status bits', () => {
    expect(src.has("...(lensOn ? [] : ['lens=off'])")).toBe(true)
  })

  it('defaults to a live lens', () => {
    expect(src.has('let lensOn = true')).toBe(true)
  })

  it('`isWearing` pauses nothing: the sensor is wrong in both directions', () => {
    // The wear sensor reports stale and wrong values in both directions on a G2, so it is
    // logged and gates nothing. The symbols are named so that re-wiring it is a visible change.
    expect(src.has('setGlassWorn')).toBe(false)
    expect(src.has('glassWorn')).toBe(false)
    expect(src.has('wearTrust')).toBe(false)
    expect(src.has('glass=notworn')).toBe(false)
    // Still read and logged.
    expect(src.has('wearing=')).toBe(true)
    // The lens pauses for the user's latch and for the case, never for `isWearing`.
    const body = src.fn('mirrorPaused')
    expect(body.has("if (!lensOn) return 'lens:off on the phone'")).toBe(true)
    expect(body.has('if (glassInCase)')).toBe(true)
    expect(body.has('Worn')).toBe(false)
  })

  it('`isInCase` does pause it', () => {
    // `isInCase` is reliable in both directions on a G2. The link stays `connected` in the
    // case, so nothing else would stop the pump.
    expect(src.has('let glassInCase = false')).toBe(true)
    expect(src.has('setGlassInCase(s?.isInCase === true)')).toBe(true) // undefined is not in-case
    expect(src.has("...(glassInCase ? ['glass=in-case'] : [])")).toBe(true)
  })

  it('the case pause is overridable in one press, and the button says which press it is', () => {
    // The label names the state the button acts on: off / case / on.
    expect(src.fn('lensLabel').has("!lensOn ? 'off' : glassInCase ? 'case' : 'on'")).toBe(true)
    expect(src.has('if (lensOn && glassInCase) { overrideCase(); return }')).toBe(true)
    const body = src.fn('overrideCase')
    expect(body.has('caseTrust = false')).toBe(true) // and the sensor is distrusted for this session
    // The sensor path honours it.
    expect(src.fn('setGlassInCase').has('if (!caseTrust || glassInCase === v) return')).toBe(true)
  })

  it('the notice names the control that paused it, so it can be undone', () => {
    const body = src.fn('overlayContent')
    expect(body.has('mirror paused — ${paused}')).toBe(true)
    expect(src.has("'lens:off on the phone'")).toBe(true)
  })

  it('the latch is not persisted: a dark lens must not survive a reload unexplained', () => {
    const body = src.fn('setLensOn')
    expect(body.has('localStorage')).toBe(false)
    expect(src.has("'pw.lens'")).toBe(false)
  })

  it('the pause does not stop the phone: no palette or input path consults it', () => {
    // `task` / `window` / `apps` keep working while the lens is paused.
    for (const fn of ['openTaskPalette', 'openWindowPalette', 'openAppsPalette', 'runRowToken']) {
      expect(src.fn(fn).has('lensOn'), fn).toBe(false)
    }
  })
})

// ── standing down for a newer instance (docs/decisions/glasses-instance-supersede.md) ──────
//
// The server decides (tests/server.instances.test.ts, tests/server.supersede.test.ts); these
// pin what the superseded page does. It must release every bridge path.

describe('a superseded instance stands down completely', () => {
  const src = clientSource()
  const fn = (name: string) => src.fn(name)

  it('sends its instance id on the stream, alongside the ticket', () => {
    // `EventSource` cannot set headers. The id is not a credential; it identifies this page load.
    expect(src.has('const INSTANCE_ID = ')).toBe(true)
    expect(src.has('`?inst=${encodeURIComponent(INSTANCE_ID)}`')).toBe(true)
  })

  it('closes the stream and refuses to re-open it', () => {
    const body = fn('standDownSuperseded')
    expect(body.has('stopStream()')).toBe(true)
    // The EventSource retry path is gated too.
    expect(fn('startStreamAsync').has('if (superseded) return')).toBe(true)
  })

  it('gates every path that can reach the bridge', () => {
    expect(src.has('|| !established || superseded) return')).toBe(true) // the pump
    expect(src.has("status: 'superseded'")).toBe(true) // pushImage
    expect(fn('scheduleReestablish').has('superseded')).toBe(true) // the rebuild ladder
    const voice = src.fn('voiceStart').between('async function voiceStart', 'audioControl(true')
    expect(voice.has('superseded')).toBe(true) // the glasses mic
  })

  it('never exits the app: that would take the winner down with it', () => {
    // `shutDownPageContainer` exits the Even App, and the new instance runs inside the same one.
    expect(fn('standDownSuperseded').has('shutDownPageContainer')).toBe(false)
    expect(fn('showSupersededOverlay').has('shutDownPageContainer')).toBe(false)
  })

  it('says so on the screen, not only in the log', () => {
    // The screen appears without user action, so it explains itself and offers a reload.
    const body = fn('showSupersededOverlay')
    expect(body.has('another instance owns the glasses')).toBe(true)
    expect(body.has('location.reload()')).toBe(true)
    expect(fn('standDownSuperseded').has('showSupersededOverlay(by)')).toBe(true)
    expect(src.has("...(superseded ? ['SUPERSEDED'] : [])")).toBe(true) // the status bits
  })

  it('is one-way: nothing but a reload clears it', () => {
    expect(src.count('superseded = true')).toBe(1)
    // The initialiser is the only other assignment: nothing turns the flag back off.
    expect(src.count('superseded = false')).toBe(1)
    expect(src.has('let superseded = false')).toBe(true)
    expect(fn('standDownSuperseded').has('if (superseded) return')).toBe(true)
  })

  it('flushes the log immediately: the next thing to happen may be nothing', () => {
    expect(fn('standDownSuperseded').has('flushLogNow()')).toBe(true)
  })
})

describe('a page that cannot be made says so where it will be read', () => {
  const src = clientSource()

  it('is shown above the preview, not inside a fold', () => {
    // Inside the collapsed `▶ connection` panel the warning would go unseen.
    const mount = src.fn('mountUi')
    const at = mount.indexOf('pageWarnEl = document.createElement')
    const title = mount.indexOf('ui.appendChild(titleRow)')
    expect(title).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(title)
    // The preview is the mirror canvas, the first thing the preview section makes.
    expect(at).toBeLessThan(mount.indexOf("mirrorEl = document.createElement('canvas')"))
  })

  it('names the cure, because nobody guesses it from a blank lens', () => {
    const body = src.fn('renderPageWarning')
    // With a live link and a refused page, a fresh page load is the cheapest thing to try:
    // `create` is once per glasses-UI lifetime and this page has spent its attempt.
    expect(body.has('Reconnect them, then reload')).toBe(true)
  })

  it('the stuck bar has no buttons: neither a reload nor an exit clears the state', () => {
    // A reload meets the same `create => 1` because the dead record lives in the host, and
    // `shutDownPageContainer` is refused or accepted without effect in this state.
    expect(src.has('pageWarnBtn')).toBe(false)
    expect(src.has('pageWarnExit')).toBe(false)
    expect(src.has('exitArmed')).toBe(false)
  })

  it('`shutDownPageContainer` has one caller: the double-tap at the server list', () => {
    const code = src.code()
    expect(code.count('bridge.shutDownPageContainer(')).toBe(1)
    expect(code.has('bridge.shutDownPageContainer(1)')).toBe(true)
    expect(src.count('exitApp()')).toBe(2) // the definition + root.ts
  })

  it('the stuck text names the recovery steps, in order', () => {
    const body = src.fn('renderPageWarning')
    expect(body.has('const stuck = linkDown && !established && establishFails >= 2')).toBe(true)
    // Fragments, because the string is wrapped across source lines.
    expect(body.has('Quit PinholeWindow')).toBe(true)
    expect(body.has('the glasses')).toBe(true)
    expect(body.has('may need a reboot')).toBe(true)
    // Hedged wording.
    expect(body.has('a reload probably will not help')).toBe(true)
    // It does not assert what the glasses' own screen says, which may differ.
    expect(body.has('still say connected')).toBe(false)
  })

  it('says when the glasses are not connected at all', () => {
    // `glass=down` in the collapsed `▶ connection` panel alone would leave the phone looking healthy.
    const body = src.fn('renderPageWarning')
    expect(body.has('const linkDown = !glassLinkUp && !superseded')).toBe(true)
    expect(body.has('the glasses are not connected')).toBe(true)
    // The link message wins: with no link, "reload for a fresh create" is the wrong advice.
    expect(body.indexOf('if (linkDown)')).toBeGreaterThan(-1)
    expect(body.indexOf('if (linkDown)')).toBeLessThan(body.indexOf('if (!noPage) return'))
  })

  it('only claims it when it is the real explanation', () => {
    const body = src.fn('renderPageWarning')
    // Link down → `glass=down` already explains it and "reboot them" would be nonsense.
    // Superseded → the curtain explains this page.
    // One failure → ordinary at boot, the establish can race the bridge by a moment.
    expect(body.has('establishFails >= 2 && glassLinkUp && !superseded')).toBe(true)
  })

  it('clears itself the instant a page exists', () => {
    const body = src.fn('markEstablished')
    expect(body.has('establishFails = 0')).toBe(true)
    expect(body.has('renderPageWarning()')).toBe(true)
  })
})
