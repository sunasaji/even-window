# Protocol

The HTTP and server-sent-events contract between the client (the WebView page) and the server.
The `routes` table in `src/server/main.ts` is the only place a route is declared and the only
place requests are dispatched from; the wire types live in `src/shared/types.ts`.

## Conventions

- Plain HTTP on `EW_PORT` (default `8787`), bound to `EW_HOST` (default `127.0.0.1`). The server
  terminates no TLS; see [security.md](security.md).
- Request and response bodies are JSON unless stated. Responses carry `cache-control: no-store`.
- A JSON request body is capped at 64 KiB. An empty, oversized or malformed body is read as
  `{}`, so a route then answers as it would for missing fields.
- Every route requires authentication except the four marked *open*. A gated request carries
  `Authorization: Bearer <session token>`; the stream carries `?ticket=` instead. With
  `EW_AUTH=0` the gate admits everything. How tokens are obtained: [security.md](security.md).
- Route and field names are the same on every backend. Key names are X keysym names and a few
  labels describe Linux sources ([platform.md](platform.md#names-that-stay)).

A request is processed in this order:

1. CORS headers are set according to the [CORS policy](#cors).
2. `OPTIONS` is answered `204` with no body.
3. The method and path are looked up. No match: `404 {"ok":false,"msg":"not found"}`.
4. Open routes pass the [rate limit](#rate-limiting-of-open-routes) or get `429`.
5. Gated routes pass the gate or get `401 {"ok":false,"msg":"unauthorized"}`.
6. The handler runs. An exception becomes `500 {"ok":false,"msg":"<message>"}`.

One access-log line is written per request unless `EW_QUIET=1`.

A failure of the action itself (a window could not be selected, an injection failed) is `200`
with `ok: false` and a `msg`. An HTTP error means the request was wrong or refused.

## Routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/auth/challenge` | open | Nonce for the session handshake |
| POST | `/api/auth/session` | open | Redeem a signed nonce for a session token |
| GET | `/api/auth/pair/status` | open | Poll a pending pairing |
| POST | `/api/auth/pair` | open | Submit a device key with a one-time code |
| GET | `/api/auth/me` | gated | The caller's enrolled identity |
| GET | `/api/auth/ticket` | gated | Short-lived ticket for the stream |
| GET | `/api/stream` | gated (ticket) | The SSE stream |
| GET | `/api/health` | gated | Display session status and capabilities |
| GET | `/api/windows` | gated | Window list and focus recency |
| POST | `/api/windows` | gated | Focus a window |
| POST | `/api/windows/close` | gated | Close a window |
| GET | `/api/apps` | gated | Launchable applications |
| POST | `/api/spawn` | gated | Launch an application |
| POST | `/api/input` | gated | Route a glasses gesture |
| GET | `/api/bindings` | gated | Per-app bindings |
| POST | `/api/bindings` | gated | Set or clear one binding |
| POST | `/api/desktop/input` | gated | Inject one low-level input event |
| POST | `/api/stt` | gated | Transcribe recorded speech |
| POST | `/api/wm/key` | gated | Send one window-manager menu key |
| POST | `/api/debug/event` | gated | Log a raw gesture envelope |
| POST | `/api/debug/log` | gated | Forward client log lines |

### Authentication routes

The model, the token kinds and the pairing procedure are described in
[security.md](security.md). The shapes:

| Route | Request | Response |
| --- | --- | --- |
| `GET /api/auth/challenge` | none | `{"nonce":"…","exp":<ms>}`; a nonce lives 2 minutes and is single-use |
| `POST /api/auth/session` | `{"clientId","nonce","sig","origin"}` | `{"token":"…","exp":<ms>,"clientId":"…"}`; a session lasts 1 hour. Any failure: `401 {"error":"pairing required or bad signature"}` |
| `POST /api/auth/pair` | `{"code":"<one-time code>","pub":<public JWK>}` | `{"status":"pending"\|"approved","id":"<fingerprint>","art":"<randomart>","slots":{"used":n,"max":n}}`; `max: 0` means unlimited. Refused: `403 {"error":"pairing closed"\|"bad code"\|"bad key"}` |
| `GET /api/auth/pair/status?id=<fingerprint>` | none | `{"status":"approved"\|"pending"\|"rejected"\|"unknown"}` |
| `GET /api/auth/me` | none | `{"id":"<fingerprint>","name":"…","custom":bool,"authEnabled":bool}`; `id` is `""` when authentication is off |
| `GET /api/auth/ticket` | none | `{"ticket":"…","exp":<ms>,"authEnabled":true}`; a ticket lasts 60 seconds and only opens the stream. With authentication off: `{"ticket":"","exp":0,"authEnabled":false}` |

### `GET /api/health`

```json
{ "ok": true, "display": ":100", "backend": "Xephyr", "pid": 12345, "fps": 10, "stt": false }
```

`ok` is whether the mirrored desktop is available. `display`, `backend` (`Xephyr`, `Xvfb` or
`none`) and `pid` describe the backend's display session. `stt` is whether a speech recogniser
is configured; the client offers voice input only when it is true. The route is gated, so a
liveness probe accepts `401` as "alive".

### `GET /api/windows`

```json
{ "list": [ { "id": "1", "wid": "0x400001", "cls": "XTerm", "title": "xterm",
              "active": true, "app": "xterm", "exe": "/usr/bin/xterm",
              "appId": "desktop:debian-xterm" } ],
  "recent": ["0x400001"] }
```

The server re-enumerates before answering. `WinInfo` fields:

| Field | Meaning |
| --- | --- |
| `id` | The backend's short window handle. It can be recycled; never keep it |
| `wid` | Opaque window id, stable for the window's lifetime |
| `cls` | Window class; `""` when the window has none |
| `title` | Window title |
| `active` | The window has focus |
| `app` | Executable name, lowercased; absent when unknown |
| `exe` | Absolute executable path; absent when unknown |
| `appId` | The `LauncherEntry.id` this server launched the window from; absent otherwise |

`list` stays in the backend's own order. `recent` is a separate array of `wid`s, most recently
focused first, live windows only; windows not focused since the server started come last.

### `POST /api/windows`

Body `{"wid":"0x400001"}` or `{"sel":"1"}`. Response `{"ok":true}` or
`{"ok":false,"msg":"select failed"}`. Neither field: `400 {"ok":false,"msg":"need sel or wid"}`.

Clients use `wid`: a cached `sel` goes stale silently, because renumbering alone does not
produce a `windows` event.

### `POST /api/windows/close`

Body as above, or `{}` to close the focused window. The window is asked to close; it is never
killed. Response `{"ok":true}` or `{"ok":false,"msg":"close failed"}`.

### `GET /api/apps`

```json
{ "list": [ { "id": "x11:xfontsel", "name": "xfontsel", "cmd": "xfontsel", "args": [],
              "note": "section-x11", "terminal": false } ],
  "recent": ["x11:xfontsel", "desktop:debian-xterm"],
  "counts": { "desktopFiles": 28, "desktopApps": 20, "sectionX11": 75, "sectionX11Kept": 28,
              "denied": 47, "user": 0, "hidden": 0, "duplicates": 2, "total": 46 },
  "overrides": "/home/you/.even-window/apps.conf",
  "errors": [] }
```

| Query | Effect |
| --- | --- |
| none | Answer from the cache; an edited override file is picked up by its modification time |
| `?rescan=1` | Run the full scan again |
| `?why=1` | Add `skipped: [{"what","why"}]`, the reason each candidate was left out |

Each element of `list` is a launcher entry (`LauncherEntry`): one thing the server can start.
Its `id` is opaque and stable across rescans and restarts. `note` is a short remark the
backend attaches for display, and `counts` carries `total` plus the backend's own counters;
nothing interprets either, and the values above are the X11 backend's
([platform.md](platform.md)). `terminal: true` means the
server wraps the command in its default terminal when launching; the wrapper is not in
`cmd`/`args`. `recent` is launch recency, newest first. `overrides` is the user's override file
and `errors` its parse errors. Where the list comes from:
[platform.md](platform.md#application-discovery).

### `POST /api/spawn`

Launches one entry of `GET /api/apps`. The request names the entry; the server owns the
argv, including any terminal wrapper, and no command line travels on the wire.

| Body | Response |
| --- | --- |
| `{"id":"x11:xfontsel"}` | `{"ok":true,"id":"…","name":"…"}`; unknown id: `404 {"ok":false,"msg":"unknown app id: …"}`; no id: `400` |

A launch that fails to start answers `200 {"ok":false,"msg":"spawn failed: <cmd>"}`.

The check on `cmd` is a sanity bound, not a security control ([security.md](security.md)).

### `POST /api/input`

Body `{"gesture":"tap"|"double"|"up"|"down","count":n}`. `count` is the number of repeats for a
swipe burst; absent or below 1 means 1, and it is capped at 64.

| Gesture | Action |
| --- | --- |
| `tap` | Press `Return` once, whatever `count` says |
| `double` | Nothing is injected; the client opens its own window list. The response is `{"handled":true}` |
| `up`, `down` | Press the bound chord `count` times, or turn the wheel `count` notches if the binding is a wheel entry. The binding is resolved from the window that has focus at that moment; with nothing bound it is `Up` / `Down` |

Response `{"handled":true}` or `{"handled":false,"msg":"inject failed"}`. Any other gesture
name, including `long` and `longRelease`, is `400 {"handled":false,"msg":"bad gesture"}`.

### `GET /api/bindings`, `POST /api/bindings`

```json
{ "map": { "comm:less": { "up":   { "mods": [], "key": "Page_Up" },
                          "down": { "mods": [], "key": "Page_Down" },
                          "submit": "ctrl+Return", "newline": "shift+Return" } },
  "default": { "up": { "mods": [], "key": "Up" }, "down": { "mods": [], "key": "Down" } },
  "file": "/home/you/.even-window/bindings.json",
  "errors": [] }
```

`map` is keyed by an app key: `*` (every app), `app:<LauncherEntry.id>`, `exe:<absolute path>`,
`comm:<name>`, `cls:<class>` or `title:<title>`. `default` is what applies with nothing bound.
`errors` lists entries dropped when the file was read.

`POST` sets one entry:

```json
{ "key": "comm:less", "up": { "mods": ["ctrl"], "key": "u" }, "down": { "mods": ["ctrl"], "key": "d" },
  "submit": "ctrl+Return", "newline": "shift+Return", "fontsize": "ctrl+equal" }
```

or clears it with `{"key":"comm:less","clear":true}`.

- `up` and `down` are required. `mods` is a subset of `ctrl`, `alt`, `shift`; `key` must be in
  the catalogue in `src/shared/keys.ts`. The catalogue is compiled into the client and is not
  sent on the wire.
- `submit`, `newline` and `fontsize` are optional ids from `SUBMIT_CHORDS`, `NEWLINE_CHORDS`
  and `FONTSIZE_STEPS` in the same file. Omitted means "inherit".
- Response `{"ok":true,"key":"…","map":{…}}`. Posting an identical entry adds
  `"unchanged":true`.
- A malformed app key, a key outside the catalogue or an unknown id is `400 {"ok":false,"msg":"…"}`.

### `POST /api/desktop/input`

Body `{"kind":"…","arg":"…"}`. The phone UI's text box, keys and pointer all use this route.

| `kind` | `arg` | Effect |
| --- | --- | --- |
| `key` | chord, e.g. `Return`, `ctrl+c`, `shift+KP_Add` | Press a chord. Held modifiers are cleared first |
| `type` | text | Type the text. Held modifiers are cleared first |
| `keydown`, `keyup` | key name | Press or release without clearing modifiers; the state persists across requests |
| `click`, `dblclick` | button `1` to `5`, default `1` | Click at the current pointer position |
| `move` | `x,y` | Move the pointer; coordinates are clamped to the screen |
| `clickat` | `x,y[,button]` | Move and click as one operation |
| `down`, `up` | button | Press or release a button at the current position |

`arg` is not translated: chords are spelled `[ctrl+][alt+][shift+]<X keysym name>` and buttons
are numbered 1 left, 2 middle, 3 right, 4 wheel up, 5 wheel down.

Whoever sends a `keydown` must send the matching `keyup`; a modifier left down corrupts every
later keystroke. Response `{"ok":true}` or `{"ok":false,"msg":"inject failed"}`. Unknown kind:
`400 {"ok":false,"msg":"bad kind: …"}`.

### `POST /api/stt`

The body is raw signed 16-bit little-endian mono PCM (`content-type:
application/octet-stream`), exactly as the microphone delivered it. `?rate=` is the sample rate
(default `16000`, accepted 8000 to 48000). Response `{"ok":true,"text":"…"}` or
`{"ok":false,"error":"…"}`.

| Status | Case |
| --- | --- |
| 200 | Transcribed. `text` may be empty: nobody spoke, which is a result |
| 400 | `rate` out of range, or an odd number of bytes |
| 413 | More than 60 seconds of audio (`STT_MAX_SECONDS`). The connection stays open so the client can read the answer |
| 502 | The recogniser did not answer or returned an error |
| 503 | No recogniser configured (`EW_STT_URL`) |

`error` is for a human to read; a client never injects it as text. Details:
[voice.md](voice.md).

### `POST /api/wm/key`

Body `{"key":"question"}`. Sends the window manager's prefix followed by one key, as a single
operation. `key` must be in the closed catalogue `RP_KEYS` in `src/shared/glassMenu.ts`; the
client names a key, never a command, and the server owns the prefix. Response
`{"ok":true,"key":"…"}` or `{"ok":false,"msg":"inject failed"}`. A key outside the catalogue:
`400 {"ok":false,"msg":"not a menu key: …"}`.

### Debug routes

The client posts to these only when it runs with `?debug=1`.

| Route | Body | Effect |
| --- | --- | --- |
| `POST /api/debug/event` | `{"event":<raw envelope>,"gesture":<normalised or null>}` | One `[ew] RAW …` line on the server's stdout. Response `{"ok":true}` |
| `POST /api/debug/log` | `{"lines":[{"t":<epoch ms>,"m":"…"}]}` | One `[ew] CLIENT HH:MM:SS.mmm <m>` line each, stamped with the client's clock. At most 200 lines per request and 600 characters per line; newlines are flattened. Response `{"ok":true,"n":<lines taken>}` |

## Stream

`GET /api/stream?inst=<instance id>&ticket=<ticket>` is a `text/event-stream`. Each event is
one unnamed `data:` line holding a JSON object discriminated on `t`. The server sends a
comment line (`: open`) at once and a comment heartbeat (`: ping`) every 15 seconds. It sets
`x-accel-buffering: no`; a proxy in front must not buffer the response.

`ticket` is required when authentication is on, because `EventSource` cannot set headers.
`inst` is a random id the page mints once per load; it is not a credential
([instance arbitration](#instance-arbitration)).

### Event types

`StreamEvent` in `src/shared/types.ts`:

| `t` | Fields | Sent when |
| --- | --- | --- |
| `tile` | `i` (0 to 3), `png` (base64 indexed PNG, 288x144, 16 ANSI colours) | That quadrant changed |
| `avail` | `ok: true`, or `ok: false` with `msg` | The mirrored desktop became available or unavailable |
| `windows` | `list: WinInfo[]`, `recent?: string[]` | The window set, a title or the focus changed. The server polls once a second |
| `apps` | `list: LauncherEntry[]`, `recent: string[]` | The launchable set or the launch recency changed: a scan, an edited override file, a launch |
| `bindings` | `map` | A binding was set or cleared |
| `clients` | `list: EnrolledClient[]`, `enforced: boolean` | The set of enrolled keys, a key's name, or whether authentication is enforced changed. Checked once a second |
| `supersede` | `by` (instance id) | A newer page instance of the same device took over |

No event is sent per frame except `tile`, and that only for tiles that changed.

`windows` is published when the list, compared in order by `wid`, `title` and `active`,
differs from the last one sent; that is why recency travels beside the list instead of
reordering it. `EnrolledClient` is `{id, name, addedAt, addedIp?}` and never contains key
material; nothing on the wire can enrol or revoke a key. With `enforced: false` the list is
not being checked.

### Priming on subscribe

A new subscriber is sent the retained state immediately, in this order:

1. `avail`
2. `windows`
3. `apps`, once the first scan has finished; an empty list is sent as such
4. `bindings`
5. `clients`
6. every retained `tile`, in index order

A static screen produces no tile events, so priming is what lets a reconnecting client repaint.

### Instance arbitration

A page of a closed or crashed Even App can keep running and keep holding the glasses bridge.
A page cannot detect another page, but both are connected to the server, so the server
arbitrates (`src/server/instances.ts`).

- Identity is the authenticated client id, so two pages on one phone compete and two paired
  devices do not. With authentication off, all streams share one identity.
- The newest instance to connect owns the glasses. Every other open stream of that identity
  receives `{"t":"supersede","by":"<new instance>"}`.
- A superseded instance id is remembered (the last 64). When it reconnects it is told to stand
  down again and is not adopted, so the two pages cannot take the glasses from each other in
  turn.
- The server leaves a superseded stream open. A client that understands the event stops its
  pump and closes the stream itself; one that does not is unaffected.
- A stream closing does not release ownership.
- A stream without `inst` takes no part: it never supersedes and is never superseded.

What the client does on `supersede`: [glasses.md](glasses.md). Background:
[decision record](decisions/glasses-instance-supersede.md).

## Version skew

The page and the server are often built from different commits. The contract therefore grows
only in ways an older peer survives:

- New fields are optional in the type (`windows.recent`), and the reader degrades when they are
  absent.
- New event types are ignored by a client that does not know them, and an older server simply
  never sends them (`clients`, `supersede`). A client must treat "never received" as "unknown",
  not as "empty".
- New request parameters are optional (`inst`).

Background: [decision record](decisions/wire-additions-are-optional.md),
[version skew incident](notes/2026-10-version-skew-and-window-order.md).

## CORS

`corsOrigin()` in `src/server/main.ts` decides, per request, which origin to echo.

| Request | Result |
| --- | --- |
| `EW_ORIGINS` contains `*` | `access-control-allow-origin: *` |
| No `Origin` header | No CORS headers; not a browser cross-origin request |
| `Origin` listed in `EW_ORIGINS` (comma-separated) | Allowed |
| `Origin` host is loopback (`localhost`, `127.0.0.1`, `::1`) | Allowed |
| `Origin` host equals the request's `Host`, any port or scheme | Allowed |
| Anything else | No CORS headers, so the browser refuses the exchange |

An allowed origin is echoed with `vary: origin`, `access-control-allow-methods: GET, POST,
OPTIONS` and `access-control-allow-headers: content-type, authorization`. The headers are set
once, before dispatch, so the stream and error responses carry them too.

The same-host rule covers a phone that loads the page from one port of a host and calls the API
on another. The policy keeps a foreign web page away from the open routes and from a server
running with `EW_AUTH=0`: a JSON `POST` needs a preflight, and a refused preflight means the
request is never sent.

## Rate limiting of open routes

The four open routes are rate-limited before their handler runs
(`src/server/ratelimit.ts`). Gated routes are never limited: an authenticated client is
expected to be chatty.

| Bucket | Burst | Refill |
| --- | --- | --- |
| Per source address | 30 | 3 per second |
| All sources together | 120 | 12 per second |

A request must find a token in both buckets. A refusal is `429 {"ok":false,"msg":"slow down"}`
with `retry-after: 1`. At most 1024 sources are tracked; when the table is full the fullest
buckets are dropped first, so a source that is being refused keeps its record.

The source is the socket's remote address; `X-Forwarded-For` is ignored. Behind a local reverse
proxy every request shares one source, and the global bucket bounds the load. The limit
protects availability only. Background:
[decision record](decisions/open-route-rate-limit.md).
