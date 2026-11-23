// The voice wiring in src/client/voice.ts.
//
// The dialog's logic is pure and tested in tests/shared.voiceDialog.test.ts; the route is
// tested in tests/server.stt.test.ts. What is left is glue with side effects, which cannot be
// called from here, so it is pinned by scanning the source for the invariants that would break
// silently: a second injection path that does not clear the box, a dialog the gestures reach
// only after the menu, an overlay that draws the menu over the dialog, and a cancel that
// leaves the transcript in the box.

import { describe, expect, it } from 'vitest'
import { clientSource } from './helpers/source.ts'

/** Code only: these invariants are also described in comments, and a scan must not pass on
 *  the sentence that documents a call. */
const code = clientSource().code()

describe('one submit path', () => {
  it('the glasses Send goes through fire(), it does not inject on its own', () => {
    // `voiceSend` must not call the injector directly: `fire()` owns clearing the box and the
    // submit key.
    const fn = code.fn('voiceSend')
    expect(fn.has('fireSubmit?.(')).toBe(true)
    expect(fn.has('submitText(')).toBe(false)
    expect(fn.has('x11Inject(')).toBe(false)
  })

  it('a submit resolves the dialog: pressing Submit declines what the glass is asking', () => {
    const fire = code
      .fn('mountUi')
      .between('const fire = (via: string, bare = false)', "const submit = button('Submit'")
    expect(fire.has('voiceResolve(')).toBe(true)
    // It does not clear the box there: `fire` already emptied it, and clearing is Cancel's job.
    expect(fire.has('voiceCancel(')).toBe(false)
  })

  // Newlines are sent as the app's own line break (docs/phone-ui.md), so `fire` must take the
  // box verbatim.
  it('sends the box as written, newlines and all', () => {
    const fire = code
      .fn('mountUi')
      .between('const fire = (via: string, bare = false)', "const submit = button('Submit'")
    expect(fire.has('const v = text.value')).toBe(true)
    expect(fire.has('flatten')).toBe(false)
    expect(fire.has('.replace(')).toBe(false)
  })
})

describe('the dialog is modal while it is up', () => {
  it('every gesture reaches the dialog before the menu', () => {
    for (const [fn, next] of [
      ['onSwipe', 'if (menuOpen) { moveMenu(dir)'],
      ['onTap', 'if (menuOpen) { await chooseMenu()'],
      ['onDouble', 'if (menuOpen) {'],
    ] as const) {
      // Throws when the function or its menu branch is missing.
      const body = code.fn(fn).between(`function ${fn}`, next)
      expect(body.has('voiceGestureRoute('), fn).toBe(true)
    }
  })

  it('the overlay draws the dialog before it draws the menu', () => {
    // `overlayContent` asks `interactiveOverlay` for both, so that is where the order is decided.
    expect(code.fn('overlayContent').has('interactiveOverlay()')).toBe(true)
    const fn = code.fn('interactiveOverlay')
    expect(fn.indexOf('voiceOverlay(voice)')).toBeGreaterThan(-1)
    expect(fn.indexOf('voiceOverlay(voice)')).toBeLessThan(fn.indexOf('if (menuOpen)'))
  })

  it('the pump stands down while the dialog is up, like every other overlay', () => {
    const fn = code.fn('overlayActive')
    expect(fn.has('voiceActive()')).toBe(true)
  })
})

describe('cancel clears the box, send does not', () => {
  it('voiceCancel empties the text box', () => {
    const fn = code.fn('voiceCancel')
    expect(fn.has("textBox.value = ''")).toBe(true)
  })

  it('voiceResolve leaves the box alone: fire() already consumed it', () => {
    const fn = code.fn('voiceResolve')
    expect(fn.has('textBox.value')).toBe(false)
  })

  it('Again clears the box too: the old transcript must not survive a re-record', () => {
    const fn = code.fn('voiceAgain')
    expect(fn.has("textBox.value = ''")).toBe(true)
  })
})

describe('the microphone cannot be left open', () => {
  it('every exit from a recording closes it', () => {
    for (const fn of ['voiceCancel', 'voiceStop', 'voiceAgain', 'voiceFail']) {
      expect(code.fn(fn).has('voiceMicOff()'), fn).toBe(true)
    }
  })

  it('a phone Submit closes it too: it can land while the dialog is still recording', () => {
    // Scoped to the function body: `voiceCancel` follows it, and a fixed-width window would find
    // its call and pass on a `voiceResolve` that has none.
    const fn = code.fn('voiceResolve')
    expect(fn.has('voiceMicOff()')).toBe(true)
  })

  it('a recording has a hard cap, and an unanswered confirm times out', () => {
    expect(code.has('VOICE_MAX_RECORD_MS')).toBe(true)
    expect(code.has('VOICE_IDLE_MS')).toBe(true)
    // The idle timer exists because an overlay left up freezes the mirror.
    expect(code.has("voiceCancel('idle')")).toBe(true)
  })
})

describe('the phone button', () => {
  it('acts through voiceButtonFor, so its label and its action are one decision', () => {
    const fn = code.fn('onVoiceBtn')
    expect(fn.has('voiceButtonFor(')).toBe(true)
    // A stop from the phone is the same stop a glasses tap reaches.
    expect(fn.has('voiceStop(')).toBe(true)
    expect(fn.has('voiceMicOff(')).toBe(false)
    expect(code.has("button('🎤 voice', onVoiceBtn,")).toBe(true)
  })

  it('follows every stage change: setVoice is the one place it is synced', () => {
    const fn = code.fn('setVoice')
    expect(fn.has('syncVoiceBtn()')).toBe(true)
  })
})

describe('the async races', () => {
  it('a transcript that arrives after a cancel is dropped, not shown', () => {
    const fn = code.fn('voiceStop')
    expect(fn.has('const gen = voiceGen')).toBe(true)
    expect(fn.count('gen !== voiceGen')).toBeGreaterThanOrEqual(3)
  })

  it('a mic that opens after a cancel is closed again', () => {
    const fn = code.fn('voiceStart')
    expect(fn.has('if (gen !== voiceGen) { void voiceMicOff(); return }')).toBe(true)
  })
})

describe('what is offered, and when', () => {
  it('the long press opens it, and only when the server has a recogniser', () => {
    const body = code
      .fn('onHubEvent')
      .between("if (g === 'long' || g === 'longRelease')", "if (g === 'double')")
    expect(body.has('sttReady')).toBe(true)
    expect(body.has('voiceStart()')).toBe(true)
  })

  it('the release stays unbound, so a lost PB 10 cannot strand the mic', () => {
    const body = code
      .fn('onHubEvent')
      .between("if (g === 'long' || g === 'longRelease')", "if (g === 'double')")
    expect(body.has("g === 'long' && sttReady")).toBe(true)
    expect(body.has("g === 'longRelease' &&")).toBe(false)
  })

  it('the phone pill is hidden until health says a recogniser is configured', () => {
    expect(code.has("voiceBtn.style.display = sttReady ? '' : 'none'")).toBe(true)
  })

  it('audio frames never reach the blanket log, and feed the dialog when one is up', () => {
    const hub = code.fn('onHubEvent')
    const at = hub.indexOf('const pcm: unknown = event.audioEvent?.audioPcm')
    expect(at).toBeGreaterThan(-1)
    const body = hub.from('const pcm: unknown = event.audioEvent?.audioPcm', 500)
    expect(body.has('onVoiceFrame(pcm)')).toBe(true)
    // Before `evenGestureType` and before the ?debug=1 POST: a frame arrives every 50ms.
    expect(at).toBeLessThan(hub.indexOf('const g = evenGestureType(event)'))
  })

  it('a frame never redraws the glass; only the stage transition does', () => {
    const fn = code.fn('onVoiceFrame')
    expect(fn.count('setVoice(')).toBe(1)
    expect(fn.has("voice.stage === 'opening'")).toBe(true)
  })
})

describe('an error is never typed into the shell', () => {
  it('the transcript is gated by injectable() before it can be sent', () => {
    const fn = code.fn('voiceSend')
    expect(fn.has('injectable(')).toBe(true)
  })

  it('a failed recognition goes to the failed stage, never into the box', () => {
    const fn = code.fn('voiceStop')
    // `error` reaches voiceFail (which shows it); the only thing written to the box is `text`.
    expect(fn.has('voiceFail(j.error')).toBe(true)
    expect(fn.has('textBox.value = text')).toBe(true)
    expect(fn.has('textBox.value = j.error')).toBe(false)
  })
})

describe('where the two buttons sit beside the text box', () => {
  // Voice above Submit, Submit bottom-aligned. The submit-key picker lives in `▶ app`, so this
  // also pins that it is not in this column.
  it('stacks them in a column, voice first, and nothing else', () => {
    expect(code.has('sideCol.append(voiceBtn, submit)')).toBe(true)
    expect(code.has('textRow.append(text, sideCol, holdHint)')).toBe(true)
  })

  it('bottom-aligns Submit against the box, which needs both of these', () => {
    const col = code.fn('mountUi').from('const sideCol = document.createElement', 400)
    // `space-between` puts Submit on the bottom edge…
    expect(col.has('justify-content:space-between')).toBe(true)
    // …and only if the column is as tall as the box, which `stretch` on the row is for.
    expect(
      code.has(
        "textRow.style.cssText = 'margin:8px 0;display:flex;gap:6px;align-items:stretch;position:relative'",
      ),
    ).toBe(true)
  })
})
