// pinhole-window — the phone tour: a few cards, each spotlighting one part of the real phone UI
// and saying what it does, so a first-time user reaches every kind of control without reading
// the docs (docs/phone-ui.md). It opens by itself once per device, and the `?` pill in the
// title row opens it again.
//
// It starts on an overview: the whole screen undimmed, every area the tour visits framed and
// numbered with its cards, so the layout and the route are seen before the first card. The
// surfaces that open over the screen (`keys`, vRing, vPad, the `apps` palette) get a card of
// their own, during which the tour opens the real thing and closes it again (`TourDemo`).
//
// The spotlight is the live UI, not a picture of it: holes cut in a dimmed layer over the
// elements' own boxes (`clip-path` with an even-odd path, so a card can point at two places
// without lighting what lies between), with the card placed above or below them. The
// layer takes every touch, so nothing behind it can be pressed by accident while reading.
//
// The glasses are not part of it: their own startup hint (hints.ts) covers the lens, and the
// tour explains the glasses gestures from the phone, which is the surface that can show a
// paragraph. That card lights no button: it lays a schematic of the temple and the ring over
// the mirror (`figureAt`), so what is explained and what is pointed at are the same thing.

import { button } from './chrome.ts'
import { log } from './debugLog.ts'
import { keep } from './durableKv.ts'

/** The parts of the phone UI a card can spotlight. Registered by `mountUi`. */
export type TourTarget = 'mirror' | 'gestures' | 'text' | 'app' | 'tools' | 'palettes'

/** A surface the tour opens for the length of one card. Registered by `mountUi`. */
export type TourDemo = 'keys' | 'vring' | 'vpad' | 'apps'

/** Where the button that opens each demo lives; the overview counts the demo's card there. */
const DEMO_REGION: Readonly<Record<TourDemo, TourTarget>> = {
  keys: 'tools',
  vring: 'tools',
  vpad: 'tools',
  apps: 'palettes',
}

/** One row of a card: a sentence, or a `[control, what it does]` pair laid out as a table. */
export type TourLine = string | readonly [string, string]

export interface TourCard {
  /** What the card spotlights; null dims everything. */
  readonly target: TourTarget | null
  /** A drawing laid over this target's box instead of a hole: the glasses gestures are made on
   *  hardware, so the card that explains them shows the hardware, not the phone's buttons. */
  readonly figureAt?: TourTarget
  /** Open this surface while the card is up. A full-screen one is shown as it is, undimmed. */
  readonly demo?: TourDemo
  /** With a full-screen demo: the card's top as a fraction of the viewport height, chosen per
   *  surface so the card covers what matters least there. */
  readonly cardAt?: number
  readonly title: string
  readonly lines: readonly TourLine[]
}

/** Pure: the cards, in order. The mirror first, because the rest acts on it (what the lens
 *  shows, then the gestures on the hardware), then the screen from the top down: the palette
 *  openers, the text row, the gesture row, the tools row and `▶ app`, each surface a row opens
 *  directly after that row. The last card says how to get back here. Voice rows appear only
 *  when the server has a recogniser, the same rule as the lens hint and the `🎤 voice` button. */
export function tourCards(voice: boolean): TourCard[] {
  return [
    {
      target: 'mirror',
      title: 'The glasses show your desktop',
      lines: [
        'This preview is the same picture the lens shows.',
        ['tap', 'click there'],
        ['drag', 'press, move and release there'],
        'This screen is the remote: it works with the glasses off too.',
      ],
    },
    {
      target: null,
      figureAt: 'mirror',
      title: 'Gestures on the glasses',
      lines: [
        'On the pad at the tip of either temple (behind the ear), or on the R1 ring:',
        ['swipe', 'along the pad: back = Down, forward = Up key to the window'],
        ['tap', 'Enter'],
        ['double-tap', 'menu: switch windows, launch apps, send keys'],
        ...(voice ? [['long press', 'voice input'] as const] : []),
        'In the menu: swipe moves, tap picks, double-tap goes back.',
      ],
    },
    {
      target: 'palettes',
      title: 'Windows and apps',
      lines: [
        ['task', 'switch to another window'],
        ['window', 'close one, open a terminal, more'],
        ['apps', 'launch a program: the next card opens it'],
      ],
    },
    {
      target: null,
      demo: 'apps',
      cardAt: 0.62,
      title: 'apps: launch a program',
      lines: [
        'Tap a row to start it on the desktop. The box at the top filters the list.',
        '✕ or a tap outside closes it.',
      ],
    },
    {
      target: 'text',
      title: 'Type into the window',
      lines: [
        ['Submit', 'types the box into the window (bottom right, or Ctrl+Enter)'],
        ...(voice
          ? [['🎤 voice', 'speak instead (top right); the text lands in the box'] as const]
          : []),
        'By default Submit only types and presses no key; ▶ app, further down, sets one.',
        'Hold Submit to send once without that key.',
      ],
    },
    {
      target: 'gestures',
      title: 'The same gestures from the phone',
      lines: [
        ['▼ dn  ▲ up', 'swipe down / up'],
        ['● tap', 'tap'],
        ['●● dbl', 'double-tap: opens the menu on the glasses'],
        ['font − / +', 'smaller / bigger text in the window'],
      ],
    },
    {
      target: 'tools',
      title: 'More controls',
      lines: [
        ['keys', 'a keyboard under this row'],
        ['vRing', 'the whole screen as a ring'],
        ['vPad', 'the whole screen as a trackpad'],
        'The next three cards open each of them.',
        ['inv', 'flip dark and light, for bright apps'],
        ['color', 'preview in desktop colours, or green as the lens shows it'],
        ['lens', 'pause the glasses to save battery'],
      ],
    },
    {
      target: null,
      demo: 'keys',
      title: 'keys: a keyboard',
      lines: [
        'For keys the phone keyboard does not have: Esc, Tab, arrows, F-keys.',
        ['Ctrl  Alt', 'arm one, and the next key or tap carries it'],
        'For a whole line of text, the text box is faster.',
      ],
    },
    {
      target: null,
      demo: 'vring',
      cardAt: 0.56,
      title: 'vRing: the screen as a ring',
      lines: [
        ['swipe', 'up / down, anywhere: the Up / Down key'],
        ['left half', 'tap'],
        ['right half', 'double-tap, which opens the menu'],
        ...(voice ? [['bottom band', 'long press: voice input'] as const] : []),
        '✕ at the top right closes it.',
      ],
    },
    {
      target: null,
      demo: 'vpad',
      cardAt: 0.66,
      title: 'vPad: the screen as a trackpad',
      lines: [
        ['drag', 'move the pointer'],
        ['tap', 'click with the button picked at the bottom'],
        ['right edge', 'wheel'],
        '✕ at the top right closes it.',
      ],
    },
    {
      target: 'app',
      title: '▶ app: what Submit and swipes do here',
      lines: [
        'Settings for the application in front, remembered per application.',
        ['submit', 'the key Submit presses after typing: set Enter to run the line'],
        ['swipe', 'the keys a swipe up / down sends'],
        'The ? button at the top brings this tour back.',
      ],
    },
  ]
}

/** One framed area of the overview. */
export interface TourRegion {
  readonly target: TourTarget
  /** The cards that explain it, as shown in its badge: `3`, `1–2`, `4–7`. */
  readonly label: string
}

/** Pure: which area each card belongs to, for the overview. A card counts where its spotlight
 *  is, a figure where it is laid, a demo where its button is. Areas come in card order. */
export function tourRegions(cards: readonly TourCard[]): TourRegion[] {
  const by = new Map<TourTarget, number[]>()
  cards.forEach((c, i) => {
    const t = c.target ?? c.figureAt ?? (c.demo ? DEMO_REGION[c.demo] : null)
    if (!t) return
    by.set(t, [...(by.get(t) ?? []), i + 1])
  })
  return [...by].map(([target, ns]) => {
    const first = ns[0] ?? 0
    const last = ns[ns.length - 1] ?? first
    const run = last - first === ns.length - 1
    return {
      target,
      label: ns.length === 1 ? String(first) : run ? `${first}–${last}` : ns.join('·'),
    }
  })
}

// ── the gestures figure ────────────────────────────────────────────────────────────────────

/** Pure: a schematic of where the gestures are made, as SVG markup in the mirror's 2:1 box.
 *  The G2 from its right side, front (lens) to the right: the thin temple is only a support;
 *  the touch pad sits on the tip that bends down behind the ear, and a swipe runs along that
 *  tip — back and down (towards the back of the head) is Down, forward and up is Up. Beside it
 *  the R1 ring. Line art traced from the product's proportions in the UI's own colours, not a
 *  product picture. */
export function gestureFigureSvg(): string {
  const hot = '#ffb070'
  const ink = '#cfcfcf'
  const dim = '#6a6a6a'
  // The tap point is white in the drawing and in its label, so the label names the dot.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 288" width="100%" height="100%" font-family="system-ui,sans-serif" role="img" aria-label="Touch areas: the pad on each temple tip behind the ear, and the ring">
<rect x="0" y="0" width="576" height="288" fill="#101010"/>
<!-- G2, right side: front frame and nose pad at the right, hinge block, straight temple, tip bent down behind the ear -->
<path d="M420 53 L441 51 Q447 52 445 58 L427 75 L425 162 Q424 170 417 169 L412 168 Q409 167 409 162 L412 92 Z" fill="none" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>
<ellipse cx="402" cy="118" rx="4" ry="7" fill="none" stroke="${dim}" stroke-width="2"/>
<rect x="376" y="72" width="44" height="24" rx="6" fill="#101010" stroke="${ink}" stroke-width="3"/>
<path d="M375 84 L150 84 Q129 84.5 96 104" fill="none" stroke="${ink}" stroke-width="8" stroke-linecap="round"/>
<g transform="translate(60 116) rotate(-25.5)">
<rect x="-37.5" y="-16.5" width="75" height="33" rx="14" fill="#101010" stroke="${ink}" stroke-width="3"/>
<rect x="-31" y="-9" width="46" height="18" rx="8" fill="${hot}" fill-opacity=".35" stroke="${hot}" stroke-width="2"/>
<circle cx="-8" cy="0" r="5" fill="#fff"/>
</g>
<path d="M38 162 L110 128" stroke="${hot}" stroke-width="3" marker-start="url(#a)" marker-end="url(#a)"/>
<text x="14" y="190" fill="${hot}" font-size="15">▼ down</text>
<text x="120" y="128" fill="${hot}" font-size="15">▲ up</text>
<text x="92" y="168" fill="${hot}" font-size="15">swipe along the pad</text>
<text x="14" y="78" fill="${hot}" font-size="15">tap <tspan fill="#fff">●</tspan></text>
<text x="230" y="232" fill="${ink}" font-size="17" text-anchor="middle">G2: pad behind either ear</text>
<text x="417" y="190" fill="${dim}" font-size="13" text-anchor="middle">lens</text>
<!-- ring, seen from the side of the finger: band plus the touch pad on top -->
<circle cx="515" cy="128" r="38" fill="none" stroke="${dim}" stroke-width="12"/>
<path d="M488 101 A38 38 0 0 1 542 101" fill="none" stroke="${hot}" stroke-width="12" stroke-opacity=".55" stroke-linecap="round"/>
<path d="M475 88 A56 56 0 0 1 555 88" fill="none" stroke="${hot}" stroke-width="3" marker-start="url(#a)" marker-end="url(#a)"/>
<circle cx="515" cy="90" r="5" fill="#fff"/>
<text x="515" y="58" fill="${hot}" font-size="15" text-anchor="middle">swipe</text>
<text x="515" y="134" fill="${hot}" font-size="15" text-anchor="middle">tap <tspan fill="#fff">●</tspan></text>
<text x="515" y="232" fill="${ink}" font-size="17" text-anchor="middle">R1 ring</text>
<defs><marker id="a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${hot}"/></marker></defs>
</svg>`
}

// ── first run ──────────────────────────────────────────────────────────────────────────────

const SEEN_KEY = 'ew.tour.seen'

/** `?tour=1` opens it at boot regardless, `?tour=0` keeps it shut (a verification run that
 *  drives the phone UI by coordinates). Not persisted: a query only steers this load. */
export function tourQuery(search: string): 'open' | 'never' | null {
  const v = new URLSearchParams(search).get('tour')
  if (v === '1') return 'open'
  if (v === '0') return 'never'
  return null
}

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    // No storage: say seen, or the tour would open on every launch.
    return true
  }
}

function markSeen(): void {
  keep(SEEN_KEY, '1')
}

/** Considered once per page load: health answers again on every stream reconnect. */
let firstRunConsidered = false

/** Open the tour on a device that has never closed it. Called when the server first answers
 *  `GET /api/health`: by then the UI works (a tour over a broken connection would explain
 *  controls that do nothing) and it is known whether voice exists. */
export function maybeOpenTourOnFirstRun(voice: boolean): void {
  if (firstRunConsidered) return
  firstRunConsidered = true
  let q: 'open' | 'never' | null = null
  try {
    q = tourQuery(location.search)
  } catch {
    // no location
  }
  if (q === 'never') return
  if (q !== 'open' && seen()) return
  openTour(voice, q === 'open' ? 'query' : 'first run')
}

// ── the overlay ────────────────────────────────────────────────────────────────────────────

/** Per target, its holes; each hole is the union of one or more elements. */
const targets = new Map<TourTarget, readonly (readonly HTMLElement[])[]>()

/** `mountUi` names what each card spotlights. Each argument is one hole; an array is one hole
 *  around its elements' union (the three palette openers). Two arguments are two holes (the
 *  Submit row and `▶ app`, with the button rows between them left dim). */
export function registerTourTarget(t: TourTarget, ...holes: (HTMLElement | HTMLElement[])[]): void {
  targets.set(
    t,
    holes.map(h => (Array.isArray(h) ? h : [h])),
  )
}

/** What `mountUi` gives the tour for one demo. `open` returns the element to spotlight, or
 *  null for a surface that covers the screen; `close` puts things back as they were. */
export interface TourDemoHooks {
  open(): HTMLElement | null
  close(): void
}
const demos = new Map<TourDemo, TourDemoHooks>()
export function registerTourDemo(d: TourDemo, hooks: TourDemoHooks): void {
  demos.set(d, hooks)
}

/** Below the pairing and server-guard screens and the toast; level with vRing / vPad. Those
 *  are opened by a demo card, so the layer is moved to the end of the body after each opens:
 *  at an equal z-index the later element is on top, and takes the touches. */
const TOUR_Z = 9999
/** The card's frame colour. */
const CARD_EDGE = '#a78bfa'
/** Space between the element and the edge of the hole. */
const HOLE_PAD = 6

let root: HTMLElement | null = null
let teardown: (() => void) | null = null

export function tourOpen(): boolean {
  return root !== null
}

/** Pure: where the card goes, given the hole and the viewport. Below the hole when it fits,
 *  else above, else pinned to whichever side has more room (the card then overlaps the hole,
 *  which is still visible around it). Returns the card's `top` in px. */
export function cardTop(
  hole: { top: number; bottom: number } | null,
  cardH: number,
  viewH: number,
  margin = 12,
): number {
  if (!hole) return Math.max(margin, (viewH - cardH) / 2)
  if (viewH - hole.bottom >= cardH + 2 * margin) return hole.bottom + margin
  if (hole.top >= cardH + 2 * margin) return hole.top - margin - cardH
  return viewH - hole.bottom >= hole.top ? viewH - margin - cardH : margin
}

export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Pure: the dim layer's clip path — the viewport minus each hole, as rounded rectangles under
 *  the even-odd rule. */
export function dimPath(w: number, h: number, holes: readonly Box[], r = 8): string {
  const n = (v: number): string => String(Math.round(v * 10) / 10)
  let d = `M0 0H${n(w)}V${n(h)}H0Z`
  for (const b of holes) {
    const k = Math.min(r, b.width / 2, b.height / 2)
    const x0 = b.left
    const y0 = b.top
    const x1 = b.left + b.width
    const y1 = b.top + b.height
    d +=
      ` M${n(x0 + k)} ${n(y0)}H${n(x1 - k)}A${n(k)} ${n(k)} 0 0 1 ${n(x1)} ${n(y0 + k)}` +
      `V${n(y1 - k)}A${n(k)} ${n(k)} 0 0 1 ${n(x1 - k)} ${n(y1)}` +
      `H${n(x0 + k)}A${n(k)} ${n(k)} 0 0 1 ${n(x0)} ${n(y1 - k)}` +
      `V${n(y0 + k)}A${n(k)} ${n(k)} 0 0 1 ${n(x0 + k)} ${n(y0)}Z`
  }
  return `path(evenodd, '${d}')`
}

function unionRect(els: readonly HTMLElement[]): DOMRect | null {
  let r: { l: number; t: number; r: number; b: number } | null = null
  for (const el of els) {
    const b = el.getBoundingClientRect()
    if (b.width === 0 && b.height === 0) continue // hidden (the voice button, a closed fold)
    r = r
      ? {
          l: Math.min(r.l, b.left),
          t: Math.min(r.t, b.top),
          r: Math.max(r.r, b.right),
          b: Math.max(r.b, b.bottom),
        }
      : { l: b.left, t: b.top, r: b.right, b: b.bottom }
  }
  return r ? new DOMRect(r.l, r.t, r.r - r.l, r.b - r.t) : null
}

export function closeTour(how: string): void {
  if (!root) return
  markSeen()
  teardown?.()
  teardown = null
  root.remove()
  root = null
  log(`tour closed (${how})`)
}

export function openTour(voice: boolean, why: string): void {
  if (typeof document === 'undefined') return
  if (root) closeTour('reopened')
  const cards = tourCards(voice)
  const regions = tourRegions(cards)
  /** -1 is the overview; 0.. are the cards. */
  let at = -1
  /** The demo that is open, and what it gave us to spotlight. */
  let demo: TourDemo | null = null
  let demoEl: HTMLElement | null = null
  log(`tour opened (${why}) — overview + ${String(cards.length)} cards`)

  const layer = document.createElement('div')
  layer.setAttribute('role', 'dialog')
  layer.setAttribute('aria-modal', 'true')
  layer.setAttribute('aria-labelledby', 'ew-tour-title')
  // The layer itself is transparent and takes every touch; `dim` is the darkening, with the
  // holes clipped out of it, and `rings` outline each hole.
  layer.style.cssText = `position:fixed;inset:0;z-index:${String(TOUR_Z)};touch-action:none`
  const dim = document.createElement('div')
  dim.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.74);pointer-events:none'
  const rings = document.createElement('div')
  // The drawing a card may lay over a target's box (`figureAt`). Built once; shown per card.
  const figure = document.createElement('div')
  figure.style.cssText =
    'position:fixed;display:none;pointer-events:none;box-sizing:border-box;' +
    'border:1px solid #555;border-radius:8px;overflow:hidden;background:#101010'
  figure.innerHTML = gestureFigureSvg()
  const card = document.createElement('div')
  card.style.cssText =
    'position:fixed;left:12px;right:12px;max-width:480px;margin:0 auto;box-sizing:border-box;' +
    // The purple frame marks the card as the tour's own: over an undimmed screen (the overview,
    // an opened pad) a grey-bordered card reads as one more panel of the UI. Orange is taken by
    // the frames around what is explained, blue by the pads' own text.
    `background:#1c1c1c;color:#E5E5E5;border:2px solid ${CARD_EDGE};border-radius:10px;` +
    'padding:12px 14px;font:14px/1.45 system-ui;' +
    `box-shadow:0 0 0 3px ${CARD_EDGE}40,0 6px 18px rgba(0,0,0,.6)`
  layer.append(dim, rings, figure, card)

  const step = document.createElement('div')
  step.style.cssText = 'font:11px system-ui;opacity:.6;margin-bottom:2px'
  const title = document.createElement('h2')
  title.id = 'ew-tour-title'
  title.style.cssText = 'font-size:16px;margin:0 0 6px'
  const body = document.createElement('div')
  const nav = document.createElement('div')
  nav.style.cssText = 'display:flex;gap:6px;margin-top:10px;align-items:center'
  const skip = button('skip', () => {
    closeTour('skip')
  })
  const spacer = document.createElement('span')
  spacer.style.flex = '1'
  const back = button('back', () => {
    go(at - 1)
  })
  const next = button('next', () => {
    if (at === cards.length - 1) closeTour('done')
    else go(at + 1)
  })
  // Every touch ends here: a demo surface under the layer must not see it.
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove'])
    layer.addEventListener(ev, e => e.stopPropagation())
  nav.append(skip, spacer, back, next)
  card.append(step, title, body, nav)

  /** The holes of the current page, each with the badge the overview puts on it. */
  const groups = (): readonly { els: readonly HTMLElement[]; badge: string }[] => {
    if (at < 0) {
      return regions.flatMap(r =>
        (targets.get(r.target) ?? []).map(els => ({ els, badge: r.label })),
      )
    }
    const c = cards[at]
    const t = c?.target ?? (demoEl && c?.demo ? DEMO_REGION[c.demo] : null)
    const own = t ? (targets.get(t) ?? []) : []
    return [...own, ...(demoEl ? [[demoEl]] : [])].map(els => ({ els, badge: '' }))
  }
  /** Open the card's demo and close the one before it. */
  const setDemo = (d: TourDemo | undefined): void => {
    if (demo === (d ?? null)) return
    if (demo) demos.get(demo)?.close()
    demo = d ?? null
    demoEl = d ? (demos.get(d)?.open() ?? null) : null
    // Whatever just opened was appended after us; go back on top of it.
    if (d) document.body.appendChild(layer)
  }
  /** The box the card's figure covers, or null when it has none. */
  const figureBox = (): Box | null => {
    const t = cards[at]?.figureAt
    const els = t ? (targets.get(t) ?? []).flat() : []
    const r = els.length > 0 ? unionRect(els) : null
    return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null
  }

  /** Cut the holes over the targets and put the card beside them. Re-run on scroll and
   *  resize. */
  const place = (): void => {
    const holes: (Box & { badge: string })[] = []
    for (const g of groups()) {
      const r = unionRect(g.els)
      if (!r) continue // hidden
      holes.push({
        left: r.left - HOLE_PAD,
        top: r.top - HOLE_PAD,
        width: r.width + 2 * HOLE_PAD,
        height: r.height + 2 * HOLE_PAD,
        badge: g.badge,
      })
    }
    const viewW = window.innerWidth
    const viewH = window.innerHeight
    // The overview and a full-screen demo show the screen as it is; a card dims around its
    // holes.
    const fullDemo = demo !== null && demoEl === null
    dim.style.display = at < 0 || fullDemo ? 'none' : ''
    dim.style.clipPath = dimPath(viewW, viewH, holes)
    const ringOf = (b: Box): HTMLElement => {
      const ring = document.createElement('div')
      ring.style.cssText =
        'position:fixed;box-sizing:border-box;border:2px solid #ffb070;border-radius:8px;' +
        `pointer-events:none;left:${String(b.left)}px;top:${String(b.top)}px;` +
        `width:${String(b.width)}px;height:${String(b.height)}px`
      return ring
    }
    // Astride the top edge at the right end: the rows are filled from the left, so this is
    // where a badge covers the least of what it numbers. After every frame, so that the frame
    // of the row above does not run through it.
    const badgeOf = (b: Box & { badge: string }): HTMLElement => {
      const badge = document.createElement('div')
      badge.style.cssText =
        'position:fixed;padding:0 8px;border-radius:9px;pointer-events:none;' +
        'background:#ffb070;color:#1c1c1c;font:700 12px/18px system-ui;white-space:nowrap;' +
        `right:${String(viewW - (b.left + b.width) + 10)}px;top:${String(b.top - 9)}px`
      badge.textContent = b.badge
      return badge
    }
    rings.replaceChildren(...holes.map(ringOf), ...holes.filter(b => b.badge).map(badgeOf))
    const fig = figureBox()
    figure.style.display = fig ? '' : 'none'
    if (fig) {
      figure.style.left = `${String(fig.left)}px`
      figure.style.top = `${String(fig.top)}px`
      figure.style.width = `${String(fig.width)}px`
      figure.style.height = `${String(fig.height)}px`
    }
    // The card keeps clear of all of them, figure included: it is placed against their
    // combined extent.
    const boxes = fig ? [...holes, fig] : holes
    const span =
      boxes.length > 0
        ? {
            top: Math.min(...boxes.map(b => b.top)),
            bottom: Math.max(...boxes.map(b => b.top + b.height)),
          }
        : null
    const frac = fullDemo ? cards[at]?.cardAt : undefined
    card.style.top =
      frac === undefined
        ? `${String(cardTop(span, card.offsetHeight, viewH))}px`
        : `${String(Math.max(12, Math.min(viewH * frac, viewH - card.offsetHeight - 12)))}px`
  }

  const go = (i: number): void => {
    at = Math.max(-1, Math.min(cards.length - 1, i))
    const c = cards[at]
    setDemo(c?.demo)
    step.textContent = c ? `${String(at + 1)} / ${String(cards.length)}` : 'tour'
    title.textContent = c ? c.title : 'The screen at a glance'
    const lines: readonly TourLine[] = c
      ? c.lines
      : [
          `The numbers are the ${String(cards.length)} cards of this tour, in order.`,
          'Each framed area is explained by the cards on its badge.',
        ]
    body.replaceChildren(...lines.map(renderLine))
    back.style.visibility = at < 0 ? 'hidden' : 'visible'
    next.textContent = at === cards.length - 1 ? 'done' : at < 0 ? 'start' : 'next'
    // Bring the target on screen first; the column scrolls inside `#app`. A demo's own element
    // comes before the row its button is in: it is what the card is about.
    const first =
      demoEl ?? groups()[0]?.els[0] ?? (c?.figureAt ? targets.get(c.figureAt)?.[0]?.[0] : undefined)
    first?.scrollIntoView({ block: 'nearest' })
    place()
    requestAnimationFrame(place) // after the scroll has landed
  }

  const onKey = (e: KeyboardEvent): void => {
    // A switch, not an if-chain: only these keys are the tour's.
    switch (e.key) {
      case 'Escape':
        closeTour('Escape')
        break
      case 'ArrowRight':
      case 'Enter':
        next.click()
        break
      case 'ArrowLeft':
        go(at - 1)
        break
      default:
        return
    }
    // Handled here only: a hardware key must not also reach the mirrored window.
    e.preventDefault()
    e.stopPropagation()
  }
  const onMove = (): void => {
    place()
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', onMove)
  window.addEventListener('scroll', onMove, true)
  teardown = () => {
    setDemo(undefined)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', onMove)
    window.removeEventListener('scroll', onMove, true)
  }

  document.body.appendChild(layer)
  root = layer
  go(-1)
}

function renderLine(l: TourLine): HTMLElement {
  const row = document.createElement('div')
  if (typeof l === 'string') {
    row.style.cssText = 'margin:4px 0'
    row.textContent = l
    return row
  }
  row.style.cssText = 'display:flex;gap:10px;margin:3px 0'
  const k = document.createElement('span')
  k.style.cssText = 'flex:0 0 6.5em;font-weight:600;color:#ffd9b0'
  k.textContent = l[0]
  const v = document.createElement('span')
  v.style.cssText = 'flex:1;min-width:0'
  v.textContent = l[1]
  row.append(k, v)
  return row
}
