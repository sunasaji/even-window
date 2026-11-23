// even-window — the stored settings: mirror mode, invert, natural scroll.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { log } from './debugLog.ts'
import {
  effectiveMirrorMode,
  flagSource,
  type MirrorMode,
  noteFlag,
  parseFlag,
  parseMirrorMode,
} from './flags.ts'
import { glassLinkUp } from './glassPage.ts'
import { lensLabel, mirrorPaused, pumpLive, syncOverlay } from './overlay.ts'
import { lensBtn, mirrorBtn } from './phoneUi.ts'
import { refreshGrey, repaintMirror } from './tiles.ts'

// Polarity. The glasses are optical see-through: black emits nothing and is transparent, so a
// light-background window lights the whole lens. The flip happens in the client's index→grey
// stage: one subtraction per pixel, no server re-encode, and neither the capture nor the server's
// tile diff is disturbed. Resolution: `?invert=1` → localStorage → off; the winner is persisted.

const INVERT_KEY = 'ew.invert'

const MIRROR_KEY = 'ew.mirror'
/** What the user picked: persisted, and the only thing `?mirror=` and the button write. */
export let mirrorChoice: MirrorMode = 'color'
/** What the preview is drawn in. Every draw site reads this one; `applyMirrorMode` is the only
 *  writer. */
export let mirrorMode: MirrorMode = 'color'

export function initMirrorMode(): void {
  let v: MirrorMode | null = null
  try {
    v = parseMirrorMode(new URLSearchParams(location.search).get('mirror'))
  } catch {
    /* no location */
  }
  if (v === null) {
    try {
      v = parseMirrorMode(localStorage.getItem(MIRROR_KEY))
    } catch {
      /* storage blocked */
    }
  }
  mirrorChoice = v ?? 'color'
  try {
    localStorage.setItem(MIRROR_KEY, mirrorChoice)
  } catch {
    /* storage blocked */
  }
  // Through the same path as every later change, so `mirrorMode` has exactly one writer.
  applyMirrorMode()
}
/** Storage key for the two-finger wheel direction, a persisted setting (docs/phone-ui.md). */
const SCROLLNAT_KEY = 'ew.scrollnat'

/** Resolve a boolean setting `?name=` → `localStorage[key]` → `fallback`, persist the winner and
 *  record which source decided. Not for instruments (`stats`, `debug`): those use `queryFlag`. */
function initFlag(name: string, key: string, fallback: boolean): boolean {
  let q: boolean | null = null
  try {
    q = parseFlag(new URLSearchParams(location.search).get(name))
  } catch {
    /* no location */
  }
  let stored: boolean | null = null
  if (q === null) {
    try {
      stored = parseFlag(localStorage.getItem(key))
    } catch {
      /* storage blocked */
    }
  }
  const on = q ?? stored ?? fallback
  noteFlag(name, flagSource(q !== null, stored !== null), on ? 'on' : 'off')
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* storage blocked */
  }
  return on
}

export let invert = false

export function initInvert(): void {
  invert = initFlag('invert', INVERT_KEY, false)
}

/** `true` = "natural": the fingers push the content (fingers up = wheel down). `false` = the
 *  fingers drive the wheel (fingers up = wheel up), as X11 and Windows do. Natural is the default
 *  because the surface is a phone; a stored value still wins (`initFlag`). */
export let padScrollNatural = true
export function setPadScrollNatural(v: boolean): void {
  padScrollNatural = v
}

export function initScrollNatural(): void {
  padScrollNatural = initFlag('scrollnat', SCROLLNAT_KEY, true)
}

/** The label is the mapping itself (`2f↑=wheel↑`), because both camps call their own convention
 *  "natural". */
export function scrollNatLabel(natural: boolean): string {
  return `2f↑=wheel${natural ? '↓' : '↑'}`
}

/** Which way the wheel turns for a given finger travel. The caller must drain its accumulator in
 *  the direction the fingers went, not the wheel direction: under the inverted setting that
 *  pushes the accumulator away from zero on every notch and the drain loop runs away. */
export function twoFingerWheelDir(accum: number, natural: boolean): -1 | 1 {
  return accum < 0 !== natural ? -1 : 1
}

export function persistScrollNatural(): void {
  try {
    localStorage.setItem(SCROLLNAT_KEY, padScrollNatural ? '1' : '0')
  } catch {
    /* storage blocked */
  }
}

function persistInvert(): void {
  try {
    localStorage.setItem(INVERT_KEY, invert ? '1' : '0')
  } catch {
    /* storage blocked */
  }
}

// The invert toggle. Flipping re-derives the four cached tiles, but everything on the glass was
// derived with the old polarity, and a quadrant whose source did not change would diff byte-equal
// against `lastTiles` and never be re-pushed. So the flip goes through `syncOverlay()`, the same
// path as the overlay hide transition: baseline reset and repaint through the one pump,
// serialised on `overlayTxn`. No `rebuildPageContainer` on this path (docs/glasses.md).
//
// While the menu or a notice is up the transition is a show: the pump stays frozen, and closing
// the menu repaints with the new polarity. Blank is grey 0 regardless of polarity; an "inverted
// blank" would light the whole lens.
export function setInvert(on: boolean): void {
  if (invert === on) return
  invert = on
  persistInvert()
  log(`invert ${on ? 'on' : 'off'}`)
  refreshGrey()
  syncOverlay()
}

/** The effective mode, not the stored choice: while the link is down they differ, and this is the
 *  one the user sees on the canvas. */
export function mirrorLabel(): string {
  return `${mirrorMode}`
}
export const MIRROR_HINT =
  "preview in the server's colours, or as the lens will show it — 16 grey " +
  "levels in the panel's green. Colour is cheaper and more legible; green is the only way to " +
  'judge polarity and contrast without putting the glasses on (and the only mode `invert` shows in)'
const MIRROR_HINT_DOWN =
  'the preview is stuck in colour while the frame pump is standing down: ' +
  'green is derived inside it. Your choice is remembered and comes back when the pump does.'

/** Flip the mirror between the server's colours and the lens simulation, and persist it. */
export function setMirrorMode(m: MirrorMode): void {
  if (m === mirrorChoice) return
  mirrorChoice = m
  try {
    localStorage.setItem(MIRROR_KEY, m)
  } catch {
    /* storage blocked */
  }
  log(`mirror: ${m}`)
  applyMirrorMode()
}

/** Recompute the effective mode from the choice and the link, repaint if it moved, and update the
 *  button. Called by the chooser and by `setGlassLink`, so the mode follows the link both ways. */
export function applyMirrorMode(): void {
  if (lensBtn) lensBtn.textContent = lensLabel()
  const live = pumpLive()
  const next = effectiveMirrorMode(mirrorChoice, live)
  const moved = next !== mirrorMode
  mirrorMode = next
  if (mirrorBtn) {
    mirrorBtn.textContent = mirrorLabel()
    // Disabled rather than hidden: a control that vanishes reads as a bug, and the title is the
    // only place that can say why.
    mirrorBtn.disabled = !live
    mirrorBtn.title = live
      ? MIRROR_HINT
      : `${MIRROR_HINT_DOWN} (${glassLinkUp ? (mirrorPaused() ?? '') : 'the glasses link is down'})`
  }
  if (moved) repaintMirror()
}
