// The server list (src/client/targets.ts, src/client/root.ts): what is kept, how it is drawn on
// the lens, and when a page load starts at it.

import { describe, expect, it } from 'vitest'
import { keySlot } from '../src/client/authClient.ts'
import { startsAtRoot } from '../src/client/root.ts'
import {
  cleanName,
  lensLabel,
  NAME_MAX,
  originLabel,
  parseTargets,
  ROOT_PAGE_ROWS,
  rootPageOf,
  rootPages,
  rootText,
  type Target,
  targetLabel,
  withName,
  withoutTarget,
  withTarget,
} from '../src/client/targets.ts'
import { glassWidth, LINE_UNITS, PANEL_LINES } from '../src/shared/voiceDialog.ts'

const T = (server: string, name?: string): Target => (name ? { server, name } : { server })

describe('the stored list', () => {
  it('reads entries with and without a name, and drops anything else', () => {
    expect(parseTargets('[{"server":"http://a:1","name":"desk"},{"server":"http://b:2"}]')).toEqual(
      [T('http://a:1', 'desk'), T('http://b:2')],
    )
    expect(parseTargets('["http://a:1","http://b:2"]')).toEqual([])
    expect(parseTargets(null)).toEqual([])
    expect(parseTargets('not json')).toEqual([])
    expect(parseTargets('{"a":1}')).toEqual([])
    expect(
      parseTargets('[3, "", {"name":"x"}, {"server":""}, {"server":"http://a:1","name":7}]'),
    ).toEqual([T('http://a:1')])
  })

  it('adds an address once and keeps its place and its name', () => {
    expect(withTarget([], 'http://a:1')).toEqual([T('http://a:1')])
    const named = [T('http://a:1', 'desk'), T('http://b:2')]
    expect(withTarget(named, 'http://a:1')).toEqual(named)
    expect(withTarget([T('http://a:1')], '')).toEqual([T('http://a:1')])
  })

  it('has no limit: a new address goes to the end and nothing is dropped', () => {
    let list: Target[] = []
    for (let i = 0; i < 25; i++) list = withTarget(list, `http://h${String(i)}:1`)
    expect(list).toHaveLength(25)
    expect(list[0]?.server).toBe('http://h0:1')
    expect(list.at(-1)?.server).toBe('http://h24:1')
    expect(parseTargets(JSON.stringify(list))).toHaveLength(25)
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

  it('shows a usual tailnet origin whole, and after a name in brackets', () => {
    const origin = 'https://z4ub.tail6d0f77.ts.net:8443'
    expect(rootText([T(origin)], 0).split('\n')[1]).toBe(`> ${origin}`)
    expect(lensLabel(T(origin, 'z4ub'))).toBe(`z4ub (${origin})`)
    expect(rootText([T(origin, 'z4ub')], 0).split('\n')[1]).toBe(`> z4ub (${origin})`)
  })

  it('cuts a row that is too wide at its end, so the name survives', () => {
    const row = rootText(
      [T('https://a-long-host.some-tailnet.ts.net:8443', 'W'.repeat(NAME_MAX))],
      0,
    ).split('\n')[1]!
    expect(glassWidth(row)).toBeLessThan(LINE_UNITS)
    expect(row.startsWith(`> ${'W'.repeat(NAME_MAX)}`)).toBe(true)
  })

  const many = (n: number): Target[] =>
    Array.from({ length: n }, (_v, i) =>
      i % 2
        ? T(`https://h${String(i)}.ts.net:8443`, `${'W'.repeat(NAME_MAX - 3)}${String(i)}`)
        : T(`https://a-rather-long-machine-name-${String(i)}.some-tailnet-name.ts.net:8443`),
    )

  it('fits the panel at its fullest, with the cursor on one row', () => {
    const lines = rootText(many(ROOT_PAGE_ROWS), 2).split('\n')
    expect(lines.length).toBeLessThanOrEqual(PANEL_LINES)
    for (const l of lines) expect(glassWidth(l)).toBeLessThan(LINE_UNITS)
    expect(lines.filter(l => l.startsWith('>'))).toHaveLength(1)
    expect(lines[3]?.startsWith('>')).toBe(true)
    // The header states the two gestures: this is the top, and a double-tap leaves the app.
    expect(lines[0]).toContain('tap=open')
    expect(lines[0]).toContain('dbl=exit')
    expect(lines[0]).not.toMatch(/\d\/\d/) // one page: no page number
  })

  it('shows a longer list a page at a time, the page the cursor is on', () => {
    const list = many(ROOT_PAGE_ROWS * 2 + 3) // three pages, the last one short
    expect(rootPages(list.length)).toBe(3)
    for (const sel of [0, ROOT_PAGE_ROWS - 1, ROOT_PAGE_ROWS, list.length - 1]) {
      const page = rootPageOf(sel, list.length)
      const lines = rootText(list, sel).split('\n')
      expect(lines[0]).toContain(` ${String(page + 1)}/3 `)
      expect(lines.length).toBeLessThanOrEqual(PANEL_LINES)
      for (const l of lines) expect(glassWidth(l)).toBeLessThan(LINE_UNITS)
      // Exactly the cursor's row is marked, and it is the right server.
      const marked = lines.filter(l => l.startsWith('>'))
      expect(marked).toHaveLength(1)
      expect(lines.indexOf(marked[0]!)).toBe(1 + (sel % ROOT_PAGE_ROWS))
    }
    // Swiping down from the last row of a page lands on the first row of the next.
    expect(rootPageOf(ROOT_PAGE_ROWS - 1, list.length)).toBe(0)
    expect(rootPageOf(ROOT_PAGE_ROWS, list.length)).toBe(1)
    expect(rootText(list, list.length - 1).split('\n')).toHaveLength(1 + 3)
  })

  it('says how to add a server when there is none, and how to leave', () => {
    const lines = rootText([], 0).split('\n')
    expect(lines.length).toBeLessThanOrEqual(PANEL_LINES)
    for (const l of lines) expect(glassWidth(l)).toBeLessThan(LINE_UNITS)
    expect(lines.join('\n')).toContain('pw-auth.mjs pair')
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
