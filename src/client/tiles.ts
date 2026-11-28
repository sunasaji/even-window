// pinhole-window — tile pixels: the cursor bake, decode, grey planes and the PNG encode.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.

import {
  SCREEN_H,
  SCREEN_W,
  TILE_H,
  TILE_W,
  TILES,
  tileIndexAt,
  tileOrigin,
} from '../shared/geom.ts'
import { assemblePng, indexPlaneFromPng, plteFrom } from '../shared/png.ts'
import { encodeOffload, log } from './debugLog.ts'
import { ANSI_U32, GREEN_U32, LEVEL_BY_ANSI, RAMP_GREYS } from './grey.ts'
import { mirrorEl } from './phoneUi.ts'
import { forgetFrames, publishTile, sample, stats, statsOn } from './pump.ts'
import { invert, mirrorMode } from './settings.ts'
import { drawMirror } from './statusUi.ts'
import { errText, errWhere } from './util.ts'

// No canvas is involved in the tile path: the client inflates the server's indexed PNG itself
// and writes palette indices. `cursorMask` builds its own small canvas once; the mirror has
// its own.

// Synthetic cursor. The capture does not include the pointer (docs/platform.md), so an arrow is
// baked into whichever grey tile holds it. Hidden by default, because glasses gestures are keys;
// vPad shows and drives it (docs/phone-ui.md), and `window.ewCursor` is the debug way in.
//
// Fractional by construction: the pad accumulates gain-scaled deltas, so anything that turns
// these into a pixel goes through `cursorTilePixel`, never the raw value.
export const cursor = { x: SCREEN_W / 2, y: SCREEN_H / 2, shown: false }

/** The cursor as a tile-local integer pixel in tile `i`, or null when it is not in that tile.
 *
 *  Integers are load-bearing: a store to a typed array at a fractional index is silently
 *  dropped, so a fractional cursor would never reach the glass. `Math.floor`, not `Math.round`:
 *  quadrant boundaries are integers, so flooring cannot land the pixel in a different tile than
 *  the one `tileIndexAt` named. */
export function cursorTilePixel(
  cx: number,
  cy: number,
  i: number,
): readonly [number, number] | null {
  if (tileIndexAt(cx, cy) !== i) return null
  const [ox, oy] = tileOrigin(i)
  return [Math.floor(cx) - ox, Math.floor(cy) - oy]
}

/** The arrow outline, built once and lazily: `Path2D` does not exist under vitest's node
 *  environment, where this module is imported for its pure exports. */
let cursorPath: Path2D | null = null
export function cursorArrow(): Path2D {
  if (!cursorPath) cursorPath = new Path2D('M0,0 L0,12 L3,9 L5,13 L7,12 L5,8 L8,8 Z')
  return cursorPath
}

/** The arrow, baked once into two boolean masks (black outline, white fill), because the push
 *  path writes palette indices rather than drawing on a canvas. The antialiased edge is
 *  thresholded at alpha >= 128: a 16-level panel wants a hard edge. */
const CURSOR_MARGIN = 2 // the 2px stroke is centred, so it reaches 1px outside the path
let cursorMasks: { w: number; h: number; fill: Uint8Array; outline: Uint8Array } | null = null

function cursorMask(): NonNullable<typeof cursorMasks> {
  if (cursorMasks) return cursorMasks
  const S = 32 // the arrow is ~8x13; 32 leaves room and margin
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context')
  const bake = (draw: () => void): Uint8Array => {
    ctx.clearRect(0, 0, S, S)
    ctx.save()
    ctx.translate(CURSOR_MARGIN, CURSOR_MARGIN)
    draw()
    ctx.restore()
    const d = ctx.getImageData(0, 0, S, S).data
    const m = new Uint8Array(S * S)
    for (let i = 0; i < S * S; i++) m[i] = (d[i * 4 + 3] ?? 0) >= 128 ? 1 : 0
    return m
  }
  const outline = bake(() => {
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#fff' // a mask: the colour only has to be opaque
    ctx.stroke(cursorArrow())
  })
  const fill = bake(() => {
    ctx.fillStyle = '#fff'
    ctx.fill(cursorArrow())
  })
  cursorMasks = { w: S, h: S, fill, outline }
  return cursorMasks
}

/** Stamp the arrow into a tile's index plane, iff the cursor is inside tile `i`. Outline to
 *  level 0, then fill to level 15. Not subject to `invert`: the cursor is chrome, and an
 *  inverted arrow would vanish against what it points at. */
function stampCursor(idx: Uint8Array, i: number): void {
  if (!cursor.shown) return
  const at = cursorTilePixel(cursor.x, cursor.y, i)
  if (!at) return
  const [lx, ly] = at
  const m = cursorMask()
  const x0 = lx - CURSOR_MARGIN,
    y0 = ly - CURSOR_MARGIN
  for (let my = 0; my < m.h; my++) {
    const ty = y0 + my
    if (ty < 0 || ty >= TILE_H) continue
    for (let mx = 0; mx < m.w; mx++) {
      const tx = x0 + mx
      if (tx < 0 || tx >= TILE_W) continue
      const o = my * m.w + mx
      if (m.fill[o]) idx[ty * TILE_W + tx] = 15
      else if (m.outline[o]) idx[ty * TILE_W + tx] = 0
    }
  }
}

/** Report a throw from the per-tile path once per distinct message, with a count. A per-frame
 *  path cannot log per failure: a persistent fault would be forty lines a second. */
const tileFaults = new Map<string, number>()
export let tileFaultTotal = 0

export function tileFault(e: unknown): void {
  tileFaultTotal++
  const key = errText(e)
  const seen = tileFaults.get(key) ?? 0
  tileFaults.set(key, seen + 1)
  // The first of each kind gets the stack; afterwards a line every hundredth occurrence.
  if (seen === 0) log(`tile path FAILED: ${errWhere(e)}`)
  else if ((seen + 1) % 100 === 0) log(`tile path still failing: ${key} (x${String(seen + 1)})`)
}

/** The tile as ANSI palette indices, per quadrant — what the server actually sent, before
 *  anything interprets it. Cached so a re-derive (polarity flip, cursor move, mirror mode)
 *  needs no fresh frame. */
const tileAnsi: (Uint8Array | null)[] = [null, null, null, null]
/** Arrival counter per quadrant, so an out-of-order inflate can be dropped. */
const tileSeq = [0, 0, 0, 0]

/** Drop every cached tile. The cache belongs to the server that sent it: without this, opening
 *  another server repaints the previous one's picture until the new tiles arrive (root.ts). */
export function forgetTiles(): void {
  for (let i = 0; i < TILES; i++) {
    tileAnsi[i] = null
    tileSeq[i] = (tileSeq[i] ?? 0) + 1 // an inflate still in flight must not land afterwards
  }
  forgetFrames()
}

/** Take a received tile: inflate it to indices, paint the colour mirror, hand it to the pump.
 *  No canvas and no derive here; the derive runs at dequeue (see `greyPending` in pump.ts). */
export async function processTile(i: number, bytes: Uint8Array): Promise<void> {
  if (i < 0 || i >= TILES) return
  // The inflate is async, so two arrivals for one quadrant can complete out of order; the
  // sequence number drops a late one instead of letting it overwrite a newer plane.
  const seq = ++tileSeq[i]!
  const d0 = statsOn ? performance.now() : 0
  let ansi: Uint8Array | null
  try {
    ansi = await indexPlaneFromPng(bytes, TILE_W, TILE_H)
  } catch (e) {
    log(`tile${i} inflate failed: ${errText(e)}`)
    return
  }
  if (seq !== tileSeq[i]) return // a newer frame for this quadrant already landed
  if (!ansi) {
    // The writer is src/shared/png.ts, so this means the two ends have diverged.
    log(`tile${i} not the expected indexed PNG — dropped`)
    return
  }
  tileAnsi[i] = ansi
  if (mirrorMode === 'color') drawMirrorColour(i)
  if (statsOn) sample(stats.decodeMs, performance.now() - d0)
  publishTile(i)
}

// ── the grey derive ────────────────────────────────────────────────────────────────────────
// Allocated once for the page. `idx` is the tile as palette indices (0-15), which is what goes
// to the glasses; `mirror` is the preview plane, one ArrayBuffer with a `Uint8Array` view to
// write through and the `ImageData` that `putImageData` requires (writing through the clamped
// view costs a clamp per store). Lazy because `ImageData` does not exist under the node tests.
let greyPlanes: {
  idx: Uint8Array[]
  mirror: Uint8Array
  mirrorU32: Uint32Array
  mirrorData: ImageData
} | null = null

export function planes(): NonNullable<typeof greyPlanes> {
  if (greyPlanes) return greyPlanes
  const n = TILE_W * TILE_H * 4
  const b = new ArrayBuffer(n)
  greyPlanes = {
    mirrorU32: new Uint32Array(b),
    // One index plane per tile, not one shared: the encode happens at dequeue, so a quadrant's
    // indices must survive until the pump reaches it. The mirror plane is shared because
    // putImageData copies synchronously in the derive.
    idx: Array.from({ length: TILES }, () => new Uint8Array(TILE_W * TILE_H)),
    mirror: new Uint8Array(b),
    mirrorData: new ImageData(new Uint8ClampedArray(b), TILE_W, TILE_H),
  }
  return greyPlanes
}

/** From a cached tile's ANSI indices, build the index plane and (in green mode) the preview
 *  plane in one pass. The PNG is encoded afterwards by the pump. One fused pass with the level
 *  lookup inlined, because this is the client's hot loop. */
export function deriveGrey(i: number): void {
  const ansi = tileAnsi[i]
  if (!ansi) return
  const p = planes()
  const idx = p.idx[i]!
  const { mirrorU32, mirrorData } = p
  const green = mirrorMode === 'green'
  const t0 = statsOn ? performance.now() : 0 // two calls per tile, not per pixel
  const map = LEVEL_BY_ANSI[invert ? 1 : 0]! // hoisted: polarity cannot change mid-tile
  const n = ansi.length
  for (let q = 0; q < n; q++) {
    const lvl = map[ansi[q]! & 15]!
    idx[q] = lvl
    // The green plane is the mirror's, not the glasses'. In colour mode nobody reads it.
    if (green) mirrorU32[q] = GREEN_U32[lvl]!
  }
  // Times the loop only, not the encode.
  if (statsOn) sample(stats.deriveMs, performance.now() - t0)
  stampCursor(idx, i) // no-op unless the cursor is shown and inside this tile
  if (green) drawMirror(i, mirrorData)
}

/** The mirror in colour: the ANSI palette applied to the indices the server sent. One palette
 *  read and one 32-bit store per pixel. */
function drawMirrorColour(i: number): void {
  const ansi = tileAnsi[i]
  if (!ansi || !mirrorEl) return
  const { mirrorU32, mirrorData } = planes()
  for (let q = 0; q < ansi.length; q++) mirrorU32[q] = ANSI_U32[ansi[q]! & 15]!
  drawMirror(i, mirrorData)
}

/** Repaint every quadrant of the mirror after a mode change. Colour repaints immediately from
 *  the cache; green comes out of the derive, which runs at dequeue, so it asks the pump and the
 *  mirror catches up a push later. */
export function repaintMirror(): void {
  if (mirrorMode === 'color') {
    for (let i = 0; i < TILES; i++) drawMirrorColour(i)
  } else for (let i = 0; i < TILES; i++) if (tileAnsi[i]) publishTile(i)
}

export async function encodeTilePng(idx: Uint8Array): Promise<Uint8Array> {
  const idat = await encodeOffload.run(idx)
  return assemblePng({ w: TILE_W, h: TILE_H, depth: 4, colourType: 3, plte: TILE_PLTE, idat })
}

/** The 16 grey entries, built once. */
const TILE_PLTE = plteFrom(RAMP_GREYS.map(v => [v, v, v] as const))

/** Re-derive every cached tile (polarity flip / cursor toggle) by asking the pump, since the
 *  derive runs at dequeue. */
export function refreshGrey(): void {
  for (let i = 0; i < TILES; i++) if (tileAnsi[i]) publishTile(i)
}

/** Which quadrant the synthetic cursor was last baked into. */
export let cursorTile = -1
export function setCursorTile(v: number): void {
  cursorTile = v
}

/** Re-derive only the tiles the cursor affects: the one it is in, plus the one it just left.
 *  vPad sends a move every PAD_MOVE_MS, so re-deriving all four per move would be wasteful. */
export function refreshCursorTiles(): void {
  const t = tileIndexAt(cursor.x, cursor.y)
  const touch = (q: number): void => {
    publishTile(q) // the lens repaints when the pump reaches it
    // The mirror cannot wait for that: in colour mode it is only painted when a tile arrives,
    // and vPad is steered by watching it, so on a still screen the arrow would not move.
    if (mirrorMode === 'color') drawMirrorColour(q)
  }
  if (t !== cursorTile) {
    if (cursorTile >= 0) touch(cursorTile) // erase the arrow from the tile it left
    cursorTile = t
  }
  if (cursorTile >= 0) touch(cursorTile)
}
