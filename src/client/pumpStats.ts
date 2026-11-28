// pinhole-window — the `?stats=1` counters and their formatting (pure).
//
// A leaf: it imports no other client module, so anything may use it at load time.

export const TILE_NAMES = ['TL', 'TR', 'BL', 'BR'] as const

export interface PumpStats {
  published: number
  /** Publishes that never reached the glass. A total of two causes with opposite remedies:
   *  coalesced (a newer frame replaced the tile before the pump reached it, so no encode was
   *  paid) and identical (`wastedEncode`). `wasted - wastedEncode` is the coalesced half. */
  wasted: number
  /** The subset of `wasted` that cost a real encode: the tile was dequeued, derived and encoded,
   *  and the bytes came out identical to what is on the glass. A monitor, ~0 when healthy; a
   *  non-zero value means something is producing tiles identical to the last one. Counted rather
   *  than derived from `encode - push`, which also includes post-encode overlay stand-downs. */
  wastedEncode: number
  pushed: number[]
  failed: number
  pushMs: number[]
  deriveMs: number[]
  /** How long a tile arrival takes: the inflate to indices plus the colour mirror. Its rate is
   *  the server's emit rate, which PINHOLE_FPS controls. */
  decodeMs: number[]
  /** How long `encodeTilePng` takes. Sampled at dequeue, so its rate is the push rate. */
  encodeMs: number[]
  /** How late each `setInterval` tick was, in ms: main-thread occupancy, the only field that
   *  measures the main thread directly (a timer cannot fire while the thread is busy). A phone
   *  WebView clamps `performance.now()` to 1 ms, so sub-ms work is invisible and the samples
   *  are summed rather than medianed; see `formatLate` for the floor subtraction. Every tick is
   *  recorded, late or not, so the floor estimate is unbiased. */
  lateMs: number[]
  /** Ticks the sampler actually got. Far fewer than `windowMs / LATE_PERIOD_MS` means the
   *  sampler itself was starved and the sum is an undercount. */
  lateTicks: number
  /** The longest a quadrant with something new to show waited for its turn. The clock starts
   *  when a publish makes a quadrant differ from the glass, and an overlay stand-down re-stamps
   *  it rather than accumulating (`pumpResume`). */
  maxWaitMs: number
}

export function newPumpStats(): PumpStats {
  return {
    published: 0,
    wasted: 0,
    wastedEncode: 0,
    pushed: [0, 0, 0, 0],
    failed: 0,
    pushMs: [],
    deriveMs: [],
    decodeMs: [],
    encodeMs: [],
    lateMs: [],
    lateTicks: 0,
    maxWaitMs: 0,
  }
}

/** Nearest-rank percentile of an unsorted sample. `p` in 0..1; empty sample → 0. Copies before
 *  sorting: the caller's array is still accumulating. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))
  return s[i] ?? 0
}

/** The one line a capture is diffed on. Pure, so a test pins the format. */
export function formatPumpStats(s: PumpStats, windowMs: number): string {
  const secs = windowMs / 1000
  const rate = (n: number): string => (n / secs).toFixed(1)
  /** `digits` differs by two orders of magnitude: a push is ~96ms, a derive ~0.4ms. */
  const ms = (xs: readonly number[], digits: number): string =>
    xs.length === 0
      ? 'n/a'
      : `med ${percentile(xs, 0.5).toFixed(digits)} p90 ${percentile(xs, 0.9).toFixed(digits)}ms`
  const pushes = s.pushed.reduce((a, b) => a + b, 0)
  const per = s.pushed.map((n, i) => `${TILE_NAMES[i] ?? i} ${n}`).join(' ')
  // Of the tiles the client published, how many were dropped before being sent. Reported as
  // waste rather than "pushes per publish", which a baseline reset can push over 100%. `enc` is
  // the part that cost an encode (see `wastedEncode`), printed next to the total.
  const waste =
    s.published === 0
      ? 'n/a'
      : `${s.wasted}/${s.published} ${Math.round((s.wasted / s.published) * 100)}% enc ${s.wastedEncode}`
  const late = formatLate(s, windowMs)
  return (
    `stats ${secs}s: push ${pushes}@${rate(pushes)}/s ${ms(s.pushMs, 0)} fail ${s.failed}` +
    ` | ${per} maxwait ${s.maxWaitMs}ms` +
    ` | decode ${s.decodeMs.length}@${rate(s.decodeMs.length)}/s ${ms(s.decodeMs, 2)}` +
    ` | derive ${s.deriveMs.length}@${rate(s.deriveMs.length)}/s ${ms(s.deriveMs, 2)}` +
    ` | encode ${s.encodeMs.length}@${rate(s.encodeMs.length)}/s ${ms(s.encodeMs, 1)}` +
    ` | late ${late}` +
    ` | wasted ${waste}`
  )
}

/** How often the occupancy sampler ticks: 100/s costs ~0.01% and gives 1000 samples a window. */
export const LATE_PERIOD_MS = 10

/**
 * `blk` is the headline: lateness above the window's own floor, i.e. the part plausibly caused
 * by this client blocking the thread. The raw `Σ` is mostly `setInterval`'s imprecision (a
 * requested 10 ms period runs at ~12.1 ms on the phone), so the floor is subtracted.
 *
 * The floor is p25, not the median: it stands for "a tick with nothing in its way" and survives
 * up to 75% of ticks being hit by blocking. `Σ` and `floor` stay on the line so the subtraction
 * can be audited; `p95`/`max` are on the raw lateness, so a single long stall stays visible.
 */
export function formatLate(s: PumpStats, windowMs: number): string {
  const want = Math.round(windowMs / LATE_PERIOD_MS)
  if (s.lateTicks === 0) return 'n/a'
  const raw = s.lateMs.reduce((a, b) => a + b, 0)
  const floor = percentile(s.lateMs, 0.25)
  let blocked = 0
  for (const v of s.lateMs) if (v > floor) blocked += v - floor
  // `reduce`, not `Math.max(...xs)`: the sample array can hold STATS_SAMPLE_MAX (4096) entries,
  // too many to spread safely.
  const max = s.lateMs.reduce((a, b) => Math.max(b, a), 0)
  const starved = s.lateTicks < want * 0.5 ? ' SAMPLER STARVED' : ''
  return (
    `blk${Math.round(blocked)}ms floor${floor.toFixed(0)} Σ${raw}/${s.lateTicks}t` +
    ` p95 ${percentile(s.lateMs, 0.95).toFixed(0)} max ${max}ms${starved}`
  )
}

/** `?encworker=` — which encode path to run. An instrument, so query-only and never persisted.
 *  `abba` alternates per stats window: the link drifts too much between runs to compare them
 *  (docs/notes/2026-10-tile-transfer-timing.md), and ABBA cancels a linear drift. */
export type EncodePath = 'worker' | 'main' | 'abba'

export function parseEncodePath(raw: string | null | undefined): EncodePath | null {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'worker' || v === '1') return 'worker'
  if (v === 'main' || v === '0') return 'main'
  if (v === 'abba') return 'abba'
  return null // absent or unparseable: decide nothing (see `queryFlag`)
}

/** A→B→B→A. Outer pair vs inner pair, so a linear drift cancels rather than merely averages. */
export const ABBA_ARMS: readonly ('worker' | 'main')[] = ['worker', 'main', 'main', 'worker']

export function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
