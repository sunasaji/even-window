# Gestures and the firmware menu

Snapshot — not maintained. Conditions: Even G2, Even App v2.3.2, SDK 0.0.16, Even Hub simulator 0.9.5; observations of 2026-10-10 to 2026-10-17.

Reference: [glasses.md](../glasses.md#gestures), [glasses.md](../glasses.md#on-glasses-menu).

## Raw envelopes

Simulator 0.9.5, `?debug=1`; the automation API and the simulator's button row produce identical
envelopes, and the `double_click` envelope is byte-identical to the one a real G2 sends
(`{"sysEvent":{"eventType":3,…}}`).

| Input | Raw envelope | Firmware menu |
| --- | --- | --- |
| `double_click` | `{"jsonData":{"eventType":3,"eventSource":1},"sysEvent":{"eventType":3,"eventSource":1}}` | does not open |
| `click` | `{"jsonData":{"eventSource":1},"sysEvent":{"eventSource":1}}` (code 0 omitted) | does not open |
| `long_press` / `long_press_release` | `eventType` 9 / 10 | does not open |
| `up` / `down` | `textEvent` with `containerID:1, containerName:"input", eventType:1\|2` | does not open |
| `context_menu` (the simulator's separate `Menu` button) | `sysEvent.eventType` 4, then 5 on close | opens |
| a menu selection | `{"jsonData":{"itemID":3},"menuItemClickEvent":{"itemID":3}}`, no `sysEvent` | — |

Swipes arrive as `textEvent` because the capture layer is a text container; this is why the
omitted-zero tap default is honoured for any of the three protobuf envelopes, not for `sysEvent`
alone. Writing the default as `event.sysEvent?.eventType ?? CLICK` would report a tap for every
event without a `sysEvent` (foreground, exit and audio pushes).

Real swipe input: five quick swipes produced two requests, `count=1` and `count=4`.

## No gesture opens the firmware menu

All six gestures were swept in the simulator; only the separate `context_menu` input opens the
firmware context menu. Long press was swept on hardware (2026-10-12), because SDK 0.0.14 added
both the context menu and the long-press events and 0.0.15 made long press keep its
`eventSource`:

| Input | Received | Menu |
| --- | --- | --- |
| Right temple long press | `eventType=9 source=1`, then `10` | no |
| Left temple long press | `eventType=9 source=3`, then `10` | no |
| Ring long press | `eventType=9 source=2`, then `10` | no |

No `eventType` 4 or 5 fired during the sweep. What does open the firmware menu on hardware was
never found (candidates: the ring's button, the Even App UI). The question stopped mattering
once the menu was drawn by the client.

While the firmware menu is open (simulator), gestures do not reach the app: an `up` produced no
envelope in the log, yet the firmware's selection moved. "Double tap goes up one level inside the
menu" is therefore impossible on the firmware side.

## Event types 4 and 5 are "a foreground layer came and went"

75 s after the long-press sweep, `eventType=4` then `5` arrived with no preceding gesture and no
`menuItemClickEvent`. The operator reported a phone notification appearing on the glasses and
folding away. Four pairs in that session:

| | `4` | `5` | Interval |
| --- | --- | --- | --- |
| 1 | 22:44:16.718 | 22:44:21.876 | 5.158 s |
| 2 | 22:51:31.368 | 22:51:36.525 | 5.157 s (operator confirmed the notification live) |
| 3 | 22:52:43.905 | 22:52:49.063 | 5.158 s |
| 4 | 22:53:34.872 | 22:53:40.029 | 5.157 s |

Identical to the millisecond: a layer on a fixed timeout, not a person closing a menu. Other
durations seen:

| Duration | Count | Notes |
| --- | --- | --- |
| 5.16 s | 4 | above |
| 3.44 s | 3 | 2026-10-17 (3.444 / 3.416 / 3.450 s); source unidentified |
| 3.78 s, 7.59 s | 1 each | 213 ms apart; unidentified |

- Duration does not identify the kind of layer.
- The app's own return to the foreground was not shown to emit the pair, and the client's own
  text overlay is not a foreground layer.
- The documentation had long said "event 4 is the one objective sign that the menu opened". That
  was wrong. The proof of a menu is `menuItemClickEvent`. Had "blank the tiles on event 4" been
  implemented, every notification would have blacked the mirror.
- A notification banner scrolls down from the top and scrolls away leaving the picture intact:
  the firmware composites over the image containers. That is why the diff baseline is not reset
  on exit. If that ever proves wrong, the symptom is a quadrant that was static under the banner
  staying stale, and the fix is `forcePending = true` on exit.
- Before the pump stood down for the layer, 10-13 pushes (about 15 KB) were sent under each
  banner, five banners in ten minutes. The pump stops all four quadrants although the banner
  covers only the top; its height is not reported, so about 5 s of freeze was preferred.

## The firmware menu design that was removed (2026-10-13)

`menuObject` exists only as an argument of create and rebuild; there is no incremental update.
While it was used:

- every change of the item set required a `rebuildPageContainer`, gated by a signature that
  excluded focus (`menuSignature`) and a 1.5 s settle, and wrapped in stand-down, rebuild,
  baseline reset, repaint;
- establish waited up to 1.5 s for the first window and app lists so the menu was not registered
  empty and rebuilt a second later (measured: `apps` arrives a few ms after `windows`; waiting
  for windows only paid the extra rebuild every time);
- a hierarchy would have cost a rebuild plus four tiles per level, and a selection closes the
  firmware menu;
- limits: 10 items, non-zero unique `itemID`, labels of at most 32 UTF-8 bytes. The client-drawn
  root list still honours them.

It was removed because the host refuses `menuObject` together with `zOrderIndex`
([container note](2026-10-glasses-container-semantics.md)) and no hardware input opened it.
Navigating the client-drawn hierarchy costs one text push per level and no image push
(simulator: five levels down, five text pushes, zero image pushes).

Launcher rows are "most recently launched" rather than phone-assigned favourites because the
set then changes only when a window also appears (no extra update), no second write surface is
needed, and a fresh install is never empty. The cost: the list cannot be pinned.

Window rows are drawn most-recently-focused first because the window manager's numbering is
roughly launch order and each row costs a swipe. The order is produced by the server; a client
talking to an older server degrades to server order.

## Row budget

Measured on the simulator's glasses framebuffer (2026-10-12), then confirmed on a G2: a level
drawn as header + 9 rows + `< Back` renders 11 lines and the last is clipped at the bottom edge.
The panel holds 10 full lines: 1 header + 8 content rows + `< Back`.

From hardware use: selecting `Help (keys)` showed the window manager's key map behind a menu
that stayed up, unreadable; hence rows whose effect lands on the mirrored desktop close the menu
first. Page rows enumerate their keys with spaces (`a b c d …`) because the panel font is
proportional, and carry no `...` marker because `.` is itself a selectable key on the
punctuation page.

## Double tap appears to do nothing

With a one-second clock mirrored, in the simulator and on hardware:

| Action | Glasses |
| --- | --- |
| One double tap | Mirror stops (three consecutive identical screenshots); the list is readable over the tiles |
| A second one | Mirror resumes |
| Two double taps 150 ms apart | Looks as if nothing happened: opened, then closed 152 ms later |

Count the `gesture double` lines in the `?debug=1` log to settle it. A related early report,
"double tap sometimes does not respond", was the host's leading click being accepted as a tap
before the double; a tap within 180 ms of a double is now dropped.

A further cause of "gestures do nothing" seen in development: the server and the client were
built from different commits.

## Persisted flags

Three persisted flags caused incidents: `menu` and `zorder` (a WebView that once ran with an old
default kept it forever, so the hierarchy menu failed to appear on one device; the storage key
was renamed twice) and `stats` (the mosaic incident in the
[timing note](2026-10-tile-transfer-timing.md)). The WebView is recreated often (5 boots in a
7-minute session), so settings must persist, but instruments must not. The boot log names every
setting that came from storage rather than the URL (`sticky:`).
