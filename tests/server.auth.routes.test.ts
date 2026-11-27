// even-window — route coverage for the auth gate.
//
// The claim is "every route this server registers is gated", so the list is derived:
//
//   1. the route table (`routes`, exported by src/server/main.ts) is the server's own
//      dispatch table, and every entry must answer 401 unauthenticated;
//   2. the set of gate-exempt (`open`) routes is pinned exactly;
//   3. src/server/main.ts is scanned for quoted `/api/…` literals and every one must be a
//      declared route path, which catches a hand-rolled branch outside the table.
//
// The requests are real HTTP against a real node:http listener: the gate lives in `route()`.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { issueTicket } from '../src/server/auth.ts'
import { corsOrigin, route, routes } from '../src/server/main.ts'
import { resetAppCache } from '../src/server/platform/x11/apps.ts'
import { enrolAndSession, makeEd25519Key, useTempStateDir } from './authFixture.ts'

/** The only routes that may be reachable without a session token: the handshake by which a
 *  device that has no identity yet acquires one. Editing this set changes the security
 *  posture — update docs/security.md in the same change. */
const EXPECTED_OPEN = [
  'GET /api/auth/challenge',
  'POST /api/auth/session',
  'POST /api/auth/pair',
  'GET /api/auth/pair/status',
].sort()

let server: Server
let origin = ''
let dispose: () => void
let token = ''
let clientId = ''

const req = async (
  method: string,
  path: string,
  opts: { token?: string; origin?: string; body?: unknown } = {},
): Promise<Response> => {
  const headers: Record<string, string> = {}
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.origin) headers.origin = opts.origin
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  return await fetch(`${origin}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    // /api/stream never ends; without this the fetch would hang the test run.
    signal: AbortSignal.timeout(5000),
  })
}

beforeAll(async () => {
  server = createServer((q, s) => {
    void route(q, s).catch(() => {
      s.statusCode = 500
      s.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const a = server.address()
  origin = typeof a === 'object' && a ? `http://127.0.0.1:${a.port}` : ''
})
afterAll(async () => {
  await new Promise<void>(r => {
    server.close(() => r())
  })
})

beforeEach(() => {
  dispose = useTempStateDir()
  delete process.env.EW_AUTH // enforcement on — the default
  delete process.env.EW_ORIGINS
  const session = enrolAndSession(makeEd25519Key())
  token = session.token
  clientId = session.clientId
})
afterEach(() => {
  dispose()
})

describe('the route table is the whole surface', () => {
  it('declares exactly these open (pre-auth) routes — nothing else', () => {
    const open = routes
      .filter(r => r.open)
      .map(r => `${r.method} ${r.path}`)
      .sort()
    expect(open).toEqual(EXPECTED_OPEN)
  })

  it('has no duplicate method+path (a shadowed route would never be reached)', () => {
    const keys = routes.map(r => `${r.method} ${r.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('contains every /api/… literal in src/server/main.ts — no hand-rolled branches', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/server/main.ts', import.meta.url)),
      'utf8',
    )
    const literals = [...src.matchAll(/'(\/api\/[^']*)'/g)].map(m => m[1])
    const declared = new Set(routes.map(r => r.path))
    const stray = [...new Set(literals)].filter(p => p !== undefined && !declared.has(p))
    // A route added as a hand-rolled branch would not be covered by the 401 sweep below.
    expect(
      stray,
      `these paths are referenced but not declared as routes: ${stray.join(', ')}`,
    ).toEqual([])
  })
})

describe('with EW_AUTH enforced, every non-open route answers 401 unauthenticated', () => {
  // Derived from the table, so a route added tomorrow is tested tomorrow with no edit here.
  for (const r of routes.filter(x => !x.open)) {
    it(`${r.method} ${r.path} → 401`, async () => {
      const res = await req(r.method, r.path, r.method === 'POST' ? { body: {} } : {})
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ ok: false, msg: 'unauthorized' })
    })
  }

  it('…including the SSE stream, which must not leak tiles to an unauthenticated peer', async () => {
    const res = await req('GET', '/api/stream')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    await res.text()
  })

  it('…and a bogus ?ticket= does not get past it either', async () => {
    const res = await req('GET', '/api/stream?ticket=not.a.token')
    expect(res.status).toBe(401)
    await res.text()
  })

  it('an unknown path is 404, not a 401 — the gate is not a path oracle to probe', async () => {
    const res = await req('GET', '/api/does-not-exist')
    expect(res.status).toBe(404)
  })
})

describe('the open routes really are reachable pre-auth (pairing must work from nowhere)', () => {
  it('GET /api/auth/challenge issues a nonce', async () => {
    const res = await req('GET', '/api/auth/challenge')
    expect(res.status).toBe(200)
    const j = (await res.json()) as { nonce?: string; exp?: number }
    expect(j.nonce).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(j.exp).toBeGreaterThan(Date.now())
  })

  it('POST /api/auth/session refuses garbage with 401 (not 500, not 200)', async () => {
    const res = await req('POST', '/api/auth/session', {
      body: { clientId: 'x', nonce: 'y', sig: 'z' },
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/auth/pair refuses with 403 when no pairing window is open', async () => {
    const res = await req('POST', '/api/auth/pair', {
      body: { code: 'x', pub: makeEd25519Key().pub },
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'pairing closed' })
  })

  it('GET /api/auth/pair/status answers unknown for an unknown id', async () => {
    const res = await req('GET', '/api/auth/pair/status?id=cafe')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'unknown' })
  })
})

describe('a real session gets through', () => {
  it('Bearer token → /api/auth/me names the authenticated client', async () => {
    const res = await req('GET', '/api/auth/me', { token })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { id: string; name: string; authEnabled: boolean }
    expect(j.id).toMatch(/^[0-9a-f]{64}$/)
    expect(j.name).toBe(`client-${j.id.slice(0, 8)}`)
    expect(j.authEnabled).toBe(true)
  })

  it('a session token in ?ticket= is refused — the kinds do not substitute', async () => {
    // The stream credential travels in a URL, so it is a separate 60s ticket. If the 1h
    // session token also worked there, the short TTL would buy nothing.
    const res = await req('GET', `/api/stream?ticket=${encodeURIComponent(token)}`)
    expect(res.status).toBe(401)
  })

  it('a ticket in the Authorization header is refused — the other direction too', async () => {
    const { ticket } = issueTicket(clientId)
    const res = await req('GET', '/api/auth/me', { token: ticket })
    expect(res.status).toBe(401)
  })

  it('GET /api/auth/ticket mints one for a Bearer-authenticated caller', async () => {
    const res = await req('GET', '/api/auth/ticket', { token })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { ticket: string; exp: number }
    expect(j.ticket).toMatch(/^[\w-]+\.[\w-]+$/)
    // 60s, not the session's hour.
    expect(j.exp - Date.now()).toBeLessThanOrEqual(60_000)
    expect(j.exp - Date.now()).toBeGreaterThan(30_000)
  })

  it('?ticket= → the SSE stream opens (the EventSource path)', async () => {
    const { ticket } = issueTicket(clientId)
    const res = await fetch(`${origin}/api/stream?ticket=${encodeURIComponent(ticket)}`, {
      headers: { origin: 'http://127.0.0.1:5273' },
      signal: AbortSignal.timeout(3000),
    }).catch((e: unknown) => e as Error)
    expect(res).toBeInstanceOf(Response)
    const r = res as Response
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    // EventSource is subject to CORS too, and the SSE response goes out through writeHead()
    // rather than sendJson(): the centrally-set headers must survive it.
    expect(r.headers.get('access-control-allow-origin')).toBe('*')
    // Read the first chunk (the `: open` comment + the primed avail event) and let go.
    const reader = r.body?.getReader()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value)).toContain(':')
    await reader?.cancel()
  })
})

describe('EW_AUTH=0 disables the gate (and nothing else)', () => {
  afterEach(() => {
    delete process.env.EW_AUTH
  })

  it('an unauthenticated gated route is answered instead of 401', async () => {
    process.env.EW_AUTH = '0'
    const res = await req('GET', '/api/auth/me')
    expect(res.status).toBe(200)
    // No identity to report, and the response says so rather than inventing one.
    expect(await res.json()).toMatchObject({ id: '', authEnabled: false })
  })

  it('a valid token still works with the gate off (the harness and a paired phone coexist)', async () => {
    process.env.EW_AUTH = '0'
    const res = await req('GET', '/api/auth/me', { token })
    expect(((await res.json()) as { id: string }).id).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('GET /api/apps — the launchable set, behind the gate', () => {
  // The 401 sweep above covers this route. This pins the shape an authenticated caller gets.
  it('answers a list with per-source counts and the override file path', async () => {
    const res = await req('GET', '/api/apps', { token })
    expect(res.status).toBe(200)
    const j = (await res.json()) as {
      list: { id: string; name: string; cmd: string; note: string; terminal: boolean }[]
      recent: string[]
      counts: Record<string, number>
      overrides: string
      errors: string[]
    }
    expect(Array.isArray(j.list)).toBe(true)
    expect(j.overrides).toMatch(/apps\.conf$/)
    expect(j.errors).toEqual([])
    for (const a of j.list) {
      expect(a.id).not.toBe('')
      expect(a.note).not.toBe('')
      expect(a.cmd).not.toBe('')
    }
    // `counts` is what makes a short list explainable rather than mysterious.
    for (const [k, v] of Object.entries(j.counts)) expect(typeof v, k).toBe('number')
    expect(j.counts.total).toBe(j.list.length)
  })
})

describe('POST /api/spawn — launches a launcher entry by id, and nothing else', () => {
  // No command line travels on the wire: the request names an entry and the server owns the
  // argv. This is not a security boundary (the list can contain a shell); authentication is.
  it('refuses a command line, with 400', async () => {
    for (const body of [{ cmd: 'xterm' }, { cmd: 'bash', args: ['-c', 'id'] }, {}]) {
      const res = await req('POST', '/api/spawn', { token, body })
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(((await res.json()) as { msg: string }).msg).toContain('id required')
    }
  })

  it('refuses an unknown app id with 404 rather than exec-ing anything', async () => {
    const res = await req('POST', '/api/spawn', { token, body: { id: 'x11:does-not-exist' } })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { msg: string }).msg).toContain('unknown app id')
  })

  it('still refuses when unauthenticated — the gate comes first, 401 not 403', async () => {
    const res = await req('POST', '/api/spawn', { body: { id: 'x11:xclock' } })
    expect(res.status).toBe(401)
  })

  it('a hidden entry cannot be launched, so apps.conf really takes effect', async () => {
    const dir = process.env.EW_STATE_DIR ?? ''
    expect(dir).not.toBe('')
    writeFileSync(join(dir, 'apps.conf'), 'app Hidden Thing = xcalc-not-real\n')
    resetAppCache()
    try {
      const list = (await (await req('GET', '/api/apps', { token })).json()) as {
        list: { id: string; cmd: string }[]
      }
      const id = list.list.find(a => a.cmd === 'xcalc-not-real')?.id ?? ''
      expect(id).not.toBe('')
      const ok = await req('POST', '/api/spawn', { token, body: { id } })
      // Listed, so accepted; the spawn itself then fails, which is 200 with ok:false.
      expect(ok.status).toBe(200)
      expect(await ok.json()).toMatchObject({ ok: false })
      writeFileSync(join(dir, 'apps.conf'), 'hide xcalc-not-real\n')
      resetAppCache()
      const no = await req('POST', '/api/spawn', { token, body: { id } })
      expect(no.status).toBe(404)
    } finally {
      rmSync(join(dir, 'apps.conf'), { force: true })
      resetAppCache()
    }
  })
})

describe('CORS', () => {
  it('echoes a loopback origin (Vite dev server, simulator WebView)', () => {
    expect(corsOrigin('http://127.0.0.1:5273', '127.0.0.1:8787', undefined, false)).toBe(
      'http://127.0.0.1:5273',
    )
    expect(corsOrigin('http://localhost:5273', 'localhost:8787', undefined, false)).toBe(
      'http://localhost:5273',
    )
  })

  it('echoes a different port on the same host — the phone-on-the-LAN topology', () => {
    expect(corsOrigin('http://192.168.1.5:5273', '192.168.1.5:8787', undefined, false)).toBe(
      'http://192.168.1.5:5273',
    )
    expect(
      corsOrigin('https://box.tail1234.ts.net', 'box.tail1234.ts.net:8787', undefined, false),
    ).toBe('https://box.tail1234.ts.net')
  })

  it('refuses a third-party origin', () => {
    expect(corsOrigin('https://evil.example', '192.168.1.5:8787', undefined, false)).toBe('')
    expect(corsOrigin('null', '192.168.1.5:8787', undefined, false)).toBe('')
    expect(corsOrigin('http://127.0.0.1.evil.example', '127.0.0.1:8787', undefined, false)).toBe('')
  })

  it('sends nothing when there is no Origin (curl/node are not CORS clients)', () => {
    expect(corsOrigin(undefined, '127.0.0.1:8787', undefined, false)).toBe('')
  })

  it('allows any origin by default while auth is enforced (the packaged app)', () => {
    expect(corsOrigin('https://anything.example', 'host:8787', undefined, true)).toBe('*')
    expect(corsOrigin('null', 'host:8787', '', true)).toBe('*')
  })

  it('honours EW_ORIGINS with or without auth, including an explicit `*`', () => {
    for (const auth of [true, false]) {
      expect(corsOrigin('https://app.example', 'host:8787', 'https://app.example', auth)).toBe(
        'https://app.example',
      )
      // A list replaces the wildcard default: this is how an operator narrows CORS under auth.
      expect(corsOrigin('https://other.example', 'host:8787', 'https://app.example', auth)).toBe('')
      expect(corsOrigin('http://127.0.0.1:5273', 'host:8787', 'https://app.example', auth)).toBe(
        'http://127.0.0.1:5273',
      )
      expect(corsOrigin('https://anything.example', 'host:8787', '*', auth)).toBe('*')
    }
  })

  it('live: with auth enforced any origin is allowed, preflight included', async () => {
    const res = await req('GET', '/api/auth/challenge', { origin: 'https://packaged.example' })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    // `*` does not vary by request, so there is nothing for a cache to key on.
    expect(res.headers.get('vary')).toBeNull()
    const pre = await req('OPTIONS', '/api/spawn', { origin: 'https://packaged.example' })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('*')
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization')
  })

  it('live: the 401 from the gate still carries CORS, or the browser sees an opaque failure', async () => {
    const res = await req('GET', '/api/health', { origin: 'https://packaged.example' })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('live: EW_ORIGINS narrows CORS under auth', async () => {
    process.env.EW_ORIGINS = 'https://app.example'
    try {
      const ok = await req('GET', '/api/auth/challenge', { origin: 'https://app.example' })
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example')
      expect(ok.headers.get('vary')).toBe('origin')
      const bad = await req('GET', '/api/auth/challenge', { origin: 'https://evil.example' })
      expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      delete process.env.EW_ORIGINS
    }
  })

  describe('with EW_AUTH=0', () => {
    beforeEach(() => {
      process.env.EW_AUTH = '0'
    })
    afterEach(() => {
      delete process.env.EW_AUTH
    })

    it('live: an allowed origin gets ACAO + Vary, a foreign one gets neither', async () => {
      const ok = await req('GET', '/api/auth/challenge', { origin: 'http://127.0.0.1:5273' })
      expect(ok.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5273')
      expect(ok.headers.get('vary')).toBe('origin')
      const bad = await req('GET', '/api/auth/challenge', { origin: 'https://evil.example' })
      expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('live: the OPTIONS preflight is 204 for an allowed origin and carries no ACAO for a foreign one', async () => {
      const ok = await req('OPTIONS', '/api/spawn', { origin: 'http://127.0.0.1:5273' })
      expect(ok.status).toBe(204)
      expect(ok.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5273')
      expect(ok.headers.get('access-control-allow-headers')).toContain('authorization')
      const bad = await req('OPTIONS', '/api/spawn', { origin: 'https://evil.example' })
      // 204 either way (a preflight performs nothing), but with no ACAO the browser refuses to
      // send the real request — which for a JSON POST means it is never sent at all. With the
      // gate off this refusal is the only thing between a web page and /api/spawn.
      expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    })
  })
})
