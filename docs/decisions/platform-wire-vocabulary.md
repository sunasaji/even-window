# Neutral route and field names, X keysym names for keys

## Context

The server was written against a nested X server and later split into an OS-neutral part and a
backend behind the `Platform` interface. Two kinds of X-flavoured vocabulary travelled on the
wire:

- **Names**: the window id field `xid`, the routes `/api/x11/input` and `/api/ratpoison`, the
  type `X11Info`. They name a thing every backend has.
- **Values**: key chords such as `ctrl+Return` and `Page_Up`, which are X keysym names. They
  are stored in the user's bindings file and compiled into the client's key catalogue
  (`src/shared/keys.ts`).

## Decision

Names are neutral. Values that are stored or catalogued keep their spelling.

- The window id is `wid`: an opaque string, stable for the window's lifetime.
- Low-level input is `POST /api/desktop/input`; a window-manager menu key is
  `POST /api/wm/key`; the session description is `SessionInfo`, whose `backend` is the
  backend's own label.
- A key chord is `[ctrl+][alt+][shift+]<key name>`, and key names are the X keysym names,
  treated as a fixed catalogue. A backend for another OS translates them at the bottom.
- Pointer buttons are 1 left, 2 middle, 3 right, 4 wheel up, 5 wheel down.

Nothing above the seam parses a window id or interprets a key name beyond passing it on.

## Alternatives considered

- **Keep every X-flavoured name.** No change at all, but `xid` and `/api/x11/input` read as
  Linux-only on a backend that has neither, and the rename only gets more expensive once a
  packaged client is published.
- **Invent a neutral key vocabulary as well.** Breaks stored bindings and adds a translation
  table on Linux, where today the stored name is exactly what is injected. The table would be a
  second list that can disagree with the first. Keysym names are a complete, documented
  catalogue, so they serve as the neutral vocabulary.
- **Accept the old names as aliases.** There is no published client to stay compatible with;
  client and server are updated together.

## Consequences

- A client and a server from before the rename do not interoperate: update both.
- A non-X backend needs a key-name to native-key table covering at least the catalogue in
  `src/shared/keys.ts`, and a mapping for wheel buttons.
- The launcher's unit is the launcher entry (`LauncherEntry`): one thing the server can start.
  Its id is opaque, `note` is a free-text remark for display, and the scan counters are the
  backend's own. The wire has no notion of a source; the X11 backend writes its source
  label into `note`. Other
  systems offer things to launch that are not packages or desktop files (settings pages,
  registered shortcuts), so the wire does not enumerate where an entry may come from. The
  X11 backend keeps `desktop`, `section-x11` and the `x11:` id prefix as its own terms.
- [platform.md](../platform.md#names-that-stay) lists the few names that keep a Linux
  flavour.
