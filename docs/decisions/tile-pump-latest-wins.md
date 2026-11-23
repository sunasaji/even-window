# Serial tile pump with encode at dequeue

## Context

Tiles arrive at up to 40 per second (10 fps, four quadrants). The glasses accept about 2.5 pushes
per second, one at a time. The SDK has no multi-container update.

## Decision

One pump pushes one tile at a time. There is no queue: each quadrant has one pending flag and one
index plane, overwritten by newer arrivals. Grey conversion and PNG encoding happen when the pump
picks the quadrant, and the encoded bytes are compared with what the container already holds
before pushing. Quadrants are picked round-robin from a cursor that persists across drains.

## Alternatives considered

- A frame queue: at a 15x oversupply it only adds latency.
- Encode on arrival: 92 % of the encodes were discarded unread.
- Fixed priority (always scan from the top-left tile): a quadrant that changes on every frame is
  dirty again when its push returns, and the other three starve.
- Parallel pushes: concurrent `updateImageRawData` calls are not safe, and the SDK defers calls
  within 100 ms of each other anyway.
- Rate-limiting the server's emission, or lowering the capture rate: saves little now that
  arrival is cheap, and costs first-change latency.

## Consequences

- The glasses always receive the newest content; intermediate frames are dropped by design.
- A dirty quadrant is served within four pushes.
- While everything changes, the display is structurally behind by about one full cycle.
- Anything that changes what the containers hold outside the pump (overlay blanking, link
  baseline) must stand the pump down first and reset the diff baseline afterwards.
- A repaint after a baseline reset may start at any quadrant.

Background: [client tile pipeline](../notes/2026-10-client-tile-pipeline.md).
