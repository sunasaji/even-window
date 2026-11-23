# Quadrant tiles

## Context

The glasses panel is 576x288. A page may hold at most four image containers, and an image
container is limited to 288 wide and 144 high, each dimension separately (minimum 20x20). The
layout is fixed when the page is created and cannot change while streaming
([establish once](establish-once.md)).

## Decision

The mirror is four 288x144 image containers in a 2x2 grid: top left, top right, bottom left,
bottom right, with container id `2 + tile index`.

## Alternatives considered

- Bands, columns, a large "hero" tile with slivers, or one full-panel image: all exceed the
  per-dimension limit and are refused at page creation. Four containers of the maximum size
  cover the panel exactly (4 x 288 x 144 = 576 x 288), so no other partition exists.
- Choosing a layout per workload: even if other shapes were legal, the best layout flips between
  workloads (bands are 29 % better than quadrants on one and 99 % worse on another), and the
  content of a mirrored desktop is not known when the page is created. Quadrants are never the
  best and never the catastrophic choice.
- Fewer, larger tiles: would need fewer messages and fewer bytes for a full repaint, and is
  unreachable for the same reason.

## Consequences

- A full repaint is always four messages; a change confined to one quadrant is one.
- No image container is spare. Anything else shown on the glasses is text in the overlay
  container or pixels inside the tiles.
- A full-panel text container being legal says nothing about image containers; the two types
  have different limits.
- Do not reopen this without a page-creation result from the validator that contradicts it.

Background: [container semantics on hardware](../notes/2026-10-glasses-container-semantics.md),
[tile layout study](../notes/2026-10-tile-transfer-timing.md).
