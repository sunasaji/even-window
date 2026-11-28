// pinhole-window — first-use hints: short, self-retiring pointers to things a first-time user
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
    'pinhole-window — gestures (ring or temple)',
    '- double-tap: menu (windows, apps, keys)',
    '- swipe: Up / Down keys to the window',
    '- tap: Enter',
    ...(voice ? ['- long press: voice input'] : []),
    '',
    'any gesture closes this',
  ].join('\n')
}

/** What stands between this device and a mirror, or null when nothing does. `guess` is
 *  `serverIsGuess`: the address in use is the built-in default, not one a person gave. */
export type SetupNotice = 'pair' | 'address' | 'unreachable'

export function setupNoticeKind(auth: string, guess: boolean): SetupNotice | null {
  if (auth === 'unpaired' || auth === 'unauthorized') return 'pair'
  if (auth === 'offline') return guess ? 'address' : 'unreachable'
  return null
}

/** Pure: the lens text while the app cannot reach or use a server. The glasses would otherwise
 *  be black with nothing to act on, so it says where the fix is (the phone) and the short form
 *  of it. It stays until the state clears; no gesture closes it, the menu still opens over it.
 *  `server` is shortened because a tailnet address is wider than a line. */
export function setupNoticeText(kind: SetupNotice, server: string): string {
  const last = 'double-tap: menu (Exit is in it)'
  if (kind === 'pair')
    return [
      'pinhole-window — pair this phone',
      '1. PC: start the server (npm run server)',
      '2. PC: node scripts/ew-auth.mjs pair URL',
      '    URL = how the phone reaches the PC',
      '3. Phone: scan the QR code it prints,',
      '    tap Copy on the page that opens,',
      '    paste into the pair dialog in this app',
      '',
      last,
    ].join('\n')
  if (kind === 'address')
    return [
      'pinhole-window — set the server address',
      'Use the card on the phone.',
      '- paired before: enter the server URL',
      '- first time, on the PC:',
      '    node scripts/ew-auth.mjs pair URL',
      '    scan its QR code, tap Copy, paste here',
      '',
      last,
    ].join('\n')
  return [
    'pinhole-window — server unreachable',
    shortServer(server),
    '- is the server running on the PC?',
    '- is the phone on the same network / VPN?',
    'To change the address: phone, connection',
    '',
    last,
  ].join('\n')
}

/** Host and port only, cut to a width the panel does not fold. */
function shortServer(server: string): string {
  const s = server.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return s.length > 38 ? `${s.slice(0, 37)}…` : s
}

/** Pure: the phone toast after a Submit that typed without pressing a key. */
export function submitOffHintText(): string {
  return "Typed only — this app's submit key is off. Set Enter (or another key) in ▶ app below."
}
