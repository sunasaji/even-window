// Gesture envelope normalisation for the Even Hub bridge (docs/glasses.md).
//
// Even Hub runtimes emit a gesture in five envelope shapes (listEvent / textEvent / sysEvent /
// a bare eventType / jsonData), with the code as a protobuf ordinal or a string.
//
// `CLICK_EVENT` is protobuf enum 0 and protobuf omits zero-value fields, so a tap arrives
// with no `eventType` at all. The default is resolved inside the envelope check, for any of
// the three protobuf envelopes: `?? CLICK_EVENT` on the field read would report a tap for
// every host push that carries no envelope. Results are `GestureName`s, which keeps the SDK
// out of the shared layer.

import type { GestureName } from './types.ts'

/** The three protobuf envelopes a gesture can be delivered in. `jsonData` does not count:
 *  it is present on unrelated host pushes, so defaulting it to a tap would create phantom
 *  gestures. */
// biome-ignore lint/suspicious/noExplicitAny: the host envelope is untyped and varies by runtime
function hasEnvelope(event: any): boolean {
  return Boolean(event?.listEvent ?? event?.textEvent ?? event?.sysEvent)
}

/** Normalise every gesture envelope; `null` for anything that is not a nameable gesture.
 *  Long press (PB 9) and its release (PB 10) are named but not routed to any action. The
 *  press source stays on the raw envelope (`sysEvent.eventSource`). */
// biome-ignore lint/suspicious/noExplicitAny: the host envelope is untyped and varies by runtime
export function evenGestureType(event: any): GestureName | null {
  const raw =
    event?.listEvent?.eventType ??
    event?.textEvent?.eventType ??
    event?.sysEvent?.eventType ??
    event?.eventType ??
    event?.jsonData?.eventType ??
    event?.jsonData?.event_type ??
    event?.jsonData?.Event_Type ??
    event?.jsonData?.type
  // CLICK_EVENT is protobuf enum zero and is omitted from an otherwise-present envelope.
  // Resolved here, inside the envelope check, never as a `??` on the field read.
  if (raw == null) return hasEnvelope(event) ? 'tap' : null
  if (typeof raw === 'number') {
    if (raw === 0) return 'tap' // CLICK_EVENT
    if (raw === 1) return 'up' // SCROLL_TOP_EVENT
    if (raw === 2) return 'down' // SCROLL_BOTTOM_EVENT
    if (raw === 3) return 'double' // DOUBLE_CLICK_EVENT
    if (raw === 9) return 'long' // LONG_PRESS_EVENT
    if (raw === 10) return 'longRelease' // LONG_PRESS_RELEASE_EVENT
    return null // 4-8: foreground/exit/IMU, not a gesture
  }
  if (typeof raw !== 'string') return null
  const value = raw.toUpperCase()
  // Release is tested first: `LONG_PRESS_RELEASE_EVENT` contains `LONG_PRESS`.
  if (value.includes('LONG_PRESS_RELEASE') || value.includes('LONGPRESSRELEASE'))
    return 'longRelease'
  if (value.includes('LONG_PRESS') || value.includes('LONGPRESS')) return 'long'
  if (value.includes('DOUBLE')) return 'double'
  if (value.includes('CLICK')) return 'tap'
  if (value.includes('SCROLL_TOP') || value.includes('UP')) return 'up'
  if (value.includes('SCROLL_BOTTOM') || value.includes('DOWN')) return 'down'
  return null
}

/** FOREGROUND_ENTER_EVENT (4) / FOREGROUND_EXIT_EVENT (5): a foreground layer came or went.
 *  Not proof that the OS menu opened: a phone notification emits the same pair. The panel is
 *  covered while a layer is up, so the tile pump pauses on it. `null` for everything else,
 *  including every gesture. See docs/decisions/blank-tiles-under-overlay.md. */
// biome-ignore lint/suspicious/noExplicitAny: the host envelope is untyped and varies by runtime
export function foregroundChange(event: any): 'enter' | 'exit' | null {
  const raw =
    event?.listEvent?.eventType ??
    event?.textEvent?.eventType ??
    event?.sysEvent?.eventType ??
    event?.eventType ??
    event?.jsonData?.eventType ??
    event?.jsonData?.event_type ??
    event?.jsonData?.Event_Type ??
    event?.jsonData?.type
  // No omitted-zero default here, unlike `evenGestureType`: a missing eventType is never a
  // foreground change.
  if (raw == null) return null
  if (typeof raw === 'number') return raw === 4 ? 'enter' : raw === 5 ? 'exit' : null
  if (typeof raw !== 'string') return null
  const value = raw.toUpperCase()
  // `ABNORMAL_EXIT_EVENT` (6) and `SYSTEM_EXIT_EVENT` (7) are the app being torn down, so a
  // bare `EXIT` must not match.
  if (value.includes('FOREGROUND_EXIT') || value.includes('FOREGROUNDEXIT')) return 'exit'
  if (value.includes('FOREGROUND_ENTER') || value.includes('FOREGROUNDENTER')) return 'enter'
  return null
}
