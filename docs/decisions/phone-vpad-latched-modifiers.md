# Phone UI: vPad modifiers are latched on the pad

Supersedes the modifier part of
[vPad uses a modal button selector and one-shot modifiers](phone-vpad-button-selector.md).
The button selector and the hold model there stand.

## Context

Ctrl / Alt could reach a pad action only by arming them in the `keys` panel before opening
the pad, and the arm was one-shot. A second modified action meant closing the pad, arming
again and reopening. The actions people repeat are exactly the modified ones: Ctrl+wheel to
zoom step by step, Shift+click to extend a selection. The two-finger scroll carried no
modifier at all, and Shift could not be applied to a pad action in any way.

One-shot had been chosen because the pad covers the `keys` panel: a modifier latched there
would make every later tap an invisible `ctrl+click`.

## Decision

`Ctrl`, `Alt` and `Shift` have a pill each in the pad's top row, after the scroll-direction
toggle. A tap lights a pill; it stays lit until tapped again, and lit pills combine. The lit
modifiers go with every tap, hold, strip drag and two-finger scroll.

- The latch is client state. On the X side a modifier is still pressed for one action and
  released after it through `padPress` / `padRelease`, so nothing is held between actions.
- Closing the pad clears all three.
- A Ctrl / Alt armed in `keys` when the pad opens becomes a lit pill and is taken from `keys`.

## Alternatives considered

- **Keep one-shot, add the pills.** The repeated actions would still need a tap on the pill
  before each one.
- **Pills only, ignore an arm made in `keys`.** Simpler, but it silently drops what the user
  just armed, and breaks the way the pad was used until now.
- **Hold the modifier down on the X side while a pill is lit.** A page that is closed or loses
  its connection would leave the key down in the desktop.

## Consequences

- Mode errors are possible, as with the button selector: a lit Ctrl turns every tap into a
  `ctrl+click`. The pill is lit in the green of an armed key, on the surface being used.
- An arm carried in from `keys` now lasts until its pill is tapped, not for one action.
- The pad's top row holds five controls; on a screen narrower than about 330px the last pill
  meets the ✕.
