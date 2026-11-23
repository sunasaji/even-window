// even-window — the phone status line, the connection summary and the mirror preview.
//
// The client modules import each other freely, but only use each other from inside functions:
// nothing here may touch another non-leaf module while this one is still loading.

import { SCREEN_H, SCREEN_W, tileOrigin } from '../shared/geom.ts'
import { PANEL_LINES, wrapGlassLines } from '../shared/voiceDialog.ts'
import { keysAlert } from './clients.ts'
import { established, glassLinkUp } from './glassPage.ts'
import { apps, menuItems, menuOpen, menuPath, menuRowCount, menuSel, windows } from './menu.ts'
import { glassCovered, glassInCase, interactiveOverlay, lensOn, superseded } from './overlay.ts'
import { connDetailsEl, connSumEl, mirrorEl, statusEl } from './phoneUi.ts'
import { authState } from './serverLink.ts'
import { invert } from './settings.ts'
import { availMsg } from './stream.ts'
import { cursor, cursorArrow, cursorTilePixel, repaintMirror, tileFaultTotal } from './tiles.ts'

export function invertLabel(): string {
  return `inv:${invert ? 'on' : 'off'}`
}
let statusText = 'booting'

export function setStatus(s: string): void {
  statusText = s
  renderStatus()
}

/** The `▶ connection` summary line: what a user sees without opening the fold, so it carries
 *  the state that should make someone open it (pairing lives inside).
 *
 *  Self-opening on refusal: `unpaired` means the server demanded auth and we have no identity,
 *  `unauthorized` means our key is not trusted. Both need the human. It never closes itself. */
export function renderConnSummary(): void {
  if (!connSumEl) return
  const needs = authState === 'unpaired' || authState === 'unauthorized'
  // A key appeared that this device did not acknowledge. Ranked above the auth states and shown
  // in red: it is the one that has to be read. Like the auth states it only ever opens the fold.
  const keysNew = keysAlert.added.length
  connSumEl.textContent = keysNew
    ? `connection — ⚠ ${keysNew} NEW enrolled key${keysNew > 1 ? 's' : ''}: open to check`
    : authState === 'unpaired'
      ? 'connection — ⚠ not paired yet: open to pair'
      : // Not a stale token: the client re-establishes once on a 401 first. `unauthorized`
        // means this device's key is not in the registry the server reads: revoked, or the
        // server was started against a different EW_STATE_DIR.
        authState === 'unauthorized'
        ? "connection — ⚠ this device's key is not enrolled: open to re-pair"
        : authState === 'offline'
          ? 'connection — ⚠ server unreachable'
          : 'connection'
  connSumEl.style.color = keysNew ? '#ff6b57' : needs || authState === 'offline' ? '#ffb46e' : ''
  if ((needs || keysNew > 0) && connDetailsEl && !connDetailsEl.open) connDetailsEl.open = true
}

export function renderStatus(): void {
  renderConnSummary()
  if (!statusEl) return
  const bits = [
    `page=${established ? 'established' : 'no'}`,
    `win=${windows.length}`,
    // How many are launchable, and how many of them made the curated glasses slots.
    `apps=${apps.length}/${menuItems.filter(it => it.kind === 'app').length}`,
    // Where the cursor is while one of our surfaces is up, plus the level path — the one piece
    // of menu state that is otherwise invisible from the phone.
    menuOpen
      ? `menu=${menuPath.length ? `${menuPath.map(p => p.id).join('/')} ` : ''}${menuSel + 1}/${menuRowCount()}`
      : 'menu=closed',
    availMsg !== null ? 'X=down' : 'X=ok',
    `invert=${invert ? 'on' : 'off'}`,
    // Only when true: it answers "the pump is down and I cannot see why".
    ...(glassCovered ? ['glass=covered'] : []),
    // Same rule. This one also explains why the mirror button went grey (`applyMirrorMode`).
    ...(glassLinkUp ? [] : ['glass=down']),
    ...(lensOn ? [] : ['lens=off']),
    ...(glassInCase ? ['glass=in-case'] : []),
    // Only when something on the tile path has thrown; otherwise the mirror just stops
    // updating, which reads as a dead link.
    ...(tileFaultTotal ? [`tilefail=${String(tileFaultTotal)}`] : []),
    ...(superseded ? ['SUPERSEDED'] : []),
    `auth=${authState}`,
  ]
  // Two lines: `statusText` is the live narrative and the bits are the standing state, which
  // must stay visible on a phone-width line.
  statusEl.textContent = `${statusText}\n${bits.join(' | ')}`
}

// ── the lens text, copied onto the preview (docs/phone-ui.md) ───────────────────────────────
//
// The menu and the voice dialog are text in container 6; the preview draws only tiles, so the
// phone copies that text while either is up.
//
// An approximation, labelled as one in the corner. The string is the one container 6 is sent
// (`interactiveOverlay`); the firmware's bitmap font is not available here. Lines are folded by
// the same width model that budgets the dialog (`wrapGlassLines`), so a break can be a few
// narrow glyphs off. Nothing is sent from this copy.
//
// Only the two surfaces a person acts on: `X unavailable` and `mirror paused` stay lens-only,
// because the preview keeps working while the lens is paused.

/** The text on the preview, or null when it is showing tiles. Read by `drawMirror`. */
export let previewText: string | null = null

/** One row of container 6: 288 px over the ten lines the panel shows. */
const PREVIEW_LINE_PX = SCREEN_H / PANEL_LINES
/** Sized so ASCII rows run at about the lens font's width. CJK comes out ~15% narrower than
 *  the lens's 28 per line, which is harmless: the breaks come from the width model, not this
 *  font. */
const PREVIEW_FONT = '17px system-ui, -apple-system, "Hiragino Sans", sans-serif'
/** Lens green — what the glasses draw text in — in both preview modes. */
const PREVIEW_TEXT_COLOUR = '#3f3'

/** Called from `syncOverlay`, which every overlay change goes through. */
export function syncPreviewOverlay(): void {
  const next = interactiveOverlay()
  if (next === previewText) return
  const was = previewText
  previewText = next
  if (next !== null) drawPreviewOverlay(next)
  else if (was !== null) repaintMirror() // the tiles come back from the cache
}

function drawPreviewOverlay(text: string): void {
  if (!mirrorEl) return
  const ctx = mirrorEl.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
  ctx.font = PREVIEW_FONT
  ctx.fillStyle = PREVIEW_TEXT_COLOUR
  ctx.textBaseline = 'middle'
  // The panel clips at its bottom edge and does not scroll, so neither does this.
  wrapGlassLines(text)
    .slice(0, PANEL_LINES)
    .forEach((line, k) => {
      const y = (k + 0.5) * PREVIEW_LINE_PX
      const w = ctx.measureText(line).width
      if (w <= SCREEN_W) {
        ctx.fillText(line, 0, y)
        return
      }
      // The phone's font ran wider than the lens's on this line: squeeze it rather than clip
      // it, because the break is the model's and the content must stay whole.
      ctx.save()
      ctx.translate(0, y)
      ctx.scale(SCREEN_W / w, 1)
      ctx.fillText(line, 0, 0)
      ctx.restore()
    })
  ctx.font = '11px ui-monospace, monospace'
  ctx.fillStyle = '#777'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText('≈ lens text', SCREEN_W - 4, SCREEN_H - 2)
  ctx.restore()
}

/** Phone-side mirror of what the glasses are showing: tile `i`'s preview plane, plus the
 *  synthetic cursor. The cursor is drawn with path ops rather than read back off the tile, at
 *  the pixel `cursorTilePixel` gives, so the preview and the lens agree on where it is.
 *
 *  `data` is the shared `mirrorData` plane, valid only until the next derive; `putImageData`
 *  copies synchronously. */
export function drawMirror(i: number, data: ImageData): void {
  if (!mirrorEl) return
  // The menu or the voice dialog is on the preview and a tile must not paint over it (the
  // lens has no tiles under its text either). `syncPreviewOverlay` repaints from the cache on
  // close.
  if (previewText !== null) return
  const ctx = mirrorEl.getContext('2d')
  if (!ctx) return
  const [x, y] = tileOrigin(i)
  ctx.putImageData(data, x, y)
  if (!cursor.shown) return
  // The same pixel the lens gets (see `cursorTilePixel`): the user steers by this preview.
  const at = cursorTilePixel(cursor.x, cursor.y, i)
  if (!at) return
  ctx.save()
  ctx.translate(x + at[0], y + at[1])
  ctx.lineWidth = 2
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#000'
  ctx.stroke(cursorArrow())
  ctx.fillStyle = '#0f0'
  ctx.fill(cursorArrow())
  ctx.restore()
}
