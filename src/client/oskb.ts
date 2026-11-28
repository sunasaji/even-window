// pinhole-window — the on-screen keyboard (`keys` panel) and its one-shot modifiers.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { KEY_CHROME } from './chrome.ts'
import { x11Inject } from './gestures.ts'

// Two blocks:
//
//   #tkeys  a fixed grid, not a wrapped row: each line is a left cluster (modifier / editing
//           keys) and a right cluster (nav / arrows) separated by a spacer, so the right
//           cluster starts at the same x on every line.
//             [Alt ][Tab ]   [Ins ][Home][PgUp]
//             [Esc ][Ent ]   [Del ][End ][PgDn]
//             [Ctrl][F…  ]   [ ← ][ ↑ ][ ↓ ][ → ][BS ]
//           `F…` discloses F1-F12 as an extra wrapped row underneath.
//   #oskb   the character keyboard: a number row, three letter rows, a symbol row, a sticky
//           Shift at the end of the row that ends in "m", then space + Enter.
//
// Key names are xdotool's (`Return`, `Insert`, `Page_Up`, `BackSpace`): `POST /api/desktop/input
// {kind:'key'}` hands `arg` to `xdotool key` untranslated (docs/protocol.md). An unmodified
// character is `{kind:'type'}`; with Ctrl/Alt armed it is `{kind:'key'}` and needs the X keysym
// name instead of the glyph (`ctrl+minus`, not `ctrl+-`), hence CHAR_KEYSYM.
//
// The min-widths (52/54/40/40) make the widest line 332px, which fits the 336px content box of
// a 360px viewport.

/** Glyph → X keysym name, for chords: `xdotool key ctrl+-` is not parseable, `ctrl+minus` is.
 *  Punctuation only; xdotool takes letters and digits as-is. */
const CHAR_KEYSYM: Readonly<Record<string, string>> = {
  ' ': 'space',
  '!': 'exclam',
  '"': 'quotedbl',
  '#': 'numbersign',
  $: 'dollar',
  '%': 'percent',
  '&': 'ampersand',
  "'": 'apostrophe',
  '(': 'parenleft',
  ')': 'parenright',
  '*': 'asterisk',
  '+': 'plus',
  ',': 'comma',
  '-': 'minus',
  '.': 'period',
  '/': 'slash',
  ':': 'colon',
  ';': 'semicolon',
  '<': 'less',
  '=': 'equal',
  '>': 'greater',
  '?': 'question',
  '@': 'at',
  '[': 'bracketleft',
  '\\': 'backslash',
  ']': 'bracketright',
  '^': 'asciicircum',
  _: 'underscore',
  '`': 'grave',
  '{': 'braceleft',
  '|': 'bar',
  '}': 'braceright',
  '~': 'asciitilde',
}

/** The xdotool spelling for one character used as a key (modifier armed). */
export function charKeysym(ch: string): string {
  return CHAR_KEYSYM[ch] ?? ch
}

/** The `#oskb` rows: `[lowerLabel, upperLabel]`. Where they are equal, Shift is a no-op for
 *  that key. */
const OSKB_ROWS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [
    ['1', '!'],
    ['2', '@'],
    ['3', '#'],
    ['4', '$'],
    ['5', '%'],
    ['6', '^'],
    ['7', '&'],
    ['8', '*'],
    ['9', '('],
    ['0', ')'],
  ],
  [
    ['q', 'Q'],
    ['w', 'W'],
    ['e', 'E'],
    ['r', 'R'],
    ['t', 'T'],
    ['y', 'Y'],
    ['u', 'U'],
    ['i', 'I'],
    ['o', 'O'],
    ['p', 'P'],
  ],
  [
    ['a', 'A'],
    ['s', 'S'],
    ['d', 'D'],
    ['f', 'F'],
    ['g', 'G'],
    ['h', 'H'],
    ['j', 'J'],
    ['k', 'K'],
    ['l', 'L'],
  ],
  [
    ['z', 'Z'],
    ['x', 'X'],
    ['c', 'C'],
    ['v', 'V'],
    ['b', 'B'],
    ['n', 'N'],
    ['m', 'M'],
  ],
  [
    ['-', '_'],
    ['=', '+'],
    ['[', '{'],
    [']', '}'],
    ['\\', '|'],
    [';', ':'],
    ["'", '"'],
    [',', '<'],
    ['.', '>'],
    ['/', '?'],
    ['`', '~'],
  ],
]

/** One-shot Ctrl / Alt: tapping one arms it, the next key consumes it, and it disarms itself.
 *  They accumulate (`Ctrl` then `Alt` → `ctrl+alt+x`). */
const keyMod = { ctrl: false, alt: false }
let ctrlBtnEl: HTMLButtonElement | null = null
let altBtnEl: HTMLButtonElement | null = null

/** An armed modifier gets the green fill. `background` rather than `filter`, because these keys
 *  carry explicit chrome (KEY_CHROME); Shift uses the same `#2b6`. */
function syncMods(): void {
  if (ctrlBtnEl) ctrlBtnEl.style.background = keyMod.ctrl ? '#2b6' : '#e9e9e9'
  if (altBtnEl) altBtnEl.style.background = keyMod.alt ? '#2b6' : '#e9e9e9'
}

/** The armed modifiers as xdotool keysyms, in a fixed order (`ctrl` before `alt`). Read-only;
 *  see `takeKeyMods`. */
export function keyModList(): readonly string[] {
  const mods: string[] = []
  if (keyMod.ctrl) mods.push('ctrl')
  if (keyMod.alt) mods.push('alt')
  return mods
}

/** `ctrl+` / `ctrl+alt+` / `''`: the prefix that turns `click` into `ctrl+click` in a log line
 *  and `keysym` into `ctrl+keysym` for `xdotool key`. */
export function modPrefix(mods: readonly string[]): string {
  return mods.length ? mods.join('+') + '+' : ''
}

/** Consume the armed modifiers: return them and disarm.
 *
 *  One-shot everywhere, vPad included: an arm that persisted for a pad session would make every
 *  later tap a `ctrl+click` with nothing on screen saying so (docs/phone-ui.md). */
export function takeKeyMods(): readonly string[] {
  const mods = keyModList()
  if (mods.length) {
    keyMod.ctrl = false
    keyMod.alt = false
    syncMods()
  }
  return mods
}

/** Compose the armed modifiers onto the keysym, inject, then disarm. The composed `arg` is also
 *  the log tag, so the log names which key was injected. */
function sendKeyMod(keysym: string): void {
  const arg = modPrefix(takeKeyMods()) + keysym // takes and disarms, in one place
  void x11Inject('key', arg, arg)
}

/** A bare character types; a character under an armed modifier is a key chord. (The text box's
 *  `Submit` is not modifier-aware: it always sends a plain `type`.) */
function sendChar(ch: string): void {
  if (keyMod.ctrl || keyMod.alt) {
    sendKeyMod(charKeysym(ch))
    return
  }
  void x11Inject('type', ch, `'${ch}'`)
}

/** The whole `keys` panel: the `#tkeys` grid, then the `#oskb` QWERTY. Returns the container,
 *  hidden; the `keys` pill toggles `display`. */
export function buildKeyPad(): HTMLDivElement {
  const box = document.createElement('div')
  box.style.cssText = 'display:none;flex-direction:column;gap:8px;margin:0 0 8px'

  // ── #tkeys ──────────────────────────────────────────────────────────────────────────────
  const tkeys = document.createElement('div')
  tkeys.id = 'tkeys'
  tkeys.style.cssText = 'display:flex;flex-direction:column;gap:4px'
  const mkKey = (label: string, onClick: () => void, mw = 54): HTMLButtonElement => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText =
      KEY_CHROME + `padding:6px 0;font:12px ui-monospace,monospace;min-width:${mw}px;`
    b.addEventListener('click', onClick)
    return b
  }
  const skey = (label: string, keysym: string, mw = 54): HTMLButtonElement =>
    mkKey(
      label,
      () => {
        sendKeyMod(keysym)
      },
      mw,
    )
  const grp = (...kids: HTMLElement[]): HTMLDivElement => {
    const d = document.createElement('div')
    d.style.cssText = 'display:flex;gap:4px'
    d.append(...kids)
    return d
  }
  // A row pins the left cluster to the left and offsets the right cluster by a spacer, so the
  // right cluster starts at the same x on every row. The spacer may shrink (`flex:0 1 16px`) so
  // a 360px viewport squeezes the gutter rather than the keys.
  const row = (left: HTMLElement, right: HTMLElement): void => {
    const d = document.createElement('div')
    d.style.cssText = 'display:flex;align-items:center'
    const sp = document.createElement('div')
    sp.style.cssText = 'flex:0 1 16px;min-width:6px'
    d.append(left, sp, right)
    tkeys.appendChild(d)
  }
  ctrlBtnEl = mkKey(
    'Ctrl',
    () => {
      keyMod.ctrl = !keyMod.ctrl
      syncMods()
    },
    52,
  )
  altBtnEl = mkKey(
    'Alt',
    () => {
      keyMod.alt = !keyMod.alt
      syncMods()
    },
    52,
  )
  const fRow = document.createElement('div')
  fRow.style.cssText = 'display:none;flex-wrap:wrap;gap:4px;margin-top:4px'
  for (let i = 1; i <= 12; i++)
    fRow.appendChild(
      mkKey(
        'F' + String(i),
        () => {
          sendKeyMod('F' + String(i))
        },
        40,
      ),
    )
  const fBtn = mkKey(
    'F…',
    () => {
      fRow.style.display = fRow.style.display === 'none' ? 'flex' : 'none'
    },
    52,
  )
  row(
    grp(altBtnEl, skey('Tab', 'Tab', 52)),
    grp(skey('Ins', 'Insert'), skey('Home', 'Home'), skey('PgUp', 'Page_Up')),
  )
  row(
    grp(skey('Esc', 'Escape', 52), skey('Ent', 'Return', 52)),
    grp(skey('Del', 'Delete'), skey('End', 'End'), skey('PgDn', 'Page_Down')),
  )
  row(
    grp(ctrlBtnEl, fBtn),
    grp(
      skey('←', 'Left', 40),
      skey('↑', 'Up', 40),
      skey('↓', 'Down', 40),
      skey('→', 'Right', 40),
      skey('BS', 'BackSpace', 40),
    ),
  )
  tkeys.appendChild(fRow)
  syncMods()
  box.appendChild(tkeys)

  // ── #oskb ───────────────────────────────────────────────────────────────────────────────
  const oskb = document.createElement('div')
  oskb.id = 'oskb'
  let shift = false
  const charBtns: { el: HTMLButtonElement; key: readonly [string, string] }[] = []
  const keyStyle =
    KEY_CHROME + 'padding:8px 0;font:14px ui-monospace,monospace;flex:1;min-width:26px;'
  const relabel = (): void => {
    for (const { el, key } of charBtns) el.textContent = shift ? key[1] : key[0]
  }
  const shiftBtn = document.createElement('button')
  shiftBtn.textContent = 'Shift'
  shiftBtn.style.cssText = keyStyle + 'flex:2.5;'
  shiftBtn.addEventListener('click', () => {
    shift = !shift
    shiftBtn.style.background = shift ? '#2b6' : '#e9e9e9'
    relabel()
  })
  for (const r of OSKB_ROWS) {
    const line = document.createElement('div')
    line.style.cssText = 'display:flex;gap:3px;margin:0 0 3px'
    for (const key of r) {
      const b = document.createElement('button')
      b.textContent = key[0]
      b.style.cssText = keyStyle
      b.addEventListener('click', () => {
        sendChar(shift ? key[1] : key[0])
      })
      line.appendChild(b)
      charBtns.push({ el: b, key })
    }
    // Shift sits at the right end of the row ending in "m", reachable without leaving the letters.
    if (r === OSKB_ROWS[3]) line.appendChild(shiftBtn)
    oskb.appendChild(line)
  }
  const bottom = document.createElement('div')
  bottom.style.cssText = 'display:flex;gap:3px'
  const bmk = (label: string, grow: number, on: () => void): void => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText =
      KEY_CHROME + `padding:8px 0;font:13px ui-monospace,monospace;flex:${String(grow)};`
    b.addEventListener('click', on)
    bottom.appendChild(b)
  }
  bmk('space', 5, () => {
    sendChar(' ')
  })
  bmk('Enter', 2, () => {
    sendKeyMod('Return')
  })
  oskb.appendChild(bottom)
  box.appendChild(oskb)

  const note = document.createElement('div')
  note.style.cssText = 'font:11px/1.4 system-ui;color:#888'
  // The note states the touch-rate ceiling (~1.6 taps/s, docs/phone-ui.md) and the full reach
  // of the one-shot: vPad takes the arm as a lit pill, Submit does not, Shift is sticky.
  note.textContent =
    'On-screen taps register at ~1.6/s max (about one per 600ms) — a platform ' +
    'limit of the WebView touch layer, not a bug here. For more than a few keys, use the text ' +
    'box above; it sends the whole string in one injection. Ctrl/Alt are one-shot: they arm, ' +
    'and the next key here uses them and disarms them. Opening vPad with one armed lights its ' +
    'pill there, where it stays on until tapped. Submit is not modified by them. Shift is ' +
    'sticky until you tap it off.'
  box.appendChild(note)
  return box
}
