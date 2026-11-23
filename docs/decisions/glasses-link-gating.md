# Link and pause gating

## Context

Having a bridge does not mean the glasses are reachable. Pushing to absent glasses costs up to
34 s per tile plus a derive and an encode each, invisibly. The host reports device status, but
unevenly: some values are stale or wrong, and the event stream goes quiet during an outage.

## Decision

- The link is assumed up until the host says otherwise. Only `disconnected` and
  `connectionFailed` take it down; only `connected` or a successful establish bring it up.
  `connecting`, `none` and unknown values change nothing. A null `getDeviceInfo()` at start
  counts as down.
- Link down is a hard gate at the top of the pump and inside `pushImage`, checked again between
  retries. It is separate from the overlay stand-down.
- The mirror also pauses, as an overlay, for the phone's `lens` latch and for `isInCase`. One
  press overrides the case sensor for the session. The latch is not persisted.
- `isWearing`, battery and charging state are logged only.

## Alternatives considered

- Infer link loss from failed pushes: pushes fail for unrelated reasons.
- Treat `connecting` or `none` as down: a quiet host would freeze the mirror indefinitely, and a
  `none` reset record follows every disconnect.
- Treat `none` as up: pushing would resume 5 ms after a disconnect.
- Pause on `isWearing`: it was wrong in both directions on hardware.
- Fold link state into the overlay stand-down: recovery would then depend on overlay state.
- Persist the lens latch: a dark lens surviving a WebView restart looks like a broken app.

## Consequences

- A host that reports nothing behaves as before: the mirror runs.
- Waste while the glasses are merely taken off cannot be detected; the lens latch is the lever.
- On link up the client resets the diff baseline and repaints; it does not rebuild.
- The green mirror mode and the glasses microphone are unavailable while the link is down.

Background: [link loss, establish and recovery](../notes/2026-10-glasses-link-and-establish.md).
