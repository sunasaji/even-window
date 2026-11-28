// What the client remembers must survive a restart of the Even App, where localStorage is
// emptied. `keep` mirrors each value into the bridge's storage and `wireKv` puts them back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DurableStore } from '../src/client/authClient.ts'
import { keep, resetKv, wireKv } from '../src/client/durableKv.ts'

function fakeStore(blob?: Record<string, unknown>): DurableStore & { kv: Map<string, string> } {
  const kv = new Map<string, string>()
  if (blob) kv.set('pw.kv', JSON.stringify(blob))
  return {
    kv,
    get: async k => kv.get(k) ?? null,
    set: async (k, v) => {
      kv.set(k, v)
    },
  }
}
const saved = (s: { kv: Map<string, string> }): unknown => JSON.parse(s.kv.get('pw.kv') ?? '{}')

let local: Map<string, string>
beforeEach(() => {
  local = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
  })
  resetKv()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('durable key-value mirror', () => {
  it('puts kept values back after a restart emptied localStorage', async () => {
    const restored = await wireKv(fakeStore({ 'pw.tour.seen': '1', 'pw.invert': '1' }))
    expect(local.get('pw.tour.seen')).toBe('1')
    expect(local.get('pw.invert')).toBe('1')
    expect(restored.sort()).toEqual(['pw.invert', 'pw.tour.seen'])
  })

  it('lets a kept value replace a default recorded at boot', async () => {
    keep('pw.invert', '0', false) // the boot-time resolver found nothing and wrote the default
    const store = fakeStore({ 'pw.invert': '1' })
    expect(await wireKv(store)).toEqual(['pw.invert'])
    expect(local.get('pw.invert')).toBe('1')
    expect(saved(store)).toEqual({ 'pw.invert': '1' })
  })

  it('lets a choice made before wiring win over what was kept', async () => {
    keep('pw.invert', '0') // `?invert=0`, or a tap, before the bridge was ready
    const store = fakeStore({ 'pw.invert': '1', 'pw.tour.seen': '1' })
    expect(await wireKv(store)).toEqual(['pw.tour.seen'])
    expect(local.get('pw.invert')).toBe('0')
    expect(saved(store)).toEqual({ 'pw.invert': '0', 'pw.tour.seen': '1' })
  })

  it('mirrors every write once wired, and reports nothing when nothing changed', async () => {
    local.set('pw.tour.seen', '1')
    const store = fakeStore({ 'pw.tour.seen': '1' })
    expect(await wireKv(store)).toEqual([])
    keep('pw.hint.startup', '2')
    keep('pw.keys.acked', '["a"]', false)
    expect(saved(store)).toEqual({
      'pw.tour.seen': '1',
      'pw.hint.startup': '2',
      'pw.keys.acked': '["a"]',
    })
  })

  it('starts over from a damaged or missing entry', async () => {
    const store = fakeStore()
    store.kv.set('pw.kv', '{not json')
    expect(await wireKv(store)).toEqual([])
    keep('pw.tour.seen', '1')
    expect(saved(store)).toEqual({ 'pw.tour.seen': '1' })
    // Non-string members of a well-formed entry are dropped, not restored.
    resetKv()
    local.clear()
    expect(await wireKv(fakeStore({ a: 1, b: null, c: 'ok' }))).toEqual(['c'])
  })

  it('still writes localStorage when there is no bridge at all', () => {
    keep('pw.invert', '1')
    expect(local.get('pw.invert')).toBe('1')
  })
})
