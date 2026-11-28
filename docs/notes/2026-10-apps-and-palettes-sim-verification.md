# Launcher and palette checks in the simulator

Snapshot — not maintained. Conditions: 2026-10-10 (launcher, keyboard following) and
2026-10-20 (palettes); simulator 0.9.5; isolated run on display `:191`, server 8791, Vite
5291, automation 9909, simulator display `:186`. Click coordinates are from those days'
layouts.

```bash
PINHOLE_X11_RUNTIME_DIR=/tmp/pw-pal PINHOLE_STATE_DIR=/tmp/pw-pal/state \
  scripts/sim.sh --headless --keep --port 5291 --api-port 8791 \
                 --display :191 --sim-display :186 --automation-port 9909
```

## Launching (2026-10-10)

| Action | Observed |
| --- | --- |
| Phone `apps` → filter `xfontsel` → tap the row | `[pw] spawn id=x11:xfontsel xfontsel => ok`; xfontsel in the mirror after about 1 s; toast `xfontsel started — watch the mirror` |
| Launcher row chosen on the glasses | `[pw] spawn id=desktop:debian-xterm xterm => ok`, two windows |
| Right after a launch | The window list change and the recency update arrived as one menu update |
| `POST /api/spawn` with a command outside the scanned set | `403`, `spawn refused: bash is not a scanned application (45 known; GET /api/apps)` |

The 403 is not a security boundary; authentication is
([security.md](../security.md)).

## Palettes (2026-10-20)

`task`, `window` and `apps` are DOM in the browser panel, readable with
`screenshot/webview`. That day: `xdotool mousemove 482 23 click 1` (window), `418 23`
(task), `381 473` (lens latch).

| Action | Observed |
| --- | --- |
| `window` | 9 rows (`Help (keys)` … `Kill (force)`, `Close Window`), key hints in a faint right column, footer `acting on: xterm` |
| One tap on `Kill (force)` | Row turns red, `Kill it - confirm` / `tap again` |
| `Redisplay` | `window palette CLOSE (acted)` → `window palette ratpoison l => ok` |
| `task` | `* 9menu` / `xterm` / `bitmap` most-recent-first, class in the right column, filter box |
| `POST /api/spawn` while a palette is open | The new window appears at the top in place (missing in the first implementation; found by this check) |
| Tap a `task` row | `task palette CLOSE (switched)` → `select xterm => ok` |
| Lens on → off | `tiles blanked: 4 push(es)/636B in 18ms` → `overlay text => true`; glasses show `mirror paused (paused by you)` / `use the phone: task / window / apps`; the phone preview stays live |
| Lens off → on | `lens ON — baseline reset, tiles flow again` |
| Double tap → `Menu...` | First level `Keys... / Window... / [ ] Invert / Close Window / Exit...` |
| Boot log | `device info: model=g2 sn=…` / `device: connected battery=100% wearing=true` |

Not verifiable in the simulator: link drops, `isWearing: false`, battery share.

## Keyboard following of the `apps` palette (2026-10-10)

WebKitGTK has no soft keyboard, so `window.visualViewport` never changes in the simulator.
Two substitutes, neither of them the device:

| Method | What it verifies |
| --- | --- |
| Replace `visualViewport` before page load (`Object.defineProperty` with an `EventTarget`, then change `offsetTop` / `height` and fire `resize` / `scroll`) | The same shape of input as a real keyboard: layout viewport unchanged, visual viewport shrinks or shifts |
| Shorten the window (CDP `Emulation.setDeviceMetricsOverride`) | The real `resize` path, but the layout viewport shrinks too, so keyboard detection does not trigger |

Headless Chrome with `--remote-debugging-port` and Node's built-in `WebSocket` needs no extra
dependency. Measured at 390x844 and 360x740 (`max-h` then subtracted a 48 px reserve that no
longer exists; the point is that `top` follows `offsetTop` and only the list shrinks):

| Visual viewport | Panel | Filter box top | List height |
| --- | --- | --- | --- |
| 844, no keyboard | top 0 / max-h 796 | 58 | 650 |
| 508, keyboard 336 | top 0 / max-h 460 | 58 | 314 |
| 436 with `offsetTop` 72 (iOS style) | top 72 / max-h 388 | 130 | 242 |
| 360 px wide, keyboard 300 | top 0 / max-h 392 | 58 | 246, no horizontal scroll |

Opening adds two `visualViewport` listeners; closing must return to zero.

Regression geometry: a hardware screenshot (iPhone, 1179x2556 = 393x852 CSS) was reproduced
exactly by injecting a visual viewport height of 370 with the layout viewport left at 393x852.

| | Row height | Panel | List | Fully visible rows | Page buttons showing below |
| --- | --- | --- | --- | --- | --- |
| As reported | 40 | 0–322 (48 short of 370) | 176 | 4 | 11, readable through a 0.55-alpha backdrop |
| After the fix | 32 | 0–370 | 260 | 8 | 0 (opaque backdrop) |

Rows visible in the same 260 px list by row height: 40 → 6, 36 → 7, 34 → 7, 32 → 8, 30 → 8.
32 is the floor: 30 adds no row.
