// pinhole-window — the tile pump: latest-wins frames, the serial push loop and its stats state.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.

import { TILES, tileContainerId } from '../shared/geom.ts'
import { encodeOffload, log } from './debugLog.ts'
import { queryFlag } from './flags.ts'
import { established, glassLinkUp, pushImage } from './glassPage.ts'
import { bridge } from './main.ts'
import { menuOpen, overlayActive } from './menu.ts'
import { LINK_BASE_END_AFTER, measureLinkBaseline, overlayBusy, superseded } from './overlay.ts'
import {
  ABBA_ARMS,
  formatPumpStats,
  LATE_PERIOD_MS,
  newPumpStats,
  parseEncodePath,
  sameBytes,
  TILE_NAMES,
} from './pumpStats.ts'
import { availMsg } from './stream.ts'
import { deriveGrey, encodeTilePng, planes } from './tiles.ts'
import { errText } from './util.ts'

// ── the frame pump ─────────────────────────────────────────────────────────────────────────
//
// The BLE push is the rate limiter, so the decode path never waits on it: an arrival marks its
// tile pending and returns, and this single serial pump owns every BLE op and the diff baseline
// (`lastTiles` = what is on the glass). See docs/decisions/tile-pump-latest-wins.md.
//
//   1. One `pumping` flag: every further kick collapses into the active loop, which keeps
//      `updateImageRawData` strictly serial.
//   2. No queue: each step re-scans the four tiles (round-robin, see `pickTile`) and sends the
//      latest bytes at dequeue time, so stale intermediate frames are dropped for free.
// A tile whose push fails is parked for the rest of the drain; the next published frame starts
// a fresh drain that retries it. `forcePending` resets the diff baseline so every tile
// re-sends; it never rebuilds the page.

const frameTiles: (Uint8Array | null)[] = [null, null, null, null]
export const lastTiles: (Uint8Array | null)[] = [null, null, null, null]
/** This quadrant has new indices that have not been derived and encoded yet. Both happen at
 *  dequeue, because arrivals far outnumber pushes and work done at arrival would mostly be
 *  thrown away unread. */
const greyPending: boolean[] = [false, false, false, false]
const tileOrder = [0, 1, 2, 3]
let frameSeq = 0
export let forcePending = false
export function setForcePending(v: boolean): void {
  forcePending = v
}
/** Forget the frames waiting to be pushed, with their encodes. `lastTiles` stays: it records
 *  what the glass holds, and that is still true. */
export function forgetFrames(): void {
  for (let i = 0; i < frameTiles.length; i++) {
    frameTiles[i] = null
    greyPending[i] = false
  }
}
let pumping = false
/** Where the next dequeue scan starts (see `pickTile`). Survives drains, overlay stand-downs
 *  and `forcePending`: a rotation that restarted at TL every drain would be an absolute
 *  priority again. */
let tileCursor = 0

// ── pump statistics (`?stats=1`, off by default) ───────────────────────────────────────────
//
// `pushImage`'s `ms` is JS wall-clock, so it includes main-thread contention; the fields are
// described on `PumpStats` (pumpStats.ts). Every hook is behind the flag so the hot loop costs
// nothing when off. Forwarding log lines to the server is gated on `?debug=1` separately, so a
// hardware capture needs both.
//
// Query-only (`queryFlag`, docs/decisions/instrument-flags-query-only.md): an instrument must
// not turn itself on from storage.
export const STATS_PERIOD_MS = 10_000
/** Per-window sample cap. Only bounds memory; the counts stay exact when it bites. */
const STATS_SAMPLE_MAX = 4096

export let statsOn = false

export let stats = newPumpStats()
/** When each quadrant became dirty, or 0 if it has nothing waiting. Outside PumpStats because
 *  a wait can straddle a window boundary and must not be reset with the counters. */
const dirtyAt: number[] = [0, 0, 0, 0]

export function sample(xs: number[], v: number): void {
  if (xs.length < STATS_SAMPLE_MAX) xs.push(v)
}

export function initStats(): void {
  statsOn = queryFlag('stats')
  if (!statsOn) return
  stats = newPumpStats()

  // Main-thread occupancy sampler. Inside the stats flag because it ticks 100 times a second.
  let due = performance.now() + LATE_PERIOD_MS
  setInterval(() => {
    const now = performance.now()
    const late = Math.round(now - due)
    // Re-base on now rather than on the original schedule: this measures how late each tick
    // was, not how far the clock has drifted since boot.
    due = now + LATE_PERIOD_MS
    stats.lateTicks++
    // Every tick, including the ones that were not late, or the floor estimate in `formatLate`
    // is biased upwards.
    sample(stats.lateMs, Math.max(late, 0))
  }, LATE_PERIOD_MS)

  const path = parseEncodePath(new URLSearchParams(location.search).get('encworker'))
  let arm = 0
  if (path === 'abba') {
    encodeOffload.forcePath(ABBA_ARMS[0]!)
    log(
      `encode A/B: alternating ${ABBA_ARMS.join('>')} per ${STATS_PERIOD_MS / 1000}s window` +
        ' — compare `late blk` (NOT `Σ`, which is mostly the timer) between arm:worker and' +
        ' arm:main, and only within this run',
    )
  } else if (path) {
    encodeOffload.forcePath(path)
    log(`encode path PINNED to ${path} by ?encworker — not the default`)
  }

  let windows = 0
  setInterval(() => {
    const s = stats
    // Captured before the arm advances: this line describes the window that just ended.
    const ran = `enc:${encodeOffload.mode}${path === 'abba' ? ` arm:${ABBA_ARMS[arm % ABBA_ARMS.length]}` : ''}`
    stats = newPumpStats()
    if (path === 'abba') encodeOffload.forcePath(ABBA_ARMS[++arm % ABBA_ARMS.length]!)
    // The closing bracket: the link drifts within a capture, so the baseline is measured again
    // at the end to show whether it did.
    if (++windows === LINK_BASE_END_AFTER) void measureLinkBaseline('end')
    // Silent windows are still printed, so "nothing moved" and "the pump wedged" differ in the
    // log. `enc:` is appended here because it names the code path that ran, not a counter; the
    // worker adds ~1 ms of round trip to the `encode` wall clock.
    log(`${formatPumpStats(s, STATS_PERIOD_MS)} ${ran}`)
  }, STATS_PERIOD_MS)
}

/** Choose the next tile to push: the first dirty one (latest bytes differ from the glass, or
 *  pending an encode), scanning the fixed TL→TR→BL→BR cycle starting at `cursor`. Returns -1
 *  when every tile is caught up.
 *
 *  Not a scan from 0: a push (~330 ms) is slower than capture, so a busy quadrant is dirty
 *  again before its push returns and an index priority would starve the other three. Rotating
 *  the start bounds any dirty tile's wait at 4 pushes. Pure, so a test pins that bound. */
export function pickTile(
  frames: readonly (Uint8Array | null)[],
  last: readonly (Uint8Array | null)[],
  failed: ReadonlySet<number>,
  cursor: number,
  pending: readonly boolean[] = [],
): number {
  const n = tileOrder.length
  for (let k = 0; k < n; k++) {
    const t = tileOrder[((((cursor % n) + n) % n) + k) % n]!
    if (failed.has(t)) continue
    // `pending` is a candidate with no bytes yet: its indices wait to be encoded when the pump
    // reaches it. `frames[t]` still holds the previous encode, which may match the glass.
    if (pending[t]) return t
    const b = frames[t]
    if (b && !sameBytes(last[t], b)) return t
  }
  return -1
}

/** Mark one tile as having a new frame and kick the pump; the pump's coalescing does the rest. */
export function publishTile(i: number): void {
  if (statsOn) {
    stats.published++
    // Already pending means the previous arrival never reached the glass.
    if (greyPending[i]) stats.wasted++
    // Not `else`: already-pending is exactly the state in which something is waiting, so the
    // wait clock must be running there too.
    if (!dirtyAt[i]) dirtyAt[i] = Date.now()
  }
  greyPending[i] = true
  frameSeq++
  kickPump()
}

/** Resolves when the active drain stops; null when no drain is running. Lets an overlay
 *  transition wait for an in-flight BLE push to land before it writes the same plane. */
let pumpSettled: Promise<void> | null = null

export function kickPump(): void {
  if (pumping) return
  const run = pumpTiles()
  pumpSettled = run
  const clear = () => {
    if (pumpSettled === run) pumpSettled = null
  }
  void run.then(clear, clear)
}

/** Stand the pump down and wait for it. An overlay only makes the pump break at its next step;
 *  a tile push already in flight keeps going and records itself in `lastTiles`, so a show
 *  transition that did not wait would blank against the wrong baseline. Bounded so a wedged
 *  push cannot deadlock the menu. */
export async function pumpQuiesce(): Promise<void> {
  const t0 = Date.now()
  let waited = false
  for (let guard = 0; guard < 8; guard++) {
    const p = pumpSettled
    if (!p) break
    waited = true
    await p.catch(() => {})
    if (pumpSettled === p) pumpSettled = null
  }
  // Only interesting when it actually blocked: ~0 ms on the simulator, a push duration on
  // hardware.
  log(waited ? `pump quiesced in ${Date.now() - t0}ms` : 'pump quiesced (nothing in flight)')
}

/** Is the pump currently held down by an overlay? Tracked so the transitions are logged once
 *  each rather than on every kick. */
let pumpStoodDown = false

function pumpHalt(where: string): void {
  if (pumpStoodDown) return
  pumpStoodDown = true
  log(
    `pump STAND-DOWN at ${where} (menuOpen=${menuOpen} availDown=${availMsg !== null} busy=${overlayBusy})`,
  )
}

function pumpResume(): void {
  if (!pumpStoodDown) return
  pumpStoodDown = false
  // Restart every pending wait: the overlay made the quadrants wait, not the rotation, so the
  // stand-down must not be charged to maxWait.
  if (statsOn) {
    const now = Date.now()
    for (let i = 0; i < TILES; i++) if (dirtyAt[i]) dirtyAt[i] = now
  }
  log('pump RESUME — tiles flowing again')
}

async function pumpTiles(): Promise<void> {
  // `!glassLinkUp` and `!established` gate here as well as in `pushImage`, so the derive and
  // the PNG encode are not paid for a push that would be refused. A dead link means "do not
  // touch the bridge"; an overlay (below) only freezes the plane. `reestablishPage` ends in
  // `forcePending = true; kickPump()`, so the first drain happens the moment a page exists.
  if (pumping || !bridge || !glassLinkUp || !established || superseded) return
  pumping = true
  try {
    for (;;) {
      // Overlay freeze: while the text overlay is up (or a transition is settling) the pump
      // pushes nothing, because the overlay shares the tiles' plane. Client-side only; there is
      // no server hold route. Incoming tiles keep coalescing latest-wins, so there is no backlog
      // on close: `forcePending` resets the baseline (the show transition pushed black over the
      // tiles) and the newest tile per quadrant goes out. Never a rebuild.
      if (overlayActive()) {
        pumpHalt('drain start')
        break
      }
      pumpResume()
      if (forcePending) {
        forcePending = false
        lastTiles.fill(null)
      }
      const startSeq = frameSeq
      const failed = new Set<number>() // tiles whose push failed this drain — don't spin
      for (;;) {
        if (overlayActive()) {
          pumpHalt('mid-drain')
          break
        }
        // The drain may have started while the link was up; stop before paying another derive
        // and encode for a push that will be refused.
        if (!glassLinkUp) break
        // Dequeue the next dirty tile, round-robin from `tileCursor`. Re-scanned every step, so
        // the latest state of every quadrant is considered each time.
        const i = pickTile(frameTiles, lastTiles, failed, tileCursor, greyPending)
        if (i < 0) break
        // Advance before the await: this tile has had its turn whether or not the push lands.
        tileCursor = (i + 1) % tileOrder.length
        // Derive and encode at dequeue. The flag is cleared first: an arrival that lands during
        // the await must set it again, or its indices would never be sent.
        if (greyPending[i]) {
          greyPending[i] = false
          deriveGrey(i) // the pixel loop, here rather than at arrival
          const e0 = statsOn ? performance.now() : 0
          try {
            frameTiles[i] = await encodeTilePng(planes().idx[i]!)
            if (statsOn) sample(stats.encodeMs, performance.now() - e0)
          } catch (e) {
            log(`tile${i} encode failed: ${errText(e)}`)
            failed.add(i)
            continue
          }
          if (overlayActive()) {
            pumpHalt('post-encode')
            break
          }
        }
        const b = frameTiles[i] // fetch the latest bytes at dequeue time
        if (!b) break
        // The newest indices can encode to bytes identical to what is on the glass: not a push,
        // and the wait ends here.
        if (sameBytes(lastTiles[i], b)) {
          // This one cost a real encode: both counters (see `PumpStats`).
          if (statsOn && dirtyAt[i]) {
            stats.wasted++
            stats.wastedEncode++
            dirtyAt[i] = 0
          }
          continue
        }
        const r = await pushImage(tileContainerId(i), `tile${i}`, b)
        if (r.ok) lastTiles[i] = b
        else failed.add(i)
        if (statsOn) {
          sample(stats.pushMs, r.ms)
          if (r.ok) {
            stats.pushed[i] = (stats.pushed[i] ?? 0) + 1
            const waited = dirtyAt[i] ?? 0
            const now = Date.now()
            if (waited) stats.maxWaitMs = Math.max(stats.maxWaitMs, now - waited)
            // An arrival that landed during this push is already waiting; its clock starts here.
            dirtyAt[i] = greyPending[i] ? now : 0
          } else stats.failed++
        }
        log(`${TILE_NAMES[i] ?? i}=${r.status}/${b.length}B/${r.ms}ms`)
      }
      // Re-drain if a newer frame landed while we were sending (its tiles — and any that just
      // failed — get a fresh attempt); else we're caught up.
      if (overlayActive()) {
        pumpHalt('drain end')
        break
      }
      if (forcePending || frameSeq !== startSeq) continue
      break
    }
  } finally {
    pumping = false
  }
}
