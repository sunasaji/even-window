# Phone helper UI

The page the Even App WebView loads is two things at once: the bridge that drives the glasses
([glasses.md](glasses.md)) and a control surface for the phone. This document describes the
control surface: every control, what it sends to the server, and the invariants an implementer
must keep. Routes and bodies are defined in [protocol.md](protocol.md).

The UI is built by `mountUi()` in `src/client/`; base CSS lives in `index.html`. Key buttons
are unstyled native controls ([decision](decisions/phone-native-button-chrome.md)).

## Layout

Top to bottom, one scrolling column (max width 720 px):

| Row | Contents |
| --- | --- |
| Title row | `even-window`, `?` (the [tour](#tour)), then the three palette openers `task`, `window`, `apps N` |
| Page warning | Hidden unless the glasses page is not established (see [glasses.md](glasses.md)) |
| Mirror preview | 576x288 canvas showing the mirrored desktop; also a touch surface |
| Text row | Text box, `🎤 voice` (only when the server reports speech-to-text; see [voice.md](voice.md)), `Submit` |
| Gesture row | `▼ dn`, `▲ up`, `● tap`, `●● dbl`, `font −`, `font +` |
| Tools row | `keys`, `vRing`, `vPad`, `inv:off`, `color`, `lens:on` |
| Keys panel | On-screen keyboard, hidden until `keys` is latched |
| `app` fold | Per-app bindings editor; the summary shows what is in force |
| `connection` fold | Status line, server URL + `apply`, `pair`, enrolled keys |
| Key probe | Only with `?keyprobe=1` |
| `log N/400` fold | Client log with `copy`, `follow:on/off`, `clear` |

Folds are ordered by how often they are needed: per app, per device, when something breaks.
When a newer page load takes over the glasses, this instance stops pushing and covers the UI
with `another instance owns the glasses` and a `take over here` (reload) button.

### Conventions for every control

- Pills are unstyled native `<button>` elements. Do not set a background or size on them: iOS
  drops the native button box when the background is overridden and the row re-lays out.
- Press feedback (`button:active`) and latched state (`setLit`) both use `filter: invert(1)`,
  a post-layout effect, so nothing moves under the thumb.
- `html, body` carry `touch-action: manipulation` (no double-tap-zoom delay) and
  `user-select: none`. Only `input`, `textarea` and the log panel opt back into selection.
- Form controls are 16 px or larger so iOS does not zoom on focus. The palette filter box is
  14 px, which is safe only because the viewport is locked to `maximum-scale=1`.
- A control that needs a guaranteed target has a 44x44 hit box with 32 px of ink (transparent
  border plus `background-clip: padding-box`).
- On-screen taps register at roughly 1.6 per second at most, a property of the WebView touch
  layer. Design for fewer taps, not bigger buttons: the text box sends a line per injection
  and vRing is one large surface.
- The simulator's WebView delivers mouse events and has no soft keyboard or iOS touch layer.
  Touch suppression, finger activation, keyboard-viewport behaviour and hardware-key delivery
  can be confirmed only on a device ([development.md](development.md)).

Background: [touch layer findings](notes/2026-10-phone-touch-layer.md),
[chrome and layout notes](notes/2026-10-phone-chrome-and-layout.md).

## Mirror preview

Shows the tiles the client receives, in the server's colours or as the lens renders them (see
[Pills](#pills)). While the on-glasses menu or the voice dialog is displayed, the preview is
blanked and shows the same strings the lens shows, marked `≈ lens text`; line breaks are an
estimate. The `X unavailable` and `mirror paused` notices are not copied.

### Direct touch

The canvas is an absolute-coordinate touch surface, always on.

| Gesture | Sends (`POST /api/desktop/input`) |
| --- | --- |
| Tap (contact that never moves 6 px; no time limit) | `clickat "x,y,1"` |
| Drag | `move` then `down 1`; throttled `move`s; final `move` then `up 1` |

- Left button only (`MIRROR_BUTTON`). Other buttons, the wheel and the on-lens arrow belong to
  vPad. There is no double-click kind; two taps are two `clickat`s.
- Coordinates come from `mirrorPixel()`: integer, floored, clamped to the last pixel.
- Ignored while vPad is open and while the lens-text copy is displayed. The gate is checked on
  press only; a drag in progress always runs to its release.
- An armed Ctrl/Alt from the keys panel is consumed by the next tap or drag.
- The arrow is not shown on the lens, but the cursor position is kept true so that vPad starts
  from the last touched pixel.
- The canvas has `touch-action: none`: a finger dragged across it does not scroll the page.

Invariants: the aiming `move` and the `down` are awaited inside one `padQueue` step, as are the
final `move` and the release, so neither can be overtaken. Press and release go through
`padPress` / `padRelease` only, and cancellation releases unconditionally.

## Text box and Submit

A three-row `textarea` plus `Submit`. `Submit` clears the box and sends the plan computed by
`sendPlan()` as sequential `POST /api/desktop/input` calls, stopping at the first failure:

1. Each non-empty line as one `{kind:'type'}` injection.
2. Between lines, `{kind:'key'}` with the app's newline chord. An empty line is only that key;
   trailing newlines are kept.
3. Finally, unless the app's submit key is `off`, `{kind:'key'}` with the submit chord.

Whitespace-only text sends nothing. Armed Ctrl/Alt never modify a submit.

| Per-app setting | Values | Default |
| --- | --- | --- |
| `submit` | `off`, `Enter`, `C-Enter`, `S-Enter`, `M-Enter`, `Tab`, `C-s`, `C-d` (`SUBMIT_CHORDS`) | `off` (type only) |
| `newline` | `Enter`, `C-Enter`, `S-Enter`, `M-Enter` (`NEWLINE_CHORDS`) | `Enter` |

Both are set in the [bindings editor](#bindings-editor-app) and resolved for the focused
window at the moment of sending, never cached.
Rationale: [submit key as a closed per-app list](decisions/phone-submit-key.md).

In the box (`fieldEnterAction()`): `Enter`, `Shift+Enter` and `Alt+Enter` insert a line break;
`Ctrl+Enter` and `Cmd+Enter` submit; any `Enter` during IME composition (`isComposing` or
`keyCode === 229`) is left to the IME.

### Hold to suppress the submit key

Holding `Submit` sends the text once without the submit key. The gesture exists only when the
focused app's submit key is not `off`. After 120 ms (`SUBMIT_HINT_MS`) a hint appears,
`hold → send without <key>`; after 300 ms (`SUBMIT_HOLD_MS`, the same threshold as vPad's
hold) the button inverts and the hint reads `release → send without <key>`. Releasing sends;
sliding off the button first cancels.

Invariants: there is one send path (`fire()`), and the `click` that follows a hold-send is
swallowed so the line is not sent twice. The hint is absolutely positioned with
`pointer-events: none` so it neither reflows the row nor takes the pointer.

## Gesture row

| Pill | Effect |
| --- | --- |
| `▼ dn` / `▲ up` | `onSwipe(±1)` through the same de-burst gate as the ring |
| `● tap` | `onTap()` |
| `●● dbl` | `onDouble()`: opens the on-glasses menu; inside it, up one level |
| `font −` / `font +` | The focused app's `fontsize` step |

The first four call the same functions as ring and temple gestures, so they follow the same
routing (menu, voice dialog, or `POST /api/input`); see [glasses.md](glasses.md).

`font −/+` injects the sequence of the app's `fontsize` setting through
`POST /api/desktop/input`. The choices are the closed list `FONTSIZE_STEPS`. The default is
`shift+KP_Add` / `shift+KP_Subtract`, xterm's own font-size action, which never reaches the
shell; it is the only entry that has been measured. `ctrl+wheel` reaches the window under the
pointer, not the focused one. Invariant: a modifier pressed with `keydown` during a sequence
is always released with `keyup`, also when a step fails.

## On-screen keys (`keys`)

`keys` toggles a panel with a fixed navigation grid (`Alt Tab / Esc Ent / Ctrl F…` on the
left, `Ins Home PgUp / Del End PgDn / ← ↑ ↓ → BS` on the right, `F…` unfolds F1–F12) and a
character keyboard (digits, letters, symbols, `Shift`, `space`, `Enter`).

| Key | Sends (`POST /api/desktop/input`) |
| --- | --- |
| Named key | `{kind:'key', arg:<xdotool keysym>}`, e.g. `Page_Up`, `BackSpace` |
| Character, no modifier armed | `{kind:'type', arg:<char>}` |
| Character with Ctrl/Alt armed | `{kind:'key', arg:'ctrl+minus'}`: keysym names via `CHAR_KEYSYM`, never glyphs |

- `Ctrl` and `Alt` are one-shot and cumulative: tap to arm (green), the next injection uses
  them and disarms them. "Next injection" includes the next vPad tap, hold or wheel drag and
  the next mirror tap or drag.
- `Shift` is sticky until tapped off and only relabels the character keys.
- Key names here are xdotool spellings. Do not route them through `keyNameToChord()`, which
  belongs to the gesture path.

## vRing

A full-screen gesture surface that stands in for the R1 ring and can be used without looking
at the phone.

| Gesture | Effect |
| --- | --- |
| Vertical swipe ≥ 40 px, anywhere | `onSwipe(∓1)` (finger up = ring up) |
| Tap on the left half | `onTap()` |
| Tap on the right half | `onDouble()` |
| Tap in the bottom 12 % of the screen, when the server has a recogniser | `onLong()`: opens the voice dialog, as the ring's long press does |
| `✕` (corner) | Close |

- Single versus double is decided by position, not by time, and at `touchend` with no delay:
  timers are unreliable under frame-forwarding load. Zone labels name the gesture sent, not
  its outcome, which depends on the mode.
- The long press is a tap on its own band for the same reason: a hold would have to be timed.
  The band is drawn, and hit-tested, only when the server has a recogniser; without one the
  two halves reach the bottom edge. A swipe may start or end in the band.
- A module-scope guard drops a repeat of the same gesture within 140 ms (swipes) or 260 ms
  (taps) before `ringFire` applies the shared de-burst. It must stay at module scope so it
  holds across overlay instances.
- Mouse input is accepted for the simulator and desktop. vRing and vPad are mutually
  exclusive, and opening a palette closes both.

## vPad

A full-screen virtual trackpad for the mirrored desktop's pointer. The pointer is composited
by the client, so while vPad is open the arrow is drawn on the lens and on the preview. The
overlay dims the page (`OVERLAY_DIM`, one constant for both overlays) and leaves a rectangular
hole over the mirror.

| Input | Effect | Sends (`POST /api/desktop/input`) |
| --- | --- | --- |
| One-finger drag | Relative move, mirror scale × `PAD_GAIN` (1.25) | `move`, at most one per 55 ms |
| Tap (≤ 300 ms, < 6 px) | Click with the selected button | `move`, `clickat "x,y,b"` |
| Hold > 300 ms without moving, or tap then drag within 450 ms | Press the selected button and keep following | `down b` … `move` … `up b` |
| Two-finger drag | Wheel | `click 4` / `click 5` |
| Mouse or trackpad hover | Relative move without gain | `move` |
| Physical right button | Right click at the arrow | `clickat "x,y,3"` |

- Movement is relative for fingers and hardware pointers alike: the OS cursor's position is
  ignored and only deltas are read (`hoverStep()`), also while a button is down.
  Rationale: [relative pad, absolute mirror](decisions/phone-pointer-surfaces.md).
- Button selector: three pills, `Left (1)`, `Middle (2)`, `Right (3)`, choose the button that
  taps and holds use. Default left; the choice persists across taps and across reopening the
  pad, and the hint line names it.
  Rationale: [modal button selector](decisions/phone-vpad-button-selector.md).
- Held modifiers: Ctrl/Alt armed in the keys panel before opening the pad compose with the
  next tap (`ctrl+click`), hold (how xterm's own menus open) or wheel drag (`ctrl+wheel`).
  They are sent as separate `keydown` / `keyup` injections around the action and are
  one-shot; a second modified action needs the pad closed and the modifier re-armed.

### Wheel

| Entry | Direction | Notes |
| --- | --- | --- |
| Right-edge strip | Fixed: drag down = wheel down | Tap = one notch (top half up, bottom half down) |
| Two-finger drag | Toggle in the top-left corner, default natural (`2f↑=wheel↓`) | Persisted as `scrollnat` |

Both go through the same `wheelNotch()`: one notch per 51 px of travel (`PAD_WHEEL_PX`, tuned
on a device), at most 4 per move event (`PAD_WHEEL_MAX`). Wheel events go to the window under
the pointer, so a strip drag first forces one `move` to the arrow's position. Each notch
flashes the strip's `▲` or `▼`; there is no thumb because there is no scroll position to
read. The strip touches the right screen edge with no inset, so a miss cannot land on the pad.
On desktop, a physical wheel over the strip sends notches and elsewhere sends the swipe
gesture.

### Invariants

- Unconditional release. `padDown` records what is held before the injection is sent;
  `padRelease` clears the record first, then releases the button and the modifiers in reverse
  order, awaiting each and continuing past failures. Close, `pointercancel`, button switch,
  second finger and physical right button all call it without a guard.
- One injection queue. Every press and release goes through `padQueue`, so a release can never
  overtake its press. Only throttled `move`s bypass it.
- Integer cursor. `cursorTilePixel()` is the single conversion to a pixel for both the lens
  and the preview, and the cursor is clamped to `SCREEN_W - 1` / `SCREEN_H - 1`.
- Every contact resolves to exactly one of tap, press-and-hold, move or two-finger scroll.
  The hold timer re-arms itself if it fires early.
- The selected button is passed to every `clickat` / `down` / `up`; the only literal is the
  physical right button. The selector produces 1–3 only, so it can never select a wheel
  button.
- Overlay controls (`✕`, selector pills, direction toggle) are hit-tested by rectangle on
  `pointerup` through one table (`controlAt`), because pointer capture retargets events. The
  direction toggle must have exactly one activation path; an extra `click` listener makes it
  toggle twice under a finger.
- The wheel strip is a gesture surface, not a control: it is not in `controlAt`, its contact
  is never added to the pad's pointer set, and only a first finger that starts on it owns it.
- Gesture surfaces (vRing, vPad, the mirror canvas) take the platform's touch defaults away
  explicitly: `touch-action: none`, `user-select: none`, `-webkit-touch-callout: none`, and
  `preventDefault()` on cancelable `touchstart` / `touchmove` / `touchend`
  (`suppressNativeTouchGestures()`), except over exempt controls. Never apply this to
  palettes.

Background: [vPad and mirror touch measurements](notes/2026-10-vpad-pointer-and-wheel.md).

## Palettes (`task`, `window`, `apps`)

All three use one shell (`openPaletteShell`): a panel anchored to the top of the visual
viewport over an opaque backdrop, with an optional filter box and 32 px one-line rows
(`div[role=button]`).

| Palette | Rows | A row sends |
| --- | --- | --- |
| `task` | Every window, full title, most recently used first; `*` marks the focused one; class in the dim column; filter | `POST /api/windows {wid}` |
| `window` | The rows of the on-glasses `Menu... > Window...` level, flat, plus `Close Window` | `POST /api/wm/key {key}` or `POST /api/windows/close {wid}` |
| `apps` | Every scanned application with its command line; filter on name and command; `rescan` | `POST /api/spawn {id}`; `rescan` is `GET /api/apps?rescan=1` |

- `task` and `window` are the phone-side route to what is otherwise drawn only on the lens
  and need no glasses link. They reuse the shared rows and actions (`windowPanelRows`,
  `runRowToken`, `selectWindow`) and must not reimplement them.
  Rationale: [phone palettes](decisions/phone-palettes.md).
- A row acts and the palette closes; the result is visible in the mirror. In `window`, a
  destructive row (`Kill (force)`) arms on the first tap and acts on the second. `apps` stays
  open when a launch fails, and renders at most 120 matching rows (the footer says so).
- Filters match every whitespace-separated term. The filter box is not focused automatically.
- One palette at a time: opening one closes any other and both full-screen overlays, and an
  opener toggles only its own palette.
- Closing: `✕`, a tap on the backdrop, the back gesture (a same-document `pushState` entry),
  `Escape`, or the opener. `history.back()` is called only when the palette's own entry is
  current, so the page never navigates.
- Layout reads `window.visualViewport` (offsets, size, `resize` and `scroll` events), because
  the soft keyboard shrinks only the visual viewport and `position: fixed` does not follow
  it. While the keyboard is up (layout height minus visual height ≥ 120 px) the panel fills
  the visible rectangle. Do not subtract anything from `visualViewport.height`. Listeners are
  removed on close.
- The list scrolls natively and the filter box takes a caret, so gesture-surface touch
  suppression must not be applied. A custom 3 px indicator shows list length at rest, which
  native overlay scrollbars do not.
- Focus is not trapped; closing returns it to the opener. The hardware-keyboard path is
  suspended while a palette is open.

Background: [palette layout measurements](notes/2026-10-phone-palette-layout.md).

## Bindings editor (`app`)

Edits the per-app record stored by the server (`GET` / `POST /api/bindings`; model in
`src/shared/bindings.ts`, catalogues in `src/shared/keys.ts`).

- The fold summary always shows what is in force for the focused window, submit first, with
  key names spelled out and the matching identity (`via comm:xterm`).
- `app` dropdown: every identity the focused window has, in resolution order
  (`app → exe → comm → cls → title → *`), each labelled by kind, then every key that already
  has a binding. The preselected key is `preferredKey()` (normally `exe:`).
- `▲ up` / `▼ dn`: Ctrl/Alt/Shift toggles plus a key dropdown from the closed catalogue
  `KEYS` (which includes `wheel up` / `wheel down`). Each row shows the exact command sent.
- `submit`, `newline`, `fontsize`: a dropdown only, from their closed lists. The note for the
  selected entry is always visible, because two submit entries are warnings (`C-s` freezes a
  terminal, `C-d` logs out at a bare prompt).
- `apply` writes all five fields as one record: `POST /api/bindings {key, up, down, submit,
  newline, fontsize}`. `clear`, or `✕` on a listed binding, sends `{key, clear:true}`.

Invariants:

- No free-text field for keys: a name that is not a keysym would be stored and do nothing.
- The editor opens with the inherited values and is refilled from the binding map on every
  update until the user touches it; otherwise an untouched `apply` overwrites an inherited
  binding.
- `submit`, `newline` and `fontsize` resolve per field (the first entry that states that
  field); swipes resolve per record. "Not set" and `off` are different.
- Dropdown option sets are rebuilt only when they change: window updates arrive every second
  and would close an open native picker.
- `<select>` elements need `color-scheme: dark` to be legible; do not set it on `:root`.
- The editor warns when a repeat-risky key (`Return`, `KP_Enter`, `Delete`, `BackSpace`) is
  bound to a swipe and when Shift is combined with a key that shifts to another glyph.

## Connection fold

The summary states what needs attention, and the fold opens itself for the first three:

| State | Summary |
| --- | --- |
| New enrolled key | `connection — ⚠ N NEW enrolled key(s): open to check` (red, takes priority) |
| `unpaired` | `connection — ⚠ not paired yet: open to pair` |
| `unauthorized` | `connection — ⚠ this device's key is not enrolled: open to re-pair` |
| `offline` | `connection — ⚠ server unreachable` |

Inside: the status line (the client's own bookkeeping), the server URL field with `apply`
(sets the API base, stored as `ew.server`, and restarts the stream), and `pair`, which opens
the pairing dialog regardless of auth state, because a device that cannot reach the server
never learns its state. Pairing is described in [security.md](security.md).

### When no server address was chosen

With no `?server=` and no stored address the client uses a default: its own origin, or
`http://localhost:8787` when the page is on loopback or has no origin. The packaged app is in
the second case, and on a phone that address leads nowhere. The default is used but not
stored, so the client can tell that nobody chose it.

When the default does not answer, the client asks once per page load:

| Device | What opens |
| --- | --- |
| Holds no key | The pairing dialog. A pasted pairing URL carries the server address |
| Holds a key | A card asking for the server address only. It accepts an origin, any URL on the server, a pairing URL, or a bare `host:port` (taken as https) |

A chosen address that stops answering opens nothing; the summary line says `server
unreachable`.

In the packaged app `localStorage` does not survive a restart of the Even App, so a chosen
address is also written to the bridge's storage (`setLocalStorage`, key `ew.server`) and read
back at start when the client would otherwise be on the default.

Enrolled keys table: a read-only list of the client keys the server trusts, received on the
stream (`{t:'clients'}`): name, first 12 characters of the id, date added, with this device
marked. The first list seen becomes the acknowledged set (stored as `ew.keys.acked`). A key
that appears later is shown in red as `⚠ NEW` until `mark as seen` is tapped; removed keys
are reported too. Only the host can change the list (`ew-auth`).

## Pills

| Pill | Effect | Persistence |
| --- | --- | --- |
| `inv:on` / `inv:off` | Flips the polarity of what is pushed to the lens | Setting (`ew.invert`) |
| `color` / `green` | Preview in the server's colours, or as the lens shows it (16 grey levels in green) | Setting (`ew.mirror`) |
| `lens:on` / `lens:off` / `lens:case` | Pauses the glasses: tile pushes stop and the panel is blanked | Not persisted |

All three are client-only. `color` is forced and the pill disabled while the frame pump is
standing down (link down or lens paused), because green is derived inside the pump; the
choice is kept. With the lens paused the whole phone UI keeps working. `lens:case` appears
when the glasses report being in their case; tapping it overrides the sensor for the session.
Details: [glasses.md](glasses.md).

There is no `kbd` pill: the hardware-keyboard path has no mode.

## Toasts

`toast(msg, ms = 2600)` shows one line at the bottom centre (`z-index` 10000: above palettes
and the vRing / vPad layers, below the pairing and server-guard screens). It answers actions whose result is not immediately visible:
`launching <name>…`, `<name> started — watch the mirror`, `launch failed: …`, and the
`rescan` result. One first-use hint uses it too: after a successful Submit whose app has the
submit key `off` (not a hold-send), `submitOffHintText()` is shown for 6 s, on the first three
such sends per device (`takeHint('submit-off')`, `src/client/hints.ts`). The wording claims only that the process started; the window appears on the
next window poll.

## Tour

`src/client/tour.ts`. Six cards, each spotlighting part of this UI and saying what it does:

1. The mirror preview (tap = click, drag = drag).
2. The glasses gestures. No button is lit: a schematic of the G2 from its right side (the pad on the temple tip behind the ear, swiped along its slant: back = Down) and the R1 ring
   (`gestureFigureSvg()`) is laid over the mirror's box (`figureAt`), so what is pointed at is
   what is explained.
3. The gesture row: `▼ dn` `▲ up` `● tap` `●● dbl` and `font −/+`.
4. The tools row: `keys`, `vRing`, `vPad`, `inv`, `color`, `lens`.
5. Typing: the text row (Submit bottom right, `🎤 voice` top right) and `▶ app` (the submit
   key). Late on purpose: typing is wanted once the rest is understood.
6. The palette openers, ending on how to reopen the tour.

Voice rows (the long press, `🎤 voice`) appear only with a recogniser.

- Opens by itself on the first `GET /api/health` that answers OK, once per device (`ew.tour.seen`
  in localStorage, set by any close). Not before: a tour over a connection that does not work
  would explain controls that do nothing.
- `?` in the title row opens it again. `?tour=1` opens it at boot regardless; `?tour=0` keeps
  it shut for that load (for runs that drive the UI by coordinates). Neither is stored.
- `skip`, `back`, `next` / `done`; `Escape`, `←`, `→` and `Enter` from a hardware keyboard.
  Those keys stop there and do not reach the mirrored window.
- The spotlight is the live UI. A transparent full-screen layer at `z-index` 9999 takes every
  touch, and a dim layer under it has the holes clipped out (`dimPath()`, an even-odd
  `clip-path`). A card can cut more than one hole, so the text row and `▶ app` light up
  without the rows between them. The card goes below the holes, else above, else pinned to
  the roomier edge (`cardTop()`); positions are recomputed on scroll and resize.
- It sits below the toast and the pairing and server-guard screens. A first-run tour that opens
  under the pairing dialog is waiting when pairing is done.

## Hardware keyboard and trackpad

A Bluetooth keyboard paired with the phone types into the mirrored desktop whenever no field
of this page has focus. There is no mode and no hidden input element.
Rationale: [hardware keyboard without a mode](decisions/phone-hardware-keyboard.md).

`wireHardwareKeyboard()` listens for `keydown` on `document` in the capture phase;
`hwKeyPlan()` maps the event:

| Event | Sends (`POST /api/desktop/input`) |
| --- | --- |
| Printable character, no Ctrl/Alt/Meta | `type` (Shift is already applied by the platform) |
| Character with Ctrl/Alt/Meta | `key`, e.g. `ctrl+minus` (Meta is sent as `super`) |
| Named key (`Enter`, `Tab`, `Backspace`, arrows, `Home`, `PageUp`, …, `F1`–`F12`) | `key` with the xdotool name; Shift is added for named keys only |
| Bare modifier, `Unidentified`, empty | Nothing |

- Gate (`kbdShouldHandle`): nothing is sent while focus is in an `INPUT`, `TEXTAREA`,
  `SELECT` or contenteditable element, or while a palette is open. The caret decides where
  keys go.
- A tap outside a focused field blurs it (`tapDropsFocus`, capture phase), because iOS does
  not. It must happen on `pointerup`: blurring on `pointerdown` collapses the keyboard and
  moves the button from under the thumb. The gate and this rule share one definition of
  "field".
- Inside a field, `Tab` is swallowed (`KBD_SWALLOW_IN_FIELD`) so focus cannot leave the field
  and send the rest of the sentence to the shell.
- Consumed keys are `preventDefault()`ed, so `Tab` and `space` cannot operate this page while
  no field is focused; the first injected key logs this once.
- Ordering and batching (`KeyBatcher`): injections are serialised. Characters accumulate
  while a request is in flight and go out as one `type`, so batch size follows round-trip
  time with no fixed window. A chord flushes pending characters first, and a pending flush is
  tracked by identity so a chord cannot be overtaken. Hiding the page flushes the buffer.

Limits, measured on an iPhone inside the Even App WebView:

- Arrow keys are not delivered at all, neither to the DOM nor to a focused field. Use
  `C-p/n/b/f` or `hjkl`. The spellings stay in `KBD_NAMED` for platforms that deliver them.
- A Bluetooth trackpad arrives as a real mouse pointer with hover, but iOS has no Pointer
  Lock: it drives vPad by deltas only and stops at the screen edge.

Background: [key probe results](notes/2026-10-keyprobe-ios-hardware-input.md).

## Query flags

Boolean flags accept an empty value, `1`, `true`, `on`, `yes` and `0`, `false`, `off`, `no`;
anything else decides nothing.

| Flag | Kind | Effect |
| --- | --- | --- |
| `server=<url>` | Setting (`ew.server`) | API base. A paired device asks before following a link to another server |
| `pair=<code>` (also `#pair=`) | One-shot | Opens the pairing dialog with the code; removed from the address bar |
| `invert` | Setting (`ew.invert`), default off | Polarity |
| `mirror=color\|green` | Setting (`ew.mirror`), default `color` | Preview rendering |
| `scrollnat` | Setting (`ew.scrollnat`), default on | Two-finger wheel direction on vPad |
| `debug` | Instrument | Forwards every log line (`POST /api/debug/log`, batched) and each raw bridge event (`POST /api/debug/event`) to the server log |
| `stats` | Instrument | Logs frame-pump statistics every 10 s |
| `encworker=worker\|main\|abba` | Instrument, read only with `stats` | Pins or alternates the tile encode path |
| `keyprobe` | Instrument | Mounts the key probe panel |
| `voicefeed=<url>` | Test hook | See [voice.md](voice.md) |
| `tour=1\|0` | One-shot | Opens the [tour](#tour) at boot, or keeps it shut for this load |

Settings resolve as query → `localStorage` → default, and the winner is stored (for `server`,
only a chosen address; see [Connection fold](#when-no-server-address-was-chosen)). Instruments
are read from the URL only and never persist. When a setting came from storage rather than
the URL, the boot log prints a `sticky:` line naming it and its value.

In the packaged app `localStorage` is emptied when the Even App is restarted. Everything the
client keeps there is therefore also held in the bridge's storage (one JSON object under
`ew.kv`, written by `src/client/durableKv.ts`) and put back at start: the settings above, the
tour and hint records (`ew.tour.seen`, `ew.hint.*`) and the acknowledged enrolled keys
(`ew.keys.acked`). A value chosen by a query or a tap in the current load wins over the kept
one. The boot log names what was put back (`settings recovered from the durable store: …`).

## Log and key probe

The log keeps 400 lines, newest at the bottom, and follows the tail until scrolled away.
There is no separate debug panel: `?debug=1` sends the same log to the server's stdout, which
is how to read a device that cannot be inspected.

The key probe (`?keyprobe=1`) reports which key and pointer events reach the WebView. It
observes only: it must never inject or call `preventDefault()`, and it listens in the capture
phase. Running it: [development.md](development.md).
