// pinhole-window — session binding: the signed material names the destination
// (src/shared/sessionBinding.ts, docs/decisions/session-origin-binding.md).
//
// The attack: a paired device is pointed at an attacker's API base, the attacker feeds it a
// nonce fetched from the real server, the device signs, and the attacker redeems that
// signature upstream. The defence is that the device signs where it thinks it is sending and
// the real server refuses a signature made out to anywhere else.
//
// Pinned here, because each one is a way the check could become decorative:
//   * a signature for another origin is refused when EW_ORIGIN is set;
//   * the body's `origin` field is not trusted — it is folded back into the signed material;
//   * EW_ORIGIN is compared after canonicalisation;
//   * `EW_ORIGIN=*` (a CORS habit) is not "allow anything";
//   * there is no bare-nonce fallback.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addClient,
  canonicalOrigin,
  issueChallenge,
  redeemSession,
  sessionBindingStatus,
} from '../src/server/auth.ts'
import { normaliseOrigin, sessionMaterial } from '../src/shared/sessionBinding.ts'
import { makeEd25519Key, makeP256Key, type TestKey, useTempStateDir } from './authFixture.ts'

const REAL = 'https://host.ts.net:8443'
const EVIL = 'http://attacker.example'

let dispose: () => void
let prevOrigin: string | undefined
let prevMax: string | undefined
beforeEach(() => {
  dispose = useTempStateDir()
  prevOrigin = process.env.EW_ORIGIN
  prevMax = process.env.EW_MAX_CLIENTS
})
afterEach(() => {
  if (prevOrigin === undefined) delete process.env.EW_ORIGIN
  else process.env.EW_ORIGIN = prevOrigin
  if (prevMax === undefined) delete process.env.EW_MAX_CLIENTS
  else process.env.EW_MAX_CLIENTS = prevMax
  dispose()
})

/** Enrol `key` and redeem a challenge the way a device at `claimed` would. `sent` defaults to
 *  `claimed`; passing them apart is the attacker who edits the body but cannot re-sign.
 *  Each test reuses one key (`addClient` is idempotent on the fingerprint), so the default
 *  `EW_MAX_CLIENTS=1` cap stays in force; a test that needs a second enrollment raises the
 *  cap explicitly. */
function redeem(key: TestKey, claimed: string, sent = claimed): ReturnType<typeof redeemSession> {
  const c = addClient(key.pub)
  const { nonce } = issueChallenge()
  const sig = key.sign(sessionMaterial(c!.id, claimed, nonce))
  return redeemSession(c!.id, nonce, sig, sent)
}

describe('EW_ORIGIN unset — verify the signature, skip the comparison', () => {
  it('accepts a bound signature naming any origin (loopback dev, the EW_AUTH=0 harness)', () => {
    delete process.env.EW_ORIGIN
    expect(canonicalOrigin()).toBe('')
    const key = makeEd25519Key()
    expect(redeem(key, REAL)).not.toBeNull()
    expect(redeem(key, 'http://localhost:8787')).not.toBeNull()
    expect(redeem(key, '')).not.toBeNull()
  })
})

describe('EW_ORIGIN set — a signature made out to somewhere else is refused', () => {
  beforeEach(() => {
    process.env.EW_ORIGIN = REAL
  })

  it('accepts the device that named this server', () => {
    expect(redeem(makeEd25519Key(), REAL)).not.toBeNull()
  })

  it('accepts a P-256 device too (the WebView fallback key type)', () => {
    expect(redeem(makeP256Key(), REAL)).not.toBeNull()
  })

  it('refuses the relay: a valid signature from an enrolled key, made out to the attacker', () => {
    // The whole attack: the key is enrolled, the nonce is this server's, the signature
    // verifies — and it still fails, because the device named another destination.
    expect(redeem(makeEd25519Key(), EVIL)).toBeNull()
  })

  it('refuses an unbound claim (origin omitted) once a canonical origin is configured', () => {
    expect(redeem(makeEd25519Key(), '')).toBeNull()
  })

  it('does not let the body steer the comparison: the signature covers the origin', () => {
    // The attacker relays a signature made for EVIL and rewrites the body to say REAL. The
    // server rebuilds the material from the body, so the signature no longer verifies.
    const key = makeEd25519Key()
    expect(redeem(key, EVIL, REAL)).toBeNull()
    // …and the mirror image (signed for REAL, body says EVIL) fails for the same reason.
    expect(redeem(key, REAL, EVIL)).toBeNull()
  })

  it('leaves the nonce unburned when only the origin mismatched', () => {
    // Nothing was proved about this server, so the nonce stays usable for a correct retry.
    const key = makeEd25519Key()
    const c = addClient(key.pub)
    const { nonce } = issueChallenge()
    expect(
      redeemSession(c!.id, nonce, key.sign(sessionMaterial(c!.id, EVIL, nonce)), EVIL),
    ).toBeNull()
    // Same nonce, now used correctly: still live.
    expect(
      redeemSession(c!.id, nonce, key.sign(sessionMaterial(c!.id, REAL, nonce)), REAL),
    ).not.toBeNull()
  })

  it('compares canonical origins, so cosmetic differences are not mismatches', () => {
    const key = makeEd25519Key()
    expect(redeem(key, 'https://host.ts.net:8443/')).not.toBeNull()
    expect(redeem(key, 'https://host.ts.net:8443/api/auth/session')).not.toBeNull()
    expect(redeem(key, 'https://HOST.TS.NET:8443')).not.toBeNull()
    // A default port written out explicitly is the same origin…
    process.env.EW_ORIGIN = 'https://host.ts.net'
    expect(redeem(key, 'https://host.ts.net:443')).not.toBeNull()
    // …but a different port, or a different scheme, is a different server.
    expect(redeem(key, 'https://host.ts.net:8443')).toBeNull()
    expect(redeem(key, 'http://host.ts.net')).toBeNull()
  })

  it('refuses a bare-nonce signature — there is no downgrade path', () => {
    // Accepting a bare-nonce signature would restore the relay.
    const key = makeEd25519Key()
    const c = addClient(key.pub)
    const { nonce } = issueChallenge()
    expect(redeemSession(c!.id, nonce, key.sign(nonce), REAL)).toBeNull()
    expect(redeemSession(c!.id, nonce, key.sign(nonce), '')).toBeNull()
  })

  it('refuses material whose version tag is not ours', () => {
    const key = makeEd25519Key()
    const c = addClient(key.pub)
    const { nonce } = issueChallenge()
    const forged = ['ew-session-v2', c!.id, REAL, nonce].join('\n')
    expect(redeemSession(c!.id, nonce, key.sign(forged), REAL)).toBeNull()
  })

  it('refuses material that names another client id', () => {
    // The id is inside the signature, so a signature made for one enrollment cannot be offered
    // as another's. Both keys are enrolled, which needs two slots: the cap is raised here.
    process.env.EW_MAX_CLIENTS = '2'
    const a = makeEd25519Key(),
      b = makeEd25519Key()
    const ca = addClient(a.pub),
      cb = addClient(b.pub)
    const { nonce } = issueChallenge()
    expect(
      redeemSession(ca!.id, nonce, a.sign(sessionMaterial(cb!.id, REAL, nonce)), REAL),
    ).toBeNull()
  })
})

describe('normaliseOrigin', () => {
  it('keeps scheme, host and a non-default port, and nothing else', () => {
    expect(normaliseOrigin('https://host.ts.net:8443/api?x=1#y')).toBe('https://host.ts.net:8443')
    expect(normaliseOrigin('  http://localhost:8787  ')).toBe('http://localhost:8787')
    expect(normaliseOrigin('https://host.ts.net:443')).toBe('https://host.ts.net')
    expect(normaliseOrigin('HTTP://LOCALHOST:8787')).toBe('http://localhost:8787')
  })

  it('refuses anything that is not a usable absolute origin', () => {
    // `*` is the CORS wildcard. It is not an identity, and it must not become one here.
    for (const v of [
      '',
      '   ',
      '*',
      'host.ts.net:8443',
      '/api',
      'file:///tmp/x',
      undefined,
      null,
    ]) {
      expect(normaliseOrigin(v), JSON.stringify(v)).toBe('')
    }
  })
})

describe('sessionBindingStatus — an unenforced control says so', () => {
  it('reports enforced with the canonical origin when EW_ORIGIN is a URL', () => {
    const s = sessionBindingStatus('https://host.ts.net:8443/')
    expect(s.enforced).toBe(true)
    expect(s.origin).toBe(REAL)
    expect(s.line).toMatch(/ENFORCED/)
    expect(s.line).toContain(REAL)
  })

  it('reports not enforced, and how to fix it, when EW_ORIGIN is unset', () => {
    const s = sessionBindingStatus(undefined)
    expect(s.enforced).toBe(false)
    expect(s.line).toMatch(/NOT enforced/)
    expect(s.line).toMatch(/EW_ORIGIN/)
  })

  it('never reads a misconfigured value as enforced, and quotes what it got', () => {
    for (const v of ['*', 'host.ts.net', 'yes']) {
      const s = sessionBindingStatus(v)
      expect(s.enforced, v).toBe(false)
      expect(s.line, v).toMatch(/NOT enforced/)
      expect(s.line, v).toContain(JSON.stringify(v)) // the operator sees their own typo
    }
  })
})
