// even-window — glasses geometry. Single source of truth for both server and client.
// Derived from heimterm src/glyph.ts:17-27 (MIT, (c) 2026 Suna.S)
//
// The G2 panel is 576x288. An ImageContainerProperty maxes out at 288x144 (one
// quadrant) and only 4 image containers are allowed per page, so a full-screen
// mirror is exactly 2x2 tiles with no spare container left over.

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

/** One ffmpeg rgb24 frame of the whole nested-X root window. */
export const FRAME_BYTES = SCREEN_W * SCREEN_H * 3

/** Glasses container IDs. id 1 is the transparent input-capture text layer. */
export const EVENT_LAYER_ID = 1
/** Image container for tile `i` is `TILE_CONTAINER_BASE + i` → 2,3,4,5. */
export const TILE_CONTAINER_BASE = 2
export const CONTAINER_TOTAL = 1 + TILES

/** Left eye renders TL+BL, right eye renders TR+BR. Useful for blackout diagnosis. */
export const LEFT_EYE_TILES = [0, 2] as const
export const RIGHT_EYE_TILES = [1, 3] as const

export function tileContainerId(i: number): number {
  return TILE_CONTAINER_BASE + i
}

export function tileOrigin(i: number): readonly [number, number] {
  const xy = TILE_XY[i]
  if (!xy) throw new Error(`tile index out of range: ${i}`)
  return xy
}
