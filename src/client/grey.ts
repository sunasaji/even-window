// pinhole-window — the ANSI palette, the grey ramp and the index→grey lookup.
//
// A leaf: it imports no other client module, so anything may use it at load time.

// ── grey derivation ────────────────────────────────────────────────────────────────────────
//
// The server sends a 16-colour indexed PNG per tile (palette = ANSI16, docs/platform.md), and
// the ramp is applied here rather than on the server. The glasses are a lit-on-black mono
// panel: each palette index maps to a level 0-15 and the pushed grey is `lvl / 15 * 255`.

const X11_ANSI: ReadonlyArray<readonly [number, number, number]> = [
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
]

/** Grey level (0-15) per ANSI palette index, chosen so the luminance-ordered palette reads as
 *  an even 0..15 ramp (Black=0 … Br.White=15). */
const GREY_RAMP: readonly number[] = [0, 2, 7, 12, 1, 4, 9, 14, 8, 3, 10, 13, 6, 5, 11, 15]

// RGB → level lookup. Exact, not a quantisation: GREY_CODE maps a channel byte to a small code
// (0 = not a palette channel value) and the key `(cr << 10) | (cg << 5) | cb` is injective over
// the 16 palette colours; anything else hits the -1 sentinel and takes the luminance fallback.
// 5 bits per code so the shift cannot overflow for any 16-colour palette.
const GREY_CODE = new Uint8Array(256)
const GREY_LUT = new Int16Array(32768)

function buildGreyLut(): void {
  GREY_CODE.fill(0)
  GREY_LUT.fill(-1)
  const vals = [...new Set(X11_ANSI.flat())].sort((a, b) => a - b)
  vals.forEach((v, i) => {
    GREY_CODE[v] = i + 1
  })
  for (let i = 0; i < X11_ANSI.length; i++) {
    const rgb = X11_ANSI[i]
    if (!rgb) continue
    const lvl = Math.max(0, Math.min(15, GREY_RAMP[i] ?? 15))
    const key = (GREY_CODE[rgb[0]]! << 10) | (GREY_CODE[rgb[1]]! << 5) | GREY_CODE[rgb[2]]!
    GREY_LUT[key] = lvl
  }
}
buildGreyLut()

/** 255 / 15 — exact, so a level converts to a byte with a multiply and back with a divide. */
export const LEVEL_STEP = 17

/** The primary rule: ANSI RGB → ramp level 0..15. Levels, not bytes, because the tile ships as
 *  an indexed PNG whose palette is exactly the sixteen levels; the off-palette luminance
 *  fallback is therefore quantised. `inverted` flips the level as the last step, which keeps
 *  the PLTE constant. */
export function levelOf(r: number, g: number, b: number, inverted = false): number {
  const hit = GREY_LUT[(GREY_CODE[r]! << 10) | (GREY_CODE[g]! << 5) | GREY_CODE[b]!]!
  const lvl = hit >= 0 ? hit : Math.round((0.299 * r + 0.587 * g + 0.114 * b) / LEVEL_STEP)
  return inverted ? 15 - lvl : lvl
}

/** The same rule as a 0..255 byte, for the preview and for anything that wants a pixel value. */
export function greyOf(r: number, g: number, b: number, inverted = false): number {
  return levelOf(r, g, b, inverted) * LEVEL_STEP
}

/** ANSI palette index → ramp level, and its inverted twin. Derived from `levelOf`, so the
 *  per-pixel sixteen-entry read cannot drift from the one rule. */
export const LEVEL_BY_ANSI: readonly Uint8Array[] = [false, true].map(inv =>
  Uint8Array.from({ length: 16 }, (_, i) => {
    const c = X11_ANSI[i] ?? [0, 0, 0]
    return levelOf(c[0]!, c[1]!, c[2]!, inv)
  }),
)

/** The ANSI palette packed one u32 per entry, for the colour mirror: one store per pixel.
 *  Little-endian RGBA, which is what `ImageData` wants on every platform this runs on. */
export const ANSI_U32 = (() => {
  const u32 = new Uint32Array(16)
  const u8 = new Uint8Array(u32.buffer)
  for (let i = 0; i < 16; i++) {
    const c = X11_ANSI[i] ?? [0, 0, 0]
    u8[i * 4] = c[0]!
    u8[i * 4 + 1] = c[1]!
    u8[i * 4 + 2] = c[2]!
    u8[i * 4 + 3] = 255
  }
  return u32
})()

/** The ramp as green, packed the same way, for the lens-simulation mirror. */
export const GREEN_U32 = (() => {
  const u32 = new Uint32Array(16)
  const u8 = new Uint8Array(u32.buffer)
  for (let i = 0; i < 16; i++) {
    u8[i * 4 + 1] = i * LEVEL_STEP
    u8[i * 4 + 3] = 255
  }
  return u32
})()

/** The 16 palette entries the pushed tile carries: the ramp as greys. Constant: invert flips
 *  the index, never the palette. */
export const RAMP_GREYS: readonly number[] = Array.from({ length: 16 }, (_, i) => i * LEVEL_STEP)
