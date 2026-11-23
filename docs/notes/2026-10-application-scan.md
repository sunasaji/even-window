# Application scan measurements

Snapshot — not maintained. Conditions: 2026-10-10, one development machine, WSL2, Debian-family userland with dpkg and snapd; counts are specific to the packages installed there.

## What the scan found

```
[ew] apps: 46 launchable (20 .desktop, 28/75 Section:x11, 0 user; 47 denied, 0 hidden, 2 dup)
```

| Source | Count | Breakdown |
| --- | --- | --- |
| `.desktop` files | 28 | `/usr/share/applications` 23, `~/.local/share/applications` 1, `/var/lib/snapd/desktop/applications` 4 (on `XDG_DATA_DIRS`) |
| of which became entries | 20 | 8 dropped: 6 with `NoDisplay=true`, 2 whose `TryExec` target does not exist |
| `Section: x11` and links libX11 | 75 | From 29 packages and 106 candidate binaries |
| of which passed the deny-list | 28 | 47 dropped |
| User-defined | 0 | No `apps.conf` |
| Duplicates (same argv) | 2 | `xterm` and `urxvt`, each found by both sources |
| Total | 46 | |

A full scan is three child processes (`dpkg-query -W`, one `dpkg -L` over the 29 packages, one
`ldd` over the 106 binaries) and took about 1.1 s. `ldd` reports transitive dependencies.

## Why `.desktop` files are not enough

Of the 107 libX11-linked binaries on `$PATH`, 102 have no `.desktop` file. The x11-apps suite
ships none, so `xfontsel`, `oclock`, `bitmap` and `editres` never appear through that source.

## Why the package section and not toolkit linkage

Debian's `Section: x11` was compared with a "links a GUI toolkit" heuristic on a sample:

- It accepted 11 of 11 wanted programs, including `rofi`, which links no toolkit.
- It correctly excluded `ffmpeg` (video), `convert` (graphics), `gs` (text), `pactl` (sound),
  `pango-view` (libs), `chafa` (graphics), `broadwayd` and `gtk-launch` (misc), and
  `memusagestat` (devel).

## How the deny-list was built

Each of the 75 commands was started with no arguments on an isolated `Xvfb :193`, left for
1.6 s, and the number of children of the root window was compared with the baseline.

| Class | Members | Observation |
| --- | --- | --- |
| `server` | X servers, daemons, window managers | A second window manager fights ratpoison; a daemon maps nothing |
| `query` | One-shot tools | No window, process exited. `xprop`, `xwd` and `xkill` stay alive with no window, waiting for a click, and look hung |
| `benchmark` | `ico`, `rendercheck`, `x11perf` | They do map a window, and repaint continuously, so all four tiles are dirty on every frame |
| `needs-args` | `xfd`, `xmessage`, `xmore`, `xmag`, `transset` | Need a font name, a message, a file, or a pointer selection |

All 28 remaining commands mapped a window and stayed alive.

## The scanned set is not a security boundary

The set contained `env`, from a `.desktop` entry whose `Exec` line is
`env TERM=xterm-256color byobu`, and `env` starts anything.
