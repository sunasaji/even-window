# Phone touch layer findings

Snapshot — not maintained. Conditions: iPhone, Even App WebView (WKWebView), 2026-10; simulator
is WebKitGTK driven with `xdotool`; some observations predate this repository.

## Tap rate ceiling

- Measured before this repository: on-screen taps register at about 1.6 per second (one per ~600 ms).
  Dropped taps never reach the DOM; no handler or library can recover them.
- Consequences drawn: on-screen keys are structurally slow (one tap per key); the text box
  sends a whole line per injection; ring and temple gestures arrive over BLE and bypass the
  touch layer; vRing uses one large surface because a half-screen swipe is a single contact.
- A double click made of two finger taps on the mirror may not be expressible at all under
  this ceiling. No dedicated control was added.

## Timers fire early

- A 320 ms `setTimeout` was observed firing after ~5 ms under frame-forwarding load.
- vRing therefore decides at `touchend` without delay and separates tap from double-tap by
  screen half, not by time.
- vPad's hold timer re-checks `Date.now() - startAt` when it fires and re-arms for the rest.
- Earlier vPad thresholds (300 ms tap, 1000 ms long press) left a dead band between them
  where nothing happened; the hold threshold is now the tap threshold.

## Native touch defaults on full-screen overlays (vPad report)

Report: on a tap-then-drag in vPad, the page behind started a text selection instead of the
drag reaching the pad. Injection was correct in the simulator. The competitor was the phone's
own long-press callout and selection drag, which has the same shape as a hold-drag.

| Measure | Where | Stops |
| --- | --- | --- |
| `touch-action: none` | overlay element | pan / zoom |
| `user-select: none` | overlay and `html, body` | selection; the page behind must not be a selection host |
| `-webkit-touch-callout: none` | overlay element | iOS long-press callout (was missing on both overlays) |
| `preventDefault()` on `touchstart/move/end` | `suppressNativeTouchGestures()` | touch defaults |

- `preventDefault()` on `pointerdown` stops only compatibility mouse events. vPad was driven by
  pointer events alone and had no touch listener; vRing had them. That asymmetry was the
  diagnosis.
- A `touchmove` already committed to scrolling arrives non-cancelable; calling
  `preventDefault()` on it only logs a console error, so `cancelable` is checked.
- `✕` and the selector pills are exempt and hit-tested by rectangle: under pointer capture the
  event target is retargeted, and suppressing `touchend` over a control kills its activation.
- The first suppression is logged once (`vPad: native touch defaults suppressed (…)`); on a
  phone this is the only outside evidence that the gate is active.

## Controls that fire twice on a finger

Overlay controls act on a rectangle test in `pointerup`. The scroll-direction toggle also had
a `click` listener; a finger ran both, so the toggle flipped twice and appeared dead (device
report 2026-10-15). Selector pills survived the same double path because selecting is
idempotent. The simulator did not reproduce it: a mouse runs only one of the two paths.

## Other device findings

- iOS does not move focus when a tap lands on a plain `<button>` or a canvas, so a text field
  kept focus and kept receiving hardware keys. The page blurs it on `pointerup`.
- iOS shows a selection callout on a long-pressed control, which covered the Submit hold hint
  and ate the release; Submit carries `-webkit-touch-callout: none`.
- A thumb wrapped around the phone lands on the last few pixels of the screen. With an inset
  right of the wheel strip, a missed strip drag moved the X pointer and clicked.

## What the simulator cannot show

WebKitGTK delivers a mouse, has no soft keyboard and no `-webkit-touch-callout`. It can show
that an overlay still works; it cannot show that selection stopped, that a finger activates a
control once, or that a palette avoids the keyboard.
