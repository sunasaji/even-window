# Phone UI: native buttons and imported chrome

## Context

The phone UI must fit six pills per row on a 360–390 px screen and still be tappable. A first
version styled the buttons (`min-height: 44px`, `padding: 0 15px`, pill radius) and fitted
four per row. Six fit when no CSS is applied to those buttons at all.

## Decision

- Pills are unstyled native `<button>` elements; the platform's own control size is the size.
- Press and latch feedback use `filter: invert(1)`, a post-layout effect.
- `touch-action: manipulation` on `html, body` removes the double-tap-zoom delay, so small
  targets register on the first tap.
- Controls that need a guaranteed target (overlay `✕`, palette `✕`, the scroll-direction
  toggle) have a 44x44 hit box with 32 px of ink, made with a transparent border and
  `background-clip: padding-box`.
- The rest of the chrome follows the same rounded look. Deliberate exceptions: the
  mirror and the overlay "hole" are rectangular (they stand for a physical 576x288 panel),
  vPad selector pills use the key chrome with square corners, and `Submit` carries
  touch-callout suppression for its hold gesture.
- One dim value for both full-screen overlays: `OVERLAY_DIM = rgba(0,0,0,0.92)`.

## Alternatives considered

- Larger styled pills: fewer per row, and overriding the background makes iOS drop the native
  button box and resize it, moving buttons under the thumb.
- Bigger buttons as the answer to the ~600 ms tap ceiling: the ceiling limits tap count, not
  accuracy, so the answer is fewer taps (text box, vRing).
- An opaque overlay: the page stops reading as a layer underneath and `✕` loses its meaning.

## Consequences

- Native pills render in the platform's light button colour, so a latched (inverted) pill is
  the dark one.
- Do not set `color-scheme: dark` on `:root`; it would darken the native pills. `<select>`
  elements opt in individually.
- Background: [chrome and layout notes](../notes/2026-10-phone-chrome-and-layout.md),
  [dim value table](../notes/2026-10-vpad-pointer-and-wheel.md#overlay-dim-value).
