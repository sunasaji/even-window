// Glasses geometry: the single source of truth for both server and client.
//
// The G2 panel is 576x288. An image container is limited per dimension to 288x144 (minimum
// 20x20) and a page holds at most four image containers, so 4 x (288x144) covers the panel
// exactly and the only possible layout is this 2x2 grid. Text containers may be panel-sized;
// image containers may not. See docs/decisions/quadrant-tiles.md.

export const SCREEN_W = 576
export const SCREEN_H = 288

export const TILE_W = 288
export const TILE_H = 144
export const TILES = 4

/** Quadrant origins, in tile index order: TL, TR, BL, BR. */
export const TILE_XY: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [TILE_W, 0],
  [0, TILE_H],
  [TILE_W, TILE_H],
] as const

/** One rgb24 frame of the whole root window. */
export const FRAME_BYTES = SCREEN_W * SCREEN_H * 3

// Glasses container ids (docs/glasses.md). The allocation is fixed.
//
//   1      transparent input-capture text layer (the only isEventCapture:1 container)
//   2..5   the four image tiles
//   6      overlay text layer (isEventCapture:0)
//
// Only one container may carry isEventCapture:1, so id 1 is the path for every gesture and
// is never written with visible content; the overlay has its own container
// (docs/decisions/separate-input-and-overlay-layers.md).

/** The transparent input-capture text layer. Established once, never pushed again. */
export const EVENT_LAYER_ID = 1
/** Image container for tile `i` is `TILE_CONTAINER_BASE + i` → 2,3,4,5. */
export const TILE_CONTAINER_BASE = 2
/** Overlay text layer: the first id after the tiles. */
export const OVERLAY_LAYER_ID = TILE_CONTAINER_BASE + TILES
/** `containerTotalNum` for establishPage: input layer + 4 tiles + overlay. */
export const CONTAINER_TOTAL = 1 + TILES + 1

// Both eyes see the whole 576x288: no quadrant belongs to an eye (docs/architecture.md).

export function tileContainerId(i: number): number {
  return TILE_CONTAINER_BASE + i
}

export function tileOrigin(i: number): readonly [number, number] {
  const xy = TILE_XY[i]
  if (!xy) throw new Error(`tile index out of range: ${i}`)
  return xy
}

/** The inverse of `tileOrigin`: which quadrant holds screen point (x, y), or -1 if it is off
 *  the panel. */
export function tileIndexAt(x: number, y: number): number {
  if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return -1
  return (y < TILE_H ? 0 : 2) + (x < TILE_W ? 0 : 1)
}

// ── z-order plan (`zOrderIndex`) ───────────────────────────────────────────────────────────
//
// The SDK validates `zOrderIndex` before the native call: if any container on a page sets it,
// every list/text/image container must, values must be unique, and larger renders closer to
// the front. A violation is rejected locally (`createStartUpPageContainer` returns 1,
// `rebuildPageContainer` returns false) without reaching the firmware, so suspect this plan
// first when a page is refused. The plan is applied to every page; the firmware honours it.

/** `zOrderIndex` for tile `i` → 1,2,3,4. The tiles are the back. */
export function tileZOrder(i: number): number {
  return 1 + i
}

/** The transparent input-capture layer: above the tiles, below the overlay. It has no
 *  visible content, so it only needs a unique value. */
export const Z_EVENT_LAYER = 1 + TILES

/** The overlay text layer: the frontmost container, since the tiles cover the whole panel. */
export const Z_OVERLAY = 2 + TILES
