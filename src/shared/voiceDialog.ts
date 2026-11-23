// The voice dialog as pure data (docs/voice.md, docs/decisions/voice-dialog-design.md).
//
// Here: the stages, their rows, the gesture rule, the width model, the line budget and the
// elision. Not here: the microphone, the HTTP call, the text box and when a stage changes,
// which are client side effects.
//
// The panel holds ten lines and the firmware wraps text itself, so this module only estimates
// line counts, erring long. `opening` is its own stage because the mic takes about 445 ms to
// deliver its first frame, and "listening" must not be claimed before then.

/** Rows are the same shape the menu uses, so the overlay renders both the same way. */
export interface VoiceRow {
  /** ASCII only, like menu labels. */
  label: string
  token: VoiceToken
}

export type VoiceToken = 'send' | 'again' | 'cancel'

/** Where the dialog is. Each stage draws and answers gestures differently. */
export type VoiceStage =
  /** The mic has been asked for; no frame has arrived yet (about 445 ms). */
  | 'opening'
  /** Frames are arriving. This is the only stage that may claim to be hearing anything. */
  | 'listening'
  /** Recording stopped, the recogniser has the audio (about 0.8 s for 4 s of speech). */
  | 'recognizing'
  /** There is a transcript to accept, redo or drop. */
  | 'confirm'
  /** The recogniser answered with nothing. Not an error: nobody spoke. */
  | 'empty'
  /** Something broke. `error` is shown and is never injected. */
  | 'failed'

export interface VoiceState {
  stage: VoiceStage
  /** The transcript, in `confirm`. The client keeps the authoritative copy in the text box. */
  text: string
  /** Why it failed, in `failed`. Human-readable, never injected. */
  error: string
  /** Whole seconds since the first frame, in `listening`. */
  seconds: number
  /** Cursor position among the rows. */
  sel: number
  /** Whose microphone this recording is from (`voiceMicFor`); the header names the phone's. */
  mic: VoiceMic
}

export function newVoiceState(
  stage: VoiceStage = 'opening',
  mic: VoiceMic = 'glasses',
): VoiceState {
  return { stage, text: '', error: '', seconds: 0, sel: 0, mic }
}

// ── which microphone ───────────────────────────────────────────────────────────────────────
//
// The glasses' mic, and the phone's only when the glasses link is down. Chosen once at the
// start of a recording: a link that drops mid-recording does not switch mics. Both deliver
// 16 kHz s16le mono; frame length differs and nothing here assumes one. The phone's needs the
// OS microphone permission.

export type VoiceMic = 'glasses' | 'phone'

export function voiceMicFor(glassLinkUp: boolean): VoiceMic {
  return glassLinkUp ? 'glasses' : 'phone'
}

/** The message for "the host took the call and no audio came", naming the likely cause per mic. */
export function voiceNoAudioError(mic: VoiceMic): string {
  return mic === 'phone'
    ? 'no audio from the phone mic. Is the microphone allowed for the Even App?'
    : 'no audio arrived. Is g2-microphone declared in app.json?'
}

// ── the width model ────────────────────────────────────────────────────────────────────────
//
// One line holds 28 pure-CJK characters or 53 hyphens-and-digits; at wide 2 / narrow 1 the
// capacity is 56 units. It is an estimate: the font is proportional and the firmware does the
// wrapping, so an error costs a line of layout, never a character of content.
export const LINE_UNITS = 56
/** Lines the panel shows before the bottom edge clips. */
export const PANEL_LINES = 10

/** East Asian Wide and Fullwidth: the ranges a transcript can contain, plus astral CJK, which
 *  the panel cannot draw but is still counted wide. */
export function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, symbols and punctuation 、。「」
    (cp >= 0x3041 && cp <= 0x33ff) || // kana ー・, CJK compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms Ａ１～？
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // astral CJK: drawn as nothing
  )
}

/** A string's width in the units above. Code points, not UTF-16 units, so a surrogate pair
 *  counts once. */
export function glassWidth(s: string): number {
  let w = 0
  for (const ch of s) w += isWideChar(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

/** How many panel lines a string takes once the firmware wraps it. Each newline-separated
 *  segment, even an empty one, occupies at least one line. */
export function estimateLines(s: string, unitsPerLine = LINE_UNITS): number {
  let n = 0
  for (const seg of s.split('\n')) n += Math.max(1, Math.ceil(glassWidth(seg) / unitsPerLine))
  return n
}

/** The lines `s` takes once wrapped, by the same width model as `estimateLines`. A wide glyph
 *  that would straddle a line end moves to the next line whole, so the count can exceed
 *  `estimateLines` but is never shorter. For the phone's approximate copy of the lens text
 *  only: the glasses receive the unwrapped string and the firmware folds it. */
export function wrapGlassLines(s: string, unitsPerLine = LINE_UNITS): string[] {
  const out: string[] = []
  for (const seg of s.split('\n')) {
    let line = ''
    let used = 0
    for (const ch of seg) {
      const w = glassWidth(ch)
      if (used + w > unitsPerLine && line !== '') {
        out.push(line)
        line = ''
        used = 0
      }
      line += ch
      used += w
    }
    out.push(line)
  }
  return out
}

/** Cut `s` down to at most `maxLines` wrapped lines, keeping the head and marking the cut
 *  with `…`. The mark is required: an undrawable glyph already vanishes silently on the
 *  panel, so elision must not shorten text silently too. */
export function elideToLines(s: string, maxLines: number, unitsPerLine = LINE_UNITS): string {
  if (maxLines <= 0) return ''
  if (estimateLines(s, unitsPerLine) <= maxLines) return s
  const budget = maxLines * unitsPerLine - 1 // one unit kept for the `…`
  let used = 0
  let line = 0
  let out = ''
  for (const ch of s) {
    const w = ch === '\n' ? 0 : glassWidth(ch)
    if (ch === '\n') {
      line += 1
      used = (line + 1) * unitsPerLine
      if (used >= budget) break
      out += ch
      continue
    }
    if (used + w > budget) break
    used += w
    out += ch
  }
  return `${out}…`
}

// ── the rows ───────────────────────────────────────────────────────────────────────────────
//
// Three at most: ten lines less the header leaves six for the body only with three rows.
// ASCII, short, the destructive one last.

const ROW_SEND: VoiceRow = { label: 'Send', token: 'send' }
const ROW_AGAIN: VoiceRow = { label: 'Again', token: 'again' }
const ROW_CANCEL: VoiceRow = { label: 'Cancel', token: 'cancel' }

/** The rows for a stage. Empty during `opening` / `listening` / `recognizing`, when there is
 *  nothing to pick. */
export function voiceRows(stage: VoiceStage): VoiceRow[] {
  if (stage === 'confirm') return [ROW_SEND, ROW_AGAIN, ROW_CANCEL]
  if (stage === 'empty' || stage === 'failed') return [ROW_AGAIN, ROW_CANCEL]
  return []
}

/** Lines left for the body: the panel less the header and the rows. */
export function bodyLineBudget(stage: VoiceStage): number {
  return PANEL_LINES - 1 - voiceRows(stage).length
}

// ── gestures ───────────────────────────────────────────────────────────────────────────────
//
// A long press starts the dialog (routed by the client, not here) and a tap stops the
// recording; no hold-to-talk. A double-tap cancels in every stage.

export type VoiceGesture = 'tap' | 'swipe-up' | 'swipe-down' | 'double'
export type VoiceAction = 'stop' | 'choose' | 'up' | 'down' | 'cancel' | 'none'

export function voiceActionFor(g: VoiceGesture, stage: VoiceStage): VoiceAction {
  if (g === 'double') return 'cancel'
  // Working: a tap stops the recording. A swipe is swallowed so it does not reach the desktop.
  if (stage === 'opening' || stage === 'listening') return g === 'tap' ? 'stop' : 'none'
  // The recogniser has the audio: nothing to stop or pick; only cancel works.
  if (stage === 'recognizing') return 'none'
  if (g === 'tap') return 'choose'
  return g === 'swipe-up' ? 'up' : 'down'
}

/** Move the cursor, wrapping, like the menu. */
export function moveVoiceSel(sel: number, delta: number, rows: number): number {
  if (rows <= 0) return 0
  return (((sel + delta) % rows) + rows) % rows
}

// ── the phone button ───────────────────────────────────────────────────────────────────────
//
// The phone's `🎤 voice` button follows the dialog: with nothing up it starts a recording, and
// during `opening` / `listening` it is `■ stop`, the same stop as a glasses tap. In every
// other stage it is disabled: the choice is made through the text box and Submit.

export type VoiceButtonAction = 'start' | 'stop' | 'none'

export interface VoiceButton {
  label: string
  action: VoiceButtonAction
}

/** The phone button for a dialog stage, or for no dialog at all (`null`). */
export function voiceButtonFor(stage: VoiceStage | null): VoiceButton {
  if (stage === null) return { label: '🎤 voice', action: 'start' }
  if (stage === 'opening' || stage === 'listening') return { label: '■ stop', action: 'stop' }
  return { label: '🎤 voice', action: 'none' }
}

// ── the drawing ────────────────────────────────────────────────────────────────────────────

/** The one-line header: what is happening and what the gestures do here. */
export function voiceHeader(s: VoiceState): string {
  switch (s.stage) {
    // Not "listening": speech before the first audio frame (about 445 ms) is lost.
    case 'opening':
      return s.mic === 'phone' ? 'Voice  opening the phone mic...' : 'Voice  opening the mic...'
    case 'listening':
      return `Voice${s.mic === 'phone' ? ' (phone)' : ''}  listening ${String(s.seconds)}s  (tap=stop  dbl=cancel)`
    case 'recognizing':
      return 'Voice  recognizing...'
    case 'confirm':
      return 'Voice  (tap=pick  dbl=cancel)'
    case 'empty':
      return 'Voice  nothing was heard'
    case 'failed':
      return 'Voice  FAILED'
  }
}

/** The body: the transcript, the error, or nothing. Elided to whatever the rows leave. */
export function voiceBody(s: VoiceState): string {
  if (s.stage === 'confirm') return elideToLines(s.text, bodyLineBudget('confirm'))
  if (s.stage === 'failed') return elideToLines(s.error, bodyLineBudget('failed'))
  return ''
}

/** The whole overlay text, with the menu's cursor spelling (`> ` / two spaces). */
export function voiceOverlay(s: VoiceState): string {
  const rows = voiceRows(s.stage)
  const body = voiceBody(s)
  const lines = [voiceHeader(s)]
  if (body !== '') lines.push(body)
  for (const [i, r] of rows.entries()) lines.push(`${i === s.sel ? '>' : ' '} ${r.label}`)
  return lines.join('\n')
}

/** Does this state fit the panel? tests/shared.voiceDialog.test.ts checks every stage. */
export function voiceFits(s: VoiceState): boolean {
  return estimateLines(voiceOverlay(s)) <= PANEL_LINES
}

/** The row the cursor is on, or null when the stage has none or `sel` is out of range. */
export function voiceChoice(s: VoiceState): VoiceToken | null {
  return voiceRows(s.stage)[s.sel]?.token ?? null
}

/** Is this text safe to inject? Empty text and errors both yield `false`: a recogniser's
 *  complaint must never be typed into a shell. */
export function injectable(text: string): boolean {
  return text.trim() !== ''
}
