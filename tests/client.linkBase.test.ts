// The link baseline (src/client/linkBase.ts).
//
// Push time drifts about 1.5x over a minute at constant payload, so a run has to carry its
// own scale and say whether that scale held.

import { describe, expect, it } from 'vitest'
import { formatLinkBase, linkBasePattern, linkBaseVerdict } from '../src/client/linkBase.ts'
import { TILE_H, TILE_W } from '../src/shared/geom.ts'
import { assemblePng, filter0Rows, pack4bit, plteFrom, zlibDeflate } from '../src/shared/png.ts'

describe('linkBasePattern: a constant that must never change', () => {
  it('is deterministic: the same bytes every call', () => {
    const a = linkBasePattern(TILE_W, TILE_H)
    const b = linkBasePattern(TILE_W, TILE_H)
    expect(a).toEqual(b)
  })

  it('encodes to something beside the ~2.1KB production tiles, not the cheap end of the link', async () => {
    // A range, not an exact number: the pattern is the constant, but the encoded size depends
    // on the deflate implementation (1920 B in node, 2016 B in the phone's WebView).
    //
    // The baseline has to exercise the same part of the link as real content; a 159 B blank
    // tile would measure almost nothing.
    const idx = linkBasePattern(TILE_W, TILE_H)
    const { data, bytesPerRow } = pack4bit(idx, TILE_W, TILE_H)
    const png = assemblePng({
      w: TILE_W,
      h: TILE_H,
      depth: 4,
      colourType: 3,
      plte: plteFrom(Array.from({ length: 16 }, (_, i) => [i * 17, i * 17, i * 17] as const)),
      idat: await zlibDeflate(filter0Rows(data, bytesPerRow, TILE_H)),
    })
    expect(png.length).toBeGreaterThan(1500)
    expect(png.length).toBeLessThan(2600)
  })

  it('uses the whole ramp, so the payload is not accidentally compressible', () => {
    const seen = new Set(linkBasePattern(TILE_W, TILE_H))
    expect(seen.size).toBe(16)
  })

  it('covers every pixel', () => {
    expect(linkBasePattern(TILE_W, TILE_H)).toHaveLength(TILE_W * TILE_H)
  })
})

describe('formatLinkBase', () => {
  it('reports the median and the bytes it was measured with', () => {
    // The byte count shows whether two baselines came from the same deflate engine.
    const line = formatLinkBase([300, 310, 320, 330, 340, 350, 360, 700], 1920)
    expect(line).toContain('n=8 1920B')
    expect(line).toContain('med 340ms')
  })

  it('is robust to the one slow sample every BLE link produces', () => {
    // A median, not a mean: one 700 ms outlier in eight must not move the scale.
    const clean = formatLinkBase([300, 300, 300, 300, 300, 300, 300, 300], 1920)
    const withOutlier = formatLinkBase([300, 300, 300, 300, 300, 300, 300, 2000], 1920)
    expect(clean).toContain('med 300ms')
    expect(withOutlier).toContain('med 300ms')
  })

  it('says a session cannot be compared rather than inventing a scale for it', () => {
    expect(formatLinkBase([], 1920)).toContain('cannot be compared')
    expect(formatLinkBase([], 1920)).not.toContain('med ')
  })

  it('labels which end of the run it is', () => {
    expect(formatLinkBase([300], 1920, 'start')).toContain('linkbase(start)')
    expect(formatLinkBase([300], 1920, 'end')).toContain('linkbase(end)')
  })
})

describe('linkBaseVerdict: may this capture be compared at all?', () => {
  // The link drifts within a single capture (537 ms to 355 ms median in about a minute), so a
  // baseline at one end is not enough.

  it('passes a link that held', () => {
    expect(linkBaseVerdict(400, 400)).toContain('held')
    expect(linkBaseVerdict(400, 440)).toContain('held') // +10%
    expect(linkBaseVerdict(400, 360)).toContain('held') // -10%
  })

  it('fails a run that drifted from 537ms to 355ms', () => {
    const v = linkBaseVerdict(537, 355)
    expect(v).toContain('LINK DRIFTED')
    expect(v).toContain('-34%')
    expect(v).toContain('do not compare')
  })

  it('tolerates 15%, because two medians of eight over BLE will not agree exactly', () => {
    expect(linkBaseVerdict(400, 460)).toContain('held') // +15% exactly: inclusive
    expect(linkBaseVerdict(400, 461)).toContain('LINK DRIFTED') // just past it
  })

  it('points at the remedy rather than just refusing', () => {
    expect(linkBaseVerdict(537, 355)).toContain('Interleave')
  })

  it('refuses rather than dividing by a missing end', () => {
    expect(linkBaseVerdict(0, 400)).toContain('uncomparable')
    expect(linkBaseVerdict(400, 0)).toContain('uncomparable')
  })
})
