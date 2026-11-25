// The voice dialog as pure data (docs/voice.md, docs/decisions/voice-dialog-design.md).
//
// Here: the stages, their rows, the gesture rule, the width model, the line budget, the
// transcript's pages and the elision. Not here: the microphone, the HTTP call, the text box and when a stage changes,
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
  /** Which page of the transcript is shown, in `confirm` (`voicePages`). 0 when it fits. */
  page: number
  /** Whose microphone this recording is from (`voiceMicFor`); the header names the phone's. */
  mic: VoiceMic
}

export function newVoiceState(
  stage: VoiceStage = 'opening',
  mic: VoiceMic = 'glasses',
): VoiceState {
  return { stage, text: '', error: '', seconds: 0, sel: 0, page: 0, mic }
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
// The panel font is proportional and the firmware does the wrapping, so this is an estimate.
// Widths are in six classes, and a line holds 63 units.
//
//   CJK and full width           2.25   28 to a line
//   capitals                     1.35
//   `m` `w` `@` `%`              1.5
//   digits and `-`               1.18   a 53-character ruler of them filled a line
//   `f` `t` `r`                  0.65
//   `|` `i` `l` brackets, space  0.5
//   anything else                1.15   lower case
//
// Three lines measured on a G2 fix the scale: 28 CJK characters, the ruler, and a window title
// of 58 lower-case letters that filled the line at its 58th (`*Taumata...maungah`, one more
// wrapped). The classes between them are fitted so that those three come out at a full line
// and the rows seen to fit come out under one. One width for every narrow character is off
// by a fifth from one ASCII line to the next.
//
// An error costs layout, never content, but not evenly: a row that overflows breaks at its
// first space, which strands the cursor on a line of its own. So a row is budgeted short of
// the line (`ROW_LABEL_UNITS` in glassMenu.ts).
export const LINE_UNITS = 63
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

const NARROW_CHARS: ReadonlySet<string> = new Set("|!.,:;'`()[]{} iljI")
const SLIM_CHARS: ReadonlySet<string> = new Set('ftr')
const BROAD_CHARS: ReadonlySet<string> = new Set('mw@%')

/** Characters a page title can carry that are not meant to be seen: the soft hyphen, the
 *  zero-width space and joiners, direction marks, the byte order mark, control characters.
 *  The panel does not treat them as invisible: on a G2 a soft hyphen is drawn as `-`, which
 *  made a row that was budgeted without it wrap. So a label drops them (`plainText`) instead
 *  of guessing a width; `glassWidth` counts any that remain as an ordinary character. */
function isUnseen(cp: number): boolean {
  return (
    cp <= 0x1f || // C0 controls, newline and tab among them
    (cp >= 0x7f && cp <= 0x9f) || // DEL and the C1 controls
    cp === 0xad || // soft hyphen
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space and joiners, direction marks
    (cp >= 0x2028 && cp <= 0x202e) || // line and paragraph separators, embeddings
    cp === 0x2060 || // word joiner
    cp === 0xfeff // byte order mark
  )
}

/** `s` without the characters above. For one-line labels; a control character (a newline in
 *  a window title) becomes nothing rather than a line break. */
export function plainText(s: string): string {
  let out = ''
  for (const ch of s) if (!isUnseen(ch.codePointAt(0) ?? 0)) out += ch
  return out
}

/** A string's width in the units above. Code points, not UTF-16 units, so a surrogate pair
 *  counts once. */
export function glassWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    if (NARROW_CHARS.has(ch)) w += 0.5
    else if (SLIM_CHARS.has(ch)) w += 0.65
    else if (ch === '-' || (ch >= '0' && ch <= '9')) w += 1.18
    else if (BROAD_CHARS.has(ch)) w += 1.5
    else if (ch >= 'A' && ch <= 'Z') w += 1.35
    else w += isWideChar(ch.codePointAt(0) ?? 0) ? 2.25 : 1.15
  }
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

// ── the transcript's pages ─────────────────────────────────────────────────────────────────
//
// The panel does not scroll, so a transcript longer than the body is shown a page at a time
// (`moveVoice` turns them). Nothing is dropped: the pages put end to end are the transcript.
//
// Only the last page has the rows. `Send` is not offered before the whole text has been
// shown, so a tap on an earlier page cannot send what was not read; it turns the page. On
// arriving at the last page the cursor is on no row (`voiceAtPage`), so the tap that was meant
// to turn one more page does not send either.

/** A page's lines are folded a little short of the panel's, since the estimate is not exact
 *  and a line too many would push the last row off the bottom edge. */
export const PAGE_LINE_UNITS = LINE_UNITS - 3

/** Fold one newline-free segment into lines of at most `units`, breaking after the last space
 *  on the line when there is one, as the firmware does, and inside a word only when the word
 *  is longer than a line. The lines put end to end are the segment. */
function foldSegment(seg: string, units: number): string[] {
  const out: string[] = []
  let line = ''
  let used = 0
  for (const ch of seg) {
    const w = glassWidth(ch)
    // A space at the line end hangs past it: it draws nothing, and keeping it there means
    // the next line, and so the next page, starts with a word.
    if (ch !== ' ' && used + w > units && line !== '') {
      const sp = line.lastIndexOf(' ')
      if (sp >= 0 && sp < line.length - 1) {
        // Carry the unfinished word down.
        out.push(line.slice(0, sp + 1))
        line = line.slice(sp + 1)
        used = glassWidth(line)
      } else {
        out.push(line)
        line = ''
        used = 0
      }
    }
    line += ch
    used += w
  }
  out.push(line)
  return out
}

/** Pure: `s` as pages. Every page but the last holds up to `fullLines` panel lines and the
 *  last up to `lastLines`, the fewer: it shares the panel with the rows. Always at least one
 *  page, and the last is never empty when there is text. A page ends at a line end, so
 *  between words where the text has spaces. */
export function pageByLines(
  s: string,
  fullLines: number,
  lastLines: number,
  units = PAGE_LINE_UNITS,
): string[] {
  const last = Math.max(1, lastLines)
  const full = Math.max(last, fullLines)
  // Each folded line, and whether it opens a newline-separated segment.
  const lines: { text: string; opens: boolean }[] = []
  for (const [i, seg] of s.split('\n').entries()) {
    for (const [j, text] of foldSegment(seg, units).entries()) {
      lines.push({ text, opens: i > 0 && j === 0 })
    }
  }
  const pages: string[] = []
  let at = 0
  const take = (n: number): void => {
    // A new segment starts on its own line; a page break stands in for that line break.
    pages.push(
      lines
        .slice(at, at + n)
        .map((l, k) => (l.opens && k > 0 ? `\n${l.text}` : l.text))
        .join(''),
    )
    at += n
  }
  // One line is always left over, so the page with the rows has something on it.
  while (lines.length - at > last) take(Math.min(full, lines.length - at - 1))
  take(lines.length - at)
  return pages
}

/** The transcript's pages in `confirm`. The last page carries the rows; the ones before it
 *  carry none, so they have the whole panel under the header. */
export function voicePages(text: string): string[] {
  return pageByLines(text, PANEL_LINES - 1, bodyLineBudget('confirm'))
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

/** Is an earlier page of a paged transcript showing, one with more text after it? */
export function voiceMorePages(s: VoiceState): boolean {
  return s.stage === 'confirm' && s.page < voicePages(s.text).length - 1
}

/** The rows this state draws: the stage's, except on a transcript page that is not the last,
 *  which has none. */
export function voiceRowsFor(s: VoiceState): VoiceRow[] {
  return voiceMorePages(s) ? [] : voiceRows(s.stage)
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

/** One swipe (`delta` = -1 up, +1 down) in a stage with rows. A transcript of several pages
 *  is read by the same swipe that moves the cursor: the stops are one ring,
 *
 *      page 1 > page 2 > ... > last page > its first row > ... > its last row > page 1
 *
 *  The last page is a stop of its own, with the cursor on no row: arriving there selects the
 *  page, and one more step puts the cursor on `Send`. So a run of taps or swipes through the
 *  pages ends on the last page and not on `Send`. With one page this is `moveVoiceSel`. */
export function moveVoice(s: VoiceState, delta: number): { page: number; sel: number } {
  const rows = voiceRows(s.stage).length
  if (rows <= 0) return { page: 0, sel: 0 }
  const pages = s.stage === 'confirm' ? voicePages(s.text).length : 1
  const last = pages - 1
  const page = Math.min(Math.max(s.page, 0), last)
  if (pages === 1) return { page: 0, sel: moveVoiceSel(s.sel, delta, rows) }
  // A stop's index on the ring: the pages first, then the last page's rows.
  const at = page < last || s.sel < 0 ? page : pages + Math.min(s.sel, rows - 1)
  const n = pages + rows
  const to = (((at + delta) % n) + n) % n
  return to <= last ? { page: to, sel: NO_ROW } : { page: last, sel: to - pages }
}

/** `sel` when the cursor is on no row: a page of a paged transcript is what is selected. */
export const NO_ROW = -1

/** Is a page of a paged transcript what is selected, rather than a row? True on every page
 *  before the last, and on the last until the cursor has stepped onto its rows. A tap here
 *  moves on (`moveVoice(s, 1)`); it never picks. */
export function voiceAtPage(s: VoiceState): boolean {
  if (s.stage !== 'confirm') return false
  const pages = voicePages(s.text).length
  return pages > 1 && (s.page < pages - 1 || s.sel < 0)
}

/** The state for a transcript that has just arrived: on its first page, and with no row
 *  selected when there are several. */
export function voiceConfirm(text: string, mic: VoiceMic = 'glasses'): VoiceState {
  const paged = voicePages(text).length > 1
  return { ...newVoiceState('confirm', mic), text, sel: paged ? NO_ROW : 0 }
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
    case 'confirm': {
      const n = voicePages(s.text).length
      if (n <= 1) return 'Voice  (tap=pick  dbl=cancel)'
      const at = Math.min(Math.max(s.page, 0), n - 1) + 1
      const keys = voiceAtPage(s) ? 'tap=next  swipe=page' : 'tap=pick  swipe up=back'
      return `Voice ${String(at)}/${String(n)}  (${keys}  dbl=cancel)`
    }
    case 'empty':
      return 'Voice  nothing was heard'
    case 'failed':
      return 'Voice  FAILED'
  }
}

/** The body: the transcript's current page, the error elided to whatever the rows leave, or
 *  nothing. */
export function voiceBody(s: VoiceState): string {
  if (s.stage === 'confirm') {
    const pages = voicePages(s.text)
    return pages[Math.min(Math.max(s.page, 0), pages.length - 1)] ?? ''
  }
  if (s.stage === 'failed') return elideToLines(s.error, bodyLineBudget('failed'))
  return ''
}

/** The whole overlay text, with the menu's cursor spelling (`> ` / two spaces). */
export function voiceOverlay(s: VoiceState): string {
  const rows = voiceRowsFor(s)
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
  return voiceRowsFor(s)[s.sel]?.token ?? null
}

/** Is this text safe to inject? Empty text and errors both yield `false`: a recogniser's
 *  complaint must never be typed into a shell. */
export function injectable(text: string): boolean {
  return text.trim() !== ''
}
