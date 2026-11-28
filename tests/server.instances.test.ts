// pinhole-window — which WebView instance owns the glasses (src/server/instances.ts).
//
// When the Even App dies its page can keep running, so two live clients hold one bridge
// (docs/decisions/glasses-instance-supersede.md). A page cannot see another page; the server
// sees both.
//
// The property that matters is monotonicity: under plain "newest connection wins" the
// superseded page's EventSource retry would take the glasses back.

import { describe, expect, it } from 'vitest'
import { InstanceBook, STALE_MEMORY } from '../src/server/instances.ts'

const CID = 'abc123'

describe('InstanceBook — the newest page load owns the glasses', () => {
  it('adopts the first instance and displaces nobody', () => {
    const b = new InstanceBook()
    expect(b.verdict(CID, 'A')).toBe('adopt')
    expect(b.adopt(CID, 'A')).toBeNull()
    expect(b.currentOf(CID)).toBe('A')
  })

  it('a new instance takes over and names who it displaced', () => {
    const b = new InstanceBook()
    b.adopt(CID, 'A')
    expect(b.verdict(CID, 'B')).toBe('adopt')
    expect(b.adopt(CID, 'B')).toBe('A')
    expect(b.currentOf(CID)).toBe('B')
  })

  it('the same instance reconnecting changes nothing — no supersede to anyone', () => {
    // An EventSource drop and retry is routine (the ticket expires after 60s), and it must not
    // be mistaken for a second page.
    const b = new InstanceBook()
    b.adopt(CID, 'A')
    expect(b.verdict(CID, 'A')).toBe('adopt')
    expect(b.adopt(CID, 'A')).toBeNull()
    expect(b.currentOf(CID)).toBe('A')
  })

  it('a superseded instance reconnecting is told again, and does not take over', () => {
    // The case. The old page is still alive and its stream will come back.
    const b = new InstanceBook()
    b.adopt(CID, 'A')
    b.adopt(CID, 'B')
    expect(b.verdict(CID, 'A')).toBe('stale')
    expect(b.currentOf(CID)).toBe('B')
  })

  it('cannot ping-pong, however many times the old page retries', () => {
    const b = new InstanceBook()
    b.adopt(CID, 'A')
    b.adopt(CID, 'B')
    for (let i = 0; i < 50; i++) {
      expect(b.verdict(CID, 'A')).toBe('stale')
      // The server never calls `adopt` on a stale verdict; even if it did, ownership holds.
      expect(b.currentOf(CID)).toBe('B')
    }
  })

  it('a third page load takes over from the second, and both older ones stay stale', () => {
    const b = new InstanceBook()
    b.adopt(CID, 'A')
    b.adopt(CID, 'B')
    expect(b.adopt(CID, 'C')).toBe('B')
    expect(b.verdict(CID, 'A')).toBe('stale')
    expect(b.verdict(CID, 'B')).toBe('stale')
    expect(b.verdict(CID, 'C')).toBe('adopt')
  })

  it('identities are independent — two paired devices do not fight', () => {
    // `PINHOLE_MAX_CLIENTS` is 1 by default, but it can be raised, and a second enrolled device is
    // a different user-visible thing from a second WebView on the same phone.
    const b = new InstanceBook()
    b.adopt('phone', 'A')
    expect(b.adopt('laptop', 'B')).toBeNull()
    expect(b.currentOf('phone')).toBe('A')
    expect(b.currentOf('laptop')).toBe('B')
    expect(b.verdict('phone', 'A')).toBe('adopt')
  })

  it('a client that sends no instance id is left entirely alone', () => {
    // A client without an instance id is never superseded and never supersedes anyone.
    const b = new InstanceBook()
    b.adopt(CID, 'A')
    expect(b.verdict(CID, '')).toBe('ignore')
    expect(b.adopt(CID, '')).toBeNull()
    expect(b.currentOf(CID)).toBe('A') // ownership untouched
  })

  it('remembers a bounded number of superseded ids, newest first to survive', () => {
    const b = new InstanceBook()
    b.adopt(CID, 'first')
    for (let i = 0; i < STALE_MEMORY + 10; i++) b.adopt(CID, `i${String(i)}`)
    // The oldest have been forgotten (they are long dead), the recent ones have not.
    expect(b.verdict(CID, 'first')).toBe('adopt')
    expect(b.verdict(CID, `i${String(STALE_MEMORY + 8)}`)).toBe('stale')
  })

  it('a disconnect does not release ownership (only `reset` does)', () => {
    // A quiet stream does not mean the old page is gone. If a disconnect cleared the owner,
    // the old page would reclaim the glasses by reconnecting.
    const b = new InstanceBook()
    b.adopt(CID, 'A')
    b.adopt(CID, 'B')
    // (no disconnect hook exists by design; this pins that `reset` is the only way back)
    expect(b.verdict(CID, 'A')).toBe('stale')
    b.reset()
    expect(b.verdict(CID, 'A')).toBe('adopt')
    expect(b.currentOf(CID)).toBeUndefined()
  })
})
