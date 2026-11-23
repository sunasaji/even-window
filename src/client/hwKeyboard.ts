// even-window — a hardware keyboard attached to the phone.
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import { log } from './debugLog.ts'
import { x11Inject } from './gestures.ts'
import { charKeysym, modPrefix } from './oskb.ts'
import { paletteEl } from './palette.ts'

// The hardware keyboard path (docs/phone-ui.md, docs/decisions/phone-hardware-keyboard.md).
//
// A plain capture-phase listener on `document`: on iOS, hardware characters arrive with nothing
// focused, so there is no hidden `<input>` (which would cost the shortcut bar and can summon the
// soft keyboard). Tab is eaten by focus navigation unless cancelled, so a handled key is
// cancelled. The arrow keys never arrive on iOS; `KBD_NAMED` spells them for other devices.
//
// There is no mode. The gate is `kbdShouldHandle`: keys go to the nested X unless one of this
// app's own controls has focus, so where the caret is decides where typing goes. A hidden page
// receives no key events, and the real boundary is auth (docs/security.md).
//
// The cost: Tab and space are consumed whenever no field has focus, so this page cannot be
// keyboard-navigated while a hardware keyboard is attached.
/** `KeyboardEvent.key` → the xdotool spelling, for keys that are not a single character.
 *
 *  Separate from the server's `keyNameToChord`, which translates the tmux-style names the gesture
 *  bindings use (`Enter`, `BSpace`, `PPage`). The names here are the DOM's (`Backspace`,
 *  `PageUp`), which overlap with those only partly. */
const KBD_NAMED: Readonly<Record<string, string>> = {
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
  Insert: 'Insert',
}

/** Modifier keys pressed alone. They are the prefix of the next keystroke, and injecting them
 *  would hold nothing (`key` clears modifiers; src/server/input.ts). */
const KBD_BARE_MODS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'])

/** Controls whose own typing must never be hijacked. The rule is the tag, not an allow-list of
 *  elements, so a control added later is protected automatically. */
const KBD_EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** Keys that are dropped while one of this app's fields has focus: neither injected nor acted
 *  on. Tab inside a text box would move focus to a button, and the next keystrokes would then
 *  go to the nested X. The way out of a field is to tap elsewhere. */
const KBD_SWALLOW_IN_FIELD = new Set(['Tab'])

/** Should this key be dropped because a field has focus and the key would move focus off it? */
export function kbdSwallowInField(key: string): boolean {
  return KBD_SWALLOW_IN_FIELD.has(key)
}

export interface HwKey {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export type KbdPlan = { kind: 'type' | 'key'; arg: string }

/** The pure core: one hardware key → what to inject, or `null` to ignore it.
 *
 *  A bare character is text (`type`); a character under Ctrl/Alt is a chord whose name must be
 *  the X keysym, not the glyph (`ctrl+minus`, never `ctrl+-`), hence `charKeysym`.
 *
 *  Shift is not added to a character, because the platform already applied it: shift+2 arrives
 *  as `"@"`. It is added to a named key, where the glyph never changes (`shift+Tab`). */
export function hwKeyPlan(e: HwKey): KbdPlan | null {
  if (e.key === '' || e.key === 'Unidentified' || KBD_BARE_MODS.has(e.key)) return null
  const mods = (e.ctrlKey ? ['ctrl'] : [])
    .concat(e.altKey ? ['alt'] : [])
    .concat(e.metaKey ? ['super'] : [])
  const named = KBD_NAMED[e.key]
  if (named !== undefined) {
    return { kind: 'key', arg: modPrefix(e.shiftKey ? [...mods, 'shift'] : mods) + named }
  }
  if (Array.from(e.key).length !== 1) {
    // F1-F12: xdotool takes the name as-is. Any other multi-character key is ignored.
    return /^F\d{1,2}$/.test(e.key) ? { kind: 'key', arg: modPrefix(mods) + e.key } : null
  }
  if (mods.length === 0) return { kind: 'type', arg: e.key }
  return { kind: 'key', arg: modPrefix(mods) + charKeysym(e.key) }
}

/** Should this keystroke go to the nested X? Pure, because this is the entire policy.
 *
 *  `editable` is `isContentEditable`, which the tag test cannot see: a `contenteditable` element
 *  is a `<div>` as far as `tagName` is concerned. */
export function kbdShouldHandle(
  focusTag: string,
  editable: boolean,
  paletteOpen: boolean,
): boolean {
  return !paletteOpen && !editable && !KBD_EDITABLE.has(focusTag)
}

/** What `Enter` means inside this app's text box (docs/decisions/phone-submit-key.md).
 *
 *  A bare `Enter` breaks the line, as do `Shift+Enter` and `Alt+Enter`; the box sends its
 *  newlines through as the app's own line break. `Ctrl+Enter` (or `⌘+Enter`) submits, so a
 *  hardware keyboard can send without a tap on the screen.
 *
 *  The IME guard is required: the `Enter` that commits a conversion candidate is not a line
 *  break. `isComposing` is the standard signal and `keyCode === 229` the legacy one some IMEs
 *  produce instead; both are honoured. */
export type EnterAction = 'submit' | 'newline' | 'pass'

export function fieldEnterAction(e: {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing: boolean
  keyCode: number
}): EnterAction {
  if (e.key !== 'Enter') return 'pass'
  if (e.isComposing || e.keyCode === 229) return 'pass' // the IME owns this one
  // `metaKey` too: a Mac keyboard paired with the phone spells this chord ⌘↩.
  if (e.ctrlKey === true || e.metaKey === true) return 'submit'
  return 'newline'
}

/** Should a tap somewhere else take the focus off the field that is holding it?
 *
 *  WebKit on iOS only moves focus when a tap lands on something focusable, and plain buttons
 *  and the canvas are not, so without this the caret stays in the field and keeps the keys.
 *
 *  Shares one definition of "a field" with `kbdShouldHandle`, so "the keys go where the caret
 *  is, and a tap moves the caret" holds everywhere. */
export function tapDropsFocus(focusTag: string, editable: boolean, insideField: boolean): boolean {
  if (insideField) return false
  return editable || KBD_EDITABLE.has(focusTag)
}

/** Serialises hardware keystrokes and batches them by the round trip itself.
 *
 *  Order: a typist is faster than a round trip, and concurrent `fetch`es have no ordering
 *  guarantee, so everything goes through one chain.
 *
 *  Throughput: there is no coalescing window. A flush is queued, and when it reaches the head
 *  of the chain it takes whatever has accumulated: nothing extra on a fast link, a whole burst
 *  on a slow one.
 *
 *  A chord closes the buffer synchronously. Otherwise a character typed after `ctrl+c` but
 *  before the pending flush ran would be injected before the chord.
 *
 *  `send` is injected so this is testable without a server (tests/client.hwinput.test.ts). */
export class KeyBatcher {
  private buf = ''
  private chain: Promise<unknown> = Promise.resolve()
  /** Identity of the one flush allowed to drain the buffer, or null when none is pending.
   *
   *  A token rather than a boolean: after `char('a')` (in flight), `char('x')`, `chord('ctrl+c')`,
   *  `char('b')`, the flush queued for `x` is still ahead of the chord in the chain and would
   *  take `b` with it. Superseding by identity makes that stale flush a no-op. */
  private flushTask: object | null = null

  constructor(private readonly send: (kind: 'type' | 'key', arg: string) => Promise<unknown>) {}

  /** Characters not yet handed to `send` (test/diagnostic accessor). */
  pending(): string {
    return this.buf
  }

  /** One printable character. */
  char(ch: string): void {
    this.buf += ch
    if (this.flushTask) return // the pending flush will take this one too
    const me = {}
    this.flushTask = me
    this.chain = this.chain
      .then(() => {
        if (this.flushTask !== me) return undefined // superseded by a chord
        this.flushTask = null
        const s = this.take()
        return s === '' ? undefined : this.send('type', s)
      })
      .catch(() => {
        if (this.flushTask === me) this.flushTask = null
      })
  }

  /** One key or chord (`Return`, `ctrl+c`). Takes the buffered text with it, in order. */
  chord(arg: string): void {
    this.flushNow()
    this.chain = this.chain
      .then(() => this.send('key', arg))
      .catch(() => {
        /* logged inside */
      })
  }

  /** Hand over anything buffered right now (the page is going away, or a chord needs to pass).
   *  Supersedes any pending flush: after this call the buffer belongs to whatever is queued
   *  next, never to a task queued before it. */
  flushNow(): void {
    this.flushTask = null
    const s = this.take()
    if (s === '') return
    this.chain = this.chain
      .then(() => this.send('type', s))
      .catch(() => {
        /* logged inside */
      })
  }

  private take(): string {
    const s = this.buf
    this.buf = ''
    return s
  }
}

const kbdBatcher = new KeyBatcher((kind, arg) => x11Inject(kind, arg, arg))

/** The gate's rule is logged once, the first time a hardware key is injected. It is the only
 *  place the page says what it does with the keyboard, including that Tab is consumed. */
let kbdAnnounced = false
/** Logged once: where a tap sends the keyboard. */
let kbdBlurAnnounced = false

/** Installed once, at mount. Capture phase, so a key this app's own widgets would consume is
 *  still seen and the gate decides. */
export function wireHardwareKeyboard(): void {
  document.addEventListener(
    'keydown',
    e => {
      const el = document.activeElement
      const tag = el ? el.tagName : 'none'
      const editable = el instanceof HTMLElement && el.isContentEditable
      if (!kbdShouldHandle(tag, editable, paletteEl !== null)) {
        // A field has focus, so the keystroke is the field's, except for the ones that would
        // take the focus away from it (`kbdSwallowInField`). Those are cancelled and go nowhere.
        if (kbdSwallowInField(e.key)) e.preventDefault()
        return
      }
      const plan = hwKeyPlan(e)
      if (!plan) return
      if (!kbdAnnounced) {
        kbdAnnounced = true
        log(
          'kbd: hardware keys go to the window whenever no field here has focus' +
            ' — including Tab and space, which this page therefore cannot use' +
            ' (focus a text field to type into the phone instead)',
        )
      }
      // Cancelled because it was consumed: otherwise Tab walks the focus ring through this page's
      // buttons and space scrolls the column.
      e.preventDefault()
      if (plan.kind === 'type') {
        kbdBatcher.char(plan.arg)
        return
      }
      kbdBatcher.chord(plan.arg) // takes the text typed before it, in order
    },
    true,
  )

  // A tap outside the field gives the keyboard back to the X.
  //
  // On `pointerup`, not `pointerdown`: a blur dismisses the soft keyboard and re-lays out the
  // column, which would move a button from under the thumb pressing it. By `pointerup` the
  // browser has fixed which element the click belongs to.
  //
  // Capture phase, so an overlay that cancels the event (vPad's touch gate) cannot stop the
  // focus from being returned.
  document.addEventListener(
    'pointerup',
    e => {
      const el = document.activeElement
      if (!(el instanceof HTMLElement)) return
      const inside = e.target instanceof Node && (e.target === el || el.contains(e.target))
      if (!tapDropsFocus(el.tagName, el.isContentEditable, inside)) return
      el.blur()
      if (kbdBlurAnnounced) return
      kbdBlurAnnounced = true
      log('kbd: a tap outside a field drops its focus, so the keys go back to the window')
    },
    true,
  )

  // The coalescing buffer must not be carried across a backgrounding: a page that comes back
  // later would otherwise deliver the tail of a sentence typed before it was hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') kbdBatcher.flushNow()
  })
}
