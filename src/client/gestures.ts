// pinhole-window — glasses input: gestures to the server, X11 injection, the ring gate and the
// hub event router.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.

import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { resolveFontsize } from '../shared/bindings.ts'
import { evenGestureType, foregroundChange } from '../shared/evenEvent.ts'
import { menuActionFor } from '../shared/glassMenu.ts'
import { type Chord, chordToXdo } from '../shared/keys.ts'
import type { GestureName, InputKind } from '../shared/types.ts'
import { activeWin, bindings, fontStepFor } from './bindingsEditor.ts'
import { DEBUG_EVENTS, log } from './debugLog.ts'
import { chooseMenu, closeMenu, menuOpen, menuPath, moveMenu, openMenu, popLevel } from './menu.ts'
import { NavDebouncer } from './navDebounce.ts'
import { dismissStartupHint, setGlassCovered } from './overlay.ts'
import { apiPost } from './serverLink.ts'
import { sttReady } from './stream.ts'
import { onVoiceFrame, voiceActive, voiceGestureRoute, voiceStart } from './voice.ts'

async function sendGesture(gesture: GestureName, count = 1): Promise<void> {
  const body = count > 1 ? { gesture, count } : { gesture }
  const r = await apiPost<{ handled?: boolean; msg?: string }>('/api/input', body)
  log(
    `${gesture}${count > 1 ? `x${count}` : ''} => ${r?.handled ? 'handled' : (r?.msg ?? 'not handled')}`,
  )
}

const nav = new NavDebouncer((dir, count) => sendGesture(dir < 0 ? 'up' : 'down', count))

// ── direct X11 injection (the phone helper's text box, key pad and trackpad) ───────────────
//
// These drive `POST /api/desktop/input` (docs/protocol.md), which hands `kind` + `arg` to the
// platform's input injection. It is the most powerful route (`{kind:'type'}` types into
// whatever has focus) and sits behind the auth gate (docs/security.md). Nothing here is a
// gesture: `POST /api/input` routes the four glasses gestures and answers 400 for these.

/** One injection, logged. Resolves the server's `ok`. The log line is the only record that a
 *  phone tap turned into an X event. */
export async function x11Inject(kind: InputKind, arg: string, tag = ''): Promise<boolean> {
  const r = await apiPost<{ ok?: boolean; msg?: string }>('/api/desktop/input', { kind, arg })
  const ok = r?.ok === true
  log(`x11 ${kind}${tag ? ` ${tag}` : ''} => ${ok ? 'ok' : (r?.msg ?? 'failed')}`)
  return ok
}

/** Pointer primitives for the trackpad. Not logged per event: a drag emits a steady stream of
 *  moves. The discrete acts (click, button down/up) go through `x11Inject` and are logged. */
export function padMove(x: number, y: number): void {
  void apiPost('/api/desktop/input', { kind: 'move', arg: `${Math.round(x)},${Math.round(y)}` })
}

// ── font size ──────────────────────────────────────────────────────────────────────────────
//
// The client renders no text of its own (it mirrors pixels), so the legibility lever is the
// application's own font. `font −` / `font +` press a per-app key sequence
// (`AppBinding.fontsize`, chosen from `FONTSIZE_STEPS`). The default is xterm's built-in
// `Shift+KP_Add` / `Shift+KP_Subtract`, which are Xt actions: xterm consumes the key and
// nothing reaches the pty.

/** `font −` / `font +`: the focused app's `fontsize` sequence, in order. Stops at the first
 *  failure (half a chord sequence is a different command), except that a `keyup` always follows
 *  its `keydown`: a lost one would leave the modifier held for every later key. */
export async function fontStep(dir: 1 | -1): Promise<void> {
  const w = activeWin()
  const r = resolveFontsize(bindings, w)
  const step = fontStepFor(w)
  const seq = dir > 0 ? step.bigger : step.smaller
  const tag = `font ${dir > 0 ? '+' : '−'} (${step.label}${r.via ? ` via ${r.via}` : ''})`
  const held: string[] = []
  let ok = true
  for (const inj of seq) {
    if (!ok && inj.kind !== 'keyup') continue
    if (inj.kind === 'keyup' && !held.includes(inj.arg)) continue
    const done = await x11Inject(inj.kind, inj.arg, tag)
    if (inj.kind === 'keydown' && done) held.push(inj.arg)
    if (inj.kind === 'keyup') held.splice(held.indexOf(inj.arg), 1)
    if (!done) ok = false
  }
}

/** One step of a send plan. */
export interface Injection {
  kind: 'type' | 'key'
  arg: string
  tag: string
}

/** Pure: the injections a boxful of text becomes, in order.
 *    * a blank or whitespace-only box is nothing;
 *    * lines go in order with `nl` pressed between them; an empty line is the break alone;
 *    * a trailing newline is a real break, not trimmed: it is how a line is ended when the
 *      app's submit key is off, which is the default;
 *    * `press` goes last and only if it exists. */
export function sendPlan(text: string, press: Chord | null, nl: Chord): Injection[] {
  if (text.trim() === '') return []
  const lines = text.split(/\r?\n/)
  const out: Injection[] = []
  lines.forEach((line, i) => {
    if (i > 0)
      out.push({
        kind: 'key',
        arg: chordToXdo(nl),
        tag: `(newline ${String(i)}/${String(lines.length - 1)})`,
      })
    if (line !== '') out.push({ kind: 'type', arg: line, tag: `${String(line.length)} char(s)` })
  })
  if (press) out.push({ kind: 'key', arg: chordToXdo(press), tag: '(submit)' })
  return out
}

/** Send the box: type each line, press `nl` (the app's `newline` setting) between them, then
 *  press `press` (its `submit` setting; null = type only). A newline is a keystroke, not a
 *  character, so both keys can be chosen per app. Sequential, stopping at the first failure: a
 *  failed `type` followed by a successful submit would run text nobody typed. */
export async function submitText(text: string, press: Chord | null, nl: Chord): Promise<boolean> {
  const plan = sendPlan(text, press, nl)
  if (plan.length === 0) return false
  for (const step of plan) {
    if (!(await x11Inject(step.kind, step.arg, step.tag))) return false
  }
  return true
}

// ── gesture routing ────────────────────────────────────────────────────────────────────────

export interface GestureGate {
  kind: string
  t: number
}

/** Same-kind burst refractory plus the cross-kind pair rule. The ring reports scroll deltas
 *  continuously, so without a refractory N events become N actions. A double-tap is commonly
 *  prefixed (sometimes trailed) by a plain click: a 'single' within `pairMs` of a 'double' is
 *  that double's own click edge and is swallowed. A 'double' is never swallowed by an adjacent
 *  single. Pure; the caller stores {kind,t} only on accept. */
export function ringGateAccept(
  prev: GestureGate,
  kind: string,
  now: number,
  sameMs: number,
  pairMs = 180,
): boolean {
  const dt = now - prev.t
  if (kind === prev.kind) return dt >= sameMs
  if (kind === 'single' && prev.kind === 'double' && dt < pairMs) return false
  return true
}

/** Same-kind de-burst windows: swipes 140 ms (scroll streams deltas, so collapse hard),
 *  tap/double 90 ms (absorbs a duplicate burst yet lets a deliberate second double-tap fire). */
const SWIPE_BURST_MS = 140
const TAP_BURST_MS = 90
/** The Hub emits CLICK before DOUBLE_CLICK, so a single is held back this long and cancelled
 *  if a double arrives (docs/glasses.md). */
const SINGLE_DEFER_MS = 180

let ringGate: GestureGate = { kind: '', t: 0 }
let singleTimer: ReturnType<typeof setTimeout> | null = null

export function ringFire(kind: string, fn: () => void): void {
  const now = Date.now()
  const same = kind === 'swipe -1' || kind === 'swipe +1' ? SWIPE_BURST_MS : TAP_BURST_MS
  if (!ringGateAccept(ringGate, kind, now, same)) {
    // Logged, not silent: a swallowed gesture and one that never arrived look identical from
    // outside. The delta says whether the firmware repeated itself inside the window.
    log(
      `gesture ${kind} SWALLOWED by de-burst (+${now - ringGate.t}ms after ${ringGate.kind || 'none'}, window ${same}ms)`,
    )
    return
  }
  ringGate = { kind, t: now }
  fn()
}

/** A long press: opens the voice dialog when the server has a recogniser and no dialog is up;
 *  otherwise it does nothing. `source` only labels the log line. Shared by the ring (PB 9) and
 *  vRing's bottom band, so the two cannot drift apart. */
export function onLong(source: string): void {
  if (sttReady && !voiceActive()) {
    log(`long press (${source}) — opening voice`)
    void voiceStart()
    return
  }
  log(`long (${source}) — not bound to an action`)
}

/** Share of the screen height, from the bottom edge, that vRing gives to the long press. The
 *  left/right divider ends where this band begins. */
export const VRING_LONG_BAND = 0.12

/** Pure: which gesture a vRing tap at (`x`, `y`) on a `w` x `h` screen sends. The bottom band
 *  is the long press when `voice` is on; without it the band belongs to the two halves, so no
 *  part of the pad is dead. */
export function vRingTapKind(
  x: number,
  y: number,
  w: number,
  h: number,
  voice: boolean,
): 'single' | 'double' | 'long' {
  if (voice && y >= h * (1 - VRING_LONG_BAND)) return 'long'
  return x >= w / 2 ? 'double' : 'single'
}

export function onSwipe(dir: -1 | 1): void {
  if (voiceGestureRoute(dir < 0 ? 'swipe-up' : 'swipe-down')) return // the dialog is in front
  if (dismissStartupHint()) return // it only closes the hint: its key could not be seen landing
  if (menuOpen) {
    moveMenu(dir)
    return
  } // the switcher owns the gesture while it is up
  nav.queue(dir)
}

export async function onTap(): Promise<void> {
  if (voiceGestureRoute('tap')) return
  if (dismissStartupHint()) return // as for a swipe
  if (menuOpen) {
    await chooseMenu()
    return
  }
  await nav.flush() // act at the settled cursor, not a stale one
  await sendGesture('tap')
}

/** Double-tap. While the menu is up: `menuActionFor(…, depth)` — up one level while nested,
 *  close at the root list. With nothing up: open the root list. The `nav.flush()` comes first
 *  so whatever follows acts at the settled cursor. */
export async function onDouble(): Promise<void> {
  await nav.flush()
  if (voiceGestureRoute('double')) return
  if (menuOpen) {
    const depth = menuPath.length + 1 // the root list is depth 1
    const act = menuActionFor('double', depth)
    log(`double — menu depth ${String(depth)} => ${act}`)
    if (act === 'ascend') popLevel()
    else closeMenu()
    return
  }
  // A startup hint up goes with it: it names the double-tap, so the double-tap goes on to do
  // what the hint said, and the menu's redraw retires the hint (`syncOverlay`).
  log('double — opening the root list')
  openMenu()
}

/** Has an `audioEvent` ever arrived? Used to log it only once. */
let sawAudioEvent = false

export function onHubEvent(event: EvenHubEvent): void {
  // Audio first: frames arrive every 50-100 ms while a microphone is open, so they must never
  // reach the per-event `log()` below or `?debug=1`'s POST per envelope. Outside a voice dialog
  // they are dropped, and reported once.
  const pcm: unknown = event.audioEvent?.audioPcm
  if (pcm !== undefined) {
    if (voiceActive()) {
      onVoiceFrame(pcm)
      return
    }
    if (!sawAudioEvent) {
      sawAudioEvent = true
      log(
        'audioEvent arrived — a microphone is open and no dialog asked for it.' +
          ' Dropped; not logged again this session (docs/voice.md).',
      )
    }
    return
  }
  const g = evenGestureType(event)
  if (DEBUG_EVENTS) void apiPost('/api/debug/event', { event, gesture: g })
  // Every envelope is logged, normalised, before any filtering — including those that
  // normalise to null: `sysEvent.eventType` 4/5 is a foreground layer arriving and leaving
  // (shared/evenEvent.ts).
  const sys = event.sysEvent
  log(
    `gesture ${g ?? 'null'} (eventType=${String(sys?.eventType ?? '-')} source=${String(sys?.eventSource ?? '-')})`,
  )
  // A foreground layer (most often a notification) covering the panel. Not a gesture, so it
  // is handled before the gesture ladder.
  const fg = foregroundChange(event)
  if (fg !== null) {
    setGlassCovered(fg === 'enter')
    return
  }
  if (g === null) return
  // Long press (PB 9) and its release (PB 10) are handled here, never sent to
  // `POST /api/input`, which routes four gestures and would answer 400 (docs/glasses.md).
  if (g === 'long' || g === 'longRelease') {
    // The release stays unbound: recording is stopped by a tap, so a lost PB 10 cannot leave
    // the mic open (docs/voice.md).
    const source = `source=${String(event.sysEvent?.eventSource ?? '?')}`
    if (g === 'long') onLong(source)
    else log(`${g} (${source}) — not bound to an action`)
    return
  }
  if (g === 'double') {
    // Cancel the deferred single: this is the pair's own leading click.
    if (singleTimer !== null) {
      clearTimeout(singleTimer)
      singleTimer = null
    }
    ringFire('double', () => {
      void onDouble()
    })
    return
  }
  if (g === 'up') {
    ringFire('swipe -1', () => onSwipe(-1))
    return
  }
  if (g === 'down') {
    ringFire('swipe +1', () => onSwipe(1))
    return
  }
  // tap: gate first, then defer so an incoming double can cancel it.
  if (!ringGateAccept(ringGate, 'single', Date.now(), TAP_BURST_MS)) return
  if (singleTimer !== null) clearTimeout(singleTimer)
  singleTimer = setTimeout(() => {
    singleTimer = null
    ringGate = { kind: 'single', t: Date.now() }
    void onTap()
  }, SINGLE_DEFER_MS)
}
