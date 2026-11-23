// The PNG container, shared by the server encoder and the client one.
//
// Both ends emit indexed PNGs, but the server deflates synchronously with `node:zlib` and the
// browser only has the asynchronous `CompressionStream`. So this module owns the bytes around
// IDAT and each caller passes an already-deflated IDAT.
//
// Zero dependencies and Uint8Array throughout, never Buffer: the WebView imports this file.

/** PNG signature. */
export const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** One PNG chunk: length, type, data, CRC over type+data. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const t = new Uint8Array(4)
  for (let i = 0; i < 4; i++) t[i] = type.charCodeAt(i)
  const body = concatBytes([t, data])
  return concatBytes([u32(data.length), body, u32(crc32(body))])
}

/** Scanlines with filter 0 (None) on every row. With a 16-symbol alphabet deflate finds the
 *  runs by itself, and a Sub/Up filter makes the matches worse. */
export function filter0Rows(src: Uint8Array, bytesPerRow: number, h: number): Uint8Array {
  const stride = bytesPerRow + 1
  const raw = new Uint8Array(h * stride)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0
    raw.set(src.subarray(y * bytesPerRow, (y + 1) * bytesPerRow), y * stride + 1)
  }
  return raw
}

/** Pack 8-bit palette indices (0-15) two per byte, high nibble first (PNG bit depth 4). Rows
 *  are byte-aligned, so an odd width leaves the last low nibble of each row unused. */
export function pack4bit(
  idx: Uint8Array,
  w: number,
  h: number,
): { data: Uint8Array; bytesPerRow: number } {
  const bytesPerRow = Math.ceil(w / 2)
  const data = new Uint8Array(bytesPerRow * h)
  for (let y = 0; y < h; y++) {
    const si = y * w,
      di = y * bytesPerRow
    for (let x = 0; x < w; x++) {
      const v = (idx[si + x] ?? 0) & 0x0f
      const o = di + (x >> 1)
      data[o] = (x & 1) === 0 ? v << 4 : data[o]! | v
    }
  }
  return { data, bytesPerRow }
}

/** A PLTE payload from RGB triples: three bytes per entry. */
export function plteFrom(rgb: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const b = new Uint8Array(rgb.length * 3)
  for (let i = 0; i < rgb.length; i++) {
    const p = rgb[i]!
    b[i * 3] = p[0]
    b[i * 3 + 1] = p[1]
    b[i * 3 + 2] = p[2]
  }
  return b
}

export interface PngParts {
  w: number
  h: number
  /** Bits per sample. 4 or 8 for colour type 3; 8 for colour type 0. */
  depth: number
  /** 3 = indexed (PLTE required), 0 = greyscale (PLTE must be absent). */
  colourType: number
  /** Required for colour type 3, forbidden for colour type 0. */
  plte?: Uint8Array
  /** ZLIB-wrapped (RFC 1950) deflate of the filtered scanlines, not raw deflate. */
  idat: Uint8Array
}

/** Assemble a PNG from an already-compressed IDAT. `idat` must be ZLIB-wrapped (RFC 1950),
 *  as `deflateSync` and `CompressionStream('deflate')` produce. Raw DEFLATE (`'deflate-raw'`)
 *  is rejected by every decoder. */
export function assemblePng({ w, h, depth, colourType, plte, idat }: PngParts): Uint8Array {
  if (colourType === 3 && !plte) throw new Error('assemblePng: colour type 3 requires a PLTE')
  if (colourType === 0 && plte) throw new Error('assemblePng: colour type 0 must not carry a PLTE')
  const ihdr = concatBytes([
    u32(w),
    u32(h),
    new Uint8Array([
      depth,
      colourType,
      0, // compression method: deflate
      0, // filter method: adaptive (the per-row byte is always 0; see filter0Rows)
      0, // interlace: none
    ]),
  ])
  const parts = [PNG_SIG, pngChunk('IHDR', ihdr)]
  if (plte) parts.push(pngChunk('PLTE', plte))
  parts.push(pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0)))
  return concatBytes(parts)
}

/** ZLIB-wrapped deflate via `CompressionStream`, for callers without `node:zlib` (the
 *  WebView). `'deflate'` is the RFC 1950 wrapper that `assemblePng` requires. */
export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  void writer.write(data as unknown as BufferSource)
  void writer.close()
  const reader = cs.readable.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) parts.push(value as Uint8Array)
  }
  return concatBytes(parts)
}

/** The inverse of `assemblePng` for the one shape this project emits: colour type 3, depth 8,
 *  filter 0 on every row. Returns the palette indices, or null for any other shape. The
 *  client inflates tiles with this instead of decoding through a canvas: 0.69 ms against
 *  2.0 ms per tile on the phone (docs/notes/2026-10-client-tile-pipeline.md). */
export async function indexPlaneFromPng(
  png: Uint8Array,
  w: number,
  h: number,
): Promise<Uint8Array | null> {
  for (let i = 0; i < PNG_SIG.length; i++) if (png[i] !== PNG_SIG[i]) return null
  const be = (o: number): number =>
    ((png[o]! << 24) | (png[o + 1]! << 16) | (png[o + 2]! << 8) | png[o + 3]!) >>> 0
  const idats: Uint8Array[] = []
  let p = PNG_SIG.length
  let ok = false
  while (p + 12 <= png.length) {
    const len = be(p)
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!)
    const data = png.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      // depth 8, colour type 3, no interlace, and the dimensions the caller expects.
      ok = be(p + 8) === w && be(p + 12) === h && data[8] === 8 && data[9] === 3 && data[12] === 0
      if (!ok) return null
    } else if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  if (!ok || idats.length === 0) return null
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  void writer.write(concatBytes(idats) as unknown as BufferSource)
  void writer.close()
  const reader = ds.readable.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) parts.push(value as Uint8Array)
  }
  const raw = concatBytes(parts)
  const stride = w + 1
  if (raw.length < h * stride) return null
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    // Filter None is all the writer emits (see filter0Rows); refuse anything else.
    if (raw[y * stride] !== 0) return null
    out.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * w)
  }
  return out
}
