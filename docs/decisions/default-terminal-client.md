# The default application is a dark xterm with a bold bitmap font

## Context

A fresh mirrored desktop needs something on it, and the same program wraps launcher entries
that need a terminal. The glasses are an optical see-through display: a black pixel emits
nothing and is transparent, a bright pixel emits light. A stock black-on-white terminal lights
the whole lens. Captured pixels are quantised to 16 colours, so antialiased glyph edges turn
into coloured fringes.

## Decision

The default (`DEFAULT_SPAWN_ARGV`, overridable with `EW_SPAWN`) is

```
xterm -bg black -fg white -cr white
      -fn -misc-fixed-bold-r-normal--18-120-100-100-c-90-iso10646-1 -bw 0 -b 0 +sb
```

- Light on dark, stated explicitly instead of inherited.
- The 9x18 bold core bitmap font: 64 columns by 16 rows, never antialiased, and bold strokes
  mean more emitting pixels per glyph.
- No border, inner margin or scrollbar: every pixel is mirror surface. A white cursor is an
  emitting block instead of a hole in the text.
- The font name is written out in full and contains no whitespace or shell syntax, because the
  same argv is also used as one shell command line and as a ratpoison alias.

## Alternatives considered

- **urxvt.** With the same core font it renders pixel-identical frames. It exits when the font
  is missing, leaving nothing to mirror; xterm falls back to `fixed`.
- **9x15 bold.** Same 64 columns, 20% shorter glyphs.
- **10x20.** Taller, but 57 columns and no bold face in the misc-fixed family.

## Consequences

- Entries marked as needing a terminal are launched as this argv plus `-e`, so they inherit the
  polarity and font.
- xterm is a required package.
- Measurements: [X11 backend measurements](../notes/2026-11-x11-backend-measurements.md).
