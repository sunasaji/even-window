// pinhole-window — entering and leaving the server list (the root), and its gestures.
//
// At the list nothing is mirrored and no request goes to a server. A tap opens the server under
// the cursor; a double-tap leaves the app through the system dialog, as Even Hub requires of the
// top of an app. Inside a server `Disconnect` in the menu comes back here
// (docs/decisions/root-is-the-server-list.md).

import { log } from './debugLog.ts'
import { setPairingPrompted } from './main.ts'
import { closeMenu, exitApp, menuOpen } from './menu.ts'
import { maybeShowStartupHint, syncOverlay } from './overlay.ts'
import { renderRootPanel } from './phoneUi.ts'
import { SERVER, setAuthState, switchServer } from './serverLink.ts'
import { setStatus } from './statusUi.ts'
import { resetStreamState, stopStream } from './stream.ts'
import { moveRoot, rootOpen, rootSel, setRootOpen, setRootSel, targetList } from './targets.ts'
import { forgetTiles } from './tiles.ts'
import { voiceActive, voiceCancel } from './voice.ts'

/** The status line at the list. */
export const ROOT_STATUS = 'not connected — choose a server'

/** Pure: does this page load start at the list? A URL that names a server or carries a pairing
 *  code is a request for that server, so it opens directly (the simulator harness, a pairing
 *  link). The packaged app has no query and always starts at the list. */
export function startsAtRoot(search: string): boolean {
  let q: URLSearchParams
  try {
    q = new URLSearchParams(search)
  } catch {
    return true
  }
  return !q.get('server')?.trim() && !q.get('pair')?.trim()
}

/** Leave the open server and show the list. */
export function enterRoot(why: string): void {
  if (rootOpen) return
  log(`root: disconnecting from ${SERVER} (${why})`)
  if (voiceActive()) voiceCancel('disconnect')
  if (menuOpen) closeMenu()
  stopStream()
  resetStreamState()
  // The picture belongs to the server being left. The lens is blanked under the list; with
  // the cache gone it stays black until the next server sends its own.
  forgetTiles()
  setRootOpen(true)
  setRootSel(targetList().indexOf(SERVER))
  // No server, so no auth state: this also clears a setup notice.
  setAuthState('unknown')
  setStatus(ROOT_STATUS)
  renderRootPanel()
  syncOverlay()
}

/** Open a server from the list. */
export function openTarget(server: string): void {
  log(`root: opening ${server}`)
  switchServer(server) // leaves the root: `rootLeft` below
}

/** Called by `switchServer` when a connection was started from the list, whoever asked for it:
 *  a tap on the glasses, a row on the phone, an address typed, a pairing URL pasted. */
export function rootLeft(): void {
  // The dialog is latched once per page load; a server opened later must be able to ask again.
  setPairingPrompted(false)
  // The gestures only mean something inside a server, so the hint waits for the first one.
  maybeShowStartupHint()
  renderRootPanel()
  syncOverlay()
}

/** A gesture while the list is up. */
export function rootGesture(g: 'tap' | 'double' | 'up' | 'down'): void {
  if (g === 'double') {
    log('root: double — leaving the app (system dialog)')
    void exitApp()
    return
  }
  const list = targetList()
  if (g === 'tap') {
    const server = list[rootSel]
    if (server) openTarget(server)
    else log('root: tap — no server in the list')
    return
  }
  moveRoot(g === 'up' ? -1 : 1)
  renderRootPanel()
  syncOverlay()
}
