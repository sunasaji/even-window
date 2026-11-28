// What the pairing card is allowed to display (src/client/pairingUI.ts).
//
// The randomart comparison is the out-of-band confirmation pairing rests on
// (docs/security.md), and it only means something if each side draws its grid from the key
// it holds. So the device's grid is drawn from its own key, and a response that names a
// different key is a refusal. These cases are the security contract.

import { describe, expect, it } from 'vitest'
import { enrolledKeyDiff } from '../src/client/clients.ts'
import { pairingArtView, pairingTarget, slotLine } from '../src/client/pairingUI.ts'
import { randomart } from '../src/shared/randomart.ts'

const OURS = 'a'.repeat(64)
const THEIRS = 'b'.repeat(64)

describe('pairingArtView', () => {
  it('draws the grid from our key, not from the response', () => {
    const v = pairingArtView(OURS, OURS, randomart(OURS))
    expect(v.art).toBe(randomart(OURS))
    expect(v.id).toBe(OURS)
    expect(v.mismatch).toBe(false)
  })

  it('never displays a server grid that disagrees with ours', () => {
    const v = pairingArtView(OURS, THEIRS, randomart(THEIRS))
    expect(v.mismatch).toBe(true)
    expect(v.art).toBe(randomart(OURS))
    expect(v.art).not.toBe(randomart(THEIRS))
    expect(v.id).toBe(OURS)
  })

  it('flags an art string that does not match the id the response claims', () => {
    // The art is what the human compares, so it is checked on its own, not inferred from the id.
    expect(pairingArtView(OURS, OURS, randomart(THEIRS)).mismatch).toBe(true)
  })

  it('accepts a response that omits the cross-check fields', () => {
    // With nothing to disagree with, our own grid is still the one the operator compares.
    const v = pairingArtView(OURS, '', '')
    expect(v.art).toBe(randomart(OURS))
    expect(v.mismatch).toBe(false)
  })

  it('treats "no local identity" as unverifiable rather than fine', () => {
    // Key generation failed: the server's grid is shown but must not be presented as confirmed.
    const v = pairingArtView('', THEIRS, randomart(THEIRS))
    expect(v.art).toBe(randomart(THEIRS))
    expect(v.id).toBe(THEIRS)
    expect(v.mismatch).toBe(true)
  })
})

describe('randomart is one implementation, shared by both sides', () => {
  // The device and the server must produce byte-identical grids for the same fingerprint.
  it('matches the server-side export for the same fingerprint', async () => {
    const { randomart: serverSide } = await import('../src/server/auth.ts')
    expect(serverSide(OURS)).toBe(randomart(OURS))
    expect(serverSide(THEIRS)).toBe(randomart(THEIRS))
  })
})

// ── the enrolled-keys alert (docs/security.md, the table in `▶ connection`) ─────────────────
//
// `enrolledKeyDiff` holds the policy. Each case is a way the alert could become useless:
// alerting on a fresh install, alerting on a rename, or staying quiet about an added key.

describe('enrolledKeyDiff', () => {
  const A = { id: 'a'.repeat(64) }
  const B = { id: 'b'.repeat(64) }

  it('does not alert on the first ever report: every key is new to a fresh install', () => {
    expect(enrolledKeyDiff([A], null)).toEqual({ added: [], removed: [], alert: false })
    expect(enrolledKeyDiff([A, B], null).alert).toBe(false)
  })

  it('alerts on a key this device has not acknowledged', () => {
    const d = enrolledKeyDiff([A, B], [A.id])
    expect(d.alert).toBe(true)
    expect(d.added).toEqual([B.id])
    expect(d.removed).toEqual([])
  })

  it('reports a revoke without alerting', () => {
    // A key leaving is the safe direction; the alert is reserved for one that arrived.
    const d = enrolledKeyDiff([A], [A.id, B.id])
    expect(d.alert).toBe(false)
    expect(d.removed).toEqual([B.id])
    expect(d.added).toEqual([])
  })

  it('reports both directions when a key was swapped (the re-pairing shape)', () => {
    const d = enrolledKeyDiff([B], [A.id])
    expect(d.added).toEqual([B.id])
    expect(d.removed).toEqual([A.id])
    expect(d.alert).toBe(true)
  })

  it('is quiet when nothing moved, in any order', () => {
    expect(enrolledKeyDiff([A, B], [A.id, B.id])).toEqual({ added: [], removed: [], alert: false })
    expect(enrolledKeyDiff([B, A], [A.id, B.id]).alert).toBe(false)
  })

  it('is quiet for an empty registry that was already empty', () => {
    expect(enrolledKeyDiff([], [])).toEqual({ added: [], removed: [], alert: false })
  })

  it('treats a rename as no change: the id is the principal', () => {
    // The diff only sees ids: a relabelled key is the same key.
    expect(enrolledKeyDiff([{ id: A.id }], [A.id]).alert).toBe(false)
  })
})

// ── carrying the code to another origin ───────────────────────────────────────────────────
//
// When the app and the API are on different origins, a pasted pairing URL has to deliver both
// the code and which server to talk to. The URL carries `server=`; an absolute URL's own
// origin is the fallback.

describe('pairingTarget', () => {
  it('takes a bare code and names no server', () => {
    expect(pairingTarget('AbC-123_xyz')).toEqual({ code: 'AbC-123_xyz', server: '' })
  })

  it('takes the code and the origin out of a pairing URL', () => {
    expect(pairingTarget('https://host.ts.net:8443/?pair=CODE1')).toEqual({
      code: 'CODE1',
      server: 'https://host.ts.net:8443',
    })
  })

  it("prefers an explicit `server=` over the URL's own origin", () => {
    // The app is served from one origin and the API lives on another.
    const t = pairingTarget(
      'https://store.example/app?pair=CODE2&server=https%3A%2F%2Fhost.ts.net%3A8443',
    )
    expect(t).toEqual({ code: 'CODE2', server: 'https://host.ts.net:8443' })
  })

  it('reads a fragment-carried code too', () => {
    expect(pairingTarget('https://host.ts.net:8443/#pair=CODE3').code).toBe('CODE3')
  })

  it('refuses a `server=` that is not a usable origin, rather than guessing', () => {
    const t = pairingTarget('https://host.ts.net:8443/?pair=C&server=not-a-url')
    expect(t.code).toBe('C')
    // Falls back to the URL's own origin, never to a value `normaliseOrigin` rejected.
    expect(t.server).toBe('https://host.ts.net:8443')
  })

  it('returns nothing usable for junk', () => {
    expect(pairingTarget('what is this')).toEqual({ code: '', server: '' })
    expect(pairingTarget('')).toEqual({ code: '', server: '' })
  })
})

// ── the slot count, shown before approval ─────────────────────────────────────────────────
//
// PINHOLE_MAX_CLIENTS is enforced by `pw-auth approve` on the host. The pairing response reports
// the slots, so the device can say beforehand that an approval would be refused.

describe('slotLine', () => {
  it('says how many are free when there is room', () => {
    const s = slotLine(0, 1)
    expect(s.blocked).toBe(false)
    expect(s.text).toMatch(/0 of 1/)
    expect(s.text).toMatch(/1 free/)
  })

  it('blocks at the cap, and names both ways out', () => {
    const s = slotLine(1, 1)
    expect(s.blocked).toBe(true)
    expect(s.text).toMatch(/NO FREE SLOT/)
    expect(s.text).toMatch(/REFUSED/)
    expect(s.text).toMatch(/revoke/)
    expect(s.text).toMatch(/PINHOLE_MAX_CLIENTS/)
  })

  it('does not block a device that is already enrolled: it takes no new slot', () => {
    const s = slotLine(1, 1, true)
    expect(s.blocked).toBe(false)
    expect(s.text).toMatch(/already one of them/)
  })

  it('reports an uncapped registry as having no limit', () => {
    const s = slotLine(7, 0)
    expect(s.blocked).toBe(false)
    expect(s.text).toMatch(/no limit/)
    expect(s.text).toMatch(/7 key/)
  })

  it('clamps a registry that is somehow over its cap', () => {
    // Hand-edited clients.json, or a cap lowered after the fact.
    const s = slotLine(3, 2)
    expect(s.blocked).toBe(true)
    expect(s.text).toMatch(/3 of 2/)
  })
})
