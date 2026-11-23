// Unit tests for the per-app swipe binding model (src/shared/bindings.ts).
//
// Pinned here: the resolution order (app → exe → comm → cls → title → "*" → built-in), the
// identity spelling, and that an empty map resolves to the built-in defaults.

import { describe, expect, it } from 'vitest'
import type { BindingMap } from '../src/shared/bindings.ts'
import {
  appEntryKey,
  appKeys,
  bindingEq,
  bindingLabel,
  clsKey,
  commKey,
  DEFAULT_BINDING_KEY,
  DEFAULT_SWIPE,
  exeKey,
  extrasSuffix,
  isBindingKey,
  keyKind,
  needsWindow,
  normAppBinding,
  normBindingMap,
  preferredKey,
  resolveFontsize,
  resolveNewline,
  resolveSubmit,
  resolveSwipe,
  titleKey,
} from '../src/shared/bindings.ts'
import { FONTSIZE_DEFAULT, FONTSIZE_STEPS, fontStepById } from '../src/shared/keys.ts'

const PAGER: BindingMap['x'] = {
  up: { mods: [], key: 'Page_Up' },
  down: { mods: [], key: 'Page_Down' },
}
const VIM: BindingMap['x'] = {
  up: { mods: ['ctrl'], key: 'u' },
  down: { mods: ['ctrl'], key: 'd' },
}

describe('identity spelling', () => {
  it('lowercases and prefixes', () => {
    expect(commKey('xterm')).toBe('comm:xterm')
    expect(clsKey('XTerm')).toBe('cls:xterm')
    // WM_CLASS is reported as e.g. "XTerm".
    expect(clsKey('Navigator')).toBe('cls:navigator')
  })

  it('collapses characters a key may not contain, rather than refusing the app', () => {
    expect(clsKey('Google Chrome')).toBe('cls:google-chrome')
    expect(commKey('  Foo/Bar  ')).toBe('comm:foo-bar')
    expect(clsKey('com.gexperts.Tilix')).toBe('cls:com.gexperts.tilix')
  })

  it('is empty for an unresolvable identity', () => {
    expect(commKey('')).toBe('')
    expect(commKey(undefined)).toBe('')
    expect(clsKey('   ')).toBe('')
  })

  it('validates keys the way the server must before writing one', () => {
    expect(isBindingKey('*')).toBe(true)
    expect(isBindingKey('comm:xterm')).toBe(true)
    expect(isBindingKey('cls:com.gexperts.tilix')).toBe(true)
    expect(isBindingKey('xterm')).toBe(false) // no kind prefix
    expect(isBindingKey('comm:XTerm')).toBe(false) // not normalised
    expect(isBindingKey('title:foo')).toBe(true) // last resort, but a valid kind
    expect(isBindingKey('app:desktop:com.gexperts.Tilix')).toBe(true) // the inner ':' is allowed
    expect(isBindingKey('exe:/usr/games/xmountains')).toBe(true)
    expect(isBindingKey('exe:usr/games/xmountains')).toBe(false) // must be absolute
    expect(isBindingKey('nope:xterm')).toBe(false)
    expect(isBindingKey('comm:')).toBe(false)
    expect(isBindingKey('comm:a b')).toBe(false)
    expect(isBindingKey(null)).toBe(false)
  })
})

describe('the identities beyond comm and cls', () => {
  // A path is not folded like a name: lowercasing and collapsing `/` would turn two different
  // binaries into one key.
  it('keeps an exe path case-sensitive and slash-bearing', () => {
    expect(exeKey('/usr/games/xmountains')).toBe('exe:/usr/games/xmountains')
    expect(exeKey('/opt/Foo/bin/Foo')).toBe('exe:/opt/Foo/bin/Foo')
  })

  // A bare argv[0] from WM_COMMAND (`firefox`) says no more than comm does.
  it('refuses a relative exe', () => {
    expect(exeKey('firefox')).toBe('')
    expect(exeKey('')).toBe('')
    expect(exeKey(undefined)).toBe('')
  })

  it('keeps an LauncherEntry id verbatim, inner colon and all', () => {
    expect(appEntryKey('desktop:com.gexperts.Tilix')).toBe('app:desktop:com.gexperts.Tilix')
    expect(appEntryKey('x11:xmountains')).toBe('app:x11:xmountains')
    expect(appEntryKey('')).toBe('')
  })

  // Titles are routinely CJK; folding them through `ident()` would collapse them to one key.
  it('keeps a title readable rather than folding it to [a-z0-9]', () => {
    expect(titleKey('Xmountains')).toBe('title:xmountains')
    expect(titleKey('  アドオン マネージャー ')).toBe('title:アドオン マネージャー')
    expect(titleKey('a\tb   c')).toBe('title:a b c')
  })

  it('names the kind of a stored key', () => {
    expect(keyKind('*')).toBe('default')
    expect(keyKind('app:x11:xmountains')).toBe('app')
    expect(keyKind('exe:/usr/bin/xterm')).toBe('exe')
    expect(keyKind('comm:xterm')).toBe('comm')
    expect(keyKind('cls:xterm')).toBe('cls')
    expect(keyKind('title:xmountains')).toBe('title')
  })
})

describe('appKeys: the resolution order', () => {
  it('is app, then exe, then comm, then cls, then the default', () => {
    expect(
      appKeys({
        appId: 'desktop:xmountains',
        exe: '/usr/games/xmountains',
        app: 'xmountains',
        cls: 'XM',
      }),
    ).toEqual([
      'app:desktop:xmountains',
      'exe:/usr/games/xmountains',
      'comm:xmountains',
      'cls:xm',
      DEFAULT_BINDING_KEY,
    ])
  })

  // Apps rewrite their titles, so a title is not a candidate at all unless no durable
  // identity exists.
  it('offers a title only when no durable identity resolved', () => {
    expect(appKeys({ app: 'xterm', cls: 'XTerm', title: 'vim | src/main.ts' })).toEqual([
      'comm:xterm',
      'cls:xterm',
      DEFAULT_BINDING_KEY,
    ])
    // xmountains: no WM_CLASS, no _NET_WM_PID, no WM_COMMAND; a name and nothing else.
    expect(appKeys({ title: 'Xmountains' })).toEqual(['title:xmountains', DEFAULT_BINDING_KEY])
  })

  // `app:` lives in server memory and is lost on restart; if it suppressed the title, a
  // launched xmountains would become unbindable after a restart.
  it('does not let the session-scoped app: key suppress the title', () => {
    expect(appKeys({ appId: 'desktop:xmountains', title: 'Xmountains' })).toEqual([
      'app:desktop:xmountains',
      'title:xmountains',
      DEFAULT_BINDING_KEY,
    ])
    // ...while a durable identity still does.
    expect(appKeys({ appId: 'desktop:xterm', app: 'xterm', title: 'vim' })).toEqual([
      'app:desktop:xterm',
      'comm:xterm',
      DEFAULT_BINDING_KEY,
    ])
  })

  it('is comm, then cls, then the default', () => {
    expect(appKeys({ app: 'xterm', cls: 'XTerm' })).toEqual([
      'comm:xterm',
      'cls:xterm',
      DEFAULT_BINDING_KEY,
    ])
    expect(appKeys({ app: 'firefox', cls: 'Navigator' })).toEqual([
      'comm:firefox',
      'cls:navigator',
      DEFAULT_BINDING_KEY,
    ])
  })

  // Firefox reports comm `firefox` and WM_CLASS `firefox`. Dropping the `cls:` candidate when
  // it equals comm would make a stored `cls:firefox` unreachable.
  it('still offers the cls candidate when it spells the same word as comm', () => {
    expect(appKeys({ app: 'firefox', cls: 'firefox' })).toEqual([
      'comm:firefox',
      'cls:firefox',
      DEFAULT_BINDING_KEY,
    ])
    const r = resolveSwipe({ 'cls:firefox': PAGER }, { app: 'firefox', cls: 'firefox' })
    expect(r.via).toBe('cls:firefox')
  })

  it('drops only the halves that are not resolvable, and never drops the default', () => {
    expect(appKeys({ cls: 'XTerm' })).toEqual(['cls:xterm', DEFAULT_BINDING_KEY])
    expect(appKeys({ app: 'xterm' })).toEqual(['comm:xterm', DEFAULT_BINDING_KEY])
    expect(appKeys({})).toEqual([DEFAULT_BINDING_KEY])
    expect(appKeys(null)).toEqual([DEFAULT_BINDING_KEY])
  })
})

describe('preferredKey: what the editor writes by default', () => {
  it('prefers comm when that is all there is', () => {
    expect(preferredKey({ app: 'xterm', cls: 'XTerm' })).toBe('comm:xterm')
  })

  // exe over app: `app:` matches only copies this server launched, so defaulting to it would
  // fail for the same program started from a shell.
  it('prefers the binary over the launcher entry, while still offering both', () => {
    const w = { appId: 'desktop:xmountains', exe: '/usr/games/xmountains', app: 'xmountains' }
    expect(preferredKey(w)).toBe('exe:/usr/games/xmountains')
    expect(appKeys(w)).toContain('app:desktop:xmountains')
  })

  // For a wrapper, /usr/bin/python3 is as much "every python app" as comm `python3` is, so
  // only the class still separates them.
  it('still steers a wrapper to WM_CLASS, exe or no exe', () => {
    expect(preferredKey({ app: 'python3', exe: '/usr/bin/python3', cls: 'Meld' })).toBe('cls:meld')
  })

  it('offers a title as the default only when it is the only identity', () => {
    expect(preferredKey({ title: 'Xmountains' })).toBe('title:xmountains')
  })

  // The case where comm would bind every app of a family.
  it('steers to WM_CLASS when comm names a runtime, not an app', () => {
    expect(preferredKey({ app: 'electron', cls: 'Code' })).toBe('cls:code')
    expect(preferredKey({ app: 'java', cls: 'jetbrains-idea' })).toBe('cls:jetbrains-idea')
    expect(preferredKey({ app: 'python3', cls: 'Meld' })).toBe('cls:meld')
  })

  it('falls back to comm when a wrapper has no usable class either', () => {
    expect(preferredKey({ app: 'electron' })).toBe('comm:electron')
  })

  it('is empty when nothing is resolvable', () => {
    expect(preferredKey({})).toBe('')
    expect(preferredKey(null)).toBe('')
  })
})

describe('resolveSwipe', () => {
  it('is the built-in Up/Down with an empty map', () => {
    const r = resolveSwipe({}, { app: 'xterm', cls: 'XTerm' })
    expect(r.binding).toEqual(DEFAULT_SWIPE)
    expect(r.binding.up.key).toBe('Up')
    expect(r.binding.down.key).toBe('Down')
    expect(r.via).toBe('') // '' = nothing matched, the built-in answered
  })

  it('prefers comm over cls over the default', () => {
    const map: BindingMap = {
      'comm:less': PAGER,
      'cls:navigator': VIM,
      '*': { up: { mods: [], key: 'k' }, down: { mods: [], key: 'j' } },
    }
    expect(resolveSwipe(map, { app: 'less', cls: 'XTerm' }).via).toBe('comm:less')
    expect(resolveSwipe(map, { app: 'firefox', cls: 'Navigator' }).via).toBe('cls:navigator')
    expect(resolveSwipe(map, { app: 'xterm', cls: 'XTerm' }).via).toBe('*')
    expect(resolveSwipe(map, null).via).toBe('*')
  })

  it('returns the bound chords, not just the key that won', () => {
    const r = resolveSwipe({ 'comm:vim': VIM }, { app: 'vim' })
    expect(r.binding.up).toEqual({ mods: ['ctrl'], key: 'u' })
    expect(bindingLabel(r.binding)).toBe('up=C-u down=C-d')
  })
})

// With no per-app entry the gesture path never has to ask which window has focus.
describe('needsWindow', () => {
  it('is false for an empty map and for a default-only map', () => {
    expect(needsWindow({})).toBe(false)
    expect(needsWindow({ '*': PAGER })).toBe(false)
  })

  it('is true as soon as one app-specific entry exists', () => {
    expect(needsWindow({ 'comm:less': PAGER })).toBe(true)
    expect(needsWindow({ '*': PAGER, 'cls:xterm': VIM })).toBe(true)
  })
})

describe('normBindingMap: reading the stored file', () => {
  it('keeps the good entries and reports the bad ones rather than failing the file', () => {
    const { map, errors } = normBindingMap({
      'comm:less': { up: { key: 'Page_Up' }, down: { key: 'Page_Down' } },
      'comm:vim': { up: { mods: ['alt', 'ctrl'], key: 'u' }, down: { mods: ['ctrl'], key: 'd' } },
      'comm:bad': { up: { key: 'ArrowUp' }, down: { key: 'Down' } }, // key not in catalogue
      'comm:half': { up: { key: 'Up' } }, // no down
      'nope:xterm': { up: { key: 'Up' }, down: { key: 'Down' } }, // not an app key
    })
    expect(Object.keys(map).sort()).toEqual(['comm:less', 'comm:vim'])
    expect(map['comm:vim']?.up).toEqual({ mods: ['ctrl', 'alt'], key: 'u' }) // canonicalised
    expect(errors).toHaveLength(3)
    expect(errors.join('\n')).toContain('comm:bad')
    expect(errors.join('\n')).toContain('comm:half')
    expect(errors.join('\n')).toContain('nope:xterm')
  })

  it('treats a missing or non-object file as an empty map', () => {
    expect(normBindingMap(null)).toEqual({ map: {}, errors: [] })
    expect(normBindingMap('nope')).toEqual({ map: {}, errors: [] })
    expect(normBindingMap({})).toEqual({ map: {}, errors: [] })
  })
})

describe('normAppBinding / bindingEq', () => {
  it('needs both halves and canonicalises each', () => {
    expect(normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' } })).toEqual(DEFAULT_SWIPE)
    expect(normAppBinding({ up: { key: 'Up' } })).toBeNull()
    expect(normAppBinding({ down: { key: 'Down' } })).toBeNull()
    expect(normAppBinding(null)).toBeNull()
  })

  it('compares both halves', () => {
    expect(
      bindingEq(DEFAULT_SWIPE, { up: { mods: [], key: 'Up' }, down: { mods: [], key: 'Down' } }),
    ).toBe(true)
    expect(bindingEq(DEFAULT_SWIPE, PAGER)).toBe(false)
  })
})

// ── the submit key, per app (docs/phone-ui.md) ──────────────────────────────────────────────
// It is stored in the same record as the swipe, under the same identities, but it resolves
// independently.

describe('resolveSubmit: which key Submit presses', () => {
  // An unconfigured app is typed into, not run (SUBMIT_DEFAULT).
  it('presses nothing when the app has not been configured', () => {
    expect(resolveSubmit({}, { app: 'xterm' })).toEqual({ id: 'off', via: '' })
    expect(resolveSubmit({}, null)).toEqual({ id: 'off', via: '' })
  })

  it('takes the most specific entry that has an opinion, and says which one', () => {
    const map: BindingMap = {
      '*': { ...PAGER, submit: 'Return' },
      'comm:firefox': { ...PAGER, submit: 'ctrl+Return' },
    }
    expect(resolveSubmit(map, { app: 'firefox' })).toEqual({
      id: 'ctrl+Return',
      via: 'comm:firefox',
    })
    expect(resolveSubmit(map, { app: 'xterm' })).toEqual({ id: 'Return', via: '*' })
  })

  // Binding a swipe for one app must not cancel the submit key set for every app.
  it('falls through an entry that has a swipe but no submit of its own', () => {
    const map: BindingMap = { '*': { ...PAGER, submit: 'ctrl+Return' }, 'comm:xterm': VIM }
    expect(resolveSwipe(map, { app: 'xterm' }).via).toBe('comm:xterm')
    expect(resolveSubmit(map, { app: 'xterm' })).toEqual({ id: 'ctrl+Return', via: '*' })
  })

  // `off` is a choice, not the absence of one: it wins over the inherited value.
  it('lets an app choose to press nothing, and that beats an inherited key', () => {
    const map: BindingMap = {
      '*': { ...PAGER, submit: 'ctrl+Return' },
      'comm:xterm': { ...VIM, submit: 'off' },
    }
    expect(resolveSubmit(map, { app: 'xterm' })).toEqual({ id: 'off', via: 'comm:xterm' })
  })
})

describe('the submit key on the stored record', () => {
  // The closed list is enforced on the file, not just in the picker: `ctrl+alt+shift+Return`
  // is a chord `normChord` would accept and the UI cannot produce.
  it('accepts only an id from SUBMIT_CHORDS, and rejects the record otherwise', () => {
    expect(
      normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' }, submit: 'ctrl+Return' }),
    ).toEqual({ ...DEFAULT_SWIPE, submit: 'ctrl+Return' })
    expect(normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' }, submit: 'off' })).toEqual({
      ...DEFAULT_SWIPE,
      submit: 'off',
    })
    for (const bad of ['ctrl+alt+shift+Return', 'ctrl+Enter', 'Enter', '', 7, {}]) {
      expect(
        normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' }, submit: bad }),
        String(bad),
      ).toBeNull()
    }
  })

  it('treats absent as "no opinion" and keeps the record', () => {
    expect(normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' } })).toEqual(DEFAULT_SWIPE)
    expect(normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' }, submit: null })).toEqual(
      DEFAULT_SWIPE,
    )
  })

  // A record that differs only in the submit key is a different record; otherwise the SSE
  // event and the file write would be skipped.
  it('counts in bindingEq', () => {
    expect(bindingEq(DEFAULT_SWIPE, { ...DEFAULT_SWIPE, submit: 'ctrl+Return' })).toBe(false)
    expect(bindingEq({ ...PAGER, submit: 'off' }, { ...PAGER, submit: 'off' })).toBe(true)
  })

  // The stored list must not print an inherited value as though this entry owned it.
  it('is printed only when this entry has one', () => {
    expect(extrasSuffix(PAGER)).toBe('')
    expect(extrasSuffix({ ...PAGER, submit: 'ctrl+Return' })).toBe(' submit=C-Enter')
    expect(extrasSuffix({ ...PAGER, submit: 'off' })).toBe(' submit=off')
    // The swipe half never mentions it, because the two resolve separately.
    expect(bindingLabel({ ...PAGER, submit: 'ctrl+Return' })).toBe('up=PgUp down=PgDn')
  })
})

describe('resolveNewline: what a line break in the box becomes', () => {
  it('is a bare Return when nothing is stored: a terminal, a textarea, an editor', () => {
    expect(resolveNewline({}, { app: 'xterm' })).toEqual({ id: 'Return', via: '' })
  })

  // In a chat box `Return` sends, so a three-line message would become three messages unless
  // the break is the app's own.
  it('takes the most specific entry that has an opinion, and says which one', () => {
    const map: BindingMap = {
      '*': { ...PAGER, newline: 'Return' },
      'comm:firefox': { ...PAGER, submit: 'ctrl+Return', newline: 'shift+Return' },
    }
    expect(resolveNewline(map, { app: 'firefox' })).toEqual({
      id: 'shift+Return',
      via: 'comm:firefox',
    })
    expect(resolveNewline(map, { app: 'xterm' })).toEqual({ id: 'Return', via: '*' })
  })

  // Independent of `submit` and of the swipe, like `resolveSubmit`.
  it('falls through an entry that has a submit but no newline of its own', () => {
    const map: BindingMap = {
      '*': { ...PAGER, newline: 'shift+Return' },
      'comm:xterm': { ...VIM, submit: 'off' },
    }
    expect(resolveSubmit(map, { app: 'xterm' })).toEqual({ id: 'off', via: 'comm:xterm' })
    expect(resolveNewline(map, { app: 'xterm' })).toEqual({ id: 'shift+Return', via: '*' })
  })

  // Narrower than submit, and the file is gated too.
  it('stores only the Enter family: `off`, Tab and C-d are refused', () => {
    expect(
      normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' }, newline: 'shift+Return' }),
    ).toEqual({ ...DEFAULT_SWIPE, newline: 'shift+Return' })
    for (const bad of ['off', 'Tab', 'ctrl+d', 'ctrl+s', 'nope', 3]) {
      expect(
        normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' }, newline: bad }),
        String(bad),
      ).toBeNull()
    }
  })

  it('counts in bindingEq and prints in the stored list', () => {
    expect(bindingEq(DEFAULT_SWIPE, { ...DEFAULT_SWIPE, newline: 'shift+Return' })).toBe(false)
    expect(extrasSuffix({ ...PAGER, submit: 'ctrl+Return', newline: 'shift+Return' })).toBe(
      ' submit=C-Enter newline=S-Enter',
    )
    expect(extrasSuffix(PAGER)).toBe('')
  })
})

describe('resolveFontsize: what `font −` / `font +` press in the focused app', () => {
  // An empty map resolves to xterm's pair.
  it("is xterm's shift+KP pair when nothing is stored", () => {
    expect(resolveFontsize({}, { app: 'xterm' })).toEqual({ id: 'shift+KP', via: '' })
    expect(FONTSIZE_DEFAULT.bigger).toEqual([{ kind: 'key', arg: 'shift+KP_Add' }])
    expect(FONTSIZE_DEFAULT.smaller).toEqual([{ kind: 'key', arg: 'shift+KP_Subtract' }])
  })

  it("walks field by field: an entry with only a submit does not hide the default's fontsize", () => {
    const map: BindingMap = {
      '*': { ...PAGER, fontsize: 'ctrl+equal' },
      'cls:kitty': { ...PAGER, fontsize: 'ctrl+shift+equal' },
      'comm:xterm': { ...VIM, submit: 'off' },
    }
    expect(resolveFontsize(map, { cls: 'kitty' })).toEqual({
      id: 'ctrl+shift+equal',
      via: 'cls:kitty',
    })
    expect(resolveFontsize(map, { app: 'xterm' })).toEqual({ id: 'ctrl+equal', via: '*' })
  })

  it('stores only ids from FONTSIZE_STEPS: a free chord is refused', () => {
    expect(normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' }, fontsize: 'emacs' })).toEqual(
      { ...DEFAULT_SWIPE, fontsize: 'emacs' },
    )
    for (const bad of ['ctrl+KP_Add', 'xterm', '', 3]) {
      expect(
        normAppBinding({ up: { key: 'Up' }, down: { key: 'Down' }, fontsize: bad }),
        String(bad),
      ).toBeNull()
    }
  })

  it('is part of equality and of the stored-entry line', () => {
    expect(bindingEq({ ...PAGER, fontsize: 'emacs' }, PAGER)).toBe(false)
    expect(extrasSuffix({ ...PAGER, fontsize: 'ctrl+equal' })).toBe(' fontsize=C-=/C--')
  })
})

describe('FONTSIZE_STEPS: the closed list of zoom conventions', () => {
  it('has unique ids, each findable, each with both directions', () => {
    const ids = FONTSIZE_STEPS.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of FONTSIZE_STEPS) {
      expect(fontStepById(s.id)).toBe(s)
      expect(s.bigger.length, s.id).toBeGreaterThan(0)
      expect(s.smaller.length, s.id).toBeGreaterThan(0)
    }
  })

  // A held Ctrl that is never released would modify every later key the phone sends.
  it('releases every key it holds, in the same direction', () => {
    for (const s of FONTSIZE_STEPS) {
      for (const seq of [s.bigger, s.smaller]) {
        const downs = seq.filter(i => i.kind === 'keydown').map(i => i.arg)
        const ups = seq.filter(i => i.kind === 'keyup').map(i => i.arg)
        expect(ups.sort(), s.id).toEqual(downs.sort())
      }
    }
  })
})
