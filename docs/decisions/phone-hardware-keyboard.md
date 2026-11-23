# Phone UI: hardware keyboard input has no mode

## Context

A Bluetooth keyboard paired with the phone can drive the mirrored desktop. Measurement in the
Even App WebView on an iPhone showed that `keydown` is delivered without any focused element,
that arrow keys are not delivered at all, and that a Bluetooth trackpad arrives as a real
mouse pointer with hover.

## Decision

- Keys are captured on `document` and injected whenever no field of the page has focus and no
  palette is open. There is no on/off pill.
- No hidden `<input>` is kept focused.
- The caret decides: keys go to the focused field, otherwise to the mirrored desktop. A tap
  outside a field removes its focus; `Tab` inside a field is swallowed.
- Injections are serialised; characters typed during a round trip are batched into one
  injection, with no fixed coalescing window.
- Input stays inside this WebView rather than moving to a companion app.

## Alternatives considered

- A `kbd:on/off` latch: retired after a day of use. A hidden page receives no key events, the
  WebView is recreated often (five launches in seven minutes were observed) so a per-session
  latch would be re-armed constantly, and the real boundary is authentication; the text box
  was always an injection surface.
- A focused off-screen input (the usual iOS technique): brings up the shortcut bar and
  fights selection and the soft keyboard, and is unnecessary here.
- A fixed 24 ms coalescing window: either delays the first key or is too short on a slow
  link. Batching by round trip adapts by itself.
- A separate SSH or remote-touchpad app: this WebView is the BLE bridge, so putting another
  app in front freezes the lens.

## Consequences

- With a keyboard attached, `Tab` and `space` cannot operate the page while no field is
  focused; the log says so once.
- Arrow keys are unavailable on the measured device; readline and vi keys cover the gap.
- Background: [key probe results](../notes/2026-10-keyprobe-ios-hardware-input.md).
