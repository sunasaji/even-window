// Browser side of the client auth boundary (see src/server/auth.ts, docs/security.md).
//
// Identity is a WebCrypto keypair: Ed25519 where supported, else ECDSA P-256. In a plain
// browser the private key is non-extractable and lives in IndexedDB. Pairing enrols the
// public key; a session is obtained by signing a server challenge together with the origin
// this device believes it is talking to (src/shared/sessionBinding.ts). There is one keypair
// per server. "Paired" means a keypair for the current server exists; unpaired requests go out
// unauthenticated.

import { normaliseOrigin, sessionMaterial } from '../shared/sessionBinding.ts'

const DB_NAME = 'pw-auth',
  STORE = 'keys',
  KEY_ID = 'client'

let base = ''
/** Point the auth handshake at the same origin/base the app uses for /api. */
export function setAuthBase(b: string): void {
  base = b
}

// ── base64url of raw bytes ────────────────────────────────────────────────────
function b64u(buf: ArrayBuffer): string {
  let s = ''
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── IndexedDB (stores the CryptoKeyPair) ───────────────────────────────────────
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
function idbGet<T>(key: string): Promise<T | undefined> {
  return idb().then(
    db =>
      new Promise<T | undefined>((resolve, reject) => {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
        r.onsuccess = () => resolve(r.result as T | undefined)
        r.onerror = () => reject(r.error)
      }),
  )
}
function idbPut(key: string, val: unknown): Promise<void> {
  return idb().then(
    db =>
      new Promise<void>((resolve, reject) => {
        const r = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key)
        r.onsuccess = () => resolve()
        r.onerror = () => reject(r.error)
      }),
  )
}

// ── durable identity store (Even Hub bridge) ──────────────────────────────────
// IndexedDB does not survive a restart of the packaged Even Hub app, so there the keypair is
// generated extractable and its JWK mirrored into the SDK bridge store, then rebuilt from it
// when IndexedDB is empty. A plain browser has no bridge and never writes a JWK.
// See docs/decisions/packaged-app-key-mirror.md.
export interface DurableStore {
  get(key: string): Promise<string | null>
  set(key: string, val: string): Promise<void>
}
const JWK_KEY = 'pw-auth.jwk'
let durable: DurableStore | null = null
/** Wire the durable identity store (the Even bridge). Its presence means "packaged app:
 *  mirror an extractable JWK here". */
export function setDurableStore(s: DurableStore): void {
  durable = s
  // The stream opens before the bridge is ready, so `loadKeypair()` may already have cached
  // "no identity" from an empty IndexedDB. Invalidate those negative results so the next load
  // consults the mirror; a loaded keypair is never dropped.
  for (const [origin, kp] of kpCache) if (kp === null) kpCache.delete(origin)
}
// Rebuild a CryptoKeyPair from a mirrored JWK pair; the in-memory private key is non-extractable.
async function importPair(priv: JsonWebKey, pub: JsonWebKey): Promise<CryptoKeyPair> {
  const algo: AlgorithmIdentifier | EcKeyImportParams =
    priv.kty === 'OKP' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' }
  const privateKey = await crypto.subtle.importKey('jwk', priv, algo, false, ['sign'])
  const publicKey = await crypto.subtle.importKey('jwk', pub, algo, true, ['verify'])
  return { privateKey, publicKey }
}

// ── keypair lifecycle ─────────────────────────────────────────────────────────
// One keypair per server, named by the server's origin. A key enrolled at one server is never
// presented to another, pairing with a second server does not replace the first one's key, and
// forgetting a server discards its key (docs/decisions/one-key-per-server.md).

/** Pure: the suffix that names a server's key in both stores. */
export function keySlot(origin: string): string {
  return origin ? `@${origin}` : ''
}

const kpCache = new Map<string, CryptoKeyPair | null>() // absent = not loaded yet

/** One slot: IndexedDB first, then the durable JWK mirror, which re-seeds IndexedDB. */
async function readSlot(slot: string): Promise<CryptoKeyPair | null> {
  let kp: CryptoKeyPair | null = null
  try {
    kp = (await idbGet<CryptoKeyPair>(KEY_ID + slot)) ?? null
  } catch {
    kp = null
  }
  if (kp || !durable) return kp
  try {
    const raw = await durable.get(JWK_KEY + slot)
    if (!raw) return null
    const { priv, pub } = JSON.parse(raw) as { priv: JsonWebKey; pub: JsonWebKey }
    kp = await importPair(priv, pub)
    try {
      await idbPut(KEY_ID + slot, kp)
    } catch {
      /* ignore */
    }
  } catch {
    return null
  }
  return kp
}

async function loadKeypair(): Promise<CryptoKeyPair | null> {
  const origin = authOrigin()
  const hit = kpCache.get(origin)
  if (hit !== undefined) return hit
  const kp = await readSlot(keySlot(origin))
  kpCache.set(origin, kp)
  return kp
}
/** Has this device been paired with the current server (a key for it exists)? */
export async function isPaired(): Promise<boolean> {
  return (await loadKeypair()) != null
}

/** Create and persist a fresh identity for the current server, returning the public key JWK to
 *  enrol. Prefers Ed25519, falling back to ECDSA P-256. The private key is extractable only
 *  when a durable store is wired up (see `DurableStore`). */
export async function generateKeypair(): Promise<JsonWebKey> {
  const origin = authOrigin()
  const slot = keySlot(origin)
  const extractable = durable != null // only mirrored keys need to be extractable
  let kp: CryptoKeyPair
  try {
    kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, extractable, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
  } catch {
    kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, extractable, [
      'sign',
      'verify',
    ])
  }
  await idbPut(KEY_ID + slot, kp)
  kpCache.set(origin, kp)
  if (durable && extractable) {
    try {
      const priv = await crypto.subtle.exportKey('jwk', kp.privateKey)
      const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
      await durable.set(JWK_KEY + slot, JSON.stringify({ priv, pub }))
    } catch {
      /* ignore: IndexedDB still holds it for this session */
    }
  }
  resetSession()
  return await crypto.subtle.exportKey('jwk', kp.publicKey)
}

/** Ask a server to drop this device's enrolment, signed with the key kept for that server.
 *  Used when the phone forgets a server, before the key itself is discarded. `failed` covers a
 *  server that does not answer: the enrolment then stays until it is revoked on the host. */
export async function revokeSelf(server: string): Promise<'revoked' | 'no-key' | 'failed'> {
  const keep = base
  const work = async (): Promise<'revoked' | 'no-key' | 'failed'> => {
    base = server
    resetSession()
    if (!(await loadKeypair())) return 'no-key'
    const tok = await bearer()
    if (!tok) return 'failed'
    const r = await fetch(`${server}/api/auth/revoke-self`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}` },
    })
    if (!r.ok) return 'failed'
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean }
    return j.ok ? 'revoked' : 'failed'
  }
  try {
    // Bounded: an address that leads nowhere must not hold the row on the screen.
    return await Promise.race([
      work(),
      new Promise<'failed'>(resolve => {
        setTimeout(() => {
          resolve('failed')
        }, REVOKE_TIMEOUT_MS)
      }),
    ])
  } catch {
    return 'failed'
  } finally {
    base = keep
    resetSession()
  }
}
const REVOKE_TIMEOUT_MS = 6000

/** Discard the key kept for a server: the phone forgot that server (phoneUi.ts). The enrolment
 *  on the server stays until it is revoked there, but nothing here can use it any more. */
export async function forgetKey(server: string): Promise<void> {
  const origin = normaliseOrigin(server)
  if (!origin) return
  kpCache.delete(origin)
  try {
    const db = await idb()
    await new Promise<void>((resolve, reject) => {
      const r = db
        .transaction(STORE, 'readwrite')
        .objectStore(STORE)
        .delete(KEY_ID + keySlot(origin))
      r.onsuccess = () => resolve()
      r.onerror = () => reject(r.error)
    })
  } catch {
    /* ignore */
  }
  try {
    await durable?.set(JWK_KEY + keySlot(origin), '')
  } catch {
    /* ignore */
  }
}
// Sign params matching the keypair's algorithm (Ed25519 has no separate hash).
function signAlgo(kp: CryptoKeyPair): AlgorithmIdentifier | EcdsaParams {
  return kp.privateKey.algorithm.name === 'Ed25519'
    ? { name: 'Ed25519' }
    : { name: 'ECDSA', hash: 'SHA-256' }
}
/** The public key JWK, or null if unpaired. */
export async function publicJwk(): Promise<JsonWebKey | null> {
  const kp = await loadKeypair()
  if (!kp) return null
  return await crypto.subtle.exportKey('jwk', kp.publicKey)
}
/** Stable client id: SHA-256 of the public-key coordinates. Must match src/server/auth.ts
 *  and scripts/pw-auth.mjs: OKP (Ed25519) uses only `x`; EC (P-256) uses `x` and `y`. */
export async function clientId(): Promise<string | null> {
  const jwk = await publicJwk()
  if (!jwk) return null
  const material = jwk.kty === 'OKP' ? `${jwk.crv}:${jwk.x}` : `${jwk.crv}:${jwk.x}:${jwk.y}`
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)))
}

// ── session token (challenge → sign → token), cached in memory ─────────────────
let token: string | null = null
let tokenExp = 0
let inflight: Promise<string | null> | null = null
/** Drop the cached session token (on 401 / expiry / re-pair). */
export function resetSession(): void {
  token = null
  tokenExp = 0
}

/** The origin this device believes it is talking to: the API base, else our own origin.
 *  It is part of the signed material (src/shared/sessionBinding.ts), so a signature obtained
 *  by a relay under another origin is refused by the real server. */
export function authOrigin(): string {
  const fromBase = normaliseOrigin(base)
  if (fromBase) return fromBase
  try {
    return normaliseOrigin(location.origin)
  } catch {
    return ''
  }
}

async function establish(): Promise<string | null> {
  const kp = await loadKeypair()
  if (!kp) return null
  try {
    const ch = (await (await fetch(base + '/api/auth/challenge')).json()) as { nonce?: string }
    if (!ch.nonce) return null
    const cid = await clientId()
    const origin = authOrigin()
    const material = sessionMaterial(cid ?? '', origin, ch.nonce)
    const sig = b64u(
      await crypto.subtle.sign(signAlgo(kp), kp.privateKey, new TextEncoder().encode(material)),
    )
    const r = await fetch(base + '/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: cid, nonce: ch.nonce, sig, origin }),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { token?: string; exp?: number }
    if (!j.token) return null
    token = j.token
    tokenExp = j.exp ?? 0
    return token
  } catch {
    return null
  }
}

// ── pairing (device side of the strict approve-then-enroll flow) ───────────────
/** Generate this device's identity and submit its public key against the one-time code from
 *  the pairing URL. The returned `id` and `art` are the server's claim: the caller draws its
 *  grid from this device's own key and uses them only as a cross-check (`pairingArtView`). */
export async function submitPairing(code: string): Promise<{
  status: string
  id?: string
  art?: string
  error?: string
  /** Keys enrolled and the cap (0 = uncapped), so the dialog can warn that approval will be refused. */
  slots?: { used: number; max: number }
}> {
  const pub = await generateKeypair() // fresh identity
  try {
    const r = await fetch(base + '/api/auth/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, pub }),
    })
    return (await r.json()) as {
      status: string
      id?: string
      art?: string
      error?: string
      slots?: { used: number; max: number }
    }
  } catch (e) {
    return { status: 'error', error: String(e) }
  }
}
/** Poll enrolment status for a device id: 'pending' | 'approved' | 'rejected' | 'unknown'. */
export async function pairStatus(id: string): Promise<string> {
  try {
    const j = (await (
      await fetch(base + '/api/auth/pair/status?id=' + encodeURIComponent(id))
    ).json()) as { status?: string }
    return j.status || 'unknown'
  } catch {
    return 'unknown'
  }
}

/** A short-lived ticket for the SSE stream, or null when unpaired or unreachable.
 *  `EventSource` cannot set headers, so the stream credential travels in the URL; the ticket
 *  opens the stream and nothing else, and the session token never goes there. Fetch one
 *  immediately before each `new EventSource(...)`: an automatic reconnect reuses the URL and
 *  is refused once the ticket has expired (docs/decisions/stream-ticket.md). */
export async function streamTicket(): Promise<string | null> {
  const tok = await bearer()
  if (!tok) return null
  try {
    const r = await fetch(base + '/api/auth/ticket', {
      headers: { authorization: `Bearer ${tok}` },
    })
    if (!r.ok) return null
    const j = (await r.json()) as { ticket?: string }
    return j.ticket || null
  } catch {
    return null
  }
}

/** A valid bearer token, establishing a session if needed; null when unpaired or the
 *  handshake fails. Concurrent callers share one in-flight handshake. */
export async function bearer(): Promise<string | null> {
  if (token && Date.now() < tokenExp - 60_000) return token // 60 s skew margin
  if (!(await isPaired())) return null
  if (!inflight)
    inflight = establish().finally(() => {
      inflight = null
    })
  return inflight
}
