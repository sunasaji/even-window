# Phone UI: relative vPad, absolute mirror touch

## Context

The mirrored desktop is 576x288; the phone screen is larger and the wearer usually looks at
the lens, not the phone. Two kinds of pointing device reach the page: fingers, which have no
position until they touch, and a hardware mouse or trackpad, which has an OS-drawn cursor the
page can neither move nor hide (iOS has no Pointer Lock).

## Decision

- vPad is relative for every input: finger drags move the arrow by deltas (with a gain),
  hardware pointers move it by deltas (without gain, hover included). The OS cursor's
  position is never used, also not at the moment of a click.
- The mirror preview is a separate, absolute surface for fingers only: tap = click and
  drag = press-drag-release at the touched pixel, left button, no arrow on the lens. It is
  always on and yields to vPad while vPad is open.
- One surface, one behaviour. The two contracts are never mixed on the same surface.

## Alternatives considered

- Absolute mapping for hardware pointers over the mirror rectangle. It was shipped and
  withdrawn after one day of use: when the invisible OS cursor entered the mirror, the arrow
  jumped to it. An unpredictable jump costs more than the precision gained when the wearer is
  not looking at the phone.
- Absolute mapping of the whole pad to the desktop for fingers: edges are hard to reach and
  motion jumps.
- A latch for mirror touch: unnecessary; the only conflict is with vPad, which gates it.
- A double-click kind for mirror touch: left to the application's own timing until needed.

## Consequences

- A finger dragged over the mirror does not scroll the helper page (`touch-action: none`).
- Mirror touch keeps the cursor belief current, so opening vPad afterwards does not jump.
- Right and middle buttons, the wheel and modifier-holds need vPad.
- Background: [key probe results](../notes/2026-10-keyprobe-ios-hardware-input.md),
  [vPad notes](../notes/2026-10-vpad-pointer-and-wheel.md).
