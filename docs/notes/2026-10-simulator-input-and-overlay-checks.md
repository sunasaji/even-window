# Simulator input envelopes and overlay checks

Snapshot — not maintained. Conditions: October 2026, Even Hub simulator 0.9.5, SDK 0.0.16,
client run with `?debug=1`; hardware comparisons on a G2 where stated. Some checks refer to
code paths that no longer exist (the firmware menu, a `zorder` flag); they are kept as
evidence and as reusable procedures.

## What each automation input sends

The simulator's button row is `Up | Down | Click | Double Click | Long Press | Menu | 📷`.
Each button and its automation action produced byte-identical envelopes.

| Input | Raw envelope | Firmware menu |
| --- | --- | --- |
| `double_click` | `{"jsonData":{"eventType":3,"eventSource":1},"sysEvent":{"eventType":3,"eventSource":1}}` | does not open |
| `click` | `{"jsonData":{"eventSource":1},"sysEvent":{"eventSource":1}}` (protobuf 0 omitted) | does not open |
| `long_press` / `long_press_release` | `eventType` 9 / 10 | does not open |
| `up` / `down` | `{"containerID":1,"containerName":"input","eventType":1\|2}` as `textEvent` | does not open |
| `context_menu` (the `Menu` button) | `{"jsonData":{"eventType":4},"sysEvent":{"eventType":4}}`, then `5` on close | opens |

- The `double_click` envelope is byte-identical to the one logged from hardware, so the
  simulator's double tap is the device's double tap.
- `sysEvent.eventType` 4 / 5 are foreground enter / exit. Hardware (2026-10-12) showed they
  also fire for notifications, so they do not prove a menu opened; `menuItemClickEvent` does.
  Selection envelope: `{"jsonData":{"itemID":3},"menuItemClickEvent":{"itemID":3}}`, no
  `sysEvent`.
- No temple gesture opens the firmware menu. What produces `eventType=4` on hardware was left
  open (candidates: the ring button, the Even App's own UI).
- When the firmware menu was in use: `context_menu` drew "xterm" / "BRAVO-016" / "Exit" above
  the tiles, `click` delivered `{"menuItemClickEvent":{"itemID":2}}`, and Exit logged
  `exit (shutDownPageContainer(1)) => true` (the simulator does not actually quit).
- Input before the page is established: `/api/input` answers `{"ok":true}`, the simulator
  logs `inject_input: no active event container`, nothing happens. Input is received by the
  transparent event-capture text container (container 1).

## Double tap pauses the mirror

With a one-second clock on the mirrored desktop:

| Action | Glasses |
| --- | --- |
| One double tap | Mirror stops (three consecutive screenshots byte-identical); overlay text readable |
| A second one | Mirror resumes |
| Two double taps 150 ms apart | Looks as if nothing happened: opened, closed 152 ms later |

Hardware behaves the same. The third row is settled by counting `gesture double` lines.

## Blanking the tiles under the overlay

Stopping the pump does not clear the panel; it keeps showing the last frame. The client
therefore pushes black tiles before drawing overlay text.

```bash
curl -s -X POST $A/api/input -H 'content-type: application/json' -d '{"action":"double_click"}'
sleep 3; curl -so during.png $A/api/screenshot/glasses
ffmpeg -v error -i during.png -vf alphaextract -pix_fmt gray -y during_alpha.png
```

| | Without blanking (the regression) | With blanking |
| --- | --- | --- |
| Glasses while open | Menu rows over frozen terminal text, hard to read (as reported from hardware) | Menu alone on black |
| Log on open | `overlay SHOW` → `overlay text => true` | plus `blank TL/TR/BL/BR=success/565B/…` and `tiles blanked: 4 push(es)/2260B in 19ms` |
| Moving the selection | | `tiles already blank — nothing to push` |
| On close | | all four tiles pushed again (`resetBaseline` → `repaintTiles`) |

The 19 ms means nothing (no radio link). Hardware estimate from the measured 75 ms + 0.038
ms/byte: about 96 ms per 565-byte tile, about 390 ms for four.

## `zOrderIndex` A/B

Two runs differing only in whether containers carried `zOrderIndex`:

| `zOrderIndex` | `create` | `rebuild` | Glasses PNG after showing the overlay |
| --- | --- | --- | --- |
| set | `0` | `true` | changes; menu text readable over the mirrored terminal |
| absent | `0` | `true` | byte-identical to before (overlay invisible) |

Hardware gave the same result, which made `zOrderIndex` mandatory. As a regression check for
changes to the z plan: judge by whether the glasses PNG changes, not by return values.

## Compositing order with a fake server

A stub API server on separate ports that never sends tiles:

| Condition | `textContainerUpgrade` returned | Glasses |
| --- | --- | --- |
| No tiles, text in container 6 | `true` | readable (alpha has 2 levels) |
| Black tile pushed to container 2 first, same text | `true` | empty (alpha has 1 level) |

The return value was `true` in the row where nothing was drawn.

## Simulator and SDK compatibility

The 0.9.5 binary contains `menuObject`, `MenuContainerProperty`, `menuItems`,
`MenuItemClickEvent`, `zOrderIndex` (with validation messages `duplicate zOrderIndex` and
`zOrderIndex must be set on all containers or none`) and `textColor`; it handles pages built
with SDK 0.0.16 without regressions seen.
