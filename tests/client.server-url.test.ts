// How the client guesses its API base when nothing was specified.
//
// `http://localhost:8787` is wrong for a remotely-served page: `localhost` resolves on the
// device running the browser. Behind a single-origin reverse proxy our own origin is correct,
// and it makes every request same-origin.

import { describe, expect, it } from 'vitest'
import { serverChangeNeedsConfirm } from '../src/client/serverGuard.ts'
import { defaultServer, normaliseServer } from '../src/client/serverLink.ts'

const LOOPBACK = 'http://localhost:8787'

describe('defaultServer', () => {
  it('assumes the API is on our own localhost only when the page is on localhost', () => {
    expect(defaultServer('http://localhost:5273', 'localhost:5273')).toBe(LOOPBACK)
    expect(defaultServer('http://127.0.0.1:5273', '127.0.0.1:5273')).toBe(LOOPBACK)
    expect(defaultServer('http://localhost', 'localhost')).toBe(LOOPBACK)
  })

  it('assumes same-origin for a page served from anywhere else', () => {
    // The `tailscale serve` topology.
    expect(defaultServer('https://host.ts.net:8443', 'host.ts.net:8443')).toBe(
      'https://host.ts.net:8443',
    )
    // A LAN address is equally not the phone's localhost.
    expect(defaultServer('http://192.168.3.2:5273', '192.168.3.2:5273')).toBe(
      'http://192.168.3.2:5273',
    )
  })

  it('falls back to loopback when there is no usable origin', () => {
    // file:// and sandboxed iframes report the opaque origin "null".
    expect(defaultServer('null', '')).toBe(LOOPBACK)
    expect(defaultServer('', '')).toBe(LOOPBACK)
  })

  it('never emits a trailing slash, so `${SERVER}/api/x` cannot double up', () => {
    expect(defaultServer('https://host.ts.net:8443/', 'host.ts.net:8443')).toBe(
      'https://host.ts.net:8443',
    )
    expect(normaliseServer('https://host.ts.net:8443/')).toBe('https://host.ts.net:8443')
  })

  it('treats IPv6 loopback as loopback', () => {
    expect(defaultServer('http://[::1]:5273', '[::1]:5273')).toBe(LOOPBACK)
  })
})

// ── `?server=` on a paired device ───────────────────────────────────────────────────────────
//
// `?server=` points the auth handshake at a base, and a paired device proves its identity to
// whatever base it is given, so a link that moves a paired device needs one human tap
// (src/client/serverGuard.ts). The policy must not prompt on the dev/simulator flow, which
// passes the same `?server=` on every launch.

describe('serverChangeNeedsConfirm', () => {
  const ask = (param: string, stored: string, paired: boolean): boolean =>
    serverChangeNeedsConfirm(param, stored, paired, normaliseServer)

  it('asks when a paired device is pointed somewhere else', () => {
    expect(ask('http://attacker.example', 'https://host.ts.net:8443', true)).toBe(true)
  })

  it('never asks an unpaired device: it has no identity to relay', () => {
    expect(ask('http://attacker.example', 'https://host.ts.net:8443', false)).toBe(false)
  })

  it('does not ask when the link agrees with what we already use', () => {
    // The simulator and dev scripts pass `?server=` on every launch; a prompt here would be
    // the prompt that teaches people to tap through prompts.
    expect(ask('https://host.ts.net:8443', 'https://host.ts.net:8443', true)).toBe(false)
    // …including when only the trailing slash differs.
    expect(ask('https://host.ts.net:8443/', 'https://host.ts.net:8443', true)).toBe(false)
  })

  it('does not ask on first contact: no stored base means no choice to override', () => {
    expect(ask('https://host.ts.net:8443', '', true)).toBe(false)
  })

  it('ignores an empty or whitespace param', () => {
    expect(ask('', 'https://host.ts.net:8443', true)).toBe(false)
    expect(ask('   ', 'https://host.ts.net:8443', true)).toBe(false)
  })

  it('asks when only the port or the scheme moves (same host is not the same server)', () => {
    expect(ask('http://host.ts.net:8443', 'https://host.ts.net:8443', true)).toBe(true)
    expect(ask('https://host.ts.net:9999', 'https://host.ts.net:8443', true)).toBe(true)
  })
})
