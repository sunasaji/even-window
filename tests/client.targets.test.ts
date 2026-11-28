// The server list (src/client/targets.ts, src/client/root.ts): what is kept, how it is drawn on
// the lens, and when a page load starts at it.

import { describe, expect, it } from 'vitest'
import { keySlot } from '../src/client/authClient.ts'
import { startsAtRoot } from '../src/client/root.ts'
import {
  cleanName,
  NAME_MAX,
  originLabel,
  parseTargets,
  rootText,
  TARGETS_MAX,
  type Target,
  targetLabel,
  withName,
  withoutTarget,
  withTarget,
} from '../src/client/targets.ts'
import { glassWidth, LINE_UNITS, PANEL_LINES } from '../src/shared/voiceDialog.ts'

const T = (server: string, name?: string): Target => (name ? { server, name } : { server })

describe('the stored list', () => {
  it('reads entries with and without a name, and the bare strings of the first version', () => {
    expect(parseTargets('[{"server":"http://a:1","name":"desk"},{"server":"http://b:2"}]')).toEqual(
      [T('http://a:1', 'desk'), T('http://b:2')],
    )
    expect(parseTargets('["http://a:1","http://b:2"]')).toEqual([T('http://a:1'), T('http://b:2')])
    expect(parseTargets(null)).toEqual([])
    expect(parseTargets('not json')).toEqual([])
    expect(parseTargets('{"a":1}')).toEqual([])
    expect(parseTargets('["http://a:1", 3, "", {"name":"x"}, {"server":""}]')).toEqual([
      T('http://a:1'),
    ])
  })

  it('adds an address once and keeps its place and its name', () => {
    expect(withTarget([], 'http://a:1')).toEqual([T('http://a:1')])
    const named = [T('http://a:1', 'desk'), T('http://b:2')]
    expect(withTarget(named, 'http://a:1')).toEqual(named)
    expect(withTarget([T('http://a:1')], '')).toEqual([T('http://a:1')])
  })

  it('never grows past what the panel can show', () => {
    let list: Target[] = []
    for (let i = 0; i < TARGETS_MAX + 3; i++) list = withTarget(list, `http://h${String(i)}:1`)
    expect(list).toHaveLength(TARGETS_MAX)
    expect(list.at(-1)?.server).toBe(`http://h${String(TARGETS_MAX + 2)}:1`) // the newest stays
  })

  it('removes an address', () => {
    expect(withoutTarget([T('http://a:1'), T('http://b:2')], 'http://a:1')).toEqual([
      T('http://b:2'),
    ])
  })

  it('names a server, trims the name, and clears it with an empty one', () => {
    const list = [T('http://a:1'), T('http://b:2')]
    const named = withName(list, 'http://b:2', '  my   laptop  ')
    expect(named).toEqual([T('http://a:1'), T('http://b:2', 'my laptop')])
    expect(withName(named, 'http://b:2', '   ')).toEqual(list)
    expect(cleanName('x'.repeat(NAME_MAX + 5))).toHaveLength(NAME_MAX)
  })
})

describe('the list on the lens', () => {
  it('shows a name when there is one, and the whole origin otherwise', () => {
    expect(targetLabel(T('https://pc.tail.ts.net:8443/'))).toBe('https://pc.tail.ts.net:8443')
    expect(targetLabel(T('http://pc:8787'))).toBe('http://pc:8787')
    expect(targetLabel(T('http://pc:8787', 'desk'))).toBe('desk')
    expect(originLabel('http://pc:8787/')).toBe('http://pc:8787')
  })

  it('shows a usual tailnet origin whole', () => {
    const origin = 'https://z4ub.tail6d0f77.ts.net:8443'
    expect(rootText([T(origin)], 0).split('\n')[1]).toBe(`> ${origin}`)
  })

  it('fits the panel at its fullest, with the cursor on one row', () => {
    const list = Array.from({ length: TARGETS_MAX }, (_v, i) =>
      i % 2
        ? T(`https://h${String(i)}.ts.net:8443`, 'W'.repeat(NAME_MAX))
        : T(`https://a-rather-long-machine-name-${String(i)}.some-tailnet-name.ts.net:8443`),
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

describe('one key per server', () => {
  it('names a key by the origin of its server, and the old single key by nothing', () => {
    expect(keySlot('https://pc.ts.net:8443')).toBe('@https://pc.ts.net:8443')
    expect(keySlot('https://pc.ts.net:8443')).not.toBe(keySlot('http://pc.ts.net:8443'))
    expect(keySlot('')).toBe('')
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
