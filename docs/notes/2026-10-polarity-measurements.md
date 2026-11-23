# Polarity measurements

Snapshot — not maintained. Conditions: 2026-10-10, simulator 0.9.5, 576x288, one terminal
showing `ls` output; lit = alpha > 127 in the glasses screenshot.

The lens is optical see-through: black emits nothing and is transparent. A light-background
window lights the whole lens.

| Frame | lit | dark |
| --- | --- | --- |
| Default dark terminal, invert off | 2.53% | 97.47% |
| Same, invert on | 97.93% | 2.07% |
| `xterm -bg white -fg black`, invert off | 97.93% | 2.07% |
| Same, invert on | 2.53% | 97.47% |

Light-background applications measured the same way: `xfontsel` / `xcalc` about 96.95% lit.

Command (luma is useless here; the content is in alpha):

```bash
ffmpeg -v error -i glasses.png -vf alphaextract -pix_fmt gray -f rawvideo - \
  | od -An -v -tu1 | tr -s ' ' '\n' | sed '/^$/d' \
  | awk '{n++; if($1>127) hi++} END{printf "lit %.2f%% / dark %.2f%%\n", 100*hi/n, 100*(n-hi)/n}'
```

## Choice of the default terminal

The default client is `xterm` with a 9x18 bold core bitmap font (64x16 cells at 576x288),
black background. Given the same core font, `xterm` and `urxvt` produced identical output
(raw grey planes compared with `cmp`). The deciding difference is failure behaviour: without
the font, `urxvt` exits with `unable to load base fontset … aborting` (nothing left to
mirror), while `xterm` falls back to `fixed` and keeps running.

## Toggling

Toggling invert resets the diff baseline and repaints all four tiles; without that,
quadrants that did not change keep the old polarity. In the log, `invert on` is followed by
pushes of TL, TR, BL and BR.
