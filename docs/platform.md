# Platform

The server is OS-neutral above one interface. Below it, a backend owns everything that depends
on the operating system's desktop. One backend exists: X11, developed and tested on Linux.

| `process.platform` | Backend |
| --- | --- |
| `linux` | X11 |
| `win32` | None: the server starts and reports that there is nothing to mirror |
| anything else (macOS, the BSDs) | X11, untested. The server says so at start-up |

On a system other than Linux the X11 backend needs the same tools (an X server, ratpoison,
xdotool, ffmpeg). Two parts use what Linux and Debian offer when it is there and yield
nothing otherwise: process identity is read from `/proc`, so without it per-application
bindings and launch attribution do not apply and the default binding is used; and part of the
application list comes from dpkg, so without it the list is the `.desktop` files and
`apps.conf`.

A backend's job: keep a 576x288 desktop alive that outlives the server process, deliver its
pixels as raw frames, and let the server list, focus, close and drive the windows on it.

## The `Platform` interface

Defined in `src/server/platform/types.ts`; that file is the design. `platform/index.ts` picks
the backend at start-up and exports it as `platform`.

| Part | Members | Contract |
| --- | --- | --- |
| `session: DisplaySession` | `start(sink)`, `stopCapture()`, `info()` | `start` brings the desktop up or reattaches to the one a previous process left, then captures into the sink. It never rejects; failure is reported through `sink.avail`. Concurrent calls share one start. `stopCapture` stops capture only: the desktop and its applications stay up |
| `SessionSink` (given to `start`) | `frame(rgb24)`, `avail(state)` | A frame is `SCREEN_W` x `SCREEN_H`, rgb24, rows top to bottom, `FRAME_BYTES` long, valid only during the call |
| `windows: WindowControl` | `enumerate()`, `identify(wid)`, `focusedId()`, `select(sel)`, `close(sel?)`, `spawn(cmd, args)` | `enumerate` returns the managed windows in a stable order of the backend's own, without identity. `identify` is uncached; the caller caches per window lifetime. `close` asks, never kills. `spawn` starts a detached program on the mirrored desktop, argv verbatim with no shell, and returns its pid or 0 |
| `input: InputInjector` | `inject(kind, arg)`, `repeatKey(chord, n)`, `wheel(button, n, mods)`, `wmKey(key)` | Never reject; `false` on failure. `wheel` holds the modifiers around the whole burst and always releases them. `wmKey` returns `false` on a backend with no window-manager key surface |
| `processes: ProcessInspector` | `parentPid(pid)` | 0 when the process is gone or unreadable |
| `apps: AppCatalogue` | `list(force?)`, `byId(id)`, `launchArgv(app)`, `overridesPath()`, `seedCommand()` | `list` answers from a cache unless `force`. `launchArgv` includes any wrapper the entry needs |

What stays above the seam, so a backend does not implement it: slicing frames into tiles and
diffing them (`tiles.ts`), the per-window identity cache and focus recency (`windows.ts`),
launch attribution (`launches.ts`), launch recency (`appRecency.ts`), binding resolution, and
all of HTTP, authentication and the stream.

### Import direction

Nothing in `src/server/` outside `platform/x11/` imports from `platform/x11/`, except
`platform/index.ts`. `src/shared/` imports nothing from `src/server/` or `src/client/`.
`tests/architecture.test.ts` enforces both from the source text. A backend may import from
`src/shared/` and from OS-neutral helpers such as `src/server/stateDir.ts`.

The backend is loaded with a dynamic import because the X11 modules do work at import time
(creating the runtime directory, resolving the host display).

## The X11 backend

A nested X server with the ratpoison window manager, driven with xdotool and xprop, captured
with ffmpeg. Process identity comes from `/proc` and the application list from XDG `.desktop`
files and dpkg. Files:
`platform/x11/{session,xenv,windows,input,proc,apps,desktop}.ts`.

Required programs: `Xephyr` or `Xvfb`, `ratpoison`, `ffmpeg`, `xdotool`, `xprop`, and `xterm`
for the default application.

### Display session lifecycle

The X server, the window manager and the applications are started detached, in their own
process groups, and outlive the server. Only the capture process dies with it. Background:
[decision record](decisions/display-session-outlives-server.md).

`start` does the first of these that applies:

1. **Reuse** the session this process already has, if its X server still answers.
2. **Reattach** through the state file `session.json` in the runtime directory
   (`EW_X11_RUNTIME_DIR`, default `<repo>/.ew-x11`). It records the display, how to connect to
   it, the backend and the X and window-manager pids. If the X server is alive, the backend
   restarts the window manager only if it is gone, reapplies the window-manager settings,
   and restarts capture. A stale state file is deleted.
3. **Start fresh.** Pick a display, start an X server, wait for it to answer, start ratpoison,
   start the default application if no window exists, start capture, then write the state
   file.

A reattach wins over configuration: to change the backend or the display, stop the old X
server and delete `session.json`.

**Backend order.** Xephyr draws the nested desktop as a window on the host desktop, which lets
the operator watch it on the PC. Xvfb is headless. With a host display available the order is
Xephyr then Xvfb; without one, Xvfb then Xephyr. The second is tried on the same display
before another display number is tried. `EW_BACKEND=xephyr|xvfb` pins one, with no fallback.

**Host display discovery** (`resolveHostDisplay`). A service manager does not pass a login
shell's `DISPLAY`, so the environment alone cannot say whether a desktop exists. The order is:
`EW_HOST_DISPLAY` (empty means "no host desktop"), then `DISPLAY`, then the lowest-numbered
socket in `/tmp/.X11-unix` that is not the nested display itself. The X server is started with
`DISPLAY` set to the result; every other child gets the nested display.

**Display probing.** The nested display is `EW_X11_DISPLAY` (default `:100`).

- A display counts as live only if it accepts a connection, on its unix socket or on TCP port
  6000 + n. A lock file alone does not, and an orphaned lock and socket on the configured
  display are removed so that it can be reused.
- If the configured display is taken by another server, or no backend comes up on it, the next
  free number is tried, up to six attempts.
- The X server listens on TCP as well (`-listen tcp`). Where the socket directory does not
  allow a unix socket (WSLg mounts `/tmp/.X11-unix` without the sticky bit), clients connect
  to `127.0.0.1:<n>` instead of `:<n>`. Whichever transport answers first is recorded and
  published to children.

Code that starts a process against the nested display uses `childEnv()` or `run()`. A
hand-written `DISPLAY=:100` breaks on a TCP-only display.

### Window manager

ratpoison shows one window at a time, filling the screen, with no decoration, so no window
ever needs fitting to the panel. Background:
[decision record](decisions/monocle-window-manager.md).

The generated configuration (`ratpoisonrc` in the runtime directory):

| Setting | Reason |
| --- | --- |
| White on black bars, no border, no padding | The panel emits light for bright pixels; a white bar would light the lens |
| `set font monospace:pixelsize=11` | The stock bar font overflows a 576-wide screen |
| `unmanage ratmenu` | A managed popup is centred across the tile boundaries and dirties all four tiles on every move |
| `bind c` to the default application | The stock binding starts the host's terminal emulator, which may open on the host desktop |
| A list of `unbind`s (`RP_UNBIND`) | Removes frame-splitting commands, which break the one-window-fills-the-screen assumption, and shortens the on-screen key help so the useful part fits. `C-t` and the keys of `RP_KEYS` stay bound |

Window control uses ratpoison's command interface; ratpoison does not implement EWMH.

| Operation | How |
| --- | --- |
| Enumerate | `ratpoison -c 'windows %n\|%s\|%i\|%c\|%t'` |
| Focused window | `xdotool getwindowfocus` (`getactivewindow` needs EWMH) |
| Select | Resolve the id to the current window number by re-listing, then `select <n>`. Numbers are recycled, so the mapping is never cached |
| Close | `delete`, which sends `WM_DELETE_WINDOW`; never `kill` |

A window without a class is reported by ratpoison as `None`; the backend maps that to `""` so
that classless windows do not share a binding key.

### Child environment

`childEnv()` in `xenv.ts` builds the environment of every process that talks to the nested
display.

| Rule | Reason |
| --- | --- |
| `FONTCONFIG_FILE` points at a generated file with antialiasing off, full hinting, no subpixel rendering | Antialiased edges quantise to the wrong one of 16 colours and give text coloured fringes. `EW_AA=1` permits antialiasing for comparison |
| `WAYLAND_DISPLAY` removed, `GDK_BACKEND=x11`, `MOZ_ENABLE_WAYLAND=0` | A toolkit that finds a Wayland socket renders on the host desktop, and the mirror stays empty |
| `DISPLAY` is the resolved transport of the nested display | See display probing |
| Applications and ratpoison start in `EW_SPAWN_CWD` (default the home directory; `~` is expanded; a bad value falls back with a warning) | A launched terminal's prompt is read on the glasses, so its directory is part of the interface. ratpoison passes its own directory to what it launches |
| The X server and capture start in the runtime directory | They write nothing relative |

The default application (`EW_SPAWN`; empty disables it) is an xterm with a black background,
white foreground and cursor, a 9x18 bold bitmap font, no border and no scrollbar: 64 columns
by 16 rows. Dark background is a correctness matter on a see-through panel, where bright
pixels emit light. Background: [decision record](decisions/default-terminal-client.md).

### Capture

```
ffmpeg -f x11grab -draw_mouse 0 -video_size 576x288 -framerate <EW_FPS> -i <display>.0 \
       -pix_fmt rgb24 -f rawvideo -
```

- `EW_FPS` defaults to 10 and is clamped to 1 to 30.
- The pointer is not drawn: the query fails on some nested servers, and the client composites
  its own cursor.
- The output is a byte stream, cut at exactly `FRAME_BYTES` per frame. If more than four
  frames accumulate, the backend keeps only the newest frame's worth of bytes to resynchronise.
- If capture ends unasked, the backend reports the desktop unavailable and leaves the X stack
  alone.

### Input injection

One `xdotool` process per event (`input.ts`), with a 2 second timeout, so a stuck call cannot
block the next one.

| Kind | xdotool |
| --- | --- |
| `key` | `key --clearmodifiers <chord>` |
| `type` | `type --clearmodifiers [--delay 40] -- <text>`; the delay is added only for text with non-ASCII characters, which are dropped at the default delay |
| `keydown`, `keyup` | `keydown` / `keyup` without `--clearmodifiers`, since their purpose is to hold a modifier |
| `click`, `dblclick` | `click <b>`; a double click is one invocation with `--repeat 2 --delay 120` |
| `move`, `clickat` | `mousemove x y [click <b>]`, coordinates clamped to the screen |
| `down`, `up` | `mousedown` / `mouseup` |

`wmKey` sends the ratpoison prefix and the key in one invocation, because two would race
through the prefix grab. It sends keystrokes rather than `ratpoison -c` so that interactive
surfaces such as the key help appear on the mirrored desktop. A wheel turn goes to the window
under the pointer, not the focused one. Background:
[X11 backend measurements](notes/2026-11-x11-backend-measurements.md).

### Window identity

`identify` asks the window for its pid (`xdotool getwindowpid`, the `_NET_WM_PID` property)
and reads `/proc/<pid>/comm` (lowercased, a trailing `-bin` stripped) and the `/proc/<pid>/exe`
link. A window with no pid is asked for `WM_COMMAND` (`xprop`); its first argument gives the
name, and the path if it is absolute. A window that offers neither has no identity.

The server caches the answer for the window's lifetime, including an empty one, and attributes
windows to launches by walking parent pids (`parentPid` reads `/proc/<pid>/stat`). Nothing is
written onto windows. Background:
[decision record](decisions/window-identity-without-stamping.md).

### Application discovery

The launchable set is the union of three sources, minus a shipped deny-list and the user's
`hide` rules (`apps.ts`, `desktop.ts`):

| Source | `LauncherEntry.note` | Detail |
| --- | --- | --- |
| XDG `.desktop` files | `desktop` | `XDG_DATA_HOME` and `XDG_DATA_DIRS`; hidden entries and entries whose `TryExec` is missing are skipped |
| Debian packages in `Section: x11` whose binaries link libX11 | `section-x11` | Three processes: `dpkg-query`, `dpkg -L`, `ldd`. Without dpkg this source is empty and the rest still works |
| The user's `apps.conf` in the state directory | `user` | Verbs `hide`, `show`, `app`, `term`; see [configuration.md](configuration.md) |

The deny-list (`DENY_CLASSES`) removes X servers and daemons, one-shot query tools, benchmarks
that repaint continuously, and programs that need an argument; `show` restores an entry. An
entry that needs a terminal is launched inside the default application's terminal with `-e`.
The scan runs at start-up and is cached. Background:
[application scan measurements](notes/2026-10-application-scan.md).

## Adding a backend

Add `src/server/platform/<os>/index.ts` exporting a `Platform`, and select it in
`platform/index.ts`. `platform/unsupported.ts` is a complete do-nothing implementation to start
from. `backendFor()` in `platform/index.ts` is the table at the top of this page.

Beyond the signatures, a backend must provide a desktop of exactly 576x288 that shows one
window at a time filling it, survives a server restart and can be found again by the next
process; window ids that are stable for the window's lifetime; all ten input kinds of
[`POST /api/desktop/input`](protocol.md#post-apidesktopinput); and application ids that are stable
across rescans.

### Wire vocabulary a backend translates

These cross the seam and the wire unchanged, so a backend converts them to its own terms:

| Vocabulary | Form |
| --- | --- |
| Key chord | `[ctrl+][alt+][shift+]<X keysym name>`, for example `ctrl+Return`, `Page_Up`, `KP_Add`, `ISO_Left_Tab`. The bindable set is the catalogue in `src/shared/keys.ts`; `key` and `keydown` on the low-level route accept any name |
| Pointer button | 1 left, 2 middle, 3 right, 4 wheel up, 5 wheel down |
| Window id (`WinInfo.wid`, `WinSel.wid`) | An opaque string. The X11 backend uses lowercase hexadecimal; nothing above the seam parses it |
| Short handle (`WinInfo.id`, `WinSel.sel`) | Any string the backend can resolve; clients do not rely on it |

### Names that stay

Routes and fields are named for what they do (`wid`, `/api/desktop/input`, `/api/wm/key`,
`SessionInfo`). The following keep a Linux flavour, with OS-neutral meaning, and are not
renamed per backend:

- Key names are X keysym names (`Return`, `Page_Up`). They are stored in the user's bindings
  file and compiled into the client's key catalogue.
- `cls` is the window class an application declares (WM_CLASS on X11).
- `SessionInfo.backend` is the backend's own label (`Xephyr`, `Xvfb`).
- Launcher entries are the exception in the other direction: the wire fixes only the unit
  (`LauncherEntry`, with an opaque `id`), and each backend chooses its own id scheme, counter
  names and the remark in `note`. The X11 backend uses `desktop`, `section-x11` and `user`, with
  ids `desktop:<file id>`, `x11:<command>` and `user:<slug>`.
- Binding keys `comm:`, `exe:` and `cls:`.
- Environment variables such as `EW_X11_DISPLAY` and `EW_BACKEND` configure the X11 backend
  only.

### What is still X11-shaped above the seam

Known places where OS-neutral code or the client assumes the X11 backend:

- **The window-manager menu.** `RP_KEYS` and `RP_PREFIX` in `src/shared/glassMenu.ts` are
  ratpoison's keymap, and the client builds its `window` rows from them. `wmKey` may return
  `false`, but nothing tells the client to hide the rows.
- **Key presets.** The key catalogue and the font-size and submit presets in
  `src/shared/keys.ts` were chosen for X applications (xterm's `shift+KP_Add`, for example).
- **Window class.** Binding resolution uses `cls` as a fallback identity and assumes it is a
  per-application string, as `WM_CLASS` is.
- **Launch attribution** assumes a window's pid descends from the pid `spawn` returned, and
  treats pid 0 as "this window has no pid".
- **Process signals.** The server shuts down on `SIGINT` and `SIGTERM`.
- **The synthetic cursor.** The client draws its own pointer because the X11 capture has none; a
  backend whose frames include a cursor would show two.
- **Tooling.** The scripts under `scripts/`, the systemd units and the simulator harness are
  Linux-only.
