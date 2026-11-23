# Blank the tiles under the overlay

## Context

Stopping the pump stops new frames but does not darken the panel: image containers keep showing
the last tile. The panel is emissive and see-through, so overlay text over a lit terminal frame
is bright text on bright text. This was reported from hardware as an unreadable menu.

## Decision

Before overlay text is shown, the pump stands down and every quadrant that is not already black
receives a constant all-black tile through the normal serial push path. Hiding the overlay
resets the diff baseline and lets the pump repaint. The same mechanism serves the menu, the
voice dialog, the `X unavailable` notice and the lens pause.

## Alternatives considered

- Blank only the rows the text occupies: the text metrics are not reported by the firmware, the
  menu spans all four quadrants anyway, leftover bright rows reproduce the problem, and a partial
  tile cannot be a constant.
- Rebuild the page without tiles: rebuilding a live page is forbidden
  ([establish once](establish-once.md)).
- A separate "pause" path for the lens latch: it would have to re-earn serialisation and pump
  awareness that the overlay transition already has.

## Consequences

- Opening costs up to four small pushes (565 B each, about 390 ms in total); moving the selection
  costs none because the tiles are already black.
- Nothing on the mirrored desktop is visible while an overlay is up.
- The black tile ignores invert: black is "no emission", not a colour.
- A paused lens is also the lowest-power picture the panel can show.
