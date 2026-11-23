// The `.desktop` parser, against real files.
//
// Every fixture in tests/fixtures/desktop/ is a copy of an installed `.desktop` file, kept
// because it carries a case a naive parser gets wrong:
//
//   com.gexperts.Tilix       three `[Desktop Action …]` groups; `grep '^Name='` returns four
//                            names.
//   firefox                  `Name[ja]`, many locale variants, and three localised actions
//                            (`Name[ja]=新しいウィンドウ`).
//   rxvt-unicode             `Actions=New` with no trailing semicolon, and `OnlyShowIn=Unity`
//                            on the action rather than on the entry.
//   xmountains               `[Desktop Action View]` with an Exec and no Name.
//   python3.12               `NoDisplay=true` and `Terminal=true` together.
//   vim, info, byobu         `Terminal=true` (plus `%F` and a relative `TryExec` in vim's case).
//   openjdk-8-java           `%f` in the middle of argv: `cautious-launcher %f /usr/bin/java`.
//   display-im6.q16          `%F` after an absolute program path.
//   claude-code-url-handler  a quoted argv[0] and `%u`; `NoDisplay=true`.
//   nsight                   an absolute `TryExec` pointing into a CUDA install.
//   debian-xterm/-uxterm     a licence comment before `[Desktop Entry]`, and a commented-out
//                            key (`#GenericName=Terminal`) inside the group.
//   kitty, rofi              ordinary entries, as the control.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  expandFieldCodes,
  localeCandidates,
  localesFromEnv,
  localisedValue,
  parseDesktopFile,
  parseDesktopGroups,
  splitExec,
} from '../src/server/platform/x11/desktop.ts'

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'desktop')
const fixture = (name: string): string => readFileSync(join(DIR, `${name}.desktop`), 'utf8')
const parse = (name: string, locales: string[] = []) => parseDesktopFile(fixture(name), locales)

const NO_CTX = { icon: '', name: '', path: '' }

describe('groups', () => {
  it('drops the licence header before the first group, and commented-out keys inside it', () => {
    const groups = parseDesktopGroups(fixture('debian-xterm'))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('Desktop Entry')
    expect(groups[0]?.keys.get('Name')).toBe('XTerm')
    // `#GenericName=Terminal` is a comment, not a key, and `#` is not part of a key name.
    expect(groups[0]?.keys.has('GenericName')).toBe(false)
    expect(groups[0]?.keys.has('#GenericName')).toBe(false)
  })

  it('keeps action groups separate from the entry (Tilix)', () => {
    const groups = parseDesktopGroups(fixture('com.gexperts.Tilix'))
    expect(groups.map(g => g.name)).toEqual([
      'Desktop Entry',
      'Desktop Action new-window',
      'Desktop Action new-session',
      'Desktop Action preferences',
    ])
  })

  it('is total: garbage in, fewer keys out — never a throw', () => {
    expect(parseDesktopGroups('')).toEqual([])
    expect(parseDesktopGroups('Name=orphan')).toEqual([]) // key outside any group
    expect(parseDesktopGroups('[unterminated\nName=x')).toEqual([])
    const g = parseDesktopGroups('[A]\nno-equals-sign\n=novalue\nk=v')
    expect(g[0]?.keys.get('k')).toBe('v')
    expect(g[0]?.keys.size).toBe(1)
  })
})

describe('Tilix — the action-group trap', () => {
  const t = parse('com.gexperts.Tilix')

  it("the entry's name is the app's name, not an action's", () => {
    expect(t.entry?.name).toBe('Tilix')
    expect(t.entry?.exec).toBe('tilix')
  })

  it('reports the actions as actions, in Actions= order', () => {
    expect(t.actions.map(a => a.id)).toEqual(['new-window', 'new-session', 'preferences'])
    expect(t.actions.map(a => a.name)).toEqual(['New Window', 'New Session', 'Preferences'])
    expect(t.actions[0]?.exec).toBe('tilix --action=app-new-window')
  })

  it('no action name can be mistaken for the entry name', () => {
    const naive = [...fixture('com.gexperts.Tilix').matchAll(/^Name=(.*)$/gm)].map(m => m[1])
    expect(naive).toEqual(['Tilix', 'New Window', 'New Session', 'Preferences']) // the trap
    expect(t.entry?.name).toBe('Tilix') // the parse
  })
})

describe('actions in the wild', () => {
  it('rxvt-unicode: `Actions=New` with no trailing semicolon still yields one action', () => {
    const r = parse('rxvt-unicode')
    expect(r.actions.map(a => a.id)).toEqual(['New'])
    expect(r.actions[0]?.name).toBe('New Rxvt Color Unicode Terminal')
  })

  it('rxvt-unicode: OnlyShowIn sits on the action, so the entry has none', () => {
    expect(parse('rxvt-unicode').entry?.onlyShowIn).toEqual([])
  })

  it('xmountains: an action with an Exec and no Name is still an action', () => {
    const x = parse('xmountains')
    expect(x.actions).toEqual([{ id: 'View', name: '', exec: 'xmountains' }])
    expect(x.entry?.name).toBe('Xmountains')
    // Icon= is present but empty, which must not become a `--icon ''` argument (see %i below).
    expect(x.entry?.icon).toBe('')
  })

  it('firefox: three actions, and an action group not listed in Actions= would still be found', () => {
    expect(parse('firefox').actions.map(a => a.id)).toEqual([
      'new-window',
      'new-private-window',
      'open-profile-manager',
    ])
    const extra = parseDesktopFile(
      '[Desktop Entry]\nName=X\nExec=x\n[Desktop Action undeclared]\nExec=y\n',
    )
    expect(extra.actions.map(a => a.id)).toEqual(['undeclared'])
  })
})

describe('locale', () => {
  it('follows the spec lookup order, most specific first', () => {
    expect(localeCandidates('ja_JP.UTF-8')).toEqual(['ja_JP', 'ja'])
    expect(localeCandidates('sr_RS.UTF-8@latin')).toEqual([
      'sr_RS@latin',
      'sr_RS',
      'sr@latin',
      'sr',
    ])
    expect(localeCandidates('ja')).toEqual(['ja'])
    expect(localeCandidates('C')).toEqual([])
    expect(localeCandidates('POSIX')).toEqual([])
    expect(localeCandidates('')).toEqual([])
  })

  it('reads LC_ALL → LC_MESSAGES → LANG, in that order', () => {
    expect(localesFromEnv({ LC_ALL: 'ja_JP.UTF-8', LANG: 'de_DE' })).toEqual(['ja_JP', 'ja'])
    expect(localesFromEnv({ LC_MESSAGES: 'fr_FR', LANG: 'de_DE' })).toEqual(['fr_FR', 'fr'])
    expect(localesFromEnv({ LANG: 'de_DE.UTF-8' })).toEqual(['de_DE', 'de'])
    expect(localesFromEnv({})).toEqual([])
  })

  it("prefers the user's locale for a localised name (firefox's own actions)", () => {
    const ja = parse('firefox', ['ja'])
    expect(ja.actions[0]?.name).toBe('新しいウィンドウ')
    expect(parse('firefox').actions[0]?.name).toBe('New Window')
    // The entry's Name[ja] exists too — it just happens to also be "Firefox".
    expect(ja.entry?.name).toBe('Firefox')
  })

  it('falls back to the unsuffixed key when the locale has no translation', () => {
    const keys = new Map([
      ['Name', 'Base'],
      ['Name[ja]', 'ベース'],
    ])
    expect(localisedValue(keys, 'Name', ['ja'])).toBe('ベース')
    expect(localisedValue(keys, 'Name', ['de_DE', 'de'])).toBe('Base')
    expect(localisedValue(keys, 'Name', [])).toBe('Base')
    expect(localisedValue(keys, 'Nope', ['ja'])).toBe('')
  })
})

describe('flags that hide or wrap an entry', () => {
  it('python3.12 is NoDisplay and Terminal at once', () => {
    const p = parse('python3.12')
    expect(p.entry?.noDisplay).toBe(true)
    expect(p.entry?.terminal).toBe(true)
  })

  it('counts the NoDisplay and Terminal fixtures', () => {
    const names = readdirSync(DIR)
      .filter(n => n.endsWith('.desktop'))
      .map(n => n.slice(0, -8))
    const parsed = names.map(n => ({ n, e: parse(n).entry }))
    expect(
      parsed
        .filter(x => x.e?.noDisplay)
        .map(x => x.n)
        .sort(),
    ).toEqual(['claude-code-url-handler', 'openjdk-8-java', 'python3.12'])
    expect(
      parsed
        .filter(x => x.e?.terminal)
        .map(x => x.n)
        .sort(),
    ).toEqual(['byobu', 'info', 'python3.12', 'vim'])
  })

  it('TryExec is reported verbatim — relative for vim, absolute for nsight', () => {
    expect(parse('vim').entry?.tryExec).toBe('vim')
    expect(parse('nsight').entry?.tryExec).toBe('/usr/local/cuda-11.8/bin/nsight')
    expect(parse('kitty').entry?.tryExec).toBe('kitty')
    expect(parse('debian-xterm').entry?.tryExec).toBe('')
  })

  it('Type is reported so only Application is launched', () => {
    expect(parse('rofi').entry?.type).toBe('Application')
  })
})

describe('splitExec — the Desktop Entry quoting rules, not the shell ones', () => {
  it('splits on whitespace', () => {
    expect(splitExec('tilix --action=app-new-window')).toEqual(['tilix', '--action=app-new-window'])
    expect(splitExec('  xterm \t -e  vim ')).toEqual(['xterm', '-e', 'vim'])
    expect(splitExec('')).toEqual([])
  })

  it('keeps a double-quoted argument together', () => {
    // The quoted absolute path must survive as one token; whose home it sits
    // under is not the point, so only its tail is pinned.
    const argv = splitExec(parse('claude-code-url-handler').entry?.exec ?? '')
    expect(argv).toHaveLength(3)
    expect(argv[0]).toMatch(/\/\.local\/bin\/claude$/)
    expect(argv.slice(1)).toEqual(['--handle-uri', '%u'])
    expect(splitExec('prog "two words" x')).toEqual(['prog', 'two words', 'x'])
    expect(splitExec('prog ""')).toEqual(['prog', ''])
  })

  it('honours the four backslash escapes inside quotes, and nothing else', () => {
    expect(splitExec('p "a\\"b"')).toEqual(['p', 'a"b'])
    expect(splitExec('p "a\\\\b"')).toEqual(['p', 'a\\b'])
    expect(splitExec('p "a\\$b"')).toEqual(['p', 'a$b'])
    expect(splitExec('p "a\\nb"')).toEqual(['p', 'a\\nb']) // \n is not an escape here
  })

  it('treats a single quote as an ordinary character — this is where a shell splitter diverges', () => {
    expect(splitExec("p it's fine")).toEqual(['p', "it's", 'fine'])
    expect(splitExec("p 'two words'")).toEqual(['p', "'two", "words'"])
  })
})

describe('expandFieldCodes', () => {
  it('drops the file/URL codes for an argument-less launch', () => {
    expect(expandFieldCodes(['firefox', '%u'], NO_CTX)).toEqual(['firefox'])
    expect(expandFieldCodes(['vim', '%F'], NO_CTX)).toEqual(['vim'])
    expect(expandFieldCodes(['p', '%f', '%U', '%d', '%D', '%n', '%N', '%v', '%m'], NO_CTX)).toEqual(
      ['p'],
    )
  })

  it('drops the argument, not just the code, when the code was the whole argument', () => {
    // openjdk-8-java.desktop: `cautious-launcher %f /usr/bin/java -jar`. Leaving '' behind
    // would hand java an extra empty argument and shift its own argv parsing.
    const argv = splitExec(parse('openjdk-8-java').entry?.exec ?? '')
    expect(argv).toEqual(['cautious-launcher', '%f', '/usr/bin/java', '-jar'])
    expect(expandFieldCodes(argv, NO_CTX)).toEqual(['cautious-launcher', '/usr/bin/java', '-jar'])
    expect(expandFieldCodes(argv, NO_CTX)).not.toContain('')
  })

  it('%i expands to two arguments, or to none when there is no icon', () => {
    expect(expandFieldCodes(['p', '%i'], { ...NO_CTX, icon: 'firefox' })).toEqual([
      'p',
      '--icon',
      'firefox',
    ])
    expect(expandFieldCodes(['p', '%i'], NO_CTX)).toEqual(['p'])
    // xmountains.desktop has `Icon=` (present, empty) — it must not become `--icon ''`.
    expect(
      expandFieldCodes(['p', '%i'], { ...NO_CTX, icon: parse('xmountains').entry?.icon ?? '' }),
    ).toEqual(['p'])
  })

  it('%c is the name, %k the file path, %% a literal percent', () => {
    const ctx = { icon: 'i', name: 'My App', path: '/usr/share/applications/x.desktop' }
    expect(expandFieldCodes(['p', '%c'], ctx)).toEqual(['p', 'My App'])
    expect(expandFieldCodes(['p', '--title=%c'], ctx)).toEqual(['p', '--title=My App'])
    expect(expandFieldCodes(['p', '%k'], ctx)).toEqual(['p', '/usr/share/applications/x.desktop'])
    expect(expandFieldCodes(['p', '100%%'], ctx)).toEqual(['p', '100%'])
  })

  it('drops an unknown or trailing code rather than passing it to execvp', () => {
    expect(expandFieldCodes(['p', '%z'], NO_CTX)).toEqual(['p'])
    expect(expandFieldCodes(['p', 'a%z'], NO_CTX)).toEqual(['p', 'a'])
    expect(expandFieldCodes(['p', '%'], NO_CTX)).toEqual(['p'])
    expect(expandFieldCodes(['p', 'plain'], NO_CTX)).toEqual(['p', 'plain'])
    // …but an argument that was already empty is not an emptied one, and survives.
    expect(expandFieldCodes(splitExec('p ""'), NO_CTX)).toEqual(['p', ''])
  })

  it('every fixture produces a non-empty argv with no empty arguments', () => {
    for (const n of readdirSync(DIR)
      .filter(x => x.endsWith('.desktop'))
      .map(x => x.slice(0, -8))) {
      const e = parse(n).entry
      expect(e, n).not.toBeNull()
      const argv = expandFieldCodes(splitExec(e?.exec ?? ''), {
        icon: e?.icon ?? '',
        name: e?.name ?? '',
        path: `${DIR}/${n}.desktop`,
      })
      expect(argv.length, n).toBeGreaterThan(0)
      expect(
        argv.filter(a => a === ''),
        n,
      ).toEqual([])
      expect(argv[0], n).not.toContain('%')
    }
  })
})
