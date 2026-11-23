# Per-app swipe bindings

Snapshot — not maintained. Conditions: X11 backend (nested X with ratpoison, xdotool), development machine and simulator, 2026-10-10 to 2026-10-15.

Reference: [glasses.md](../glasses.md#per-app-swipe-bindings).

## No single property identifies an application

The first version keyed on process name and window class. `xmountains` has neither: `xprop`
returns only WM_STATE, WM_NAME and WM_PROTOCOLS, and `xdotool getwindowpid` answers "window
10485761 has no pid associated with it". It is focused and named on screen with nothing to bind
to. Hence five key kinds, most specific first: `app:`, `exe:`, `comm:`, `cls:`, `title:`.

- `app:` is the only one that separates by argv (`term htop` and `term btop` share comm, exe and
  class). The server remembers what it launched and claims the window when it appears; nothing is
  written on the window and polling costs nothing extra. Windows started another way fall back
  to `exe:`.
- `comm:` is kept below `exe:` because it fails differently: the exe symlink of another user's
  process is unreadable, comm is not.
- `cls:` needs no pid. `ratpoison -c 'windows %c'` returns the second WM_CLASS string (xterm:
  `"xterm","XTerm"` -> `XTerm`; Firefox: `"Navigator","firefox"` -> `firefox`) and the literal
  string `None` for a window without a class, which must be read as "no class" or `cls:none`
  becomes a key shared by every classless app.
- `title:` is a candidate only when none of exe, comm, cls resolved: terminals rewrite their
  title per command, so a title binding made while `vim` was in the title would be listed,
  plausible and dead a moment later. `app:` does not suppress it, because the launch claim lives
  in memory and a window whose only other identity is `app:` would become unbindable after a
  server restart.
- Both `comm:` and `cls:` are candidates even when they spell the same word. Skipping the
  duplicate made a stored `cls:firefox` unreachable (Firefox reports comm `firefox` and class
  `firefox`).
- Rejected: the window id (stable only for the window's lifetime) and the window manager's
  number (reused).
- Old applications tend to lack `_NET_WM_PID` and to provide ICCCM `WM_COMMAND`; xterm's full path
  was obtained from the latter.

## Identity is resolved once per window lifetime

pid, comm and exe are resolved the first time a window is seen and dropped when it closes.
Negative results are cached too; otherwise a window like xmountains pays two process spawns per
poll forever to relearn that there is nothing to learn.

Measurement (2026-10-11), 30 s idle, child CPU from `cutime + cstime` in `/proc/<pid>/stat`
(reaped children only, so the long-lived capture process is excluded):

| | Windows | Child CPU in 30 s | Per second |
| --- | --- | --- | --- |
| With cache | 5 | 0.28 s | 9.3 ms |
| Without cache | 1 | 0.50 s | 16.7 ms |

About 8-9 ms per spawn; two spawns per tick became one (44 % less). The conditions are unequal
(more windows make the window listing dearer), which biases the result against the cache, so
the direction is safe. Resolution has since dropped further, to once per window.

A swipe resolves the focused window at gesture time (one `xdotool getwindowfocus` plus a cache
read) rather than from the 1 Hz window list: reading the list sent the previous app's key on the
first swipe after a window switch.

## Closed key set

The low-level key route passes unknown key names through by design. For stored bindings that is
the worst failure: `Pagedown`, `ArrowUp` or `Ctrl` save cleanly and send nothing, surfacing days
later as "the feature is broken". Names in the catalogue are the xdotool spellings (`Return`,
`Page_Up`, `minus`), so what is stored is what is sent; `C-u` style text is display only.
`super` is excluded as the one modifier a host window manager is likely to grab.

Two warnings the editor shows: move-N repeats whatever is bound (`Return` bound to a swipe makes
five swipes five commands), and Shift plus a character key is a different character.

## Wheel bindings (requested 2026-10-15)

`WheelUp` / `WheelDown` are catalogue entries executed as pointer button 4 / 5 clicks, with
modifiers held around the clicks (`ctrl` + wheel zooms in many clients). They reach
wheel-only consumers (terminal scrollback, toolkit lists, PDF viewers), but act on the window
under the pointer; with a single maximised window that is normally the focused one. They are the
only catalogue names that are not key spellings: `xdotool key WheelUp` is accepted and does
nothing, so the executor must branch on `wheelButton()`.

Simulator end to end: `*` bound to the wheel, `POST /api/input {up, count:3}`, server log
`action=wheel button=4 via=*`, and the terminal scrollback moved three notches.
