# Simulator harness traps

Snapshot — not maintained. Conditions: October 2026, WSL2 + WSLg, Node 24.13, Even Hub
simulator 0.9.5 (GTK3 + WebKit2GTK), SDK 0.0.16, Vite 5. The rules these produced are in
[development.md](../development.md).

## The glasses PNG carries its content in alpha

`GET /api/screenshot/glasses` returns RGBA whose RGB is a uniform green (the G2's monochrome
panel colour). Measured distinct 8-bit levels per plane:

| Frame | luma levels | alpha levels |
| --- | --- | --- |
| A terminal is mirrored | 1 | 3 (0 / 179 / 255) |
| Nothing drawn | 1 | 1 |

A luma-only check therefore reports a good frame as blank, and compositing onto white erases
the content. `sim.sh --screenshot` measures both planes and warns only when both have one
level.

File size cannot tell the two apart either: an unpainted frame was about 3,969 bytes, a frame
showing a terminal about 4,731 bytes. The automation API answers 200 with a blank 576x288 PNG
even when the app has pushed no tiles.

## Bytes that are not a PNG

A wrong path sent to the Vite port gets the SPA fallback: `index.html`, HTTP 200,
`text/html`. Saved as `.png` it only fails later in an image tool. `sim.sh --screenshot`
checks four things: `curl -f`, `content-type: image/png`, the 8-byte magic
`89 50 4e 47 0d 0a 1a 0a`, and a size above 256 bytes.

## "Glasses Display" overlaps "Browser"

The simulator's display has no window manager, so its top-level windows overlap. Measured:
`Browser` at `0,0` 600x800 (or off-screen, `X=-292`, in other runs), `Glasses Display` at
`324,175` 576x328. Clicks in the browser's right half (x ≥ 324, 175 ≤ y ≤ 503) were eaten by
`Glasses Display`: nothing happened, no error, nothing in `/api/console`. Clicks on the left
half worked, which made it look like anything but an overlap.

Also measured: `xdotool mousemove X Y click 1` as one command was sometimes dropped by the
WebView; `xdotool mousemove 527 411; sleep 0.6; xdotool click 1` went through.

Top-level windows on the simulator's display: `evenhub-simulator`, `Browser`,
`Glasses Display`. Searching there for `even-sim` returns nothing (rc=1); that name is the
title of the Xephyr window on the host display.

## Reattach beats `--display`

Passing `--display :105` while `.ew-x11/session.json` existed gave
`"display":":100"` from `/api/health`: the server reattached to the existing session instead
of starting a new one. Isolated runs therefore set `EW_X11_RUNTIME_DIR`.

## A foreign service satisfied the readiness poll

With another stack already holding `:8787`, the script's `GET /api/health` poll succeeded
against that stack while its own server had failed to bind. Both scripts now refuse to start
on a busy port.

## A second simulator

A second simulator against the same server is a second client; the two fight over the
mirror and every observation is corrupted. `sim.sh` refuses when the automation port answers
`/api/ping`.

## WSL2 specifics

- A GTK child that still sees `WAYLAND_DISPLAY` renders on the WSLg host desktop instead of
  the nested display. Children get `WAYLAND_DISPLAY` unset, `GDK_BACKEND=x11`,
  `MOZ_ENABLE_WAYLAND=0`. Inherited `TMUX` / `TMUX_PANE` are dropped on the same principle.
- WebKit's DMABUF/GL compositing fails on a nested or virtual X (blank window or crash). The
  simulator gets `WEBKIT_DISABLE_DMABUF_RENDERER=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`,
  `LIBGL_ALWAYS_SOFTWARE=1`.
- `/tmp/.X11-unix` was mode `0777`, not `1777` (a WSL bind mount). A new X server can exit at
  once with `_XSERVTransMakeAllCOTSServerListeners: failed to create listener for unix`. The
  scripts start it with `-listen tcp` and connect as `127.0.0.1:<N>`.

## `pkill -f` kills the caller

`pkill -f sim-linux-x64` can match the invoking shell's own command line and kill it (exit
144). A related case: after `setsid nohup node …`, a bash subshell with the same
command line stayed behind and `pgrep -f` returned it first; killing it left the real server
running and the replacement died with `EADDRINUSE`. Take the pid from the listening socket:

```bash
PID=$(ss -ltnpH | grep ':8787' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
kill "$PID"; until ! ss -ltn | grep -q ':8787'; do sleep 0.5; done
```

The scripts' log pumps can also block forever, because the detached X server inherits the
pipe's write end; the scripts reap their remaining direct children on exit.

## Vite wedged by a dynamically imported dependency

Symptom: the phone opened a pairing URL and stayed on "loading". The pairing dialog's QR
encoder is a dynamic import, invisible to Vite's dependency scan, so the first page to reach
it made the dev server discover a dependency mid-session, re-run the optimiser and force a
reload. The server then stopped answering.

```bash
ss -ltnp | grep 5273                 # listening, with a receive backlog
curl -m 15 http://127.0.0.1:5273/    # 000 (timeout)
ls -l node_modules/.vite/deps/       # rewritten after Vite's start time
```

With `qrcode-generator` in `optimizeDeps.include`, `/` answered 200 in 32 ms. The wedged
process did not die on `SIGTERM` (its shutdown handler waits on the stuck server); it needed
`kill -9 <pid>`. Production builds are unaffected.

## The SDK bundle that did not update

Vite serves optimised dependencies at `?v=<browserHash>` with
`max-age=31536000,immutable`. Upgrading the SDK from 0.0.10 to 0.0.16 did not change the hash
(`73029bd2` before and after; `vite --force` did not change it either). The WebView kept the
cached 0.0.10 bundle while the app code updated, the new code called
`new mod.MenuItemProperty(...)` on a module that predates the class, and the glasses page
failed to establish with "undefined is not a constructor". See
[decisions/sdk-not-prebundled.md](../decisions/sdk-not-prebundled.md).

## Stale WebView state

The WebView keeps `localStorage` across simulator restarts, and can keep old JavaScript while
Vite already serves new modules. `Ctrl-R` / `F5` are unreliable under Xephyr's
`-no-host-grab`; restarting the simulator is the sure way. A value once passed with
`--app-query` decided the next run that passed nothing; the `sticky:` boot line exists for
that.

## Misleading observations on hardware

A gesture can appear to do nothing because the glasses are not keeping the display alive,
not because the build is broken. The reverse also happens: the screen seems to move while
the log shows zero tile pushes, because what is visible is an afterimage or another app.
Hence the one-second clock check before any rendering conclusion.
