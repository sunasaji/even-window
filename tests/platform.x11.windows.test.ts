// Unit tests for the pure halves of the X11 window backend, fed literal
// `ratpoison -c 'windows %n|%s|%i|%c|%t'` output and literal `xprop` output, both captured
// from a live session.

import { describe, expect, it } from 'vitest'
import {
  normXid,
  parseRatpoisonWindows,
  parseWmCommand,
} from '../src/server/platform/x11/windows.ts'

// From a live ratpoison with two xterms, the second focused.
const TWO = '1|-|4194305|XTerm|xterm\n2|*|6291457|XTerm|second\n'

describe('normXid', () => {
  it('accepts both spellings and normalises to lowercase hex', () => {
    expect(normXid('4194305')).toBe('0x400001')
    expect(normXid('0x400001')).toBe('0x400001')
    expect(normXid('0X400001')).toBe('0x400001')
    expect(normXid(4194305)).toBe('0x400001')
    // ...so a wire wid and a ratpoison decimal compare equal.
    expect(normXid('0x400001')).toBe(normXid('4194305'))
  })

  it('returns empty for junk, so a bad selector can never match a window', () => {
    for (const v of ['', '  ', 'xterm', '-1', '1.5', undefined]) expect(normXid(v)).toBe('')
  })
})

describe('parseRatpoisonWindows', () => {
  it('parses output captured verbatim from a live ratpoison', () => {
    // ratpoison numbers windows from zero and marks the previously-current window '+';
    // neither may be mistaken for "no window is active".
    expect(parseRatpoisonWindows('0|*|4194316|XTerm|xterm\n1|+|8388620|XTerm|two\n')).toEqual([
      { id: '0', wid: '0x40000c', cls: 'XTerm', title: 'xterm', active: true },
      { id: '1', wid: '0x80000c', cls: 'XTerm', title: 'two', active: false },
    ])
  })

  it('parses the common two-window case', () => {
    expect(parseRatpoisonWindows(TWO)).toEqual([
      { id: '1', wid: '0x400001', cls: 'XTerm', title: 'xterm', active: false },
      { id: '2', wid: '0x600001', cls: 'XTerm', title: 'second', active: true },
    ])
  })

  it('treats only "*" as active ("+" = last, "-" = other)', () => {
    const l = parseRatpoisonWindows('1|+|4194305|XTerm|a\n2|-|4194307|XTerm|b\n')
    expect(l.map(w => w.active)).toEqual([false, false])
  })

  it('keeps a title containing the field separator intact', () => {
    const l = parseRatpoisonWindows('3|*|4194305|URxvt|vim | src/main.ts | 1,1\n')
    expect(l[0]?.title).toBe('vim | src/main.ts | 1,1')
    expect(l[0]?.cls).toBe('URxvt')
  })

  // xmountains sets no WM_CLASS, and ratpoison prints the literal string `None` for it. Taken
  // at face value, `cls:none` would be a swipe-binding key (docs/glasses.md) shared by every
  // class-less program.
  it('reads ratpoison\'s literal "None" class as absent, not as a class named none', () => {
    const l = parseRatpoisonWindows('2|*|10485761|None|Xmountains\n')
    expect(l[0]?.cls).toBe('')
    expect(l[0]?.title).toBe('Xmountains')
    // A class that merely contains the word is untouched — only the exact token is ratpoison's.
    expect(parseRatpoisonWindows('3|-|4194305|Nonesuch|x\n')[0]?.cls).toBe('Nonesuch')
  })

  it('returns [] for an empty desktop', () => {
    expect(parseRatpoisonWindows('')).toEqual([])
    expect(parseRatpoisonWindows('\n\n')).toEqual([])
    // ratpoison prints this prose line when nothing is managed.
    expect(parseRatpoisonWindows('No managed windows\n')).toEqual([])
  })

  it('skips malformed lines instead of emitting a bogus window', () => {
    const l = parseRatpoisonWindows('1|*|4194305|XTerm|ok\ngarbage\n|||\n2|*|notanid|XTerm|bad\n')
    expect(l.map(w => w.title)).toEqual(['ok'])
  })

  it('substitutes a placeholder for an empty title', () => {
    expect(parseRatpoisonWindows('4|-|4194305|XTerm|   \n')[0]?.title).toBe('win 4')
  })

  it('leaves app unset — the identity pass in listWindows() fills it', () => {
    expect(parseRatpoisonWindows(TWO)[1]?.app).toBeUndefined()
  })
})

// WM_COMMAND is the ICCCM property a client sets so a session manager can restart it. Clients
// that publish no `_NET_WM_PID` often still set it.
describe('parseWmCommand', () => {
  it('parses the argv xprop prints, captured verbatim from :100', () => {
    const out = 'WM_COMMAND(STRING) = { "/usr/bin/xterm", "-bg", "black", "-fg", "white", "+sb" }\n'
    expect(parseWmCommand(out)).toEqual(['/usr/bin/xterm', '-bg', 'black', '-fg', 'white', '+sb'])
  })

  // What this buys over comm: the full path, straight off a window that may have no pid.
  it('yields an absolute argv[0] where there is one', () => {
    expect(parseWmCommand('WM_COMMAND(STRING) = { "/usr/bin/xterm" }')[0]).toBe('/usr/bin/xterm')
    expect(parseWmCommand('WM_COMMAND(STRING) = { "firefox" }')[0]).toBe('firefox')
  })

  it('returns [] for the "not found" answer and for anything else', () => {
    expect(parseWmCommand('WM_COMMAND:  not found.')).toEqual([])
    expect(parseWmCommand('')).toEqual([])
    expect(parseWmCommand('WM_NAME(STRING) = "Xmountains"')).toEqual([])
  })

  it('unescapes without letting an escaped quote end the list', () => {
    expect(parseWmCommand('WM_COMMAND(STRING) = { "a\\"b", "c" }')).toEqual(['a"b', 'c'])
  })
})
