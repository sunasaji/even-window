// Unit tests for the pure, OS-neutral window helpers (the change key and the focus-recency
// fold). The lists are built by the X11 backend's parser from literal
// `ratpoison -c 'windows %n|%s|%i|%c|%t'` output.

import { describe, expect, it } from 'vitest'
import { parseRatpoisonWindows } from '../src/server/platform/x11/windows.ts'
import { mruFold, windowsKey } from '../src/server/windows.ts'

// Two xterms, the second focused.
const TWO = '1|-|4194305|XTerm|xterm\n2|*|6291457|XTerm|second\n'

describe('windowsKey', () => {
  const list = parseRatpoisonWindows(TWO)

  it('is stable for an unchanged set', () => {
    expect(windowsKey(list)).toBe(windowsKey(parseRatpoisonWindows(TWO)))
  })

  it('changes when the title changes', () => {
    expect(windowsKey(parseRatpoisonWindows('1|*|4194305|XTerm|vim\n'))).not.toBe(
      windowsKey(parseRatpoisonWindows('1|*|4194305|XTerm|less\n')),
    )
  })

  it('changes when focus moves', () => {
    expect(
      windowsKey(parseRatpoisonWindows('1|*|4194305|XTerm|a\n2|-|4194307|XTerm|b\n')),
    ).not.toBe(windowsKey(parseRatpoisonWindows('1|-|4194305|XTerm|a\n2|*|4194307|XTerm|b\n')))
  })

  it('changes when a window appears or disappears', () => {
    expect(windowsKey(list)).not.toBe(
      windowsKey(parseRatpoisonWindows('1|-|4194305|XTerm|xterm\n')),
    )
  })

  it('ignores pure renumbering (the short handle may be recycled; the set did not change)', () => {
    const before = parseRatpoisonWindows('2|-|4194305|XTerm|xterm\n3|*|6291457|XTerm|second\n')
    expect(windowsKey(before)).toBe(windowsKey(list))
  })
})

// ── focus recency (the glasses menu's MRU order) ────────────────────────────────────────
//
// Folded from the same 1 Hz observation the window list comes from, so these feed it exactly
// what `parseRatpoisonWindows` produces rather than a hand-made shape.

describe('mruFold', () => {
  const list = (out: string) => parseRatpoisonWindows(out)
  // Three windows; the `|*|` moves between the cases. Numbers are ratpoison's, window ids are stable.
  const A = '1|*|4194305|XTerm|a\n2|-|4194306|XTerm|b\n3|-|4194307|XTerm|c\n' // a focused
  const B = '1|-|4194305|XTerm|a\n2|*|4194306|XTerm|b\n3|-|4194307|XTerm|c\n' // b focused
  const C = '1|-|4194305|XTerm|a\n2|-|4194306|XTerm|b\n3|*|4194307|XTerm|c\n' // c focused

  it('seeds from the first observation: the active window heads it, the rest follow the list', () => {
    expect(mruFold([], list(A))).toEqual(['0x400001', '0x400002', '0x400003'])
    expect(mruFold([], list(C))).toEqual(['0x400003', '0x400001', '0x400002'])
  })

  it('moves the newly focused window to the head and pushes the rest down one', () => {
    let mru = mruFold([], list(A))
    mru = mruFold(mru, list(B))
    expect(mru).toEqual(['0x400002', '0x400001', '0x400003'])
    mru = mruFold(mru, list(C))
    expect(mru).toEqual(['0x400003', '0x400002', '0x400001'])
    // …and back to the first window: the order is a history, not a rotation.
    expect(mruFold(mru, list(A))).toEqual(['0x400001', '0x400003', '0x400002'])
  })

  // Every `listWindows()` call folds, so a fold that drifted would reorder an idle desktop.
  it('is idempotent — folding the same observation twice changes nothing', () => {
    const once = mruFold(mruFold([], list(A)), list(B))
    expect(mruFold(once, list(B))).toEqual(once)
    expect(mruFold(mruFold(once, list(B)), list(B))).toEqual(once)
  })

  it('drops windows that have closed', () => {
    const mru = mruFold(mruFold([], list(A)), list(C))
    expect(mru).toContain('0x400002')
    // b closed; c still has focus.
    const after = mruFold(mru, list('1|-|4194305|XTerm|a\n3|*|4194307|XTerm|c\n'))
    expect(after).toEqual(['0x400003', '0x400001'])
  })

  // A window that opens without taking focus must not displace the one the user was in.
  it('appends a never-focused newcomer at the tail, not the head', () => {
    const mru = mruFold(mruFold([], list(A)), list(B)) // b, a
    const grown = mruFold(
      mru,
      list('1|-|4194305|XTerm|a\n2|*|4194306|XTerm|b\n3|-|4194307|XTerm|c\n4|-|4194308|XTerm|d\n'),
    )
    expect(grown).toEqual(['0x400002', '0x400001', '0x400003', '0x400004'])
  })

  it('still heads the order with a newcomer that did take focus (the usual case for a launch)', () => {
    const mru = mruFold([], list(A))
    const grown = mruFold(
      mru,
      list('1|-|4194305|XTerm|a\n2|-|4194306|XTerm|b\n3|-|4194307|XTerm|c\n4|*|4194308|XTerm|d\n'),
    )
    expect(grown[0]).toBe('0x400004')
  })

  it('survives an empty desktop and a list where nothing is focused', () => {
    expect(mruFold([], [])).toEqual([])
    expect(mruFold(['0x400001'], [])).toEqual([])
    // ratpoison spells "no current window" as no `*` at all (and `+` for the last one, which
    // parseRatpoisonWindows deliberately does not read as active). The order must hold still.
    const none = '1|+|4194305|XTerm|a\n2|-|4194306|XTerm|b\n'
    expect(mruFold(['0x400002', '0x400001'], list(none))).toEqual(['0x400002', '0x400001'])
  })

  it('never repeats an wid, whatever it is given', () => {
    const out = mruFold(['0x400002', '0x400002', '0x400001'], list(B))
    expect(out).toEqual(['0x400002', '0x400001', '0x400003'])
    expect(new Set(out).size).toBe(out.length)
  })
})
