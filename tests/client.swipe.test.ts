// Tests for the phone's `▶ app` editor (docs/phone-ui.md) — the rules in it that are rules
// rather than rendering: which apps the target pulldown offers, and what the rows are
// pre-filled with.
//
// The model itself (resolution order, validation) is pinned in shared.bindings.test.ts; the
// server's half in server.bindings.test.ts. What is left here is the editor's own behaviour,
// plus a source-text check that there is no free-text key field.

import { describe, expect, it } from 'vitest'
import {
  bindTargets,
  editorBase,
  editorFontsize,
  editorNewline,
  editorSubmit,
} from '../src/client/bindingsEditor.ts'
import type { AppBinding, BindingMap } from '../src/shared/bindings.ts'
import { DEFAULT_SWIPE, preferredKey } from '../src/shared/bindings.ts'
import { clientSource } from './helpers/source.ts'

const PAGER: AppBinding = {
  up: { mods: [], key: 'Page_Up' },
  down: { mods: [], key: 'Page_Down' },
}
const VIM: AppBinding = {
  up: { mods: ['ctrl'], key: 'u' },
  down: { mods: ['ctrl'], key: 'd' },
}

describe('bindTargets — what the pulldown offers', () => {
  // Every identity the window has, in resolution order, then the default. Offering only the
  // preferred one would make a reasonable choice unreachable: `exe:` and `app:` are different
  // promises about the same window, and only the user knows which they mean.
  it('offers every identity the window has, in resolution order', () => {
    expect(bindTargets({ app: 'xterm', cls: 'XTerm' }, {})).toEqual([
      'comm:xterm',
      'cls:xterm',
      '*',
    ])
    expect(
      bindTargets(
        {
          appId: 'desktop:xmountains',
          exe: '/usr/games/xmountains',
          app: 'xmountains',
        },
        {},
      ),
    ).toEqual(['app:desktop:xmountains', 'exe:/usr/games/xmountains', 'comm:xmountains', '*'])
  })

  // A window with no WM_CLASS, no pid and no WM_COMMAND: without the title fallback this list
  // would be `['*']` and the app would be unbindable.
  it('offers a title key when that is the only identity', () => {
    expect(bindTargets({ title: 'Xmountains' }, {})).toEqual(['title:xmountains', '*'])
  })

  it('offers only the default when no window has focus', () => {
    expect(bindTargets(null, {})).toEqual(['*'])
    expect(bindTargets({}, {})).toEqual(['*'])
  })

  // Otherwise a binding set on another app becomes unreachable the moment you switch away
  // from it — and `clear` would have nothing to point at.
  it('includes every key already bound, so nothing is unreachable', () => {
    const map: BindingMap = { 'comm:less': PAGER, 'cls:navigator': VIM }
    expect(bindTargets({ app: 'xterm' }, map)).toEqual([
      'comm:xterm',
      '*',
      'comm:less',
      'cls:navigator',
    ])
  })

  it('does not offer the focused app twice when it is already bound', () => {
    const map: BindingMap = { 'comm:xterm': VIM, '*': PAGER }
    expect(bindTargets({ app: 'xterm' }, map)).toEqual(['comm:xterm', '*'])
  })

  // comm names a runtime here, so `preferredKey` steers the default selection to WM_CLASS —
  // binding `comm:electron` would bind every Electron app at once. The others stay offered.
  it('still offers a wrapper comm, but does not preselect it', () => {
    expect(bindTargets({ app: 'electron', cls: 'Code' }, {})).toEqual([
      'comm:electron',
      'cls:code',
      '*',
    ])
    expect(preferredKey({ app: 'electron', cls: 'Code' })).toBe('cls:code')
  })
})

describe('editorBase — what the rows are pre-filled with', () => {
  it('shows an existing entry as itself', () => {
    expect(editorBase('comm:less', { 'comm:less': PAGER }, { app: 'less' })).toEqual(PAGER)
  })

  // The safety property: opening the editor on an unbound app and pressing `apply` without
  // touching anything must not change what that app does.
  it('shows the inherited value for an app with no entry of its own', () => {
    const map: BindingMap = { '*': PAGER }
    expect(editorBase('comm:xterm', map, { app: 'xterm' })).toEqual(PAGER)
  })

  it('shows the built-in default when nothing is bound at all', () => {
    expect(editorBase('comm:xterm', {}, { app: 'xterm' })).toEqual(DEFAULT_SWIPE)
    expect(editorBase('*', {}, null)).toEqual(DEFAULT_SWIPE)
  })

  // `*` is the fallback itself, so it must not inherit from a more specific entry that happens
  // to match the window that is focused while you are editing it.
  it('never fills the default row from an app-specific entry', () => {
    const map: BindingMap = { 'comm:xterm': VIM }
    expect(editorBase('*', map, { app: 'xterm' })).toEqual(DEFAULT_SWIPE)
  })
})

describe('editorSubmit — what the submit row is pre-filled with', () => {
  // Same safety property as `editorBase`: open the panel on an app, press `apply` without
  // reading anything, and nothing that app does may change.
  it("shows this entry's own key", () => {
    expect(
      editorSubmit('comm:less', { 'comm:less': { ...PAGER, submit: 'off' } }, { app: 'less' }),
    ).toBe('off')
  })

  it('shows the inherited key for an entry that has no opinion of its own', () => {
    const map: BindingMap = { '*': { ...PAGER, submit: 'ctrl+Return' }, 'comm:xterm': VIM }
    expect(editorSubmit('comm:xterm', map, { app: 'xterm' })).toBe('ctrl+Return')
  })

  it('shows the built-in default (press nothing) when nothing is stored anywhere', () => {
    expect(editorSubmit('comm:xterm', {}, { app: 'xterm' })).toBe('off')
    expect(editorSubmit('*', {}, null)).toBe('off')
  })

  // `*` is the fallback itself, so it must not be filled from an app-specific entry that
  // happens to match whatever has focus while you are editing it.
  it('never fills the default row from an app-specific entry', () => {
    const map: BindingMap = { 'comm:xterm': { ...VIM, submit: 'ctrl+Return' } }
    expect(editorSubmit('*', map, { app: 'xterm' })).toBe('off')
  })
})

describe('editorNewline — what the newline row is pre-filled with', () => {
  it("shows this entry's own key, then the inherited one, then the built-in Return", () => {
    const own: BindingMap = { 'comm:less': { ...PAGER, newline: 'shift+Return' } }
    expect(editorNewline('comm:less', own, { app: 'less' })).toBe('shift+Return')
    const inherited: BindingMap = { '*': { ...PAGER, newline: 'alt+Return' } }
    expect(editorNewline('comm:xterm', inherited, { app: 'xterm' })).toBe('alt+Return')
    expect(editorNewline('comm:xterm', {}, { app: 'xterm' })).toBe('Return')
    expect(editorNewline('*', {}, null)).toBe('Return')
  })
})

describe('editorFontsize — what the fontsize row is pre-filled with', () => {
  it("shows this entry's own pair, then the inherited one, then xterm's", () => {
    const own: BindingMap = { 'cls:kitty': { ...PAGER, fontsize: 'ctrl+shift+equal' } }
    expect(editorFontsize('cls:kitty', own, { cls: 'kitty' })).toBe('ctrl+shift+equal')
    const inherited: BindingMap = { '*': { ...PAGER, fontsize: 'ctrl+wheel' } }
    expect(editorFontsize('comm:xterm', inherited, { app: 'xterm' })).toBe('ctrl+wheel')
    expect(editorFontsize('comm:xterm', {}, { app: 'xterm' })).toBe('shift+KP')
    expect(editorFontsize('*', own, { cls: 'kitty' })).toBe('shift+KP')
  })
})

describe('the editor has no free-text key field', () => {
  // A key name that looks right, saves cleanly and sends nothing is the worst failure this
  // feature can have, so the picker is built from the closed key set
  // (docs/decisions/swipe-bindings-closed-key-set.md).
  it('builds the key picker from KEYS and nothing else', () => {
    const src = clientSource()
    // The editor's builders, by name — every row of the panel is made by one of these.
    const panel = src.fns('buildKeySelect', 'buildChordEditor', 'buildSendRow', 'buildFontsizeRow')
    expect(panel.has('for (const k of KEYS)')).toBe(true)
    expect(panel.has("createElement('input')")).toBe(false)
    expect(panel.has("createElement('textarea')")).toBe(false)
  })

  it('sends the structured chord, not a "C-u" string — and the submit key as a list ID', () => {
    const src = clientSource()
    expect(
      src.has("apiPost<{ ok?: boolean; msg?: string; map?: BindingMap }>('/api/bindings', body)"),
    ).toBe(true)
    expect(
      src.has(
        'key: editKey, up: edit.up, down: edit.down, submit: edit.submit, newline: edit.newline,',
      ),
    ).toBe(true)
  })

  // The submit and newline rows are pulldowns over the catalogue for the same reason the key
  // row is one over KEYS, and they must stay free of the modifier toggles the chord rows
  // carry: those would put `ctrl+alt+shift+Return` back on the table (see shared/keys.ts).
  it('builds both send rows from the catalogue, with no modifier toggles of their own', () => {
    const src = clientSource()
    const row = src.fns('buildSendRow', 'buildFontsizeRow')
    expect(row.has('for (const s of rows)')).toBe(true)
    expect(row.has("kind === 'submit' ? SUBMIT_CHORDS : NEWLINE_CHORDS")).toBe(true)
    expect(row.has('for (const m of MODS)')).toBe(false)
    expect(row.has("createElement('input')")).toBe(false)
  })
})
