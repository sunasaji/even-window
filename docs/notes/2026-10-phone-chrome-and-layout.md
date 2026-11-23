# Phone UI chrome and layout

Snapshot — not maintained. Conditions: 2026-10-10 to 2026-11-23; iPhone (390 px class) in the
Even App, simulator (WebKitGTK); heimterm phone companion as the reference (MIT).

## Ported from heimterm

Layout and CSS of the page, `#tkeys` / `#oskb`, vRing, vPad and the toast come from heimterm's
phone companion. Differences introduced by the port:

| | heimterm | even-window |
| --- | --- | --- |
| Key names | tmux (`Enter`, `IC`, `PPage`, `BSpace`) via `send-keys` | xdotool spellings (`Return`, `Insert`, `Page_Up`, `BackSpace`) |
| Character keys | `termSendText` | `type`, or `key` with X keysym names when Ctrl/Alt is armed (`ctrl+minus`; `ctrl+-` is not parsed) |
| Key min-width | 56 / 54 / 44 / 42 | 52 / 54 / 40 / 40: heimterm's longest row is 360 px and overflows a 360 px viewport; trimmed to 332 px inside 336 px |
| vRing input | touch only | touch plus a mouse path for the simulator and desktop |
| Mirror corners | 8 px radius | square, like the physical panel |

The reference applies no CSS to its key buttons, so they render as the platform's native
buttons; see [decisions/phone-native-button-chrome.md](../decisions/phone-native-button-chrome.md).

## Layout choices and why

- The status line (`page=established | win=3 | …`) lives in the `connection` fold, not inside
  the preview frame: drawn there in the same green monospace, it read as glasses output.
- The `connection` fold holds the server URL, pairing and status. The `SERVER` variable and
  `?server=` keep the older name "server".
- `pair` is in `connection`, not in the tools row: it is needed once per device. It stays
  reachable through the dialog that opens on the first 401, through `?pair=`, and through
  the fold summary.
- Apps are launched from the `apps` palette opened from the title row.
- `color` sits next to `inv` (both change appearance). A title plus four native buttons does
  not fit 390 px, so the title row holds exactly the three palette openers.
- The `▶ app` fold holds per-app settings: swipe bindings and the submit row.
- vPad selector pills have square corners; that needs `appearance: none`, so they reuse the
  key chrome.
- Press-and-hold and tap-then-drag on the vPad are one state with two entries, and the hint
  names it once.
- `<select>` in the simulator's WebView ignores `background` without `appearance: none` and
  renders pale grey on white; `color-scheme: dark` on the selects fixes all three pickers.
- The bindings editor refills whenever the window list or the bindings change, not only when
  the selected key changes; otherwise a window list that arrives before the bindings lets
  `apply` overwrite an inherited binding with stale values.

## Submit key

- A hardware keyboard can submit from the text box (`Ctrl+Enter`), so a line can be sent
  without reaching for the screen; plain `Enter` inserts a newline.
- The submit chord is picked from a closed list rather than built from modifier toggles, so
  awkward combinations such as `Ctrl+Alt+Shift` keys are not configurable.
- The chord is stored per app, in the `app` fold; the default is `off`. Newlines are sent as
  keys with a per-app `newline` key. Holding Submit sends the text once without the submit
  key.

Simulator check of multi-line sending: `type "echo line-one"`, `key Return`,
`type "echo line-two"`, `key Return` ran both lines.

Submit hold details: the hint waits 120 ms so ordinary taps do not flash it; touch pointers
are implicitly captured, so leaving the button is detected by hit test; the hint names the
key it omits.

## Font size keys

Font size keys are per app (`fontsize`). Zoom keys differ per app
(browsers `C-=`, kitty `C-S-=`, Emacs `C-x C-=`, LibreOffice Ctrl+wheel). No per-app presets
are built in: the notes say which apps document each chord, and only `shift+KP` (xterm) was
measured here. OSC 50 was rejected (needs a write to a TTY the server does not own) and so
was restarting the terminal. Measurement: see
[vPad notes](2026-10-vpad-pointer-and-wheel.md#xterm-font-keys-2026-10-10-xvfb-190).

## Lens text on the preview

The menu and the voice dialog are firmware-rendered text, invisible on a tile-only preview.
The preview paints the same strings: 17 px font chosen so an ASCII heading matches the
simulator's lens width, line pitch 288 / 10 = 28.8 px, wrapping by the width model (full
width 2, half width 1, 56 units per line). Simulator check: the root list appeared on both
surfaces, the cursor moved on both, taps on the copy sent nothing. The voice dialog path was
not exercised in the simulator.

## Toast

Launching starts a process on another display; the window appears one poll (1 Hz) later and
the tap itself returns nothing visible. Hence a toast, worded "started", not "showing".
