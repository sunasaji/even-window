# Phone palette layout measurements

Snapshot — not maintained. Conditions: 2026-10-10 to 2026-10-20; iPhone 1179x2556 (393x852
CSS px) screenshots; headless Chromium with an injected or resized `visualViewport` at
390x844 and 360x740; simulator (WebKitGTK) for behaviour. A machine with 46 scanned apps.

## Soft keyboard and the visual viewport

Report: the apps list was hidden behind the on-screen keyboard. The soft keyboard shrinks the
visual viewport only; the layout viewport, which `position: fixed` uses, does not change. iOS
may also offset the visual viewport and sometimes fires only `scroll`, not `resize`.

Tracking measured with an injected `visualViewport` (panel max-height then still subtracted a
48 px reserve; it now equals the visual viewport):

| Visual viewport | Panel | Filter box top | List height |
| --- | --- | --- | --- |
| 844 (no keyboard) | top 0 / max-h 796 | 58 | 650 |
| 508 (keyboard 336) | top 0 / max-h 460 | 58 | 314 |
| 436 + `offsetTop: 72` (iOS style) | top 72 / max-h 388 | 130 | 242 |
| 360 px wide, keyboard 300 | top 0 / max-h 392 | 58 | 246, no horizontal scroll |

Opening adds two listeners on `visualViewport`; closing must return the count to zero.

## The 48 px reserve was a mistake

A device screenshot with `visualViewport.height = 370` (layout still 393x852) showed only 4
rows and the page's pill rows visible below the panel. Reproduced numerically:

| | Row height | Panel | List | Fully visible rows | Page buttons showing below |
| --- | --- | --- | --- | --- | --- |
| At the report | 40 | 0–322 | 176 | 4 | 11 (through a 0.55-alpha backdrop) |
| After | 32 | 0–370 | 260 | 8 | 0 (opaque backdrop) |

- `visualViewport.height` already excludes the iOS form accessory bar; the 48 px
  `PALETTE_BOTTOM_RESERVE` was the entire unnecessary subtraction. With ~45 px of panel footer
  it left ~93 px between the last row and the keyboard.
- The reserve had been meant as an outside-tap target, but with the keyboard up it sat
  between the filter box and the keys.
- Keyboard detection: `documentElement.clientHeight − visualViewport.height ≥ 120`. To
  reproduce, keep the layout viewport at 393x852 and set only the visual viewport to 370;
  shrinking the window shrinks both and the detection does not trigger.

## Row height

Rows went 40 → 36 → 32 px on two requests for a lower row. Rows fully visible in the same
260 px list box: 40 → 6, 36 → 7, 34 → 7, 32 → 8, 30 → 8. 30 buys no extra row, so 32 is the
floor. Content is one 14 px line (17 px); the rest is padding.

Other row facts from the same machine: 28 of 46 entries had a command line identical to the
display name, so the command column is omitted for those; duplicate display names exist
(deb and snap Firefox, two Emacs builds), which is why the command column exists at all.
Plain `<button>` rows with wrapping command lines had produced rows of uneven height.

## Scroll indicator

iOS scrollbars are overlay scrollbars shown only while scrolling, and
`::-webkit-scrollbar` styling is ignored for them: it would be visible in the desktop
simulator and silently absent on the phone. The list draws its own 3 px indicator (thumb
size = visible fraction, position = scroll fraction, hidden when everything fits), updated
on scroll, on filter changes and on keyboard changes.

## Filter box font size

The filter box is 14 px, below the 16 px rule that prevents iOS focus zoom. This relies on
the viewport's `maximum-scale=1`. If a device ever zooms on focus, return to 16 px and get
the height from padding.

## Simulator checks (2026-10-20)

- `window`: 9 rows (`Help (keys)` … `Kill (force)`, `Close Window`), key hints in the dim
  column, footer `acting on: xterm`. One tap on `Kill (force)` turned the row red
  (`Kill it - confirm` / `tap again`). `Redisplay` closed the palette and sent the command.
- `task`: most-recently-used order with `*` on the focused window. A window spawned while the
  palette was open appeared at the top (the first implementation missed this redraw).
- `lens:off` blanked the glasses and left the phone preview live.
