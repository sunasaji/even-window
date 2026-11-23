# Client tile pipeline measurements

Snapshot — not maintained. Conditions: phone WebView driving an Even G2, SDK 0.0.16; desktop Chromium 149 for the `CompressionStream` test; capture at 10 fps; measured 2026-10-11 to 2026-10-16 with `?debug=1&stats=1`.

Reference: [glasses.md](../glasses.md#tile-pipeline).

## Arrival path: canvas round trip removed

The server sends an index plane as an indexed PNG. The client used to expand it to RGBA through
a canvas (`drawImage` + `getImageData`) and the push path turned it back into indices.

| | ms per tile | at 40 tiles/s |
| --- | --- | --- |
| Old: `drawImage` + `getImageData` (hardware) | 2.00 | 80 ms/s |
| New: own inflate + unfilter | 0.688 | 27.5 ms/s |
| plus colour mirror (u32 palette, one store per pixel) | 0.066 | 2.6 ms/s |

Hardware, 2026-10-16: `decode 400@40.0/s med 2.00ms` before; `decode 400@40.0/s med 0.00 p90
1.00ms` after. The Blob, the object URL, the `Image` element and the decode canvas are gone.

Related details:

- The grey derive became a 16-entry table read (0.173 ms/tile), derived from `levelOf` so the rule
  exists once.
- Writing the mirror through a `Uint8ClampedArray` cost +0.25 ms/tile (the clamp runs four times a
  pixel); the mirror is written through a `Uint32Array` view of the same buffer.
- Fusing the index plane and the green mirror into one pass over the 41,472 pixels saved
  0.37 ms/tile.

## Two event streams were open, silently

`startStreamAsync` closes the stream and then awaits a ticket; a second caller entering that
window made both create an `EventSource`, and the one not kept was never closed. Boot did exactly
that (once before the bridge, once when the identity came back from the durable store). Nothing
looked wrong: the stream worked and the glasses updated. The only trace was a `decode` rate above
the 40/s ceiling (10 fps x 4 quadrants). A generation counter now closes the window.

Client main-thread budget (rate x median):

| | decode | derive | encode | total |
| --- | --- | --- | --- | --- |
| canvas round trip, one stream | 80.0 | 1.1 | 4.4 | 85.5 ms/s |
| own inflate, two streams | 32.0 | 0.6 | 3.0 | 35.6 ms/s |
| own inflate, one stream | 16.0 | 2.3 | 4.6 | 22.9 ms/s |

`encode` is wall time across an `await`, so the three columns are not strictly the same unit; the
conclusion holds anyway.

Push did not change: that run had `push med 300 ms` with `linkbase 271 ms`, ratio 1.11, the same
as earlier runs (1.06 / 1.07). The link was 35 % faster that minute. Without the baseline bracket
this would have been reported as "fixing the double subscription made push 33 % faster".

## Capture frame rate only sets the arrival rate

Workload with all four quadrants changing:

| Capture fps | Tiles arriving per second |
| --- | --- |
| 10 | 38.8 |
| 5 | 18.8 |
| 3 | 11.2 |
| 2 | 6.4 |
| 1 | 3.2 |

The pump sends about 2.5 tiles/s, so 10 fps is a 15.5x oversupply. On a nearly static screen the
rate is 0.4 tiles/s regardless. Lowering the frame rate costs first-change latency (mean
1/(2 fps): 50 ms at 10 fps, 167 ms at 3 fps) and, after the arrival path was made cheap, would
recover only part of 16 ms/s. A server-side emit rate limit was considered and not implemented.

## Encode at dequeue

With encoding done at arrival, 92 % of deflates were thrown away unread on hardware (40
derives/s against about 3 pushes/s). Moving derive and encode to dequeue made the encode rate
equal the push rate with no latency cost and no tuning constant.

A bug found on the way: clearing `greyPending[i]` after the encode `await` erased the flag set by
an arrival during the encode, leaving pixels in the plane with nobody owing a push. The quadrant
stopped silently. The flag is cleared before the `await`.

Round robin: with an absolute TL-first priority, a busy TL quadrant is dirty again by the time
its own push returns and the other three never get served (`104 0 0 0` pushes per window). The
rotating cursor fixed it (`26 26 26 26`).

## `CompressionStream` occupies the main thread in a WebView

Chromium 149, 200 serial deflates of a 20,880 B tile row buffer:

| | Wall | Macrotasks that ran meanwhile |
| --- | --- | --- |
| Deflate on the main thread | 127 ms | 0 |
| Deflate in a worker | 176 ms | 20,592 (117/ms) |
| Idle baseline | 127 ms | 19,098 (150/ms) |

`write()` and `close()` return in 0.000 ms, but compression runs inside the `read()`
continuation, a microtask. Do not re-check this in node: node's `CompressionStream` runs zlib on
the libuv thread pool and gives the opposite answer (2.3x faster when concurrent).

On hardware the worker round trip is about 1.0 ms per tile (`encode` median 2.0 -> 3.0 ms, p90
3.0 -> 5.0 ms), four times the 0.25 ms estimated on desktop: a phone's structured clone of
41,472 B and its `postMessage` are dearer. Throughput is unchanged (2.2-2.5 pushes/s).

### ABBA on hardware (2026-10-16, `?encworker=abba`, 8 usable windows)

| Arm | `late blk` | raw `Σ` | `encode med` |
| --- | --- | --- | --- |
| worker | 250 / 255 / 259 / 266 | 1726 / 1727 / 1730 / 1741 | 3.0 x4 |
| main | 271 / 276 / 277 / 298 | 1737 / 1740 / 1743 / 1751 | 2.0 x4 |

`blk` separates completely (U = 0, one-sided p about 0.014): 23 ms per window, 2.3 ms/s of main
thread returned. The raw sum does not separate (one inversion, p about 0.057). The run
self-certified (`link held within 6%`, `push med 445 / 448 = 0.99`).

The absolute `blk` is not "main-thread time lost": 60 ms was predicted and 23 ms observed. The
sampler only catches a block if a tick falls inside it, so it underestimates systematically. It
is a quantity for comparing arms.

## The `late` instrument

A 10 ms `setInterval`; tick lateness is main-thread occupancy regardless of who caused it. The
phone WebView rounds `performance.now()` to 1 ms, which pins `derive med` and `decode med` at
0.00 and makes per-call timings unreadable; lateness summed over a window is sensitive in the
2-5 ms band where encode lives.

First hardware run: the raw sum was almost entirely the timer's own inaccuracy.

```
825 ticks x 10 ms = 8250 ms  +  late Σ 1740 ms  =  9990 ms = the window
```

A requested 10 ms period was really about 12.1 ms; about 1650 of the 1740 ms was that constant,
and the signal (3.2 encodes/s x 2 ms = 64 ms) was 3.7 % of the printed number. Arms did not
separate: worker 1728 / 1730 / 1740 against main 1730 / 1747 / 1761 / 1762 / 1768.

Fix: `blk` is the excess over a per-window floor, and the floor is the 25th percentile, not the
median, so it survives when up to 75 % of ticks are hit. Simulator check (40 encodes/s, half the
ticks hit): worker 660 / 747, main 1140 / 1277, floor 2 ms in every window; separation improved
from 1.21x (raw) to 1.72x (`blk`). Absolute values do not transfer to hardware.

`SAMPLER STARVED` marks a window where the sampler got under half its ticks; it fired on the
first run (`late Σ6504ms/350t max 990ms`, the main thread stopped for about a second), which would
otherwise have read as a large occupancy number.

## The `wasted` counter is a sum of two causes

| | Where | Condition | Encode paid |
| --- | --- | --- | --- |
| A, coalesced | `publishTile` | the quadrant was already pending | no |
| B, identical | the pump's `sameBytes` skip | encoded bytes equal what the glasses hold | yes (about 2 ms) |

`wasted` is A + B; `enc` is B. A is the coalescing working, not a budget. In a healthy run B is
about one per 10 s window: 0.2 ms/s, 0.9 % of the client budget. The one large B on record (5 of
7) was a bug: a fractional cursor coordinate silently dropped by a TypedArray index assignment
produced tiles identical to the previous ones. A non-zero `enc` is a fault signal, not an
optimisation opportunity.

`maxwait` measures how long a quadrant holding new content waited. An earlier version measured
the gap between pushes and reported `27117ms` for a menu that had simply been open for 27 s.

Reference sample line:

```
stats 10s: push 22@2.2/s med 300 p90 416ms fail 0 | TL 6 TR 6 BL 5 BR 5 maxwait 1562ms
           | decode 400@40.0/s med 0.00 p90 1.00ms | derive 23@2.3/s med 1.00 p90 2.00ms
           | encode 23@2.3/s med 2.0 p90 3.0ms | wasted 373/400 93%
```

## Capture-side diff (server)

`processFrame` runs a whole-frame memcmp before the per-tile diff: 0.016 ms against 0.66 ms
quantise + 0.65 ms PNG per frame on the development machine, taking a static screen from about
13 ms/s to 0.16 ms/s of server work. The two stages are not redundant: 16-colour quantisation
maps different rgb24 frames to the same tile.
