// A pure `.desktop` parser (freedesktop Desktop Entry Specification subset): text in,
// structure out, no I/O (apps.ts does that). Rules the parser must keep, each pinned by a real
// file in tests/fixtures/desktop/:
//   - a key is read from one named group, so `[Desktop Action …]` names never leak into the
//     entry;
//   - actions are parsed and returned but are not applications (apps.ts skips them);
//   - `%f %F %u %U` are removed for an argument-less launch, along with any argument they
//     leave empty; `%i %c %k` expand;
//   - quoting follows the spec (double quotes, backslash escapes), not the shell: a single
//     quote is an ordinary character, so a shell-style splitter must not be used here;
//   - comments and blank lines may precede the first group;
//   - localised keys (`Name[ja]`) follow the spec's lookup order.

/** One `[Group Name]` section, in file order. */
export interface DesktopGroup {
  name: string
  /** Last value wins for a repeated key, which is what every other implementation does. */
  keys: Map<string, string>
}

/** A `[Desktop Action <id>]` group. `name` may be '' — xmountains.desktop omits it. */
export interface DesktopAction {
  id: string
  name: string
  exec: string
}

/** The `[Desktop Entry]` group, decoded. Raw `exec` — field codes are expanded separately, so
 *  a caller can report the original line. */
export interface DesktopEntry {
  /** Localised `Name`, falling back to the unsuffixed one. */
  name: string
  exec: string
  tryExec: string
  icon: string
  /** `Terminal=true` — the program needs a terminal to be useful (apps.ts wraps it). */
  terminal: boolean
  noDisplay: boolean
  /** `Hidden=true` means "deleted" per the spec: strictly stronger than NoDisplay. */
  hidden: boolean
  /** `Type`, verbatim. Only `Application` is launchable. */
  type: string
  onlyShowIn: string[]
  notShownIn: string[]
}

export interface DesktopFile {
  /** null when the file has no `[Desktop Entry]` group at all. */
  entry: DesktopEntry | null
  /** In `Actions=` order where that key lists them, then any remaining action groups. */
  actions: DesktopAction[]
}

/** Split a `.desktop` file into its groups. Lines before the first `[Group]`, `#` comments
 *  and blank lines are dropped, and a line with no `=` is dropped rather than throwing: a
 *  malformed entry must degrade to fewer keys, never to a 500 on `GET /api/apps`. */
export function parseDesktopGroups(text: string): DesktopGroup[] {
  const out: DesktopGroup[] = []
  let cur: DesktopGroup | null = null
  // Strip a UTF-8 BOM: it would otherwise become part of the first group header.
  for (const raw of text.replace(/^﻿/, '').split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      if (end < 0) continue
      cur = { name: line.slice(1, end).trim(), keys: new Map() }
      out.push(cur)
      continue
    }
    if (!cur) continue // a key outside any group is meaningless
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    // The spec forbids space around `=`; real files have it anyway, so both are tolerated.
    cur.keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return out
}

/** The spec's locale lookup order for a POSIX locale string, most specific first, without the
 *  unsuffixed key (callers append that as the final fallback). `ja_JP.UTF-8@foo` → `ja_JP@foo`,
 *  `ja_JP`, `ja@foo`, `ja`. The encoding (`.UTF-8`) is never part of a key. */
export function localeCandidates(locale: string): string[] {
  const s = locale.trim()
  if (!s || s === 'C' || s === 'POSIX') return []
  const atIdx = s.indexOf('@')
  const modifier = atIdx >= 0 ? s.slice(atIdx + 1) : ''
  const base = (atIdx >= 0 ? s.slice(0, atIdx) : s).split('.')[0] ?? ''
  if (!base) return []
  const [lang, country] = base.split('_')
  if (!lang) return []
  const out: string[] = []
  if (country && modifier) out.push(`${lang}_${country}@${modifier}`)
  if (country) out.push(`${lang}_${country}`)
  if (modifier) out.push(`${lang}@${modifier}`)
  out.push(lang)
  return out
}

/** Locales to try, from the environment, in the POSIX precedence order LC_ALL → LC_MESSAGES →
 *  LANG. */
export function localesFromEnv(env: Record<string, string | undefined>): string[] {
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = env[k]
    if (v?.trim()) return localeCandidates(v)
  }
  return []
}

/** `Name[ja]` before `Name`, per `locales`. */
export function localisedValue(
  keys: ReadonlyMap<string, string>,
  key: string,
  locales: readonly string[],
): string {
  for (const loc of locales) {
    const v = keys.get(`${key}[${loc}]`)
    if (v) return v
  }
  return keys.get(key) ?? ''
}

function bool(keys: ReadonlyMap<string, string>, key: string): boolean {
  return (keys.get(key) ?? '').toLowerCase() === 'true'
}

function semiList(v: string): string[] {
  return v
    .split(';')
    .map(s => s.trim())
    .filter(s => s !== '')
}

/** Parse one `.desktop` file. Never throws. */
export function parseDesktopFile(text: string, locales: readonly string[] = []): DesktopFile {
  const groups = parseDesktopGroups(text)
  const entryGroup = groups.find(g => g.name === 'Desktop Entry')
  const entry: DesktopEntry | null = entryGroup
    ? {
        name: localisedValue(entryGroup.keys, 'Name', locales),
        exec: entryGroup.keys.get('Exec') ?? '',
        tryExec: entryGroup.keys.get('TryExec') ?? '',
        icon: entryGroup.keys.get('Icon') ?? '',
        terminal: bool(entryGroup.keys, 'Terminal'),
        noDisplay: bool(entryGroup.keys, 'NoDisplay'),
        hidden: bool(entryGroup.keys, 'Hidden'),
        type: entryGroup.keys.get('Type') ?? '',
        onlyShowIn: semiList(entryGroup.keys.get('OnlyShowIn') ?? ''),
        notShownIn: semiList(entryGroup.keys.get('NotShownIn') ?? ''),
      }
    : null

  // Action groups, in the order `Actions=` declares them (with or without a trailing
  // semicolon), then any action group the key does not list: those are still not applications.
  const actionGroups = new Map<string, DesktopGroup>()
  for (const g of groups) {
    const m = /^Desktop Action\s+(.+)$/.exec(g.name)
    if (m?.[1]) actionGroups.set(m[1].trim(), g)
  }
  const declared = entryGroup ? semiList(entryGroup.keys.get('Actions') ?? '') : []
  const order = [
    ...declared.filter(id => actionGroups.has(id)),
    ...[...actionGroups.keys()].filter(id => !declared.includes(id)),
  ]
  const actions: DesktopAction[] = order.map(id => {
    const g = actionGroups.get(id)
    return {
      id,
      name: g ? localisedValue(g.keys, 'Name', locales) : '',
      exec: g?.keys.get('Exec') ?? '',
    }
  })

  return { entry, actions }
}

// ── Exec → argv ────────────────────────────────────────────────────────────────────────────

/** Split an `Exec` value into argv by the Desktop Entry Specification, not shell rules:
 *  whitespace separates; a double-quoted string is one argument; inside quotes a backslash
 *  escapes `"`, `` ` ``, `$` and `\` only; a single quote is an ordinary character. The result
 *  is exec'd directly, never through a shell. */
export function splitExec(exec: string): string[] {
  const out: string[] = []
  let cur = ''
  let open = false // the current argument exists even if it is empty ("" is an argument)
  let quoted = false
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i]
    if (ch === undefined) break
    if (quoted) {
      if (ch === '\\') {
        const nxt = exec[i + 1]
        if (nxt === '"' || nxt === '`' || nxt === '$' || nxt === '\\') {
          cur += nxt
          i++
          continue
        }
        cur += ch
        continue
      }
      if (ch === '"') {
        quoted = false
        continue
      }
      cur += ch
      continue
    }
    if (ch === '"') {
      quoted = true
      open = true
      continue
    }
    if (/\s/.test(ch)) {
      if (cur !== '' || open) {
        out.push(cur)
        cur = ''
        open = false
      }
      continue
    }
    cur += ch
  }
  if (cur !== '' || open) out.push(cur)
  return out
}

/** Codes that name a file, a URL or a drop target. A launch has no arguments, so each one is
 *  removed, along with any argument the removal leaves empty. */
const DROPPED_CODES = 'fFuUdDnNvm'

export interface FieldCodeContext {
  /** `Icon=` — `%i` becomes `--icon <icon>`, or nothing when there is no icon. */
  icon: string
  /** The localised `Name` — `%c`. */
  name: string
  /** Absolute path of the `.desktop` file — `%k`. */
  path: string
}

/** Apply the field codes of an already-split argv. `%%` is a literal percent. `%i` expands to
 *  two arguments (or none), which is why this works on argv rather than the Exec string.
 *  Unknown codes are dropped: the spec calls them invalid. */
export function expandFieldCodes(argv: readonly string[], ctx: FieldCodeContext): string[] {
  const out: string[] = []
  for (const arg of argv) {
    if (!arg.includes('%')) {
      out.push(arg)
      continue
    }
    if (arg === '%i') {
      // The one code that is not a substitution: two arguments, or zero.
      if (ctx.icon) out.push('--icon', ctx.icon)
      continue
    }
    let res = ''
    for (let i = 0; i < arg.length; i++) {
      const ch = arg[i]
      if (ch !== '%') {
        res += ch
        continue
      }
      const code = arg[i + 1]
      if (code === undefined) break // trailing '%' — drop it
      i++
      if (code === '%') {
        res += '%'
        continue
      }
      if (code === 'c') {
        res += ctx.name
        continue
      }
      if (code === 'k') {
        res += ctx.path
        continue
      }
      if (DROPPED_CODES.includes(code)) continue
      // 'i' inside a larger argument, or anything unrecognised: drop the code.
    }
    // Dropping a code that was the whole argument drops the argument, not an empty argv slot
    // (`cautious-launcher %f /usr/bin/java -jar`). `arg !== ''` keeps a deliberately empty
    // argument (`Exec=p ""`) distinct from one this step emptied.
    if (res === '' && arg !== '') continue
    out.push(res)
  }
  return out
}
