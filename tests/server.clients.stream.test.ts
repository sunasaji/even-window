// pinhole-window — who is enrolled, on the wire (`{t:'clients'}`, docs/protocol.md,
// docs/security.md).
//
// Every connected device is told who is enrolled, and the phone compares that against what it
// saw last time. Two properties are pinned:
//   1. The public key does not travel. The event is built by `clientsWire`, not by spreading
//      the registry object.
//   2. The change key is order-insensitive and name-sensitive: a rewrite that only reorders
//      entries is not a change; a rename, and a flip of EW_AUTH, are.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addClient, type Client, listClients, removeClient } from '../src/server/auth.ts'
import { clientsKey, clientsWire } from '../src/server/main.ts'
import { makeEd25519Key, makeP256Key, useTempStateDir } from './authFixture.ts'

let dispose: () => void
let prevMax: string | undefined
beforeEach(() => {
  dispose = useTempStateDir()
  prevMax = process.env.EW_MAX_CLIENTS
})
afterEach(() => {
  if (prevMax === undefined) delete process.env.EW_MAX_CLIENTS
  else process.env.EW_MAX_CLIENTS = prevMax
  dispose()
})

describe('clientsWire — what the phone is told', () => {
  it('carries id, name and addedAt, and never the public key', () => {
    const key = makeEd25519Key()
    addClient(key.pub, 'my-phone')
    const [row] = clientsWire(listClients())
    expect(row).toBeDefined()
    expect(row).toMatchObject({ name: 'my-phone' })
    expect(typeof row!.id).toBe('string')
    expect(typeof row!.addedAt).toBe('number')
    // The property that matters: no key material, under any spelling.
    expect(row).not.toHaveProperty('pub')
    expect(JSON.stringify(row)).not.toContain(key.pub.x)
    expect(Object.keys(row!).sort()).toEqual(['addedAt', 'id', 'name'])
  })

  it('passes addedIp through when the registry has one, and omits it otherwise', () => {
    const withIp: Client = {
      id: 'a'.repeat(64),
      name: 'phone',
      pub: makeEd25519Key().pub,
      addedAt: 1,
      addedIp: '10.0.0.9',
    }
    expect(clientsWire([withIp])[0]).toMatchObject({ addedIp: '10.0.0.9' })
    expect(clientsWire([{ ...withIp, addedIp: undefined }])[0]).not.toHaveProperty('addedIp')
  })

  it('is empty for an empty registry — a real answer, not a missing one', () => {
    expect(clientsWire(listClients())).toEqual([])
  })
})

describe('clientsKey — when a change is published', () => {
  const rows = [
    { id: 'a'.repeat(64), name: 'phone', addedAt: 1 },
    { id: 'b'.repeat(64), name: 'laptop', addedAt: 2 },
  ]

  it('ignores order: a rewrite that only reorders the file is not an event', () => {
    expect(clientsKey(rows, true)).toBe(clientsKey([...rows].reverse(), true))
  })

  it('ignores addedAt: the same keys re-stamped are the same keys', () => {
    expect(clientsKey(rows, true)).toBe(
      clientsKey(
        rows.map(r => ({ ...r, addedAt: 999 })),
        true,
      ),
    )
  })

  it('notices an added key, a removed key, and a rename', () => {
    const base = clientsKey(rows, true)
    expect(clientsKey([...rows, { id: 'c'.repeat(64), name: 'x', addedAt: 3 }], true)).not.toBe(
      base,
    )
    expect(clientsKey(rows.slice(0, 1), true)).not.toBe(base)
    expect(clientsKey([{ ...rows[0]!, name: 'renamed' }, rows[1]!], true)).not.toBe(base)
  })

  it('notices EW_AUTH flipping — the same list means something else when auth is off', () => {
    expect(clientsKey(rows, false)).not.toBe(clientsKey(rows, true))
  })
})

describe('the registry it reports is the real one', () => {
  it('tracks an enrol and a revoke made through the auth module', () => {
    process.env.EW_MAX_CLIENTS = '2'
    const a = makeEd25519Key(),
      b = makeP256Key()
    const ca = addClient(a.pub, 'phone')!
    const first = clientsKey(clientsWire(listClients()), true)

    addClient(b.pub, 'laptop')
    const second = clientsKey(clientsWire(listClients()), true)
    expect(second).not.toBe(first)
    expect(
      clientsWire(listClients())
        .map(c => c.name)
        .sort(),
    ).toEqual(['laptop', 'phone'])

    expect(removeClient(ca.id)).toBe(true)
    const third = clientsKey(clientsWire(listClients()), true)
    expect(third).not.toBe(second)
    expect(clientsWire(listClients()).map(c => c.name)).toEqual(['laptop'])
  })
})
