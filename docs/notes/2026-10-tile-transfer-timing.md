# Tile transfer timing on hardware

Snapshot — not maintained. Conditions: Even G2 over BLE from a phone WebView, `@evenrealities/even_hub_sdk` 0.0.16, measured 2026-10-11 to 2026-10-16 with `?debug=1&stats=1`.

Reference: [glasses.md](../glasses.md#cost-model).

## Linear fits, and why none of them generalises

| Source | Fit | Notes |
| --- | --- | --- |
| G2, SDK 0.0.16, small tiles (up to 600 B) | 75 ms + 0.038 ms/byte (about 26 KB/s) | 565 B tile about 96 ms; four about 390 ms |
| G2, SDK 0.0.16, large tiles (1.2-8.9 KB), 2026-10-11 | 13 ms + 0.057 ms/byte (about 17 KB/s) | 7960 B about 470 ms; four about 1.9 s |
| All 8 points of 2026-10-11 | 70 ms + 0.0484 ms/byte (about 20 KB/s) | see points below |
| heimterm, SDK 0.0.10 | 85 ms + 0.09 ms/byte (about 11 KB/s) | comparison only; do not use |

The 8 points (bytes -> ms): 280 -> 118, 327 -> 88, 371 -> 86, 1176 -> 89, 1457 -> 161,
4321 -> 238, 6064 -> 375, 7960 -> 470.

- The 2.4x gap to heimterm matches the LZ4 compression SDK 0.0.12 added to
  `updateImageRawData`.
- A fit made on one range fails outside it: the small-tile line predicts 377 ms for 7960 B
  (measured 470); the large-tile line predicts 29-34 ms for 280-371 B (measured 86-118).
- Every linear fit is a line drawn through a staircase (below).

## Push time is quantised to 30 ms

215 samples cluster at 240 / 270 / 300 / 330 / 360 / 390 ms, consistent with the BLE connection
interval. A change has to remove a whole step to be visible.

In one session with identical content, a 583 B difference changed push time by 0-10 ms (about
0.017 ms/byte). Halving bytes from there does not reach a step. The four messages per full
repaint cannot be merged: the SDK has no multi-container update.

Since SDK 0.0.14, each `updateImageRawData` holds the image path for 100 ms; calls inside the
window are deferred, not dropped (Even Hub display documentation and SDK README, as cited by the
g2-engine project). The serial pump at 300-450 ms per tile never hits it, but any burst strategy
is capped at 10 messages/s.

## The "324 ms fixed cost" was wrong (corrected 2026-10-16)

An earlier reading derived a fixed cost of 324 ms as "median 360 ms minus bytes x 0.017". But
0.017 ms/byte is the slope when the content is the same and only the bytes change; it is not the
slope across different content. Near-empty tiles show the floor directly:

| Run (`linkbase`) | 159 B | 498 B | ~1000 B | ~1500 B | ~2000 B |
| --- | --- | --- | --- | --- | --- |
| 17:19 (277 ms) | 116 ms | — | 177 ms | 263 ms | 296 ms |
| 17:40 (not measured) | 116 ms | — | 236 ms | 357 ms | 445 ms |
| 17:45 (448 ms) | 85 / 89 ms | 150 ms | 207 ms | 326 ms | 445 ms |

- The floor is 85-116 ms, the bottom of the 30 ms grid, never 324 ms. g2-engine measured about
  150 ms on an iPhone (a 24x24 black tile took 149 ms).
- Of a 445 ms push, about 360 ms depends on content.
- Floor and slope move with link quality (17:19: 0.10 ms/byte, floor 100 ms; 17:45: 0.19 ms/byte,
  floor 56 ms), so neither is a quotable constant.
- "Removing bytes does not help" still stands; it is a different, controlled experiment.
- One mechanism explains both: the host decodes the PNG and re-compresses the pixels before
  sending them over BLE. g2-engine observed the same 20,948 B payload taking 203 ms when black
  and 3264 ms as noise (16x), and a 4-bit 20,948 B and an 8-bit 41,684 B image taking the same
  time. PNG size is discarded; pixel detail matters.
- This does not mean there is room left. The client can choose little about content beyond
  `GREY_RAMP`; terminal entropy is dominated by glyph outlines, not by the number of levels.

## The link drifts 1.5x within a minute

With an identical payload inside one run, the push median went from 537 ms to 355 ms in about a
minute (1.51x). The spread seen between runs (328 / 360 / 458 ms) was the same drift sampled at
different moments.

- "Run before, run after, compare" is invalid, within or across sessions.
- Only interleaved arms are valid. ABBA cancels linear drift exactly. Changes that cannot be
  interleaved must be argued from mechanism and checked indirectly.
- `?stats=1` therefore measures a link baseline at both ends of a run (`linkbase`): 8 pushes of a
  fixed pseudo-random 3 px block pattern. Within 15 % the run reports that `push med / linkbase`
  may be compared; otherwise it prints `LINK DRIFTED`.
- The pattern is constant; its encoded size is not (1920 B from node's deflate, 2016 B from the
  phone WebView), so the log prints the byte count.
- The pattern is brighter than a terminal (uniform levels 0-15), so the glasses show a bright
  mosaic for about 3.5 s (8 pushes x about 420 ms) at boot and about 60 s later. It was reported
  from hardware as "the screen turns to camouflage"; the cause then was a `stats` flag that had
  been persisted in `localStorage` hours earlier. Instruments are no longer persisted.

## Tile encoding: settled questions

| Question | Answer |
| --- | --- |
| Does the firmware decode palette PNGs? | Yes: colour type 3 at 8 and 4 bit, and colour type 0 grey, all confirmed through the lens |
| What was wrong with `canvas.toBlob`? | A general RGBA truecolour encoder for a 16-level picture: 8075 B against 2083 B |
| Depth 4 or 8? | No timing difference (ABBA, 64 pushes, +10 ms, under half an interval); 4 is smaller |
| JPEG? | Larger than PNG on every workload, and functionally unusable (below) |
| Will fewer bytes be faster? | No (above) |
| Lower colour depth on the captured display? | No gain; depth 8 breaks colour classification |
| Lower capture frame rate? | Not worth it after the client arrival path was made cheap |
| Compare index planes before encoding to skip encodes? | No: 0.2 ms/s, 0.9 % of the client's main-thread work |
| Is `CompressionStream` off the main thread? | Not in a WebView; moved to a worker ([pipeline note](2026-10-client-tile-pipeline.md)) |
| Adopt the Glyph framework? | No: 20-40 % slower (below) |
| Any tile shape other than quadrants? | Impossible ([container note](2026-10-glasses-container-semantics.md)) |

Result of moving from `toBlob` to the 4-bit indexed encoder (2026-10-11): push median 474.8 ms
before, 327.7 ms after; pushes per quadrant per window 5/5/5/5 before, 8/8/8/8 after. The 1.45x is
not claimed: the two runs were sequential and the difference is within link drift. The
structural argument is the valid one (a quarter of the bytes, about 100 ms by the same-session
slope).

### JPEG

Compared with 4-bit indexed PNG on three real contents: dense digits 1667 B vs 25,784 B (q95),
sparse terminal 769 B vs 15,498 B, GUI 1445 B vs 6042 B. The pixels are already quantised to 16
levels upstream, which is the best case for palette coding and the worst for a DCT. Ringing also
lights 8-47 % of the black background even at q95; on a see-through panel black is transparent,
so that destroys see-through and costs battery.

### Capture colour depth (2026-10-16)

ffmpeg emits rgb24 whatever the X depth, so nothing downstream changes; ffmpeg itself is
1.1-1.4 % of a core. Only the X server's drawing gets cheaper (34 % to 28 % when saturated). At
depth 8 the ANSI palette is destroyed through x11grab (red becomes 72,72,85; white 72,108,0; only
black survives of 7 colours), so every pixel falls to the luminance fallback. Depth 16 classifies
correctly but gains only X server CPU.

### Glyph (2026-10-16)

[gabrielevierti/glyph](https://github.com/gabrielevierti/glyph), MIT, v0.3.0, a rendering
framework for the G2. No licence obstacle; the measurements decide.

| Glyph stage | This project | Verdict |
| --- | --- | --- |
| Sends `canvas.toBlob(,'image/png')` | own 4-bit indexed encoder | The rejected encoder (8075 B vs 2083 B) |
| One FNV-1a hash for change detection | four stages (whole frame, quadrant rows, quantised index plane, final PNG bytes) | Stricter here; a hash collision stays clean forever |
| 16 levels from the red channel only | ANSI16 classification plus luminance fallback | Not applicable to arbitrary RGB |
| No bitmap ingestion (`blit` takes quantised 0..15) | ffmpeg capture | Missing in Glyph |
| `bench` p50/p95 | `?stats=1` with link baseline bracket | Drift detection only here |

Converted with this project's slopes, `toBlob`'s extra 5992 B is +102 ms at 0.017 ms/byte (push
360 -> 450 ms) or +228 ms at 0.038 ms/byte: 3.4-7.6 steps of the 30 ms grid. Glyph's
`stats.bytes` counts Gray4 bytes, about a quarter of the PNG actually sent.

Glyph's layout presets other than `quadrants` (`bands` 576x72, `columns` 144x288, `chrome`
576x32 + 192x256, `hero` 426x288) exceed the image container limit and cannot be established on
hardware; its `validateLayout` does not check the limit and its tests run in headless Chromium
without SDK validation. Its hardware bench runs only `quadrants`. This is worth reporting
upstream.

## Tile layout study (2026-10-16)

Method (no hardware needed): `Xvfb :99 -screen 0 576x288x24`, the fixed workloads of
`scripts/bench-workload.sh`, the server's own ffmpeg arguments, a per-pixel change map and an
integral image to count dirty tiles per candidate layout. Self-check: the quadrant count matched
a verbatim re-implementation of the server's tile diff on all 139 changed frames of 4 workloads.

Messages per frame, not bytes, is the quantity measured.

| Workload | Change shape | Best | Quadrants | Worst |
| --- | --- | --- | --- | --- |
| `idle` | one frame changes | all 1.00 | 1.00 | all equal |
| `seqleft` | left half only | `columns` / `hero` -49.8 % | 2.01 tiles/frame | `bands` +99.3 % |
| `sl` | crosses full width | `hero` -31.0 %, `bands` -29.0 % | 3.24 tiles/frame | `quadrants` (last) |
| `counter64` | whole screen | all 4.00 | 4.00 | all equal |

- The best layout flips per workload. Quadrants are never best and never catastrophic. The
  mirrored content is arbitrary and the layout is fixed at page creation, so a static choice has
  to be a hedge.
- Minimising messages alone degenerates into one huge tile plus slivers (`sl`: 576x192 plus three
  576x32, -69.2 %). Push cost is fixed cost plus slope times content, not either alone.
- Not splitting would be cheaper (own encoder, 40-frame average, all quadrants dirty; the model
  column uses the since-corrected 324 ms + 0.017 ms/byte):

| Configuration | Messages | Bytes/frame (`sl` / `counter64`) | Modelled push |
| --- | --- | --- | --- |
| 4 x 288x144 (current) | 4 | 1047 B / 4198 B | 1314 ms / 1367 ms |
| 2 x 576x144 | 2 | 779 B / 3928 B | 661 ms / 715 ms |
| 1 x 576x288 | 1 | 613 B / 3620 B | 334 ms / 386 ms |

  Splitting duplicates PNG headers and deflate dictionaries four times. None of the alternatives
  is reachable: the image container limit forces quadrants.

## What derive optimisation did not do (2026-10-11)

Hypothesis: the client and the pump share a thread, so a cheaper grey derive should lower push
time.

| | derive med / p90 | push med (mean of window medians, SD) |
| --- | --- | --- |
| Baseline (old derive) | 2.00 / 2.00 ms | 454.5 ms, 10.5 (n = 8 windows) |
| Optimised | 0.00 / 1.00 ms | 474.8 ms, 6.8 (n = 6 windows) |

Derive got about 3x cheaper on hardware and push did not get faster. Push is transfer-bound. The
optimisation was kept for the phone's main thread and battery (about 5 % of the main thread at
40 derives/s), not for latency.
