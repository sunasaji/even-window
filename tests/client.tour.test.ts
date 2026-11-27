// The phone tour (src/client/tour.ts): the cards, the `?tour=` query, where the card sits
// against the spotlight, and the wiring that would break silently (a target never registered, a
// first run that never opens, a `?` that is not there).

import { describe, expect, it } from 'vitest'
import {
  cardTop,
  dimPath,
  gestureFigureSvg,
  type TourTarget,
  tourCards,
  tourQuery,
  tourRegions,
} from '../src/client/tour.ts'
import { clientSource } from './helpers/source.ts'

describe('cards', () => {
  it('mention the long press only when there is a recogniser', () => {
    const text = (v: boolean) => JSON.stringify(tourCards(v))
    expect(text(true)).toContain('long press')
    expect(text(false)).not.toContain('long press')
  })

  it('cover the discoveries the UI cannot show by itself', () => {
    const all = JSON.stringify(tourCards(false))
    for (const must of ['double-tap', 'Submit only types', '▶ app', 'Hold Submit', 'vPad', '?'])
      expect(all).toContain(must)
  })

  it('spotlight each target once', () => {
    const ts = tourCards(false)
      .map(c => c.target)
      .filter(t => t !== null)
    expect(new Set(ts).size).toBe(ts.length)
  })

  // The gestures card explains hardware, so it points at a drawing of it, not at buttons.
  it('explain the glasses gestures over a figure, with no button lit', () => {
    const g = tourCards(false).find(c => c.title === 'Gestures on the glasses')
    expect(g?.target).toBeNull()
    expect(g?.figureAt).toBe('mirror')
  })

  it('come in the order: the mirror, then the screen from the top down', () => {
    expect(
      tourCards(false).map(c =>
        c.demo ? `open:${c.demo}` : (c.target ?? `figure:${String(c.figureAt)}`),
      ),
    ).toEqual([
      'mirror',
      'figure:mirror',
      'palettes',
      'open:apps',
      'text',
      'gestures',
      'tools',
      'open:keys',
      'open:vring',
      'open:vpad',
      'app',
    ])
  })

  // A surface that opens over the screen is shown open, right after the row its button is in.
  it('open each surface on the card after the one that lights its button', () => {
    const cs = tourCards(true)
    const at = (pred: (c: (typeof cs)[number]) => boolean): number => cs.findIndex(pred)
    expect(at(c => c.demo === 'keys')).toBe(at(c => c.target === 'tools') + 1)
    expect(at(c => c.demo === 'apps')).toBe(at(c => c.target === 'palettes') + 1)
    // A full-screen surface is not dimmed, so its card says where to stand.
    for (const d of ['vring', 'vpad', 'apps'])
      expect(cs.find(c => c.demo === d)?.cardAt, d).toBeGreaterThan(0)
  })

  it('give Submit and ▶ app a card each', () => {
    const cs = tourCards(false)
    expect(cs.filter(c => c.target === 'text')).toHaveLength(1)
    expect(cs.filter(c => c.target === 'app')).toHaveLength(1)
  })

  it('name every button of the rows they light', () => {
    const all = JSON.stringify(tourCards(true))
    for (const b of [
      'dn',
      'up',
      'tap',
      'dbl',
      'font',
      'keys',
      'vRing',
      'vPad',
      'inv',
      'color',
      'lens',
      '🎤 voice',
      'Submit',
    ])
      expect(all).toContain(b)
  })

  it('mention the voice button only with a recogniser', () => {
    expect(JSON.stringify(tourCards(false))).not.toContain('🎤')
  })
})

describe('overview', () => {
  it('numbers each area with the cards that explain it, in card order', () => {
    expect(tourRegions(tourCards(false))).toEqual([
      { target: 'mirror', label: '1–2' },
      { target: 'palettes', label: '3–4' },
      { target: 'text', label: '5' },
      { target: 'gestures', label: '6' },
      { target: 'tools', label: '7–10' },
      { target: 'app', label: '11' },
    ])
  })

  it('lists the numbers when an area is visited twice with other cards between', () => {
    const card = (target: TourTarget) => ({ target, title: '', lines: [] })
    expect(tourRegions([card('mirror'), card('tools'), card('mirror')])).toEqual([
      { target: 'mirror', label: '1·3' },
      { target: 'tools', label: '2' },
    ])
  })
})

describe('?tour=', () => {
  it('1 opens, 0 suppresses, anything else defers to the device', () => {
    expect(tourQuery('?tour=1')).toBe('open')
    expect(tourQuery('?server=x&tour=0')).toBe('never')
    expect(tourQuery('?tour=yes')).toBeNull()
    expect(tourQuery('')).toBeNull()
  })
})

describe('cardTop', () => {
  const H = 800
  const CARD = 200

  it('goes below the hole when it fits', () => {
    expect(cardTop({ top: 50, bottom: 300 }, CARD, H)).toBe(312)
  })

  it('goes above when only that fits', () => {
    expect(cardTop({ top: 500, bottom: 700 }, CARD, H)).toBe(500 - 12 - CARD)
  })

  it('pins to the roomier edge when neither fits, never off screen', () => {
    const t = cardTop({ top: 150, bottom: 700 }, CARD, H)
    expect(t).toBeGreaterThanOrEqual(0)
    expect(t + CARD).toBeLessThanOrEqual(H)
  })

  it('centres without a hole', () => {
    expect(cardTop(null, CARD, H)).toBe(300)
  })
})

describe('gestureFigureSvg', () => {
  it("is one svg in the mirror's 2:1 box, labelling both touch areas", () => {
    const svg = gestureFigureSvg()
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox="0 0 576 288"')
    expect(svg).toContain('behind either ear')
    expect(svg).toContain('R1 ring')
  })
})

describe('dimPath', () => {
  it('is the viewport alone without holes', () => {
    expect(dimPath(600, 800, [])).toBe("path(evenodd, 'M0 0H600V800H0Z')")
  })

  it('cuts one closed sub-path per hole, even-odd so each is clear', () => {
    const d = dimPath(600, 800, [
      { left: 10, top: 20, width: 100, height: 40 },
      { left: 10, top: 200, width: 300, height: 30 },
    ])
    expect(d.startsWith('path(evenodd,')).toBe(true)
    expect(d.match(/Z/g)?.length).toBe(3)
    expect(d).toContain('M18 20H102') // the first hole's top edge, inset by the corner radius
  })
})

describe('wiring', () => {
  const src = clientSource()

  it('every target a card names is registered by the UI', () => {
    const names = new Set(
      tourCards(true)
        .map(c => c.target)
        .filter(t => t !== null),
    )
    for (const t of names as Set<TourTarget>)
      expect(src.has(`registerTourTarget('${t}'`), `registerTourTarget('${t}')`).toBe(true)
  })

  it('every surface a card opens is registered by the UI', () => {
    for (const c of tourCards(true))
      if (c.demo) expect(src.has(`registerTourDemo('${c.demo}'`), c.demo).toBe(true)
  })

  it('opens on the first health answer, and from the ? pill', () => {
    expect(src.count('maybeOpenTourOnFirstRun(sttReady)')).toBe(1)
    expect(src.has("openTour(sttReady, '? button')")).toBe(true)
  })
})
