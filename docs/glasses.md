# Glasses side

How the WebView client drives the Even G2 display: the page it creates, how tiles reach the
panel, when it pushes and when it stands down, how gestures are read and routed, and the menu
it draws on the glasses.

Related: [architecture.md](architecture.md) (pipeline and geometry overview),
[protocol.md](protocol.md) (HTTP and SSE contract), [phone-ui.md](phone-ui.md) (the phone
operating surface), [voice.md](voice.md) (voice input).

Names below are functions and constants in `src/client/` and `src/shared/`; search for them by
name.

## Containers

The page is fixed. It is declared once, in `pageObjects()`, from constants in
`src/shared/geom.ts`.

| containerID | Type | Geometry | `zOrderIndex` | Role |
| --- | --- | --- | --- | --- |
| 1 (`EVENT_LAYER_ID`) | text, `content: ' '`, `isEventCapture: 1` | 576x288 at (0,0) | 5 | Transparent input-capture layer. Never written after the page is created. |
| 2, 3, 4, 5 | image | 288x144 at (0,0), (288,0), (0,144), (288,144) | 1, 2, 3, 4 | Tiles 0-3: top left (TL), top right (TR), bottom left (BL), bottom right (BR) |
| 6 (`OVERLAY_LAYER_ID`) | text, `content: ' '`, `isEventCapture: 0` | 576x288 at (0,0) | 6 | Overlay: menu, notices, voice dialog |

`containerTotalNum` is 6. The image container for tile `i` is `2 + i`. Both eyes see the whole
576x288 panel; no quadrant belongs to an eye.

Platform rules that shape this allocation:

| Rule | Consequence |
| --- | --- |
| An image container is at most 288x144, per dimension (and at least 20x20). | A tile is one quadrant. |
| A page holds at most 4 image containers. | 4 x 288x144 is exactly 576x288, so the 2x2 grid is the only layout that covers the panel. |
| Only one container may set `isEventCapture: 1`. | Every gesture arrives through container 1. |
| Without `zOrderIndex`, images always render in front of text. | Text over the tiles needs a z-order plan. |
| `zOrderIndex` is all-or-nothing: if one container sets it, every text and image container must, with unique values; larger is nearer the front. | All six containers carry one. A violation fails `create` and `rebuild` inside the SDK, before the host sees the page. |
| The host refuses a page that has both `menuObject` and `zOrderIndex`. | The firmware context menu is not registered. |
| Only image containers (`updateImageRawData`) and text containers (`textContainerUpgrade`) can be updated in place. | Anything that changes after creation is a tile or overlay text. |

Background: [container semantics observed on hardware](notes/2026-10-glasses-container-semantics.md).
Decisions: [quadrant tiles](decisions/quadrant-tiles.md),
[separate input and overlay layers](decisions/separate-input-and-overlay-layers.md),
[client-drawn menu instead of the firmware menu](decisions/client-drawn-glasses-menu.md).

### Return values are not proof of drawing

`createStartUpPageContainer => 0`, `rebuildPageContainer => true`, `updateImageRawData =>
'success'` and `textContainerUpgrade => true` mean the host accepted the call. None of them means
anything is visible. Judge drawing by looking at the panel or by measuring pixels in a simulator
screenshot. The simulator accepts pages that real glasses refuse, so a refusal in the simulator
is conclusive and an acceptance is not.

## Tile pipeline

A tile travels: stream event, inflate to palette indices, pending flag, then (inside the pump)
pick, grey conversion, PNG encode, comparison with what the container holds, push.

### Arrival, grey conversion, encoding

- Arrival. The server sends each changed quadrant as an 8-bit indexed PNG of ANSI palette
  indices. `indexPlaneFromPng` (`src/shared/png.ts`) inflates it and accepts only that shape
  (colour type 3, depth 8, filter 0, expected size); anything else is dropped with a log line.
  A per-quadrant sequence number drops an inflate that finishes after a newer one. Arrival only
  stores the index plane, marks the quadrant pending and kicks the pump. Exactly one event stream
  may be open: an arrival rate above 40 tiles/s means two are.
- Grey conversion. `deriveGrey` runs at dequeue. Each ANSI index maps to one of the panel's 16
  levels through `LEVEL_BY_ANSI`, derived from `levelOf` and `GREY_RAMP`. The phone's synthetic
  pointer is stamped into the plane from a prebuilt mask (fill level 15, outline level 0).
- Encoding. `encodeTilePng` writes colour type 3, bit depth 4, with a constant 16-entry grey
  palette (`TILE_PLTE`); a typical terminal tile is about 2 KB. `canvas.toBlob` is not used. Pack,
  filter and deflate run in a worker (`EncodeOffload`, `encodeWorker.ts`) because
  `CompressionStream` occupies the main thread in a WebView. If the worker fails to load, throws
  or does not answer within `OFFLOAD_TIMEOUT_MS` (2 s), encoding stays on the main thread for the
  rest of the session.

Decision: [4-bit indexed PNG tiles](decisions/indexed-png-tiles.md).

### The pump

`pumpTiles` is the only producer of tile pushes during mirroring; `kickPump` starts it.

- Serial. One `updateImageRawData` is in flight at a time, across all quadrants.
- Latest wins. There is no queue: a quadrant has one pending flag and one index plane, and a newer
  arrival overwrites it. Derive and encode happen at dequeue, only for frames actually sent.
- Fair. `pickTile` scans from `tileCursor`, which advances past each quadrant served and persists
  across drains, so a dirty quadrant is reached within four pushes.
- Diffed. Encoded bytes equal to `lastTiles[i]` (what the container is believed to hold) are not
  sent. `forcePending` clears that baseline so all four quadrants are sent again.
- `greyPending[i]` is cleared before the `await` on the encode, so an arrival during the encode
  re-marks the quadrant instead of being lost.

`pushImage` is the single place an image is pushed. It refuses immediately when there is no
bridge, the link is down, the page is not established, or the instance is superseded. Otherwise
it tries up to 4 times, 8 s timeout each, 500 ms apart, and abandons the ladder if the link goes
down in between. A quadrant whose push fails is skipped for the rest of that drain.

Decision: [serial pump with encode at dequeue](decisions/tile-pump-latest-wins.md).

### Cost model

Measured on a G2 with SDK 0.0.16. Pushing is transfer-bound; the phone's CPU is not the limit.

| Fact | Value |
| --- | --- |
| Push of a production tile (2.1-2.7 KB) | 300-450 ms; about 2.2-2.5 pushes/s; a full repaint is 1.2-1.9 s |
| Push of a near-empty tile (159 B) | 85-116 ms; this is the floor |
| Small tiles (up to 600 B) | about 75 ms + 0.038 ms/byte; the 565 B black tile is about 96 ms, four are about 390 ms |
| Granularity | Push times fall on a 30 ms grid |
| What the time depends on | Pixel detail. The host decodes the PNG and re-compresses pixels, so removing PNG bytes from identical content gains nothing (583 B changed the time by 0-10 ms) |
| Link drift | The same payload varies 1.5x within a minute; only interleaved (ABBA) comparisons within one run are valid |
| Message rate ceiling | The SDK holds the image path for 100 ms per update, so 10 updates/s at most |
| Client main thread per tile | inflate 0.69 ms, colour mirror 0.07 ms, grey derive 0.17 ms, encode about 2 ms (plus about 1 ms worker round trip on a phone) |

No linear formula holds outside the range it was fitted on. Background:
[tile transfer timing](notes/2026-10-tile-transfer-timing.md),
[client tile pipeline measurements](notes/2026-10-client-tile-pipeline.md).

## Establishing the page

At boot the client opens the event stream first (it works without a bridge), then loads the SDK
and waits up to 8 s for the bridge. With a bridge it subscribes to hub events and device status,
reads `getDeviceInfo()`, and calls `establishPage()`:

1. `createStartUpPageContainer(pageObjects())`. Results: 0 success, 1 invalid, 2 oversize,
   3 out of memory. This call is allowed once per glasses-UI lifetime.
2. `rebuildPageContainer(pageObjects())`, always, whatever step 1 returned. Only a rebuild makes
   the containers live; after a create alone, tile pushes report success and paint nothing.
3. The page is established if either call succeeded (`pageEstablished`,
   `src/shared/establishPage.ts`). `markEstablished` is the only place `established` is set, and
   success also marks the link up.

After a successful establish the client restates the overlay if it has content, sets
`forcePending` and kicks the pump.

### Retry

If the page is not established, `markEstablished(false)` arms a retry. A retry issues the rebuild
only (`reestablishPage`), and only while `established` is false. Every bridge call has an 8 s
timeout.

| Constant | Value | Meaning |
| --- | --- | --- |
| `ESTABLISH_RETRY_MIN_MS` | 5 s | First delay; doubles after each failure |
| `ESTABLISH_RETRY_MAX_MS` | 60 s | Ceiling while the link is up |
| `ESTABLISH_RETRY_LINKDOWN_MAX_MS` | 15 s | Ceiling while the link is down |

- While the link is down, each attempt first re-reads `getDeviceInfo()`; the status event stream
  is not reliable during an outage.
- A link-up transition retries at once with the backoff reset (`reestablishNow`). A `connecting`
  status pulls a pending retry forward (`reestablishSooner`) without changing the link verdict.
- A rebuild that throws on timeout is caught and the retry re-armed; `reestablishBusy` prevents
  re-entry.
- A refused create with a refused rebuild is what disconnected glasses look like. The phone shows
  a warning bar while the link is down or after two failed attempts.

Decision: [establish once, never rebuild a live page](decisions/establish-once.md).
Background: [link loss, establish and recovery on hardware](notes/2026-10-glasses-link-and-establish.md).

## When the pump stands down

Two kinds of gate exist and they are kept separate.

Hard gates mean "do not touch the bridge". They are checked at the top of `pumpTiles` and again
inside `pushImage`:

| State | Set by | Cleared by |
| --- | --- | --- |
| Link down (`glassLinkUp === false`) | `connectType` `disconnected` or `connectionFailed`; `getDeviceInfo()` returning no device at boot | `connectType` `connected`; a successful establish |
| Page not established | a failed establish | a successful establish or retry |
| Superseded | `{t:'supersede'}` on the stream | reload only |

Overlay gates mean "the glasses are listening, but the tiles must hold still". `overlayActive()`
is true when any of these holds, and the pump checks it before each drain, each pick and after
each encode:

| State | Meaning |
| --- | --- |
| `menuOpen` | The on-glasses menu is up |
| voice dialog active | See [voice.md](voice.md) |
| `availMsg !== null` | The server reported `{t:'avail', ok:false}` |
| `mirrorPaused() !== null` | The lens is switched off on the phone, or the glasses are in their case |
| `glassCovered` | A firmware foreground layer (for example a phone notification) covers the panel |
| `overlayBusy`, `measuringLink` | A hide transition is in progress; a `?stats=1` link baseline is running |

### Link state

- The link starts as reachable and only host evidence changes it. A host that never sends
  `deviceStatusChanged` keeps the mirror running.
- `connecting`, `none` and unknown values leave the verdict unchanged (`pushableFromConnectType`
  returns `null`). A `none` record with default fields follows a disconnect within milliseconds.
- Push failures never change the link state. `setGlassLink` is the only writer.
- Status events are filtered by the glasses' serial number, so a ring going to sleep does not stop
  the mirror. An empty serial counts as the glasses; with no known serial every event is used.
- On link up: reset the diff baseline, kick the pump, restate the overlay, and retry the
  establish if there is no page. An established page is not rebuilt.
- While the link is down, overlay text is not pushed (it is re-sent on link up), and the green
  mirror mode and the glasses microphone are unavailable.

### Lens pause and the case

`mirrorPaused()` has two causes: the `lens` latch on the phone (`lensOn`, session state, not
persisted) and `isInCase` from the device status. The pause is an overlay: the tiles are blanked
to black, which on an emissive panel is also the lowest-power picture, and a notice names the
control that paused the mirror. One press of the button while it reads `lens:case` overrides the
case sensor for the session (`caseTrust`). `isWearing`, `batteryLevel` and `isCharging` are logged
and drive nothing.

### Foreground layers

`foregroundChange()` reports event types 4 and 5 as `enter` and `exit`. The pump stands down
while a layer is up and is kicked on exit. The diff baseline is not reset on exit: the firmware
composites the layer over the image containers without altering them. Types 4 and 5 do not mean
that a menu opened.

Decision: [link and pause gating](decisions/glasses-link-gating.md).

## Instance ownership

A WebView can outlive a crash of its host app, and two pages would then share one bridge and one
pair of glasses. Each page load mints `INSTANCE_ID` and sends it as `?inst=` on the stream URL;
the server arbitrates per authenticated client ([protocol.md](protocol.md)). A page that receives
`{t:'supersede', by}` calls `standDownSuperseded`: it closes its stream, gates the pump,
`pushImage`, the establish retry and the microphone, and covers the phone UI with a curtain whose
only control reloads the page. Standing down is one-way. It never calls `shutDownPageContainer`,
which would end the app the winning page runs in.

Decision: [instance supersede](decisions/glasses-instance-supersede.md).

## Overlay

Container 6 shows one text at a time. `overlayContent()` picks it in this order: voice dialog,
menu, setup notice, `X unavailable` notice, `mirror paused` notice, startup hint, blank (`' '`).

The setup notice is what the lens shows while there is no usable server, so that a first start
is never a black panel (`setupNoticeText()` in `src/client/hints.ts`). It has three forms:

| Auth state | Notice |
| --- | --- |
| `unpaired`, `unauthorized` | Pair this phone: start the server, run `ew-auth.mjs pair URL` on the PC, open the pairing URL on the phone |
| `offline` on the built-in default address | Set the server address in the card on the phone |
| `offline` on an address a person gave | Server unreachable: the address, two things to check, where to change it |

No gesture closes it; it goes when the state clears (`syncSetupNotice()`, called from
`setAuthState`). The menu still opens over it, which keeps Exit reachable.

The startup hint lists the gestures (`startupHintText()` in `src/client/hints.ts`). It is
considered once per page load, at the first establish, and shown on the first three launches
per device (`HINT_SHOWS`, counted in localStorage). It stays until a gesture: a swipe
or tap only closes it; a double-tap closes it and opens the menu. The menu or the voice dialog
coming up retires it, so it never returns after they close.

`syncOverlay()` chains transitions so they never overlap; `applyOverlayTransition` fixes the
order:

```
SHOW:  standDown -> blankTiles -> writeOverlay(content)
HIDE:  standDown -> writeOverlay(' ') -> resetBaseline -> repaintTiles
```

- `standDown` waits for the in-flight push, so a landing frame cannot relight a blanked quadrant.
- `blankTiles` pushes a constant all-black tile (565 B, encoded once) to every quadrant that is
  not already black. Black is always level 0, regardless of invert. Moving the selection inside
  the menu therefore costs one text push and no image push.
- Hiding has no "restore" step: resetting the baseline and kicking the pump repaints all four
  quadrants over the black.
- Text writes go through `LatestAsyncWriter`: serial per container, newest content wins.

Decision: [blank the tiles under the overlay](decisions/blank-tiles-under-overlay.md).

## Gestures

### Normalisation

`evenGestureType(event)` (`src/shared/evenEvent.ts`) reduces every envelope shape the host emits
(`listEvent`, `textEvent`, `sysEvent`, a bare `eventType`, `jsonData`; numeric or string codes)
to a `GestureName` or `null`.

| Event | Code | Result |
| --- | --- | --- |
| `CLICK_EVENT` | 0 | `tap` |
| `SCROLL_TOP_EVENT` / `SCROLL_BOTTOM_EVENT` | 1 / 2 | `up` / `down` |
| `DOUBLE_CLICK_EVENT` | 3 | `double` |
| `FOREGROUND_ENTER_EVENT` / `FOREGROUND_EXIT_EVENT` | 4 / 5 | `null`; handled by `foregroundChange()` |
| abnormal exit, system exit, IMU | 6-8 | `null` |
| `LONG_PRESS_EVENT` / `LONG_PRESS_RELEASE_EVENT` | 9 / 10 | `long` / `longRelease` |

- Code 0 is omitted on the wire. A missing `eventType` is a tap only when one of the three
  protobuf envelopes (`listEvent`, `textEvent`, `sysEvent`) is present; `jsonData` alone is not an
  envelope.
- String codes test `LONG_PRESS_RELEASE` before `LONG_PRESS`, and `FOREGROUND_EXIT` never matches
  a bare `EXIT`, because the shorter names are substrings of the longer ones.
- `foregroundChange()` has no omitted-zero default.
- The input source (right temple, ring, left temple) stays on `sysEvent.eventSource`.

### De-burst and tap deferral

| Constant | Value | Rule |
| --- | --- | --- |
| `SWIPE_BURST_MS` | 140 ms | A swipe in the same direction within this window of the last accepted one is dropped |
| `TAP_BURST_MS` | 90 ms | Same for repeated taps and repeated doubles |
| `SINGLE_DEFER_MS` | 180 ms | A tap is held this long; a double arriving meanwhile cancels it |
| pair window | 180 ms | A tap within this window after a double is that double's own click and is dropped |

The host emits a click before a double click, which is why taps are deferred. A double is never
dropped in favour of a tap.

### Routing

`onHubEvent` handles, in order: audio frames (to the voice dialog), foreground changes, long
presses, then double, swipe and tap.

| Gesture | Voice dialog open | Menu open | Otherwise |
| --- | --- | --- | --- |
| swipe up / down | dialog | move the selection (wraps) | `POST /api/input {gesture:'up'\|'down', count}` through the swipe debouncer |
| tap | dialog | select the row | flush the debouncer, then `POST /api/input {gesture:'tap'}` (the server sends Enter) |
| double | dialog | up one level; close at the root list | open the root list |
| long press | ignored | starts voice input if `GET /api/health` reports `stt: true` | same |
| long press release | not bound | not bound | not bound |

The server routes only `tap`, `double`, `up` and `down`; long presses never leave the client.
`longRelease` is deliberately unbound so that a lost release cannot leave anything open.

### Swipe debounce and move-N

`NavDebouncer` (`NAV_SETTLE_MS = 600`) is leading-edge: the first swipe is sent at once with
`count` 1. Further swipes in the same direction within 600 ms accumulate and are sent as one
request with `count: N` when 600 ms pass without another. A change of direction or an idle gap
starts a new leading edge. Tap and double flush the debouncer first so they act at the settled
position. The server clamps `count` to 64.

### Per-app swipe bindings

What `up` and `down` send is resolved on the server for the window that has focus at that moment;
the glasses side only sends the gesture and the count.

- Identity keys, most specific first: `app:<LauncherEntry.id>`, `exe:<absolute path>`, `comm:<name>`,
  `cls:<class>`, `title:<title>` (a candidate only when none of `exe`, `comm`, `cls` resolved),
  then `*`, then the built-in `Up` / `Down` (`appKeys`, `resolveSwipe` in
  `src/shared/bindings.ts`).
- A binding is a chord: modifiers from `ctrl`, `alt`, `shift` plus one key from the closed
  catalogue `KEYS` (`src/shared/keys.ts`). `WheelUp` / `WheelDown` turn the wheel instead and act
  on the window under the pointer.
- Move-N repeats the bound chord N times, whatever it is.
- With no entry other than `*`, the gesture path does not look up the focused window
  (`needsWindow`).

Routes: [protocol.md](protocol.md). Editor: [phone-ui.md](phone-ui.md). Decision:
[closed key set](decisions/swipe-bindings-closed-key-set.md). Background:
[per-app swipe bindings](notes/2026-10-swipe-bindings.md).

## On-glasses menu

The menu is text in container 6, opened by a double tap. `src/shared/glassMenu.ts` owns every
level below the root as pure data; the client owns the root list, the path stack and the
selection.

### Root list

Built by `buildMenuItems` and laid out by `rootPages`: a header and at most nine rows
(`ROOT_MAX_ROWS`, the same budget as a level). Labels are cut by width, to
`ROW_LABEL_UNITS` (see [Row width](#row-width)); the focus mark `*` and the `+ ` prefix count
towards it.

| Rows | Source | On tap |
| --- | --- | --- |
| `Menu...`, always first, `itemID` 1; `Menu/Prev/Next...` when there are several pages | fixed | descend into level `menu` |
| Windows, all of them; the focused one is marked `*` | `{t:'windows'}.list` | `POST /api/windows {wid}` |
| `+ <name>` launcher rows, at most 8 (`MENU_MAX_APPS`), after the windows; paged with them | most recently launched apps, `{t:'apps'}.recent` | `POST /api/spawn {id}` |

- The header is `Tasks`. Eight windows and apps fit under `Menu...` on a page. Beyond eight
  of them together they are split into pages of eight, windows first, and the header carries
  the page (`Tasks 1/2`). An app row is never dropped for space.
- While paged (`MenuState.rootPaged`), level `menu` ends `Prev Page`, `Next Page`
  (tokens `page:prev` / `page:next`). Each returns to the root list on the neighbouring page,
  wrapping, with the cursor on row 1. A page spends no row on paging.
- Recency decides the pages as well as the order: the most recently focused windows are on
  the first page.

- Windows are drawn most-recently-focused first (`mruOrderItems`, from `{t:'windows'}.recent`),
  never-focused ones last. This is display order only; `itemID`s follow the server's order.
- The order is frozen while the menu is open (`menuRootOrder`) so a row cannot move under the
  cursor, which opens on `Menu...`.
- A window row is its title (`windowLabel`). A title that leaves room is followed by the
  application in brackets, `~ (XTerm)`, unless it already names it; a long title is cut and
  stands alone. The application is `WinInfo.cls`, else `WinInfo.app`, the same name the
  phone's `task` palette shows; the client does not know which OS filled them.
- Windows are selected by `wid`. Selecting a row closes the menu first, then acts.

### Levels

| Level id | Rows |
| --- | --- |
| `menu` | `Keys...`, `Window...`, `Launch...` (only with applications), `[x] Invert`, `Close Window` (only with a focused window), `Exit...` |
| `keys` | `Mods...`, `Move...`, `Edit...`, `Func...`, `Chars...` (`Letters...`, `Digits...`, `Punct...`, `Keypad...`), `Clicks...` |
| `kmods` | `[ ] Ctrl`, `[ ] Alt`, `[ ] Shift`: sticky for the next key, then cleared |
| `kmove`, `kedit`, `kfn` | the `nav`, `edit` and `fn` groups of the key catalogue |
| `kclick` | `Click`, `Double-click`, `Click-hold`, `Click-release`, `Wheel up`, `Wheel down`, at the current pointer position |
| `rp` (`Window...`) | the window-manager key catalogue `RP_KEYS`: help, last window, next, previous, new terminal, redisplay, banish pointer, `Kill (force)...` |
| `rpkill`, `cexit` | confirmation levels: the action, then `< Back` |
| `launch` (`Launch...`) | every application in `{t:'apps'}.list`, in name order |
| `<id>/N` | page N of a group too long for one level |
| `launch/I/J...` | the page, or group of pages, at that path of indices |

A level holds at most `LEVEL_MAX_ROWS = 9` rows, because the panel shows 10 full text lines
including the breadcrumb header. No row is spent on going back: a double tap ascends, and the
header says so. Only the confirmation levels end with `< Back`, so that the cursor has a row to
rest on that does nothing. Longer groups are split by `balancedChunk` into evenly sized pages
whose row label lists the page's keys. Labels written in the code are ASCII only: the firmware
font's coverage is unknown and a missing glyph looks like a broken menu. The header is the
breadcrumb (`pathHeader`), followed by what a double tap will do.

### Launch

`Launch...` lists every application, so that the glasses can start one that was never launched
from the phone. The number of applications is whatever the machine has installed, so the level
is an index of unbounded depth (`launchTree`):

- Up to 9 applications are the level itself.
- More are split into pages of at most 9, and the level lists the pages. More than 9 pages
  (82 applications or more) are grouped again, as often as it takes.
- A page row names its range, then the start of each name on it:
  `Fi-Gn (Files|Firefox|GIMP|Gnome Te)`. Each entry is as long as lets them all fit, from
  eight characters down to four; at four, a list that still does not fit ends `...`.
  Neighbours that start alike, whatever the case, are listed once. A row for a group of pages lists where each page starts. The
  breadcrumb shows only the range (`MenuRow.crumb`).
- Names are shown as they are, like window titles, and are cut by width
  (see [Row width](#row-width)).
- Order is by lower-cased code point, so it is the same on every device.

### Row width

A row must not overflow. The firmware breaks an overflowing row at its first space, so the
cursor is left alone on a line, the label takes the next two, and the last row of the list
falls off the panel. Arbitrary text (a window title, an application name, an index row) is
therefore cut by width, to `ROW_LABEL_UNITS = 57` units of `glassWidth`
(`src/shared/voiceDialog.ts`), of the `LINE_UNITS = 63` a line holds. The cursor column and
the focus mark take up to 2.8 more, so a full row is 95 % of the line.

`glassWidth` is the one width model for lens text: the menu, the voice dialog's line counts,
the startup hint and the phone's copy of the lens text all use it.

| Characters | Units |
| --- | --- |
| CJK and full width | 2.25 |
| capitals | 1.35 |
| `m`, `w`, `@`, `%` | 1.5 |
| digits and `-` | 1.18 |
| `f`, `t`, `r` | 0.65 |
| `\|`, `i`, `l`, `j`, `I`, brackets, punctuation, space | 0.5 |
| anything else (lower case) | 1.15 |

Three lines measured on a G2 fix the scale; each filled a line and one more character
wrapped:

| Line | Length |
| --- | --- |
| CJK | 28 characters |
| A ruler of digits and `-` | 53 characters |
| `*` and a window title in lower case (`Taumatawhakatangi...`) | 58 characters |

The classes in between are fitted: those three come out at a full line, and rows seen to fit
(the `Launch...` index of 47 applications, a mostly Japanese window title) come out under
one. They are not a measurement of the firmware font.

Characters that are not meant to be seen (soft hyphen, zero-width space and joiners,
direction marks, control characters) are removed from a label before it is cut (`plainText`).
The panel does not hide them: a soft hyphen is drawn as `-`.

### Tokens

Each row is `{label, token}`. `parseToken` is the only interpreter; an unknown token is logged and
dropped.

| Token | Action | Menu afterwards (`rowMenuEffect`) |
| --- | --- | --- |
| `sub:<id>`, `back` | descend, ascend | stay |
| `mod:<ctrl\|alt\|shift>` | toggle a sticky modifier | stay |
| `key:<name>` | `POST /api/desktop/input {kind:'key'}` with the armed modifiers; `<name>` must be in `KEYS` | resume |
| `click:<action>` | `POST /api/desktop/input` pointer action (`clickInput`) | resume |
| `rp:<key>` | `POST /api/wm/key {key}`; `<key>` must be in `RP_KEYS` | reset |
| `app:<id>` | `POST /api/spawn {id}` | reset |
| `close` | `POST /api/windows/close {wid}` for the focused window | reset |
| `invert` | toggle polarity | reset |
| `exit` | `shutDownPageContainer(1)` | reset |

- `stay`: the menu remains open.
- `resume`: the menu closes so the result is visible and remembers its level; the next double tap
  reopens it at the same row, revalidated against live state (`resumablePath`). Closing the menu
  by a double tap forgets it.
- `reset`: the menu closes and the next open starts at the root list.

The menu closes before the action runs, because the tiles are black and the pump is stood down
while it is open. `Exit` and `Kill (force)` sit behind a confirmation level. Repetition belongs on
swipe bindings; the menu is for one-shot operations.

Background: [gestures and the firmware menu](notes/2026-10-gestures-and-firmware-menu.md).

## Invert

The panel is see-through and emissive: black emits nothing and is transparent. Invert flips the
polarity of mirrored content and is entirely client-side. It is resolved as `?invert=1`, then
`localStorage['ew.invert']`, then off, and the winning value is stored.

Invert flips the grey level (`15 - level`) during grey conversion. The PNG palette is constant.
The synthetic pointer and the black blanking tile are not inverted. Toggling it re-marks every
cached quadrant and runs an overlay sync, which resets the diff baseline and repaints all four
tiles; without that, unchanged quadrants would keep the old polarity. The colour mirror on the
phone does not show invert.

## Pump statistics

`?stats=1` (an instrument, [never persisted](decisions/instrument-flags-query-only.md); flags are
listed in [development.md](development.md#query-parameters)) prints one line every 10 s and brackets the run
with a link baseline: 8 fixed-pattern pushes at boot and again after 60 s, each showing a bright
mosaic on the glasses for about 3.5 s. `?encworker=worker|main|abba` pins or alternates the
encode path.

| Field | Meaning |
| --- | --- |
| `push N@R/s med p90` | Push wall time, including retries |
| `TL TR BL BR`, `maxwait` | Pushes per quadrant, and the longest a quadrant with new content waited (stand-downs excluded) |
| `decode`, `derive`, `encode` | Arrival work (a rate above 40/s means two streams are open) and dequeue work (rates should equal the push rate). `encode` is wall time across an `await` |
| `late blk` | Main-thread occupancy above the timer's own floor; compare only between arms of one run |
| `wasted N/M enc E` | Arrivals that never reached the glasses; `E` of them had already been encoded |
| `linkbase(start\|end)` | Baseline medians; if they differ by more than 15 % the run prints `LINK DRIFTED` and is not comparable with any other |

## Invariants

1. `rebuildPageContainer` has one call site (`rebuildPage`) and two callers: the mandatory
   follow-up in `establishPage`, and `reestablishPage` while no page is established. Nothing
   rebuilds a live page; doing so during streaming blacks out the display.
2. `established` is assigned only in `markEstablished` and is never true after a failed
   establish.
3. `updateImageRawData` calls are serial and go through `pushImage`. Overlay blanking pushes only
   after the pump has stood down.
4. Frames are never queued; the newest replaces the pending one.
5. Container 1 is never written after creation. All visible text goes to container 6.
6. Every container carries a unique `zOrderIndex` and no `menuObject` is registered.
7. `shutDownPageContainer` ends the app. Its only caller is the menu's `Exit` row. It is never
   called from error handling, recovery or supersede.
8. Whenever the grey derivation changes, or the tiles hold something other than the diff
   baseline says (overlay hide, link up, stream reopen, link baseline), set `forcePending` and
   kick the pump. Do not rebuild.
9. Link state changes only on host evidence, through `setGlassLink`. Absence of evidence never
   stops the mirror.
10. Never infer that something was drawn from a return value.
11. Menu labels written in the code are ASCII; every row label is at most `ROW_LABEL_UNITS`
    wide by `glassWidth`. A level never exceeds `LEVEL_MAX_ROWS`.

`tests/client.invert.test.ts`, `tests/client.overlay.test.ts`, `tests/client.link.test.ts` and
`tests/shared.glassMenu.test.ts` pin most of these.
