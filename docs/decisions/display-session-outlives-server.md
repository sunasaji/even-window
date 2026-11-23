# The display session outlives the server

## Context

The mirrored desktop holds the user's running applications: shells, editors, a browser. The
server process is restarted often, by the operator, by a service manager, and during
development. Capture, by contrast, is stateless.

## Decision

A backend starts the desktop detached from the server process and records how to find it
again. On Linux the X server, the window manager and the applications run in their own process
groups, and `session.json` in the runtime directory records the display, its transport, the
backend and the pids. Stopping the server stops capture only. The next start reattaches through
the state file and restarts only what died.

The tile diff baseline and the retained tiles are module state for the same reason: a reattach
sends only real changes.

## Alternatives considered

- **Start a new desktop on every start.** With a detached stack this orphans one X server per
  restart; with an attached one every restart closes the user's applications.
- **Find the old desktop by scanning displays.** Cannot tell this project's server from another
  nested X on the machine; the state file can.

## Consequences

- `DisplaySession.stopCapture()` is the only shutdown call; no interface member destroys the
  desktop.
- Configuration that is applied when the desktop starts (backend, display number, window-manager
  settings written to the rc file) does not take effect on a reattach. The X11 backend
  reapplies the window-manager settings it can at reattach; changing the backend requires
  stopping the old X server and deleting the state file.
- A backend for another OS has to solve the same problem: a desktop that survives the process
  and can be found by the next one.
