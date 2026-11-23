# Voice capture measurements

Snapshot — not maintained. Conditions: 2026-10-16/17, G2 glasses on hardware, Even App in
developer mode, SDK 0.0.16, measured with a temporary probe (`?micprobe=1`, since removed).

## The microphone sits behind two gates

| Gate | Applies to | When it takes effect |
| --- | --- | --- |
| `g2-microphone` in the `permissions` of `app.json` | Glasses microphone | Read at page load in developer mode (a reload enabled it) |
| OS microphone permission | Phone microphone | Dialog on first use |

Glasses audio arrives over BLE and does not use the phone's microphone hardware, so it needs
no OS permission.

`audioControl(true, …)` returning `true` does not mean audio will arrive. Without the
declaration the host accepted the call, returned `true`, and delivered no frame at all. No
envelope arrives either, so nothing shows in the hub-event log. "No permission" and "SDK
audio is broken" can only be told apart by counting frames. This cost about an hour before
the probe separated accepted from arrived.

## PCM shape

| Source | Frame | Audio per frame | Arrival interval (median) | Measured rate | First frame |
| --- | --- | --- | --- | --- | --- |
| Glasses | 1600 B | 50.0 ms | 59 ms | 15943–16145 Hz | 445 ms |
| Phone | 3200 B | 100.0 ms | 93 ms | 15925–16095 Hz | 422 ms |

- Both are 16 kHz, s16le, mono.
- The wire format was a `Uint8Array` passed directly, not the `number[]` or base64 the SDK's
  doc comment lists. Conversion cost on the main thread: 0.00 ms. Another host version could
  switch format, so the client detects the shape instead of assuming it.
- Delivery is bursty: the glasses deliver two frames about every 100 ms (interval range
  0–91 ms).
- Loss is effectively zero: 125 frames (6.25 s of audio) arrived in 6.23 s of wall time.
- Do not use the median arrival interval as the period. Because delivery is bursty, the
  median (59 ms) does not represent the period (50 ms) and yields a confident wrong rate of
  13333 Hz. The period is the mean interval, span / (frames − 1).

## The microphone does not compete with the mirror

Audio at 32 kB/s is larger than the measured tile bandwidth (17–26 kB/s), yet tile pushes
did not degrade while the microphone was on. Tile push throughput, normalised by bytes
(B/ms; blank tiles of 159 B / 483 B excluded as a different workload):

| Interval | Mean | Median | Range | n |
| --- | --- | --- | --- | --- |
| Before | 6.80 | 6.99 | 5.65–7.24 | 12 |
| During | 6.63 | 6.80 | 5.18–7.20 | 14 |
| After | 6.69 | 6.76 | 5.80–7.08 | 16 |

During versus after differs by 1%, inside the per-push spread (5.2–7.2). The right comparison
is during versus after (same content and conditions, only the microphone differs). So
32 kB/s is the phone-to-WebView figure, not the BLE figure; the glasses presumably send
compressed audio that the phone expands.

Consequence: the tile pump is paused during the dialog for legibility (text over lit tiles
is unreadable), not for bandwidth. Keeping the mirror live while recording is technically
possible.

## Start-up latency

From request to first frame: 445 ms (glasses), 422 ms (phone). With long-press detection
added, close to a second passes between starting to press and audio being recorded.
Therefore "listening" is shown on the first frame.

## `speakerRole` and `direction` are unusable

`speakerRole` (self / other) gave a self ratio of 96%, 50% and 30% across three runs of the
same action, and whole silent intervals fell to `other`. The SDK's own comment says "App
algorithm result; this is not a firmware identity assertion". Speech gating is by user
action. `direction` is populated only for the glasses (signed values such as 0, ±8, ±17,
−37, −49, −66, −90); for the phone it is `null` and `speakerRole` is `unknown`.
