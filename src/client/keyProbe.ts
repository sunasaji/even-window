// pinhole-window — the `?keyprobe=1` input probe.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { button } from './chrome.ts'
import { log } from './debugLog.ts'
import { queryFlag } from './flags.ts'

// `?keyprobe=1`: does a Bluetooth keyboard / trackpad paired to the phone reach this WebView?
//
// An instrument, not a feature, and it never injects: there is deliberately no path from a key
// seen here into `x11Inject` (docs/security.md). `tests/client.keyprobe.test.ts` scans this
// source and fails if an injection call appears.
//
// What it answers, in the order the panel prints it:
//   1. do key events arrive, and do they arrive without focus (the `blur` button makes the
//      unfocused case reproducible);
//   2. do they arrive intact: `key` / `code` / `keyCode`, the modifiers, the arrows and Tab;
//   3. is anything lost between the platform and the DOM. The field is the control: iOS fills
//      it natively with no JavaScript in the path, so a character the field has and the echo
//      lacks was lost on the way to JS;
//   4. how long each event waited (`delay`) on this main thread, with no server in the loop;
//   5. whether the pointer hovers (a move with no button down), which decides whether a
//      trackpad can be a trackpad here or is only a more precise finger.
//
// Query-only, like `stats` and `debug` (see `queryFlag`). Findings are in
// docs/notes/2026-10-keyprobe-ios-hardware-input.md.
export const KEY_PROBE = queryFlag('keyprobe')

/** Longest echo kept on screen: a sentence, not a session. */
export const PROBE_ECHO_MAX = 96
/** Named keys remembered, deduplicated and in arrival order. */
export const PROBE_NAMED_MAX = 14
/** A held key repeats ~30/s, so repeats are counted and logged at most this often. */
const PROBE_REPEAT_MS = 500
/** Pointer moves are never logged per event (a single drag is hundreds); the tally is. */
const PROBE_PTR_MS = 1000
/** Readout refresh. The tally updates per event; the DOM does not. */
const PROBE_RENDER_MS = 200

/** How long an event waited between the platform stamping it and this handler running: the
 *  main-thread queue delay, with no network in the measurement.
 *
 *  `Event.timeStamp` is on the `performance.now()` origin in current engines, but older WebKit
 *  builds hand out epoch milliseconds. Both bases are accepted, and a reading impossible on
 *  either (negative, or over a minute) returns `null` rather than a wrong number. */
export function eventDelayMs(stamp: number, nowPerf: number, nowEpoch: number): number | null {
  if (!Number.isFinite(stamp) || stamp <= 0) return null
  const d = stamp > 1e12 ? nowEpoch - stamp : nowPerf - stamp
  return d >= 0 && d <= 60_000 ? d : null
}

/** The character a key contributes to the echo, or `null` for a named key (`Enter`, `ArrowUp`).
 *  Space becomes `␣` so that a trailing space is visible when comparing against the field. */
export function probeEchoChar(key: string): string | null {
  if (key === ' ') return '␣'
  return Array.from(key).length === 1 ? key : null
}

/** `CASM`, or `-`. */
export function probeMods(m: {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}): string {
  const s =
    (m.ctrlKey ? 'C' : '') +
    (m.altKey ? 'A' : '') +
    (m.shiftKey ? 'S' : '') +
    (m.metaKey ? 'M' : '')
  return s === '' ? '-' : s
}

/** Is this focus label the "nothing is focused" case? `document.activeElement` is the body,
 *  not `null`, when nothing holds focus. */
export function probeUnfocused(tag: string): boolean {
  return tag === 'none' || tag === 'BODY' || tag === 'HTML'
}

export interface KeyProbeEvent {
  phase: 'down' | 'up'
  key: string
  code: string
  keyCode: number
  repeat: boolean
  mods: string
  focus: string
  delayMs: number | null
  trusted: boolean
}

/** One log line per discrete key. `key` is quoted because the interesting values include the
 *  empty string and a bare space. */
export function keyProbeLine(e: KeyProbeEvent): string {
  return (
    `keyprobe ${e.phase} key=${JSON.stringify(e.key)} code=${e.code === '' ? '-' : e.code}` +
    ` which=${String(e.keyCode)} mods=${e.mods} focus=${e.focus}` +
    ` delay=${e.delayMs === null ? '?' : `${String(Math.round(e.delayMs))}ms`}` +
    (e.repeat ? ' repeat' : '') +
    (e.trusted ? '' : ' SYNTHETIC')
  )
}

export interface KeyProbeTally {
  down: number
  up: number
  repeat: number
  /** Keys that arrived with no usable identity (`Unidentified` / keyCode 0). */
  unnamed: number
  /** Keydowns seen while nothing on the page held focus. */
  unfocused: number
  /** Named keys seen at least once, in arrival order (arrows, Tab, Escape, F-keys). */
  named: string[]
  /** An editing key was pressed, so the field and the echo may legitimately differ. */
  edited: boolean
  delays: number
  delaySum: number
  delayMax: number
  echo: string
  /** Caret moves inside the field, and the ones no key event explains. A key that produces no
   *  event but still moves the caret reached the control, and is recoverable from
   *  `selectionchange`. */
  caret: number
  caretGhosts: number
}

export interface PtrProbeTally {
  moves: number
  /** Moves with no button held: the hover bit. */
  hoverMoves: number
  /** Moves that carried a non-zero `movementX/Y`: relative deltas. */
  deltas: number
  downs: number
  types: Record<string, number>
  /** The raw last event, so the summary counters can be checked against actual values. */
  last: PtrSample | null
}

export interface PtrSample {
  type: string
  x: number
  y: number
  dx: number
  dy: number
  buttons: number
}

export function newKeyTally(): KeyProbeTally {
  return {
    down: 0,
    up: 0,
    repeat: 0,
    unnamed: 0,
    unfocused: 0,
    named: [],
    edited: false,
    delays: 0,
    delaySum: 0,
    delayMax: 0,
    echo: '',
    caret: 0,
    caretGhosts: 0,
  }
}

export function newPtrTally(): PtrProbeTally {
  return { moves: 0, hoverMoves: 0, deltas: 0, downs: 0, types: {}, last: null }
}

/** The keys whose arrival means the field no longer holds the string that was typed. */
const PROBE_EDIT_KEYS = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** Fold one keydown/keyup into the tally. Takes the fields, not the event, so the test can
 *  drive it without a DOM. */
export function tallyKey(t: KeyProbeTally, e: KeyProbeEvent): void {
  if (e.phase === 'up') {
    t.up++
    return
  }
  t.down++
  if (e.repeat) t.repeat++
  if (e.key === '' || e.key === 'Unidentified') t.unnamed++
  if (probeUnfocused(e.focus)) t.unfocused++
  if (PROBE_EDIT_KEYS.has(e.key)) t.edited = true
  if (e.delayMs !== null) {
    t.delays++
    t.delaySum += e.delayMs
    t.delayMax = Math.max(t.delayMax, e.delayMs)
  }
  const ch = probeEchoChar(e.key)
  if (ch === null) {
    if (!t.named.includes(e.key) && t.named.length < PROBE_NAMED_MAX) t.named.push(e.key)
  } else {
    t.echo = (t.echo + ch).slice(-PROBE_ECHO_MAX)
  }
}

/** The loss verdict. The field is the control, so a divergence is loss between the platform and
 *  the DOM, unless an editing key has been pressed. Only the tail is compared: the echo is
 *  capped.
 *
 *  The direction matters:
 *    * field ahead of echo → loss before JS, the failure the probe hunts;
 *    * echo ahead of field → the keys reached the DOM and the field does not have focus. That
 *      is the unfocused case working and must not be reported as a loss. */
export function echoVerdict(fieldValue: string, echo: string, edited: boolean): string {
  const plain = echo.replaceAll('␣', ' ')
  if (plain === '' && fieldValue === '') return 'nothing typed yet'
  if (edited) return 'field was edited (BackSpace / arrows) — compare these two by eye'
  if (fieldValue.endsWith(plain) || plain.endsWith(fieldValue)) {
    return `field and echo AGREE (${String(plain.length)} chars) — nothing lost before JS`
  }
  if (fieldValue.length > plain.length) {
    return (
      `LOSS — field has ${String(fieldValue.length)}, JS saw ${String(plain.length)}:` +
      ' keys reached the control but not the DOM'
    )
  }
  return (
    `JS AHEAD — saw ${String(plain.length)}, field has ${String(fieldValue.length)}:` +
    ' keys reach the DOM with focus elsewhere. not a loss — this is the unfocused case working'
  )
}

/** A caret move is a ghost when no key event and no touch can account for it.
 *
 *  Both exclusions are load-bearing: a keydown that moved the caret is a key doing its job, and
 *  a tap into the field moves the caret with no key at all. The touch window is the longer one
 *  because a tap's `selectionchange` can trail its `pointerdown`. */
export const CARET_KEY_MS = 60
export const CARET_PTR_MS = 400

export function caretGhost(nowMs: number, lastKeyMs: number, lastPtrMs: number): boolean {
  return nowMs - lastKeyMs > CARET_KEY_MS && nowMs - lastPtrMs > CARET_PTR_MS
}

/** What the caret counters mean. A ghost is a key that reached the control without a key event,
 *  and therefore one that could be recovered from `selectionchange` deltas. */
export function caretVerdict(t: KeyProbeTally): string {
  if (t.caret === 0) return 'no caret movement yet — focus the field and press the arrow keys'
  if (t.caretGhosts === 0) {
    return `${String(t.caret)} moves, all explained by key events — nothing to recover`
  }
  return (
    `${String(t.caret)} moves, ${String(t.caretGhosts)} with no key event:` +
    ' the arrows reach the control though not the DOM — recoverable from selectionchange'
  )
}

/** What the hover bit means. */
export function hoverVerdict(p: PtrProbeTally): string {
  if (p.hoverMoves === 0) {
    return (
      'no move without a button yet — a pointer that only reports while pressed is' +
      ' AssistiveTouch (iPhone): a precise finger, not a trackpad'
    )
  }
  return p.deltas > 0
    ? 'HOVER + relative deltas — a real pointer'
    : 'HOVER, absolute only (no movementX/Y) — aiming works, Pointer-Lock capture does not'
}

/** The whole on-screen readout, as one string. */
export function keyProbeReadout(k: KeyProbeTally, p: PtrProbeTally, fieldValue: string): string {
  const out: string[] = []
  out.push(
    k.down === 0
      ? 'keys:    NOTHING YET — tap the field and type, then press `blur` and type again'
      : `keys:    down ${String(k.down)} up ${String(k.up)} repeat ${String(k.repeat)}` +
          ` · unnamed ${String(k.unnamed)} · while unfocused ${String(k.unfocused)}`,
  )
  if (k.down > 0) {
    out.push(
      `named:   ${k.named.length > 0 ? k.named.join(' ') : '(none — try Tab and the arrows)'}`,
    )
    out.push(
      `delay:   ${
        k.delays === 0
          ? 'not measurable on this engine'
          : `avg ${String(Math.round(k.delaySum / k.delays))}ms max ${String(Math.round(k.delayMax))}ms`
      }`,
    )
    out.push(`echo:    ${k.echo}`)
    out.push(`loss:    ${echoVerdict(fieldValue, k.echo, k.edited)}`)
    out.push(`caret:   ${caretVerdict(k)}`)
  }
  const types = Object.entries(p.types)
    .map(([t, n]) => `${t}×${String(n)}`)
    .join(' ')
  out.push(
    p.moves === 0
      ? 'pointer: no moves yet — drag a finger, then move the trackpad without pressing'
      : `pointer: ${types} · moves ${String(p.moves)} hover ${String(p.hoverMoves)}` +
          ` deltas ${String(p.deltas)} downs ${String(p.downs)}`,
  )
  // The raw last sample, under the summary: what the device calls the thing that is moving.
  if (p.last) {
    const s = p.last
    out.push(
      `last:    type=${s.type} at ${String(s.x)},${String(s.y)}` +
        ` Δ${String(s.dx)},${String(s.dy)} buttons=${String(s.buttons)}`,
    )
  }
  if (p.moves > 0) out.push(`verdict: ${hoverVerdict(p)}`)
  return out.join('\n')
}

let probeKeys = newKeyTally()
let probePtr = newPtrTally()
/** Listeners and the render timer are installed once per page, not once per `mountUi()`. */
let probeWired = false

/** The panel. Mounted only under `?keyprobe=1`, directly above the log it writes into. */
export function mountKeyProbe(ui: HTMLElement): void {
  const box = document.createElement('details')
  box.open = true // open by default so it is not overlooked
  box.style.cssText = 'margin:0 0 8px'
  const bar = document.createElement('summary')
  bar.textContent = 'keyprobe — observation only, nothing is injected'
  box.appendChild(bar)

  const how = document.createElement('div')
  how.style.cssText = 'margin:6px 0;font:11px/1.45 system-ui;color:#888'
  how.innerHTML =
    '1 · tap the field and type a line you know.<br>' +
    '2 · press <b>blur</b> and type again — this is the "no focus" case the iOS bug reports' +
    ' are about.<br>' +
    '3 · with the field focused, press the arrows and watch <b>caret</b>: on this device' +
    ' they fire no event, so a caret that moves anyway is an invisible key.<br>' +
    '3b · press Tab and Ctrl-combinations; they are the other two that go missing.<br>' +
    '4 · move the trackpad <b>without pressing</b>, then with a button held.<br>' +
    'The field is the control: what it holds came from the platform with no JavaScript in' +
    ' the path.'
  box.appendChild(how)

  const field = document.createElement('input')
  field.placeholder = 'type here (nothing is sent anywhere)'
  field.autocomplete = 'off'
  field.spellcheck = false
  field.style.cssText =
    'width:100%;box-sizing:border-box;padding:7px 9px;' +
    'font:16px ui-monospace,monospace;background:#000;color:#E5E5E5;' +
    'border:1px solid #333;border-radius:6px'
  box.appendChild(field)

  const out = document.createElement('div')
  out.style.cssText =
    'margin:6px 0 0;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'color:#5f6;white-space:pre-wrap;word-break:break-word'
  box.appendChild(out)

  const render = (): void => {
    out.textContent = keyProbeReadout(probeKeys, probePtr, field.value)
  }

  /** Where focus is, as one word for a key line. Declared here because the `blur` button reads
   *  it too, and the listeners are installed once per page while the panel is built once per
   *  `mountUi()`. */
  const focusTag = (): string => {
    const el = document.activeElement
    if (!el) return 'none'
    return el === field ? 'FIELD' : el.tagName
  }

  const tools = document.createElement('div')
  tools.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0'
  const focusBtn = button(
    'focus',
    () => {
      field.focus()
    },
    'put focus in the field — iOS delivers hardware keys only to a focused control',
  )
  // Blur the active element, not just the field: tapping this button focuses the button, so
  // "nothing is focused" would otherwise be "a button is focused". The probe never calls
  // `preventDefault()` (it must not change what it measures), so it undoes the focus afterwards
  // and logs where focus ended up.
  const blurBtn = button(
    'blur',
    () => {
      field.blur()
      const el = document.activeElement
      if (el instanceof HTMLElement) el.blur()
      log(`keyprobe: focus dropped — now ${focusTag()}`)
    },
    'drop focus, then type: does a key still reach the DOM?',
  )
  const resetBtn = button('reset', () => {
    probeKeys = newKeyTally()
    probePtr = newPtrTally()
    field.value = ''
    log('keyprobe: tally reset')
    render()
  })
  for (const b of [focusBtn, blurBtn, resetBtn]) b.style.cssText = 'font:11px system-ui'
  tools.append(focusBtn, blurBtn, resetBtn)
  box.appendChild(tools)

  ui.appendChild(box)
  render()

  if (probeWired) return
  probeWired = true

  // Capture phase, on the document: a key that another handler consumes still has to be counted
  // ("it arrived and something ate it" differs from "it never arrived"). Nothing here calls
  // `preventDefault()`: the probe must not change the behaviour it measures.
  const read = (e: KeyboardEvent, phase: 'down' | 'up'): KeyProbeEvent => ({
    phase,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    repeat: e.repeat,
    mods: probeMods(e),
    focus: focusTag(),
    delayMs: eventDelayMs(e.timeStamp, performance.now(), Date.now()),
    trusted: e.isTrusted,
  })

  // Timestamps the caret rule reads (`caretGhost`): a caret move is evidence of an invisible key
  // only if neither a key nor a finger can account for it.
  let lastKeyAt = -1e9
  let lastPtrAt = -1e9

  let repeats = 0
  let repeatAt = 0
  document.addEventListener(
    'keydown',
    e => {
      lastKeyAt = performance.now()
      const k = read(e, 'down')
      tallyKey(probeKeys, k)
      // A held key is counted every time and logged on a timer: one line per repeat would fill
      // the forward queue (LOG_QUEUE_MAX) within seconds and evict the interesting lines.
      if (k.repeat) {
        repeats++
        const now = Date.now()
        if (now - repeatAt >= PROBE_REPEAT_MS) {
          repeatAt = now
          log(`keyprobe repeat ×${String(repeats)} key=${JSON.stringify(k.key)}`)
          repeats = 0
        }
        return
      }
      log(keyProbeLine(k))
    },
    true,
  )
  document.addEventListener(
    'keyup',
    e => {
      const k = read(e, 'up')
      tallyKey(probeKeys, k)
      if (!k.repeat) log(keyProbeLine(k))
    },
    true,
  )

  // `keypress` is deprecated, but on engines where `keydown` arrives `Unidentified` it is
  // sometimes the only event carrying the character. Logged once, the first time it fires.
  let sawKeypress = false
  document.addEventListener(
    'keypress',
    e => {
      if (sawKeypress) return
      sawKeypress = true
      log(
        `keyprobe: keypress fires on this engine (key=${JSON.stringify(e.key)}) — a fallback` +
          ' for an Unidentified keydown',
      )
    },
    true,
  )

  // The caret is how an invisible key is caught. On iOS the arrow keys produce no key event; if
  // they still move the caret inside a focused field, they reached the control and the caret is
  // the signal. The probe counts such ghosts.
  //
  // `selectionchange` on the document, not `select` on the field: the latter fires for
  // selections, not for a collapsed caret moving one character.
  let caretAt = -1
  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== field) {
      caretAt = -1
      return
    }
    const at = field.selectionStart ?? -1
    if (at === caretAt) return
    const from = caretAt
    caretAt = at
    if (from < 0) return // first reading: a position, not a move
    probeKeys.caret++
    if (!caretGhost(performance.now(), lastKeyAt, lastPtrAt)) return
    probeKeys.caretGhosts++
    // Logged individually: ghosts are rare. The direction is in the line because it names the
    // arrow.
    log(
      `keyprobe caret ${String(from)}→${String(at)} with no key event` +
        ` (${at > from ? 'right/down' : 'left/up'}) — an invisible key moved the control`,
    )
  })

  let ptrAt = 0
  let ptrLogged = 0
  document.addEventListener(
    'pointermove',
    e => {
      lastPtrAt = performance.now()
      probePtr.moves++
      probePtr.types[e.pointerType] = (probePtr.types[e.pointerType] ?? 0) + 1
      if (e.buttons === 0) probePtr.hoverMoves++
      if (e.movementX !== 0 || e.movementY !== 0) probePtr.deltas++
      probePtr.last = {
        type: e.pointerType,
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        dx: Math.round(e.movementX),
        dy: Math.round(e.movementY),
        buttons: e.buttons,
      }
      const now = Date.now()
      if (now - ptrAt < PROBE_PTR_MS || probePtr.moves === ptrLogged) return
      ptrAt = now
      ptrLogged = probePtr.moves
      log(
        `keyprobe ptr ${String(probePtr.moves)} moves type=${e.pointerType}` +
          ` hover=${String(probePtr.hoverMoves)} deltas=${String(probePtr.deltas)}`,
      )
    },
    true,
  )
  document.addEventListener(
    'pointerdown',
    e => {
      lastPtrAt = performance.now()
      probePtr.downs++
      probePtr.types[e.pointerType] = (probePtr.types[e.pointerType] ?? 0) + 1
      log(
        `keyprobe ptr down type=${e.pointerType} button=${String(e.button)}` +
          ` buttons=${String(e.buttons)} at ${String(Math.round(e.clientX))},${String(Math.round(e.clientY))}`,
      )
    },
    true,
  )

  // The readout is repainted on a timer rather than per event: a DOM write in handlers that
  // may run thirty times a second would make the probe part of the delay it reports.
  setInterval(render, PROBE_RENDER_MS)
}
