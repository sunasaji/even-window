# Client-drawn glasses menu instead of the firmware menu

## Context

The SDK offers a firmware context menu (`menuObject`). It is drawn on the firmware's own plane,
supports one flat level of at most 10 items, and can only be changed by rebuilding the page. On
a G2 the host refuses a page that carries both `menuObject` and `zOrderIndex`, and no gesture
that opens the firmware menu was found on hardware.

## Decision

The whole menu (the window and launcher list, and every level below it) is text written by the
client into overlay container 6, in front of the tiles by `zOrderIndex`, and opened by a double
tap. `menuObject` is not registered. Levels are pure data in `src/shared/glassMenu.ts`.

## Alternatives considered

- Firmware menu only: needs a page rebuild whenever the window set changes, cannot nest, closes
  on every selection, and could not be opened from the glasses.
- Firmware root with client-drawn levels: impossible, since the levels need `zOrderIndex` and the
  host refuses the combination.
- A `listObject` container: has no incremental update either.

## Consequences

- Moving within the menu costs one text update and no image push; no rebuild is ever needed for
  the menu.
- The menu must fit the panel: 10 text lines, so 8 content rows per level plus header and
  `< Back`; long groups are paged.
- Labels are restricted to ASCII because the firmware font's coverage is unknown.
- While the menu is up, gestures are consumed by it and the mirror is blanked, so rows that act
  on the mirrored desktop close the menu before acting.
- The firmware menu's label limit (32 bytes) is still honoured by the root list. Its row count
  is the panel's: a header and nine rows per page.

Background: [gestures and the firmware menu](../notes/2026-10-gestures-and-firmware-menu.md),
[container semantics](../notes/2026-10-glasses-container-semantics.md).
