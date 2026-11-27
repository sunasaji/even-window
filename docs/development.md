# Development

For people changing the code: the dev loop, the simulator harness, how to observe what the
client and the glasses are doing, and recipes for verifying a change. Installing and operating
even-window is covered in [getting-started.md](getting-started.md),
[configuration.md](configuration.md) and [troubleshooting.md](troubleshooting.md).

The harness scripts are Linux-only: they drive the X11 backend ([platform.md](platform.md)),
whose mirrored desktop is a nested X display.

## Moving parts

| Part | Started as | Listens on | Notes |
| --- | --- | --- | --- |
| Server | `node src/server/main.ts` | `EW_PORT`, default `8787` | Owns the mirrored desktop (`EW_X11_DISPLAY`, default `:100`) and captures it |
| WebView app | `vite` | `5273` (`host: true`, `strictPort`) | Phone UI and glasses side; served from the working tree |
| Even Hub simulator | `@evenrealities/evenhub-simulator` | automation API, default `9899` | Renders the app and a 576x288 glasses panel, in its own X display (`:180` and up) |

The client resolves the server URL as `?server=` → `localStorage` → `http://localhost:8787`, so
the app URL for a local run is `http://127.0.0.1:5273/?server=http://127.0.0.1:8787`. Both
scripts print it.

The server runs TypeScript directly, so it needs a Node.js with built-in type stripping
(22.18 or newer). Linux packages are listed in
[getting-started.md](getting-started.md).

Runtime state and logs live in `<repo>/.ew-x11/` (`EW_X11_RUNTIME_DIR`, git-ignored):
`session.json` (the display session), `state/` (the harness's auth registry) and
`logs/{dev,sim}-{api,vite}.log`, `logs/sim-{sim,x}.log`.

## Dev loop

```bash
scripts/dev.sh                                   # server + Vite, logs prefixed [api] / [vite]
scripts/dev.sh --port 5273 --api-port 8787 --display :100
scripts/dev.sh --no-auth                         # EW_AUTH=0, announced on every run
```

`dev.sh` is a harness, not the way to run a long-lived server (use the systemd unit or plain
`node src/server/main.ts`; see [getting-started.md](getting-started.md)). It differs from a
normal run in these ways:

- Authentication is on. Pair each browser profile once with the `ew-auth.mjs pair` command the
  script prints; the key persists in that profile.
- The auth registry is its own: `EW_STATE_DIR=.ew-x11/state`. `~/.even-window` is not touched.
  Point `scripts/ew-auth.mjs` at the same directory (the printed command does).
- `~/.even-window/env` is not read. A `dev.env` in the repo root (git-ignored, mode `600`,
  same format as the env file in [configuration.md](configuration.md)) is read if present.
  `EW_ENV_FILE=<path>` overrides both; `EW_ENV_FILE=` reads nothing. `EW_PORT`,
  `EW_X11_DISPLAY`, `EW_AUTH` and `EW_STATE_DIR` come from the script and win over any file.
- It refuses to start if the server or Vite port is already in use, polls readiness (a `401`
  from `/api/health` counts as ready), and on `Ctrl-C` stops both by recorded pid.

Why the harness is scoped this way: [decisions/harness-auth-and-isolation.md](decisions/harness-auth-and-isolation.md).

### What needs restarting

| You changed | Do this |
| --- | --- |
| `src/client/`, `src/shared/` used by the client | Reload the page on the phone (HMR also applies). In the simulator, restart the simulator or `touch` a client source file to trigger HMR |
| `src/server/`, `src/shared/` used by the server | Restart the server: `Ctrl-C` in the `dev.sh` terminal and run it again |
| `vite.config.ts`, a new dependency | Restart Vite |

Restarting the server does not close the mirrored desktop: on Linux the display session is
detached, survives `SIGTERM` (`stopping capture, leaving the X stack up`), and the next server
reattaches through `session.json` (`reattached to … on :100`). Windows and running programs
stay.

Because of that reattach, `--display` has no effect while a session file exists in the runtime
directory. To start on another display, use another `EW_X11_RUNTIME_DIR`, or stop the old X
server by pid and delete `session.json`.

### Client/server version skew

The client is served from the working tree and becomes new on every reload; the server process
can be hours or days old. When a feature has any server-side part and "does not work", check
this first:

```bash
PID=$(ss -ltnpH | grep ':8787' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
ps -o lstart= -p "$PID"          # older than your server-side change? restart it
```

Take the pid from `ss`, not from `pgrep -f`, which can return a leftover wrapper shell with
the same command line. Rules that keep skew survivable:

- New fields in server events are optional in the shared types, and the client degrades
  when they are missing ([protocol.md](protocol.md)).
- Uncaught client errors are logged as `UNCAUGHT …` (`installErrorFunnel`), so a skew crash
  shows up in the client log instead of only in the WebView console.

Background: [notes/2026-10-version-skew-and-window-order.md](notes/2026-10-version-skew-and-window-order.md).

## Simulator harness

```bash
scripts/sim.sh                               # visible (Xephyr) when a host X display exists
scripts/sim.sh --headless --keep             # Xvfb, no display needed, stays up
scripts/sim.sh --headless --screenshot /tmp/glasses.png   # one-shot: up, settle, capture, down
```

| Option | Meaning |
| --- | --- |
| `--screenshot <path>` | After `EW_SETTLE_MS` (default 6000), fetch the glasses frame and write it. Non-zero exit if the fetch failed or the bytes are not a PNG; warns if the frame is blank |
| `--headless` | Put the simulator in Xvfb instead of Xephyr. Chosen automatically when `$DISPLAY` is unset. The simulator has no headless mode of its own; screenshots come from the automation API, so results are identical |
| `--keep` | Leave everything running until `Ctrl-C` |
| `--auth` | Run the server with the real auth gate. Default is `EW_AUTH=0` with a printed notice |
| `--app-query <qs>` | Extra query parameters for the app URL (also `EW_APP_QUERY`), e.g. `invert=1` or `debug=1`. Use it to pin settings: a query parameter beats what an earlier run left in `localStorage` |
| `--port`, `--api-port`, `--automation-port <N>` | Vite, server and automation ports (`VITE_PORT` 5273, `EW_PORT` 8787, `EW_AUTOMATION_PORT` 9899) |
| `--display <:N>` | The server's display, the one being mirrored (`EW_X11_DISPLAY`, default `:100`) |
| `--sim-display <:N>` | The simulator's own display (`EW_SIM_DISPLAY`, default `:180`; the next free one is picked if busy) |

`--display` is what gets captured; `--sim-display` is where the simulator's windows are
drawn. Reach the simulator's display over TCP: `DISPLAY=127.0.0.1:<N>`.

Like `dev.sh`, `sim.sh` uses its own auth registry, reads `dev.env` but not
`~/.even-window/env`, and refuses to start on a busy server or Vite port. It also refuses when
the automation port already answers `/api/ping`: a second simulator would be a second client
on the same server and the two would fight over the mirror.

### Running next to a live instance

The defaults collide with a running stack (ports, display `:100`, and the session file, which
would make the new server reattach to the live desktop). Give a parallel run its own of
everything:

```bash
EW_X11_RUNTIME_DIR=/tmp/ew-iso scripts/sim.sh --headless --keep \
  --display :191 --api-port 8791 --port 5291 --sim-display :186 --automation-port 9909
```

The recipes below assume this isolated run: `E=http://127.0.0.1:8791` (server),
`A=http://127.0.0.1:9909` (automation), mirrored display `127.0.0.1:191` or `:191`, simulator
display `127.0.0.1:186`. With `--auth`, pair the WebView first:
`EW_STATE_DIR=<runtime>/state node scripts/ew-auth.mjs open '<app-url>'`, start with
`--app-query "pair=<CODE>"`, click "Pair this device" in the WebView (see
[driving the phone UI](#driving-the-phone-ui)), then `ew-auth.mjs pending` / `approve <id>`.

### Automation API

```bash
curl -s  $A/api/ping                          # pong
curl -so g.png $A/api/screenshot/glasses      # glasses frame, 576x288 PNG
curl -so w.png $A/api/screenshot/webview      # the WebView (phone UI), 600x800
curl -s  $A/api/console                       # the WebView's console.* output
curl -s -X POST $A/api/input -H 'content-type: application/json' -d '{"action":"down"}'
```

`action` is one of `up`, `down`, `click`, `double_click`, `long_press`, `long_press_release`,
`context_menu`. These are glasses gestures only; the API has no JavaScript eval and no way to
touch the phone UI.

- Input sent before the client has established its page is dropped: the API answers
  `{"ok":true}` and the simulator log says `inject_input: no active event container`.
- `click` is the least reliable action. After each one, confirm the state with a screenshot
  before sending the next.
- `context_menu` raises the firmware's foreground-enter/exit system events; it is not a gesture
  and the app does not use the firmware menu ([glasses.md](glasses.md)).

Background: [notes/2026-10-simulator-input-and-overlay-checks.md](notes/2026-10-simulator-input-and-overlay-checks.md).

### Reading a glasses screenshot

The glasses PNG is RGBA. Its RGB is a uniform green; all content is in the alpha channel. Any
check on luma, or a viewer that composites onto white, sees a blank frame.

```bash
ffmpeg -v error -i g.png -vf alphaextract,negate -y g-alpha.png     # look at this one
# fraction of lit pixels (lit = the lens emits light there)
ffmpeg -v error -i g.png -vf alphaextract -pix_fmt gray -f rawvideo - \
  | od -An -v -tu1 | tr -s ' ' '\n' | sed '/^$/d' \
  | awk '{n++; if($1>127) hi++} END{printf "lit %.2f%%\n", 100*hi/n}'
```

Rules:

- A valid PNG proves the simulator answered, not that anything was mirrored: an app that
  pushed no tiles still yields a 200 and a PNG. Judge by distinct alpha levels (one level =
  nothing drawn), never by file size.
- When fetching by hand, validate the bytes (`curl -f`, `content-type: image/png`, `file`). A
  wrong path on the Vite port returns `index.html` with status 200.
- The phone preview is drawn by a separate path. Something visible in the preview is not
  evidence that it reached the glasses.

Background: [notes/2026-10-simulator-harness-traps.md](notes/2026-10-simulator-harness-traps.md).

### Driving the phone UI

On a simulator profile that has never closed it, the phone tour opens over the UI at the first
health answer. Start with `--app-query tour=0` when clicking by coordinates, or close it once
(`Escape`).

The simulator is an ordinary X client, so `xdotool` on the simulator's display operates the
WebView. Its two windows, `Browser` (600x800) and `Glasses Display`, overlap by default and
`Browser` may start off-screen. Clicks that land on `Glasses Display` vanish without any
error, so separate the windows first:

```bash
export DISPLAY=127.0.0.1:186                                  # the simulator's display
B=$(xdotool search --name '^Browser$' | head -1)
G=$(xdotool search --name '^Glasses Display$' | head -1)
xdotool windowmove "$B" 0 0; xdotool windowmove "$G" 0 810; xdotool windowraise "$B"
curl -so wv.png $A/api/screenshot/webview                     # read button coordinates here
xdotool mousemove 147 472; sleep 0.6; xdotool click 1         # move and click as two steps
```

- With `Browser` at `0,0`, screenshot coordinates are screen coordinates.
- Look up window ids every time; they change on each launch. (`xdotool search --name
  even-sim` finds the Xephyr host window, not a simulator window.)
- Button positions move with the UI. Always read them from a fresh `screenshot/webview`.
- To check what the mirrored desktop received, ask its display, not the simulator's:
  `DISPLAY=127.0.0.1:191 xdotool getmouselocation`.
- WebKitGTK has no soft keyboard, so anything that follows the on-screen keyboard
  (`visualViewport`) cannot be exercised here.

## Logs and diagnostics

The client has one log (`log()`), with a 400-line buffer and two outlets:

- The `▶ log` panel at the bottom of the phone UI ([phone-ui.md](phone-ui.md)).
- With `?debug=1`, each line is also sent to the server (`POST /api/debug/log`, batched every
  700 ms) and printed on the server's stdout as `[ew] CLIENT HH:MM:SS.mmm …`, in the same
  stream as `[ew] input gesture=…` and, from `POST /api/debug/event`, `[ew] RAW <envelope> ->
  <gesture>`. When the app dies on the phone, this is the only copy; the last batch before a
  crash can be lost.

In the simulator, `$A/api/console` gives the same client lines without `?debug=1`. Read it
next to the server log (`.ew-x11/logs/sim-api.log`) to match client intent with server action.

Lines worth knowing:

| Line | Meaning |
| --- | --- |
| `boot: query=… inst=…` | The URL this load used and its instance id |
| `sticky: invert=on — …` | A setting came from `localStorage`, not from this URL |
| `gesture double SWALLOWED by de-burst` | A gesture arrived and was deliberately dropped (as opposed to never arriving) |
| `UNCAUGHT …` | An uncaught error or rejection |
| `[ew] input gesture=up count=1 action=key key=ctrl+u via=comm:vim` | Server side: what a gesture resolved to and which binding matched (`via` absent = built-in default) |

SDK calls returning success (`create => 0`, `rebuild => true`, `overlay text => true`) mean
"accepted", not "drawn" ([glasses.md](glasses.md)). Decide rendering questions from the glasses
frame.

### Query parameters

Settings resolve `?param=` → `localStorage` → default and the winner is stored. Instruments are
read from the URL of the current load only and are never stored
([decisions/instrument-flags-query-only.md](decisions/instrument-flags-query-only.md)).

| Parameter | Kind | Effect |
| --- | --- | --- |
| `server=<url>` | setting | Server base URL |
| `invert=1` | setting | Invert polarity on the glasses |
| `mirror=color\|green` | setting | Phone preview rendering |
| `scrollnat=0\|1` | setting | Scroll direction of the touch surfaces |
| `debug=1` | instrument | Forward the client log and raw events to the server |
| `stats=1` | instrument | Log a `stats 10s: …` line per window and run the link baseline, which shows a bright test pattern on the glasses for a few seconds after boot and once more about a minute in |
| `keyprobe=1` | instrument | Show the keyboard/pointer probe panel; observes only, injects nothing |
| `encworker=worker\|main\|abba` | instrument | Pin or alternate the PNG encode path (needs `stats=1`) |
| `voicefeed=<url>` | instrument | Feed PCM from a URL into voice input ([voice without a microphone](#voice-without-a-microphone)) |
| `pair=<code>` | one-shot | Open the pairing dialog with this code ([security.md](security.md)) |

Debug objects on `window` (browser devtools only; the automation API cannot evaluate
JavaScript): `ewInvert`, `ewMenu`, `ewVoice`, `ewCursor`.

Timing comparisons need `?debug=1&stats=1` on real hardware, a fixed server build for both
runs, and a deterministic workload that keeps all four tiles changing:
`scripts/bench-workload.sh` (`counter64` by default, or `sl`) adds one to the running mirrored
desktop. Run each side for at least 60 s and discard the first one or two windows.
Background: [notes/2026-10-bench-workload-selection.md](notes/2026-10-bench-workload-selection.md).

### Reading the key probe

`?keyprobe=1` shows a panel that observes keyboard and pointer events and injects nothing
(add `&debug=1` to get its lines in the server log too). Work through it in this order:

| Step | Lines to read | Question answered |
| --- | --- | --- |
| 1. Tap the field, type a known string | `keys:` / `echo:` / `loss:` | Do keys reach the DOM at all. `loss: LOSS` = the field got the text but JavaScript did not see the keys; not fixable in the web layer |
| 2. Press `blur`, type the same string | `while unfocused` | Do keys arrive without focus. `JS AHEAD` means they do |
| 3. Arrows with the field focused | `caret:` | If arrows produce no key events but the caret moves, they can be recovered from `selectionchange`; `ghost` 0 means they really do not arrive |
| 3b. Tab, Ctrl combinations | `named:` / `unnamed` | Whether specific keys arrive; a growing `unnamed` means `Unidentified` / keyCode 0 |
| 4. Hold a key | `repeat` | Whether auto-repeat arrives |
| 5. Move the trackpad without pressing | `pointer:` / `last:` / `verdict:` | Is there hover. `last:` is the verdict: moving with `buttons=0` is real hover, `type=touch` is AssistiveTouch synthesising touches; `Δ` stuck at 0 means absolute coordinates only |
| 6. Repeat 1–2 while the mirror is busy | `delay:` | Time spent waiting behind the tile pump on the main thread. `?` means the timestamp base could not be determined; no number is invented |

What it found on an iPhone: [notes/2026-10-keyprobe-ios-hardware-input.md](notes/2026-10-keyprobe-ios-hardware-input.md).

## The simulator is not the hardware

- There is no Bluetooth link. Pushes return in milliseconds; latency, frame rate and pump
  contention cannot be measured. Do not draw performance conclusions here.
- The PNG encoder differs; tile bytes and sizes need not match the device.
- Compositing order of text over images matched the device where it was compared, but only
  the device settles it.
- It never reports a link drop or `isWearing: false`, has no audio device and no soft keyboard.

Meaningful in the simulator: control flow (establish, tile diffing, gesture routing,
reconnects), API responses, relative byte sizes, logic regressions. Device-only: transfer
timing, real rendering, phone runtime load. When reporting a result, say which of the two it
was verified on. On hardware, before concluding anything about rendering, put a one-second
clock on the mirrored desktop (`xterm -e 'while :; do date +%T; sleep 1; done'`) and confirm it
ticks on the lens.

## Verification recipes

All recipes use the isolated run above (`$E`, `$A`, auth off) and assume `H='content-type:
application/json'`. Judge results from the glasses alpha plane and from logs.

### Smoke test (input and output end to end)

One simulator gesture exercises gesture normalisation, `POST /api/input`, key injection,
capture, tile diff, the stream and the tile pump:

```bash
for c in 'echo AAAA-FIRST' 'echo ZZZZ-SECOND'; do          # setup: two history lines
  curl -s -X POST $E/api/desktop/input -H "$H" -d "{\"kind\":\"type\",\"arg\":\"$c\"}"
  curl -s -X POST $E/api/desktop/input -H "$H" -d '{"kind":"key","arg":"Return"}'
done
curl -s -X POST $A/api/input -H "$H" -d '{"action":"up"}'; curl -so up1.png $A/api/screenshot/glasses
curl -s -X POST $A/api/input -H "$H" -d '{"action":"up"}'; curl -so up2.png $A/api/screenshot/glasses
```

Pass: the prompt line reads `echo ZZZZ-SECOND` in `up1.png` and `echo AAAA-FIRST` in `up2.png`.

### Polarity

Black is transparent on the lens, so a healthy terminal frame is mostly dark. Measure the lit
fraction with the command in [Reading a glasses screenshot](#reading-a-glasses-screenshot):
the default dark terminal is a few percent lit; the same frame with `--app-query invert=1` is
the complement. After a toggle, the client log shows all four tiles (`TL/TR/BL/BR`) pushed
again. Background: [notes/2026-10-polarity-measurements.md](notes/2026-10-polarity-measurements.md).

### Window switching and recency order

```bash
for a in x11:xclock x11:xlogo; do curl -s -X POST $E/api/spawn -H "$H" -d "{\"id\":\"$a\"}"; done
curl -s $E/api/windows | python3 -m json.tool                 # note the window ids
curl -s -X POST $E/api/windows -H "$H" -d '{"wid":"<wid>"}'   # focus in a known order
curl -s -X POST $A/api/input -H "$H" -d '{"action":"double_click"}'; curl -so g.png $A/api/screenshot/glasses
```

Pass: `list` keeps its order whatever is focused; `recent` is most-recent-first; the menu rows
on the glasses follow `recent`; focusing another window while the menu is open moves only the
`*` marker, not the rows; reopening picks up the new order; choosing a row switches to the
window named on that row. While the menu is open the mirror is paused and the tiles are blanked
(`tiles blanked: 4 push(es)`); moving the selection pushes no images.

### Instance supersede

```bash
curl -s $A/api/console | grep -o 'inst=[a-z0-9-]*' | tail -1          # current id, from the log
timeout 4 curl -sN "$E/api/stream?inst=fake-takeover" >/dev/null &
curl -so wv.png $A/api/screenshot/webview                             # full-screen curtain
```

Pass: server logs `stream inst=fake-tak TAKES OVER from …`, client logs `SUPERSEDED by instance
…` and shows the curtain; "take over here" reloads with a new id; subscribing again with a
displaced id logs `is STALE … told to stand down`. Copy ids from logs, not from screenshots
(the server prints only eight characters).

### Phone palettes

Separate the simulator windows, then click `task`, `window` and `apps` at coordinates read from
`screenshot/webview`. Pass: each opens; `task` lists windows most-recent-first and a window
spawned with `POST /api/spawn` appears while it is open; tapping a row logs `select … => ok`;
a `window` action logs `window palette ratpoison … => ok`; a destructive row asks for a second
tap; launching from `apps` logs `[ew] spawn id=… => ok` on the server. Background:
[notes/2026-10-apps-and-palettes-sim-verification.md](notes/2026-10-apps-and-palettes-sim-verification.md).

### Voice without a microphone

`?voicefeed=<url>` fetches raw PCM (s16le, mono, 16 kHz) and feeds it through the same entry
point as glasses audio, 1600 bytes per frame. Vite serves the repo root, so a file there is
reachable as `/name.pcm`. No audio file ships with the repo.

```bash
ffmpeg -y -i speech.wav -ar 16000 -ac 1 -f s16le ja.pcm        # any speech recording
EW_STT_URL=http://127.0.0.1:8757/v1/audio/transcriptions EW_X11_RUNTIME_DIR=/tmp/ew-iso \
  scripts/sim.sh --headless --keep --display :191 --api-port 8791 --port 5291 \
                 --sim-display :186 --automation-port 9909 --app-query 'voicefeed=/ja.pcm'
curl -s $A/api/console | grep -i voice
curl -so g.png $A/api/screenshot/glasses                       # confirm dialog, within 60 s
curl -s -X POST $A/api/input -H "$H" -d '{"action":"click"}'   # choose Send
```

Needs a running recogniser ([voice.md](voice.md)); `GET /api/health` must report `"stt":
true`. `touch` a client source file to reload the WebView and replay the feed. Background:
[notes/2026-11-voice-phone-mic-fallback.md](notes/2026-11-voice-phone-mic-fallback.md).

### Authenticated curl

```bash
export EW_STATE_DIR="$PWD/.ew-x11/state"         # the registry the server under test uses
S=http://127.0.0.1:8787; O=$S                    # O must equal EW_ORIGIN when that is set
J() { python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }
TID=$(node scripts/ew-auth.mjs add-test)
N=$(curl -s $S/api/auth/challenge | J nonce)
SIG=$(node scripts/ew-auth.mjs sign "$N" "$O")
TOK=$(curl -s -X POST $S/api/auth/session -H "$H" \
  -d "{\"clientId\":\"$TID\",\"nonce\":\"$N\",\"sig\":\"$SIG\",\"origin\":\"$O\"}" | J token)
curl -s -H "Authorization: Bearer $TOK" $S/api/health
T=$(curl -s -H "Authorization: Bearer $TOK" $S/api/auth/ticket | J ticket)
curl -sN -m 2 "$S/api/stream?ticket=$T" | head -3      # the stream takes a ticket, not the token
node scripts/ew-auth.mjs revoke "${TID:0:12}"          # clean up
```

A nonce works once. `add-test` counts against `EW_MAX_CLIENTS`. Every auth failure is the
same `401`, and `/api/health` is gated too, so a liveness probe must treat `401` as alive.
Contract: [security.md](security.md). Background:
[notes/2026-11-authenticated-curl-checks.md](notes/2026-11-authenticated-curl-checks.md).

## Tests, lint and format

```bash
npm run check      # lint + typecheck + tests; run before every commit
npm run format     # Biome formatting and safe lint fixes
npm test           # vitest run
```

- Suites are `tests/<area>.<subject>.test.ts` with `<area>` one of `client`, `server`,
  `shared`. Vitest is configured in `vite.config.ts`; `tests/setup.ts` sets `EW_ENV_FILE=''`
  so no suite depends on the developer's own env file. `tests/authFixture.ts` provides auth
  state; `tests/fixtures/` is excluded from Biome.
- Prefer behaviour tests through exported functions. Where behaviour cannot run without the
  glasses, a source audit asserts on source text; write these with `tests/helpers/source.ts`
  (insensitive to formatting) and audit code, never comments.
- Biome (`biome.json`) lints and formats: 2 spaces, 100 columns, single quotes, no semicolons,
  organised imports. Conventions for comments and commits are in
  [CONTRIBUTING.md](../CONTRIBUTING.md).

## Packaging

```bash
npm run pack       # npm run build, then evenhub pack app.json dist -o out.ehpk
```

`out.ehpk` (ignored by git) is the file uploaded to Even Hub for a beta or store release. The
packer is `@evenrealities/evenhub-cli`, a dev dependency; nothing else is needed.

- The package holds `app.json` and the contents of `dist/` only. The server is not part of
  it and is installed separately by each user.
- Set `version` in both `app.json` and `package.json` before packing. The packer reads only
  `app.json`; `tests/manifest.test.ts` fails when the two differ.
- The packer stamps `min_app_version` from the newest SDK published on npm, not from the one
  installed here. If a newer SDK has appeared since the pinned one, add
  `--sdk-ver <installed version>`: `npm run pack -- --sdk-ver 0.0.16`.
- `npx evenhub pack --check app.json dist` asks Even Hub whether the package id is free; it
  needs a network connection and `evenhub login`.
- A packaged app is served from the Even App's own origin, not from the server, so it starts
  without a server address. CORS allows it by default while authentication is enforced; with
  `EW_AUTH=0` its origin must be in `EW_ORIGINS`. See
  [getting-started.md](getting-started.md#load-the-app-in-the-even-app).

## Vite rules

- Do not pre-bundle the Even Hub SDK: it stays in `optimizeDeps.exclude`
  ([decisions/sdk-not-prebundled.md](decisions/sdk-not-prebundled.md)).
- A dependency reached only through a dynamic `import()` goes in `optimizeDeps.include`.
  Otherwise the first page that reaches it makes the dev server re-optimise mid-session, which
  can wedge it. A wedged Vite ignores `SIGTERM`; kill it by pid with `-9`.
- The dev server sends `cache-control: no-store` on everything. The WebView inside the Even
  App cannot be hard-reloaded, so it must never be handed something cacheable.
- An HTTP response from Vite does not prove the simulator's WebView runs the new code; check
  the `boot:` timestamp in `/api/console`.
- Hosts other than `.ts.net` need `EW_ALLOWED_HOSTS`; HMR behind a TLS proxy needs
  `EW_HMR_HOST` / `EW_HMR_PORT` ([configuration.md](configuration.md)).

## Process hygiene

- Stop processes by pid, never `pkill -f <pattern>`: the pattern matches the invoking shell's
  own command line. The scripts start children under `setsid` and kill recorded process groups.
- To remove a display session for good, find its X server (`pgrep -af 'Xephyr :100|Xvfb
  :100'`), kill that pid and delete `session.json`. The simulator's X server belongs to
  `sim.sh` and goes away with it.
