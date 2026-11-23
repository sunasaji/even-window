# Phone UI: vPad uses a modal button selector and one-shot modifiers

## Context

vPad first mapped long-press to right click and had no middle button. Athena and Motif menus
(xterm's own menus, xfontsel, older X software) are operated by pressing a button, dragging
and releasing; xterm's menus additionally need Ctrl held. Middle click is the only way to
paste the X11 primary selection.

## Decision

- Three pills select the active button (left, middle, right). Taps and holds use it. The
  selection is sticky: no automatic return to left, and it survives closing the pad.
- A long press, or a tap followed by a drag, is press-and-hold of the selected button. These
  are two entries to one state with one release path.
- Ctrl/Alt armed in the keys panel compose with the next tap, hold or wheel drag as separate
  `keydown` / `keyup` injections, one-shot, like everywhere else in the UI.
- Held state is released unconditionally and all presses and releases share one queue.
- Two-finger scroll direction is a toggle (default natural); the edge strip's direction is
  fixed, because a scrollbar-shaped control has only one meaning for "down".

## Alternatives considered

- Long-press = right click: removes press-drag-release for every button.
- Three momentary buttons that click at the current position: cannot hold a button.
- Returning to left after each click: a silent state change is more surprising than a visible
  mode.
- Modifiers that stay armed for the whole pad session: the overlay hides the keys panel, so
  every later tap would be an invisible `ctrl+click`.
- Two-finger drag as Up/Down keys to the focused window: a pointer gesture should act where
  the pointer is; swipes can be bound to keys or the wheel instead.

## Consequences

- Mode errors are possible; the lit pill and the hint line name the active button.
- Two modified actions in a row require closing the pad to re-arm.
- With the natural default, two-finger and strip disagree on "up" out of the box, as on macOS.
