// auth.ts — client authentication for the pinhole-window API (the auth boundary).
//
// Every /api/* route is effectively remote code execution with the user's privileges
// (`POST /api/spawn` execs an argv, `POST /api/desktop/input` types into a shell), so
// authentication is the only real security boundary. Model: docs/security.md.
//
//   1. Enrollment (pairing): the client's public key (Ed25519, or ECDSA P-256 as fallback) is
//      stored here; the private key never leaves the device.
//   2. Session: the client signs a short-lived challenge nonce together with its id and the
//      origin it believes it is talking to (src/shared/sessionBinding.ts); the server issues a
//      stateless HMAC token keyed by a host-local secret.
//   3. Steady state: `Authorization: Bearer` session token (1h), or a 60-second `?ticket=` for
//      the SSE stream. Both cost one constant-time HMAC check per request.
//
// Enforcement is on by default; `EW_AUTH=0` is for loopback-only development. The state dir,
// the registry and the secret are resolved per call and stat-gated, so a revoked key or a
// rotated secret (`ew-auth rotate`, or deleting the file) takes effect on the next request
// without a restart. Rotation ends live sessions, not enrollments.

import {
  createHash,
  createHmac,
  createPublicKey,
  verify as cryptoVerify,
  type JsonWebKeyInput,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { randomart } from '../shared/randomart.ts'
import { normaliseOrigin, sessionMaterial } from '../shared/sessionBinding.ts'
import { defaultStateDir } from './stateDir.ts'

/** Registry/secret/pairing state. `EW_STATE_DIR` overrides; read per call so the location is
 *  a runtime property, not a module-load one (docs/configuration.md). */
export function stateDir(): string {
  return process.env.EW_STATE_DIR || defaultStateDir()
}
const clientsFile = (): string => join(stateDir(), 'clients.json')
const secretFile = (): string => join(stateDir(), 'server-secret')

const CHALLENGE_TTL_MS = 2 * 60 * 1000 // a nonce is signable for 2 minutes

// ── two kinds of token (docs/decisions/stream-ticket.md) ─────────────────────
// Both are bearer credentials; the lifetime differs because they are carried differently.
//   's' session, in `Authorization: Bearer`: one hour. The client re-establishes silently.
//   't' ticket, in `?ticket=`, because `EventSource` cannot set headers. A URL lands in proxy
//       logs and referrers, so it lives sixty seconds and only opens the stream.
// The kind is inside the MAC and `authClientId` requires it to match where the token arrived,
// so a ticket is not usable as a Bearer and a session token is not usable in a URL.
const SESSION_TTL_MS = 60 * 60 * 1000 // 1h, then the client re-establishes silently
const TICKET_TTL_MS = 60 * 1000 // 60s, and only to open the SSE stream

/** `s` = session (Bearer header), `t` = stream ticket (`?ticket=`). */
export type TokenKind = 's' | 't'

// ── enforcement flag ─────────────────────────────────────────────────────────
/** Auth is enforced by default. Opt out only for a loopback-only dev run with an explicit
 *  `EW_AUTH=0` (or off/false/no) — see docs/development.md. */
export function authEnabled(): boolean {
  const v = (process.env.EW_AUTH ?? '').toLowerCase()
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no')
}

// ── base64url helpers ────────────────────────────────────────────────────────
const b64u = (b: Buffer): string => b.toString('base64url')
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url')

// ── client registry (authorized public keys) ─────────────────────────────────
// Two accepted key types: Ed25519 (OKP, preferred) and ECDSA P-256 (EC, the
// fallback for WebViews without Ed25519 WebCrypto — see src/client/authClient.ts).
// Both are ~128-bit; the server verifies whichever the client enrolled.
export type ClientJwk =
  | { kty: 'OKP'; crv: 'Ed25519'; x: string }
  | { kty: 'EC'; crv: 'P-256'; x: string; y: string }
// `name` is the single human label for this key, like an authorized_keys comment.
// Auto-assigned `client-<id8>` at enrollment.
export interface Client {
  id: string
  name: string
  pub: ClientJwk
  addedAt: number
  addedIp?: string
}
interface Registry {
  clients: Client[]
}

// ── the registry is cached, with a stat as the source of truth ───────────────
// (docs/decisions/registry-stat-cache.md)
//
// `authClientId()` reads the registry on every request, and revocation happens in another
// process (`scripts/ew-auth.mjs` edits clients.json). So the cache removes the read and the
// parse but never the freshness check: one `statSync` per request. Not `fs.watch` — it can
// miss events and follows an inode, and a missed event is a revoked key that keeps working.
//
// The cache key is the file path (stateDir() is per call) plus `ino`, `mtimeNs` and `size`,
// compared for equality: a rename-into-place changes the inode and may carry an older mtime.
// `mtimeNs` (BigInt stat) is used because millisecond mtimes can collide across rewrites.
//
// The stat is taken before the read, so cached content is at least as new as its key; a
// write between the two costs a redundant re-read, never a stale answer.
interface RegStamp {
  ino: bigint
  mtimeNs: bigint
  size: bigint
}
/** A missing file is a legitimate state ("no clients enrolled") and is cached as such, with a
 *  stamp no real file can produce. */
const ABSENT: RegStamp = { ino: -1n, mtimeNs: -1n, size: -1n }
function stampOf(file: string): RegStamp {
  try {
    const s = statSync(file, { bigint: true })
    return { ino: s.ino, mtimeNs: s.mtimeNs, size: s.size }
  } catch {
    return ABSENT
  }
}
const sameStamp = (a: RegStamp, b: RegStamp): boolean =>
  a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size

let regCache: { file: string; stamp: RegStamp; reg: Registry } | null = null

/** Drop the cached registry. For tests; normal operation never needs it. */
export function resetRegistryCache(): void {
  regCache = null
}

function readRegistry(): Registry {
  const file = clientsFile()
  const stamp = stampOf(file)
  const c = regCache
  if (c && c.file === file && sameStamp(c.stamp, stamp)) return c.reg
  let reg: Registry
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Registry
    reg = Array.isArray(r?.clients) ? r : { clients: [] }
  } catch {
    reg = { clients: [] }
  }
  regCache = { file, stamp, reg }
  return reg
}
/** Persist the registry and adopt it as the cache. The stamp is taken after the write. Every
 *  mutator mutates the object `readRegistry()` returned and then lands here, so the cached
 *  object and the file stay the same thing. */
function writeRegistry(r: Registry): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const file = clientsFile()
  // 0600 like the secret beside it: which keys are trusted, and when and from where they
  // were added, is reconnaissance. Modes apply at creation only; `stateDirWarning()` reports
  // an existing loose file.
  writeFileSync(file, JSON.stringify(r, null, 2), { encoding: 'utf8', mode: 0o600 })
  regCache = { file, stamp: stampOf(file), reg: r }
}

/** Stable client id = SHA-256 fingerprint of the public key coordinates (hex). The same key
 *  always maps to the same id, so re-pairing is idempotent; the randomart is drawn from it.
 *  The material must match src/client/authClient.ts and scripts/ew-auth.mjs byte for byte:
 *  OKP has only `x`; EC has `x` and `y`. */
export function fingerprint(pub: ClientJwk): string {
  const material = pub.kty === 'OKP' ? `${pub.crv}:${pub.x}` : `${pub.crv}:${pub.x}:${pub.y}`
  return createHash('sha256').update(material).digest('hex')
}
function validPub(pub: unknown): pub is ClientJwk {
  const p = pub as { kty?: string; crv?: string; x?: unknown; y?: unknown } | null
  if (!p) return false
  if (p.kty === 'OKP') return p.crv === 'Ed25519' && typeof p.x === 'string'
  if (p.kty === 'EC') return p.crv === 'P-256' && typeof p.x === 'string' && typeof p.y === 'string'
  return false
}

/** The enrolled clients. This is the cached array, not a copy: mutate it only together with
 *  `writeRegistry`, or the cache and the file diverge. */
export function listClients(): Client[] {
  return readRegistry().clients
}

// ── how many keys may be enrolled at once (EW_MAX_CLIENTS, default 1) ────────
// (docs/decisions/client-cap.md)
//
// Re-pairing adds a key instead of replacing one: the device generates a fresh keypair and
// the old entry stays authorized with nobody holding it. With a cap of 1 the second
// enrollment is refused, so a new key needs the old one revoked first.
//
// The cap covers the enrollment paths (this module and the write paths in ew-auth.mjs), not
// hand edits of clients.json. Re-adding an already enrolled key is allowed at any limit: same
// fingerprint, no new key.

/** Pure parse of `EW_MAX_CLIENTS`: unset ⇒ 1; `0`/`unlimited`/`off`/`none` ⇒ 0, meaning no
 *  cap; anything else that is not plain digits ⇒ 1, so a typo fails safe. Plain digits only:
 *  `Number()` would read `1e3` or `0x10`, and the value in effect must be the value seen. */
export function parseMaxClients(raw: string | undefined | null): number {
  const s = (raw ?? '').trim()
  if (s === '') return 1
  if (/^(0|unlimited|off|none)$/i.test(s)) return 0
  return /^\d+$/.test(s) ? Number(s) : 1
}

/** Max simultaneous enrolled keys, read per call like the rest of this module's config. */
export function maxClients(): number {
  return parseMaxClients(process.env.EW_MAX_CLIENTS)
}

/** Is the registry at its cap? (Always false when uncapped.) */
export function enrollmentFull(): boolean {
  const max = maxClients()
  return max > 0 && listClients().length >= max
}

/** Banner lines when the cap has been relaxed from its default, or [] at the default. */
export function clientLimitWarning(raw: string | undefined = process.env.EW_MAX_CLIENTS): string[] {
  const max = parseMaxClients(raw)
  if (max === 1) return []
  if (max === 0) {
    return [
      'WARNING: EW_MAX_CLIENTS is UNCAPPED — any number of keys may be enrolled at once.',
      '  A re-paired device leaves its old key enrolled and nobody holding it; with no cap,' +
        ' nothing refuses that.',
    ]
  }
  return [`client limit: ${max} keys (EW_MAX_CLIENTS) — revoke-first re-pairing is not enforced`]
}

/** Enroll (or refresh the name of) an authorized client by its public key. Idempotent on the
 *  fingerprint. Returns the stored client, or null if the JWK is malformed or the registry is
 *  at `maxClients()` (`enrollmentFull()` tells the two apart). */
export function addClient(pub: unknown, name = ''): Client | null {
  if (!validPub(pub)) return null
  const id = fingerprint(pub)
  const reg = readRegistry()
  const existing = reg.clients.find(c => c.id === id)
  if (existing) {
    if (name) existing.name = name
    writeRegistry(reg)
    return existing
  }
  // Counted off the registry we are about to write, so the check cannot race a reload.
  const max = maxClients()
  if (max > 0 && reg.clients.length >= max) return null
  const client: Client = { id, name: name || autoName(id), pub, addedAt: Date.now() }
  reg.clients.push(client)
  writeRegistry(reg)
  return client
}
/** Revoke a client by id (full) or short id prefix. Returns true if one was removed. */
export function removeClient(idOrPrefix: string): boolean {
  const reg = readRegistry()
  const before = reg.clients.length
  reg.clients = reg.clients.filter(c => c.id !== idOrPrefix && !c.id.startsWith(idOrPrefix))
  if (reg.clients.length === before) return false
  writeRegistry(reg)
  return true
}
/** Look up an enrolled client by its exact id (fingerprint), or null. */
export function getClient(id: string): Client | null {
  return readRegistry().clients.find(c => c.id === id) ?? null
}
/** The name auto-assigned at enrollment, derivable from the immutable id. */
export function autoName(id: string): string {
  return `client-${id.slice(0, 8)}`
}

// ── host-local secret for signing session tokens ─────────────────────────────
// Cached by directory (EW_STATE_DIR is read per call) and stat-gated like the registry:
// deleting or replacing the file is how "end every live session" is spelled, and it has to
// work on a running server, on the next token check. Cost: one `statSync` per verify.
//
// There is no rotation schedule. The secret signs session tokens whose exposure is already
// bounded by the 1h TTL; it does not protect a transport (docs/security.md).
let secretCache: { dir: string; stamp: RegStamp; key: Buffer } | null = null
function serverSecret(): Buffer {
  const dir = stateDir()
  const file = join(dir, 'server-secret')
  const stamp = stampOf(file)
  const c = secretCache
  if (c && c.dir === dir && sameStamp(c.stamp, stamp)) return c.key
  try {
    const key = unb64u(readFileSync(file, 'utf8').trim())
    if (key.length >= 32) {
      secretCache = { dir, stamp, key }
      return key
    }
  } catch {
    /* generate below */
  }
  const key = randomBytes(32)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(secretFile(), b64u(key), { encoding: 'utf8', mode: 0o600 })
  // Stamped after the write, so the stamp is the kernel's own for these bytes.
  secretCache = { dir, stamp: stampOf(file), key }
  return key
}

// ── challenge nonces (short-lived, single-use, in-memory) ────────────────────
const challenges = new Map<string, number>() // nonce → expiry(ms)
function sweepChallenges(now: number): void {
  for (const [n, exp] of challenges) if (exp < now) challenges.delete(n)
}

/** Issue a fresh random challenge the client must sign to prove key possession. */
export function issueChallenge(): { nonce: string; exp: number } {
  const now = Date.now()
  sweepChallenges(now)
  const nonce = b64u(randomBytes(32))
  const exp = now + CHALLENGE_TTL_MS
  challenges.set(nonce, exp)
  return { nonce, exp }
}

/** Verify a signature over the UTF-8 bytes of `data` against a registered public key.
 *  Ed25519 (OKP): pure EdDSA, no separate hash. ECDSA P-256 (EC): SHA-256 with the
 *  raw r||s signature WebCrypto emits (dsaEncoding ieee-p1363). */
function verifySig(pub: ClientJwk, data: string, sigB64u: string): boolean {
  try {
    const key = createPublicKey({ key: pub, format: 'jwk' } as unknown as JsonWebKeyInput)
    const buf = Buffer.from(data, 'utf8'),
      sig = unb64u(sigB64u)
    return pub.kty === 'OKP'
      ? cryptoVerify(null, buf, key, sig)
      : cryptoVerify('sha256', buf, { key, dsaEncoding: 'ieee-p1363' }, sig)
  } catch {
    return false
  }
}

// ── session tokens (stateless HMAC bearer) ───────────────────────────────────
function signToken(cid: string, exp: number, k: TokenKind): string {
  const payload = b64u(Buffer.from(JSON.stringify({ cid, exp, k }), 'utf8'))
  const mac = b64u(createHmac('sha256', serverSecret()).update(payload).digest())
  return `${payload}.${mac}`
}
/** The client id and the token's kind, or null if the MAC, the shape or the clock says no.
 *  A token with no `k` is refused: there is no downgrade path. */
function verifyToken(token: string): { cid: string; kind: TokenKind } | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const payload = token.slice(0, dot),
    mac = token.slice(dot + 1)
  const expect = b64u(createHmac('sha256', serverSecret()).update(payload).digest())
  const a = Buffer.from(mac),
    b = Buffer.from(expect)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const { cid, exp, k } = JSON.parse(unb64u(payload).toString('utf8')) as {
      cid?: unknown
      exp?: unknown
      k?: unknown
    }
    if (typeof cid !== 'string' || typeof exp !== 'number' || exp < Date.now()) return null
    if (k !== 's' && k !== 't') return null
    return { cid, kind: k }
  } catch {
    return null
  }
}

/** Mint a short-lived stream ticket for an already-authenticated client. This authenticates
 *  nothing: the caller must already hold a Bearer session (`GET /api/auth/ticket` is gated). */
export function issueTicket(clientId: string): { ticket: string; exp: number } {
  const exp = Date.now() + TICKET_TTL_MS
  return { ticket: signToken(clientId, exp, 't'), exp }
}

// ── session binding (the signed material names the destination) ──────────────────────────
//
// See src/shared/sessionBinding.ts and docs/decisions/session-origin-binding.md for what this
// does and does not close. Three rules make the check real:
//
//  1. The comparison value is configured, never derived from the request. A relaying attacker
//     connects directly and chooses its own `Host` header. (`corsOrigin()` in main.ts does
//     match against `Host`; that is correct for CORS and must not be copied here.)
//  2. It has its own variable, not `EW_ORIGINS`. That one is a CORS allowlist — multi-valued
//     and accepting `*` — and widening CORS must not widen the auth binding.
//  3. No downgrade: a bare-nonce signature is never accepted (see SESSION_BINDING_V1).
//
// Unset is a legitimate state (loopback development, the `EW_AUTH=0` harness): the signature
// is verified and the comparison skipped. `sessionBindingStatus()` reports it on every start.

/** `EW_ORIGIN`, canonicalised — the one origin this server accepts a session signature for,
 *  or `''` when unset/unusable. Read per call, like `stateDir()`. */
export function canonicalOrigin(): string {
  return normaliseOrigin(process.env.EW_ORIGIN)
}

/** What the start-up banner says about session binding ("session" to keep it apart from the
 *  swipe bindings). Pure in its argument. A misconfigured value never reads as enforced:
 *  `EW_ORIGIN=*` lands in "unusable", not in "allow anything". */
export function sessionBindingStatus(raw: string | undefined = process.env.EW_ORIGIN): {
  enforced: boolean
  origin: string
  line: string
} {
  const given = (raw ?? '').trim()
  const origin = normaliseOrigin(given)
  if (origin)
    return { enforced: true, origin, line: `session binding ENFORCED — EW_ORIGIN=${origin}` }
  if (given) {
    return {
      enforced: false,
      origin: '',
      line: `session binding NOT enforced — EW_ORIGIN=${JSON.stringify(given)} is not an absolute URL`,
    }
  }
  return {
    enforced: false,
    origin: '',
    line:
      'session binding NOT enforced — set EW_ORIGIN to the URL the device dials' +
      ' (e.g. https://host.ts.net:8443) to refuse signatures made for anywhere else',
  }
}

/** Is the registry holding more keys than the cap allows, in a run where that matters? With
 *  auth off the registry is never consulted, so there is nothing to fail closed about. */
export function overCap(): boolean {
  if (!authEnabled()) return false
  const max = maxClients()
  return max > 0 && listClients().length > max
}

/** The refusal printed when the server declines to start over the cap
 *  (docs/decisions/client-cap.md). It fails closed, with no override: a warning would leave a
 *  gate that is believed narrow and is in fact wide, and `count > max` is also what an
 *  unauthorized enrollment looks like. Recovery needs no server — `ew-auth revoke` edits
 *  clients.json directly. */
export function overCapRefusal(count: number, max: number, dir: string): string[] {
  return [
    `REFUSING TO START: ${count} client key(s) are enrolled but EW_MAX_CLIENTS=${max}.`,
    '  Lowering the cap does not revoke anything — the cap gates enrolment, not requests — so',
    '  starting now would serve a gate that is wider than the configuration asks for. This is',
    '  also what an unauthorized enrolment looks like, so it is not assumed to be benign.',
    `  Look, then drop what should be gone (no server needed — ${dir}):`,
    '    node scripts/ew-auth.mjs list',
    '    node scripts/ew-auth.mjs revoke <id>',
    `  Or keep them on purpose: raise the cap back to ${count} (EW_MAX_CLIENTS=${count}).`,
  ]
}

/** Banner lines for how many keys are enrolled. Pure in its arguments. The count tells a
 *  wrong `EW_STATE_DIR` apart from a device that lost its pairing: both look like every
 *  request getting 401, but an enforcing server with zero keys points at the registry. */
export function clientCountBanner(
  count: number,
  max: number,
  dir: string,
  authOn: boolean,
): string[] {
  if (!authOn) return [] // the auth-off banner already says nothing is being checked
  if (count === 0) {
    return [
      `NO CLIENT KEYS ENROLLED in ${dir} — nothing can authenticate until a device is paired.`,
      '  If a device was already paired, this is the wrong registry: check EW_STATE_DIR' +
        ' (scripts/dev.sh and scripts/sim.sh deliberately use their own).',
    ]
  }
  // Over the cap while running: start-up refuses outright (`overCapRefusal`), so this is the
  // registry growing under a serving process, noticed by the 1 Hz poll. It is reported, not
  // made fatal: exiting mid-session would give anyone who can write the state dir an off
  // switch. The cap gates enrollment, not requests, so the extra key works until revoked.
  if (max > 0 && count > max) {
    return [
      `WARNING: a key was added while running — ${count} client key(s) enrolled but` +
        ` EW_MAX_CLIENTS=${max}. OVER THE CAP.`,
      '  The extra key(s) work: the cap gates enrolment, not requests. If you did not add it,' +
        ' revoke it now — and note that this server will REFUSE TO START while over the cap.',
      `  node scripts/ew-auth.mjs list  /  revoke <id>   (${dir}, no restart needed)`,
    ]
  }
  return [`${count} client key(s) enrolled${max > 0 ? ` of ${max}` : ''} — ${dir}`]
}

/** Redeem a signed challenge for a session token. Verifies that the nonce is live and
 *  single-use, that the signature matches an enrolled client's public key over the bound
 *  material (clientId + the origin the client believes it is talking to + the nonce), and that
 *  the named origin is this server's own when `EW_ORIGIN` is configured.
 *  `origin` is what the request body claimed; it is folded back into the signed material, so
 *  a tampered value fails verification. */
export function redeemSession(
  clientId: string,
  nonce: string,
  sigB64u: string,
  origin = '',
): { token: string; exp: number; clientId: string } | null {
  const now = Date.now()
  sweepChallenges(now)
  const exp = challenges.get(nonce)
  if (!exp || exp < now) return null
  const client = listClients().find(c => c.id === clientId)
  if (!client) return null
  const bound = normaliseOrigin(origin)
  if (!verifySig(client.pub, sessionMaterial(clientId, bound, nonce), sigB64u)) return null
  // After the signature: a mismatch means the signature was made for another server. The
  // nonce is not burned on this path — nothing has been proved about this server.
  const want = canonicalOrigin()
  if (want && bound !== want) return null
  challenges.delete(nonce) // single-use: burn the nonce on success
  const sExp = now + SESSION_TTL_MS
  return { token: signToken(client.id, sExp, 's'), exp: sExp, clientId: client.id }
}

// ── request gate ─────────────────────────────────────────────────────────────
/** The token a request carries and where it came from. The kind inside the token must match
 *  the source (see `authClientId`). `token` is '' when there is none. */
function extractToken(req: IncomingMessage): { token: string; from: TokenKind } {
  const h = req.headers.authorization
  if (typeof h === 'string' && h.startsWith('Bearer '))
    return { token: h.slice(7).trim(), from: 's' }
  try {
    return { token: new URL(req.url ?? '', 'http://x').searchParams.get('ticket') ?? '', from: 't' }
  } catch {
    return { token: '', from: 't' }
  }
}
/** Resolve the authenticated client id for a request, or null if unauthenticated. Token
 *  source: `Authorization: Bearer <t>`, or `?ticket=<t>` for the SSE stream.
 *  The registry is consulted here and not only at redeem time, so a revoked client's
 *  stateless token stops working on the next request (one `statSync` in the steady state). */
export function authClientId(req: IncomingMessage): string | null {
  const { token, from } = extractToken(req)
  const v = token ? verifyToken(token) : null
  if (v == null) return null
  if (v.kind !== from) return null // a ticket is not a Bearer, and a Bearer is not a ticket
  return getClient(v.cid) ? v.cid : null
}

// ── state directory permissions ──────────────────────────────────────────────
/** Banner lines when the state dir is readable by other local accounts, or [] when it is not.
 *  `mode` is the directory's `statSync().mode` (passed in so this stays pure). Modes apply at
 *  creation only, so an existing loose directory is reported, never silently chmod'ed. */
export function stateDirWarning(mode: number, dir = stateDir()): string[] {
  if ((mode & 0o077) === 0) return []
  const bits = (mode & 0o777).toString(8).padStart(3, '0')
  return [
    `state dir ${dir} is mode 0${bits} — readable by other local accounts.`,
    `  Tighten it: chmod 700 ${dir} (new installs are created 0700; this one predates that).`,
  ]
}

// ── pairing (strict "approve-then-enroll") ───────────────────────────────────
// (docs/decisions/pairing-randomart.md)
//
// The operator opens a short pairing window (`ew-auth pair` writes pairing.json with a hashed
// one-time code). The client posts its public key + code; a valid code stages a pending
// enrollment, never an authorized one. The operator compares the staged key's randomart
// (`ew-auth pending`) with the art the device drew from its own key and runs `approve`; only
// then does the key move into clients.json.
//
// The window is single-use, which stops a code that leaked to someone off the path. The art
// stops an in-path attacker who substitutes its own key, and only because the device draws
// its own: the `art` in the response is a cross-check, never what the device displays.
const pendingFile = (): string => join(stateDir(), 'pending.json')
const pairingFile = (): string => join(stateDir(), 'pairing.json')
const PENDING_TTL_MS = 10 * 60 * 1000

export interface Pending {
  id: string
  name: string
  pub: ClientJwk
  art: string
  status: 'pending' | 'rejected'
  createdAt: number
  ip?: string
}
function readPending(): Pending[] {
  try {
    const r = JSON.parse(readFileSync(pendingFile(), 'utf8')) as { pending?: Pending[] }
    return Array.isArray(r?.pending) ? r.pending : []
  } catch {
    return []
  }
}
function writePending(list: Pending[]): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  writeFileSync(pendingFile(), JSON.stringify({ pending: list }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/** Randomart over the fingerprint of the key this server staged. Re-exported; the
 *  implementation lives in src/shared/randomart.ts because the device must compute its own
 *  copy from its own key. */
export { randomart }

/** Open pairing window (or null if closed/expired). */
function pairingWindow(): { codeHash: string; exp: number } | null {
  try {
    const w = JSON.parse(readFileSync(pairingFile(), 'utf8')) as { codeHash?: string; exp?: number }
    return w?.codeHash && (w.exp ?? 0) > Date.now()
      ? (w as { codeHash: string; exp: number })
      : null
  } catch {
    return null
  }
}

/** How many keys are enrolled, and how many may be. `max: 0` = uncapped (EW_MAX_CLIENTS).
 *  Reported in the pairing response so the device can say there is no free slot before the
 *  operator tries to approve. Only a caller holding a valid one-time code receives it. */
export interface PairSlots {
  used: number
  max: number
}

/** Submit a device's public key against the one-time code. Stages a pending enrollment; the
 *  window is consumed on the first valid submit. `ip` is the submitting device's source
 *  address (best effort), stored so `approve` can record where the key was enrolled from. */
export function submitPairing(
  code: string,
  pub: unknown,
  ip = '',
):
  | { status: 'pending' | 'approved'; id: string; art: string; slots: PairSlots }
  | { error: string } {
  const w = pairingWindow()
  if (!w) return { error: 'pairing closed' }
  const got = createHash('sha256').update(String(code)).digest()
  const want = unb64u(w.codeHash)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { error: 'bad code' }
  if (!validPub(pub)) return { error: 'bad key' }
  rmSync(pairingFile(), { force: true }) // single-use: burn the window on first valid submit
  const id = fingerprint(pub)
  const art = randomart(id)
  const slots: PairSlots = { used: listClients().length, max: maxClients() }
  if (listClients().some(c => c.id === id)) return { status: 'approved', id, art, slots } // already enrolled
  const list = readPending().filter(p => p.id !== id && Date.now() - p.createdAt < PENDING_TTL_MS)
  list.push({
    id,
    name: autoName(id),
    pub,
    art,
    status: 'pending',
    createdAt: Date.now(),
    ...(ip ? { ip } : {}),
  })
  writePending(list)
  return { status: 'pending', id, art, slots }
}

/** Poll enrollment status for a device id (client waits for operator approval). */
export function pairingStatus(id: string): 'approved' | 'pending' | 'rejected' | 'unknown' {
  if (listClients().some(c => c.id === id)) return 'approved'
  const p = readPending().find(p => p.id === id)
  if (!p) return 'unknown'
  return p.status === 'rejected' ? 'rejected' : 'pending'
}
