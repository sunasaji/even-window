// png.ts — 16-colour quantisation + a hand-rolled indexed-PNG encoder.
//
// The wire format carries a palette index (0-15), not grey: the client decides how to render
// it (grey ramp on the glasses, colour in the simulator). The server quantises every captured
// RGB pixel to the nearest of the 16 ANSI colours and emits a colour-type-3 PNG whose PLTE is
// that palette (docs/decisions/indexed-png-tiles.md). No image dependencies: node's zlib does
// the deflate.

import { deflateSync } from 'node:zlib'
import { assemblePng, filter0Rows, plteFrom } from '../shared/png.ts'

/** The 16 ANSI colours (xterm's classic values), in palette-index order. */
export const ANSI16: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
] as const

// ── RGB → nearest ANSI index LUT ────────────────────────────────────────────────
// 5 bits per channel = 32768 entries, built once. One array read per pixel instead of a
// nearest-colour search keeps tiling cheap enough to run synchronously in the capture callback.
let lutCache: Uint8Array | null = null

/** Memoised 32768-entry LUT: index with `(r>>3)<<10 | (g>>3)<<5 | (b>>3)` → ANSI index 0-15. */
export function indexLut(): Uint8Array {
  if (lutCache) return lutCache
  const lut = new Uint8Array(32768)
  for (let r5 = 0; r5 < 32; r5++) {
    for (let g5 = 0; g5 < 32; g5++) {
      for (let b5 = 0; b5 < 32; b5++) {
        // Expand 5-bit back to 8-bit by replicating the high bits (0..31 → 0..255).
        const r = (r5 << 3) | (r5 >> 2),
          g = (g5 << 3) | (g5 >> 2),
          b = (b5 << 3) | (b5 >> 2)
        let best = 0,
          bd = Infinity
        for (let i = 0; i < 16; i++) {
          const p = ANSI16[i]!
          const dr = r - p[0],
            dg = g - p[1],
            db = b - p[2]
          const d = dr * dr + dg * dg + db * db
          if (d < bd) {
            bd = d
            best = i
          }
        }
        lut[(r5 << 10) | (g5 << 5) | b5] = best
      }
    }
  }
  lutCache = lut
  return lut
}

// ── PNG writer (colour type 3, 8-bit index, filter None) ────────────────────
//
// The container (chunk framing, CRC) lives in src/shared/png.ts because the client writes
// indexed PNGs too. Compression is not shared: here it is `node:zlib`'s `deflateSync`, in a
// WebView only the asynchronous `CompressionStream` exists. Shared code takes an
// already-deflated IDAT.

/** PLTE payload: the 16 ANSI RGB triples (48 bytes). Constant, so built once. */
const PLTE = plteFrom(ANSI16)

/** Encode a `w`x`h` row-major buffer of palette indices (1 byte/pixel, values 0-15) as an
 *  8-bit indexed PNG carrying the ANSI16 PLTE. Deflate level 6; filter None on every scanline
 *  (see `filter0Rows`). */
export function encodeIndexedPng(idx: Uint8Array, w: number, h: number): Buffer {
  if (idx.length < w * h)
    throw new Error(`encodeIndexedPng: need ${w * h} bytes, got ${idx.length}`)
  const idat = deflateSync(filter0Rows(idx, w, h), { level: 6 })
  return Buffer.from(assemblePng({ w, h, depth: 8, colourType: 3, plte: PLTE, idat }))
}
