// The server link: which server, the auth state, and the fetch helpers.
//
// The client modules import each other freely, but only from inside functions: nothing here may
// use another non-leaf module while this one is still loading.

import {
  bearer,
  type DurableStore,
  isPaired,
  resetSession,
  setAuthBase,
  setLegacyAdoptable,
} from './authClient.ts'
import { log } from './debugLog.ts'
import { flagSource, noteFlag } from './flags.ts'
import { maybePromptPairing } from './main.ts'
import { syncSetupNotice } from './overlay.ts'
import { renderRootPanel, syncServerField } from './phoneUi.ts'
import { kickPump, setForcePending } from './pump.ts'
import { rootLeft } from './root.ts'
import { confirmServerChange, serverChangeNeedsConfirm } from './serverGuard.ts'
import { needsServerAddress, openServerSetup } from './serverSetup.ts'
import { renderStatus, setStatus } from './statusUi.ts'
import { startStream } from './stream.ts'
import { addTarget, rootOpen, setRootOpen, targetList } from './targets.ts'
import { errText, withTimeout } from './util.ts'

// ── server address ─────────────────────────────────────────────────────────────────────────
// The API base is explicit and may be cross-origin (the simulator and the Vite dev server are
// other origins than the API; see docs/protocol.md for the CORS policy).
// Resolution order: `?server=` → localStorage → default. A chosen address is persisted; the
// default is a guess and is not, so the next load can still tell that nobody chose.

const LOOPBACK_SERVER = 'http://localhost:8787'
const SERVER_KEY = 'ew.server'

/** Trim and drop a trailing slash so `${SERVER}/api/x` never doubles up. */
export function normaliseServer(raw: string): string {
  const s = raw.trim()
  return s.endsWith('/') ? s.replace(/\/+$/, '') : s
}

/** Hosts for which "the API is on my own localhost" is a sane guess. */
function isLoopbackHost(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
}

/** The API base to assume when nothing was specified. Pure.
 *  `http://localhost:8787` only makes sense when this page is itself on localhost; from any
 *  other origin the best guess is our own origin, which is right behind a single-origin
 *  reverse proxy. */
export function defaultServer(origin: string, host: string): string {
  if (!origin || origin === 'null') return LOOPBACK_SERVER // file://, sandboxed iframe
  return isLoopbackHost(host.replace(/:\d+$/, '')) ? LOOPBACK_SERVER : normaliseServer(origin)
}

export let SERVER = LOOPBACK_SERVER

/** True while `SERVER` is the default and nobody chose it: no `?server=`, no stored value, no
 *  address entered or pasted. See `maybeAskForServer`. */
export let serverIsGuess = false

/** A `?server=` that `initServer` did not adopt by itself, pending `settlePendingServer`
 *  (see src/client/serverGuard.ts). */
let pendingServerParam = ''

export function initServer(): void {
  let q: string | null = null
  try {
    q = new URLSearchParams(location.search).get('server')
  } catch {
    /* no location */
  }
  let stored: string | null = null
  // Read the stored base even when `?server=` is present: the two are compared (serverGuard.ts).
  try {
    stored = localStorage.getItem(SERVER_KEY)
  } catch {
    /* storage blocked */
  }
  let fallback = LOOPBACK_SERVER
  try {
    fallback = defaultServer(location.origin, location.host)
  } catch {
    /* no location */
  }
  // Defer: whether the change may be adopted depends on `isPaired()`, which is async, and boot
  // must not wait on it. Keep the stored base meanwhile. With no stored base there is nothing
  // to protect and the param wins outright.
  if (q?.trim() && stored?.trim() && normaliseServer(q) !== normaliseServer(stored)) {
    pendingServerParam = q
    noteFlag('server', flagSource(false, true), normaliseServer(stored))
    setServer(stored)
    return
  }
  const v = q?.trim() ? q : stored?.trim() ? stored : fallback
  const from = flagSource(!!q?.trim(), !!stored?.trim())
  // Recorded like the boolean flags, so a server URL persisted by a previous run is visible.
  noteFlag('server', from, normaliseServer(v))
  setServer(v, from === 'default')
  // An app served from a real origin (the dev server, a single-origin proxy) was loaded from
  // that server, so it is listed without anyone typing it. The loopback default never is.
  if (from === 'default' && SERVER !== LOOPBACK_SERVER) addTarget(SERVER)
}

/** Point the client at an API base. `guess` marks the built-in default, which is used but not
 *  stored; every other caller passes an address somebody chose. */
export function setServer(raw: string, guess = false): void {
  SERVER = normaliseServer(raw)
  serverIsGuess = guess
  // The key of an earlier version goes to a server somebody chose, never to the default.
  setLegacyAdoptable(!guess)
  if (!guess) {
    try {
      localStorage.setItem(SERVER_KEY, SERVER)
    } catch {
      /* storage blocked */
    }
    void serverStore?.set(SERVER_KEY, SERVER)
    // Every address somebody chose is a server this device can open again (targets.ts).
    if (addTarget(SERVER)) renderRootPanel()
  }
  // A different server has a different signing secret: drop the cached session so the old
  // server's token is never sent to the new one.
  setAuthBase(SERVER)
  resetSession()
}

// ── the address in the bridge's durable store ──────────────────────────────────────────────
// In the packaged Even Hub app localStorage does not survive a restart of the app (observed on
// an iPhone, 2026-11-27), so the chosen address is mirrored where the device key already is.

let serverStore: DurableStore | null = null

/** Wire the durable store, once the bridge exists. A chosen address is written to it; when
 *  this load is still on the guessed default, the address kept there is adopted. It is one
 *  this device chose earlier, so no confirmation is asked. */
export async function wireServerStore(store: DurableStore): Promise<void> {
  serverStore = store
  if (!serverIsGuess) {
    void store.set(SERVER_KEY, SERVER)
    return
  }
  let kept = ''
  try {
    kept = normaliseServer((await withTimeout(store.get(SERVER_KEY), 3000, 'server store')) ?? '')
  } catch {
    /* slow or failing bridge: stay on the guess, and the address card may open */
  }
  if (!kept || !serverIsGuess) return
  log(`server: ${kept} recovered from the durable store`)
  // At the list the address is only adopted: it becomes a row, and opening it is a tap.
  if (rootOpen) {
    setServer(kept)
    syncServerField()
    return
  }
  switchServer(kept)
}

/** Adopt a new API base mid-run: re-point the handshake, drop the old session and re-open
 *  the stream. Never a reload, which would re-establish the glasses page (docs/glasses.md). */
export function switchServer(raw: string): void {
  // Connecting is what leaves the server list, whoever asked for it.
  const fromRoot = rootOpen
  if (fromRoot) setRootOpen(false)
  setServer(raw)
  syncServerField()
  setAuthState('unknown')
  setStatus(`server changed — reconnecting: ${SERVER}`)
  setForcePending(true)
  startStream()
  kickPump()
  if (fromRoot) rootLeft()
}

/** Resolve a `?server=` that `initServer` deferred. Unpaired: adopt it. Paired: one human
 *  tap, defaulting to keeping the current server. */
export function settlePendingServer(paired: boolean): void {
  const param = pendingServerParam
  if (!param) return
  pendingServerParam = ''
  const to = normaliseServer(param)
  if (!serverChangeNeedsConfirm(param, SERVER, paired, normaliseServer)) {
    log(`server: adopted ?server=${to} (unpaired — no identity to relay)`)
    switchServer(param)
    return
  }
  // Logged as well as shown: a headless run has nobody to tap.
  log(`server: ?server=${to} DIFFERS from ${SERVER} on a paired device — asking before adopting`)
  try {
    confirmServerChange({
      from: SERVER,
      to,
      onAccept: () => {
        log(`server: accepted ${to}`)
        switchServer(param)
      },
      onKeep: () => {
        log(`server: kept ${SERVER}`)
      },
    })
  } catch (e) {
    log(`server: confirm dialog failed (${errText(e)}) — kept ${SERVER}`)
  }
}

// ── authenticated transport (docs/security.md) ─────────────────────────────────────────────
// Every /api call carries the session bearer when this device is paired; unpaired sends no
// header (correct for EW_AUTH=0 and for the open pairing routes). A 401 triggers one
// re-establish and retry, then the pairing prompt.

/** 'unknown' until a request has been answered. Drives the status line;
 *  `unpaired`/`unauthorized` opens the pairing dialog. */
type AuthState = 'unknown' | 'ok' | 'unpaired' | 'unauthorized' | 'offline'
export let authState: AuthState = 'unknown'

export function setAuthState(s: AuthState): void {
  if (authState === s) return
  authState = s
  renderStatus()
  syncSetupNotice()
  // A refused paired device (key revoked, registry wiped) and an unpaired one both need the
  // pairing dialog.
  if (s === 'unpaired' || s === 'unauthorized') maybePromptPairing()
  if (s === 'offline') void maybeAskForServer()
}

// ── asking for the server address ──────────────────────────────────────────────────────────
// The packaged app starts on a guessed address that cannot answer (src/client/serverSetup.ts).
// Asked at most once per page load, and only once the identity is known: before the bridge's
// durable store is wired, a device that holds a key still looks unpaired, and would be sent to
// the pairing dialog to enrol a second one.

let identitySettled = false
let askedForServer = false

/** Called by boot when `isPaired()` can be trusted: the durable store is wired, or there is
 *  no bridge to wait for. */
export function identityIsSettled(): void {
  identitySettled = true
  void maybeAskForServer()
}

async function maybeAskForServer(): Promise<void> {
  if (askedForServer || !identitySettled) return
  // At the list there is no request to fail, so the question is only whether a server is known.
  if (
    rootOpen ? targetList().length > 0 : !needsServerAddress(serverIsGuess, authState === 'offline')
  )
    return
  askedForServer = true
  const tried = SERVER
  if (!(await isPaired())) {
    log(
      rootOpen
        ? 'server: none in the list and no identity — opening the pairing dialog'
        : `server: no answer from the default ${tried} and no identity — opening the pairing dialog`,
    )
    maybePromptPairing()
    return
  }
  log(
    rootOpen
      ? 'server: none in the list on a paired device — asking for the address'
      : `server: no answer from the default ${tried} on a paired device — asking for the address`,
  )
  try {
    openServerSetup({
      tried,
      onServer: origin => {
        log(`server: address entered — ${origin}`)
        switchServer(origin)
      },
    })
  } catch {
    /* no DOM (tests): the log line above is the record */
  }
}

export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const doFetch = async (tok: string | null): Promise<Response> => {
    const h = new Headers(init?.headers ?? {})
    if (tok) h.set('Authorization', 'Bearer ' + tok)
    return await fetch(`${SERVER}${path}`, { ...init, headers: h })
  }
  const isAuthPath = path.startsWith('/api/auth/')
  // At the server list no server is open. The pairing routes are let through: enrolling is how
  // the first server gets into the list.
  if (rootOpen && !isAuthPath) throw new Error('no server is open')
  const tok = await bearer()
  let r: Response
  try {
    r = await doFetch(tok)
  } catch (e) {
    setAuthState('offline')
    throw e
  }
  if (r.status === 401 && !isAuthPath) {
    if (tok == null) {
      setAuthState('unpaired')
      return r
    } // server demands auth, no identity
    resetSession()
    const tok2 = await bearer()
    if (tok2) {
      try {
        r = await doFetch(tok2)
      } catch (e) {
        setAuthState('offline')
        throw e
      }
    }
    setAuthState(r.status === 401 ? 'unauthorized' : 'ok')
  } else if (!isAuthPath && r.ok) {
    setAuthState('ok')
  }
  return r
}

export async function apiPost<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const r = await authFetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await r.json()) as T
  } catch (e) {
    log(`POST ${path} failed: ${errText(e)}`)
    return null
  }
}

/** Authenticated GET + JSON; returns null rather than throwing, like `apiPost`. */
export async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const r = await authFetch(path)
    return (await r.json()) as T
  } catch (e) {
    log(`GET ${path} failed: ${errText(e)}`)
    return null
  }
}
