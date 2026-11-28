// The server list (src/client/targets.ts, src/client/root.ts): what is kept, how it is drawn on
// the lens, and when a page load starts at it.

import { describe, expect, it } from 'vitest'
import { startsAtRoot } from '../src/client/root.ts'
import {
  parseTargets,
  rootText,
  TARGETS_MAX,
  targetLabel,
  withoutTarget,
  withTarget,
} from '../src/client/targets.ts'
import { glassWidth, LINE_UNITS, PANEL_LINES } from '../src/shared/voiceDialog.ts'

describe('the stored list', () => {
  it('reads a JSON array of strings and nothing else', () => {
    expect(parseTargets('["http://a:1","http://b:2"]')).toEqual(['http://a:1', 'http://b:2'])
    expect(parseTargets(null)).toEqual([])
    expect(parseTargets('not json')).toEqual([])
    expect(parseTargets('{"a":1}')).toEqual([])
    expect(parseTargets('["http://a:1", 3, ""]')).toEqual(['http://a:1'])
  })

  it('adds an address once and keeps its place', () => {
    expect(withTarget([], 'http://a:1')).toEqual(['http://a:1'])
    expect(withTarget(['http://a:1', 'http://b:2'], 'http://a:1')).toEqual([
      'http://a:1',
      'http://b:2',
    ])
    expect(withTarget(['http://a:1'], '')).toEqual(['http://a:1'])
  })

  it('never grows past what the panel can show', () => {
    let list: string[] = []
    for (let i = 0; i < TARGETS_MAX + 3; i++) list = withTarget(list, `http://h${String(i)}:1`)
    expect(list).toHaveLength(TARGETS_MAX)
    expect(list.at(-1)).toBe(`http://h${String(TARGETS_MAX + 2)}:1`) // the newest stays
  })

  it('removes an address', () => {
    expect(withoutTarget(['http://a:1', 'http://b:2'], 'http://a:1')).toEqual(['http://b:2'])
  })
})

describe('the list on the lens', () => {
  it('names a server by its whole origin, scheme included', () => {
    expect(targetLabel('https://pc.tail.ts.net:8443/')).toBe('https://pc.tail.ts.net:8443')
    expect(targetLabel('http://pc:8787')).toBe('http://pc:8787')
  })

  it('shows a usual tailnet origin whole', () => {
    const origin = 'https://z4ub.tail6d0f77.ts.net:8443'
    expect(rootText([origin], 0).split('\n')[1]).toBe(`> ${origin}`)
  })

  it('fits the panel at its fullest, with the cursor on one row', () => {
    const list = Array.from(
      { length: TARGETS_MAX },
      (_v, i) => `https://a-rather-long-machine-name-${String(i)}.some-tailnet-name.ts.net:8443`,
    )
    const lines = rootText(list, 2).split('\n')
    expect(lines.length).toBeLessThanOrEqual(PANEL_LINES)
    for (const l of lines) expect(glassWidth(l)).toBeLessThan(LINE_UNITS)
    expect(lines.filter(l => l.startsWith('>'))).toHaveLength(1)
    expect(lines[3]?.startsWith('>')).toBe(true)
    // The header states the two gestures: this is the top, and a double-tap leaves the app.
    expect(lines[0]).toContain('tap=open')
    expect(lines[0]).toContain('dbl=exit')
  })

  it('says how to add a server when there is none, and how to leave', () => {
    const lines = rootText([], 0).split('\n')
    expect(lines.length).toBeLessThanOrEqual(PANEL_LINES)
    for (const l of lines) expect(glassWidth(l)).toBeLessThan(LINE_UNITS)
    expect(lines.join('\n')).toContain('ew-auth.mjs pair')
    expect(lines.at(-1)).toContain('double-tap: exit')
  })
})

describe('where a page load starts', () => {
  it('starts at the list with no query, as the packaged app always does', () => {
    expect(startsAtRoot('')).toBe(true)
    expect(startsAtRoot('?tour=0&invert=1')).toBe(true)
  })

  it('opens directly when the URL names a server or carries a pairing code', () => {
    expect(startsAtRoot('?server=http://127.0.0.1:8791')).toBe(false)
    expect(startsAtRoot('?pair=ABCD-EFGH')).toBe(false)
    expect(startsAtRoot('?server=')).toBe(true)
  })
})
