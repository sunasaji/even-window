// png.ts — 16-colour quantisation + a hand-rolled indexed-PNG encoder.
//
// The glasses are a mono panel, but the WIRE format carries a palette INDEX (0-15), not
// grey: the client decides how to render it (grey ramp on the glasses, colour in the
// simulator). So the server quantises every captured RGB pixel to the nearest of the 16
// ANSI colours and emits a colour-type-3 PNG whose PLTE is exactly that ANSI palette.
// A 288x144 tile then costs about the same as a grayscale tile while still carrying hue.
//
// Zero image dependencies: node's built-in zlib does the only hard part (deflate).
//
// Derived from heimterm src/server/x11.ts:392-452 (MIT, (c) 2026 Suna.S)

import { deflateSync } from 'node:zlib'

/** The 16 ANSI colours (xterm's classic values), in palette-index order. */
export const ANSI16: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
] as const

// ── RGB → nearest ANSI index LUT ────────────────────────────────────────────────
// 5 bits per channel = 32768 entries, built once. Reducing the per-pixel nearest-colour
// search (16 squared-distance comparisons) to a single array read is what makes tiling a
// 576x288 frame at 10fps cheap enough to do synchronously in the capture callback.
let lutCache: Uint8Array | null = null

/** Memoised 32768-entry LUT: index with `(r>>3)<<10 | (g>>3)<<5 | (b>>3)` → ANSI index 0-15. */
export function indexLut(): Uint8Array {
  if (lutCache) return lutCache
  const lut = new Uint8Array(32768)
  for (let r5 = 0; r5 < 32; r5++) {
    for (let g5 = 0; g5 < 32; g5++) {
      for (let b5 = 0; b5 < 32; b5++) {
        // Expand 5-bit back to 8-bit by replicating the high bits (0..31 → 0..255).
        const r = (r5 << 3) | (r5 >> 2), g = (g5 << 3) | (g5 >> 2), b = (b5 << 3) | (b5 >> 2)
        let best = 0, bd = Infinity
        for (let i = 0; i < 16; i++) {
          const p = ANSI16[i]!
          const dr = r - p[0], dg = g - p[1], db = b - p[2]
          const d = dr * dr + dg * dg + db * db
          if (d < bd) { bd = d; best = i }
        }
        lut[(r5 << 10) | (g5 << 5) | b5] = best
      }
    }
  }
  lutCache = lut
  return lut
}

// ── PNG writer (colour type 3, 8-bit index, filter None) ────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** PLTE chunk payload: the 16 ANSI RGB triples (48 bytes). Constant, so built once. */
const PLTE = (() => {
  const b = Buffer.alloc(16 * 3)
  for (let i = 0; i < 16; i++) {
    const p = ANSI16[i]!
    b[i * 3] = p[0]; b[i * 3 + 1] = p[1]; b[i * 3 + 2] = p[2]
  }
  return b
})()

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IEND = chunk('IEND', Buffer.alloc(0))

/**
 * Encode a `w`x`h` row-major buffer of palette indices (1 byte/pixel, values 0-15) as an
 * 8-bit indexed PNG carrying the ANSI16 PLTE.
 *
 * Filter 0 (None) on every scanline: the input is already a tiny alphabet of 16 symbols,
 * so deflate's LZ77 stage finds the runs on its own and a Sub/Up filter only decorrelates
 * them into worse matches. Level 6 is the speed/size knee for this data.
 */
export function encodeIndexedPng(idx: Uint8Array, w: number, h: number): Buffer {
  if (idx.length < w * h) throw new Error(`encodeIndexedPng: need ${w * h} bytes, got ${idx.length}`)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8   // bit depth: 8-bit palette index
  ihdr[9] = 3   // colour type 3 = indexed (requires PLTE)
  ihdr[10] = 0  // compression method: deflate
  ihdr[11] = 0  // filter method: adaptive (per-scanline byte below is always 0)
  ihdr[12] = 0  // interlace: none
  // Raw scanlines: one filter byte (0 = None) prefixing each row of indices.
  const stride = w + 1
  const raw = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0
    raw.set(idx.subarray(y * w, y * w + w), y * stride + 1)
  }
  const idat = deflateSync(raw, { level: 6 })
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('PLTE', PLTE), chunk('IDAT', idat), IEND])
}
