# vPad and mirror touch: pointer, modifier and wheel measurements

Snapshot — not maintained. Conditions: 2026-10-10 to 2026-10-17; isolated Xvfb display with
ratpoison and xterm (XTerm 390), simulator (WebKitGTK), iPhone and G2 glasses where stated.

## Arrow vanished after the first drag (2026-10-12)

- Symptom on glasses: the arrow appeared when vPad opened and never again after a drag; the
  phone preview kept showing it.
- Cause: the cursor starts at an integer centre but accumulates `PAD_GAIN`-scaled deltas, so
  it is fractional after the first move. Stamping into the index plane used
  `idx[ty * TILE_W + tx]`; assigning to a fractional TypedArray index is silently ignored.
  The canvas preview accepts fractional coordinates.
- Evidence in `?stats=1`: `derive 7 … encode 7 … push 2 … wasted 5/7 71%` (tiles re-encoded
  byte-identical and dropped).
- Fix: one conversion (`cursorTilePixel`, `Math.floor`) for both surfaces. Rounding 287.6 to
  288 would fall outside the tile. The clamp was also `SCREEN_W` / `SCREEN_H`, which belong to
  no tile; now `- 1`. Confirmed on a G2 (2026-10-12).

## Ctrl + press-and-hold (2026-10-10, Xvfb :192 + simulator)

- xterm's VT Fonts / Main Options menus need ctrl + button held. `xdotool mousedown` takes no
  modifiers and the server's `key` uses `--clearmodifiers`, so `keydown` / `keyup` kinds were
  added (without `--clearmodifiers`).
- During a ctrl-hold, `xdotool key a` gave `state 0x104` and `XLookupString … (01)` (ctrl+a);
  after release `state 0x0` and `"a"`. With `mousedown` forced to fail, `keyup ctrl` was still
  sent.

## Wheel strip and two-finger scroll

- The first notch size, 34 px, was derived from xterm's lines per notch. On an iPhone it was
  reported as too fast ("about 2/3 please", 2026-10-12); 34 × 3/2 = 51 px per notch was
  confirmed as right. On a 390 px-class phone the strip is about 6 notches long.
- Two-finger drag originally sent the swipe keys to the focused window, at 26 px per step.
  It was changed to the wheel (2026-10-15) with the same 51 px, since a wheel notch scrolls
  several lines (xterm: 5).
- Direction: the first default was "fingers drive the wheel"; after using both, natural
  became the default (2026-10-15). The strip stays fixed.
- With the direction inverted, the accumulator must be reduced by finger travel, not by wheel
  direction; otherwise it grows every notch and the loop runs to its cap.
- A hint line that also stated the current direction went stale when toggled with the pad
  open; only the toggle's own label states it now.
- In landscape the mirror reaches the bottom, so the strip's top is clamped to keep travel.

## Corner controls covered the mirror (device screenshot 2026-10-16)

`✕` and the direction toggle were 44 px boxes at `top: 8`; the mirror's top edge was at
y = 44, so they covered the first rows and that band was also deaf to the pad. Fix: 32 px ink
in a 44 px target, and the box is lifted by `clamp(mirrorTop − 44, 0, 8)`. The toggle shrank
from ~100 to ~84 CSS px wide. The same was applied to vRing.

## Mirror touch end-to-end (2026-10-17, simulator)

- Tap at WebView (300,183) → `getmouselocation` in the mirrored display `x:287 y:142`.
- Drag selected the first xterm line; end point `x:326 y:9` matched.
- Opening vPad right after and dragging moved the arrow from (326,9): the cursor belief was
  kept current.
- Log order: `clickat` for a tap; `move`, `down`, …, `move`, `up` for a drag.

## Overlay dim value

Native pills are the brightest thing behind the overlay (`buttonface` ≈ #EFEFEF on a #232323
page). Composited against black:

| Alpha | Pill vs page | Contrast | Appearance |
| --- | --- | --- | --- |
| 0.72 | 67 vs 10 | 2.00:1 | reads as a row of labelled buttons |
| 0.88 | 29 vs 4 | 1.22:1 | |
| 0.90 | 24 vs 4 | 1.16:1 | labels still readable |
| 0.92 | 19 vs 3 | 1.11:1 | faint rectangles, labels gone |

0.92 was chosen by eye from rendered samples. vPad (0.72) and vRing (0.82) previously
differed, which showed as a seam when switching.

## xterm font keys (2026-10-10, Xvfb :190)

`shift+KP_Add` raised 9x18bold to 10x20 and `shift+KP_Subtract` lowered it; returning to the
original step gave a byte-identical capture and the bash session survived every step. The
ladder stops at both ends (the lowest is xterm's 2x5 "Unreadable"). urxvt has no such binding.
