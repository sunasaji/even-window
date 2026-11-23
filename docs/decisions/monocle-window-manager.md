# A monocle window manager on a panel-sized desktop

## Context

The glasses panel is 576x288 and is covered by exactly four image tiles. Any window shown has
to fill that area; a window of another size would need scaling, which destroys bitmap text, or
cropping.

## Decision

The mirrored desktop is created at exactly the panel size, and the X11 backend runs ratpoison
on it. ratpoison shows one window at a time, full-screen, with no decoration, and is driven
entirely by commands (`ratpoison -c`) and a keyboard prefix. There is no "fit window to
viewport" step anywhere in the system.

The generated configuration removes the frame-splitting bindings (`s`, `S`, `R`, the
`M-arrow` family, `C-underscore`) so that the one-window invariant cannot be broken from the
keyboard, leaves the ratmenu popup unmanaged so that it stays compact in a corner instead of
being centred across the tile boundaries, and rebinds `C-t c` to the default application.

## Alternatives considered

- **Fitting each window to the viewport** (resizing or scaling it on selection). An extra
  operation per switch that the monocle layout makes unnecessary.
- **Keeping ratpoison's stock keymap.** Its split commands leave two half-drawn windows on the
  mirror and a pointer mapping that describes neither.
- **Managing the ratmenu popup.** ratpoison would centre it across the 288/144 tile boundaries,
  so every menu movement would repaint all four tiles.

## Consequences

- ratpoison does not implement EWMH, so `xdotool windowactivate` and `getactivewindow` do not
  work; window control goes through ratpoison commands and `getwindowfocus`.
- ratpoison window numbers are recycled, so the stable window id is the X window id and the
  number is resolved again on every operation.
- The unbind list also serves readability: the key help draws one line per binding without
  paging, and the stock keymap does not fit the panel
  ([measurements](../notes/2026-11-x11-backend-measurements.md)).
- A backend for another OS needs an equivalent: one window at a time, filling a panel-sized
  desktop.
