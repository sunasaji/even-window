// The lens text copied onto the phone preview (docs/phone-ui.md) — the wiring in
// src/client/statusUi.ts and overlay.ts. The wrap model it draws with is pure and tested in
// tests/shared.voiceDialog.test.ts; what is pinned here is the glue, by scanning the source for
// the invariants that would fail without a sound: a tile painting over the copy, a notice that
// must stay lens-only reaching the preview, and a touch landing on the window behind the text.

import { describe, expect, it } from 'vitest'
import { clientSource, type Source } from './helpers/source.ts'

const src = clientSource()
/** Code only — the invariants are also described in comments. (Throws on an unknown name.) */
const body = (name: string): Source => src.fn(name).code()

describe('what is copied', () => {
  it('the copy and the lens share one string: both read interactiveOverlay()', () => {
    expect(body('overlayContent').has('interactiveOverlay()')).toBe(true)
    expect(body('syncPreviewOverlay').has('interactiveOverlay()')).toBe(true)
  })

  it('only the dialog and the menu — the lens notices are not copied', () => {
    const fn = body('interactiveOverlay')
    expect(fn.has('voiceOverlay(voice)')).toBe(true)
    expect(fn.has('if (menuOpen)')).toBe(true)
    expect(fn.has('availMsg')).toBe(false)
    expect(fn.has('mirrorPaused')).toBe(false)
  })

  it('the dialog wins over the menu, on both surfaces', () => {
    const fn = body('interactiveOverlay')
    expect(fn.indexOf('voiceOverlay(voice)')).toBeGreaterThan(-1)
    expect(fn.indexOf('voiceOverlay(voice)')).toBeLessThan(fn.indexOf('if (menuOpen)'))
  })
})

describe('when it is drawn', () => {
  it('every overlay change syncs it: syncOverlay calls syncPreviewOverlay', () => {
    expect(body('syncOverlay').has('syncPreviewOverlay()')).toBe(true)
  })

  it('a tile never paints over it', () => {
    const fn = body('drawMirror')
    expect(fn.has('if (previewText !== null) return')).toBe(true)
    // …and the guard is ahead of the putImageData, not after it.
    expect(fn.indexOf('previewText !== null')).toBeGreaterThan(-1)
    expect(fn.indexOf('previewText !== null')).toBeLessThan(fn.indexOf('putImageData'))
  })

  it('closing it brings the tiles back from the cache', () => {
    expect(body('syncPreviewOverlay').has('repaintMirror()')).toBe(true)
  })

  it('folds with the width model and clips at the panel, like the lens', () => {
    const fn = body('drawPreviewOverlay')
    expect(fn.has('wrapGlassLines(text).slice(0, PANEL_LINES)')).toBe(true)
    expect(fn.has('≈ lens text')).toBe(true) // it says it is an approximation
  })
})

describe('touch', () => {
  it('a touch on the copy does not click the window behind it', () => {
    const down = body('wireMirrorTouch').between(
      "addEventListener('pointerdown'",
      'e.preventDefault()',
    )
    expect(down.has('if (previewText !== null) return')).toBe(true)
  })
})
