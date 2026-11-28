# Client-drawn glasses menu instead of the firmware menu

## Context

The SDK offers a firmware context menu (`menuObject`). It is drawn on the firmware's own plane,
supports one flat level of at most 10 items, and can only be changed by rebuilding the page.

When this was decided (October 2026), the host on a G2 refused a page that carried both
`menuObject` and `zOrderIndex`, and no gesture that opens the firmware menu had been found.
Neither holds any more: tap-then-long-press opens it, and a page may carry both
([measured in November](../notes/2026-11-context-menu-on-hardware.md)). The decision stands on
the remaining grounds: one flat level, ten items, a rebuild for every change of the window set.

## Decision

The whole menu (the window and launcher list, and every level below it) is text written by the
client into overlay container 6, in front of the tiles by `zOrderIndex`, and opened by a double
tap. `menuObject` is not registered. Levels are pure data in `src/shared/glassMenu.ts`.

## Alternatives considered

- Firmware menu only: needs a page rebuild whenever the window set changes, cannot nest, and
  closes on every selection.
- Firmware root with client-drawn levels: ruled out at the time because the host refused
  `menuObject` together with `zOrderIndex`. It is possible now, at the price of two menus whose
  open state the app cannot tell apart from a notification.
- A `listObject` container: has no incremental update either.

## Consequences

- Moving within the menu costs one text update and no image push; no rebuild is ever needed for
  the menu.
- The menu must fit the panel: 10 text lines, so a header and 9 rows per level; long groups
  are paged. A double tap ascends, so only the confirmation levels spend a row on `< Back`.
- Labels written in the code are restricted to ASCII because the firmware font's coverage is
  unknown. Window titles and application names are shown as they are.
- While the menu is up, gestures are consumed by it and the mirror is blanked, so rows that act
  on the mirrored desktop close the menu before acting.
- The firmware menu's label limit (32 bytes) no longer applies: the root list cuts a label by
  its width on the panel. Its row count is the panel's: a header and nine rows per page.

- The firmware menu still exists beside this one: with no `menuObject` it holds the system rows
  (Display off, Brightness, Close), so the glasses always have a way to close the app.

Background: [gestures and the firmware menu](../notes/2026-10-gestures-and-firmware-menu.md),
[the context menu on hardware](../notes/2026-11-context-menu-on-hardware.md),
[container semantics](../notes/2026-10-glasses-container-semantics.md).
