// even-window — first-use hints: short, self-retiring pointers to things a first-time user
// cannot discover by looking. Each hint is shown a few times per device and then never again;
// the count lives in localStorage, so a browser that refuses storage just keeps showing them.
//
// Two hints exist:
//   * `startup` — on the lens, once the page is established: the gestures that open everything
//     else (the mirror itself carries no hint, so the double-tap menu is otherwise invisible).
//   * `submit-off` — on the phone, after a Submit to an app whose submit key is `off`: the text
//     was typed but nothing ran, which reads as "Submit is broken" until the setting is found.
//
// Nearly a leaf: it imports only the storage helper, so anything may call it.

import { keep } from './durableKv.ts'

/** How many times each hint is shown on a device before it retires. More than one, because the
 *  first showing is easily missed: the glasses may not be worn yet when the app first starts. */
export const HINT_SHOWS = 3

/** How long the startup hint stays on the lens unless a gesture closes it first. */
export const STARTUP_HINT_MS = 8000

export type HintId = 'startup' | 'submit-off'

const storeKey = (id: HintId): string => `ew.hint.${id}`

/** Pure: should a hint already shown `shown` times be shown again? */
export function hintDue(shown: number, max = HINT_SHOWS): boolean {
  return shown < max
}

/** Read-and-count: true when the hint is due, and the showing is recorded. Storage failures
 *  count as "never shown": a hint too many beats a user left without one. */
export function takeHint(id: HintId): boolean {
  let shown = 0
  try {
    const n = Number.parseInt(localStorage.getItem(storeKey(id)) ?? '0', 10)
    if (Number.isFinite(n) && n > 0) shown = n
  } catch {
    // no storage: treat as unseen
  }
  if (!hintDue(shown)) return false
  keep(storeKey(id), String(shown + 1))
  return true
}

/** Retire a hint early: the user has shown they know what it would say. */
export function retireHint(id: HintId): void {
  keep(storeKey(id), String(HINT_SHOWS))
}

/** Pure: the lens text of the startup hint. Lines stay well under the panel's width
 *  (`LINE_UNITS`), so the firmware never folds one. No space-aligned columns: the
 *  lens font is proportional, so each row is `gesture: effect` instead. The voice row appears
 *  only when the server has a recogniser, because a long press does nothing otherwise. */
export function startupHintText(voice: boolean): string {
  return [
    'even-window — gestures (ring or temple)',
    '- double-tap: menu (windows, apps, keys)',
    '- swipe: Up / Down keys to the window',
    '- tap: Enter',
    ...(voice ? ['- long press: voice input'] : []),
    '',
    'any gesture closes this',
  ].join('\n')
}

/** Pure: the phone toast after a Submit that typed without pressing a key. */
export function submitOffHintText(): string {
  return "Typed only — this app's submit key is off. Set Enter (or another key) in ▶ app below."
}
