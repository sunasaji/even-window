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
  moveVoiceSel,
  newVoiceState,
  PANEL_LINES,
  type VoiceStage,
  voiceActionFor,
  voiceButtonFor,
  voiceChoice,
  voiceFits,
  voiceHeader,
  voiceMicFor,
  voiceNoAudioError,
  voiceOverlay,
  voiceRows,
  wrapGlassLines,
} from '../src/shared/voiceDialog.ts'

const STAGES: VoiceStage[] = ['opening', 'listening', 'recognizing', 'confirm', 'empty', 'failed']

/** Longer than any panel could hold, in both scripts. */
const LONG_JA = 'このファイルのバグを直してテストを追加してください。'.repeat(20)
const LONG_EN = 'fix the bug in this file and add a test for it, then run the suite '.repeat(20)

describe('the width model (wide 2 / narrow 1, 56 units a line)', () => {
  it('reproduces the three lines that were measured on the glasses', () => {
    // 28 pure CJK characters = 56 units, the capacity.
    const measured = '音声入力の折り返しを調べるための長い一文です。ここで切れ'
    expect([...measured].length).toBe(28)
    expect(glassWidth(measured)).toBe(56)
    // kana + digits: 23 wide + 9 narrow = 55, just inside.
    expect(glassWidth('あいうえ5あいうえ10あいうえ15あいうえ20あいうえ25あいう')).toBe(55)
    // hyphens and digits: 53 narrow glyphs = 53, also inside.
    expect(glassWidth('----5---10---15---20---25---30---35---40---45---50---')).toBe(53)
  })

  it('counts the punctuation a transcript contains as wide', () => {
    for (const ch of ['、', '。', '「', '」', '～', '？', '・', 'ー', 'Ａ', '１']) {
      expect(glassWidth(ch), ch).toBe(2)
    }
  })

  it('counts a surrogate pair once, not twice', () => {
    // The panel draws nothing for it, but a missing glyph is not a narrow glyph.
    expect([...'𠮷'].length).toBe(1)
    expect(glassWidth('𠮷')).toBe(2)
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
  it('folds at the measured capacities: 28 CJK, 56 narrow', () => {
    const ja = 'あ'.repeat(30)
    expect(wrapGlassLines(ja)).toEqual(['あ'.repeat(28), 'あ'.repeat(2)])
    expect(wrapGlassLines('-'.repeat(57)).map(l => l.length)).toEqual([56, 1])
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
