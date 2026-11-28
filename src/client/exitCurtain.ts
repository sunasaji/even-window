// pinhole-window — the phone stands aside while the glasses ask whether to close the app.
//
// A double-tap at the server list calls `shutDownPageContainer(1)`, and the system answers
// with its own dialog on the lens. While it is up the glasses' gestures go to that dialog, not
// to the app, but the phone page is still live: a tap there opened a server behind the dialog,
// and the phone's own `dbl` asked to close a second time. So the page is covered until the
// dialog goes.
//
// Only this dialog. A foreground layer is announced the same way whatever it is
// (docs/notes/2026-11-context-menu-on-hardware.md), and covering the page for every phone
// notification would interrupt someone typing. The dialog is told apart by timing: it is the
// layer that arrives right after the app asked for it.

import { log } from './debugLog.ts'

/** How long after the request a layer still counts as its dialog. On hardware it arrived 88 ms
 *  and 90 ms later. */
export const EXIT_DIALOG_WINDOW_MS = 2000

/** Pure: is a layer entering at `now` the dialog requested at `askedAt` (0 = none)? */
export function isExitDialog(
  askedAt: number,
  now: number,
  windowMs = EXIT_DIALOG_WINDOW_MS,
): boolean {
  return askedAt > 0 && now >= askedAt && now - askedAt <= windowMs
}

let askedAt = 0
let curtain: HTMLElement | null = null

/** The app has just asked the system to close it. */
export function noteExitAsked(): void {
  askedAt = Date.now()
}

/** A foreground layer entered or left the lens (`setGlassCovered`). */
export function exitCurtainOnLayer(entered: boolean): void {
  if (!entered) {
    hideExitCurtain('the dialog left the lens')
    return
  }
  if (!isExitDialog(askedAt, Date.now())) return
  askedAt = 0
  showExitCurtain()
}

function showExitCurtain(): void {
  if (curtain) return
  log('exit dialog on the lens — the phone page is covered until it is answered')
  try {
    const back = document.createElement('div')
    back.id = 'pw-exit-curtain'
    // Above the page, below the pairing card and the confirm cards: none of them can be up
    // at the server list, and if one ever is, it is an answer to something the user did.
    back.style.cssText =
      'position:fixed;inset:0;z-index:99990;background:#151515cc;color:#e5e5e5;display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;' +
      'box-sizing:border-box;text-align:center;font:15px/1.5 system-ui,sans-serif;' +
      'touch-action:none'
    const head = document.createElement('div')
    head.style.cssText = 'font-weight:600;font-size:17px'
    head.textContent = 'Answer on the glasses'
    const body = document.createElement('div')
    body.style.cssText = 'color:#bdbdbd'
    body.textContent =
      'The glasses are asking whether to close PinholeWindow. This screen is paused until you ' +
      'answer there.'
    // The way out if the "dialog left" event never arrives: without it a lost event would
    // leave the page covered for good.
    const anyway = document.createElement('button')
    anyway.textContent = 'use the phone anyway'
    anyway.style.cssText = 'font:13px system-ui;opacity:.8'
    anyway.addEventListener('click', () => {
      hideExitCurtain('dismissed on the phone')
    })
    // A solid card for the words: on the translucent cover alone they ran into the buttons
    // showing through from behind.
    const card = document.createElement('div')
    card.style.cssText =
      'max-width:340px;background:#232323;border:1px solid #a78bfa;border-radius:10px;' +
      'padding:20px;display:flex;flex-direction:column;align-items:center;gap:12px'
    card.append(head, body, anyway)
    back.append(card)
    document.body.append(back)
    curtain = back
  } catch {
    /* no DOM (tests): the log line above is the record */
  }
}

function hideExitCurtain(why: string): void {
  if (!curtain) return
  curtain.remove()
  curtain = null
  log(`exit dialog curtain off (${why})`)
}
