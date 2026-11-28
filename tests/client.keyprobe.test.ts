// pinhole-window — `?keyprobe=1`, the instrument that answers "does a Bluetooth keyboard or
// trackpad reach this WebView at all?"
//
// The probe's findings can only come from a real phone. What a test can do is make sure the
// instrument is honest:
//
//   * it must never inject (docs/security.md). The source scan at the bottom is the guard;
//     the pure tests only prove the readout is not lying.
//   * it must not manufacture findings: a loss verdict after a BackSpace, or a delay figure
//     taken from a mismatched clock base, would be read as a hardware fault.
//   * it must stay an instrument: query-only, never sticky (tests/client.flags.test.ts).

import { describe, expect, it } from 'vitest'
import {
  CARET_KEY_MS,
  CARET_PTR_MS,
  caretGhost,
  caretVerdict,
  echoVerdict,
  eventDelayMs,
  hoverVerdict,
  type KeyProbeEvent,
  keyProbeLine,
  keyProbeReadout,
  newKeyTally,
  newPtrTally,
  PROBE_ECHO_MAX,
  PROBE_NAMED_MAX,
  probeEchoChar,
  probeMods,
  probeUnfocused,
  tallyKey,
} from '../src/client/keyProbe.ts'
import { clientSource } from './helpers/source.ts'

const src = clientSource()

const key = (over: Partial<KeyProbeEvent> = {}): KeyProbeEvent => ({
  phase: 'down',
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  repeat: false,
  mods: '-',
  focus: 'FIELD',
  delayMs: 3,
  trusted: true,
  ...over,
})

describe('eventDelayMs: the queue delay, or nothing', () => {
  it('measures against performance.now() for a high-res stamp', () => {
    expect(eventDelayMs(1_000, 1_012, Date.now())).toBe(12)
  })

  it('measures against the wall clock when the engine stamps with epoch ms', () => {
    const epoch = 1_760_000_000_000
    expect(eventDelayMs(epoch, 500, epoch + 20)).toBe(20)
  })

  it('refuses a reading that is impossible on either base, rather than reporting a number', () => {
    expect(eventDelayMs(1_000, 900, Date.now())).toBe(null) // negative
    expect(eventDelayMs(1_000, 90_000, Date.now())).toBe(null) // over a minute
    expect(eventDelayMs(0, 10, 10)).toBe(null)
    expect(eventDelayMs(Number.NaN, 10, 10)).toBe(null)
  })
})

describe('probeEchoChar: what a key contributes to the echo', () => {
  it('takes single characters, including the ones a phone keyboard makes', () => {
    expect(probeEchoChar('a')).toBe('a')
    expect(probeEchoChar('あ')).toBe('あ')
    expect(probeEchoChar('😀')).toBe('😀') // one grapheme, two UTF-16 units
  })

  it('makes a space visible, because the echo is compared by eye against the field', () => {
    expect(probeEchoChar(' ')).toBe('␣')
  })

  it('returns null for a named key, which belongs on the `named` line instead', () => {
    for (const k of ['Enter', 'ArrowUp', 'Tab', 'Unidentified', '']) {
      expect(probeEchoChar(k)).toBe(null)
    }
  })
})

describe('probeMods / probeUnfocused', () => {
  it('spells the modifiers compactly and says `-` for none', () => {
    const m = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
    expect(probeMods(m)).toBe('-')
    expect(probeMods({ ...m, ctrlKey: true, shiftKey: true })).toBe('CS')
  })

  it('counts BODY as unfocused: that is the state the iOS bug reports are about', () => {
    expect(probeUnfocused('BODY')).toBe(true)
    expect(probeUnfocused('HTML')).toBe(true)
    expect(probeUnfocused('none')).toBe(true)
    expect(probeUnfocused('FIELD')).toBe(false)
    expect(probeUnfocused('INPUT')).toBe(false)
  })
})

describe('keyProbeLine: one line per discrete key', () => {
  it('quotes the key, because the interesting values are "" and " "', () => {
    expect(keyProbeLine(key({ key: ' ' }))).toContain('key=" "')
    expect(keyProbeLine(key({ key: '' }))).toContain('key=""')
  })

  it('says `?` rather than a made-up number when the delay is unmeasurable', () => {
    expect(keyProbeLine(key({ delayMs: null }))).toContain('delay=?')
    expect(keyProbeLine(key({ delayMs: 12.4 }))).toContain('delay=12ms')
  })

  it('marks a repeat and an untrusted event, since both change what a line means', () => {
    expect(keyProbeLine(key({ repeat: true }))).toContain('repeat')
    expect(keyProbeLine(key({ trusted: false }))).toContain('SYNTHETIC')
    expect(keyProbeLine(key())).not.toContain('SYNTHETIC')
  })
})

describe('tallyKey: what the panel counts', () => {
  it('separates down from up, so a keyboard that sends no keyup is visible', () => {
    const t = newKeyTally()
    tallyKey(t, key())
    tallyKey(t, key({ phase: 'up' }))
    tallyKey(t, key())
    expect([t.down, t.up]).toEqual([2, 1])
  })

  it('counts the iOS failure modes it exists to catch', () => {
    const t = newKeyTally()
    tallyKey(t, key({ key: 'Unidentified', keyCode: 0 }))
    tallyKey(t, key({ focus: 'BODY' }))
    expect([t.unnamed, t.unfocused]).toEqual([1, 1])
  })

  it('collects named keys once each, in arrival order and bounded', () => {
    const t = newKeyTally()
    for (const k of ['Tab', 'ArrowUp', 'Tab']) tallyKey(t, key({ key: k }))
    expect(t.named).toEqual(['Tab', 'ArrowUp'])
    for (let i = 0; i < PROBE_NAMED_MAX + 5; i++) tallyKey(t, key({ key: `F${String(i)}` }))
    expect(t.named.length).toBe(PROBE_NAMED_MAX)
  })

  it('builds the echo and keeps the tail, which is what a capped field can be compared with', () => {
    const t = newKeyTally()
    for (const ch of 'hi there') tallyKey(t, key({ key: ch }))
    expect(t.echo).toBe('hi␣there')
    for (let i = 0; i < PROBE_ECHO_MAX + 10; i++) tallyKey(t, key({ key: 'z' }))
    expect(t.echo.length).toBe(PROBE_ECHO_MAX)
    expect(t.echo.endsWith('z')).toBe(true)
  })

  it('remembers that an editing key was pressed: the loss verdict depends on it', () => {
    const t = newKeyTally()
    expect(t.edited).toBe(false)
    tallyKey(t, key({ key: 'Backspace' }))
    expect(t.edited).toBe(true)
  })

  it('averages only the delays it could measure', () => {
    const t = newKeyTally()
    tallyKey(t, key({ delayMs: 10 }))
    tallyKey(t, key({ delayMs: null }))
    tallyKey(t, key({ delayMs: 30 }))
    expect([t.delays, t.delaySum, t.delayMax]).toEqual([2, 40, 30])
  })

  it('counts a repeat without letting it flood the named list', () => {
    const t = newKeyTally()
    for (let i = 0; i < 20; i++) tallyKey(t, key({ key: 'ArrowDown', repeat: true }))
    expect(t.repeat).toBe(20)
    expect(t.named).toEqual(['ArrowDown'])
  })
})

describe('echoVerdict: the finding, and the refusal to invent one', () => {
  it('agrees when the field and the DOM saw the same thing', () => {
    expect(echoVerdict('hi there', 'hi␣there', false)).toContain('AGREE')
  })

  it('agrees when only the cap separates them (the echo holds the tail)', () => {
    expect(echoVerdict('abcdef', 'cdef', false)).toContain('AGREE')
  })

  it('reports loss when the control has characters the DOM never saw', () => {
    const v = echoVerdict('hello', 'hlo', false)
    expect(v).toContain('LOSS')
    expect(v).toContain('not the DOM')
  })

  // The direction is the finding: typing with focus on a button gives the DOM every key and
  // the field none, and that must not be announced as the iOS failure.
  it('does not call it loss when the DOM is ahead: that is the unfocused case working', () => {
    const v = echoVerdict('hello', 'helloxyz', false)
    expect(v).toContain('JS AHEAD')
    expect(v).toContain('not a loss')
    expect(v).not.toContain('LOSS —')
  })

  it('says nothing about divergence once an editing key has been pressed', () => {
    expect(echoVerdict('hllo', 'hello', true)).not.toContain('LOSS')
    expect(echoVerdict('hllo', 'hello', true)).toContain('edited')
  })

  it('is quiet before anything is typed', () => {
    expect(echoVerdict('', '', false)).toBe('nothing typed yet')
  })
})

// The caret. On iOS the arrow keys produce no key event, so the probe tells "the key never
// happened" from "the key happened and the DOM did not see it". The rule has to be strict,
// because the second answer would be used to build a feature on.

describe('caretGhost: a caret move nothing else explains', () => {
  const now = 10_000

  it('is a ghost when neither a key nor a touch is recent enough', () => {
    expect(caretGhost(now, now - CARET_KEY_MS - 1, now - CARET_PTR_MS - 1)).toBe(true)
  })

  it('is not a ghost right after a key: that is a key doing its job', () => {
    expect(caretGhost(now, now - 1, now - 100_000)).toBe(false)
  })

  it('is not a ghost right after a touch: a tap moves the caret with no key at all', () => {
    expect(caretGhost(now, now - 100_000, now - 1)).toBe(false)
  })

  it('leaves the touch window the longer of the two (a tap trails its pointerdown)', () => {
    expect(CARET_PTR_MS).toBeGreaterThan(CARET_KEY_MS)
  })
})

describe('caretVerdict: zero ghosts is a finding too', () => {
  it('asks for the experiment when the caret has not moved', () => {
    expect(caretVerdict(newKeyTally())).toContain('press the arrow keys')
  })

  it('says there is nothing to recover when every move had a key', () => {
    const t = { ...newKeyTally(), caret: 6 }
    expect(caretVerdict(t)).toContain('nothing to recover')
  })

  it('names the recovery route only when ghosts actually happened', () => {
    const t = { ...newKeyTally(), caret: 6, caretGhosts: 4 }
    expect(caretVerdict(t)).toContain('selectionchange')
    expect(caretVerdict(t)).toContain('no key event')
  })
})

describe('hoverVerdict: the one bit that decides whether a trackpad is a trackpad', () => {
  it('names AssistiveTouch when no move ever arrived without a button', () => {
    const p = newPtrTally()
    p.moves = 400
    expect(hoverVerdict(p)).toContain('AssistiveTouch')
  })

  it('separates hover-with-deltas from hover-absolute', () => {
    const p = { ...newPtrTally(), moves: 10, hoverMoves: 10 }
    expect(hoverVerdict(p)).toContain('absolute only')
    expect(hoverVerdict({ ...p, deltas: 4 })).toContain('relative deltas')
  })
})

describe('keyProbeReadout: the panel says what to do next when it has nothing', () => {
  it('asks for the two experiments instead of printing zeroes', () => {
    const r = keyProbeReadout(newKeyTally(), newPtrTally(), '')
    expect(r).toContain('NOTHING YET')
    expect(r).toContain('blur')
    expect(r).toContain('without pressing')
  })

  it('carries every finding once keys have arrived', () => {
    const k = newKeyTally()
    for (const ch of 'ab') tallyKey(k, key({ key: ch }))
    tallyKey(k, key({ key: 'Tab', focus: 'BODY' }))
    const p = { ...newPtrTally(), moves: 3, types: { touch: 3 } }
    const r = keyProbeReadout(k, p, 'ab')
    expect(r).toContain('while unfocused 1')
    expect(r).toContain('Tab')
    expect(r).toContain('AGREE')
    expect(r).toContain('touch×3')
  })

  // The counters are a summary; the raw values are on screen so they can be checked.
  it('prints the raw last pointer sample', () => {
    const p = {
      ...newPtrTally(),
      moves: 1,
      hoverMoves: 1,
      types: { mouse: 1 },
      last: { type: 'mouse', x: 120, y: 340, dx: -3, dy: 2, buttons: 0 },
    }
    const r = keyProbeReadout(newKeyTally(), p, '')
    expect(r).toContain('type=mouse at 120,340')
    expect(r).toContain('Δ-3,2')
    expect(r).toContain('buttons=0')
  })

  it('has no `last:` line before a pointer has ever moved', () => {
    expect(keyProbeReadout(newKeyTally(), newPtrTally(), '')).not.toContain('last:')
  })
})

// The structural half: the probe must stay an instrument, and must never inject.

describe('the probe never reaches the nested X (source scan)', () => {
  // The probe, by name: the mount (every listener and every DOM write lives there) and the
  // functions it is built from, wherever each is declared.
  const probe = src.fns(
    'mountKeyProbe',
    'eventDelayMs',
    'probeEchoChar',
    'probeMods',
    'probeUnfocused',
    'keyProbeLine',
    'newKeyTally',
    'newPtrTally',
    'tallyKey',
    'echoVerdict',
    'caretGhost',
    'caretVerdict',
    'hoverVerdict',
    'keyProbeReadout',
  )
  // Code only: the comments name the very things being forbidden ("nothing here calls
  // `preventDefault()`"), and a scan must not fail on the sentence that documents the promise.
  const code = probe.code()

  it('isolated the probe block for scanning', () => {
    expect(probe.raw.length).toBeGreaterThan(2000)
    expect(code.has('function mountKeyProbe')).toBe(true)
  })

  it('calls no injection or API primitive: the only sink is log() and the tally', () => {
    for (const forbidden of ['x11Inject', 'apiPost(', 'authFetch(', 'padPress', 'ringFire']) {
      expect(code.has(forbidden), forbidden).toBe(false)
    }
  })

  it('never cancels an event: the probe must not change what it measures', () => {
    expect(code.has('preventDefault')).toBe(false)
  })

  it('listens in the capture phase, so a key eaten by another handler is still counted', () => {
    const listeners = probe.count('addEventListener(')
    expect(listeners).toBeGreaterThanOrEqual(5)
    // Every listener is an inline arrow, so its closing `}, true)` is the capture flag's.
    expect(probe.count(/addEventListener\('\w+',(?:e|\(\))=>\{/)).toBe(listeners)
    expect(probe.count('}, true)')).toBeGreaterThanOrEqual(5)
  })
})

describe('the probe is an instrument, not a setting (source scan)', () => {
  it('reads its flag from the URL only, through the shared grammar', () => {
    expect(src.has("KEY_PROBE = queryFlag('keyprobe')")).toBe(true)
    expect(src.has("initFlag('keyprobe'")).toBe(false)
  })

  it('is mounted only when the flag is on', () => {
    expect(src.has('if (KEY_PROBE) mountKeyProbe(ui)')).toBe(true)
  })

  // The `blur` run is only an experiment if focus actually goes away; tapping the button gives
  // the button focus. The fix has no pure surface to assert on, so its shape is pinned here.
  it('drops focus from whatever holds it, not just from the field', () => {
    expect(src.has('if (el instanceof HTMLElement) el.blur()')).toBe(true)
    expect(src.has('keyprobe: focus dropped — now ${focusTag()}')).toBe(true)
  })

  it('announces itself in the boot log, with what it does not do', () => {
    expect(src.has('keyprobe=on (observes keys and pointer; injects nothing)')).toBe(true)
  })
})
