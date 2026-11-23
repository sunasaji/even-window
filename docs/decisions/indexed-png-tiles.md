# 4-bit indexed PNG tiles

## Context

The panel shows 16 grey levels. Tiles are pushed as image bytes over BLE at roughly two to three
per second, and the host decodes and re-compresses them. The picture is quantised to a 16-colour
palette on the server before it reaches the client.

## Decision

The client writes each tile itself as a PNG with colour type 3, bit depth 4 and a constant
16-entry grey palette (`src/shared/png.ts`), deflating in a worker. Invert flips the index, not
the palette. Incoming tiles are inflated by the client's own narrow reader. No canvas is on
either path.

## Alternatives considered

- `canvas.toBlob`: a truecolour RGBA encoder; 8075 B against 2083 B for the same tile.
- 8-bit indexed: no measurable timing difference; larger.
- JPEG: 4-15x larger on already-posterised content, and ringing lights the black background,
  which on a see-through panel destroys transparency.
- Further byte reduction, or skipping encodes by comparing index planes first: no measurable
  gain; push time is quantised in 30 ms steps and depends on pixel detail.
- Deflate on the main thread: `CompressionStream` blocks the main thread in a WebView.
- An external rendering framework (Glyph): uses `toBlob` and layouts the hardware refuses.

## Consequences

- The palette is constant, so one fewer thing varies in what the firmware receives.
- Grey values are exact panel levels; off-palette input is quantised to a level.
- The reader accepts only the shape the server's writer emits and drops anything else.
- The worker is optional: any failure falls back to the main thread for the session.
- These questions are settled by measurement; reopen them only with an interleaved (ABBA)
  comparison on hardware.

Background: [tile transfer timing](../notes/2026-10-tile-transfer-timing.md),
[client tile pipeline](../notes/2026-10-client-tile-pipeline.md).
