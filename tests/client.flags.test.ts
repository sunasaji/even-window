// even-window — the two kinds of flag, and the line that keeps a stored one honest.
//
//   * Instruments do not persist. `stats` and `debug` are read from this URL only, so the
//     answer to "am I being measured" is no by default on every load. Settings (`server`,
//     `invert`, `scrollnat`) persist, because the WebView is torn down and re-opened constantly.
//   * What still persists says so. The boot log names the flags this load took from storage
//     rather than from its URL.
//
// See docs/decisions/instrument-flags-query-only.md.

import { describe, expect, it } from 'vitest'
import { flagSource, parseFlag, stickyLine } from '../src/client/flags.ts'
import { clientSource } from './helpers/source.ts'

const src = clientSource()

describe('parseFlag — one grammar for every ?flag= in the client', () => {
  it('reads presence as on, so a bare ?flag works', () => {
    expect(parseFlag('')).toBe(true)
  })

  it('accepts the spellings a human types', () => {
    for (const s of ['1', 'true', 'on', 'yes', 'TRUE', ' on ']) expect(parseFlag(s)).toBe(true)
    for (const s of ['0', 'false', 'off', 'no', 'OFF', ' off ']) expect(parseFlag(s)).toBe(false)
  })

  it('returns null for absent and for unparseable, so neither decides anything', () => {
    expect(parseFlag(null)).toBe(null)
    expect(parseFlag(undefined)).toBe(null)
    expect(parseFlag('banana')).toBe(null)
  })
})

describe('flagSource — which of the three sources decided', () => {
  it('prefers the URL, then storage, then the default', () => {
    expect(flagSource(true, true)).toBe('query')
    expect(flagSource(true, false)).toBe('query')
    expect(flagSource(false, true)).toBe('stored')
    expect(flagSource(false, false)).toBe('default')
  })
})

describe('stickyLine — the self-diagnosing line', () => {
  it('says nothing when this load decided everything (the common case must stay quiet)', () => {
    expect(stickyLine([])).toBe('')
  })

  it('names the flag, its value, and the exact parameter that would change it', () => {
    const line = stickyLine([{ name: 'stats', value: 'on' }])
    expect(line).toContain('stats=on')
    expect(line).toContain('localStorage')
    expect(line).toContain('?stats=')
  })

  it('carries every stuck flag, so one of them cannot hide behind another', () => {
    const line = stickyLine([
      { name: 'server', value: 'http://host:8787' },
      { name: 'invert', value: 'on' },
    ])
    expect(line).toContain('server=http://host:8787')
    expect(line).toContain('invert=on')
    expect(line).toContain('?server=')
    expect(line).toContain('?invert=')
  })
})

// ── the structural half: an instrument must not become sticky ──────────────────────────────
//
// A unit test cannot observe `initStats`, which touches `location` and `localStorage`. What it
// can do is pin the shape: instruments go through `queryFlag`, settings through `initFlag`, and
// the retired key is only ever removed.

describe('instruments are query-only (source scan)', () => {
  it('reads stats from the URL and never resolves it against storage', () => {
    expect(src.has("statsOn = queryFlag('stats')")).toBe(true)
    expect(src.has("initFlag('stats'")).toBe(false)
  })

  it('reads debug the same way, through the shared grammar', () => {
    expect(src.has("DEBUG_EVENTS = queryFlag('debug')")).toBe(true)
    expect(src.has("initFlag('debug'")).toBe(false)
  })

  it('never reads the stats flag from storage', () => {
    expect(src.has("statsOn = queryFlag('stats')")).toBe(true)
    expect(src.has('ew.stats')).toBe(false)
  })

  it('keeps the settings persistent — this is not a reason to de-stick them', () => {
    // Which way a two-finger drag turns the wheel is what this install runs as, so `scrollnat`
    // is a setting (docs/phone-ui.md).
    expect(src.has("initFlag('invert'")).toBe(true)
    expect(src.has("initFlag('scrollnat'")).toBe(true)
    expect(src.has('localStorage.setItem(SERVER_KEY')).toBe(true)
  })

  it('scrollnat is a setting, not an instrument — it must not go through queryFlag', () => {
    expect(src.has("queryFlag('scrollnat')")).toBe(false)
    // …and it is announced on the boot line, like every other resolved setting.
    expect(src.has('scroll=${scrollNatLabel(padScrollNatural)}')).toBe(true)
  })
})

describe('every resolver records its source (source scan)', () => {
  it('notes every setting, so none can go stale invisibly', () => {
    expect(src.has("noteFlag('server'")).toBe(true)
    // invert comes through initFlag, which notes on its behalf.
    expect(src.has('noteFlag(name, flagSource(')).toBe(true)
  })

  it('prints the sticky line at boot', () => {
    expect(src.has('stickyLine(stickyFlags)')).toBe(true)
  })
})
