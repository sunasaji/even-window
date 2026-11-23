// The PNG container (src/shared/png.ts).
//
// Both ends encode through this: the server for the tile it sends the client, the client for
// the tile it pushes to the glasses. The typical faults of a hand-rolled PNG writer (a
// raw-DEFLATE IDAT, a CRC over the wrong span, nibbles packed low-first) all look like a
// decoder refusing the file, so the output is validated structurally, round-tripped through
// node's zlib and cross-checked between the two callers. `CompressionStream` is a node
// global, so the real browser-side path runs here.

import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodeIndexedPng } from '../src/server/png.ts'
import { TILE_H, TILE_W } from '../src/shared/geom.ts'
import {
  assemblePng,
  concatBytes,
  crc32,
  filter0Rows,
  indexPlaneFromPng,
  PNG_SIG,
  pack4bit,
  plteFrom,
  pngChunk,
  zlibDeflate,
} from '../src/shared/png.ts'

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const GREY_PLTE = plteFrom(Array.from({ length: 16 }, (_, i) => [i * 17, i * 17, i * 17] as const))

interface Chunk {
  type: string
  data: Uint8Array
}

/** Walk a PNG, checking every chunk's CRC with an independent implementation on the way. */
function parsePng(png: Uint8Array): Chunk[] {
  for (let i = 0; i < SIG.length; i++) {
    if (png[i] !== SIG[i]) throw new Error(`bad signature at byte ${i}`)
  }
  const table = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  const crc = (b: Uint8Array): number => {
    let c = 0xffffffff
    for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const be = (o: number): number =>
    ((png[o]! << 24) | (png[o + 1]! << 16) | (png[o + 2]! << 8) | png[o + 3]!) >>> 0
  const out: Chunk[] = []
  let p = SIG.length
  while (p < png.length) {
    const len = be(p)
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!)
    const data = png.subarray(p + 8, p + 8 + len)
    const want = be(p + 8 + len)
    const got = crc(png.subarray(p + 4, p + 8 + len))
    if (got !== want) throw new Error(`CRC mismatch in ${type}: got ${got} want ${want}`)
    out.push({ type, data })
    p += 12 + len
  }
  return out
}

const ihdrOf = (cs: Chunk[]) => {
  const d = cs.find(c => c.type === 'IHDR')!.data
  const be = (o: number) => ((d[o]! << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!) >>> 0
  return {
    w: be(0),
    h: be(4),
    depth: d[8]!,
    colourType: d[9]!,
    compression: d[10]!,
    filter: d[11]!,
    interlace: d[12]!,
  }
}

/** Inflate IDAT and strip the per-row filter byte, asserting each is 0 (filter None). */
function scanlines(cs: Chunk[], bytesPerRow: number, h: number): Uint8Array {
  const raw = new Uint8Array(inflateSync(Buffer.from(cs.find(c => c.type === 'IDAT')!.data)))
  expect(raw.length).toBe(h * (bytesPerRow + 1))
  const out = new Uint8Array(h * bytesPerRow)
  for (let y = 0; y < h; y++) {
    expect(raw[y * (bytesPerRow + 1)]).toBe(0)
    out.set(raw.subarray(y * (bytesPerRow + 1) + 1, (y + 1) * (bytesPerRow + 1)), y * bytesPerRow)
  }
  return out
}

/** A tile plane with every level in it, deterministic. */
const plane = (): Uint8Array =>
  Uint8Array.from({ length: TILE_W * TILE_H }, (_, i) => (i * 7 + ((i / TILE_W) | 0)) & 15)

describe('zlibDeflate: IDAT needs the ZLIB wrapper', () => {
  it('emits ZLIB (RFC 1950), not raw DEFLATE, because that is what IDAT must carry', async () => {
    const out = await zlibDeflate(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(out[0]! & 0x0f).toBe(8) // CM = 8
    expect(((out[0]! << 8) | out[1]!) % 31).toBe(0) // the header check value
  })

  it('round-trips through node zlib', async () => {
    const src = new Uint8Array(5000).map((_, i) => i % 17)
    expect(new Uint8Array(inflateSync(Buffer.from(await zlibDeflate(src))))).toEqual(src)
  })
})

describe('crc32', () => {
  it("matches the PNG specification's check value", () => {
    // "123456789" -> 0xCBF43926 is the standard CRC-32 test vector.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

describe('assemblePng', () => {
  it('refuses colour type 3 without a palette, and colour type 0 with one', () => {
    const idat = new Uint8Array([0x78, 0x01, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])
    expect(() => assemblePng({ w: 1, h: 1, depth: 8, colourType: 3, idat })).toThrow(
      /requires a PLTE/,
    )
    expect(() =>
      assemblePng({ w: 1, h: 1, depth: 8, colourType: 0, plte: GREY_PLTE, idat }),
    ).toThrow(/must not carry/)
  })

  it('writes IHDR exactly, including the fields nobody looks at', async () => {
    const { data, bytesPerRow } = pack4bit(plane(), TILE_W, TILE_H)
    const cs = parsePng(
      assemblePng({
        w: TILE_W,
        h: TILE_H,
        depth: 4,
        colourType: 3,
        plte: GREY_PLTE,
        idat: await zlibDeflate(filter0Rows(data, bytesPerRow, TILE_H)),
      }),
    )
    expect(cs.map(c => c.type)).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND'])
    expect(ihdrOf(cs)).toEqual({
      w: TILE_W,
      h: TILE_H,
      depth: 4,
      colourType: 3,
      compression: 0,
      filter: 0,
      interlace: 0,
    })
  })
})

describe('pack4bit: bit depth 4 is what the glasses are sent', () => {
  it('packs two pixels per byte, high nibble first', () => {
    const { data, bytesPerRow } = pack4bit(new Uint8Array([1, 2, 3, 4]), 4, 1)
    expect(bytesPerRow).toBe(2)
    expect([...data]).toEqual([0x12, 0x34])
  })

  it('byte-aligns each row, so an odd width leaves the last low nibble unused', () => {
    const { data, bytesPerRow } = pack4bit(new Uint8Array([1, 2, 3, 4, 5, 6]), 3, 2)
    expect(bytesPerRow).toBe(2)
    expect([...data]).toEqual([0x12, 0x30, 0x45, 0x60])
  })

  it('round-trips a whole tile through the nibbles', async () => {
    const idx = plane()
    const { data, bytesPerRow } = pack4bit(idx, TILE_W, TILE_H)
    const cs = parsePng(
      assemblePng({
        w: TILE_W,
        h: TILE_H,
        depth: 4,
        colourType: 3,
        plte: GREY_PLTE,
        idat: await zlibDeflate(filter0Rows(data, bytesPerRow, TILE_H)),
      }),
    )
    const rows = scanlines(cs, bytesPerRow, TILE_H)
    const back = new Uint8Array(TILE_W * TILE_H)
    for (let y = 0; y < TILE_H; y++) {
      for (let x = 0; x < TILE_W; x++) {
        const b = rows[y * bytesPerRow + (x >> 1)]!
        back[y * TILE_W + x] = (x & 1) === 0 ? b >> 4 : b & 0x0f
      }
    }
    expect(back).toEqual(idx)
  })
})

describe('filter0Rows', () => {
  it('prefixes every row with a zero and copies the rest verbatim', () => {
    expect([...filter0Rows(new Uint8Array([1, 2, 3, 4, 5, 6]), 3, 2)]).toEqual([
      0, 1, 2, 3, 0, 4, 5, 6,
    ])
  })
})

describe('the two callers cannot diverge', () => {
  it('the browser path and the server path produce the same 8-bit indexed pixels', async () => {
    // The server deflates with node:zlib and the client with CompressionStream, so the IDAT
    // bytes may differ; the pixels may not. Only the palette is meant to differ.
    const idx = plane()
    const mine = parsePng(
      assemblePng({
        w: TILE_W,
        h: TILE_H,
        depth: 8,
        colourType: 3,
        plte: GREY_PLTE,
        idat: await zlibDeflate(filter0Rows(idx, TILE_W, TILE_H)),
      }),
    )
    const theirs = parsePng(new Uint8Array(encodeIndexedPng(idx, TILE_W, TILE_H)))
    expect(scanlines(mine, TILE_W, TILE_H)).toEqual(scanlines(theirs, TILE_W, TILE_H))
    expect(ihdrOf(mine)).toEqual(ihdrOf(theirs))
  })
})

// ── reading one back ───────────────────────────────────────────────────────────────────────
//
// `indexPlaneFromPng` is the counterpart to the writer above, and the client's arrival path
// rests on it. It is deliberately narrow: a shape it does not recognise returns null, because
// a mis-decoded tile is a wrong picture on the glasses.

describe('indexPlaneFromPng', () => {
  it('round-trips the writer exactly, which is the only contract that matters', async () => {
    const idx = plane()
    const png = new Uint8Array(encodeIndexedPng(idx, TILE_W, TILE_H))
    expect(await indexPlaneFromPng(png, TILE_W, TILE_H)).toEqual(idx)
  })

  it('round-trips a tile of a single colour, and one using every index', async () => {
    for (const mk of [
      () => new Uint8Array(TILE_W * TILE_H), // all black
      () => Uint8Array.from({ length: TILE_W * TILE_H }, (_, i) => i % 16), // every index
    ]) {
      const idx = mk()
      const png = new Uint8Array(encodeIndexedPng(idx, TILE_W, TILE_H))
      expect(await indexPlaneFromPng(png, TILE_W, TILE_H)).toEqual(idx)
    }
  })

  it('refuses a PNG that is not the shape this project writes', async () => {
    const idx = plane()
    const good = new Uint8Array(encodeIndexedPng(idx, TILE_W, TILE_H))
    // wrong dimensions asked for
    expect(await indexPlaneFromPng(good, TILE_W + 1, TILE_H)).toBeNull()
    expect(await indexPlaneFromPng(good, TILE_W, TILE_H + 1)).toBeNull()
    // not a PNG at all
    expect(await indexPlaneFromPng(new Uint8Array(32), TILE_W, TILE_H)).toBeNull()
    // the right dimensions but greyscale, so the bytes are pixels and not indices
    const grey = assemblePng({
      w: TILE_W,
      h: TILE_H,
      depth: 8,
      colourType: 0,
      idat: await zlibDeflate(filter0Rows(idx, TILE_W, TILE_H)),
    })
    expect(await indexPlaneFromPng(grey, TILE_W, TILE_H)).toBeNull()
  })

  it('refuses a filter it cannot reconstruct rather than mis-decoding it', async () => {
    // Every row gets filter 1 (Sub), which the writer never emits; returning the raw bytes
    // would be a plausible-looking wrong picture.
    const stride = TILE_W + 1
    const raw = new Uint8Array(TILE_H * stride)
    for (let y = 0; y < TILE_H; y++) {
      raw[y * stride] = 1
      raw.set(plane().subarray(y * TILE_W, (y + 1) * TILE_W), y * stride + 1)
    }
    const png = assemblePng({
      w: TILE_W,
      h: TILE_H,
      depth: 8,
      colourType: 3,
      plte: GREY_PLTE,
      idat: await zlibDeflate(raw),
    })
    expect(await indexPlaneFromPng(png, TILE_W, TILE_H)).toBeNull()
  })

  it('handles a PNG split across several IDAT chunks', async () => {
    const idx = plane()
    const idat = await zlibDeflate(filter0Rows(idx, TILE_W, TILE_H))
    const cut = idat.length >> 1
    const png = concatBytes([
      PNG_SIG,
      pngChunk(
        'IHDR',
        concatBytes([
          new Uint8Array([
            0,
            0,
            (TILE_W >> 8) & 255,
            TILE_W & 255,
            0,
            0,
            (TILE_H >> 8) & 255,
            TILE_H & 255,
          ]),
          new Uint8Array([8, 3, 0, 0, 0]),
        ]),
      ),
      pngChunk('PLTE', GREY_PLTE),
      pngChunk('IDAT', idat.subarray(0, cut)),
      pngChunk('IDAT', idat.subarray(cut)),
      pngChunk('IEND', new Uint8Array(0)),
    ])
    expect(await indexPlaneFromPng(png, TILE_W, TILE_H)).toEqual(idx)
  })
})
