# Status

English | [日本語](status.ja.md)

Maturity: proof of concept, with one backend (Linux). Mirroring, gestures, window
switching and voice input work on a real G2. This page records how far each feature
has been verified; the reference documents describe how each one works.

## Verification levels

| Level | Meaning |
| --- | --- |
| Hardware (G2) | Confirmed on real G2 glasses |
| Hardware (iPhone) | Confirmed in the Even App on a real iPhone |
| Simulator | Confirmed end to end in the Even Hub simulator, not on hardware |
| Removed | Found not to work or not to be reliable on hardware, and taken out |
| Unverified | A code path exists but has not been exercised |

## Features

| Feature | Level | Result | Reference |
| --- | --- | --- | --- |
| Mirroring (capture → tiles → glasses) | Hardware (G2) | Works, including changed-tiles-only updates | [architecture.md](architecture.md) |
| Tile transfer cost | Hardware (G2), measured | About 75 ms plus 0.038 ms per byte for a small tile | [glasses.md](glasses.md) |
| Gestures to the mirrored desktop (swipe, tap) | Hardware (G2) for gesture arrival; simulator for the full path | Works | [glasses.md](glasses.md) |
| Swipe debounce and batching | Real input | A burst of swipes becomes a leading swipe plus one batch | [glasses.md](glasses.md) |
| Window switching (double tap → window list) | Hardware (G2) | Works; windows are listed most recently focused first | [glasses.md](glasses.md) |
| Text drawn in front of the tiles (`zOrderIndex`) | Hardware (G2) | Works; always on | [glasses.md](glasses.md) |
| Hierarchical menu under `Menu...` | Simulator (key delivery checked against a real session) | Works; moving between levels pushes no images | [glasses.md](glasses.md) |
| Firmware context menu | Removed | Cannot coexist with `zOrderIndex` on hardware, and no gesture opens it | [glasses.md](glasses.md) |
| Voice input from the glasses (long press → speak → tap → `Send`) | Hardware (G2), 2026-10-17 | Works with the glasses microphone | [voice.md](voice.md) |
| Voice input started with the phone's **voice** button, glasses microphone | Unverified on hardware | No hardware record | [voice.md](voice.md) |
| Stopping a recording with the phone's **stop** button | Hardware (iPhone), 2026-11-23 | Works | [voice.md](voice.md) |
| Voice input with the phone microphone (app started with Bluetooth off) | Hardware (iPhone), 2026-11-23 | Works. Not usable as a rescue when the glasses are lost while the app runs. | [voice.md](voice.md) |
| Lens text shown on the phone preview (menu, voice dialog) | Simulator (menu); hardware (iPhone) for the voice dialog, 2026-11-23 | Works; same text, approximate font and line breaks | [phone-ui.md](phone-ui.md) |
| Invert (light/dark) | Simulator, measured on the rendered glasses image | Works | [usage.md](usage.md#light-and-dark) |
| **lens** latch (pause the glasses) | Simulator | Works | [usage.md](usage.md#pausing-the-mirror) |
| Pause in the case (`isInCase`) | Hardware (G2) | Matches the physical state in both directions | [glasses.md](glasses.md) |
| Automatic pause when taken off (`isWearing`) | Removed | Sometimes right, not dependable | [glasses.md](glasses.md) |
| Stopping updates when the link drops | Hardware (G2) | Stops. The reconnect path is unverified. | [glasses.md](glasses.md) |
| Launching applications (full list on the phone, recent ones on the glasses) | Simulator | Works | [usage.md](usage.md) |
| Phone **task** and **window** palettes | Simulator | Work without the glasses | [phone-ui.md](phone-ui.md) |
| Phone controls (keys, vRing, vPad, apps) | Hardware (iPhone) | In daily use. Suppression of the platform's touch defaults cannot be verified in the simulator. | [phone-ui.md](phone-ui.md) |
| Touch on the preview | Simulator | Works; left button only | [phone-ui.md](phone-ui.md) |
| Hardware keyboard | Hardware (iPhone) | In daily use; arrow keys are not delivered | [phone-ui.md](phone-ui.md) |
| Hardware trackpad | Hardware (iPhone) | Relative movement only | [phone-ui.md](phone-ui.md) |
| Authentication (device keys, session tokens) | Simulator | On by default; a real phone connects through `tailscale serve` | [security.md](security.md) |
| Instance arbitration (a newer copy takes the glasses) | Hardware (G2) | Observed to fire | [glasses.md](glasses.md) |
| Operating systems | — | Linux only. A Windows backend has not been started. | [platform.md](platform.md) |

## Known limitations

- **Reconnect is unverified.** Taking the glasses off and on does not drop the link,
  so the path that restores the mirror after a link loss has not been exercised on
  hardware.
- **The Even App can close right after a Bluetooth disconnect.** The cause is not
  identified. It is believed to be independent of even-window, without proof. It
  reproduced on 2026-11-23 when Bluetooth was switched off while the app was running.
- **An uncaught WebKit `NotSupportedError` seen before one such crash is unexplained.**
  A flood of log lines it used to trigger was a bug in even-window and is fixed.
- **No automatic pause on taking the glasses off.** `isWearing` is unreliable; use
  the **lens** latch or the case.
- **Suppression of platform touch defaults on the phone's full-screen pads cannot be
  checked in the simulator.**
- **Arrow keys from a Bluetooth keyboard do not reach the iOS WebView.** This cannot
  be fixed from the web layer.
- **Right click is available through vPad only**, and there is no dedicated
  double-click path on the preview.
- **No colour and no smooth video.** The glasses are 4-bit grey and each tile update
  takes about 75 ms or more.
- **Linux only.**
