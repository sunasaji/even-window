# Choosing the benchmark workload

Snapshot — not maintained. Conditions: October 2026; 12 s per workload through the
production quantiser and tile diff at 10 fps capture; the last two rows on a live mirrored
desktop, the others on a clean 576x288 Xvfb. Result: `scripts/bench-workload.sh`.

A before/after timing comparison is only as good as the sameness of the two runs, and the
workload is what drifts. It has to keep all four quadrants changing (fairness and starvation
only show when everything is dirty), be reproducible (same pixels give the same PNG sizes and
so comparable push times), and saturate the capture rate.

Dirty frames per quadrant in 12 s, and tiles per second the pump would have to send:

| Workload | TL | TR | BL | BR | needed/s | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Idle shell prompt | 1 | 1 | 1 | 1 | 0.3 | 97 of 98 frames byte-identical |
| `while :; do seq 1 100000; done` | 117 | 1 | 117 | 1 | 19.7 | left half only |
| `awk printf "%064d"` counter | 1 | 116 | 17 | 116 | 20.8 | right half only |
| `while :; do sl -l; done` | 78 | 82 | 80 | 85 | 27.1 | good, even |
| `counter64` (script default) | 117 | 117 | 117 | 117 | 39.3 | best |

The pump on hardware sends about 2.2–2.5 tiles/s (300–450 ms each). The needed/s column dates
from when a tile was 565 bytes and the pump did about 10.4/s; it is still valid for relative
comparison (`counter64` oversupplies the pump about 16 times).

## The trap

A workload whose changing region is horizontally confined dirties two quadrants, and the
resulting `TR 0 BR 0` is indistinguishable from the starvation bug being measured. `seq`
prints short numbers at the left margin. A single `%064d` counter looks full-width but its
high digits never change, so only the right end moves; worse, it looks even for the first
seconds while the screen fills. `counter64` prints eight 8-digit fields, each a different
multiple of the counter, so every column changes on every line. `sl` needs no such care: the
train crosses the full width.

Video satisfies coverage and saturation but not reproducibility (decode jitter); use it only
for subjective checks.

## Capture procedure

- Flags go in the URL the phone opens: `?debug=1&stats=1`. Both are needed (`stats` produces
  the lines, `debug` forwards them). Check the boot log shows `stats=every 10s`.
- Do not use the simulator: without a radio link four tiles return in about 19 ms and the
  contention being measured does not exist.
- Keep the server binary fixed across both runs; switch the client with `git switch` and a
  full reload on the phone.
- 60 s or more per run; drop the first one or two 10 s windows (establish and first paint).
- While `stats` is on, a bright pseudo-random mosaic (the link baseline pattern, eight pushes,
  about 3.5 s) appears after boot and once more about 60 s in. It reruns on every reload or
  reconnect and is not counted in the `stats` push numbers. `grep linkbase` before
  investigating a mosaic.

`stats` and `debug` stopped being persisted on 2026-10-13, after a `?stats=1` typed long
before kept rerunning the baseline on loads whose URL did not mention it.

## Lessons from the one-off hardware probes

`?pngprobe` (does the firmware decode palette PNGs) and `?depthprobe` (depth 4 vs 8) were
removed once answered. What generalises:

- Separate questions the lens answers ("was it drawn") from questions a return value answers
  ("how many ms").
- Show the same picture in four quadrants with different encodings, plus one known-good
  control; the comparison becomes spatial and needs no memory.
- Do not let the test card create an illusion: with vertical bands, the brightest and darkest
  bands met at a quadrant edge and simultaneous contrast read as "the right side is darker".
  Flat areas that cross the boundary are the instrument.
- Run generated images through a third-party decoder (`ffmpeg`) first, so an encoder bug is
  not mistaken for a firmware rejection.
