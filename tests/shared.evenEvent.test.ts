// Gesture envelope normalisation (docs/glasses.md).

import { describe, expect, it } from 'vitest'
import { evenGestureType, foregroundChange } from '../src/shared/evenEvent.ts'

describe('evenGestureType: the five envelope shapes runtimes emit', () => {
  it('listEvent with a numeric eventType', () => {
    expect(evenGestureType({ listEvent: { eventType: 1 } })).toBe('up')
  })

  it('textEvent with a string eventType', () => {
    expect(evenGestureType({ textEvent: { eventType: 'SCROLL_BOTTOM_EVENT' } })).toBe('down')
  })

  it('sysEvent with a numeric eventType', () => {
    expect(evenGestureType({ sysEvent: { eventType: 3 } })).toBe('double')
  })

  it('jsonData passthrough, protoName key', () => {
    expect(evenGestureType({ jsonData: { Event_Type: 'DOUBLE_CLICK_EVENT' } })).toBe('double')
    expect(evenGestureType({ jsonData: { event_type: 2 } })).toBe('down')
    expect(evenGestureType({ jsonData: { type: 'CLICK' } })).toBe('tap')
  })

  it('a bare eventType on the event itself', () => {
    expect(evenGestureType({ eventType: 0 })).toBe('tap')
  })
})

describe('evenGestureType: the omitted protobuf zero (CLICK_EVENT)', () => {
  // CLICK_EVENT is enum 0 and protobuf omits zero-value fields, so a single tap arrives with
  // no eventType field at all. The default must resolve inside the envelope check.
  it('an envelope with no eventType at all is a tap', () => {
    expect(evenGestureType({ sysEvent: {} })).toBe('tap')
    expect(evenGestureType({ textEvent: {} })).toBe('tap')
    expect(evenGestureType({ listEvent: {} })).toBe('tap')
  })

  it('an envelope-less event is not a tap', () => {
    expect(evenGestureType({})).toBeNull()
    expect(evenGestureType(undefined)).toBeNull()
    expect(evenGestureType(null)).toBeNull()
    // `event.sysEvent?.eventType ?? CLICK` would report a tap here
    expect(evenGestureType({ audioEvent: { audioPcm: new Uint8Array(4) } })).toBeNull()
    expect(evenGestureType({ jsonData: {} })).toBeNull()
  })
})

describe('evenGestureType: full ordinal and string mapping', () => {
  it('maps the four gesture ordinals', () => {
    expect(evenGestureType({ sysEvent: { eventType: 0 } })).toBe('tap')
    expect(evenGestureType({ sysEvent: { eventType: 1 } })).toBe('up')
    expect(evenGestureType({ sysEvent: { eventType: 2 } })).toBe('down')
    expect(evenGestureType({ sysEvent: { eventType: 3 } })).toBe('double')
  })

  it('returns null for the non-gesture ordinals 4-8', () => {
    for (const n of [4, 5, 6, 7, 8, 99, -1]) {
      expect(evenGestureType({ sysEvent: { eventType: n } })).toBeNull()
    }
  })
})

// ── long press: PB 9 / 10 ──────────────────────────────────────────────────────────────────
//
// Named and normalised so the events are loggable; this function binds them to no action.

describe('evenGestureType: long press', () => {
  it('maps the two ordinals', () => {
    expect(evenGestureType({ sysEvent: { eventType: 9 } })).toBe('long')
    expect(evenGestureType({ sysEvent: { eventType: 10 } })).toBe('longRelease')
  })

  it('maps the SDK enum names', () => {
    expect(evenGestureType({ sysEvent: { eventType: 'LONG_PRESS_EVENT' } })).toBe('long')
    expect(evenGestureType({ sysEvent: { eventType: 'LONG_PRESS_RELEASE_EVENT' } })).toBe(
      'longRelease',
    )
  })

  it('release is not swallowed by the press branch', () => {
    // `LONG_PRESS_RELEASE_EVENT` contains `LONG_PRESS`, so the branch order matters.
    for (const s of ['LONG_PRESS_RELEASE', 'longPressRelease', 'long_press_release_event']) {
      expect(evenGestureType({ sysEvent: { eventType: s } })).toBe('longRelease')
    }
    for (const s of ['LONG_PRESS', 'longPress', 'long_press_event']) {
      expect(evenGestureType({ sysEvent: { eventType: s } })).toBe('long')
    }
  })

  it('arrives on any of the three envelopes, and through jsonData', () => {
    expect(evenGestureType({ listEvent: { eventType: 9 } })).toBe('long')
    expect(evenGestureType({ textEvent: { eventType: 10 } })).toBe('longRelease')
    expect(evenGestureType({ jsonData: { Event_Type: 'LONG_PRESS_EVENT' } })).toBe('long')
  })

  it('does not disturb the four routed gestures', () => {
    expect(evenGestureType({ sysEvent: { eventType: 0 } })).toBe('tap')
    expect(evenGestureType({ sysEvent: { eventType: 3, eventSource: 2 } })).toBe('double')
  })

  it('returns null for non-gesture event names', () => {
    for (const s of [
      'FOREGROUND_ENTER_EVENT',
      'FOREGROUND_EXIT_EVENT',
      'SYSTEM_EXIT_EVENT',
      'IMU_DATA_REPORT',
    ]) {
      expect(evenGestureType({ sysEvent: { eventType: s } })).toBeNull()
    }
  })

  it('prefers double over click when both substrings are present', () => {
    expect(evenGestureType({ sysEvent: { eventType: 'DOUBLE_CLICK_EVENT' } })).toBe('double')
  })

  it('accepts the short string forms and is case-insensitive', () => {
    expect(evenGestureType({ sysEvent: { eventType: 'scroll_top' } })).toBe('up')
    expect(evenGestureType({ sysEvent: { eventType: 'down' } })).toBe('down')
  })
})

// ── FOREGROUND_ENTER / EXIT ────────────────────────────────────────────────────────────────
//
// A phone notification emits this pair as well as a menu. The pump stands down on `enter` and
// resets its baseline on `exit`, so a false positive freezes the mirror and a false negative
// keeps pushing into a covered panel.

describe('foregroundChange', () => {
  it('names the two foreground events, in every envelope', () => {
    expect(foregroundChange({ sysEvent: { eventType: 4 } })).toBe('enter')
    expect(foregroundChange({ sysEvent: { eventType: 5 } })).toBe('exit')
    expect(foregroundChange({ textEvent: { eventType: 4 } })).toBe('enter')
    expect(foregroundChange({ listEvent: { eventType: 5 } })).toBe('exit')
    expect(foregroundChange({ eventType: 4 })).toBe('enter')
    expect(foregroundChange({ jsonData: { eventType: 5 } })).toBe('exit')
  })

  it('reads the string spellings of both events', () => {
    expect(foregroundChange({ sysEvent: { eventType: 'FOREGROUND_ENTER_EVENT' } })).toBe('enter')
    expect(foregroundChange({ sysEvent: { eventType: 'FOREGROUND_EXIT_EVENT' } })).toBe('exit')
    expect(foregroundChange({ sysEvent: { eventType: 'foregroundEnter' } })).toBe('enter')
  })

  // ABNORMAL_EXIT (6) / SYSTEM_EXIT (7) are the app being torn down, not a layer going away,
  // so a bare `EXIT` must not match.
  it('does not mistake the teardown events for a layer leaving', () => {
    expect(foregroundChange({ sysEvent: { eventType: 6 } })).toBeNull()
    expect(foregroundChange({ sysEvent: { eventType: 7 } })).toBeNull()
    expect(foregroundChange({ sysEvent: { eventType: 'ABNORMAL_EXIT_EVENT' } })).toBeNull()
    expect(foregroundChange({ sysEvent: { eventType: 'SYSTEM_EXIT_EVENT' } })).toBeNull()
  })

  // `evenGestureType` reads a bare envelope as a tap; this must not read it as a foreground
  // change.
  it('returns null for every gesture, including the bare tap envelope', () => {
    for (const e of [
      { sysEvent: {} },
      { textEvent: {} },
      { sysEvent: { eventType: 0 } },
      { sysEvent: { eventType: 1 } },
      { sysEvent: { eventType: 2 } },
      { sysEvent: { eventType: 3 } },
      { sysEvent: { eventType: 9 } },
      { sysEvent: { eventType: 10 } },
    ]) {
      expect(foregroundChange(e), JSON.stringify(e)).toBeNull()
    }
    expect(foregroundChange({})).toBeNull()
    expect(foregroundChange(null)).toBeNull()
    expect(foregroundChange({ menuItemClickEvent: { itemID: 3 } })).toBeNull()
  })

  // An envelope copied verbatim from a device log.
  it('reads the envelope a real G2 sent', () => {
    expect(foregroundChange({ jsonData: { eventType: 4 }, sysEvent: { eventType: 4 } })).toBe(
      'enter',
    )
    expect(foregroundChange({ jsonData: { eventType: 5 }, sysEvent: { eventType: 5 } })).toBe(
      'exit',
    )
  })
})
