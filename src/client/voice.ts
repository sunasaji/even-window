// pinhole-window — the voice dialog: recording, the STT round trip and its gestures (docs/voice.md).
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import {
  injectable,
  moveVoice,
  newVoiceState,
  type VoiceGesture,
  type VoiceState,
  voiceActionFor,
  voiceAtPage,
  voiceButtonFor,
  voiceChoice,
  voiceConfirm,
  voiceMicFor,
  voiceNoAudioError,
} from '../shared/voiceDialog.ts'
import { setLit } from './chrome.ts'
import { log } from './debugLog.ts'
import { glassLinkUp } from './glassPage.ts'
import { bridge, sdk } from './main.ts'
import { superseded, syncOverlay } from './overlay.ts'
import { fireSubmit, textBox, voiceBtn } from './phoneUi.ts'
import { authFetch } from './serverLink.ts'
import { b64ToBytes, sttReady } from './stream.ts'
import { errText, withTimeout } from './util.ts'

/** The dialog, or null. The single answer to "is voice up". */
export let voice: VoiceState | null = null
/** Bumped by every start, cancel and resolve, and captured across every await: a transcript
 *  that arrives after the wearer has cancelled must not reopen the dialog they just closed. */
let voiceGen = 0
let voicePcm: Uint8Array[] = []
let voicePcmLen = 0
let voiceTick: ReturnType<typeof setInterval> | null = null
let voiceTimer: ReturnType<typeof setTimeout> | null = null
let voiceAskedAt = 0
let voiceFirstAt = 0

/** Hard cap on one recording. The server refuses more than `STT_MAX_SECONDS`, but the wearer
 *  gets no warning as they approach it, so this stops first and stops visibly. */
const VOICE_MAX_RECORD_MS = 30_000
/** How long `opening` may last before it is a failure. The first frame normally arrives in
 *  ~445ms; seconds of nothing means the host accepted the call and sent no audio. */
const VOICE_OPEN_GRACE_MS = 6000
/** A confirm nobody answers. An overlay left up freezes the mirror, so the dialog times itself
 *  out. */
const VOICE_IDLE_MS = 60_000
/** Both sources capture at 16 kHz. The server cannot infer it from the bytes. */
const VOICE_RATE = 16000

export function voiceActive(): boolean {
  return voice !== null
}

export function setVoice(next: VoiceState | null): void {
  voice = next
  syncOverlay()
  syncVoiceBtn()
}

/** The phone button mirrors the dialog's stage (`voiceButtonFor`): start, `■ stop`, or disabled.
 *  Called from `setVoice`, which every stage change goes through, so it cannot fall behind. */
function syncVoiceBtn(): void {
  if (!voiceBtn) return
  // Pin the width before the label first changes. The button shares a column with Submit and
  // the column is as wide as its widest button, so a shorter `■ stop` would narrow the column
  // and widen the text box mid-recording. Measured from the idle label, the first time the
  // button is laid out (it is hidden until the server reports a recogniser).
  if (!voiceBtn.style.minWidth && voiceBtn.offsetWidth > 0) {
    voiceBtn.style.minWidth = `${String(voiceBtn.offsetWidth)}px`
  }
  const b = voiceButtonFor(voice?.stage ?? null)
  voiceBtn.textContent = b.label
  voiceBtn.disabled = b.action === 'none'
  setLit(voiceBtn, b.action === 'stop')
}

/** The phone button. One switch over `voiceButtonFor`, so the label and the action can never
 *  disagree; a stop from here is the same `voiceStop` a glasses tap reaches. */
export function onVoiceBtn(): void {
  const act = voiceButtonFor(voice?.stage ?? null).action
  if (act === 'start') void voiceStart()
  else if (act === 'stop') void voiceStop('phone')
}

function voiceClearTimers(): void {
  if (voiceTick !== null) {
    clearInterval(voiceTick)
    voiceTick = null
  }
  if (voiceTimer !== null) {
    clearTimeout(voiceTimer)
    voiceTimer = null
  }
}

/** Close the microphone. Never throws and never conditional: a mic left open is the one
 *  failure on this path that the wearer cannot see. */
async function voiceMicOff(): Promise<void> {
  if (!bridge) return
  try {
    await withTimeout(Promise.resolve(bridge.audioControl(false)), 5000, 'mic off')
  } catch (e) {
    log(`voice: closing the mic FAILED: ${errText(e)} — it may still be open`)
  }
}

function voiceFail(error: string): void {
  voiceClearTimers()
  void voiceMicOff()
  setVoice({ ...newVoiceState('failed'), error })
  voiceArmIdle()
}

function voiceArmIdle(): void {
  if (voiceTimer !== null) clearTimeout(voiceTimer)
  voiceTimer = setTimeout(() => {
    voiceCancel('idle')
  }, VOICE_IDLE_MS)
}

/** Close the dialog without touching the box: the path `Send` takes, where the box has just
 *  been consumed by the submit.
 *
 *  Closes the mic too, unconditionally, like `voiceCancel`: a phone Submit can land while the
 *  dialog is still recording, and clearing the timers (the 30s cap among them) without closing
 *  the microphone would leave the glasses sending frames with nothing left to stop them. */
export function voiceResolve(reason: string): void {
  if (!voice) return
  voiceGen++
  voiceClearTimers()
  void voiceMicOff()
  log(`voice: resolved (${reason})`)
  setVoice(null)
}

/** Close the dialog and empty the box. The transcript was editable up to this moment, so
 *  cancelling discards it; otherwise it is unclear what was cancelled. */
export function voiceCancel(reason: string): void {
  if (!voice) return
  voiceGen++
  voiceClearTimers()
  void voiceMicOff()
  if (textBox) textBox.value = ''
  log(`voice: cancelled (${reason}) — the text box is cleared`)
  setVoice(null)
}

export async function voiceStart(): Promise<void> {
  if (voiceActive()) {
    log('voice: already up')
    return
  }
  if (!sdk || !bridge) {
    log('voice: no bridge — this needs the Even App')
    return
  }
  if (superseded) {
    log('voice: this instance has been superseded')
    return
  }
  if (!sttReady) {
    log('voice: the server has no recogniser configured (EW_STT_URL) — not starting')
    return
  }
  // Which mic is decided once, here (`voiceMicFor`, src/shared/voiceDialog.ts). With the glasses
  // link down their mic is unreachable, so the phone's is used: the link verdict is the only
  // input. The dialog then shows on the phone preview; the lens gets it if the link comes back
  // (`setGlassLink`).
  const mic = voiceMicFor(glassLinkUp)
  const gen = ++voiceGen
  voicePcm = []
  voicePcmLen = 0
  voiceFirstAt = 0
  voiceAskedAt = Date.now()
  setVoice(newVoiceState('opening', mic))
  let ok = false
  try {
    const source = mic === 'phone' ? sdk.AudioInputSource.Phone : sdk.AudioInputSource.Glasses
    ok = await withTimeout(Promise.resolve(bridge.audioControl(true, source)), 5000, 'mic on')
  } catch (e) {
    log(`voice: audioControl threw: ${errText(e)}`)
  }
  if (gen !== voiceGen) {
    void voiceMicOff()
    return
  } // cancelled while asking
  // Accepted is not arrived: `true` means the host took the call, nothing more. The stage stays
  // `opening` until a frame lands, and the grace check below turns "said yes, sent nothing"
  // into a visible failure.
  log(
    `voice: ${mic} mic requested => ${String(ok)} (accepted is not arrived)` +
      (mic === 'phone' ? ' — the glasses link is down, so the phone mic is the fallback' : ''),
  )
  voiceClearTimers()
  voiceTick = setInterval(() => {
    if (!voice) return
    if (voice.stage === 'opening') {
      if (Date.now() - voiceAskedAt < VOICE_OPEN_GRACE_MS) return
      // The likely cause differs per mic (`voiceNoAudioError`): an undeclared permission for the
      // glasses, the OS permission for the phone.
      voiceFail(voiceNoAudioError(voice.mic))
      return
    }
    if (voice.stage !== 'listening') return
    setVoice({ ...voice, seconds: Math.round((Date.now() - voiceFirstAt) / 1000) })
  }, 1000)
  voiceTimer = setTimeout(() => {
    void voiceStop('30s cap')
  }, VOICE_MAX_RECORD_MS)
}

let voiceWarnedWire = false

/** One `audioEvent`. Never redraws per frame: a frame arrives every 50ms and a push per frame
 *  would be a BLE write twenty times a second. The one redraw here is the opening→listening
 *  transition; the seconds counter is the 1 Hz ticker's job. */
export function onVoiceFrame(pcm: unknown): void {
  if (!voice || (voice.stage !== 'opening' && voice.stage !== 'listening')) return
  const bytes =
    pcm instanceof Uint8Array
      ? pcm
      : Array.isArray(pcm)
        ? new Uint8Array(pcm as number[])
        : typeof pcm === 'string'
          ? b64ToBytes(pcm)
          : null
  if (!bytes) {
    // The host sends `Uint8Array`; the SDK allows two other shapes. Anything else would
    // silently append nothing, so it is logged once.
    if (!voiceWarnedWire) {
      voiceWarnedWire = true
      log(`voice: audioPcm arrived as ${typeof pcm} — not a shape this knows how to read`)
    }
    return
  }
  voicePcm.push(bytes)
  voicePcmLen += bytes.length
  if (voice.stage === 'opening') {
    voiceFirstAt = Date.now()
    log(
      `voice: first frame after ${String(voiceFirstAt - voiceAskedAt)}ms (${String(bytes.length)}B)`,
    )
    setVoice({ ...voice, stage: 'listening', seconds: 0 })
  }
}

/** Everything captured so far, as one ArrayBuffer-backed block for `fetch`. */
function voicePcmBytes(): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(voicePcmLen))
  let at = 0
  for (const c of voicePcm) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export async function voiceStop(why: string): Promise<void> {
  if (!voice || (voice.stage !== 'opening' && voice.stage !== 'listening')) return
  const gen = voiceGen
  voiceClearTimers()
  await voiceMicOff()
  if (gen !== voiceGen) return
  const n = voicePcmLen
  log(`voice: stopped (${why}) with ${String(n)}B = ${(n / 2 / VOICE_RATE).toFixed(1)}s of audio`)
  if (n === 0) {
    setVoice(newVoiceState('empty'))
    voiceArmIdle()
    return
  }
  setVoice({ ...newVoiceState('recognizing') })
  const body = voicePcmBytes()
  voicePcm = []
  voicePcmLen = 0
  let res: Response
  try {
    res = await authFetch(`/api/stt?rate=${String(VOICE_RATE)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    })
  } catch (e) {
    if (gen !== voiceGen) return
    voiceFail(`could not reach the server: ${errText(e)}`)
    return
  }
  if (gen !== voiceGen) {
    log('voice: a transcript arrived for a dialog that is gone — dropped')
    return
  }
  let j: { ok?: boolean; text?: string; error?: string } = {}
  try {
    j = (await res.json()) as typeof j
  } catch {
    /* handled below */
  }
  if (!res.ok || j.ok !== true) {
    voiceFail(j.error ?? `the server answered ${String(res.status)}`)
    return
  }
  const text = (j.text ?? '').trim()
  log(`voice: transcript ${String(text.length)} char(s)`)
  if (!injectable(text)) {
    setVoice(newVoiceState('empty'))
    voiceArmIdle()
    return
  }
  // The box is the source of truth, so it is filled before the dialog claims to have a
  // transcript. Not focused: focusing pops the soft keyboard, which fights the keyboard-shrink
  // detection the apps palette depends on.
  if (textBox) textBox.value = text
  setVoice(voiceConfirm(text, voice?.mic))
  voiceArmIdle()
}

async function voiceAgain(): Promise<void> {
  voiceGen++
  voiceClearTimers()
  await voiceMicOff()
  if (textBox) textBox.value = ''
  voice = null
  await voiceStart()
}

/** `Send`. Goes through `fireSubmit`, the one submit path, rather than injecting here, so the
 *  submit key, the box-clearing and the newline handling all stay in one place. */
function voiceSend(): void {
  const t = textBox?.value ?? ''
  if (!injectable(t)) {
    log('voice: nothing to send')
    return
  }
  fireSubmit?.('glasses')
}

// `?voicefeed=<url>`: exercising voice without a microphone. Inert unless set.
//
// The simulator has no audio device and its automation API cannot evaluate JavaScript, so this
// flag is the regression path for the dialog. It feeds raw s16le mono PCM at 16 kHz through
// `onVoiceFrame`, the entry point an `audioEvent` takes, in 1600-byte frames (one glasses
// frame). That covers the stage machine, the POST, the server route, the recogniser and the
// confirm dialog; only the microphone is left for hardware.
//
// No audio ships with the repo; docs/development.md says how to make a sample.

export function voiceFeedUrl(): string {
  try {
    return new URLSearchParams(location.search).get('voicefeed') ?? ''
  } catch {
    return ''
  } // no location (vitest/node)
}

export async function voiceFeedRun(url: string): Promise<void> {
  // Wait for the capability: `voiceStart` refuses until `GET /api/health` has said the server
  // has a recogniser.
  for (let i = 0; i < 100 && !sttReady; i++) await new Promise(r => setTimeout(r, 100))
  if (!sttReady) {
    log('voicefeed: the server reports no recogniser — nothing to feed')
    return
  }
  log(`voicefeed: ${url}`)
  await voiceStart()
  let buf: Uint8Array
  try {
    const r = await fetch(url)
    if (!r.ok) {
      log(`voicefeed: ${String(r.status)} fetching ${url}`)
      voiceCancel('feed failed')
      return
    }
    buf = new Uint8Array(await r.arrayBuffer())
  } catch (e) {
    log(`voicefeed: cannot fetch ${url}: ${errText(e)}`)
    voiceCancel('feed failed')
    return
  }
  log(`voicefeed: ${String(buf.length)} bytes = ${String(Math.ceil(buf.length / 1600))} frames`)
  for (let i = 0; i < buf.length; i += 1600) onVoiceFrame(buf.subarray(i, i + 1600))
  await voiceStop('voicefeed')
}

export function voiceGestureRoute(g: VoiceGesture): boolean {
  if (!voice) return false
  const act = voiceActionFor(g, voice.stage)
  if (act === 'none') return true // swallowed: see voiceActionFor
  if (act === 'cancel') {
    voiceCancel(g)
    return true
  }
  if (act === 'stop') {
    void voiceStop(g)
    return true
  }
  if (act === 'up' || act === 'down') {
    setVoice({ ...voice, ...moveVoice(voice, act === 'up' ? -1 : 1) })
    // Reading several pages takes longer than the idle limit allows a dialog nobody answers,
    // so a swipe counts as an answer and starts the limit again.
    voiceArmIdle()
    return true
  }
  // A page of a long transcript is selected, not a row: the tap moves on, to the next page or
  // from the last page onto `Send`.
  if (voiceAtPage(voice)) {
    setVoice({ ...voice, ...moveVoice(voice, 1) })
    voiceArmIdle()
    return true
  }
  const tok = voiceChoice(voice)
  if (tok === 'send') voiceSend()
  else if (tok === 'again') void voiceAgain()
  else if (tok === 'cancel') voiceCancel('row')
  else log('voice: a pick with no row under it — dropped')
  return true
}
