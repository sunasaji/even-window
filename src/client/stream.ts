// pinhole-window — the server event stream (SSE) and what each event updates.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.

import type { StreamEvent } from '../shared/types.ts'
import { streamTicket } from './authClient.ts'
import { setBindings } from './bindingsEditor.ts'
import { setEnrolledKeys } from './clients.ts'
import { log } from './debugLog.ts'
import { setApps, setWindows } from './menu.ts'
import { INSTANCE_ID, standDownSuperseded, superseded, syncOverlay } from './overlay.ts'
import { voiceBtn } from './phoneUi.ts'
import { kickPump, setForcePending } from './pump.ts'
import { authFetch, SERVER } from './serverLink.ts'
import { setStatus } from './statusUi.ts'
import { processTile, tileFault } from './tiles.ts'
import { maybeOpenTourOnFirstRun } from './tour.ts'
import { errText } from './util.ts'

export let availMsg: string | null = null

/** Does the server have a recogniser? `GET /api/health` answers it. Voice is offered only when
 *  it does, since a server setting is not something the client can infer (docs/voice.md). */
export let sttReady = false

// ── SSE stream ─────────────────────────────────────────────────────────────────────────────

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

let es: EventSource | null = null
let streamOpened = false
/** Did the current stream URL carry a `?ticket=`? Boot opens the stream before the Even bridge
 *  (and therefore the durable identity store) is available, so this records whether a re-open
 *  is needed once an identity turns up. */
export let streamTicketed = false

export function stopStream(): void {
  if (es) {
    es.close()
    es = null
  }
  streamOpened = false
}

/** Open (or re-open) the tile stream.
 *
 *  Async because EventSource cannot set an Authorization header: a short-lived ticket rides in
 *  the URL as `?ticket=` (docs/security.md) and fetching it is a promise. Unpaired means no
 *  ticket, which an EW_AUTH=0 server accepts.
 *
 *  EventSource reports a 401 as a bare `error` and retries forever, so a `fetch` probe of a
 *  gated route goes through `authFetch`, whose state machine opens the pairing dialog. */
export function startStream(): void {
  void startStreamAsync()
}

/** Debounce for the fresh-ticket re-open in `onerror`: long enough that a flapping link cannot
 *  make it a handshake loop, short enough that a real drop recovers promptly. */
const STREAM_REOPEN_MS = 3000
let streamReopenAt = 0

/** Which call to `startStreamAsync` is the current one. The function awaits `streamTicket()`
 *  between closing the old EventSource and opening the new one, so two overlapping calls (boot
 *  makes them) would each open one and leak the loser; the generation lets the older call
 *  stand down. */
let streamGen = 0

async function startStreamAsync(): Promise<void> {
  // A superseded instance must not come back through the stream's own retry path.
  if (superseded) return
  const gen = ++streamGen
  stopStream()
  // A 60-second ticket, not the session token: a URL is the worst place for a long-lived
  // credential (proxy logs, referrers, the address bar). See docs/decisions/stream-ticket.md.
  const tok = await streamTicket()
  // A newer call started while we were fetching: it owns the stream.
  if (gen !== streamGen) return
  streamTicketed = tok != null
  let src: EventSource
  try {
    // `inst` rides alongside the ticket because `EventSource` cannot set headers. It is not a
    // credential: it is a random that identifies this page load, so the server can tell two
    // instances apart.
    const q =
      `?inst=${encodeURIComponent(INSTANCE_ID)}` + (tok ? `&ticket=${encodeURIComponent(tok)}` : '')
    src = new EventSource(`${SERVER}/api/stream${q}`)
  } catch (e) {
    setStatus(`stream failed: ${errText(e)}`)
    return
  }
  es = src
  // Fire-and-forget liveness/auth probe. GET /api/health is gated, so its status tells us
  // whether the ticket we just used would have been accepted.
  void authFetch('/api/health').then(
    async r => {
      if (!r.ok) return
      log('auth ok (health answered)')
      // Whether to offer voice at all: a server setting, so only the server knows it.
      const h = (await r.json().catch(() => ({}))) as { stt?: unknown }
      sttReady = h.stt === true
      if (voiceBtn) voiceBtn.style.display = sttReady ? '' : 'none'
      log(
        `voice: ${sttReady ? 'available — long-press opens it' : 'OFF (the server has no EW_STT_URL)'}`,
      )
      maybeOpenTourOnFirstRun(sttReady)
    },
    () => {
      /* authFetch already set the state */
    },
  )
  src.onopen = () => {
    // EventSource reconnects transparently. On a reconnect the diff baseline still holds
    // pre-drop bytes while the glass may have been cleared, so the server's re-primed tiles
    // would diff to nothing. Reset the baseline to force a full re-push; never a rebuild.
    if (streamOpened) {
      setForcePending(true)
      kickPump()
    }
    streamOpened = true
    setStatus(`stream open: ${SERVER}`)
  }
  src.onerror = () => {
    setStatus(`stream error (auto-retrying): ${SERVER}`)
    // EventSource retries by itself with the same URL, whose 60 s ticket will have expired for
    // any longer drop, so re-opening with a fresh ticket is the only path back. Debounced, and
    // only while this EventSource is still the current one.
    if (src !== es || streamReopenAt > Date.now()) return
    streamReopenAt = Date.now() + STREAM_REOPEN_MS
    setTimeout(() => {
      if (src !== es) return
      log('stream: re-opening with a fresh ticket')
      startStream()
    }, STREAM_REOPEN_MS)
  }
  src.onmessage = m => {
    let ev: StreamEvent
    try {
      ev = JSON.parse(String((m as MessageEvent).data)) as StreamEvent
    } catch {
      return
    }
    // Caught, not left floating: one fault on the per-tile path would otherwise be an unhandled
    // rejection per arriving tile (40 a second at EW_FPS=10).
    if (ev.t === 'tile') {
      void processTile(ev.i, b64ToBytes(ev.png)).catch(tileFault)
      return
    }
    if (ev.t === 'avail') {
      availMsg = ev.ok ? null : ev.msg
      log(ev.ok ? 'X available' : `X unavailable: ${ev.msg}`)
      syncOverlay()
      return
    }
    if (ev.t === 'supersede') {
      standDownSuperseded(ev.by)
      return
    }
    if (ev.t === 'windows') {
      setWindows(ev.list, ev.recent)
      return
    }
    if (ev.t === 'bindings') {
      setBindings(ev.map)
      return
    }
    if (ev.t === 'clients') {
      setEnrolledKeys(ev.list, ev.enforced)
      return
    }
    if (ev.t === 'apps') setApps(ev.list, ev.recent)
  }
}
