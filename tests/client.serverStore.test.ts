// The chosen server address is mirrored into the bridge's durable store, because the packaged
// app loses localStorage when the Even App is restarted.

import { afterEach, describe, expect, it } from 'vitest'
import type { DurableStore } from '../src/client/authClient.ts'
import { SERVER, serverIsGuess, setServer, wireServerStore } from '../src/client/serverLink.ts'

function fakeStore(
  initial: Record<string, string> = {},
): DurableStore & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial))
  return {
    kv,
    get: async k => kv.get(k) ?? null,
    set: async (k, v) => {
      kv.set(k, v)
    },
  }
}

afterEach(() => {
  setServer('http://localhost:8787', true)
})

describe('wireServerStore', () => {
  it('writes an address somebody chose', async () => {
    setServer('https://host.ts.net:8443/')
    const store = fakeStore()
    await wireServerStore(store)
    expect(store.kv.get('ew.server')).toBe('https://host.ts.net:8443')
    // And keeps following later changes.
    setServer('https://other.ts.net')
    expect(store.kv.get('ew.server')).toBe('https://other.ts.net')
  })

  it('adopts the kept address when this load is still on the guessed default', async () => {
    setServer('http://localhost:8787', true)
    await wireServerStore(fakeStore({ 'ew.server': 'https://host.ts.net:8443' }))
    expect(SERVER).toBe('https://host.ts.net:8443')
    expect(serverIsGuess).toBe(false)
  })

  it('never stores the guess, and stays on it when nothing was kept', async () => {
    setServer('http://localhost:8787', true)
    const store = fakeStore()
    await wireServerStore(store)
    expect(SERVER).toBe('http://localhost:8787')
    expect(serverIsGuess).toBe(true)
    expect(store.kv.size).toBe(0)
  })

  it('stays on the guess when the store fails', async () => {
    setServer('http://localhost:8787', true)
    await wireServerStore({
      get: async () => {
        throw new Error('bridge gone')
      },
      set: async () => {},
    })
    expect(serverIsGuess).toBe(true)
  })
})
