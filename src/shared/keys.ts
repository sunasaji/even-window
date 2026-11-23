// The closed catalogue of keys a gesture may be bound to, and the chord it forms.
//
// A stored binding is validated against this table, not a pattern: a name that is not a
// keysym (`Pagedown`, `Ctrl`) would otherwise save cleanly and send nothing. Every entry's
// stored `name` is its xdotool spelling, so `chordToXdo` is pure concatenation; `label` is
// for display only. The one exception is the wheel entries (see `KeyDef.wheel`).

/** A modifier. `super` is omitted: nothing in the display session owns it, and a host window
 *  manager is likely to have grabbed it. */
export type Mod = 'ctrl' | 'alt' | 'shift'

/** Every modifier, in the one canonical order a chord spells them. */
export const MODS: readonly Mod[] = ['ctrl', 'alt', 'shift']

export type KeyGroup = 'nav' | 'wheel' | 'edit' | 'fn' | 'alnum' | 'punct' | 'keypad'

/** Human-facing group names, for the picker's `<optgroup>` labels. */
export const GROUP_LABEL: Readonly<Record<KeyGroup, string>> = {
  nav: 'navigation',
  wheel: 'wheel (pointer, not keys)',
  edit: 'editing',
  fn: 'function',
  alnum: 'letters & digits',
  punct: 'punctuation',
  keypad: 'keypad',
}

export interface KeyDef {
  /** The xdotool / X keysym spelling. This is what is stored and what is sent. */
  name: string
  /** What a human recognises it by (`Enter` for `Return`, `-` for `minus`). The picker's
   *  filter matches it too. */
  label: string
  group: KeyGroup
  /** With Shift this key produces a different character (`shift+a` → A, `shift+2` → @), which
   *  the UI points out. */
  shiftsToGlyph?: true
  /** Not a key: an X11 pointer button, 4 = wheel up / 5 = wheel down. `name` is not a keysym
   *  here, so everything that turns a chord into a command must ask `wheelButton()` first. */
  wheel?: 4 | 5
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')
const DIGITS = '0123456789'.split('')

/** Punctuation, as `[keysym, glyph]`. The keysym is required: `xdotool key ctrl+-` does not
 *  parse, `ctrl+minus` does. */
const PUNCT: ReadonlyArray<readonly [string, string]> = [
  ['minus', '-'],
  ['equal', '='],
  ['bracketleft', '['],
  ['bracketright', ']'],
  ['backslash', '\\'],
  ['semicolon', ';'],
  ['apostrophe', "'"],
  ['comma', ','],
  ['period', '.'],
  ['slash', '/'],
  ['grave', '`'],
]

/** The closed set, about 80 entries: the keys this project is willing to store, not every
 *  keysym xdotool accepts. */
export const KEYS: readonly KeyDef[] = [
  // Navigation sorts first in the picker.
  { name: 'Up', label: 'Up', group: 'nav' },
  { name: 'Down', label: 'Down', group: 'nav' },
  { name: 'Left', label: 'Left', group: 'nav' },
  { name: 'Right', label: 'Right', group: 'nav' },
  { name: 'Page_Up', label: 'PgUp', group: 'nav' },
  { name: 'Page_Down', label: 'PgDn', group: 'nav' },
  // A key goes to the focused window; the wheel goes to the window under the pointer. It
  // reaches applications that scroll on the wheel and ignore Up/Down.
  { name: 'WheelUp', label: 'wheel up', group: 'wheel', wheel: 4 },
  { name: 'WheelDown', label: 'wheel down', group: 'wheel', wheel: 5 },
  { name: 'Home', label: 'Home', group: 'nav' },
  { name: 'End', label: 'End', group: 'nav' },

  { name: 'Return', label: 'Enter', group: 'edit' },
  { name: 'Tab', label: 'Tab', group: 'edit' },
  { name: 'ISO_Left_Tab', label: 'BackTab', group: 'edit' },
  { name: 'Escape', label: 'Esc', group: 'edit' },
  { name: 'space', label: 'Space', group: 'edit' },
  { name: 'BackSpace', label: 'BkSp', group: 'edit' },
  { name: 'Delete', label: 'Del', group: 'edit' },
  { name: 'Insert', label: 'Ins', group: 'edit' },

  ...Array.from({ length: 12 }, (_, i): KeyDef => {
    const n = `F${String(i + 1)}`
    return { name: n, label: n, group: 'fn' }
  }),

  ...LETTERS.map((c): KeyDef => ({ name: c, label: c, group: 'alnum', shiftsToGlyph: true })),
  ...DIGITS.map((c): KeyDef => ({ name: c, label: c, group: 'alnum', shiftsToGlyph: true })),
  ...PUNCT.map(([n, g]): KeyDef => ({ name: n, label: g, group: 'punct', shiftsToGlyph: true })),

  // xterm's larger/smaller-vt-font is `shift+KP_Add` / `shift+KP_Subtract` (`FONTSIZE_DEFAULT`).
  { name: 'KP_Add', label: 'KP +', group: 'keypad' },
  { name: 'KP_Subtract', label: 'KP −', group: 'keypad' },
  { name: 'KP_Multiply', label: 'KP ×', group: 'keypad' },
  { name: 'KP_Divide', label: 'KP ÷', group: 'keypad' },
  { name: 'KP_Enter', label: 'KP Enter', group: 'keypad' },
]

const BY_NAME: ReadonlyMap<string, KeyDef> = new Map(KEYS.map(k => [k.name, k]))

/** The catalogue entry for a stored name, or null when it is not in the catalogue. */
export function keyDef(name: string): KeyDef | null {
  return BY_NAME.get(name) ?? null
}

/** The gate: a set-membership test. The server calls it before writing bindings.json. */
export function isBindableKey(name: unknown): name is string {
  return typeof name === 'string' && BY_NAME.has(name)
}

/** A key plus its modifiers. Structured, not a `"C-u"` string: there is no parse step, and
 *  two spellings of one chord cannot both exist. The `C-` string is a derived label
 *  (`chordLabel`), never the record. */
export interface Chord {
  mods: Mod[]
  key: string
}

function isMod(v: unknown): v is Mod {
  return typeof v === 'string' && (MODS as readonly string[]).includes(v)
}

/** Pure validator and canonicaliser: unknown → a Chord with modifiers de-duplicated and
 *  sorted into `MODS` order, or null if the key or a modifier is not in the catalogue. Used
 *  by both the server route and the client editor. */
export function normChord(v: unknown): Chord | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { mods?: unknown; key?: unknown }
  if (!isBindableKey(o.key)) return null
  const raw = Array.isArray(o.mods) ? o.mods : o.mods == null ? [] : null
  if (raw === null) return null
  const seen = new Set<Mod>()
  for (const m of raw) {
    if (!isMod(m)) return null
    seen.add(m)
  }
  return { mods: MODS.filter(m => seen.has(m)), key: o.key }
}

/** The X11 button a catalogue name means, or null for a real key. */
export function wheelButton(name: string): 4 | 5 | null {
  return BY_NAME.get(name)?.wheel ?? null
}

/** Is this chord the wheel rather than a key? Every caller about to run a chord must ask:
 *  the two take different xdotool verbs. */
export function isWheelChord(c: Chord): boolean {
  return wheelButton(c.key) !== null
}

/** What goes to `xdotool key`: `ctrl+alt+u`, `Page_Up`. Only for key chords: a wheel chord
 *  yields a string xdotool accepts and that sends nothing. Branch on `isWheelChord` first, or
 *  use `chordCommand`. */
export function chordToXdo(c: Chord): string {
  return [...c.mods, c.key].join('+')
}

/** The command a chord becomes, as one display string: `ctrl+u`, `Page_Up`, `click 4`,
 *  `ctrl+click 5`. The editor prints this under each row. */
export function chordCommand(c: Chord): string {
  const b = wheelButton(c.key)
  if (b === null) return chordToXdo(c)
  return [...c.mods, `click ${String(b)}`].join('+')
}

/** The short human spelling (`C-u`, `C-M-Delete`, `PgUp`). Display only. */
export function chordLabel(c: Chord): string {
  const pre = c.mods.map(m => (m === 'ctrl' ? 'C-' : m === 'alt' ? 'M-' : 'S-')).join('')
  return pre + (keyDef(c.key)?.label ?? c.key)
}

export function chordEq(a: Chord, b: Chord): boolean {
  return (
    a.key === b.key && a.mods.length === b.mods.length && a.mods.every((m, i) => m === b.mods[i])
  )
}

// ── what `Submit` presses after the text (`▶ app`'s `submit` row, docs/phone-ui.md) ────────
//
// A closed list of chords, not a set of modifier toggles: the question is which one chord
// commits the line. Toggles would allow combinations that send nothing useful and could not
// express `Tab` or `Ctrl+S`. See docs/decisions/phone-submit-key.md.

/** The picker's `<optgroup>`s, carried in the catalogue so the picker cannot omit an entry. */
export type SubmitGroup = 'off' | 'enter' | 'other'

/** Kept short: a `<select>` is as wide as its widest row, group headings included, and this
 *  one sits in the narrow column beside the text box. */
export const SUBMIT_GROUP_LABEL: Readonly<Record<SubmitGroup, string>> = {
  off: 'press nothing',
  enter: 'the Enter key',
  other: 'other keys',
}

export interface SubmitChord {
  /** `chordToXdo(chord)`, or `off` when there is no chord. Also the `<option>` value and the
   *  stored id. */
  id: string
  /** `null` = type the text and press nothing. */
  chord: Chord | null
  group: SubmitGroup
  /** Where this is the key that commits. Logged on every change, since a phone has no hover. */
  note: string
}

/** What an unconfigured app gets: type the text and press nothing. Of "type it" and "run
 *  it", only the second can be wrong irreversibly. */
export const SUBMIT_DEFAULT: SubmitChord = {
  id: 'off',
  chord: null,
  group: 'off',
  note: 'type only — press nothing, run nothing',
}

/** What breaks a line with nothing configured. A newline has to press something, and
 *  `Return` is what terminals, plain textareas and editors mean by one. Chat boxes, where
 *  `Return` sends, are why the choice is per app. */
export const NEWLINE_DEFAULT: SubmitChord = {
  id: 'Return',
  chord: { mods: [], key: 'Return' },
  group: 'enter',
  note: 'shells, most chat UIs, single-line forms',
}

/** The closed list, in picker order: off, then the Enter family, then the other keys. */
export const SUBMIT_CHORDS: readonly SubmitChord[] = [
  SUBMIT_DEFAULT,
  NEWLINE_DEFAULT,
  {
    id: 'ctrl+Return',
    chord: { mods: ['ctrl'], key: 'Return' },
    group: 'enter',
    note:
      'Gmail, GitHub/GitLab comments, Jira, Slack with Enter=newline, Jupyter run-cell' +
      ' — and the Linux spelling of every site that documents Cmd+Enter',
  },
  {
    id: 'shift+Return',
    chord: { mods: ['shift'], key: 'Return' },
    group: 'enter',
    note: 'a newline in most chat boxes (compose, do not send); Jupyter run-and-advance',
  },
  {
    id: 'alt+Return',
    chord: { mods: ['alt'], key: 'Return' },
    group: 'enter',
    note: 'Jupyter run-and-insert-below; rare as a send key elsewhere',
  },
  {
    id: 'Tab',
    chord: { mods: [], key: 'Tab' },
    group: 'other',
    note: 'the next field — fill a login form one injection at a time',
  },
  // These two are harmful in the wrong window, which is why the note is logged when one is picked.
  {
    id: 'ctrl+s',
    chord: { mods: ['ctrl'], key: 's' },
    group: 'other',
    note: 'save — editors and wikis. In a terminal it is XOFF and freezes the output (ctrl+q resumes)',
  },
  {
    id: 'ctrl+d',
    chord: { mods: ['ctrl'], key: 'd' },
    group: 'other',
    note: 'EOF — a terminal reading stdin (`cat > file`, a heredoc). At a bare prompt it logs out',
  },
]

const SUBMIT_BY_ID: ReadonlyMap<string, SubmitChord> = new Map(SUBMIT_CHORDS.map(s => [s.id, s]))

/** The list entry for an id, or null when it is not in the list. */
export function submitChordById(id: string): SubmitChord | null {
  return SUBMIT_BY_ID.get(id) ?? null
}

/** What may break a line: the Enter family only. `Tab`, `C-s`, `C-d` and `off` are not line
 *  breaks. */
export const NEWLINE_CHORDS: readonly SubmitChord[] = SUBMIT_CHORDS.filter(s => s.group === 'enter')

/** The list entry for a stored newline id, or null: `submitChordById` narrowed to
 *  `NEWLINE_CHORDS`. The server gates bindings.json with it. */
export function newlineChordById(id: string): SubmitChord | null {
  const s = submitChordById(id)
  return s && s.group === 'enter' ? s : null
}

/** The picker's row text: `Enter`, `C-Enter`, `Tab`, `off`. Uses `chordLabel`, so the swipe
 *  editor, the log and this picker name a chord the same way. */
export function submitChordLabel(s: SubmitChord): string {
  return s.chord ? chordLabel(s.chord) : 'off'
}

// ── fontsize: what `font −` / `font +` press, per app (docs/phone-ui.md) ──────────────────
//
// The app draws its own text, so "bigger" means asking the focused app to zoom, and every app
// spells that differently. The pair is a per-app setting (`AppBinding.fontsize`) chosen from
// this closed list. Each direction is a short sequence of `/api/desktop/input` injections, so it
// can express a prefix (Emacs) and a wheel (Ctrl+scroll). Nothing maps an app to an entry
// automatically. Only `shift+KP` (xterm) is verified; the other notes are documented defaults.

/** One injection, in `POST /api/desktop/input`'s vocabulary. */
export interface FontInject {
  kind: 'key' | 'keydown' | 'keyup' | 'click'
  arg: string
}

export interface FontStep {
  /** The stored id (`AppBinding.fontsize`) and the `<option>` value. */
  id: string
  /** The picker's row; kept short. */
  label: string
  bigger: readonly FontInject[]
  smaller: readonly FontInject[]
  /** Where this is the zoom key. Shown under the row. */
  note: string
}

const k = (arg: string): FontInject => ({ kind: 'key', arg })

/** Hold Ctrl across one wheel click. `keydown`/`keyup` because xdotool's mouse verbs take no
 *  modifier; the client owns the `keyup` even when the click fails. */
function ctrlWheel(button: '4' | '5'): FontInject[] {
  return [
    { kind: 'keydown', arg: 'ctrl' },
    { kind: 'click', arg: button },
    { kind: 'keyup', arg: 'ctrl' },
  ]
}

/** What an unconfigured app gets: xterm's pair. An app with no binding on it ignores it or,
 *  at worst, types a `+`. */
export const FONTSIZE_DEFAULT: FontStep = {
  id: 'shift+KP',
  label: 'S-KP+ / S-KP−',
  bigger: [k('shift+KP_Add')],
  smaller: [k('shift+KP_Subtract')],
  note: 'xterm (larger/smaller-vt-font — nothing reaches the shell)',
}

export const FONTSIZE_STEPS: readonly FontStep[] = [
  FONTSIZE_DEFAULT,
  {
    id: 'ctrl+equal',
    label: 'C-= / C--',
    bigger: [k('ctrl+equal')],
    smaller: [k('ctrl+minus')],
    note: 'Firefox, Chromium, VS Code and other Electron apps, Alacritty, WezTerm',
  },
  {
    // `plus`, not `shift+equal`: xdotool finds the key that makes `+` on the active keymap and
    // adds Shift itself, so this is right on a JIS layout too.
    id: 'ctrl+plus',
    label: 'C-+ / C--',
    bigger: [k('ctrl+plus')],
    smaller: [k('ctrl+minus')],
    note: 'apps that document "Ctrl++": GNOME Terminal, Konsole, xfce4-terminal, Tilix, Evince',
  },
  {
    id: 'ctrl+shift+equal',
    label: 'C-S-= / C-S--',
    bigger: [k('ctrl+shift+equal')],
    smaller: [k('ctrl+shift+minus')],
    note: 'kitty',
  },
  {
    id: 'ctrl+shift+Page',
    label: 'C-S-PgUp / C-S-PgDn',
    bigger: [k('ctrl+shift+Prior')],
    smaller: [k('ctrl+shift+Next')],
    note: 'st (suckless)',
  },
  {
    // Two injections, because `C-x` is a prefix: one `xdotool key` per chord, in order.
    id: 'emacs',
    label: 'C-x C-= / C-x C--',
    bigger: [k('ctrl+x'), k('ctrl+equal')],
    smaller: [k('ctrl+x'), k('ctrl+minus')],
    note: 'Emacs text-scale-adjust — the current buffer only',
  },
  {
    id: 'ctrl+wheel',
    label: 'C-wheel',
    bigger: ctrlWheel('4'),
    smaller: ctrlWheel('5'),
    note:
      'most GUI apps, LibreOffice included — but it goes to the window under the pointer,' +
      ' not the focused one',
  },
]

const FONTSIZE_BY_ID: ReadonlyMap<string, FontStep> = new Map(FONTSIZE_STEPS.map(s => [s.id, s]))

/** The list entry for a stored id, or null. */
export function fontStepById(id: string): FontStep | null {
  return FONTSIZE_BY_ID.get(id) ?? null
}

/** A sequence joined for a log line or a preview: `ctrl+x ctrl+equal`. */
export function fontInjectLabel(seq: readonly FontInject[]): string {
  return seq.map(i => (i.kind === 'key' ? i.arg : `${i.kind}:${i.arg}`)).join(' ')
}
