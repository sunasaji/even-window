// even-window — the swipe debouncer and its clock.
//
// A leaf: it imports no other client module, so anything may use it at load time.

// ── swipe debounce ─────────────────────────────────────────────────────────────────────────
//
// Leading-edge debounce. The first swipe of a gesture fires immediately with count=1. Only
// follow-ups within NAV_SETTLE_MS of the previous one, in the same direction, accumulate and
// flush after the burst settles as one move-N. A direction change, or a swipe after an idle
// gap, is a new leading edge. Real swipe intervals are ~300-600 ms, so a 600 ms window batches
// them; smaller windows barely batch at all.
//
// A per-swipe POST would saturate BLE with repaints, so follow-ups are batched; each swipe
// still maps to exactly one server move. tap/double must `await flush()` first so they act at
// the settled cursor (docs/glasses.md).

export const NAV_SETTLE_MS = 600

/** Injectable clock so the debounce is unit-testable without real timers. */
export interface NavClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: NavClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export type NavSend = (dir: -1 | 1, count: number) => Promise<void> | void

export class NavDebouncer {
  private pending = 0 // accumulated follow-up swipes (leading one already sent)
  private dir = 0 // +1 / -1: direction of the current burst
  private lastTs = 0 // clock time of the last swipe — the leading-edge gate
  private timer: unknown = null

  constructor(
    private readonly send: NavSend,
    private readonly clock: NavClock = systemClock,
    private readonly settleMs: number = NAV_SETTLE_MS,
  ) {}

  queue(dir: number): void {
    const d: -1 | 1 = dir < 0 ? -1 : 1
    const now = this.clock.now()
    const within = now - this.lastTs < this.settleMs
    this.lastTs = now
    if (!within || d !== this.dir) {
      // Leading edge (idle gap, or a direction switch): flush any in-flight batch, then move
      // once immediately.
      void this.flush()
      this.dir = d
      void this.send(d, 1)
      return
    }
    // Within the window, same direction → a rapid follow-up: debounce it.
    this.pending += d
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.settleMs)
  }

  /** Apply (and clear) the pending follow-up burst now — on settle, and before a tap/double so
   *  the action lands at the settled cursor. One POST with count=N. The synchronous prologue
   *  captures dir and resets `pending` before any await, so this is re-entrant (a leading edge
   *  drains the prior burst before overwriting `dir` for the new one). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
    const n = this.pending
    const dir = this.dir
    this.pending = 0
    if (n === 0) return
    await this.send(dir < 0 ? -1 : 1, Math.abs(n))
  }
}
