// Input injection into the nested X server via xdotool (the X11 backend's `InputInjector`).
//
// One `spawn` per event keeps every injection independent, so a wedged xdotool cannot block
// the next gesture. Pointer coordinates are clamped to the 576x288 screen (shared/geom.ts): an
// out-of-range position would move the pointer onto the host screen edge and silently drop
// the click.

import { SCREEN_H, SCREEN_W } from '../../../shared/geom.ts'
import { ratpoisonArgs } from '../../../shared/glassMenu.ts'
import { run } from './xenv.ts'

/** xdotool's inter-key delay for a string containing non-ASCII characters. Such a character
 *  has no keycode, so xdotool remaps a scratch keycode before each press and the application
 *  must observe the MappingNotify first. The default 12 ms drops characters; 40 ms was lossless
 *  in 8/8 runs. It is a margin for a load-dependent race, not a threshold: raise it if
 *  characters go missing. ASCII text keeps the default delay. */
export const TYPE_DELAY_NON_ASCII_MS = 40

/** `--delay N` when the string needs it, nothing when it does not. */
export function typeDelay(arg: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is the point
  return /[^\x00-\x7f]/.test(arg) ? ['--delay', String(TYPE_DELAY_NON_ASCII_MS)] : []
}

/** Mouse buttons xdotool understands: 1=left 2=middle 3=right 4=wheel-up 5=wheel-down. */
function button(arg: string | undefined): string {
  return arg != null && /^[1-5]$/.test(arg) ? arg : '1'
}

/** Clamp one "x" or "y" field of a coordinate string into [0, max]. Garbage → 0. */
function coord(v: string | undefined, max: number): string {
  return String(Math.max(0, Math.min(max, Math.round(Number(v)) || 0)))
}

/** Pure: (kind, arg) → the xdotool argv, or null for an unknown kind. */
export function xdoArgs(kind: string, arg: string): string[] | null {
  if (kind === 'click') return ['click', button(arg)]
  // One xdotool invocation for a double-click: its own --delay is far more reliable than
  // two separate spawns, whose scheduling jitter routinely exceeds the double-click window.
  if (kind === 'dblclick') return ['click', '--repeat', '2', '--delay', '120', button(arg)]
  if (kind === 'key') return ['key', '--clearmodifiers', arg] // e.g. Return, ctrl+c
  if (kind === 'type') return ['type', '--clearmodifiers', ...typeDelay(arg), '--', arg]
  // Held modifiers: the two kinds that must not carry `--clearmodifiers`, which would release
  // the modifier the sequence is holding. `keydown ctrl` → `mousedown 1` → `mouseup 1` →
  // `keyup ctrl` is ctrl+press-and-hold, which xdotool's mouse verbs cannot express alone. The
  // caller owns the matching `keyup`; a lost one leaves the modifier down for every later key.
  if (kind === 'keydown') return ['keydown', arg]
  if (kind === 'keyup') return ['keyup', arg]
  if (kind === 'move') {
    // "x,y" → move the pointer, no click. The client composites the cursor itself (capture
    // runs with -draw_mouse 0, docs/platform.md) and streams absolute positions.
    const [xs, ys] = arg.split(',')
    return ['mousemove', coord(xs, SCREEN_W), coord(ys, SCREEN_H)]
  }
  // Press / release at the current pointer position (set by a prior `move`): with `move` this
  // gives a press-drag-release, i.e. range-select and drag-and-drop.
  if (kind === 'down') return ['mousedown', button(arg)]
  if (kind === 'up') return ['mouseup', button(arg)]
  if (kind === 'clickat') {
    // "x,y[,button]" → move and click in one invocation, so nothing can move the pointer in
    // between (a separate move+click races any other injection).
    const [xs, ys, bs] = arg.split(',')
    return ['mousemove', coord(xs, SCREEN_W), coord(ys, SCREEN_H), 'click', button(bs)]
  }
  return null
}

/** Inject one event into the nested X. Resolves false on an unknown kind, a missing xdotool or
 *  a non-zero exit; never rejects. Goes through xenv.run for the display env and its timeout,
 *  so an xdotool blocked on a wedged X connection cannot pin the gesture path open. */
export async function x11Input(kind: string, arg: string): Promise<boolean> {
  const args = xdoArgs(kind, arg)
  if (!args) return false
  const { code } = await run('xdotool', args, 2000)
  return code === 0
}

/** Send the ratpoison prefix followed by one catalogue key, as keystrokes, so the WM's
 *  interactive surfaces (`C-t ?` help) appear on the nested X; `ratpoison -c help` prints
 *  instead. One xdotool invocation for both keysequences: two spawns race through the prefix
 *  grab. `--clearmodifiers` matters because a held Shift turns `C-t k` (close) into `C-t K`
 *  (destroy). Refuses anything outside the closed catalogue (src/shared/glassMenu.ts). */
export async function x11RatpoisonKey(key: unknown): Promise<boolean> {
  const seq = typeof key === 'string' ? ratpoisonArgs(key) : null
  if (!seq) return false
  const { code } = await run('xdotool', ['key', '--clearmodifiers', ...seq], 2000)
  return code === 0
}

/** Send `n` wheel notches (X11 buttons 4 / 5), optionally under held modifiers. A wheel is a
 *  pointer button, so it goes to the window under the pointer, not the focused one. Modifiers
 *  are held with `keydown`/`keyup` around the whole burst and the release is unconditional: a
 *  modifier left down in the nested X corrupts every later keystroke. */
export async function x11Wheel(
  button: 4 | 5,
  n: number,
  mods: readonly string[] = [],
): Promise<boolean> {
  let ok = true
  for (const m of mods) if (!(await x11Input('keydown', m))) ok = false
  try {
    for (let i = 0; i < Math.max(1, n); i++) {
      if (!(await x11Input('click', String(button)))) ok = false
    }
  } finally {
    // Reverse order, and every release is attempted even if one fails.
    for (const m of [...mods].reverse()) if (!(await x11Input('keyup', m))) ok = false
  }
  return ok
}

/** Send `key` `n` times, sequentially (a move-N swipe burst, docs/glasses.md). Serial because
 *  the target app must observe N discrete keystrokes in order; parallel xdotool invocations
 *  interleave and the app sees fewer. Resolves false if any send failed. */
export async function x11InputRepeat(key: string, n: number): Promise<boolean> {
  let ok = true
  for (let i = 0; i < Math.max(1, n); i++) {
    if (!(await x11Input('key', key))) ok = false
  }
  return ok
}
