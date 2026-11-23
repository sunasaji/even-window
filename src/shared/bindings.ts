// What the UI remembers per application: which key a swipe sends, which key `Submit` presses
// after the text, what a line break becomes and what the font buttons press
// (docs/glasses.md, docs/phone-ui.md).
//
// A window offers up to five identities, tried most specific first (`appKeys`):
//   app:<LauncherEntry.id>  launched by this server; lives in server memory only
//   exe:<path>         /proc/<pid>/exe, or an absolute argv[0] from WM_COMMAND
//   comm:<name>        /proc/<pid>/comm; readable where the exe symlink is not
//   cls:<res_class>    WM_CLASS; needs no pid
//   title:<name>       only when no durable identity exists, because apps rewrite titles
// Window ids and window-manager numbers are not identities: neither survives a restart of
// the app. See docs/decisions/window-identity-without-stamping.md.

import type { Chord } from './keys.ts'
import {
  chordEq,
  chordLabel,
  FONTSIZE_DEFAULT,
  fontStepById,
  NEWLINE_DEFAULT,
  newlineChordById,
  normChord,
  SUBMIT_DEFAULT,
  submitChordById,
} from './keys.ts'

/** Everything remembered for one app identity. New per-app settings are added as optional
 *  fields, so the stored shape needs no migration. */
export interface AppBinding {
  up: Chord
  down: Chord
  /** A `SUBMIT_CHORDS` id (`Return`, `ctrl+Return`, `off`), or absent to inherit.
   *  An id, not a `Chord`, so bindings.json can only name a chord from the closed list in
   *  keys.ts. Absent ("no opinion, keep looking") and `'off'` ("type without running") differ. */
  submit?: string
  /** A `NEWLINE_CHORDS` id (`Return`, `shift+Return`, …), or absent to inherit: the keystroke
   *  a line break in the text box becomes. It is per app because `Return` breaks a line in a
   *  terminal but sends in a chat box. Only the Enter family is allowed. */
  newline?: string
  /** A `FONTSIZE_STEPS` id (`shift+KP`, `ctrl+equal`, `emacs`, …), or absent to inherit:
   *  what `font −` / `font +` press in this app. */
  fontsize?: string
}

/** `"*"` → the fallback for every app; `"comm:xterm"` / `"cls:firefox"` → one app. */
export type BindingMap = Record<string, AppBinding>

/** The key that matches anything. */
export const DEFAULT_BINDING_KEY = '*'

/** What a swipe does with nothing configured. */
export const DEFAULT_SWIPE: AppBinding = {
  up: { mods: [], key: 'Up' },
  down: { mods: [], key: 'Down' },
}

/** comm names that identify a runtime, not an application: a `comm:` binding on one would
 *  apply to every app of that family. `preferredKey` defaults to WM_CLASS for these; nothing
 *  is forbidden. */
export const WRAPPER_COMMS: readonly string[] = [
  'electron',
  'java',
  'javaw',
  'mono',
  'dotnet',
  'node',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'sh',
  'bash',
  'dash',
  'zsh',
  'env',
  'wine',
  'wine64',
  'wine-preloader',
  'flatpak',
  'snap',
  'bwrap',
  'appimage',
]

/** The parts of a window this module needs. `WinInfo` satisfies it; tests pass literals. */
export interface AppIdentity {
  /** `LauncherEntry.id`, when this window was attributed to a launch the server made. */
  appId?: string
  /** `/proc/<pid>/exe`, or an absolute argv[0] from WM_COMMAND. */
  exe?: string
  /** `/proc/<pid>/comm`. Named `app` to match `WinInfo`. */
  app?: string
  /** WM_CLASS (resource class). */
  cls?: string
  /** WM_NAME. Used only when no durable identity resolved (see `appKeys`). */
  title?: string
}

/** Fold a name fragment into its key spelling: lowercase, trimmed, anything outside
 *  `[a-z0-9._+-]` collapsed to `-`, capped at 64 chars. Sanitised rather than rejected so an
 *  app with an odd WM_CLASS stays bindable. */
function ident(v: string | undefined): string {
  if (!v) return ''
  return v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** A filesystem path. Not folded by `ident`: case and `/` distinguish binaries. Only an
 *  absolute path is an identity; a bare name says no more than comm does. */
function pathIdent(v: string | undefined): string {
  if (!v) return ''
  const s = v.trim()
  if (!s.startsWith('/')) return ''
  return s.replace(/[^A-Za-z0-9._+/-]+/g, '-').slice(0, 160)
}

/** `LauncherEntry.id` verbatim (`desktop:com.gexperts.Tilix`): the UI resolves it back to a
 *  display name, so mixed case and the inner `:` are preserved. */
function appIdent(v: string | undefined): string {
  if (!v) return ''
  const s = v.trim()
  return /^[A-Za-z0-9._:+-]{1,96}$/.test(s) ? s : ''
}

/** A window title: lowercased and whitespace-collapsed, with only control characters
 *  removed. Not reduced to `[a-z0-9]`, which would collapse every CJK title into one key. */
function titleIdent(v: string | undefined): string {
  if (!v) return ''
  return (
    v
      .trim()
      .toLowerCase()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters
      .replace(/[\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 64)
      .trim()
  )
}

export function commKey(comm: string | undefined): string {
  const s = ident(comm)
  return s ? `comm:${s}` : ''
}

export function clsKey(cls: string | undefined): string {
  const s = ident(cls)
  return s ? `cls:${s}` : ''
}

export function exeKey(exe: string | undefined): string {
  const s = pathIdent(exe)
  return s ? `exe:${s}` : ''
}

export function appEntryKey(appId: string | undefined): string {
  const s = appIdent(appId)
  return s ? `app:${s}` : ''
}

export function titleKey(title: string | undefined): string {
  const s = titleIdent(title)
  return s ? `title:${s}` : ''
}

/** Is `s` a key this map may contain? The server checks before writing, so bindings.json
 *  never holds an unmatchable key. */
export function isBindingKey(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (s === DEFAULT_BINDING_KEY) return true
  if (/^(?:comm|cls):[a-z0-9._+-]{1,64}$/.test(s)) return true
  if (/^app:[A-Za-z0-9._:+-]{1,96}$/.test(s)) return true
  if (/^exe:\/[A-Za-z0-9._+/-]{0,159}$/.test(s)) return true
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters
  if (/^title:[^\u0000-\u001f]{1,64}$/.test(s)) return true
  return false
}

/** The resolution order as candidate keys, most specific first and `"*"` last. Every key
 *  that can be stored must be reachable here; the UI also shows this list. */
export function appKeys(w: AppIdentity | null): string[] {
  const out: string[] = []
  if (w) {
    // Durable identities are read back off the process or the window, so they survive a restart.
    const durable = [exeKey(w.exe), commKey(w.app), clsKey(w.cls)].filter(k => k !== '')
    const app = appEntryKey(w.appId)
    if (app) out.push(app)
    out.push(...durable)
    // A title is a candidate only when no durable identity exists: apps rewrite titles, so a
    // `title:` binding would otherwise go dead while still listed. `app:` does not suppress
    // it, because launch attribution lives in server memory and is lost on restart.
    if (durable.length === 0) {
      const t = titleKey(w.title)
      if (t) out.push(t)
    }
    // Both `comm:` and `cls:` are offered even when they spell the same word (Firefox reports
    // `firefox` for both): skipping one would make a stored key unreachable. Not offering the
    // same app twice is the editor's concern (`preferredKey`).
  }
  out.push(DEFAULT_BINDING_KEY)
  return out
}

/** The key the editor selects by default; every candidate stays available (`appKeys`).
 *  `exe:` is preferred over `app:` because it also matches the program started outside the
 *  launcher. For a wrapper comm (`WRAPPER_COMMS`) the exe is often the runtime too, so
 *  WM_CLASS wins. '' when the window has no identity at all. */
export function preferredKey(w: AppIdentity | null): string {
  if (!w) return ''
  const comm = ident(w.app)
  const wrapped = comm !== '' && WRAPPER_COMMS.includes(comm)
  if (wrapped) {
    const cls = clsKey(w.cls)
    if (cls) return cls
  }
  const order = wrapped
    ? [appEntryKey(w.appId), commKey(w.app), exeKey(w.exe)]
    : [exeKey(w.exe), appEntryKey(w.appId), commKey(w.app), clsKey(w.cls)]
  for (const k of order) if (k) return k
  return appKeys(w).find(k => k !== DEFAULT_BINDING_KEY) ?? ''
}

export type BindingKeyKind = 'app' | 'exe' | 'comm' | 'cls' | 'title' | 'default'

/** Which kind a stored key is. `'default'` for `"*"`; `'cls'` for anything unrecognised, to
 *  keep this total. */
export function keyKind(k: string): BindingKeyKind {
  if (k === DEFAULT_BINDING_KEY) return 'default'
  const kind = k.slice(0, k.indexOf(':'))
  return kind === 'app' || kind === 'exe' || kind === 'comm' || kind === 'title' ? kind : 'cls'
}

/** What each kind means, for the editor's pulldown. */
export const KEY_KIND_LABEL: Readonly<Record<BindingKeyKind, string>> = {
  app: 'as launched (this launcher entry only)',
  exe: 'binary',
  comm: 'process name',
  cls: 'window class',
  title: 'title — apps rewrite these',
  default: 'every app',
}

/** Does resolving a swipe require knowing which window has focus? With an empty map, or one
 *  holding only `"*"`, every window resolves the same way and the focus query is skipped. */
export function needsWindow(map: BindingMap): boolean {
  return Object.keys(map).some(k => k !== DEFAULT_BINDING_KEY)
}

/** Pure lookup. `via` names the key that won, or '' for the built-in default. */
export function resolveSwipe(
  map: BindingMap,
  w: AppIdentity | null,
): { binding: AppBinding; via: string } {
  for (const k of appKeys(w)) {
    const hit = map[k]
    if (hit) return { binding: hit, via: k }
  }
  return { binding: DEFAULT_SWIPE, via: '' }
}

export function bindingEq(a: AppBinding, b: AppBinding): boolean {
  return (
    chordEq(a.up, b.up) &&
    chordEq(a.down, b.down) &&
    a.submit === b.submit &&
    a.newline === b.newline &&
    a.fontsize === b.fontsize
  )
}

/** `up=C-u down=C-d`. The swipe half only: the submit key resolves separately
 *  (`resolveSubmit`), so one line for both would imply a single source. Use `extrasSuffix`
 *  where the whole stored record is shown. */
export function bindingLabel(b: AppBinding): string {
  return `up=${chordLabel(b.up)} down=${chordLabel(b.down)}`
}

/** ` submit=C-Enter newline=S-Enter`: only the fields this record itself stores, never
 *  inherited values. */
export function extrasSuffix(b: AppBinding): string {
  const sub = b.submit === undefined ? null : submitChordById(b.submit)
  const nl = b.newline === undefined ? null : newlineChordById(b.newline)
  const fs = b.fontsize === undefined ? null : fontStepById(b.fontsize)
  return (
    (sub ? ` submit=${sub.chord ? chordLabel(sub.chord) : 'off'}` : '') +
    (nl?.chord ? ` newline=${chordLabel(nl.chord)}` : '') +
    (fs ? ` fontsize=${fs.label.replace(/ /g, '')}` : '')
  )
}

/** Which key `Submit` presses in the focused app, as a `SUBMIT_CHORDS` id, plus the binding
 *  key that decided ('' for the built-in default). Resolved field by field, unlike
 *  `resolveSwipe`: the first candidate with a `submit` wins, so a swipe binding on a more
 *  specific key does not cancel a `submit` set on `*`. */
export function resolveSubmit(map: BindingMap, w: AppIdentity | null): { id: string; via: string } {
  for (const k of appKeys(w)) {
    const hit = map[k]
    if (hit && hit.submit !== undefined) return { id: hit.submit, via: k }
  }
  return { id: SUBMIT_DEFAULT.id, via: '' }
}

/** Which key a line break in the box becomes; the same field-by-field walk as `resolveSubmit`. */
export function resolveNewline(
  map: BindingMap,
  w: AppIdentity | null,
): { id: string; via: string } {
  for (const k of appKeys(w)) {
    const hit = map[k]
    if (hit && hit.newline !== undefined) return { id: hit.newline, via: k }
  }
  return { id: NEWLINE_DEFAULT.id, via: '' }
}

/** What `font −` / `font +` press in the focused app; the same field-by-field walk. */
export function resolveFontsize(
  map: BindingMap,
  w: AppIdentity | null,
): { id: string; via: string } {
  for (const k of appKeys(w)) {
    const hit = map[k]
    if (hit && hit.fontsize !== undefined) return { id: hit.fontsize, via: k }
  }
  return { id: FONTSIZE_DEFAULT.id, via: '' }
}

/** Pure parser for a whole stored map. An invalid entry is dropped and reported in `errors`
 *  (surfaced by `GET /api/bindings`); it does not reject the file. */
export function normBindingMap(v: unknown): { map: BindingMap; errors: string[] } {
  const map: BindingMap = {}
  const errors: string[] = []
  if (!v || typeof v !== 'object') return { map, errors }
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isBindingKey(k)) {
      errors.push(`not an app key: ${JSON.stringify(k)}`)
      continue
    }
    const b = normAppBinding(raw)
    if (!b) {
      errors.push(`${k}: not a usable up/down pair`)
      continue
    }
    map[k] = b
  }
  return { map, errors }
}

/** unknown → a canonical `AppBinding`, or null. Both chords must be in the key catalogue, and
 *  `submit`, `newline` and `fontsize`, when present, must be ids from the closed lists in
 *  keys.ts. A bad optional field rejects the whole record, so it lands in `errors` instead of
 *  being silently dropped. */
export function normAppBinding(v: unknown): AppBinding | null {
  if (!v || typeof v !== 'object') return null
  const o = v as {
    up?: unknown
    down?: unknown
    submit?: unknown
    newline?: unknown
    fontsize?: unknown
  }
  const up = normChord(o.up)
  const down = normChord(o.down)
  if (!up || !down) return null
  const out: AppBinding = { up, down }
  if (o.submit !== undefined && o.submit !== null) {
    if (typeof o.submit !== 'string' || !submitChordById(o.submit)) return null
    out.submit = o.submit
  }
  if (o.newline !== undefined && o.newline !== null) {
    // Narrower than `submit`: `newline:"off"` or `newline:"ctrl+d"` would not be a line break.
    if (typeof o.newline !== 'string' || !newlineChordById(o.newline)) return null
    out.newline = o.newline
  }
  if (o.fontsize !== undefined && o.fontsize !== null) {
    if (typeof o.fontsize !== 'string' || !fontStepById(o.fontsize)) return null
    out.fontsize = o.fontsize
  }
  return out
}
