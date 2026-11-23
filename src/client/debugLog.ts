// even-window — the debug log: buffer, panel, copy, the `?debug=1` forwarder and the error
// funnel.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.
//
// `encodeOffload` (the tile encoder) lives here rather than with the tile code because its
// initialiser reads `log` while the module loads, and across an import cycle that binding is
// only guaranteed to exist inside the module that declares it.

import { TILE_H, TILE_W } from '../shared/geom.ts'
import { filter0Rows, pack4bit, zlibDeflate } from '../shared/png.ts'
import { EncodeOffload, type OffloadReply } from './encodeOffload.ts'
import { queryFlag } from './flags.ts'
import { type NavClock, systemClock } from './navDebounce.ts'
import { followBtn, logCountEl, logEl } from './phoneUi.ts'
import { authFetch } from './serverLink.ts'
import { errText, errWhere } from './util.ts'

/** Index plane → the PNG's IDAT (colour type 3, bit depth 4; the constant 16-grey PLTE is added
 *  by `encodeTilePng`). The in-process path, which is also the worker's fallback. `pack4bit`
 *  and `filter0Rows` are synchronous loops, and `zlibDeflate` only looks asynchronous
 *  (encodeOffload.ts). */
async function idatFromIndices(idx: Uint8Array): Promise<Uint8Array> {
  const { data, bytesPerRow } = pack4bit(idx, TILE_W, TILE_H)
  return zlibDeflate(filter0Rows(data, bytesPerRow, TILE_H))
}

/** The worker is opened on first use, not here: constructing one at module load would break
 *  the pure-export imports the tests do under node, where there is no `Worker`. */
export const encodeOffload = new EncodeOffload({
  openPort: events => {
    // The Vite idiom: this form emits a chunk in build and is transformed in dev, where the
    // dev server's `cache-control: no-store` (vite.config.ts) covers it too.
    const w = new Worker(new URL('./encodeWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = e => events.reply(e.data as OffloadReply)
    // A worker that fails to load reports here with an empty message in some WebViews, hence
    // the default reason.
    w.onerror = e => events.broke(`onerror: ${e.message || 'load failed'}`)
    w.onmessageerror = () => events.broke('onmessageerror (payload could not be cloned)')
    return { post: msg => w.postMessage(msg), close: () => w.terminate() }
  },
  fallback: idatFromIndices,
  log,
})

/** `?debug=1` → mirror every raw bridge envelope and log line to the server log. Off by
 *  default, query-only and never persisted (`queryFlag`); read through the shared flag grammar,
 *  so `?debug`, `?debug=on` and `?debug=true` all work. */
export const DEBUG_EVENTS = queryFlag('debug')

// ── the log ────────────────────────────────────────────────────────────────────────────────
// One buffer, two sinks:
//   1. the on-screen panel, read on the phone: scrollable, selectable, newest at the bottom;
//   2. the server's stdout when `?debug=1`, interleaved with the server's own log lines.

export interface LogLine {
  /** `Date.now()` on the client when the line was produced, not when it was forwarded. */
  t: number
  m: string
}

/** On-screen scrollback. Bounded: an unbounded array of DOM nodes in a phone WebView is a slow
 *  leak. */
export const LOG_BUFFER_MAX = 400

export const logLines: LogLine[] = []

/** `HH:MM:SS.mmm`. Every line is stamped because the questions this log answers are about
 *  order and gap. */
export function logStamp(t: number): string {
  const d = new Date(t)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

// ── forwarding to the server (`?debug=1`) ──────────────────────────────────────────────────
// Throttled by construction, because the tile pump logs one line per push: at most one request
// in flight, at most `LOG_BATCH_MAX` lines per request, requests at least `LOG_FLUSH_MS` apart.
// The queue is bounded and an overflow is reported (a counted "N dropped" marker), not silent.

/** Minimum spacing between forwarding requests. */
export const LOG_FLUSH_MS = 700
/** Maximum lines carried by one request. */
export const LOG_BATCH_MAX = 40
/** Maximum lines held waiting. Beyond this the oldest are dropped and counted. */
export const LOG_QUEUE_MAX = 200

export class LogForwarder {
  private queue: LogLine[] = []
  private dropped = 0
  private timer: unknown = null
  private inFlight = false

  constructor(
    private readonly post: (lines: LogLine[]) => Promise<void>,
    private readonly clock: NavClock = systemClock,
    private readonly flushMs: number = LOG_FLUSH_MS,
    private readonly batchMax: number = LOG_BATCH_MAX,
    private readonly queueMax: number = LOG_QUEUE_MAX,
  ) {}

  /** Lines waiting to be forwarded (test/diagnostic accessor). */
  pending(): number {
    return this.queue.length
  }
  /** Lines discarded to overflow and not yet reported (test/diagnostic accessor). */
  droppedCount(): number {
    return this.dropped
  }

  push(line: LogLine): void {
    if (this.queue.length >= this.queueMax) {
      this.queue.shift()
      this.dropped++
    }
    this.queue.push(line)
    this.arm()
  }

  private arm(): void {
    if (this.timer !== null || this.inFlight) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushMs)
  }

  /** Send one batch. Never throws and never logs: this runs inside the logging path, so an
   *  error reported through `log()` would feed its own queue. Failures are dropped; the
   *  on-screen panel still has every line. */
  async flush(): Promise<void> {
    if (this.inFlight) return
    if (this.queue.length === 0 && this.dropped === 0) return
    this.inFlight = true
    const batch = this.queue.splice(0, this.batchMax)
    if (this.dropped > 0) {
      batch.unshift({
        t: this.clock.now(),
        m: `… ${this.dropped} line(s) DROPPED (forward queue full)`,
      })
      this.dropped = 0
    }
    try {
      await this.post(batch)
    } catch {
      /* deliberately silent — see the doc comment */
    } finally {
      this.inFlight = false
    }
    if (this.queue.length > 0) this.arm()
  }
}

/** The live forwarder. Fed only when `?debug=1` (see `log()`). */
export const logForwarder = new LogForwarder(async lines => {
  // Not `apiPost`: its failure path calls `log()`, which would push a line into the very queue
  // being flushed.
  await authFetch('/api/debug/log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lines }),
  })
})

export function log(line: string): void {
  const e: LogLine = { t: Date.now(), m: line }
  logLines.push(e)
  if (logLines.length > LOG_BUFFER_MAX) logLines.shift()
  appendLogLine(e)
  console.log('[ew]', line)
  if (DEBUG_EVENTS) logForwarder.push(e)
}

// ── uncaught errors reach the log, not just the console ────────────────────────────────────
//
// A handler that throws leaves no `log()` line, so the failure would present as "the gesture
// stopped working". Gesture handlers are async and fired with `void`, so their failures are
// rejections; both errors and rejections are funnelled. Capped, so a throw on a per-frame path
// cannot flood the forwarder.
const ERR_LOG_MAX = 20
/** How many of those carry a stack trace as well as a message. */
const ERR_STACK_MAX = 3
let errLogged = 0

/** Funnel uncaught errors and unhandled rejections into `log()`. Installed first in `boot()`,
 *  so anything the rest of boot can throw is already covered. */
export function installErrorFunnel(): void {
  if (typeof window === 'undefined') return
  const note = (kind: string, detail: unknown) => {
    if (errLogged >= ERR_LOG_MAX) return
    errLogged++
    // The first few carry a stack, the rest only the message: a burst is almost always one
    // fault repeating.
    log(
      `UNCAUGHT ${kind}: ${errLogged <= ERR_STACK_MAX ? errWhere(detail) : errText(detail)}` +
        (errLogged === ERR_LOG_MAX ? ' — further uncaught errors will not be logged' : ''),
    )
  }
  window.addEventListener('error', ev => {
    // A failed resource load arrives as a bare event with no `error` and an empty `message`,
    // so naming the file is the only useful thing left in it.
    const where = ev.filename ? ` @ ${ev.filename}:${String(ev.lineno)}` : ''
    note('error', `${errText(ev.error ?? ev.message) || '(no detail)'}${where}`)
  })
  window.addEventListener('unhandledrejection', ev => {
    note('rejection', ev.reason)
  })
}

/** Is the panel pinned to the newest line? Flipped by the `follow` button and by the user's
 *  own scrolling: scrolling up must not be fought by the next line, and scrolling back to the
 *  bottom resumes following. */
export let logFollow = true

/** Near enough to the bottom to count as "at the bottom". One line of slack, because a touch
 *  scroll rarely lands on an exact pixel. */
const LOG_FOLLOW_SLOP_PX = 24

export function logAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_FOLLOW_SLOP_PX
}

export function setFollow(on: boolean): void {
  logFollow = on
  if (followBtn) followBtn.textContent = `follow:${on ? 'on' : 'off'}`
  if (on && logEl) logEl.scrollTop = logEl.scrollHeight
}

/** Append one line as its own element rather than re-rendering the whole buffer, which would
 *  be O(buffer) per line and destroy any selection the user is making. */
function appendLogLine(e: LogLine): void {
  if (!logEl) return
  const row = document.createElement('div')
  row.textContent = `${logStamp(e.t)}  ${e.m}`
  logEl.appendChild(row)
  while (logEl.childElementCount > LOG_BUFFER_MAX) {
    const first = logEl.firstChild
    if (!first) break
    logEl.removeChild(first)
  }
  if (logCountEl) logCountEl.textContent = `${logLines.length}/${LOG_BUFFER_MAX}`
  if (logFollow) logEl.scrollTop = logEl.scrollHeight
}

/** The whole buffer as text, for `copy`. Stamped identically to the panel. */
function logText(): string {
  return logLines.map(e => `${logStamp(e.t)}  ${e.m}`).join('\n')
}

/** Copy the buffer. `navigator.clipboard` is unavailable on a plain-HTTP origin (and in some
 *  WebViews), which is what the simulator and a LAN phone use, so the textarea + `execCommand`
 *  fallback is the path that usually runs. */
export function copyLog(btn: HTMLButtonElement): void {
  const text = logText()
  // Restore the button's own label, not a hard-coded 'copy': two buttons share this path.
  const label = btn.textContent ?? 'copy'
  const done = (ok: boolean): void => {
    btn.textContent = ok ? 'copied' : 'copy failed'
    setTimeout(() => {
      btn.textContent = label
    }, 1200)
  }
  const fallback = (): void => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      done(ok)
    } catch {
      done(false)
    }
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), fallback)
    return
  }
  fallback()
}
