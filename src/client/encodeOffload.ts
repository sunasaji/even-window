// encodeOffload.ts — run the tile's pack+filter+deflate on a worker, and survive not being
// able to.
//
// `CompressionStream('deflate')` does not free the main thread in a Chromium WebView: the
// compression runs inside the `read()` microtask continuation, so awaiting it never yields a
// macrotask. A worker removes that occupancy at the cost of a ~1 ms message round trip per tile
// on a phone. Node's `CompressionStream` runs off-thread, so node measurements do not apply.
// `?stats=1`'s `encode` is wall clock across an await, so it goes up with the worker while
// main-thread occupancy goes down (docs/notes/2026-10-client-tile-pipeline.md).
//
// Every failure (construct, load, throw, no answer) falls back to the in-process path for the
// rest of the session: the tile must still reach the glasses, and retrying per tile would pay
// the timeout on every push.

/** The in-process path: index plane → PNG IDAT. The worker does the same thing elsewhere. */
export type IdatFn = (idx: Uint8Array) => Promise<Uint8Array>

export interface OffloadRequest {
  id: number
  idx: Uint8Array
}
export interface OffloadReply {
  id: number
  idat?: Uint8Array
  error?: string
}

/** The worker, as this module needs it. Injected so the tests need no real `Worker`. */
export interface OffloadPort {
  post(msg: OffloadRequest): void
  close(): void
}

export interface PortEvents {
  /** A reply arrived. An id this module is not waiting for is ignored, not an error. */
  reply(msg: OffloadReply): void
  /** The port is unusable — `onerror`, `onmessageerror`, a load failure. */
  broke(reason: string): void
}

export type OpenPort = (events: PortEvents) => OffloadPort

export type OffloadMode = 'unstarted' | 'worker' | 'main'

/** Generous: the work is ~1 ms and the push timeout behind it is 8000 ms. This catches a worker
 *  that never loaded (`onerror` does not always fire in a WebView), not a slow one. */
export const OFFLOAD_TIMEOUT_MS = 2000

export interface EncodeOffloadOptions {
  openPort: OpenPort
  /** Used before the port opens, after it breaks, and for any request caught by the break. */
  fallback: IdatFn
  log: (line: string) => void
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

interface Pending {
  idx: Uint8Array
  /** `resolve`. Handed a promise on the fallback path: resolving with one adopts it, rejection
   *  included, so there is no second settle call to get wrong. */
  settle: (value: Uint8Array | PromiseLike<Uint8Array>) => void
  timer: unknown
}

export class EncodeOffload {
  private readonly o: EncodeOffloadOptions
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private port: OffloadPort | null = null
  private state: OffloadMode = 'unstarted'
  private forced: 'worker' | 'main' | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()

  constructor(options: EncodeOffloadOptions) {
    this.o = options
    this.timeoutMs = options.timeoutMs ?? OFFLOAD_TIMEOUT_MS
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** The path a tile would take right now: the failure state and the operator override
   *  combined. Printed on the stats line, the only place the running path is observable. */
  get mode(): OffloadMode {
    return this.state === 'main' || this.forced === 'main' ? 'main' : this.state
  }

  /**
   * Operator override, for an A/B inside one session (`?encworker=`). Orthogonal to the failure
   * state: forcing `worker` does not resurrect a port that already broke.
   */
  forcePath(path: 'worker' | 'main' | null): void {
    this.forced = path
    // Open now rather than on the next tile, so no arm is charged for the worker's startup.
    if (path === 'worker' && this.state === 'unstarted') this.open()
  }

  async run(idx: Uint8Array): Promise<Uint8Array> {
    if (this.state === 'main' || this.forced === 'main') return this.o.fallback(idx)
    if (this.state === 'unstarted' && !this.open()) return this.o.fallback(idx)

    const id = ++this.seq
    return new Promise<Uint8Array>(resolve => {
      const timer = this.setTimer(
        () => this.giveUp(`no reply in ${this.timeoutMs}ms`),
        this.timeoutMs,
      )
      this.pending.set(id, { idx, settle: resolve, timer })
      try {
        // Not transferred: a transfer would detach `idx`, the pump's per-quadrant plane, and
        // leave the fallback nothing to encode if this request is the one that breaks the port.
        this.port!.post({ id, idx })
      } catch (error) {
        this.giveUp(`post failed: ${text(error)}`)
      }
    })
  }

  private open(): boolean {
    try {
      this.port = this.o.openPort({
        reply: msg => this.onReply(msg),
        broke: reason => this.giveUp(reason),
      })
      this.state = 'worker'
      this.o.log(
        'encode: pack+filter+deflate moved to a worker (the main thread was 100% blocked by it)',
      )
      return true
    } catch (error) {
      this.giveUp(`worker unavailable: ${text(error)}`)
      return false
    }
  }

  private onReply(msg: OffloadReply): void {
    const p = this.pending.get(msg.id)
    // An id we are not waiting for: a reply that raced `giveUp`, or a duplicate. Dropping it is
    // correct — the request it belongs to has already been settled by the fallback.
    if (!p) return
    if (msg.error !== undefined || !msg.idat) {
      // The worker itself failed on real input. That is not a transient condition, so stop
      // trusting it — but this tile must still go out, which `giveUp` arranges.
      this.giveUp(`worker error: ${msg.error ?? 'empty reply'}`)
      return
    }
    this.pending.delete(msg.id)
    this.clearTimer(p.timer)
    p.settle(msg.idat)
  }

  /** Switch to the in-process path permanently and rescue everything in flight. */
  private giveUp(reason: string): void {
    const first = this.state !== 'main'
    this.state = 'main'
    if (first) this.o.log(`encode: back on the main thread — ${reason}`)
    try {
      this.port?.close()
    } catch {
      /* already gone */
    }
    this.port = null
    // Drain before awaiting anything: `fallback` is async, and a reply landing mid-drain must not
    // find a half-emptied map.
    const caught = [...this.pending.values()]
    this.pending.clear()
    for (const p of caught) {
      this.clearTimer(p.timer)
      p.settle(this.o.fallback(p.idx))
    }
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
