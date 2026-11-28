// pinhole-window — the server entry point: bare node:http, SSE tile stream, gesture router.
//
// Shape of the process: bring up the mirrored desktop through the platform backend, poll its
// window list at 1 Hz, and serve the routes of docs/protocol.md behind the authentication gate
// of docs/security.md.
//
// Every route is declared in one table (`routes` below) and dispatched from it. That is the
// gate's correctness condition: a route that is not in the table is not reachable, and
// tests/server.auth.routes.test.ts enumerates the table and scans this file for path literals
// outside it. Do not add a hand-rolled `if (path === …)` branch.
//
// The mirrored desktop outlives this process (docs/platform.md): on SIGINT/SIGTERM the capture
// stops and the listener closes, but the desktop and its applications stay up so a restart
// reattaches.

// Must be the first import: it applies the env file before any other module reads
// process.env at load. A bare side-effect import is never reordered by the formatter.
import './env.boot.ts'

import { statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AppBinding, AppIdentity } from '../shared/bindings.ts'
import {
  bindingLabel,
  DEFAULT_SWIPE,
  isBindingKey,
  needsWindow,
  normAppBinding,
  resolveSwipe,
} from '../shared/bindings.ts'
import { isRatpoisonKey, RP_PREFIX } from '../shared/glassMenu.ts'
import { type Chord, chordToXdo, type Mod, wheelButton } from '../shared/keys.ts'
import type { EnrolledClient, RoutedGesture, StreamEvent, WinInfo } from '../shared/types.ts'
import { noteLaunch, recentApps } from './appRecency.ts'
import {
  authClientId,
  authEnabled,
  autoName,
  type Client,
  clientCountBanner,
  clientLimitWarning,
  getClient,
  issueChallenge,
  issueTicket,
  listClients,
  maxClients,
  overCap,
  overCapRefusal,
  pairingStatus,
  redeemSession,
  removeClient,
  sessionBindingStatus,
  stateDir,
  stateDirWarning,
  submitPairing,
} from './auth.ts'
import { bindingErrors, bindingsMap, bindingsPath, setBinding } from './bindings.ts'
// The report of the side-effect import at the top of this file; ordering is that import's job.
import { envFileReport } from './env.boot.ts'
import { envFileBanner } from './envFile.ts'
import { isInputKind, keyNameToChord } from './input.ts'
import { InstanceBook } from './instances.ts'
import { appIdOfWindow, noteLaunchPid } from './launches.ts'
import { platform } from './platform/index.ts'
import type { WinSel } from './platform/types.ts'
import { createLimiter, limitSource } from './ratelimit.ts'
import {
  avail,
  onAppsChanged,
  onBindingsChanged,
  onClientsChanged,
  onWindowsChanged,
  setAvail,
  subscribe,
} from './stream.ts'
import {
  isPcmRate,
  maxPcmBytes,
  STT_MAX_SECONDS,
  STT_RATE_DEFAULT,
  sttEnabled,
  transcribe,
} from './stt.ts'
import { processFrame } from './tiles.ts'
import {
  closeWindow,
  focusedApp,
  listWindows,
  selectWindow,
  spawnApp,
  windowsKey,
  windowsMru,
} from './windows.ts'

const PORT = Number(process.env.EW_PORT) || 8787

// Bind address: loopback by default. Every route is effectively remote code execution, and
// the real boundary is the authentication gate (docs/security.md, src/server/auth.ts), on by
// default. Loopback stays the default bind so an `EW_AUTH=0` run is not one flag away from
// publishing a shell to the LAN. A tunnel substitutes for neither: Tailscale authenticates
// the network, not the client. `EW_HOST=0.0.0.0` opts in explicitly; the start-up banner
// warns (see `transportWarning`).
const HOST = process.env.EW_HOST || '127.0.0.1'

/** Bind addresses that are not reachable off this machine. Deliberately separate from the
 *  `LOOPBACK` set of the CORS policy: widening that one must not silence a warning about a
 *  bind. */
const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** The banner lines for a bind that is reachable off this machine over plaintext, or [] when
 *  there is nothing to say. Pure. This process terminates no TLS
 *  (docs/decisions/no-tls-termination.md), and auth protects neither the channel nor the
 *  server's identity: a session token read off the wire is replayable until it expires, and
 *  an in-path attacker can impersonate this host. The auth-off case is not reported here; its
 *  own banner covers it. */
export function transportWarning(host: string, authOn: boolean): string[] {
  if (!authOn) return [] // the auth-off banner owns this case, and says more
  if (LOOPBACK_BIND.has(host)) return [] // unreachable off-box: nothing is on a wire
  return [
    `WARNING: bound to ${host} over PLAIN HTTP — this server terminates no TLS.`,
    '  Auth proves which client is calling. It does not encrypt the channel and does not' +
      ' prove this server to the device:',
    '  a session token read off the wire is replayable for an hour, and an in-path attacker' +
      ' can impersonate this host.',
    '  Put TLS in front and keep this bind on loopback — `tailscale serve`' +
      ' (docs/getting-started.md), or any reverse proxy with a real certificate.',
  ]
}
/** Rate limit for the gate-exempt routes only (see src/server/ratelimit.ts). */
const openLimiter = createLimiter()

/** EW_QUIET=1 silences the per-request access log (see route()). */
const QUIET = process.env.EW_QUIET === '1'
const POLL_MS = 1000
const HEARTBEAT_MS = 15_000
/** Upper bound on a move-N repeat. A settle window (docs/glasses.md) accumulates a handful of
 *  swipes; anything larger is a stuck client, and replaying it would hold the injection path
 *  for seconds. */
const MAX_COUNT = 64

// ── gesture → action (docs/glasses.md) ─────────────────────────────────────────────────
// Pure and exported, so the whole mapping is unit-testable without a backend.

export type GestureAction =
  /** Inject `key` into the mirrored desktop `repeat` times, then answer once. For `up`/`down`
   *  the key comes from the per-app binding, `DEFAULT_SWIPE` (`Up`/`Down`) when nothing is
   *  bound. */
  | { kind: 'key'; key: string; repeat: number }
  /** Turn the wheel `repeat` notches, under `mods` if the chord carries any. A key goes to
   *  the focused window; the wheel goes to the window under the pointer
   *  (`platform.input.wheel`). */
  | { kind: 'wheel'; button: 4 | 5; mods: Mod[]; repeat: number }
  /** Handled with no injection: `double` opens the client's own menu, and an injected key
   *  would land under it. */
  | { kind: 'client' }

/** The gestures this route routes. `GestureName` is deliberately wider: the device also emits
 *  `long` / `longRelease`, which the client names and logs and this route rejects, because no
 *  action is bound to them here. */
const ROUTED: readonly RoutedGesture[] = ['tap', 'double', 'up', 'down']

/** One bound chord → the action that runs it. This is the only place the key/wheel branch is
 *  taken: a wheel chord is not a key name, so sent down the key path it would be accepted and
 *  do nothing (src/shared/keys.ts). */
function swipeAction(c: Chord, repeat: number): GestureAction {
  const b = wheelButton(c.key)
  if (b === null) return { kind: 'key', key: chordToXdo(c), repeat }
  return { kind: 'wheel', button: b, mods: c.mods, repeat }
}

/** (gesture, count, binding) → what the server does. null = not a gesture we route (→ 400).
 *  Pure: `swipe` is a parameter, so the bindings file and the focused window stay the
 *  caller's problem (see `swipeBinding`). */
export function gestureAction(
  gesture: string,
  count?: unknown,
  swipe: AppBinding = DEFAULT_SWIPE,
): GestureAction | null {
  const g = ROUTED.find(x => x === gesture)
  if (!g) return null
  // Absent / NaN / <1 ⇒ 1.
  const repeat = Math.min(MAX_COUNT, Math.max(1, Math.floor(Number(count)) || 1))
  switch (g) {
    // A swipe is a move-N: repeat the bound key `count` times and answer once. The repeat
    // applies to whatever is bound — five swipes of a bound `Return` is five commands.
    case 'up':
      return swipeAction(swipe.up, repeat)
    case 'down':
      return swipeAction(swipe.down, repeat)
    // tap = activate. Never repeated: N taps is not a meaningful gesture, and a double
    // Return in a shell would run a command twice.
    case 'tap':
      return { kind: 'key', key: keyNameToChord('Enter'), repeat: 1 }
    // double is client-owned: the client opens its own root list over the tiles
    // (docs/glasses.md). Injecting anything here would fire a stray key under the menu.
    case 'double':
      return { kind: 'client' }
  }
}

// ── window-set cache, kept fresh by the poll ───────────────────────────────────────────

let winList: WinInfo[] = []
let winRecent: string[] = []
let winKey = ''
let polling = false

/** Re-list the mirrored desktop's windows; publish to SSE only when the set changed, so an
 *  idle desktop costs one enumeration a second and no network traffic. */
async function pollWindows(): Promise<void> {
  if (polling) return // a slow enumeration must not stack up overlapping polls
  polling = true
  try {
    const list = await listWindows()
    const key = windowsKey(list)
    // The recency order is read whether or not we publish: `GET /api/windows` answers from
    // this cache. Every change to the order also changes the key, so it needs no gate.
    winRecent = windowsMru()
    if (key === winKey) return
    winKey = key
    winList = list
    onWindowsChanged(list, winRecent) // stream.ts owns the SSE fan-out
  } catch {
    /* transient: the desktop may be mid-restart. The next tick retries. */
  } finally {
    polling = false
  }
}

// ── who is enrolled (docs/security.md) ─────────────────────────────────────────────────
//
// Every connected device is told who is enrolled, and the phone compares that against what
// it saw last time, so a key that was added is noticed.
//
// Polled on the 1 Hz window tick, not watched: the registry read is the stat-gated cache in
// src/server/auth.ts (one `statSync` per second), and `fs.watch` can miss the event this
// exists to deliver. There is no route that enrolls or revokes; only `scripts/ew-auth.mjs`,
// on the host, changes the registry.

/** The wire shape of the registry: the server's `Client` minus its public key. Pure and
 *  exported so a test pins that `pub` cannot leak into the stream. */
export function clientsWire(list: readonly Client[]): EnrolledClient[] {
  return list.map(c => ({
    id: c.id,
    name: c.name,
    addedAt: c.addedAt,
    ...(c.addedIp ? { addedIp: c.addedIp } : {}),
  }))
}

/** Change key for the enrolled set. Includes the name and the enforcement flag, not only the
 *  ids: a rename is worth showing, and flipping EW_AUTH changes what the list means.
 *  Order-insensitive, so a rewrite that only reorders entries is not a change. Pure. */
export function clientsKey(list: readonly EnrolledClient[], enforced: boolean): string {
  return `${enforced ? 'on' : 'off'}|${list
    .map(c => `${c.id}:${c.name}`)
    .sort()
    .join(',')}`
}

let clientsKeyLast: string | null = null
/** Publish the enrolled set if it changed (or `force`, for the boot priming). */
function publishClients(force = false): void {
  const enforced = authEnabled()
  const list = clientsWire(listClients())
  const key = clientsKey(list, enforced)
  if (!force && key === clientsKeyLast) return
  clientsKeyLast = key
  // A key appeared while running, past the cap. Start-up refuses this state; here it is only
  // reported (see `clientCountBanner`), and the push below marks it on the phone. Fires once
  // per change, because an unchanged set returned above. `force` is the boot priming, which
  // cannot be over the cap (the refusal ran first).
  if (!force && overCap()) {
    for (const l of clientCountBanner(list.length, maxClients(), stateDir(), enforced)) {
      console.warn(`[ew] ${l}`)
    }
  }
  onClientsChanged(list, enforced)
}

// ── which key a swipe sends, right now (docs/glasses.md) ───────────────────────────────
//
// Two early exits, in this order:
//   1. Nothing app-specific is bound (the default) ⇒ `needsWindow` is false and the focused
//      window is never asked for: the gesture costs one injection and no lookup.
//   2. Something is bound ⇒ resolve from the actual focus (`focusedApp`), not from `winList`:
//      the 1 Hz cache would send the previous app's key on the first swipe after a switch.
//
// `cls`, `title` and the launcher attribution do come from winList: they do not change while
// the window lives, and the wid they are looked up by was just read from the live focus.
function identityOf(wid: string, comm: string, exe: string): AppIdentity {
  const w = wid ? winList.find(x => x.wid === wid) : undefined
  return {
    appId: appIdOfWindow(wid),
    exe,
    app: comm,
    cls: w?.cls ?? '',
    title: w?.title ?? '',
  }
}

async function swipeBinding(): Promise<{ binding: AppBinding; via: string }> {
  const map = bindingsMap()
  if (!needsWindow(map)) return resolveSwipe(map, null)
  const f = await focusedApp()
  return resolveSwipe(map, identityOf(f.wid, f.comm, f.exe))
}

// ── the launchable set (`GET /api/apps`, docs/protocol.md) ─────────────────────────────
//
// The backend's catalogue (`platform.apps`) owns the scan and its cache; this is only the
// publication path. `appsSig` suppresses a no-op SSE frame as `winKey` does for windows.

let appsSig = ''

/** Push the current list + recency to subscribers, if either changed. */
async function publishApps(force = false): Promise<void> {
  const { apps } = await platform.apps.list(force)
  const recentIds = recentApps(apps, platform.apps.seedCommand())
  const sig = `${apps.map(a => a.id).join(',')}|${recentIds.join(',')}`
  if (sig === appsSig) return
  appsSig = sig
  onAppsChanged(apps, recentIds)
}

// ── tiny HTTP helpers ──────────────────────────────────────────────────────────────────

// ── CORS (docs/security.md) ────────────────────────────────────────────────────────────
//
// Tokens are Bearer headers, so a foreign page has no credential to ride on, and the gate is
// what protects every route. CORS adds something only where the gate is absent, so the default
// follows `EW_AUTH` (docs/decisions/cors-follows-auth.md):
//   * auth enforced, `EW_ORIGINS` unset → any origin. The packaged app runs on an origin of
//     the Even App's choosing, which is not knowable here.
//   * `EW_AUTH=0`, `EW_ORIGINS` unset → the narrow policy below, because then an open
//     preflight would let any web page send a JSON POST to an unauthenticated server.
//   * `EW_ORIGINS` set → exactly what it says, in both cases, on top of the narrow policy.
//     `*` is the wildcard; any other list replaces the wildcard default.
// The narrow policy:
//   * no Origin header → allowed: not a browser, so there is no same-origin policy to satisfy;
//   * loopback origin  → allowed: the dev server and the simulator load the app from
//     127.0.0.1 on another port;
//   * same host as the request was addressed to, any port/scheme → allowed: the phone loads
//     the app and calls the API on the same host, and a third-party site is never that host.
// Everything else gets no CORS headers, so the browser refuses the exchange.

/** Host part of an `Origin` / `Host` header value, lowercased, port stripped. '' if unparseable.
 *  `Host` arrives bare (`example:8787`), `Origin` with a scheme — handle both. */
function hostOf(v: string): string {
  const s = v.trim().toLowerCase()
  if (!s) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `http://${s}`
  try {
    return new URL(withScheme).hostname
  } catch {
    return ''
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** The value to echo in `access-control-allow-origin`, or '' to send no CORS headers.
 *  Pure — `origin` is the request's Origin header, `host` its Host header, `auth` whether the
 *  gate is enforced. */
export function corsOrigin(
  origin: string | undefined,
  host: string | undefined,
  configured: string | undefined = process.env.EW_ORIGINS,
  auth: boolean = authEnabled(),
): string {
  const list = (configured ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
  if (list.includes('*') || (auth && list.length === 0)) return '*'
  if (!origin) return '' // no Origin ⇒ not a CORS request; nothing to echo
  if (list.includes(origin)) return origin
  const oh = hostOf(origin)
  if (!oh) return ''
  if (LOOPBACK.has(oh)) return origin
  if (host && oh === hostOf(host)) return origin
  return ''
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const allow = corsOrigin(req.headers.origin, req.headers.host)
  if (!allow) return
  res.setHeader('access-control-allow-origin', allow)
  // Not `*`: the echoed origin varies per request, so a shared cache must key on it.
  if (allow !== '*') res.setHeader('vary', 'origin')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, authorization')
}

/** CORS headers are applied once, centrally, in `route()` before dispatch, so every response
 *  (including the SSE stream and the gate's 401) carries them. `setHeader` values survive a
 *  later `writeHead`. */
function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Read a JSON request body. Resolves {} on empty or malformed input: every route has an
 *  all-defaults behaviour, so a parse failure is not a 500. Capped at 64 KiB. */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let n = 0
    req.on('data', (d: Buffer) => {
      n += d.length
      if (n > 65_536) {
        req.destroy()
        return resolve({})
      }
      chunks.push(d)
    })
    req.on('error', () => resolve({}))
    req.on('end', () => {
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
  })
}

/** Read a raw request body, capped, for the one route whose payload is not JSON. Unlike
 *  `readJson` it distinguishes "too big" from "empty": a truncated recording would be
 *  transcribed into a wrong sentence, so the caller must be able to refuse it. */
function readBytes(req: IncomingMessage, maxBytes: number): Promise<Uint8Array | 'too-large'> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let n = 0
    let done = false
    const finish = (v: Uint8Array | 'too-large'): void => {
      if (done) return
      done = true
      resolve(v)
    }
    req.on('data', (d: Buffer) => {
      if (done) return // past the cap: draining, not collecting
      n += d.length
      if (n > maxBytes) {
        // Drain, do not destroy: destroying closes the socket before the 413 can be written,
        // and the client sees a network error. The buffer is released, so memory stays bounded.
        chunks.length = 0
        req.resume()
        return finish('too-large')
      }
      chunks.push(d)
    })
    req.on('error', () => {
      finish(new Uint8Array(0))
    })
    req.on('end', () => {
      finish(new Uint8Array(Buffer.concat(chunks)))
    })
  })
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function selOf(b: Record<string, unknown>): WinSel {
  return { sel: str(b.sel) || undefined, wid: str(b.wid) || undefined }
}

// ── SSE ────────────────────────────────────────────────────────────────────────────────

const sseClients = new Set<ServerResponse>()
/** Per open stream: who it belongs to, so a supersede can be addressed. */
const sseWho = new Map<
  ServerResponse,
  {
    cid: string
    inst: string
    write: (ev: StreamEvent) => void
    /** Has this stream been told to stand down? Read on close — see the note there. */
    told: boolean
  }
>()
/** Which instance owns the glasses (src/server/instances.ts). */
const instances = new InstanceBook()

function handleStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // nginx buffers proxied responses by default, which would hold tiles back.
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()
  res.write(': open\n\n') // push the headers through any intermediary right away

  const write = (ev: StreamEvent): void => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }

  // subscribe() primes synchronously, so registering is all that is needed.
  const unsubscribe = subscribe(write)
  // Comment-only heartbeat: idle proxies and some mobile NATs drop a silent stream.
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, HEARTBEAT_MS)

  sseClients.add(res)

  // ── which instance owns the glasses (docs/decisions/glasses-instance-supersede.md) ─────
  // The identity is the auth client id, so two WebViews on one phone (one enrolled key)
  // arbitrate against each other and two paired devices do not. With auth off everything
  // shares the `-` bucket.
  const inst = new URL(req.url ?? '', 'http://x').searchParams.get('inst') ?? ''
  const cid = authClientId(req) ?? '-'
  sseWho.set(res, { cid, inst, write, told: false })
  const verdict = instances.verdict(cid, inst)
  if (verdict === 'stale') {
    // The old page's EventSource retrying: told again and not adopted (instances.ts). The
    // stream is left open — ending it would make a client that does not understand the
    // message reconnect in a loop, and a client that does understand closes itself.
    const by = instances.currentOf(cid) ?? ''
    console.log(
      `[ew] stream inst=${inst.slice(0, 8)} is STALE (current=${by.slice(0, 8)}) — told to stand down`,
    )
    const me = sseWho.get(res)
    if (me) me.told = true
    write({ t: 'supersede', by })
  } else if (verdict === 'adopt') {
    const displaced = instances.adopt(cid, inst)
    if (displaced !== null) {
      let told = 0
      for (const [other, info] of sseWho) {
        if (other === res || info.cid !== cid || info.inst === inst) continue
        info.told = true
        info.write({ t: 'supersede', by: inst })
        told++
      }
      // The count disambiguates the log: zero means the old page was already gone, which is
      // the good outcome, not a failure to deliver.
      console.log(
        `[ew] stream inst=${inst.slice(0, 8)} TAKES OVER from ${displaced.slice(0, 8)}` +
          ` — ${String(told)} live stream(s) told to stand down` +
          (told === 0 ? ' (the old page was already gone)' : ''),
      )
    }
  }

  const done = (): void => {
    clearInterval(beat)
    unsubscribe()
    sseClients.delete(res)
    // The one server-visible proof that a stand-down landed: a superseded client closes its
    // stream, which arrives here. The line's absence means the old page is wedged or does not
    // understand the message. Logged unconditionally, not only under `?debug=1`.
    const info = sseWho.get(res)
    if (info?.told === true) {
      console.log(`[ew] stream inst=${info.inst.slice(0, 8)} CLOSED after being told to stand down`)
    }
    // `instances` is not touched: a disconnect must not release ownership (instances.ts).
    sseWho.delete(res)
    if (!res.writableEnded) res.end()
  }
  req.on('close', done)
  req.on('error', done)
  res.on('error', done)
}

// ── routes (docs/protocol.md, gated per docs/security.md) ──────────────────────────────

/** One entry per reachable URL. `open: true` means "reachable before authentication" and is
 *  only correct for the handshake by which a device without an identity acquires one — four
 *  routes: challenge, session, pair and pair status. Adding `open` anywhere else adds an
 *  unauthenticated remote-code-execution path; tests/server.auth.routes.test.ts pins the open
 *  set. */
export interface Route {
  method: 'GET' | 'POST'
  path: string
  /** Gate-exempt. Only the auth and pairing handshake. */
  open?: true
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export const routes: readonly Route[] = [
  // ── the auth handshake (gate-exempt) ───────────────────────────────────────────────────
  // Challenge → sign → session token. src/server/auth.ts owns the model.
  {
    method: 'GET',
    path: '/api/auth/challenge',
    open: true,
    handler: (_req, res) => sendJson(res, issueChallenge()),
  },
  {
    method: 'POST',
    path: '/api/auth/session',
    open: true,
    handler: async (req, res) => {
      const b = await readJson(req)
      const clientId = str(b.clientId),
        nonce = str(b.nonce),
        sig = str(b.sig)
      // `origin` is the destination the client believes it is talking to. Not trusted as
      // input: `redeemSession` folds it back into the signed material
      // (src/shared/sessionBinding.ts).
      const r = clientId && nonce && sig ? redeemSession(clientId, nonce, sig, str(b.origin)) : null
      // One 401 for every failure mode (unknown client / dead nonce / bad signature): the
      // client's reaction is the same, and a breakdown would help an attacker.
      if (!r) return sendJson(res, { error: 'pairing required or bad signature' }, 401)
      return sendJson(res, r)
    },
  },
  // Pairing is gate-exempt by necessity: it is how a device with no identity acquires one.
  // It is gated by the one-time code and an out-of-band human approval of the randomart
  // (src/server/auth.ts).
  {
    method: 'GET',
    path: '/api/auth/pair/status',
    open: true,
    handler: (req, res) => {
      const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? ''
      return sendJson(res, { status: id ? pairingStatus(id) : 'unknown' })
    },
  },
  {
    method: 'POST',
    path: '/api/auth/pair',
    open: true,
    handler: async (req, res) => {
      const b = await readJson(req)
      // Source IP of the pairing device, recorded on the pending entry for the operator.
      // X-Forwarded-For (a proxy / `tailscale serve`) is preferred over the socket peer. It is
      // untrusted: shown to a human, never compared.
      const xff = str(req.headers['x-forwarded-for']).split(',')[0]?.trim() ?? ''
      const ip = xff || req.socket.remoteAddress || ''
      const r = submitPairing(str(b.code), b.pub ?? null, ip)
      if ('error' in r) return sendJson(res, r, 403)
      return sendJson(res, r)
    },
  },

  // ── this device's enrolled identity ────────────────────────────────────────────────────
  // The caller's own id + label, so the debug UI can say which key it is using. An empty id
  // means auth is off.
  {
    method: 'GET',
    path: '/api/auth/me',
    handler: (req, res) => {
      const cid = authClientId(req)
      const c = cid ? getClient(cid) : null
      return sendJson(res, {
        id: cid ?? '',
        name: c?.name ?? '',
        custom: !!(c && cid && c.name !== autoName(cid)),
        authEnabled: authEnabled(),
      })
    },
  },

  // The caller withdraws its own enrolment: a phone that forgets this server takes its key
  // off the registry as it goes. Only the caller's own key, named by the session it presents,
  // so it grants nothing the caller did not already have (docs/security.md).
  {
    method: 'POST',
    path: '/api/auth/revoke-self',
    handler: (req, res) => {
      const cid = authClientId(req)
      if (!cid) return sendJson(res, { ok: false, authEnabled: authEnabled() })
      const ok = removeClient(cid)
      console.log(
        `[auth] ${cid.slice(0, 12)}… revoked its own key${ok ? '' : ' (was not enrolled)'}`,
      )
      return sendJson(res, { ok })
    },
  },

  // ── a short-lived ticket for the stream (docs/decisions/stream-ticket.md) ──────────────
  // Gated: it is minted from a session. `EventSource` cannot set headers, so the stream
  // credential goes in a URL, and what goes there is a separate 60-second ticket that only
  // opens the stream (src/server/auth.ts).
  {
    method: 'GET',
    path: '/api/auth/ticket',
    handler: (req, res) => {
      const cid = authClientId(req)
      // Unreachable with auth on (the gate ran first). With EW_AUTH=0 there is no identity to
      // mint for, and the stream answers unauthenticated anyway.
      if (!cid) return sendJson(res, { ticket: '', exp: 0, authEnabled: authEnabled() })
      return sendJson(res, { ...issueTicket(cid), authEnabled: true })
    },
  },

  // ── the mirror (docs/protocol.md) ──────────────────────────────────────────────────────
  // Gated. The credential arrives as `?ticket=`, and `authClientId()` accepts only a ticket
  // there, never a session token.
  { method: 'GET', path: '/api/stream', handler: handleStream },

  // Gated on purpose: health reports the display, the backend and the capture pid, which is
  // reconnaissance. A liveness probe does not need it open — a 401 from this server already
  // proves the listener and the gate are alive (scripts/{sim,dev}.sh accept 200 or 401).
  {
    method: 'GET',
    path: '/api/health',
    handler: (_req, res) => {
      const info = platform.session.info()
      return sendJson(res, {
        ok: avail().ok,
        display: info.display,
        backend: info.backend,
        pid: info.pid,
        fps: info.fps,
        // Advertises whether `EW_STT_URL` is set, so the client offers voice input only when
        // it can work (docs/voice.md).
        stt: sttEnabled(),
      })
    },
  },

  {
    method: 'GET',
    path: '/api/windows',
    handler: async (_req, res) => {
      await pollWindows() // answer from live state, not from the cache's last tick
      return sendJson(res, { list: winList, recent: winRecent })
    },
  },
  {
    method: 'POST',
    path: '/api/windows',
    handler: async (req, res) => {
      const sel = selOf(await readJson(req))
      if (!sel.sel && !sel.wid) return sendJson(res, { ok: false, msg: 'need sel or wid' }, 400)
      const ok = await selectWindow(sel)
      void pollWindows() // the active flag moved; refresh the SSE view promptly
      return sendJson(res, ok ? { ok: true } : { ok: false, msg: 'select failed' })
    },
  },
  {
    method: 'POST',
    path: '/api/windows/close',
    handler: async (req, res) => {
      const ok = await closeWindow(selOf(await readJson(req)))
      void pollWindows()
      return sendJson(res, ok ? { ok: true } : { ok: false, msg: 'close failed' })
    },
  },

  // The launchable set.
  {
    method: 'GET',
    path: '/api/apps',
    handler: async (req, res) => {
      // `?rescan=1` forces a full scan. Without it the backend answers from its cache.
      const q = new URL(req.url ?? '', 'http://x').searchParams
      const rescan = q.get('rescan') === '1'
      const r = await platform.apps.list(rescan)
      await publishApps(false)
      return sendJson(res, {
        list: r.apps,
        recent: recentApps(r.apps, platform.apps.seedCommand()),
        counts: r.counts,
        // `?why=1` adds the per-entry skip reasons. Opt-in: it is several times the size of
        // the list.
        ...(q.get('why') === '1' ? { skipped: r.skipped } : {}),
        // The user's own override file: where it is, and anything wrong with it.
        overrides: platform.apps.overridesPath(),
        errors: r.errors,
      })
    },
  },

  {
    method: 'POST',
    path: '/api/spawn',
    handler: async (req, res) => {
      const b = await readJson(req)

      // The request names an entry of `GET /api/apps` and nothing else. The server owns the
      // argv (the backend's `launchArgv`, including any terminal wrapper), so no command line
      // arrives over the wire.
      const id = str(b.id)
      if (id) {
        const app = await platform.apps.byId(id)
        if (!app) return sendJson(res, { ok: false, msg: `unknown app id: ${id}` }, 404)
        const [cmd, ...args] = platform.apps.launchArgv(app)
        if (!cmd) return sendJson(res, { ok: false, msg: `app ${id} has no command` }, 500)
        const pid = spawnApp(cmd, args)
        // The launch registry gives the window its `app:` swipe identity (launches.ts). This
        // is the only point that knows both the LauncherEntry and the process it became.
        if (pid) noteLaunchPid(app.id, pid)
        if (pid && noteLaunch(app.id)) void publishApps()
        console.log(
          `[ew] spawn id=${id} pid=${pid || '-'} ${cmd} ${args.join(' ')} => ${pid ? 'ok' : 'failed'}`,
        )
        return sendJson(
          res,
          pid ? { ok: true, id, name: app.name } : { ok: false, msg: `spawn failed: ${cmd}` },
        )
      }

      return sendJson(res, { ok: false, msg: 'id required: an entry of GET /api/apps' }, 400)
    },
  },

  // The gesture router: ~1 action per gesture, resolved by the pure gestureAction above.
  {
    method: 'POST',
    path: '/api/input',
    handler: async (req, res) => {
      const b = await readJson(req)
      const g = str(b.gesture)
      // Only the two gestures that have a binding resolve one (see `swipeBinding`).
      const sw = g === 'up' || g === 'down' ? await swipeBinding() : null
      const act = gestureAction(g, b.count, sw?.binding)
      if (!act) return sendJson(res, { handled: false, msg: 'bad gesture' }, 400)
      // One line per routed gesture: the server-side record that a burst collapsed into one
      // `count=N` call (docs/glasses.md). `via` names the binding entry that won (`comm:less`,
      // `*`) and is absent when the built-in default answered.
      console.log(
        `[ew] input gesture=${g} count=${act.kind === 'client' ? 1 : act.repeat} action=${act.kind}` +
          (act.kind === 'key' ? ` key=${act.key}` : '') +
          (act.kind === 'wheel'
            ? ` button=${String(act.button)}${act.mods.length ? ` mods=${act.mods.join('+')}` : ''}`
            : '') +
          (sw?.via ? ` via=${sw.via}` : ''),
      )
      if (act.kind === 'client') return sendJson(res, { handled: true })
      const ok =
        act.kind === 'wheel'
          ? await platform.input.wheel(act.button, act.repeat, act.mods)
          : act.repeat > 1
            ? await platform.input.repeatKey(act.key, act.repeat)
            : await platform.input.inject('key', act.key)
      return sendJson(res, ok ? { handled: true } : { handled: false, msg: 'inject failed' })
    },
  },

  // ── the per-app swipe bindings (docs/glasses.md) ───────────────────────────────────────
  // Read by the phone's editor and written by it one entry at a time. The key catalogue is
  // not on the wire: src/shared/keys.ts is compiled into the client.
  {
    method: 'GET',
    path: '/api/bindings',
    handler: (_req, res) =>
      sendJson(res, {
        map: bindingsMap(),
        // What a swipe does with nothing bound, for the editor's inherited rows.
        default: DEFAULT_SWIPE,
        file: bindingsPath(),
        // Entries dropped on read (a hand edit naming a key outside the catalogue).
        errors: bindingErrors(),
      }),
  },
  {
    method: 'POST',
    path: '/api/bindings',
    handler: async (req, res) => {
      const b = await readJson(req)
      const key = str(b.key)
      // Clearing is a verb on this route, not a second route: bind and unbind are one
      // control in the UI.
      if (b.clear === true) {
        // A malformed key is still a 400: answering `ok` would let a client believe it had
        // unbound something it had misspelled.
        if (!isBindingKey(key))
          return sendJson(res, { ok: false, msg: `not an app key: ${key}` }, 400)
        const changed = setBinding(key, null)
        if (changed) onBindingsChanged(bindingsMap())
        console.log(`[ew] bindings clear ${key} => ${changed ? 'removed' : 'nothing to remove'}`)
        return sendJson(res, { ok: true, key, map: bindingsMap() })
      }
      // Validated here, against the same catalogue the editor renders from: the client
      // cannot be the gate, and an unknown key would be a swipe that silently does nothing.
      const binding = normAppBinding(b)
      if (!binding) {
        return sendJson(
          res,
          {
            ok: false,
            msg:
              'need up and down, each {mods:[ctrl|alt|shift], key:<one of src/shared/keys.ts>}' +
              ', and an optional submit:<one of SUBMIT_CHORDS, e.g. "ctrl+Return" or "off">' +
              ', newline:<one of NEWLINE_CHORDS> and fontsize:<one of FONTSIZE_STEPS>',
          },
          400,
        )
      }
      if (!setBinding(key, binding)) {
        // Either the key is not an app key, or the binding is already exactly this. Only the
        // first is an error.
        const already = bindingsMap()[key]
        if (!already) return sendJson(res, { ok: false, msg: `not an app key: ${key}` }, 400)
        return sendJson(res, { ok: true, key, map: bindingsMap(), unchanged: true })
      }
      onBindingsChanged(bindingsMap())
      console.log(`[ew] bindings set ${key} ${bindingLabel(binding)}`)
      return sendJson(res, { ok: true, key, map: bindingsMap() })
    },
  },

  // Low-level input, for debugging and for client features outside the gesture router.
  // `{kind:'type'}` types into whatever has focus on the mirrored desktop, so this is the
  // most directly dangerous route in the table.
  {
    method: 'POST',
    path: '/api/desktop/input',
    handler: async (req, res) => {
      const b = await readJson(req)
      const kind = str(b.kind)
      if (!isInputKind(kind)) return sendJson(res, { ok: false, msg: `bad kind: ${kind}` }, 400)
      const ok = await platform.input.inject(kind, str(b.arg))
      return sendJson(res, ok ? { ok: true } : { ok: false, msg: 'inject failed' })
    },
  },

  // ── speech to text (docs/voice.md) ─────────────────────────────────────────────────────
  // The body is raw s16le mono PCM and `?rate=` says how to read it. Gated: this route hands
  // what a microphone heard to another process.
  {
    method: 'POST',
    path: '/api/stt',
    handler: async (req, res) => {
      // Off by default; the 503 names the setting.
      if (!sttEnabled()) {
        return sendJson(res, { ok: false, error: 'STT is not configured — set EW_STT_URL' }, 503)
      }
      const raw = new URL(req.url ?? '', 'http://x').searchParams.get('rate')
      const rate = raw === null ? STT_RATE_DEFAULT : Number(raw)
      if (!isPcmRate(rate)) return sendJson(res, { ok: false, error: `bad rate: ${str(raw)}` }, 400)
      const body = await readBytes(req, maxPcmBytes(rate))
      if (body === 'too-large') {
        return sendJson(
          res,
          {
            ok: false,
            error: `too much audio — the cap is ${String(STT_MAX_SECONDS)}s`,
          },
          413,
        )
      }
      // An odd byte count cannot be 16-bit samples: the client is framing wrong.
      if (body.length % 2 !== 0) {
        return sendJson(
          res,
          {
            ok: false,
            error: `odd byte count (${String(body.length)}) — this is not s16le`,
          },
          400,
        )
      }
      const r = await transcribe(body, rate)
      // 502 for an upstream failure; the phone shows `error` to a human. `ok:true` with an
      // empty text is a success — nobody spoke.
      return sendJson(res, r, r.ok ? 200 : 502)
    },
  },
  // ── the window manager's own keyboard, from the glasses menu ───────────────────────────
  // Sends the window manager's prefix plus one key from the closed catalogue in
  // src/shared/glassMenu.ts (`RP_KEYS`). The client names a key, never a command; the prefix
  // lives on the server. An unknown name is refused here with a 400, because sent on it
  // would silently do nothing.
  {
    method: 'POST',
    path: '/api/wm/key',
    handler: async (req, res) => {
      const b = await readJson(req)
      const key = str(b.key)
      if (!isRatpoisonKey(key))
        return sendJson(res, { ok: false, msg: `not a menu key: ${key}` }, 400)
      const ok = await platform.input.wmKey(key)
      console.log(`[ew] ratpoison ${RP_PREFIX} ${key} => ${ok ? 'ok' : 'failed'}`)
      return sendJson(res, ok ? { ok: true, key } : { ok: false, msg: 'inject failed' })
    },
  },
  // ── raw gesture envelopes, for diagnosing the real device ──────────────────────────────
  // The server-side record of what the device actually sent, next to what the normaliser
  // (shared/evenEvent.ts) made of it. Gated, and the client only posts under `?debug=1`.
  {
    method: 'POST',
    path: '/api/debug/event',
    handler: async (req, res) => {
      const b = await readJson(req)
      console.log(
        `[ew] RAW ${JSON.stringify(b.event ?? b)}  -> ${JSON.stringify(b.gesture ?? null)}`,
      )
      return sendJson(res, { ok: true })
    },
  },
  // ── the client's own log, batched, onto this process's stdout ──────────────────────────
  // Gated like the route above. It interleaves what the client believed with what the server
  // did, in one stream. The client batches (LogForwarder in src/client), and the caps below
  // are the server's own backstop.
  {
    method: 'POST',
    path: '/api/debug/log',
    handler: async (req, res) => {
      const b = await readJson(req)
      const lines = Array.isArray(b.lines) ? b.lines : []
      const take = lines.slice(0, DEBUG_LOG_MAX_LINES)
      for (const raw of take) {
        const e = (raw ?? {}) as { t?: unknown; m?: unknown }
        // Newlines are flattened: one client line stays one server line.
        const msg = str(e.m)
          .replace(/[\r\n]+/g, ' / ')
          .slice(0, DEBUG_LOG_MAX_CHARS)
        console.log(`[ew] CLIENT ${hhmmss(e.t)} ${msg}`)
      }
      return sendJson(res, { ok: true, n: take.length })
    },
  },
]

/** Per-request caps for `POST /api/debug/log`: they bound what a chatty client can do to this
 *  process's stdout. */
const DEBUG_LOG_MAX_LINES = 200
const DEBUG_LOG_MAX_CHARS = 600

/** `HH:MM:SS.mmm` from the client's epoch-ms stamp, or `--:--:--.---` if it sent nonsense.
 *  The client's clock is used deliberately: a disagreement with the server's own timestamps
 *  shows a batch that flushed late. */
function hhmmss(t: unknown): string {
  if (typeof t !== 'number' || !Number.isFinite(t)) return '--:--:--.---'
  const d = new Date(t)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** The gate. Rejects before any handler runs. */
function authorized(req: IncomingMessage, r: Route): boolean {
  if (r.open === true) return true
  if (!authEnabled()) return true
  return authClientId(req) != null
}

/** Log a 429 at most once every 5s, with the number refused in between: a line per refused
 *  request would make the log the amplifier. */
let throttleCount = 0
let throttleLogAt = 0
function noteThrottle(path: string): void {
  throttleCount += 1
  const now = Date.now()
  if (now - throttleLogAt < 5000) return
  throttleLogAt = now
  console.warn(
    `[ew] rate limit: refused ${throttleCount} request(s) on open routes (latest ${path})`,
  )
  throttleCount = 0
}

export async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  const path = new URL(req.url ?? '/', 'http://x').pathname

  cors(req, res) // once, centrally — the gate's 401 and the SSE stream both need it

  // The CORS preflight never carries an Authorization header, so it is answered before the
  // gate. It performs no action; `cors()` has already decided what the origin may ask.
  if (method === 'OPTIONS') {
    res.statusCode = 204
    return void res.end()
  }

  const r = routes.find(x => x.method === method && x.path === path)

  // Access log, on by default (EW_QUIET=1 silences it): one line per request tells "the
  // client never connected" apart from "it connected and got a 401". The stream logs once,
  // at open.
  if (!QUIET) {
    const who = authClientId(req)?.slice(0, 8) ?? '-'
    console.log(`[ew] ${method} ${path} cid=${who}${r ? '' : ' (no route)'}`)
  }

  if (!r) return sendJson(res, { ok: false, msg: 'not found' }, 404)
  // Rate limit, for the gate-exempt routes only and before the handler (ratelimit.ts).
  if (r.open === true && !openLimiter.take(limitSource(req.socket.remoteAddress))) {
    res.setHeader('retry-after', String(openLimiter.retryAfterSec()))
    noteThrottle(path)
    return sendJson(res, { ok: false, msg: 'slow down' }, 429)
  }
  if (!authorized(req, r)) return sendJson(res, { ok: false, msg: 'unauthorized' }, 401)
  return await r.handler(req, res)
}

// ── lifecycle ──────────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[ew] route ${req.method} ${req.url}: ${msg}`)
    if (!res.headersSent) sendJson(res, { ok: false, msg }, 500)
    else if (!res.writableEnded) res.end()
  })
})

async function main(): Promise<void> {
  // ── fail closed before anything else ────────────────────────────────────────────────────
  // More keys enrolled than EW_MAX_CLIENTS allows means the gate in force is wider than the
  // configuration asks for (see `overCapRefusal`). Checked before the desktop and the
  // listener, so a refusal has no side effects.
  if (overCap()) {
    for (const line of envFileBanner(envFileReport)) console.error(`[ew] ${line}`)
    for (const line of overCapRefusal(listClients().length, maxClients(), stateDir())) {
      console.error(`[ew] ${line}`)
    }
    process.exit(1)
  }

  // A failed bring-up is not fatal: avail() carries the reason to every subscriber.
  try {
    await platform.session.start({ frame: processFrame, avail: setAvail })
  } catch (e: unknown) {
    console.error(`[ew] startX11 failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  await pollWindows()
  const poll = setInterval(() => {
    void pollWindows()
    // One stat per second; it is what makes an enrollment made in another process
    // (`ew-auth approve`) reach every connected phone.
    publishClients()
  }, POLL_MS)
  poll.unref?.() // never hold the process open on the poll alone

  // Prewarm the application scan (about a second on the X11 backend, then cached), so the first
  // `GET /api/apps` is instant and the banner can report what was found. A failure is not
  // fatal: the apps panel is empty, the mirror still runs.
  try {
    const r = await platform.apps.list(true)
    await publishApps(false)
    console.log(`[ew] apps: ${r.summary}`)
    for (const e of r.errors) console.warn(`[ew] apps.conf: ${e}`)
  } catch (e: unknown) {
    console.error(`[ew] app scan failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Publish the swipe bindings once, at boot, unconditionally: the empty map is the answer
  // for a fresh install and must prime subscribers, and a hand-edit complaint surfaces here
  // instead of inside the first gesture.
  const bmap = bindingsMap()
  onBindingsChanged(bmap)
  const bn = Object.keys(bmap).length
  if (bn > 0) console.log(`[ew] swipe bindings: ${bn} (${bindingsPath()})`)

  // Publish the enrolled set once, at boot, unconditionally: "no keys enrolled" must also
  // prime a subscriber.
  publishClients(true)
  for (const e of bindingErrors()) console.warn(`[ew] bindings.json: ${e}`)

  server.listen(PORT, HOST, () => {
    // What the env file set comes first: the lines below report values it may have chosen.
    for (const line of envFileBanner(envFileReport)) console.log(`[ew] ${line}`)
    const info = platform.session.info()
    console.log(
      `[ew] http://${HOST}:${PORT}  display=${info.display} backend=${info.backend} fps=${info.fps}`,
    )
    const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1'
    if (authEnabled()) {
      console.log(`[ew] auth ENFORCED (EW_AUTH) — state ${stateDir()}`)
      // How many keys, and in which registry: this makes a start against the wrong
      // EW_STATE_DIR obvious.
      const enrolled = listClients().length
      const cap = maxClients()
      const overCap = cap > 0 && enrolled > cap
      for (const l of clientCountBanner(enrolled, cap, stateDir(), true)) {
        if (enrolled > 0 && !overCap) console.log(`[ew] ${l}`)
        else console.warn(`[ew] ${l}`)
      }
      // Reported on every start, enforced or not: with `tailscale serve` in front
      // `transportWarning` is silent, so this is the only line that reports an unset EW_ORIGIN.
      const sb = sessionBindingStatus()
      if (sb.enforced) console.log(`[ew] ${sb.line}`)
      else console.warn(`[ew] ${sb.line}`)
      // Silent at the default cap of 1.
      for (const line of clientLimitWarning()) console.warn(`[ew] ${line}`)
      // A state dir looser than 0700 is reported, not silently chmod'ed.
      try {
        for (const line of stateDirWarning(statSync(stateDir()).mode)) console.warn(`[ew] ${line}`)
      } catch {
        /* no state dir yet: nothing to warn about, and the next write creates it 0700 */
      }
      for (const line of transportWarning(HOST, true)) console.warn(`[ew] ${line}`)
    } else {
      // Printed on every start: auth being off must never go unnoticed.
      console.warn('[ew] WARNING: EW_AUTH is OFF — every route is UNAUTHENTICATED.')
      console.warn(
        '[ew]   /api/spawn and /api/desktop/input are both arbitrary code execution as this user.\n' +
          `[ew]   Anything that can reach ${HOST}:${PORT} owns this account.` +
          (loopback ? ' Bound to loopback, so that is this machine only.' : ''),
      )
      if (!loopback) {
        console.warn(
          `[ew]   and it is listening on ${HOST}: the whole LAN / tailnet can reach it.\n` +
            '[ew]   Stop this now: unset EW_AUTH (enforcement is the default) or set EW_HOST=127.0.0.1.',
        )
      }
    }
  })

  let closing = false
  const shutdown = (sig: string): void => {
    if (closing) return
    closing = true
    console.log(`[ew] ${sig}: stopping capture, leaving the X stack up`)
    clearInterval(poll)
    platform.session.stopCapture() // only the capture stops; the desktop stays up (docs/platform.md)
    for (const c of sseClients) {
      if (!c.writableEnded) c.end()
    }
    sseClients.clear()
    sseWho.clear()
    server.close(() => process.exit(0))
    // Backstop: a half-open keep-alive socket must not make us hang on exit.
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// Only bootstrap when run as the entry point (`node src/server/main.ts`). Tests import this
// module for its pure exports and must not start a desktop or a listener.
if (import.meta.main) await main()
