// even-window — the OS-neutral input vocabulary: which low-level kinds the wire accepts, and
// the key-name -> chord spelling translation. Injection itself is the backend's
// (`platform.input`).

import type { InputKind } from '../shared/types.ts'

/** Every low-level kind `POST /api/desktop/input` accepts (docs/protocol.md). */
const KINDS: readonly InputKind[] = [
  'key',
  'type',
  'click',
  'dblclick',
  'move',
  'clickat',
  'down',
  'up',
  'keydown',
  'keyup',
]

export function isInputKind(s: string): s is InputKind {
  return (KINDS as readonly string[]).includes(s)
}

/** Translate a key name (`Enter`, `PageUp`, `BTab`, `C-a`, a bare char, `F1`…) into the chord
 *  spelling of the wire (`Return`, `Page_Up`, `ISO_Left_Tab`, `ctrl+a`, …). Pure; unmapped
 *  names pass through unchanged so F1-F12 and single characters work with no table entry. */
export function keyNameToChord(k: string): string {
  let mods = ''
  let s = k
  for (;;) {
    if (s.startsWith('C-')) {
      mods += 'ctrl+'
      s = s.slice(2)
    } else if (s.startsWith('M-')) {
      mods += 'alt+'
      s = s.slice(2)
    } else if (s.startsWith('S-')) {
      mods += 'shift+'
      s = s.slice(2)
    } else break
  }
  const map: Record<string, string> = {
    Enter: 'Return',
    Escape: 'Escape',
    Space: 'space',
    Tab: 'Tab',
    BTab: 'ISO_Left_Tab',
    BSpace: 'BackSpace',
    Up: 'Up',
    Down: 'Down',
    Left: 'Left',
    Right: 'Right',
    PageUp: 'Page_Up',
    PageDown: 'Page_Down',
    Home: 'Home',
    End: 'End',
    IC: 'Insert',
    DC: 'Delete',
  }
  return mods + (map[s] ?? s)
}
