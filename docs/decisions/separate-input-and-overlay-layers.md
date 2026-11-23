# Separate input and overlay layers, always z-ordered

## Context

Exactly one container on a page may capture input events, so one container is the path for every
gesture. The client also needs to show text (menu, notices, voice dialog) over the mirrored
picture. Without `zOrderIndex`, image containers always render in front of text, and the four
tiles cover the whole panel.

## Decision

Two full-panel text containers. Container 1 captures events, is created with a single space and
is never written again. Container 6 does not capture events and carries all visible text. Every
container on the page has a `zOrderIndex`: tiles 1-4, input layer 5, overlay 6 (larger is nearer
the front). There is no flag to turn the z-order off.

## Alternatives considered

- Writing overlay text into container 1: non-blank content might change capture behaviour, and
  the worst case, a menu that gestures can no longer dismiss, cannot be tested without hardware.
  The container budget is not scarce (6 of 12 in total, 2 of 8 text).
- `zOrderIndex` only on the overlay: the SDK rule is all-or-nothing; one missing or duplicate
  index fails the whole page before it reaches the host.
- Keeping z-order optional behind a flag: the flag existed while the capability was unproven. A
  persisted flag value later hid the menu on one device, and the text overlay does not work at
  all without z-order.

## Consequences

- Text drawn by the client can appear over the tiles, which is what makes a client-drawn menu
  possible ([client-drawn glasses menu](client-drawn-glasses-menu.md)).
- The firmware context menu cannot be registered: the host refuses `menuObject` together with
  `zOrderIndex`.
- After editing the z-order plan, a refused page creation points at the plan first; verify by
  looking at the glasses image, not at return values.

Background: [container semantics on hardware](../notes/2026-10-glasses-container-semantics.md).
