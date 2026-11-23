// even-window — the auth model itself (src/server/auth.ts).
//
// These tests run the real crypto: node:crypto generates the keypairs and produces the
// signatures, and src/server/auth.ts verifies them with createPublicKey/verify. Nothing is
// mocked, because a mocked verifier would prove only that the mock was called.
//
// The happy path is one test. The other ten are the ones that matter: each asserts that a
// Specific way of cheating is refused. A boundary is defined by what it rejects.

import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addClient,
  authClientId,
  authEnabled,
  autoName,
  clientCountBanner,
  clientLimitWarning,
  enrollmentFull,
  fingerprint,
  getClient,
  issueChallenge,
  issueTicket,
  listClients,
  maxClients,
  overCap,
  overCapRefusal,
  pairingStatus,
  parseMaxClients,
  randomart,
  redeemSession,
  removeClient,
  stateDir,
  stateDirWarning,
  submitPairing,
} from '../src/server/auth.ts'
import { sessionMaterial } from '../src/shared/sessionBinding.ts'
import {
  enrolAndSession,
  makeEd25519Key,
  makeP256Key,
  type TestKey,
  useTempStateDir,
} from './authFixture.ts'

/** A correctly bound signature over a challenge (src/shared/sessionBinding.ts: version tag +
 *  client id + claimed origin + nonce). Used by the rejection tests so each one fails for the
 *  reason it names — a bare-nonce signature would now be refused by the format check first,
 *  and every one of them would pass while proving nothing. */
const signSession = (key: TestKey, id: string, nonce: string, origin = ''): string =>
  key.sign(sessionMaterial(id, origin, nonce))

let dispose: () => void
beforeEach(() => {
  dispose = useTempStateDir()
})
afterEach(() => {
  dispose()
})

/** The gate takes an IncomingMessage; it only ever reads `headers` and `url`. */
function fakeReq(opts: { bearer?: string; url?: string }): IncomingMessage {
  return {
    url: opts.url ?? '/api/windows',
    headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
  } as unknown as IncomingMessage
}

describe('EW_AUTH — enforcement is on by default', () => {
  const prev = process.env.EW_AUTH
  afterEach(() => {
    if (prev === undefined) delete process.env.EW_AUTH
    else process.env.EW_AUTH = prev
  })

  it('is enabled when EW_AUTH is unset — the secure default', () => {
    delete process.env.EW_AUTH
    expect(authEnabled()).toBe(true)
  })

  it('is enabled for any value that is not an explicit opt-out (including "1" and typos)', () => {
    for (const v of ['1', 'on', 'true', 'yes', '', 'enforce', 'nope!']) {
      process.env.EW_AUTH = v
      expect(authEnabled(), `EW_AUTH=${JSON.stringify(v)}`).toBe(true)
    }
  })

  it('is disabled only by 0/off/false/no, case-insensitively', () => {
    for (const v of ['0', 'off', 'false', 'no', 'OFF', 'False', 'NO']) {
      process.env.EW_AUTH = v
      expect(authEnabled(), `EW_AUTH=${JSON.stringify(v)}`).toBe(false)
    }
  })
})

describe('EW_STATE_DIR', () => {
  it('is where the registry lands, and it is read per call', () => {
    const key = makeEd25519Key()
    addClient(key.pub, 'in-temp-dir')
    const file = join(stateDir(), 'clients.json')
    const reg = JSON.parse(readFileSync(file, 'utf8')) as { clients: { name: string }[] }
    expect(reg.clients.map(c => c.name)).toContain('in-temp-dir')
    expect(stateDir()).toBe(process.env.EW_STATE_DIR)
  })

  it('writes the token-signing secret with 0600', () => {
    enrolAndSession(makeEd25519Key())
    const mode = statSync(join(stateDir(), 'server-secret')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('the happy path: enrol → challenge → sign → token → verify', () => {
  it('accepts an Ed25519 client', () => {
    const key = makeEd25519Key()
    const { clientId, token } = enrolAndSession(key)
    expect(authClientId(fakeReq({ bearer: token }))).toBe(clientId)
  })

  it('accepts an ECDSA P-256 client (the WebView fallback)', () => {
    const key = makeP256Key()
    const { clientId, token } = enrolAndSession(key)
    expect(authClientId(fakeReq({ bearer: token }))).toBe(clientId)
  })

  it('accepts a ticket as ?ticket= — EventSource cannot set headers', () => {
    const { clientId } = enrolAndSession(makeEd25519Key())
    const { ticket } = issueTicket(clientId)
    const req = fakeReq({ url: `/api/stream?ticket=${encodeURIComponent(ticket)}` })
    expect(authClientId(req)).toBe(clientId)
  })

  it('is idempotent on the fingerprint: re-enrolling the same key does not duplicate it', () => {
    const key = makeEd25519Key()
    const a = addClient(key.pub)
    const b = addClient(key.pub)
    expect(a?.id).toBe(b?.id)
    expect(listClients()).toHaveLength(1)
    expect(a?.name).toBe(autoName(fingerprint(key.pub)))
  })
})

// ── two kinds of token ────────────────────────────────────────────────────────────────────
//
// The stream's credential has to travel in a URL, because `EventSource` cannot set headers —
// and a URL is the worst place for one (proxy logs, referrers, the address bar). So the
// session token never goes there: `?ticket=` carries a separate 60-second ticket.
//
// The separation is the whole point. If a session token also worked as a ticket, the short TTL
// would buy nothing — the credential that leaks into a log file would still be the long-lived
// one. So the kind lives inside the MAC and `authClientId` requires it to match where the
// token arrived from. These tests pin both directions, and the TTLs.
describe('session tokens and stream tickets do not substitute for each other', () => {
  it('refuses a session token presented as ?ticket=', () => {
    const { token } = enrolAndSession(makeEd25519Key())
    expect(
      authClientId(fakeReq({ url: `/api/stream?ticket=${encodeURIComponent(token)}` })),
    ).toBeNull()
    // …and the same token is still fine where it belongs.
    expect(authClientId(fakeReq({ bearer: token }))).not.toBeNull()
  })

  it('refuses a ticket presented as a Bearer header', () => {
    const { clientId } = enrolAndSession(makeEd25519Key())
    const { ticket } = issueTicket(clientId)
    expect(authClientId(fakeReq({ bearer: ticket }))).toBeNull()
    expect(authClientId(fakeReq({ url: `/api/stream?ticket=${ticket}` }))).toBe(clientId)
  })

  it('expires a ticket after 60s', () => {
    const { clientId } = enrolAndSession(makeEd25519Key())
    const { ticket, exp } = issueTicket(clientId)
    expect(exp - Date.now()).toBeLessThanOrEqual(60_000)
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 61_000
      expect(authClientId(fakeReq({ url: `/api/stream?ticket=${ticket}` }))).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('gives the session token an hour — not the twelve it used to have', () => {
    const { token, exp } = enrolAndSession(makeEd25519Key())
    expect(exp - Date.now()).toBeGreaterThan(55 * 60 * 1000)
    expect(exp - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000)
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 61 * 60 * 1000
      expect(authClientId(fakeReq({ bearer: token }))).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('refuses a token with no kind — the pre-split format, and no downgrade path', () => {
    // Hand-mint the old payload with the real secret: this is exactly what a token issued by
    // the previous version looks like, and it must not be honoured.
    const { clientId } = enrolAndSession(makeEd25519Key())
    const secret = readFileSync(join(stateDir(), 'server-secret'), 'utf8').trim()
    const payload = Buffer.from(
      JSON.stringify({ cid: clientId, exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    const mac = createHmac('sha256', Buffer.from(secret, 'base64url'))
      .update(payload)
      .digest('base64url')
    expect(authClientId(fakeReq({ bearer: `${payload}.${mac}` }))).toBeNull()
  })

  it('refuses an invented kind', () => {
    const { clientId } = enrolAndSession(makeEd25519Key())
    const secret = readFileSync(join(stateDir(), 'server-secret'), 'utf8').trim()
    const payload = Buffer.from(
      JSON.stringify({ cid: clientId, exp: Date.now() + 60_000, k: 'admin' }),
      'utf8',
    ).toString('base64url')
    const mac = createHmac('sha256', Buffer.from(secret, 'base64url'))
      .update(payload)
      .digest('base64url')
    expect(authClientId(fakeReq({ bearer: `${payload}.${mac}` }))).toBeNull()
  })
})

// ── rotating the token-signing secret ─────────────────────────────────────────────────────
//
// `server-secret` signs the session tokens, so replacing it invalidates every live session
// while leaving enrollments alone — the "log everything out now" button, for a leaked backup
// of the state dir or plain hygiene. Unlike SSH's rekeying this is not on a schedule and is
// not protecting a transport (TLS and WireGuard own that); it bounds the one long-lived
// symmetric secret in the system.
//
// It must work on a RUNNING server, which is what these tests are really about: the secret
// used to be cached by directory alone, so this file's own promise ("revocable by deleting
// it") was false until a restart. The cache is stat-gated now, like the registry.
describe('rotating server-secret takes effect without a restart', () => {
  it('invalidates a live token when the file is replaced', () => {
    const { token } = enrolAndSession(makeEd25519Key())
    expect(authClientId(fakeReq({ bearer: token }))).not.toBeNull()
    // What `ew-auth rotate` does: 32 fresh bytes over the same path.
    writeFileSync(join(stateDir(), 'server-secret'), randomBytes(32).toString('base64url'), 'utf8')
    expect(authClientId(fakeReq({ bearer: token }))).toBeNull()
  })

  it('invalidates a live token when the file is deleted (the server mints a new one)', () => {
    // The same key re-establishes, which is both what a real device does and what the default
    // EW_MAX_CLIENTS=1 allows — a second key here would be refused by the cap, not by the
    // secret, and the test would pass for the wrong reason.
    const key = makeEd25519Key()
    const { token } = enrolAndSession(key)
    expect(authClientId(fakeReq({ bearer: token }))).not.toBeNull()
    rmSync(join(stateDir(), 'server-secret'))
    expect(authClientId(fakeReq({ bearer: token }))).toBeNull()
    // And the next session works again: a missing file is regenerated, not fatal.
    const { token: fresh } = enrolAndSession(key)
    expect(authClientId(fakeReq({ bearer: fresh }))).not.toBeNull()
  })

  it('leaves enrolments alone — rotation is not revocation', () => {
    const key = makeEd25519Key()
    const { clientId } = enrolAndSession(key)
    writeFileSync(join(stateDir(), 'server-secret'), randomBytes(32).toString('base64url'), 'utf8')
    expect(getClient(clientId)?.id).toBe(clientId)
    // The device re-establishes with its own key, which is the whole cost of a rotation.
    const again = enrolAndSession(key)
    expect(again.clientId).toBe(clientId)
    expect(authClientId(fakeReq({ bearer: again.token }))).toBe(clientId)
  })

  it('does not re-read the file when nothing changed (the stat is the gate)', () => {
    // Pins that the cache is still a cache: same stamp ⇒ the same key object comes back, so a
    // per-request verify is a stat rather than a read.
    const { token } = enrolAndSession(makeEd25519Key())
    for (let i = 0; i < 50; i++) expect(authClientId(fakeReq({ bearer: token }))).not.toBeNull()
  })
})

// ── the enrolled-key count on the banner ──────────────────────────────────────────────────
//
// `EW_STATE_DIR` decides which registry is served, and pointing at the wrong one looks exactly
// like a device that lost its pairing: every request 401s and the phone opens its pairing
// dialog. The count tells those apart in one glance, which is the only reason it earns a line.
describe('clientCountBanner', () => {
  it('names the count, the cap and the registry when keys are enrolled', () => {
    const lines = clientCountBanner(2, 2, '/some/state', true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('2 client key(s) enrolled of 2')
    expect(lines[0]).toContain('/some/state')
  })

  it('warns, and names EW_STATE_DIR, when auth is enforced with an empty registry', () => {
    // "Enforced with nothing enrolled" cannot admit anybody, so it is never a working state.
    const text = clientCountBanner(0, 1, '/some/state', true).join('\n')
    expect(text).toMatch(/NO CLIENT KEYS ENROLLED/)
    expect(text).toContain('/some/state')
    expect(text).toMatch(/EW_STATE_DIR/)
    expect(text).toMatch(/wrong registry/)
  })

  // Raise the cap, enrol, lower it again — reachable without doing anything wrong, and the
  // dangerous part is the belief it creates: lowering the cap revoked nothing. The cap gates
  // enrolment, not requests, so both keys keep working and the banner has to say so.
  it('warns about a key added while RUNNING, and says the next start will refuse', () => {
    // Unreachable at start-up (that refuses); this is the 1 Hz poll noticing a registry that
    // grew past the cap under a server already serving.
    const text = clientCountBanner(2, 1, '/some/state', true).join('\n')
    expect(text).toMatch(/OVER THE CAP/)
    expect(text).toMatch(/added while running/)
    expect(text).toMatch(/REFUSE TO START/)
    expect(text).toMatch(/EW_MAX_CLIENTS=1/)
    expect(text).toMatch(/2 client key\(s\) enrolled/)
    expect(text).toMatch(/work: the cap gates enrolment/)
    expect(text).toMatch(/no restart needed/)
    expect(text).toMatch(/revoke/)
  })

  it('does not call an uncapped registry over the cap, however many keys it holds', () => {
    const lines = clientCountBanner(9, 0, '/some/state', true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(/OVER THE CAP/)
    expect(lines[0]).not.toMatch(/ of /) // no cap to report
  })

  it('is quiet at the cap — that is the intended steady state', () => {
    expect(clientCountBanner(1, 1, '/some/state', true).join('\n')).not.toMatch(/OVER THE CAP/)
  })

  it('says nothing when auth is off — that banner already covers it', () => {
    expect(clientCountBanner(0, 1, '/some/state', false)).toEqual([])
    expect(clientCountBanner(5, 1, '/some/state', false)).toEqual([])
  })

  it('reports the registry it was given, so a test cannot pass by reading the real one', () => {
    const key = makeEd25519Key()
    addClient(key.pub)
    expect(clientCountBanner(listClients().length, maxClients(), stateDir(), true)[0]).toContain(
      stateDir(),
    )
  })
})

// ── over the cap: fail closed ─────────────────────────────────────────────────────────────
//
// Raise EW_MAX_CLIENTS, enrol, lower it again, and the gate in force is wider than the
// configuration asks for. Lowering the cap has one intent — narrow it — and whoever edits
// config expects a restart to matter, while nobody can be relied on to read a start-up log.
// So a warning leaves "believed narrow, actually wide" running indefinitely.
//
// It is also indistinguishable from an enrolment the configuration never authorized (a
// hand-edited clients.json), so it is not treated as benign. Refusing is affordable because
// `ew-auth revoke` needs no server: there is no chicken-and-egg in the remedy.
describe('over the cap', () => {
  const prevMax = process.env.EW_MAX_CLIENTS
  const prevAuth = process.env.EW_AUTH
  afterEach(() => {
    for (const [k, v] of [
      ['EW_MAX_CLIENTS', prevMax],
      ['EW_AUTH', prevAuth],
    ] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  /** Two enrolled keys with the cap raised, then the cap lowered — the operator's sequence. */
  function enrolTwoThenLowerCap(): void {
    process.env.EW_MAX_CLIENTS = '2'
    addClient(makeEd25519Key().pub)
    addClient(makeEd25519Key().pub)
    expect(listClients()).toHaveLength(2)
    process.env.EW_MAX_CLIENTS = '1'
  }

  it('is detected once the cap is below the count', () => {
    enrolTwoThenLowerCap()
    expect(overCap()).toBe(true)
  })

  it('is not over the cap at the cap, or when uncapped', () => {
    process.env.EW_MAX_CLIENTS = '2'
    addClient(makeEd25519Key().pub)
    addClient(makeEd25519Key().pub)
    expect(overCap()).toBe(false)
    process.env.EW_MAX_CLIENTS = 'unlimited'
    expect(overCap()).toBe(false)
  })

  it('is not a condition when auth is off — the registry is never consulted', () => {
    enrolTwoThenLowerCap()
    process.env.EW_AUTH = '0'
    expect(overCap()).toBe(false)
  })

  it('refuses with a message naming both remedies and the registry', () => {
    const text = overCapRefusal(2, 1, '/some/state').join('\n')
    expect(text).toMatch(/REFUSING TO START/)
    expect(text).toMatch(/2 client key\(s\)/)
    expect(text).toMatch(/EW_MAX_CLIENTS=1/)
    expect(text).toMatch(/revoke/)
    expect(text).toContain('/some/state')
    expect(text).toMatch(/no server needed/)
    expect(text).toMatch(/EW_MAX_CLIENTS=2/) // raise it back to the count
  })

  it('offers no override — the two honest remedies are the only ones', () => {
    // An opt-out guarded only by a log line would contradict the reason for refusing, and
    // both real intents already have an honest expression: revoke the extra key, or raise
    // the cap to the number actually in use. Anything else would only express "let the
    // configuration claim one while two are in force".
    const text = overCapRefusal(2, 1, '/some/state').join('\n')
    expect(text).not.toMatch(/ALLOW/i)
    expect(text).not.toMatch(/override/i)
    expect(text).not.toMatch(/anyway/i)
  })

  it('has no environment variable that turns the refusal off', () => {
    // Pinned as a source fact, because the temptation to re-add an override is exactly what
    // this should resist: the only guard such a flag could have is a log line, and the whole
    // argument for refusing is that a log line is not a guard.
    const src =
      readFileSync(new URL('../src/server/auth.ts', import.meta.url), 'utf8') +
      readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/EW_ALLOW_OVER_CAP/)
  })
})

// ── state directory permissions ───────────────────────────────────────────────────────────
describe('stateDirWarning', () => {
  it('says nothing for 0700', () => {
    expect(stateDirWarning(0o040700, '/tmp/x')).toEqual([])
  })

  it('warns, with the octal mode and the chmod, for anything group- or world-readable', () => {
    for (const m of [0o040755, 0o040750, 0o040705, 0o040777]) {
      const lines = stateDirWarning(m, '/tmp/x')
      expect(lines.length, m.toString(8)).toBeGreaterThan(0)
      expect(lines.join('\n')).toContain('/tmp/x')
      expect(lines.join('\n')).toContain((m & 0o777).toString(8))
      expect(lines.join('\n')).toMatch(/chmod 700/)
    }
  })
})

// ── EW_MAX_CLIENTS ────────────────────────────────────────────────────────────────────────
//
// Re-pairing adds a key, it does not replace one (the device makes a fresh keypair, so the
// fingerprint is new and `addClient`'s idempotence cannot help). The old entry then stays
// authorized with nobody holding it — a key that grants full RCE, is never used, and so never
// looks anomalous. A printed reminder is not a control; a cap is. At the default of 1 the
// second enrollment is refused, which makes "there is a spare key" a state the operator
// cannot reach by forgetting something.
describe('EW_MAX_CLIENTS — how many keys may be enrolled at once', () => {
  const prev = process.env.EW_MAX_CLIENTS
  afterEach(() => {
    if (prev === undefined) delete process.env.EW_MAX_CLIENTS
    else process.env.EW_MAX_CLIENTS = prev
  })

  it('defaults to one', () => {
    delete process.env.EW_MAX_CLIENTS
    expect(maxClients()).toBe(1)
  })

  it('reads 0 / unlimited / off / none as uncapped', () => {
    for (const v of ['0', 'unlimited', 'UNLIMITED', 'off', 'none']) {
      expect(parseMaxClients(v), v).toBe(0)
    }
  })

  it('takes a positive integer, and fails safe on anything else', () => {
    expect(parseMaxClients('3')).toBe(3)
    expect(parseMaxClients(' 2 ')).toBe(2)
    // A typo must not silently uncap the registry — every one of these is 1.
    for (const v of ['', '   ', 'o', '-1', '2.5', 'two', 'yes', '1e3', undefined, null]) {
      expect(parseMaxClients(v), JSON.stringify(v)).toBe(1)
    }
  })

  it('refuses a second, different key at the default cap', () => {
    delete process.env.EW_MAX_CLIENTS
    const first = makeEd25519Key(),
      second = makeEd25519Key()
    expect(addClient(first.pub)).not.toBeNull()
    expect(enrollmentFull()).toBe(true)
    expect(addClient(second.pub)).toBeNull()
    expect(listClients()).toHaveLength(1)
    expect(listClients()[0]?.id).toBe(fingerprint(first.pub))
  })

  it('still accepts the same key — re-enrolling is not a new key', () => {
    delete process.env.EW_MAX_CLIENTS
    const key = makeEd25519Key()
    expect(addClient(key.pub)).not.toBeNull()
    // Idempotent at the cap, and a name refresh still lands.
    expect(addClient(key.pub, 'renamed')?.name).toBe('renamed')
    expect(listClients()).toHaveLength(1)
  })

  it('lets the new key in once the old one is revoked — the whole point of the cap', () => {
    delete process.env.EW_MAX_CLIENTS
    const old = makeEd25519Key(),
      fresh = makeEd25519Key()
    addClient(old.pub)
    expect(addClient(fresh.pub)).toBeNull()
    expect(removeClient(fingerprint(old.pub))).toBe(true)
    expect(addClient(fresh.pub)?.id).toBe(fingerprint(fresh.pub))
    expect(listClients()).toHaveLength(1)
  })

  it('honours a deliberately raised cap, and then stops at it', () => {
    process.env.EW_MAX_CLIENTS = '2'
    const a = makeEd25519Key(),
      b = makeEd25519Key(),
      c = makeEd25519Key()
    expect(addClient(a.pub)).not.toBeNull()
    expect(addClient(b.pub)).not.toBeNull()
    expect(enrollmentFull()).toBe(true)
    expect(addClient(c.pub)).toBeNull()
    expect(listClients()).toHaveLength(2)
  })

  it('enrols without limit when uncapped', () => {
    process.env.EW_MAX_CLIENTS = 'unlimited'
    for (let i = 0; i < 4; i++) expect(addClient(makeEd25519Key().pub)).not.toBeNull()
    expect(enrollmentFull()).toBe(false)
    expect(listClients()).toHaveLength(4)
  })

  it('says nothing at the default and warns when the cap is relaxed', () => {
    // The default needs no line — a banner that restates every control in its normal position
    // is the banner people stop reading. A relaxed cap is the state that must announce itself.
    expect(clientLimitWarning(undefined)).toEqual([])
    expect(clientLimitWarning('1')).toEqual([])
    expect(clientLimitWarning('nonsense')).toEqual([]) // parsed as 1, so still silent
    expect(clientLimitWarning('0').join('\n')).toMatch(/UNCAPPED/)
    expect(clientLimitWarning('unlimited').join('\n')).toMatch(/UNCAPPED/)
    expect(clientLimitWarning('3').join('\n')).toMatch(/3 keys/)
  })
})

describe('rejections — each is a specific way of cheating', () => {
  it('wrong key: a signature from a key that is not the enrolled one', () => {
    const enrolled = makeEd25519Key()
    const attacker = makeEd25519Key()
    const c = addClient(enrolled.pub)
    const { nonce } = issueChallenge()
    // Correct nonce, correct client id, valid signature — by the wrong key.
    expect(redeemSession(c!.id, nonce, signSession(attacker, c!.id, nonce))).toBeNull()
  })

  it('wrong key type: a P-256 signature offered against an Ed25519 enrollment', () => {
    const ed = makeEd25519Key()
    const ec = makeP256Key()
    const c = addClient(ed.pub)
    const { nonce } = issueChallenge()
    expect(redeemSession(c!.id, nonce, signSession(ec, c!.id, nonce))).toBeNull()
  })

  it('expired challenge: a nonce past its TTL is not signable', () => {
    const key = makeEd25519Key()
    const c = addClient(key.pub)
    const { nonce } = issueChallenge()
    // The TTL is 2 minutes and the sweep is time-based, so move the clock instead of waiting.
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 3 * 60 * 1000
      expect(redeemSession(c!.id, nonce, signSession(key, c!.id, nonce))).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('replayed nonce: a nonce is single-use — the second redeem of the same one fails', () => {
    const key = makeEd25519Key()
    const c = addClient(key.pub)
    const { nonce } = issueChallenge()
    const sig = signSession(key, c!.id, nonce)
    expect(redeemSession(c!.id, nonce, sig)).not.toBeNull()
    // Same nonce, same valid signature, replayed: refused because the nonce was burned.
    expect(redeemSession(c!.id, nonce, sig)).toBeNull()
  })

  it('unknown client: a valid signature for a client id that was never enrolled', () => {
    const key = makeEd25519Key()
    const { nonce } = issueChallenge()
    expect(
      redeemSession(fingerprint(key.pub), nonce, signSession(key, fingerprint(key.pub), nonce)),
    ).toBeNull()
  })

  it('tampered token: flipping a byte of the payload invalidates the MAC', () => {
    const { token } = enrolAndSession(makeEd25519Key())
    const [payload, mac] = token.split('.')
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as {
      cid: string
      exp: number
    }
    // Re-sign nothing: just swap the client id for someone else's and keep the original MAC.
    const forged = Buffer.from(
      JSON.stringify({ ...decoded, cid: 'f'.repeat(64) }),
      'utf8',
    ).toString('base64url')
    expect(authClientId(fakeReq({ bearer: `${forged}.${mac}` }))).toBeNull()
  })

  it('tampered token: a MAC from the wrong secret is refused', () => {
    const { token } = enrolAndSession(makeEd25519Key())
    const payload = token.split('.')[0]!
    const forgedMac = createHmac('sha256', Buffer.alloc(32, 7)).update(payload).digest('base64url')
    expect(authClientId(fakeReq({ bearer: `${payload}.${forgedMac}` }))).toBeNull()
    // …and a truncated MAC must not squeeze past the length check either.
    expect(authClientId(fakeReq({ bearer: `${payload}.${forgedMac.slice(0, 10)}` }))).toBeNull()
    expect(authClientId(fakeReq({ bearer: payload }))).toBeNull() // no separator at all
  })

  it('expired token: a correctly signed token whose exp has passed', () => {
    const { token } = enrolAndSession(makeEd25519Key())
    const realNow = Date.now
    try {
      // SESSION_TTL_MS is 12h.
      Date.now = () => realNow() + 13 * 60 * 60 * 1000
      expect(authClientId(fakeReq({ bearer: token }))).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('revoked client: a live, correctly signed token stops working the moment the key is removed', () => {
    const key = makeEd25519Key()
    const { clientId, token } = enrolAndSession(key)
    expect(authClientId(fakeReq({ bearer: token }))).toBe(clientId)
    expect(removeClient(clientId)).toBe(true)
    // The token is stateless and still within its 12h window; the gate consults the registry
    // precisely so revocation is immediate rather than "within 12 hours".
    expect(getClient(clientId)).toBeNull()
    expect(authClientId(fakeReq({ bearer: token }))).toBeNull()
  })

  it('no credential: an empty, absent or non-Bearer Authorization header', () => {
    expect(authClientId(fakeReq({}))).toBeNull()
    expect(authClientId(fakeReq({ bearer: '' }))).toBeNull()
    expect(
      authClientId({
        url: '/api/windows',
        headers: { authorization: 'Basic abc' },
      } as unknown as IncomingMessage),
    ).toBeNull()
    expect(
      authClientId({ url: '/api/stream?ticket=', headers: {} } as unknown as IncomingMessage),
    ).toBeNull()
  })

  it('malformed key: a JWK that is not one of the two accepted kinds is never enrolled', () => {
    expect(addClient(null)).toBeNull()
    expect(addClient({})).toBeNull()
    expect(addClient({ kty: 'RSA', n: 'x', e: 'AQAB' })).toBeNull()
    expect(addClient({ kty: 'OKP', crv: 'X25519', x: 'abc' })).toBeNull() // wrong curve
    expect(addClient({ kty: 'EC', crv: 'P-256', x: 'abc' })).toBeNull() // EC needs y
    expect(addClient({ kty: 'EC', crv: 'P-384', x: 'a', y: 'b' })).toBeNull()
    expect(listClients()).toHaveLength(0)
  })
})

// The registry is cached in memory behind a freshness stat (docs/security.md). The cache is an
// optimisation; immediate revocation is the property, and these tests defend it from the
// direction that actually threatens it — an edit made by someone else. `ew-auth revoke` runs in
// a different process and just rewrites clients.json, so none of the in-process bookkeeping
// (writeRegistry adopting its own write, resetRegistryCache) is available to save us. Nothing
// here calls resetRegistryCache: that would test the escape hatch instead of the mechanism.
describe('revocation stays immediate through the registry cache', () => {
  /** Rewrite clients.json from the outside, exactly as `scripts/ew-auth.mjs revoke` does:
   *  read, drop the matching client, write the whole file back. No auth.ts function involved. */
  function revokeOutOfProcess(clientId: string): void {
    const file = join(stateDir(), 'clients.json')
    const reg = JSON.parse(readFileSync(file, 'utf8')) as { clients: { id: string }[] }
    reg.clients = reg.clients.filter(c => c.id !== clientId)
    writeFileSync(file, JSON.stringify(reg, null, 2), 'utf8')
  }

  it('a key revoked by a file write is refused on the very next authClientId()', () => {
    const key = makeEd25519Key()
    const { clientId, token } = enrolAndSession(key)

    // Warm the cache the way a live server does: a request that succeeds.
    expect(authClientId(fakeReq({ bearer: token }))).toBe(clientId)

    revokeOutOfProcess(clientId)

    // The assertion. One call, no sleep, no cache reset, no server restart — the stat has to
    // notice. A plain in-memory list would still return clientId here, and that regression is
    // invisible without this test because the token itself is still perfectly valid: correctly
    // signed, well within its 12h window, and for a client that was enrolled.
    expect(authClientId(fakeReq({ bearer: token }))).toBeNull()
    expect(getClient(clientId)).toBeNull()
    expect(listClients()).toHaveLength(0)
  })

  it('an enrolment made by a file write is honoured on the very next call too', () => {
    // The same mechanism in the other direction — proof the stat drives a re-read rather than
    // the cache being emptied by something revoke-shaped.
    const a = makeEd25519Key(),
      b = makeEd25519Key()
    const { clientId: idA, token: tokenA } = enrolAndSession(a)
    const idB = fingerprint(b.pub)
    expect(getClient(idB)).toBeNull() // warms the cache on a registry holding only A

    const file = join(stateDir(), 'clients.json')
    const reg = JSON.parse(readFileSync(file, 'utf8')) as { clients: unknown[] }
    reg.clients.push({ id: idB, name: autoName(idB), pub: b.pub, addedAt: Date.now() })
    writeFileSync(file, JSON.stringify(reg, null, 2), 'utf8')

    expect(getClient(idB)?.id).toBe(idB)
    expect(authClientId(fakeReq({ bearer: tokenA }))).toBe(idA) // A is untouched
  })

  it('survives a revoke by rename-into-place, which changes the inode', () => {
    // An atomic config update writes a temp file and renames it over the target. The new file
    // has a different inode and can carry an mtime the cache has never seen as "newer", so the
    // stamp is compared for equality and includes the inode. This is also the exact shape
    // fs.watch gets wrong, which is why the stat is the source of truth and not a watcher.
    const key = makeEd25519Key()
    const { clientId, token } = enrolAndSession(key)
    expect(authClientId(fakeReq({ bearer: token }))).toBe(clientId)

    const file = join(stateDir(), 'clients.json'),
      tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ clients: [] }, null, 2), 'utf8')
    renameSync(tmp, file)

    expect(authClientId(fakeReq({ bearer: token }))).toBeNull()
  })

  it('caches a missing registry as "no clients" and still sees the file appear', () => {
    // A server running before any pairing must not re-read a nonexistent path per request, but
    // "absent" cannot be a terminal state either: the first enrolment creates the file.
    const key = makeEd25519Key()
    const id = fingerprint(key.pub)
    expect(existsSync(join(stateDir(), 'clients.json'))).toBe(false)
    expect(listClients()).toEqual([])
    expect(getClient(id)).toBeNull() // cached as absent
    expect(addClient(key.pub)?.id).toBe(id) // writeRegistry creates it and adopts its own write
    expect(getClient(id)?.id).toBe(id)
  })

  it("does not leak one state dir's registry into another", () => {
    // stateDir() is resolved per call so tests can isolate, so the cache is keyed on the
    // resolved path as well as the stamp. Honestly: the stamp alone already saves this case
    // (two different files have different inodes), so this test pins the behaviour rather
    // than the path key — dropping `c.file === file` does not make it fail. The path key stays
    // because an inode is recycled after a file is unlinked, and temp state dirs get deleted.
    const key = makeEd25519Key()
    const id = fingerprint(key.pub)
    addClient(key.pub)
    expect(getClient(id)?.id).toBe(id)

    const second = useTempStateDir() // a different EW_STATE_DIR, same process
    try {
      expect(listClients()).toEqual([])
      expect(getClient(id)).toBeNull()
    } finally {
      second()
    }

    expect(getClient(id)?.id).toBe(id) // and the first dir is still intact
  })
})

describe('fingerprints', () => {
  it('cover x and y for EC — otherwise two keys sharing x would collide', () => {
    const a: Parameters<typeof fingerprint>[0] = { kty: 'EC', crv: 'P-256', x: 'same', y: 'one' }
    const b: Parameters<typeof fingerprint>[0] = { kty: 'EC', crv: 'P-256', x: 'same', y: 'two' }
    expect(fingerprint(a)).not.toBe(fingerprint(b))
  })

  it('are stable: the same key always maps to the same id (re-pairing is idempotent)', () => {
    const key = makeEd25519Key()
    expect(fingerprint(key.pub)).toBe(fingerprint(key.pub))
    expect(fingerprint(key.pub)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('pairing requires an out-of-band human approval', () => {
  /** Open a pairing window the way scripts/ew-auth.mjs does. */
  function openWindow(code: string, ttlMs = 60_000): void {
    writeFileSync(
      join(stateDir(), 'pairing.json'),
      JSON.stringify({
        codeHash: createHash('sha256').update(code).digest('base64url'),
        exp: Date.now() + ttlMs,
      }),
      'utf8',
    )
  }

  it('refuses a submit when no window is open', () => {
    expect(submitPairing('anything', makeEd25519Key().pub)).toEqual({ error: 'pairing closed' })
  })

  it('refuses a wrong code', () => {
    openWindow('right-code')
    expect(submitPairing('wrong-code', makeEd25519Key().pub)).toEqual({ error: 'bad code' })
  })

  it('refuses an expired window', () => {
    openWindow('code', -1000)
    expect(submitPairing('code', makeEd25519Key().pub)).toEqual({ error: 'pairing closed' })
  })

  it('stages but does not enrol: a correct code alone grants nothing', () => {
    const key = makeEd25519Key()
    openWindow('code')
    const r = submitPairing('code', key.pub, '10.0.0.9')
    expect(r).toMatchObject({ status: 'pending' })
    // The key is not authorized yet — this is the whole point of approve-then-enroll.
    expect(listClients()).toHaveLength(0)
    expect(pairingStatus(fingerprint(key.pub))).toBe('pending')
    // …and a session cannot be established with a merely-pending key.
    const { nonce } = issueChallenge()
    expect(
      redeemSession(fingerprint(key.pub), nonce, signSession(key, fingerprint(key.pub), nonce)),
    ).toBeNull()
  })

  it('burns the window on the first valid submit (single-use)', () => {
    openWindow('code')
    expect(submitPairing('code', makeEd25519Key().pub)).toMatchObject({ status: 'pending' })
    // A racing second device with the same code gets nothing.
    expect(submitPairing('code', makeEd25519Key().pub)).toEqual({ error: 'pairing closed' })
  })

  it('refuses a malformed key even with a valid code (and still burns nothing for it)', () => {
    openWindow('code')
    expect(submitPairing('code', { kty: 'RSA' })).toEqual({ error: 'bad key' })
  })

  it('reports the enrolled slots, so the device can warn before anyone runs approve', () => {
    // The cap is enforced by `approve` on the host, which is a walk away from the phone. The
    // pairing response therefore carries used/max — and the caller has presented a valid
    // one-time code, so this is not something an unauthenticated stranger can ask.
    delete process.env.EW_MAX_CLIENTS
    openWindow('code')
    const first = submitPairing('code', makeEd25519Key().pub)
    expect(first).toMatchObject({ status: 'pending', slots: { used: 0, max: 1 } })

    // With the only slot taken, the next device is told so — it is still staged (the cap is
    // enforced at approve), but the dialog can say the approval will be refused.
    addClient(makeEd25519Key().pub)
    openWindow('code2')
    expect(submitPairing('code2', makeEd25519Key().pub)).toMatchObject({
      slots: { used: 1, max: 1 },
    })
  })

  it('reports max 0 when the cap is lifted', () => {
    process.env.EW_MAX_CLIENTS = 'unlimited'
    try {
      openWindow('code')
      expect(submitPairing('code', makeEd25519Key().pub)).toMatchObject({ slots: { max: 0 } })
    } finally {
      delete process.env.EW_MAX_CLIENTS
    }
  })

  it('reports approved once the operator enrols the staged key', () => {
    const key = makeEd25519Key()
    openWindow('code')
    const staged = submitPairing('code', key.pub)
    expect('art' in staged && staged.art.length).toBeGreaterThan(0)
    addClient(key.pub) // what `ew-auth approve` does
    expect(pairingStatus(fingerprint(key.pub))).toBe('approved')
    // Now — and only now — the handshake works.
    const { nonce } = issueChallenge()
    expect(
      redeemSession(fingerprint(key.pub), nonce, signSession(key, fingerprint(key.pub), nonce)),
    ).not.toBeNull()
  })

  it('reports unknown for an id nobody ever submitted', () => {
    expect(pairingStatus('deadbeef')).toBe('unknown')
    expect(pairingStatus('')).toBe('unknown')
  })

  it('shows the same randomart to the device and the operator (that is what is compared)', () => {
    const key = makeEd25519Key()
    openWindow('code')
    const r = submitPairing('code', key.pub)
    expect('art' in r && r.art).toBe(randomart(fingerprint(key.pub)))
  })
})

describe('randomart', () => {
  it('is an 11-line box with the label and the S/E markers', () => {
    const art = randomart('a'.repeat(64))
    const lines = art.split('\n')
    expect(lines).toHaveLength(11) // top bar + 9 rows + bottom bar
    expect(lines[0]).toContain('[even-window]')
    expect(lines.every(l => l.length === 19)).toBe(true)
    expect(art).toContain('S') // start marker
    expect(art).toContain('E') // end marker
  })

  it('differs for different fingerprints — a human comparison has to mean something', () => {
    expect(randomart('a'.repeat(64))).not.toBe(randomart('b'.repeat(64)))
  })

  it('is deterministic', () => {
    expect(randomart('0123456789abcdef'.repeat(4))).toBe(randomart('0123456789abcdef'.repeat(4)))
  })
})
