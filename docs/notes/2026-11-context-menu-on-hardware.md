# The context menu on hardware

Snapshot — not maintained. Conditions: Even G2, SDK 0.0.16, the Even App current on
2026-11-28 (version not recorded), a probe page served by the dev server; observations of
2026-11-28. Simulator figures are from Even Hub simulator 0.9.5 on the same day.

It corrects two findings of
[gestures and the firmware menu](2026-10-gestures-and-firmware-menu.md): that no gesture opens
the firmware menu, and that a page cannot carry both `menuObject` and `zOrderIndex`.

## The probe

One page, rebuilt into four layouts from buttons on the phone:

| Layout | `menuObject` (4 items) | `zOrderIndex` |
| --- | --- | --- |
| A | yes | no (one text container) |
| B | yes | yes (the app's six containers) |
| C | no | yes (the app as shipped) |
| D | no | no |

## What was seen on the glasses

| Question | Result |
| --- | --- |
| What opens the menu | Tap, then long press. A long press alone does not |
| A page with no `menuObject` (C) | The menu opens with the system rows only |
| A page with `menuObject` and `zOrderIndex` (B) | Accepted (`rebuild => true`), and the menu opens with the four items |
| Row order | Display off, the app's items, Brightness, Close |
| Focus at the last row | A swipe down goes to the first row: the list wraps |
| Selecting an item | `FOREGROUND_ENTER` (4), `menuItemClickEvent` with the `itemID`, `FOREGROUND_EXIT` (5) about 0.3 s later |
| Opening and closing without a selection | `4`, then `5` on close, nothing between |
| A long press with no tap before it, menu registered | Reaches the app: `eventType` 9 then 10, with `eventSource` |

`createStartUpPageContainer` answered `1` throughout, because the app had already created a
page in that glasses-UI lifetime; each layout became live through the rebuild.

## Not distinguishable from a notification

One `4`/`5` pair in the same session lasted 5.157 s with no menu open: the fixed length of a
phone notification on the lens, as in the October note. The two events say that a layer came
and went, not which one. Only `menuItemClickEvent` identifies the menu.

## Simulator differences

- The simulator draws only the app's items. It has no system rows, so row order and the
  distance to Close cannot be judged there.
- With no `menuObject` it draws an empty frame.
- It opens the menu from its own `context_menu` input, not from a gesture.
- It wraps at the ends too, in both directions, and delivers the same three events on a
  selection.
