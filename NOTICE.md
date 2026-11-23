# NOTICE

even-window is MIT licensed; see [LICENSE](LICENSE).

## Code derived from heimterm

Portions of even-window are derived from **heimterm** (MIT, (c) 2026 Suna.S), by the same
author. Attribution is kept here, per file, rather than in source comments.

| even-window | Derived from (heimterm) |
| --- | --- |
| `src/server/auth.ts` | `src/server/auth.ts` (near-verbatim, minus the connection-history surface) |
| `src/client/authClient.ts` | `src/authClient.ts` (near-verbatim) |
| `src/client/pairingUI.ts` | `src/pairingUI.ts` (flow kept, phone-helper chrome dropped) |
| `scripts/ew-auth.mjs` | `scripts/heim-auth.mjs` |
| `src/server/main.ts` | `serve.ts`, `src/server/api.ts` (bare HTTP server and route table pattern) |
| `src/server/stream.ts`, `src/server/tiles.ts`, `src/server/png.ts`, `src/server/windows.ts` | `src/server/x11.ts` (stream subscription, frame processing, PNG encoder, window identity) |
| `src/server/input.ts` | `src/nodeDescriptor.ts` (key-name translation) |
| `src/server/platform/x11/{session,xenv,windows,input}.ts` | `src/server/x11.ts`, `src/server/app.ts` (nested X lifecycle, capture, window control, input injection) |
| `src/shared/establishPage.ts` | `src/establishPage.ts` |
| `src/shared/evenEvent.ts` | `src/evenEvent.ts` |
| `src/shared/geom.ts` | `src/glyph.ts` |
| `src/shared/glassMenu.ts` | `src/menuGesture.ts`, `src/main.ts` (menu definition) |
| `src/shared/latestAsyncWriter.ts` | `src/latestAsyncWriter.ts` (copied whole) |
| `src/client/{glassPage,pump,tiles,grey}.ts` | `src/main.ts` (page establish, tile push, frame pump, palette and grey ramp) |
| `src/client/{navDebounce,gestures}.ts` | `src/main.ts`, `src/agentHistory.ts` (swipe debounce, ring de-burst, gesture gate) |
| `src/client/{chrome,oskb,vring,vpad}.ts` | `src/main.ts` (button chrome, toast, on-screen keyboard, virtual ring, virtual trackpad) |
| `index.html` `<style>` | `index.html` `<style>` (page shell, press-to-invert) |
| `scripts/ew-firefox.sh` | `scripts/heim-firefox.sh` |
| `scripts/firefox-profile/user.js` | same path (minus vertical tabs, Marionette and the Dark Reader scopes) |
| `scripts/firefox-profile/chrome/userChrome.css` | same path (plus the minimum-width release; see `docs/firefox.md`) |
| `scripts/firefox-profile/chrome/userContent.css` | same path (minus the Dark Reader layer) |

## Third-party projects cited (no code included)

The documentation cites two other G2 projects. No code from either is included in this
repository.

- **Glyph** — <https://github.com/gabrielevierti/glyph> (MIT). Cited for a design comparison.
- **g2-engine** — <https://github.com/Jadoking/g2-engine> (MIT). Only its published hardware
  measurements and the SDK limits it documents are cited.

## Trademarks

even-window is **not affiliated with or endorsed by Even Realities.** "Even Realities" and
"G2" are trademarks of their respective owner. This project talks to hardware the author
owns, over a protocol surface exposed by the vendor's own published SDK.
