// tiles.ts — one captured frame -> the dirty quadrants, as indexed PNGs. OS-neutral: a backend
// hands `processFrame` raw rgb24 frames through its `SessionSink`, and the tiles go out
// through src/server/stream.ts.

import { FRAME_BYTES, SCREEN_W, TILE_H, TILE_W, TILES, tileOrigin } from '../shared/geom.ts'
import { encodeIndexedPng, indexLut } from './png.ts'
import { onTile } from './stream.ts'

export { lastTilePng } from './stream.ts'

// Tile state is module level, not per session: a reattach must keep priming new subscribers
// from the tiles the previous capture produced, and lastTilePng() has to answer before any
// session exists. Nothing clears it, so after a reattach only genuine deltas go out.
const lastTileRaw: (Buffer | null)[] = [null, null, null, null]

// The previous raw frame, for the whole-frame short-circuit. Preallocated and copied into: the
// frame handed to processFrame is only valid for the call (see `SessionSink.frame`), and a
// per-frame copy allocation would be garbage at every tick.
const prevFrame = Buffer.allocUnsafe(FRAME_BYTES)
let prevFrameValid = false

/** Slice one rgb24 frame into the four quadrants, quantise to ANSI indices, and emit only the
 *  quadrants that changed (docs/decisions/quadrant-tiles.md, indexed-png-tiles.md).
 *  The baseline it diffs against (`lastTileRaw` / `prevFrame`) is module state with no reset
 *  hook, so tests/server.tiles.test.ts is one ordered sequence, not independent cases. */
export function processFrame(frame: Buffer): void {
  // Whole-frame short-circuit: one memcmp is ~40x cheaper than quantising a static frame.
  // It only skips work — identical bytes would leave every tile equal to lastTileRaw.
  if (prevFrameValid && prevFrame.equals(frame)) return
  // Second filter: compare each quadrant's raw rows before quantising it. Raw-identical
  // implies quantised-identical, so this too only skips work the per-tile diff would skip.
  const dirty = [true, true, true, true]
  if (prevFrameValid) {
    for (let t = 0; t < TILES; t++) {
      const [tx, ty] = tileOrigin(t)
      let same = true
      for (let r = 0; r < TILE_H && same; r++) {
        const o = ((ty + r) * SCREEN_W + tx) * 3
        if (prevFrame.compare(frame, o, o + TILE_W * 3, o, o + TILE_W * 3) !== 0) same = false
      }
      dirty[t] = !same
    }
  }
  frame.copy(prevFrame)
  prevFrameValid = true
  const lut = indexLut()
  for (let t = 0; t < TILES; t++) {
    if (!dirty[t]) continue
    const [tx, ty] = tileOrigin(t)
    const tile = Buffer.allocUnsafe(TILE_W * TILE_H)
    for (let r = 0; r < TILE_H; r++) {
      let src = ((ty + r) * SCREEN_W + tx) * 3
      let dst = r * TILE_W
      for (let x = 0; x < TILE_W; x++, src += 3, dst++) {
        tile[dst] =
          lut[((frame[src]! >> 3) << 10) | ((frame[src + 1]! >> 3) << 5) | (frame[src + 2]! >> 3)]!
      }
    }
    const prev = lastTileRaw[t]
    if (prev?.equals(tile)) continue
    lastTileRaw[t] = tile
    const b64 = encodeIndexedPng(tile, TILE_W, TILE_H).toString('base64')
    onTile(t, b64)
  }
}
