// pinhole-window — the start-up banner's transport warning (src/server/main.ts).
//
// Pinned: `EW_AUTH` on (the default) plus a published `EW_HOST` must warn, because auth is
// not a channel — on a plain HTTP bind the bearer token is replayable off the wire and nothing
// proves this host to the device. Loopback stays silent, and the EW_AUTH=0 case stays silent
// here because its own banner covers it.

import { describe, expect, it } from 'vitest'
import { transportWarning } from '../src/server/main.ts'

describe('transportWarning', () => {
  it('says nothing for a loopback bind, in any spelling', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(transportWarning(h, true), h).toEqual([])
    }
  })

  it('warns when auth is on and the bind is reachable off this machine', () => {
    const lines = transportWarning('0.0.0.0', true)
    expect(lines.length).toBeGreaterThan(0)
    const text = lines.join('\n')
    // It is plaintext, auth does not fix that, and what to do about it.
    expect(text).toMatch(/PLAIN HTTP/)
    expect(text).toMatch(/replayable/)
    expect(text).toMatch(/tailscale serve/)
    expect(text).toMatch(/0\.0\.0\.0/)
  })

  it('warns for a specific LAN address too, not just the wildcard', () => {
    expect(transportWarning('192.168.3.2', true).join('\n')).toMatch(/192\.168\.3\.2/)
  })

  it('stays quiet when auth is off — that banner owns the case and says more', () => {
    expect(transportWarning('0.0.0.0', false)).toEqual([])
    expect(transportWarning('192.168.3.2', false)).toEqual([])
  })
})
