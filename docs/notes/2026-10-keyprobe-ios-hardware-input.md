# Key probe: Bluetooth keyboard and trackpad in the Even App WebView

Snapshot — not maintained. Conditions: iPhone with a Bluetooth keyboard and trackpad, Even App
WebView, `?keyprobe=1`, runs on 2026-10-14 and 2026-10-15 (reported by the wearer); negative
controls in the WebKitGTK simulator.

## Question

Can this WebView read hardware keys and pointer movement, or would a separate SSH or
remote-touchpad app be faster? The second half is settled by design: the WebView is the BLE
bridge, so another app in front freezes the lens. The first half had to be measured.

## What published sources say

| Topic | Claim | Source |
| --- | --- | --- |
| Keys | WKWebView fires keydown/keyup only with focus; Tab and arrows are dropped or arrive `Unidentified` / keyCode 0 | WebKit #149054, openradar 24071444 |
| Pointer | A BT pointer on iPhone is AssistiveTouch, i.e. synthetic touch, no hover | WebKit #214609 |
| Deltas | Pointer Lock is unimplemented on all iOS / iPadOS versions | caniuse |

## Instrument design

- Observes only: no injection path and no `preventDefault()` (a source-audit test enforces it).
- Capture-phase listeners, so keys eaten by other handlers are still counted.
- A text field is the control group: iOS inserts characters without going through JS, so
  characters in the field but not in the echo are losses between platform and DOM.
- `delay` = `Event.timeStamp` to handler entry, i.e. main-thread wait. Impossible values
  (negative, over a minute) print `?` instead of a number.
- Auto-repeat is counted, not logged; pointer moves are never logged.
- `caret:` counts caret moves explained by neither a key event nor a touch (`caretGhost`), to
  test whether arrows could be reconstructed from `selectionchange`.

Two instrument bugs were found in the simulator before the device run: the echo verdict did
not look at direction (now `LOSS` when the field is ahead, `JS AHEAD` when the echo is), and
the `blur` button took focus itself, so the "unfocused" run was not unfocused.

## Results

| Finding | Reading | Status |
| --- | --- | --- |
| Character keys are fast while a field has focus | Keys reach the DOM without main-thread delay | reported |
| Keys still arrive after `blur` | Focus is not required; #149054 does not hold in this WebView | measured (run 2) |
| Tab moves focus | keydown fires and the default runs; a real handler can take it | reported |
| Arrow keys do nothing, the caret does not move (`caret` 0, `ghost` 0) | Not delivered even to the control; nothing to reconstruct. They work in the stock Notes app, so the cause is WebKit, not the keyboard | measured (runs 2 and 3) |
| Trackpad: `type=mouse`, `buttons=0`, coordinates move, `Δ` returns to 0 at rest | A real mouse pointer with hover and deltas; #214609 does not apply | measured (run 2) |

## What followed

- Keyboard path without a hidden input and without a mode. A first version had a `kbd:on/off`
  pill; it was retired on 2026-10-15 after use.
- A fixed 24 ms coalescing window for typed characters was replaced by batching on the round
  trip. Simulator: typing at 80 ms intervals had produced one `type` per character; at 15 ms
  intervals the batched version delivered `e`, `cho `, `fast-t`, `yping-` in order.
- A boolean "flush pending" flag reordered `a`, (in flight) `x`, chord, `b` so that `b`
  preceded the chord; an identity token fixed it (caught by a unit test).
- Hover made absolute aiming over the mirror rectangle possible. It shipped and was replaced
  the next day (2026-10-15): when the OS cursor, which the page cannot move or hide, entered
  the mirror, the arrow jumped to it. The pad now reads deltas only. Simulator check: a 40 px
  move gives +40 outside the mirror (288→328) and inside it (487→527), clamped at the edges.
- Device reports 2026-10-15: a tap outside a field did not remove its focus; Tab inside the
  text box moved focus away so that the rest of the sentence went to the shell. Both fixed.
- Simulator end-to-end: `echo always-on` + Enter ran in the nested xterm with nothing armed;
  `ctrl+c` arrived as `^C`; text typed with the page's own text box focused stayed in the box.

## Simulator checks

WebKitGTK delivers real mouse and keyboard events, so `xdotool` on the simulator's display
drove the probe, the `kbd` pill and absolute aiming (both since removed, see above):

```bash
PINHOLE_X11_RUNTIME_DIR=/tmp/pw-probe-x11 scripts/sim.sh --headless --keep \
  --api-port 8799 --port 5299 --automation-port 9909 \
  --display :140 --sim-display :186 --app-query "keyprobe=1&debug=1"
export DISPLAY=127.0.0.1:186
xdotool windowmove $(xdotool search --name '^Browser$' | head -1) 0 0
xdotool mousemove 300 604 click 1; xdotool type --delay 80 "hello world"
xdotool key --delay 150 Tab Up Down Escape
```

Checks made this way (coordinates are from that day's layout; read them from
`screenshot/webview`):

- `kbd:on`, then typing outside the mirror: `echo hello-from-bt` ran in the terminal,
  `ctrl+c` produced `^C`; typing with the app's own text field focused went into the field and
  not to the shell.
- vPad open, hovering the middle of the mirror: `DISPLAY=127.0.0.1:140 xdotool
  getmouselocation` returned `x:288 y:144`, the centre of 576x288.
- Dragging across a terminal line selected it (inverted text), so the drawn arrow and the
  real pointer agree.

Ask the mirrored display (`--display`) for the pointer, never the simulator's display.

## Log lines used to confirm the touch surfaces

Lines used to confirm touch behaviour on hardware, from the client log:

```
vPad: native touch defaults suppressed (selection / callout / scroll)      once per open
x11 keydown ctrl · for ctrl+press-and-hold (left) => ok                    ctrl + long press:
x11 down ctrl+press-and-hold (left) => ok                                   every down needs its
x11 up release left · drop => ok                                            up, every keydown
x11 keyup release ctrl · drop => ok                                         its keyup
x11 click wheel down (button 5) => ok                                      one per wheel notch
x11 clickat mirror tap (left) => ok                                        direct mirror touch
x11 move mirror drag (left) => ok / x11 down mirror drag (left) => ok      always in this order
x11 move mirror drop · drop => ok / x11 up release left · mirror drop => ok
```

A missing `keyup` leaves Ctrl held on the mirrored desktop. To test, `xdotool key a` without
`--clearmodifiers` under `xev`: `XLookupString gives 1 bytes: (01)` is ctrl+a (stuck), `(61)
"a"` is normal. For buttons, look at the `state` mask of `ButtonPress` (`0x4` = Control).
Wheel events go to the window under the pointer; `=> ok` lines with no visible scrolling mean
the application ignores the wheel.
