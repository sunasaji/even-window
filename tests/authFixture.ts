// Shared fixture for the auth tests: a throwaway state dir, a real keypair, and the real
// challenge→sign→redeem handshake. No mocks: every signature is produced by node:crypto and
// verified by src/server/auth.ts's own code path.

import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addClient, type ClientJwk, issueChallenge, redeemSession } from '../src/server/auth.ts'
import { sessionMaterial } from '../src/shared/sessionBinding.ts'

/** A freshly generated client identity plus the ability to sign as it. */
export interface TestKey {
  pub: ClientJwk
  /** Sign the UTF-8 bytes of `data` exactly as the browser's WebCrypto would:
   *  Ed25519 = pure EdDSA (null hash); P-256 = SHA-256 over the raw r||s encoding. */
  sign(data: string): string
}

/** Ed25519 — what a modern WebView enrolls. */
export function makeEd25519Key(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    pub: publicKey.export({ format: 'jwk' }) as unknown as ClientJwk,
    sign: data => cryptoSign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64url'),
  }
}

/** ECDSA P-256 — the documented fallback for WebViews without Ed25519 WebCrypto. */
export function makeP256Key(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    pub: publicKey.export({ format: 'jwk' }) as unknown as ClientJwk,
    sign: data =>
      cryptoSign('sha256', Buffer.from(data, 'utf8'), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
  }
}

/** Point PINHOLE_STATE_DIR at a fresh temp dir and return a disposer. Every auth test must do
 *  this: the module reads the dir per call, so the real ~/.pinhole-window registry is never
 *  touched and tests cannot see each other's keys. */
export function useTempStateDir(): () => void {
  const prev = process.env.PINHOLE_STATE_DIR
  const dir = mkdtempSync(join(tmpdir(), 'pw-auth-test-'))
  process.env.PINHOLE_STATE_DIR = dir
  return () => {
    if (prev === undefined) delete process.env.PINHOLE_STATE_DIR
    else process.env.PINHOLE_STATE_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Enrol a key and walk the real handshake: challenge → sign → redeem. Returns the bearer
 *  token. Throws if any step fails, so a broken happy path cannot turn a negative test into
 *  a false pass.
 *  `origin` is what the device claims to be talking to and goes inside the signature
 *  (src/shared/sessionBinding.ts). The default `''` is the "no PINHOLE_ORIGIN configured" case. */
export function enrolAndSession(
  key: TestKey,
  origin = '',
): { clientId: string; token: string; exp: number } {
  const c = addClient(key.pub)
  if (!c) throw new Error('addClient rejected a freshly generated key')
  const { nonce } = issueChallenge()
  const r = redeemSession(c.id, nonce, key.sign(sessionMaterial(c.id, origin, nonce)), origin)
  if (!r) throw new Error('redeemSession refused a valid signature over a live nonce')
  return { clientId: c.id, token: r.token, exp: r.exp }
}
