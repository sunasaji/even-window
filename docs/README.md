# Documentation

English is the source of truth. User-facing guides also exist in Japanese (`<name>.ja.md`).

## Using pinhole-window

| Guide | 日本語 | What it covers |
| --- | --- | --- |
| [Getting started](getting-started.md) | [日本語](getting-started.ja.md) | Requirements, install, first run, pairing a phone, running as a service |
| [Usage](usage.md) | [日本語](usage.ja.md) | Glasses gestures and menu, the phone UI, voice input |
| [Configuration](configuration.md) | [日本語](configuration.ja.md) | Environment variables, the env file, application and binding files |
| [Firefox on the glasses](firefox.md) | [日本語](firefox.ja.md) | The bundled Firefox profile for a 576x288 screen |
| [Troubleshooting](troubleshooting.md) | [日本語](troubleshooting.ja.md) | Symptoms, causes and checks |
| [Status](status.md) | [日本語](status.ja.md) | What works, what is verified on hardware, known limits |

## Reference

Each of these describes the present behaviour and stands on its own.

| Document | What it covers |
| --- | --- |
| [Architecture](architecture.md) | The parts, the data flow and where each lives in the tree |
| [Protocol](protocol.md) | HTTP routes, the SSE stream, wire types |
| [Glasses](glasses.md) | Page containers, tiles, the pump, gestures, the menu |
| [Phone UI](phone-ui.md) | The WebView's phone-side controls |
| [Voice](voice.md) | Capture, the recogniser contract, the dialog |
| [Security](security.md) | The authentication boundary and its threat model |
| [Platform](platform.md) | The operating-system seam and the X11 backend |
| [Development](development.md) | The dev loop, tests, the simulator harness |

## Decision records

[`decisions/`](decisions/) holds one short record per design choice: context, decision,
alternatives considered, consequences.

- [Blank the tiles under the overlay](decisions/blank-tiles-under-overlay.md)
- [Enrolled keys are capped, and an over-cap registry refuses to start](decisions/client-cap.md)
- [Client-drawn glasses menu instead of the firmware menu](decisions/client-drawn-glasses-menu.md)
- [The CORS default follows authentication](decisions/cors-follows-auth.md)
- [Renamed from even-window to pinhole-window](decisions/rename-to-pinhole-window.md)
- [The default application is a dark xterm with a bold bitmap font](decisions/default-terminal-client.md)
- [The display session outlives the server](decisions/display-session-outlives-server.md)
- [The env file is a parsed subset of systemd's EnvironmentFile](decisions/env-file-format.md)
- [Establish once, never rebuild a live page](decisions/establish-once.md)
- [Instance supersede](decisions/glasses-instance-supersede.md)
- [Link and pause gating](decisions/glasses-link-gating.md)
- [Harness runs: auth off in `sim.sh`, own registry, no operator config](decisions/harness-auth-and-isolation.md)
- [4-bit indexed PNG tiles](decisions/indexed-png-tiles.md)
- [Instrument flags are read from the URL only](decisions/instrument-flags-query-only.md)
- [A monocle window manager on a panel-sized desktop](decisions/monocle-window-manager.md)
- [The server does not terminate TLS](decisions/no-tls-termination.md)
- [Only the open routes are rate limited](decisions/open-route-rate-limit.md)
- [The packaged app mirrors an extractable private key](decisions/packaged-app-key-mirror.md)
- [Pairing is approve-then-enrol, with randomart drawn by each side](decisions/pairing-randomart.md)
- [Phone UI: hardware keyboard input has no mode](decisions/phone-hardware-keyboard.md)
- [Phone UI: native buttons and imported chrome](decisions/phone-native-button-chrome.md)
- [Phone UI: palettes as the phone-side route to glasses-only UI](decisions/phone-palettes.md)
- [Phone UI: relative vPad, absolute mirror touch](decisions/phone-pointer-surfaces.md)
- [Phone UI: the submit key is a closed, per-app list](decisions/phone-submit-key.md)
- [Phone UI: vPad uses a modal button selector and one-shot modifiers](decisions/phone-vpad-button-selector.md)
- [Phone UI: vPad modifiers are latched on the pad](decisions/phone-vpad-latched-modifiers.md)
- [Neutral route and field names, X keysym names for keys](decisions/platform-wire-vocabulary.md)
- [Quadrant tiles](decisions/quadrant-tiles.md)
- [Revocation is immediate: the registry is cached behind a stat](decisions/registry-stat-cache.md)
- [The Even Hub SDK is not pre-bundled by Vite](decisions/sdk-not-prebundled.md)
- [Separate input and overlay layers, always z-ordered](decisions/separate-input-and-overlay-layers.md)
- [The session signature names its destination](decisions/session-origin-binding.md)
- [A separate short-lived ticket opens the stream](decisions/stream-ticket.md)
- [The recogniser is a URL, and the server proxies to it](decisions/stt-backend-contract.md)
- [Swipe bindings use a closed key set and structured chords](decisions/swipe-bindings-closed-key-set.md)
- [Serial tile pump with encode at dequeue](decisions/tile-pump-latest-wins.md)
- [The voice dialog is a view of the phone's text box](decisions/voice-dialog-design.md)
- [Window identity is derived, never stamped on the window](decisions/window-identity-without-stamping.md)
- [Wire additions are optional fields and ignorable events](decisions/wire-additions-are-optional.md)

## Notes

[`notes/`](notes/) holds dated measurements and investigation logs. Each is a snapshot of
what was observed at the time and is not kept in sync with the code.

- [Application scan measurements](notes/2026-10-application-scan.md)
- [Launcher and palette checks in the simulator](notes/2026-10-apps-and-palettes-sim-verification.md)
- [Choosing the benchmark workload](notes/2026-10-bench-workload-selection.md)
- [Client tile pipeline measurements](notes/2026-10-client-tile-pipeline.md)
- [Firefox minimum width investigation](notes/2026-10-firefox-minimum-width.md)
- [Gestures and the firmware menu](notes/2026-10-gestures-and-firmware-menu.md)
- [Glasses container semantics observed on hardware](notes/2026-10-glasses-container-semantics.md)
- [Link loss, establish and recovery on hardware](notes/2026-10-glasses-link-and-establish.md)
- [Key probe: Bluetooth keyboard and trackpad in the Even App WebView](notes/2026-10-keyprobe-ios-hardware-input.md)
- [Phone UI chrome and layout](notes/2026-10-phone-chrome-and-layout.md)
- [Phone palette layout measurements](notes/2026-10-phone-palette-layout.md)
- [Phone touch layer findings](notes/2026-10-phone-touch-layer.md)
- [Polarity measurements](notes/2026-10-polarity-measurements.md)
- [Simulator harness traps](notes/2026-10-simulator-harness-traps.md)
- [Simulator input envelopes and overlay checks](notes/2026-10-simulator-input-and-overlay-checks.md)
- [Per-app swipe bindings](notes/2026-10-swipe-bindings.md)
- [Tile transfer timing on hardware](notes/2026-10-tile-transfer-timing.md)
- [Version skew, window recency order and instance supersede](notes/2026-10-version-skew-and-window-order.md)
- [Voice capture measurements](notes/2026-10-voice-capture-measurements.md)
- [Recogniser benchmarks](notes/2026-10-voice-recogniser-benchmarks.md)
- [Typing non-ASCII text, and how the lens draws transcripts](notes/2026-10-voice-text-typing-and-lens-text.md)
- [vPad and mirror touch: pointer, modifier and wheel measurements](notes/2026-10-vpad-pointer-and-wheel.md)
- [Authentication: design reasoning](notes/2026-11-auth-design-reasoning.md)
- [Authentication gate: measured behaviour](notes/2026-11-auth-verification.md)
- [Authenticated curl checks](notes/2026-11-authenticated-curl-checks.md)
- [X11 backend measurements](notes/2026-11-x11-backend-measurements.md)
- [Speech service device and model placement](notes/2026-11-speech-service-setup.md)
- [Phone-microphone fallback: findings and hardware check](notes/2026-11-voice-phone-mic-fallback.md)
