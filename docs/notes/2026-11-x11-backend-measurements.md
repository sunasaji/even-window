# X11 backend measurements

Snapshot — not maintained. Conditions: one development machine, WSL2 with WSLg, Debian-family userland, nested X server at 576x288 (Xephyr unless stated), ratpoison, xdotool, ffmpeg x11grab, Node.js 20+. Collected from source comments during development; individual measurements are undated unless a date is given.

## Default terminal and font

Method: frames captured from the nested display with ffmpeg x11grab and compared byte for byte.

| Finding | Detail |
| --- | --- |
| xterm vs urxvt, same X core bitmap font | Pixel-identical frames (raw grey planes equal under `cmp`). Rendering is not a reason to prefer either |
| Missing font, urxvt | Prints `unable to load base fontset … aborting` and exits; the desktop has nothing to mirror |
| Missing font, xterm | Falls back to `fixed` and still opens |
| 9x18 bold (`-misc-fixed-bold-r-normal--18-120-100-100-c-90-iso10646-1`) | 64x16 cells on 576x288 |
| 9x15 bold | The same 64 columns, glyphs 20% shorter |
| 10x20 | 57 columns (7 fewer); no bold face in misc-fixed |

Conclusion: xterm with 9x18 bold. The tiebreak between terminals is failure behaviour.

## ratpoison

- **Key help length.** `C-t ?` draws one line per binding with no paging. At `pixelsize=11` the
  panel shows about 20 lines. The stock keymap is 86 lines; with the `RP_UNBIND` list it is 38.
  That is still about two screenfuls, so the list is chosen to make the visible screenful the
  useful one: the eleven `select <digit>` / `select -` rows go first, then the `C-` twins of
  plain keys (`a` and `C-a` both run `time`, `k` and `C-k` both run `delete`, and so on), then
  `C-exclam`, the widest row.
- **Unbinding keys does not remove commands.** `ratpoison -c 'select N'` still works after
  `unbind 0` … `unbind 9`; verified on the live display.
- **Frame commands break the mirror.** After `C-t s`, `C-t S` or `C-t R` the mirror shows two
  half-drawn windows. `Q` (`only`) is kept bound as the repair.
- **Stock `C-t c`.** Runs `x-terminal-emulator`, which on a Debian desktop resolved to a
  single-instance D-Bus terminal: the new window opened on the host display, not the nested one.
- **Stock bars** are black on white, and the stock bar font (9x15bold) overflows a 576-wide
  screen.
- **Reattach.** A ratpoison started with an older rc keeps its keymap, so the `unmanage` and
  `unbind` commands are reapplied with one `ratpoison -c` call each on reattach.
- **`ratpoison -c help`** prints to stdout and draws nothing, which is why the menu sends the
  key sequence instead.
- **Prefix grab.** Sending the prefix and the key as two xdotool processes races through the
  grab; one process with two key sequences does not. A Shift left down turns `C-t k` (close)
  into `C-t K` (kill), hence `--clearmodifiers`.
- **No EWMH.** `xdotool getactivewindow` and `windowactivate` fail; `getwindowfocus` and
  `ratpoison -c 'select N'` work.
- **Window with no class.** `ratpoison -c 'windows %a|%c|%t'` on a display with xterm, Firefox
  and xmountains:

  ```
  0|xterm|XTerm|xterm
  1|Navigator|firefox|…Firefox
  2|None|None|Xmountains
  ```

  The literal `None` is ratpoison's rendering of "no WM_CLASS".

## A window with no identity

xmountains sets neither `WM_CLASS`, `_NET_WM_PID` nor `WM_COMMAND`. `xprop` on its window
returns only `WM_STATE`, `WM_NAME` and `WM_PROTOCOLS`, and `xdotool getwindowpid` answers
`window … has no pid associated with it`. xterm publishes its full path in `WM_COMMAND`.

Another user's window on the same display gives `/proc/<pid>/comm` (world-readable) but refuses
the `/proc/<pid>/exe` link.

## Launch attribution

A first version offered every unclaimed window to a pending launch. In a live run the launch
was claimed by a copy of the same program that was already open: the older window sorts first
and had never been claimed. The fix was to offer only windows seen for the first time.

Real launches put processes between the spawned pid and the window's pid: `sh -c 'xterm …'`
adds a shell, and with `xterm -e htop` the window belongs to xterm. Hence the walk up the
parent chain (bounded at 12 steps).

**X-Resource extension.** Xephyr advertises X-Resource 1.2, and `XResQueryClientIds` is the
only way to ask the server for a client's pid without window properties. It returned a pid only
for clients connected over a local (unix) socket: a test client on the abstract unix socket and
Xephyr itself answered, while ratpoison, xterm, Firefox and xmountains, all connected through
`127.0.0.1:100`, returned nothing.

## Typing non-ASCII text with xdotool

Method: `xdotool type` into `cat > file`, then compare bytes, so the result is what the
application received.

| Text | `--delay` | Result |
| --- | --- | --- |
| ASCII, 48 characters | default (12 ms) | 3 of 3 runs identical |
| Japanese, 26 characters | default (12 ms) | 3 of 3 runs dropped characters (20, 25 and 23 of 26 arrived) |
| Japanese, 26 characters | 25 ms | 1 of 3 runs dropped one character |
| Japanese, 26 characters | 40 ms | 8 of 8 runs identical |

Cause: a character with no keycode makes xdotool remap a scratch keycode, press it, and remap
again; the application must see the MappingNotify before the key press.

40 ms is a margin, not a threshold. The race depends on timing and load: the same string at the
default delay was byte-perfect on a Xephyr display and lossy on an Xvfb one. At 40 ms, 26
Japanese characters take about 1.0 s. ASCII text keeps the default.

Other xdotool figures: one invocation costs about 3 ms. A double click sent as two processes
routinely misses the double-click window through scheduling jitter; one invocation with
`--repeat 2 --delay 120` does not. Parallel `xdotool key` invocations interleave and the
application sees fewer keystrokes than were sent, so repeats are serial.

## Frame and tile diff cost

Per frame, 576x288 rgb24, measured on the same machine:

| Step | Time |
| --- | --- |
| Whole-frame comparison with the previous frame (`Buffer.equals`) | 0.016 ms |
| Quantise all four tiles through the lookup table | 0.66 ms in one measurement, 0.804 ms in another |
| PNG-encode four tiles | 0.65 ms |
| Compare four quadrants row by row against the previous frame | 0.120 ms |
| Compare four quadrants and quantise the one that changed | 0.311 ms |

At 10 frames per second an idle mirror costs about 0.16 ms of JavaScript per second with the
whole-frame comparison, against about 13 ms without it. Copying each frame into a preallocated
buffer avoids about 5 MB/s of garbage.

Both comparisons only skip work: raw-identical pixels are quantised-identical, so the set of
emitted tiles is unchanged.

Observed on a real G2: a clock that moves only in the left half of the screen produces pushes
for the top-left and bottom-left tiles only.

## X transport on WSLg

- `/tmp/.X11-unix` is a bind mount with mode `0777`, not `1777`. A new X server can fail with
  `_XSERVTransMakeAllCOTSServerListeners: failed to create listener for unix` and exit, or come
  up serving TCP only. With `-listen tcp` the display is usable as `127.0.0.1:<n>`.
- Xvfb on this machine creates no socket file, only an abstract socket. Testing for
  `/tmp/.X11-unix/X<n>` with `existsSync` reports "not running" for a live server. The abstract
  socket `@/tmp/.X11-unix/X100` exists and `DISPLAY=:100` connects through it.
- A display with no lock file and no socket file can still refuse a new server, when another
  process holds it through an abstract socket only.
- ffmpeg's pointer query fails on the nested server (notably Xvfb over TCP) and logs an error
  per frame unless `-draw_mouse 0` is given.
- The inherited environment carries `WAYLAND_DISPLAY=wayland-0`. GTK applications and Firefox
  then render on the host desktop and the capture shows an empty screen.
- Under a systemd user unit the environment has no `DISPLAY`, although the WSLg socket
  `/tmp/.X11-unix/X0` is usable. Keyed on the variable, every such start chose Xvfb. With socket
  discovery the log reads:

  ```
  [x11] no DISPLAY in the environment; mapping Xephyr into the host display :0
  [x11] started Xephyr on :100 via 127.0.0.1:100, 10fps
  ```

## Working directory of launched programs

An early version started every child in the runtime directory, so each shell opened at
`<repo>/.pw-x11`. systemd's `EnvironmentFile` does not run a shell, so `PINHOLE_SPAWN_CWD=~/work`
arrives as the literal string and has to be expanded by the server.
