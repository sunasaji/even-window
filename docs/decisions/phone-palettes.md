# Phone UI: palettes as the phone-side route to glasses-only UI

## Context

The window list and the `Window...` menu level are drawn only on the lens, and the glasses
run for only a few hours of continuous use. Without the glasses, window switching and
window-manager actions were reachable from the phone only by firing gestures blind. The
application list, in turn, is too long to browse on a 576x288 monochrome panel, and a first
phone list was hidden behind the soft keyboard.

## Decision

- Three top-anchored palettes opened from the title row: `task` (switch window), `window`
  (act on the current window), `apps` (launch).
- One shell owns the frame, viewport tracking, closing paths and cleanup; only one palette is
  open at a time.
- `task` and `window` are bypasses, not second implementations: rows come from the shared
  definitions and actions go through the same functions as the glasses UI. Navigation state
  and sticky modifiers of the on-glasses menu are not touched from the phone.
- Differences from the lens follow from the lens's limits only: all windows with full titles,
  no paging, no `Back` row, destructive rows arm in place, `Close Window` is inline.
- The panel is positioned from `window.visualViewport` and takes the whole visible rectangle
  while the soft keyboard is up. Rows are 32 px `div[role=button]` elements, not buttons.
- A palette closes when a row acts. `window` omits `Exit...`, `Keys...` and `Invert`.

## Alternatives considered

- A fold in the page (`▶ apps`): two entry points to keep in sync, and the list sat behind
  the keyboard.
- Redrawing the on-glasses root list on the phone: it carries launcher rows and a `Menu...`
  row that have better homes on the phone, and it truncates for the firmware.
- Keeping the palette open after an action: it would cover the mirror, where the result is.
- A reserved strip below the panel for outside taps: it sat between the filter box and the
  keyboard, exactly where typing thumbs land.

## Consequences

- Cycling windows costs two taps per window; repeated actions belong on a swipe binding.
- Both palettes work with the glasses off or disconnected.
- Background: [palette layout measurements](../notes/2026-10-phone-palette-layout.md).
