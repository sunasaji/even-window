// The voice dialog as pure data (src/shared/voiceDialog.ts).
//
// The most important test is the fit: every stage, drawn, must be inside the ten lines the
// panel shows, since a row past the bottom edge is invisible. All six stages are walked with
// an over-long transcript.

import { describe, expect, it } from 'vitest'
import {
  bodyLineBudget,
  elideToLines,
  estimateLines,
  glassWidth,
  injectable,
  LINE_UNITS,
  moveVoice,
  moveVoiceSel,
  NO_ROW,
  newVoiceState,
  PAGE_LINE_UNITS,
  PANEL_LINES,
  pageByLines,
  type VoiceStage,
  voiceActionFor,
  voiceAtPage,
  voiceButtonFor,
  voiceChoice,
  voiceConfirm,
  voiceFits,
  voiceHeader,
  voiceMicFor,
  voiceMorePages,
  voiceNoAudioError,
  voiceOverlay,
  voicePages,
  voiceRows,
  voiceRowsFor,
  wrapGlassLines,
} from '../src/shared/voiceDialog.ts'

const STAGES: VoiceStage[] = ['opening', 'listening', 'recognizing', 'confirm', 'empty', 'failed']

/** Longer than any panel could hold, in both scripts. */
const LONG_JA = 'このファイルのバグを直してテストを追加してください。'.repeat(20)
const LONG_EN = 'fix the bug in this file and add a test for it, then run the suite '.repeat(20)

describe('the width model (six classes, 63 units a line)', () => {
  it('reproduces the three lines that were measured on the glasses', () => {
    // Each of these filled a line on a G2, and one more character wrapped.
    const cjk = '音声入力の折り返しを調べるための長い一文です。ここで切れ'
    expect([...cjk].length).toBe(28)
    const mixed = 'あいうえ5あいうえ10あいうえ15あいうえ20あいうえ25あいう'
    const ascii = '----5---10---15---20---25---30---35---40---45---50---'
    expect(ascii.length).toBe(53)
    // A window title in lower case: the line took `*` and 57 letters, and wrapped the 58th.
    const title = '*Taumatawhakatangihangakoauauotamateaturipukakapikimaungah'
    expect(title.length).toBe(58)
    expect(estimateLines(title + 'o')).toBe(2)
    for (const s of [cjk, mixed, ascii, title]) {
      expect(glassWidth(s), s).toBeLessThanOrEqual(LINE_UNITS)
      expect(glassWidth(s), s).toBeGreaterThan(LINE_UNITS - 2.25)
    }
    expect(estimateLines(cjk + 'あ')).toBe(2)
    expect(estimateLines(ascii + '-')).toBe(2)
  })

  // One width for every narrow character is off by a fifth between an index row and a title
  // in capitals; these are the classes that close the gap.
  it('tells a narrow glyph from a letter from a capital', () => {
    expect(glassWidth('||il')).toBe(2)
    expect(glassWidth('ftr')).toBeCloseTo(1.95)
    expect(glassWidth('abcd')).toBeCloseTo(4.6)
    expect(glassWidth('1-2-')).toBeCloseTo(4.72)
    expect(glassWidth('ABCD')).toBeCloseTo(5.4)
    expect(glassWidth('mw')).toBe(3)
  })

  it('counts the punctuation a transcript contains as wide', () => {
    for (const ch of ['、', '。', '「', '」', '～', '？', '・', 'ー', 'Ａ', '１']) {
      expect(glassWidth(ch), ch).toBe(2.25)
    }
  })

  it('counts a surrogate pair once, not twice', () => {
    // The panel draws nothing for it, but a missing glyph is not a narrow glyph.
    expect([...'𠮷'].length).toBe(1)
    expect(glassWidth('𠮷')).toBe(2.25)
  })

  it('an empty string still occupies a line', () => {
    expect(estimateLines('')).toBe(1)
  })

  it('charges a newline a line of its own', () => {
    expect(estimateLines('a\nb\nc')).toBe(3)
  })

  it('wraps by the capacity, not by words', () => {
    expect(estimateLines('あ'.repeat(28))).toBe(1)
    expect(estimateLines('あ'.repeat(29))).toBe(2)
    expect(estimateLines('あ'.repeat(56))).toBe(2)
  })
})

describe("wrapGlassLines: the phone's copy of the lens text", () => {
  it('folds at the measured capacities: 28 CJK, 53 hyphens', () => {
    const ja = 'あ'.repeat(30)
    expect(wrapGlassLines(ja)).toEqual(['あ'.repeat(28), 'あ'.repeat(2)])
    expect(wrapGlassLines('-'.repeat(54)).map(l => l.length)).toEqual([53, 1])
  })

  it('keeps every character, in order: the copy may break differently, never drop', () => {
    for (const s of [LONG_JA, LONG_EN, 'Voice  (tap=pick  dbl=cancel)\nこれは\n> Send']) {
      expect(wrapGlassLines(s).join('')).toBe(s.replace(/\n/g, ''))
    }
  })

  it('a newline is a line of its own, and an empty line still takes one', () => {
    expect(wrapGlassLines('a\n\nb')).toEqual(['a', '', 'b'])
    expect(wrapGlassLines('')).toEqual([''])
  })

  // The widest row the menu budgets must not fold on the phone when it does not on the lens.
  it('keeps a row of the menu budget on one line', () => {
    const row = `> xc-xg (${Array.from({ length: 9 }, () => 'xfilili').join('|')})`
    expect(wrapGlassLines(row)).toEqual([row])
  })

  it('agrees with estimateLines, except it may run longer where a wide glyph straddles', () => {
    for (const s of [LONG_JA, LONG_EN, 'a' + 'あ'.repeat(60), 'Tasks\n> Menu...\n  *bash']) {
      const n = wrapGlassLines(s).length
      expect(n, s.slice(0, 20)).toBeGreaterThanOrEqual(estimateLines(s))
      expect(n, s.slice(0, 20)).toBeLessThanOrEqual(estimateLines(s) * 2)
    }
    expect(wrapGlassLines(LONG_JA).length).toBe(estimateLines(LONG_JA)) // pure CJK: exact
    expect(wrapGlassLines(LONG_EN).length).toBe(estimateLines(LONG_EN)) // pure ASCII: exact
  })
})

describe('elision', () => {
  it('leaves text that already fits completely alone', () => {
    const s = 'このファイルを直して'
    expect(elideToLines(s, 6)).toBe(s)
  })

  it("marks the cut, because silently-short text is this panel's existing failure mode", () => {
    const out = elideToLines(LONG_JA, 6)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThan(LONG_JA.length)
  })

  it('keeps the result inside the budget it was given', () => {
    for (const n of [1, 2, 6]) {
      for (const s of [LONG_JA, LONG_EN]) {
        expect(estimateLines(elideToLines(s, n)), `${n} lines`).toBeLessThanOrEqual(n)
      }
    }
  })

  it('keeps the head: the phone holds the rest', () => {
    expect(elideToLines(LONG_JA, 2).startsWith('このファイル')).toBe(true)
  })

  it('a zero budget yields nothing rather than an ellipsis', () => {
    expect(elideToLines(LONG_JA, 0)).toBe('')
  })
})

describe('the transcript pages', () => {
  const BUDGET = bodyLineBudget('confirm')

  it('is one page, unchanged, when the text fits', () => {
    expect(voicePages('このファイルを直して')).toEqual(['このファイルを直して'])
    expect(voicePages('')).toEqual([''])
  })

  it('drops nothing: the pages put end to end are the text', () => {
    for (const s of [LONG_JA, LONG_EN, LONG_JA + LONG_EN + LONG_JA]) {
      const pages = voicePages(s)
      expect(pages.length).toBeGreaterThan(1)
      expect(pages.join('')).toBe(s)
    }
  })

  it('keeps every page inside the body, counted by the panel line', () => {
    for (const s of [LONG_JA, LONG_EN, LONG_JA + LONG_EN + LONG_JA]) {
      const pages = voicePages(s)
      for (const p of pages.slice(0, -1)) {
        expect(estimateLines(p), p).toBeLessThanOrEqual(PANEL_LINES - 1)
      }
      expect(estimateLines(pages[pages.length - 1] ?? ''), s).toBeLessThanOrEqual(BUDGET)
    }
  })

  it('ends a page between words where the text has spaces', () => {
    const pages = voicePages(LONG_EN)
    for (const p of pages.slice(0, -1)) expect(p.endsWith(' '), JSON.stringify(p)).toBe(true)
  })

  it('breaks inside a word only when the word is longer than a line', () => {
    const word = 'a'.repeat(200)
    const pages = pageByLines(word, 2, 2)
    expect(pages.join('')).toBe(word)
    for (const p of pages) expect(glassWidth(p)).toBeLessThanOrEqual(2 * PAGE_LINE_UNITS)
  })

  it('counts an edited line break as a line, and a page break stands in for one', () => {
    expect(pageByLines('a\nb\nc', 2, 2)).toEqual(['a\nb', 'c'])
    expect(pageByLines('a\nb', 6, 6)).toEqual(['a\nb'])
  })

  it('gives the earlier pages more lines than the last, and never leaves the last empty', () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => String(i)).join('\n')
    const count = (p: string): number => p.split('\n').length
    for (let n = 1; n <= 40; n++) {
      const pages = pageByLines(lines(n), 9, 6)
      expect(pages.join('\n'), String(n)).toBe(lines(n))
      for (const p of pages.slice(0, -1)) expect(count(p), String(n)).toBeLessThanOrEqual(9)
      const last = pages[pages.length - 1] ?? ''
      expect(count(last), String(n)).toBeLessThanOrEqual(6)
      expect(last, String(n)).not.toBe('')
    }
    expect(pageByLines(lines(6), 9, 6).length).toBe(1)
    expect(pageByLines(lines(7), 9, 6).length).toBe(2)
    expect(pageByLines(lines(15), 9, 6).map(count)).toEqual([9, 6])
  })

  it('shows the page it is on, names it in the header, and fits the panel on each', () => {
    const base = { ...newVoiceState('confirm'), text: LONG_JA + LONG_EN + LONG_JA }
    const pages = voicePages(base.text)
    for (const [i, p] of pages.entries()) {
      const s = { ...base, page: i }
      expect(voiceOverlay(s)).toContain(p)
      expect(voiceHeader(s)).toContain(`${String(i + 1)}/${String(pages.length)}`)
      expect(estimateLines(voiceHeader(s))).toBe(1)
      expect(voiceFits(s), voiceOverlay(s)).toBe(true)
    }
    // A page out of range is clamped, not blank.
    expect(voiceHeader({ ...base, page: 99 })).toContain(`${String(pages.length)}/`)
    expect(voiceOverlay({ ...base, page: 99 })).toContain(pages[pages.length - 1])
  })

  it('offers the rows on the last page only, so a tap cannot send unread text', () => {
    const base = { ...newVoiceState('confirm'), text: LONG_JA + LONG_EN + LONG_JA }
    const n = voicePages(base.text).length
    for (let i = 0; i < n - 1; i++) {
      const s = { ...base, page: i }
      expect(voiceMorePages(s)).toBe(true)
      expect(voiceRowsFor(s)).toEqual([])
      expect(voiceChoice(s)).toBeNull()
      expect(voiceOverlay(s)).not.toContain('Send')
      expect(voiceHeader(s)).toContain('tap=next')
    }
    const end = { ...base, page: n - 1 }
    expect(voiceMorePages(end)).toBe(false)
    expect(voiceRowsFor(end).map(r => r.token)).toEqual(['send', 'again', 'cancel'])
    // A transcript that fits is one page, which is the last.
    expect(voiceRowsFor({ ...newVoiceState('confirm'), text: 'x' }).length).toBe(3)
    expect(voiceMorePages({ ...newVoiceState('failed'), error: LONG_EN })).toBe(false)
  })

  it('a swipe down turns the pages, then walks the rows, then starts over', () => {
    const base = { ...newVoiceState('confirm'), text: LONG_JA + LONG_EN + LONG_JA }
    const n = voicePages(base.text).length
    let s = voiceConfirm(base.text)
    const seen: string[] = []
    for (let i = 0; i < n + 4; i++) {
      seen.push(`${String(s.page)}:${String(s.sel)}`)
      s = { ...s, ...moveVoice(s, 1) }
    }
    const want = [
      ...Array.from({ length: n }, (_, i) => `${String(i)}:-1`),
      `${String(n - 1)}:0`,
      `${String(n - 1)}:1`,
      `${String(n - 1)}:2`,
      '0:-1',
    ]
    expect(seen).toEqual(want)
  })

  it('arrives on the last page with no row selected: one more step reaches Send', () => {
    const text = LONG_JA + LONG_EN + LONG_JA
    const n = voicePages(text).length
    let s = voiceConfirm(text)
    expect(s.sel).toBe(NO_ROW)
    // As many taps as it takes to reach the last page do not put the cursor on a row.
    for (let i = 0; i < n - 1; i++) {
      expect(voiceAtPage(s)).toBe(true)
      s = { ...s, ...moveVoice(s, 1) }
    }
    expect(s.page).toBe(n - 1)
    expect(voiceAtPage(s)).toBe(true)
    expect(voiceChoice(s)).toBeNull()
    expect(voiceOverlay(s)).toContain('  Send')
    expect(voiceOverlay(s)).not.toContain('> ')
    expect(voiceHeader(s)).toContain('tap=next')
    s = { ...s, ...moveVoice(s, 1) }
    expect(voiceAtPage(s)).toBe(false)
    expect(voiceChoice(s)).toBe('send')
    expect(voiceHeader(s)).toContain('tap=pick')
    // Up from Send is the page again, and up from there the page before.
    s = { ...s, ...moveVoice(s, -1) }
    expect([s.page, s.sel]).toEqual([n - 1, NO_ROW])
    s = { ...s, ...moveVoice(s, -1) }
    expect([s.page, s.sel]).toEqual([n - 2, NO_ROW])
  })

  it('a transcript that fits starts on Send, with nothing to page', () => {
    const s = voiceConfirm('x')
    expect(s.sel).toBe(0)
    expect(voiceAtPage(s)).toBe(false)
    expect(voiceChoice(s)).toBe('send')
  })

  it('a swipe up undoes a swipe down from every stop', () => {
    const base = { ...newVoiceState('confirm'), text: LONG_JA + LONG_EN + LONG_JA }
    let s = voiceConfirm(base.text)
    for (let i = 0; i < 12; i++) {
      const next = { ...s, ...moveVoice(s, 1) }
      expect(moveVoice(next, -1)).toEqual({ page: s.page, sel: s.sel })
      s = next
    }
  })

  it('with one page it is the plain cursor', () => {
    const s = { ...newVoiceState('confirm'), text: 'x' }
    expect(moveVoice(s, 1)).toEqual({ page: 0, sel: 1 })
    expect(moveVoice(s, -1)).toEqual({ page: 0, sel: 2 })
    expect(moveVoice({ ...newVoiceState('empty'), sel: 1 }, 1)).toEqual({ page: 0, sel: 0 })
    expect(moveVoice(newVoiceState('listening'), 1)).toEqual({ page: 0, sel: 0 })
  })
})

describe('the panel budget: every stage must fit', () => {
  for (const stage of STAGES) {
    for (const mic of ['glasses', 'phone'] as const) {
      it(`${stage} (${mic} mic) fits in ${String(PANEL_LINES)} lines, even with an over-long body`, () => {
        const s = { ...newVoiceState(stage, mic), text: LONG_JA, error: LONG_EN, seconds: 9999 }
        expect(voiceFits(s), voiceOverlay(s)).toBe(true)
        expect(estimateLines(voiceOverlay(s))).toBeLessThanOrEqual(PANEL_LINES)
      })
    }
  }

  it('leaves the header on one line in every stage, from either mic', () => {
    for (const stage of STAGES) {
      for (const mic of ['glasses', 'phone'] as const) {
        const s = { ...newVoiceState(stage, mic), seconds: 9999 }
        expect(estimateLines(voiceHeader(s)), `${stage}/${mic}`).toBe(1)
        expect(glassWidth(voiceHeader(s))).toBeLessThanOrEqual(LINE_UNITS)
      }
    }
  })

  it('derives the body budget from the rows rather than hard-coding it', () => {
    expect(bodyLineBudget('confirm')).toBe(PANEL_LINES - 1 - 3)
    expect(bodyLineBudget('empty')).toBe(PANEL_LINES - 1 - 2)
    expect(bodyLineBudget('listening')).toBe(PANEL_LINES - 1)
  })

  it('every row label is ASCII (a tofu row is indistinguishable from a broken one)', () => {
    for (const stage of STAGES) {
      for (const r of voiceRows(stage)) expect(/^[\x20-\x7e]+$/.test(r.label), r.label).toBe(true)
    }
  })
})

describe('what is drawn', () => {
  it('never claims to be listening before a frame has arrived (~445ms)', () => {
    expect(voiceHeader(newVoiceState('opening')).toLowerCase()).not.toContain('listening')
    expect(voiceHeader({ ...newVoiceState('listening'), seconds: 3 })).toContain('listening 3s')
  })

  it('shows the transcript in confirm and the error in failed, and never swaps them', () => {
    const c = { ...newVoiceState('confirm'), text: 'これを送る', error: 'boom' }
    expect(voiceOverlay(c)).toContain('これを送る')
    expect(voiceOverlay(c)).not.toContain('boom')
    const f = { ...newVoiceState('failed'), text: 'これを送る', error: 'boom' }
    expect(voiceOverlay(f)).toContain('boom')
    expect(voiceOverlay(f)).not.toContain('これを送る')
  })

  it('marks the cursor the way the menu does', () => {
    const s = { ...newVoiceState('confirm'), text: 'x', sel: 1 }
    const lines = voiceOverlay(s).split('\n')
    expect(lines).toContain('  Send')
    expect(lines).toContain('> Again')
  })

  it('offers nothing to pick while it is still working', () => {
    for (const stage of ['opening', 'listening', 'recognizing'] as VoiceStage[]) {
      expect(voiceRows(stage)).toEqual([])
      expect(voiceChoice(newVoiceState(stage))).toBeNull()
    }
  })

  it('puts the irreversible row last in confirm', () => {
    expect(voiceRows('confirm').map(r => r.token)).toEqual(['send', 'again', 'cancel'])
  })
})

describe('gestures', () => {
  it('double-tap is cancel in every stage', () => {
    for (const stage of STAGES) expect(voiceActionFor('double', stage), stage).toBe('cancel')
  })

  it('a tap stops the recording while it is running', () => {
    expect(voiceActionFor('tap', 'opening')).toBe('stop')
    expect(voiceActionFor('tap', 'listening')).toBe('stop')
  })

  it('swallows swipes while recording, so they cannot reach the desktop instead', () => {
    for (const stage of ['opening', 'listening', 'recognizing'] as VoiceStage[]) {
      expect(voiceActionFor('swipe-up', stage), stage).toBe('none')
      expect(voiceActionFor('swipe-down', stage), stage).toBe('none')
    }
  })

  it('offers only the way out while the recogniser has the audio', () => {
    expect(voiceActionFor('tap', 'recognizing')).toBe('none')
  })

  it('moves and picks once there is something to pick', () => {
    for (const stage of ['confirm', 'empty', 'failed'] as VoiceStage[]) {
      expect(voiceActionFor('tap', stage), stage).toBe('choose')
      expect(voiceActionFor('swipe-up', stage), stage).toBe('up')
      expect(voiceActionFor('swipe-down', stage), stage).toBe('down')
    }
  })

  it('wraps the cursor in both directions', () => {
    expect(moveVoiceSel(0, -1, 3)).toBe(2)
    expect(moveVoiceSel(2, 1, 3)).toBe(0)
    expect(moveVoiceSel(0, 1, 0)).toBe(0) // no rows: stay put rather than divide by zero
  })

  it('drops a pick the stage cannot satisfy instead of indexing past the rows', () => {
    expect(voiceChoice({ ...newVoiceState('empty'), sel: 7 })).toBeNull()
    expect(voiceChoice({ ...newVoiceState('confirm'), sel: 2 })).toBe('cancel')
  })
})

describe('which microphone', () => {
  it("the glasses' while the link is up, the phone's only when it is down", () => {
    expect(voiceMicFor(true)).toBe('glasses')
    expect(voiceMicFor(false)).toBe('phone')
  })

  it('a new state records the glasses unless told otherwise', () => {
    expect(newVoiceState('opening').mic).toBe('glasses')
    expect(newVoiceState('opening', 'phone').mic).toBe('phone')
  })

  it('says so while it records from the phone, and only then', () => {
    expect(voiceHeader(newVoiceState('opening', 'phone'))).toContain('phone mic')
    expect(voiceHeader({ ...newVoiceState('listening', 'phone'), seconds: 3 })).toContain('(phone)')
    expect(voiceHeader(newVoiceState('opening'))).not.toMatch(/phone/i)
    expect(voiceHeader({ ...newVoiceState('listening'), seconds: 3 })).not.toMatch(/phone/i)
  })

  it('a phone header still fits one line at the 30s cap', () => {
    expect(
      estimateLines(voiceHeader({ ...newVoiceState('listening', 'phone'), seconds: 30 })),
    ).toBe(1)
  })

  it('names the likely cause of silence per mic', () => {
    expect(voiceNoAudioError('glasses')).toContain('g2-microphone')
    expect(voiceNoAudioError('phone')).toMatch(/allowed|permission/)
  })
})

describe('the phone button', () => {
  it('starts a recording when no dialog is up', () => {
    expect(voiceButtonFor(null)).toEqual({ label: '🎤 voice', action: 'start' })
  })

  it('is `■ stop` exactly where a glasses tap stops', () => {
    for (const stage of STAGES) {
      const stops = voiceActionFor('tap', stage) === 'stop'
      expect(voiceButtonFor(stage).action === 'stop', stage).toBe(stops)
      if (stops) expect(voiceButtonFor(stage).label, stage).toBe('■ stop')
    }
  })

  it('is disabled in every other stage rather than meaning something new', () => {
    for (const stage of ['recognizing', 'confirm', 'empty', 'failed'] as VoiceStage[]) {
      expect(voiceButtonFor(stage).action, stage).toBe('none')
    }
  })
})

describe('the injection gate', () => {
  it('refuses empty and whitespace: silence is not a command', () => {
    for (const s of ['', '   ', '\n', '\t ']) expect(injectable(s)).toBe(false)
  })

  it('accepts real text', () => {
    expect(injectable('ls -la')).toBe(true)
    expect(injectable('このファイルを直して')).toBe(true)
  })
})
