// Link baseline: how fast is this link right now?
//
// Push time drifts by about 1.5x over a minute at constant payload, so a number from one run
// is comparable with another only relative to a baseline, and the baseline is taken at both
// ends of a `?stats=1` run to detect drift within it. Where a change can be expressed as two
// arms, interleaving them in one run is better. See docs/notes/2026-10-tile-transfer-timing.md.

/** Pushes in a baseline: two per container, about 3.5 s of frozen mirror. */
export const LINK_BASE_PUSHES = 8

/** 3 px blocks of pseudo-random levels, sized so the encoded tile lands near the ~2.1 KB
 *  production tiles. The seed and block size must not change, or recorded baselines become
 *  incomparable. The encoded size depends on the deflate implementation (1920 B in node,
 *  2016 B in the phone's WebView), which is why `formatLinkBase` prints the byte count. */
export function linkBasePattern(w: number, h: number): Uint8Array {
  const B = 3
  const bw = Math.ceil(w / B),
    bh = Math.ceil(h / B)
  const lv = new Uint8Array(bw * bh)
  let s = 0x2f6e2b1
  for (let i = 0; i < lv.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    lv[i] = (s >> 7) & 15
  }
  const idx = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) idx[y * w + x] = lv[((y / B) | 0) * bw + ((x / B) | 0)]!
  }
  return idx
}

export function medianOf(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]!
}

/** The one line a later capture is read against. `at` is 'start' or 'end'. */
export function formatLinkBase(ms: readonly number[], bytes: number, at = 'start'): string {
  if (ms.length === 0) return `linkbase(${at}): no successful pushes — this run cannot be compared`
  const s = [...ms].sort((a, b) => a - b)
  const p90 = s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]!
  return `linkbase(${at}): n=${ms.length} ${bytes}B med ${medianOf(ms)}ms p90 ${p90}ms`
}

/** Compares the start and end baselines of one run. If they disagree by more than 15 % the
 *  link drifted during the run and none of its numbers may be compared with another run.
 *  15 % is the tolerance for two medians of eight over BLE. */
export function linkBaseVerdict(startMs: number, endMs: number): string {
  if (!startMs || !endMs) return '  (one end missing — treat this run as uncomparable)'
  const r = endMs / startMs
  const pct = Math.round((r - 1) * 100)
  return Math.abs(r - 1) <= 0.15
    ? `  link held within ${Math.abs(pct)}% — this run's push med may be divided by ${startMs} and compared`
    : `  LINK DRIFTED ${pct > 0 ? '+' : ''}${pct}% DURING THE RUN — do not compare any number in it` +
        ' with another run. Interleave the arms instead (see depthPlan).'
}
