// pinhole-window — the palettes: one shell, three contents, and no second implementation of a row.
//
// Source-structure cases. What they protect is an arrangement:
//
//   * the frame (backdrop, visualViewport fit, history entry, Escape, scroll indicator) exists
//     once;
//   * exactly one palette can be open, because the history entry, the `popstate` handler and
//     the `kbdShouldHandle` gate are all single-valued;
//   * the phone's `window` palette routes rows and does not re-implement them: it never posts
//     to `/api/wm/key` itself.

import { describe, expect, it } from 'vitest'
import { clientSource, type Source } from './helpers/source.ts'

const src = clientSource()

/** The top-level `function name(...)`, wherever it is declared (throws when it is not). */
function fnBody(name: string): Source {
  return src.fn(name)
}

describe('the palette shell exists once', () => {
  it('one backdrop, one history entry, one Escape handler, one fit', () => {
    for (const once of [
      "backdrop.id = 'pw-palette-backdrop'",
      "history.pushState({ pwPalette: true }, '')",
      "if (e.key === 'Escape')",
      'function layoutPalette',
      'function closePalette',
    ]) {
      expect(src.count(once), once).toBe(1)
    }
  })

  it('every palette goes through the shell', () => {
    // One call per palette. Adding a fourth is fine; writing a fourth frame is not.
    expect(src.count('openPaletteShell({')).toBe(3) // apps, task, window
    expect(src.count('function openPaletteShell')).toBe(1)
  })

  it('opening one closes whatever was up: one at a time is an invariant', () => {
    expect(fnBody('openPaletteShell').has("closePalette('replaced by ' + spec.id, true)")).toBe(
      true,
    )
  })

  it('a swap hands over the history entry instead of popping and re-pushing it', () => {
    // `history.back()` dispatches `popstate` asynchronously, so popping here and pushing a
    // moment later delivers the pop to the new palette, which reads it as a back gesture and
    // closes itself.
    const close = fnBody('closePalette')
    expect(close.has('if (back && !keepHistory && isPaletteHistoryState()) history.back()')).toBe(
      true,
    )
    expect(fnBody('openPaletteShell').has('if (!palettePushedState) {')).toBe(true)
  })

  it('each opener toggles only its own palette shut', () => {
    // `closePalette` on a second tap of the same button; a different palette is replaced, not
    // toggled.
    for (const [fn, id] of [
      ['openAppsPalette', 'apps'],
      ['openWindowPalette', 'window'],
      ['openTaskPalette', 'task'],
    ] as const) {
      expect(
        fnBody(fn).has(
          `if (paletteName === '${id}' && paletteEl) { closePalette('toggled off'); return }`,
        ),
        fn,
      ).toBe(true)
    }
  })

  it('the hardware-keyboard gate asks about any open palette, not the apps hook', () => {
    expect(src.has('kbdShouldHandle(tag, editable, paletteEl !== null)')).toBe(true)
  })
})

describe('the window palette routes rows rather than re-implementing them', () => {
  const body = fnBody('openWindowPalette')

  it('takes its rows from the shared builder', () => {
    expect(body.has('windowPanelRows(menuState())')).toBe(true)
  })

  it('acts through runRowToken, with no route of its own', () => {
    expect(body.has("runRowToken(t, [], 'window palette')")).toBe(true)
    expect(body.has('/api/wm/key')).toBe(false)
    expect(body.has('/api/windows/close')).toBe(false)
    expect(body.has('apiPost')).toBe(false)
  })

  it('parses the token instead of matching on it', () => {
    // A token that cannot be parsed is dropped, never guessed at with a `startsWith`.
    expect(body.has('parseToken(r.token)')).toBe(true)
    expect(body.has('r.token.startsWith(')).toBe(false)
  })

  it('closes before it acts, like the glasses level', () => {
    const close = body.indexOf("closePalette('acted')")
    const act = body.indexOf('runRowToken(')
    expect(close).toBeGreaterThan(-1)
    expect(close).toBeLessThan(act)
  })

  it('needs no filter box, and says why in the spec rather than inventing one', () => {
    expect(body.has("openPaletteShell({ id: 'window', label: 'window', opener: windowBtn })")).toBe(
      true,
    )
  })

  it('re-renders on the window list, since that is what gates its rows', () => {
    expect(body.has("palettePanel = { on: ['windows'], render }")).toBe(true)
  })

  it('arms a destructive row in place, one at a time', () => {
    expect(body.has('let armed: string | null = null')).toBe(true)
    expect(body.has('armed = r.token')).toBe(true)
    expect(body.has('CONFIRM_LABEL')).toBe(true)
  })
})

describe('runRowToken is the one place a row becomes an action', () => {
  it('the glasses presenter delegates to it instead of carrying a copy', () => {
    const body = fnBody('activateRow')
    expect(body.has("runRowToken(t, modsAtPick, 'menu')")).toBe(true)
    // Navigation stays with the presenter that owns a path stack; the effects do not.
    expect(body.has("case 'sub': pushLevel(t.id, row.crumb ?? row.label); return")).toBe(true)
    // Asks about the call rather than the string, so prose naming `/api/wm/key` cannot match.
    expect(body.has('apiPost')).toBe(false)
  })

  it('every route a row can take lives in exactly one function', () => {
    expect(src.count("'/api/wm/key'")).toBe(1)
    expect(src.count("'/api/windows/close'")).toBe(1)
  })
})

describe('the task palette switches by wid, through the one route', () => {
  const body = fnBody('openTaskPalette')

  it('orders the raw window list, not the glasses builder, which caps and truncates', () => {
    expect(body.has('mruOrderWindows(windows, winRecent)')).toBe(true)
    expect(body.has('buildMenuItems')).toBe(false)
    expect(body.has('fitUnits')).toBe(false)
    expect(body.has('menuItems')).toBe(false)
  })

  it('selects through `selectWindow`, so both surfaces use the same key', () => {
    expect(body.has('selectWindow(wid,')).toBe(true)
    expect(body.has('apiPost')).toBe(false)
    // Never by the ratpoison number, which the WM recycles (docs/protocol.md).
    // (The shell's own spec is `{ id: 'task', … }`; any other object keyed by `id` is the number.)
    expect(body.has(/\{id:(?!'task')/)).toBe(false)
  })

  it('closes before switching: the result is the mirror behind the panel', () => {
    const close = body.indexOf("closePalette('switched')")
    expect(close).toBeGreaterThan(-1)
    expect(close).toBeLessThan(body.indexOf('selectWindow(wid,'))
  })

  it("reads the live order, not the glasses' frozen one", () => {
    // `menuRootOrder` exists because a list re-sorting under a cursor is dangerous; a thumb aims
    // at a visible row, and the row carries its own wid. Asks about the read, not the name.
    expect(body.has('menuOpen ? menuRootOrder')).toBe(false)
    expect(body.has('rootRows()')).toBe(false)
  })

  it('does not become a second launcher', () => {
    expect(body.has('launchApp')).toBe(false)
    expect(body.has('/api/spawn')).toBe(false)
    expect(body.has('MENU_ROOT_LABEL')).toBe(false)
  })

  it('re-renders on the window list', () => {
    expect(body.has("palettePanel = { on: ['windows'], render }")).toBe(true)
  })
})

describe('the title row is the three palette openers', () => {
  // Plus the tour's `?` beside the title (tour.ts), which is about the page, not an action.
  it('holds task, window and apps, and not the mirror-mode button', () => {
    expect(src.has('titleRow.append(title, helpBtn, taskBtn, windowBtn, appsBtn)')).toBe(true)
  })

  it('the mirror-mode button sits in the tools row, beside invert', () => {
    const tools = src.fn('mountUi').between('const tools = pillRow(', "tools.id = 'tools'")
    expect(tools.has('invertBtn')).toBe(true)
    expect(tools.has('mirrorBtn')).toBe(true)
    // Its state is re-synced after the row exists, or a link that was already down at boot would
    // leave an enabled button offering a mode the pump cannot draw.
    expect(src.has('ui.appendChild(tools)\n  applyMirrorMode()')).toBe(true)
  })
})
