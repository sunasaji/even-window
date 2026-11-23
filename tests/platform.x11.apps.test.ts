// The application scan: sources, the deny-list, the user's overrides, and what
// `POST /api/spawn` will accept.
//
// `buildAppList` is pure, so everything that decides what is launchable is tested without
// dpkg, a filesystem or an X server. The live `scanSectionX11` is skipped on a host without
// dpkg, where degrading to an empty result is the documented behaviour.

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type BuildInput,
  buildAppList,
  DENY_CLASSES,
  DENY_LIST,
  type DesktopInput,
  denyClass,
  desktopDirs,
  launchArgv,
  overrideMatches,
  parseOverrides,
  scanSectionX11,
  terminalWrapperArgv,
} from '../src/server/platform/x11/apps.ts'
import { DEFAULT_SPAWN_ARGV } from '../src/server/platform/x11/session.ts'
import type { LauncherEntry } from '../src/shared/types.ts'

const NO_OVERRIDES = { hide: [], show: [], add: [], errors: [] }

const desk = (id: string, text: string): DesktopInput => ({
  id,
  path: `/usr/share/applications/${id}.desktop`,
  text,
})

const build = (p: Partial<BuildInput> = {}) =>
  buildAppList({
    desktop: [],
    sectionX11: [],
    overrides: NO_OVERRIDES,
    locales: [],
    onPath: () => true,
    ...p,
  })

const names = (apps: readonly LauncherEntry[]): string[] => apps.map(a => a.name)
const ids = (apps: readonly LauncherEntry[]): string[] => apps.map(a => a.id)

describe('source 1 — .desktop', () => {
  it('takes an ordinary entry, with the id, name and argv split out', () => {
    const r = build({
      desktop: [
        desk('rofi', '[Desktop Entry]\nType=Application\nName=Rofi\nExec=rofi -show drun\n'),
      ],
    })
    expect(r.apps).toEqual([
      {
        id: 'desktop:rofi',
        name: 'Rofi',
        cmd: 'rofi',
        args: ['-show', 'drun'],
        note: 'desktop',
        terminal: false,
      },
    ])
  })

  it('hides NoDisplay=true — those entries exist to claim a MIME type, not to be launched', () => {
    const r = build({
      desktop: [
        desk('handler', '[Desktop Entry]\nType=Application\nName=H\nExec=h %u\nNoDisplay=true\n'),
      ],
    })
    expect(r.apps).toEqual([])
    expect(r.skipped).toContainEqual({ what: 'handler', why: 'NoDisplay=true' })
  })

  it('hides Hidden=true (the spec\'s "deleted"), and anything that is not an Application', () => {
    const r = build({
      desktop: [
        desk('gone', '[Desktop Entry]\nType=Application\nName=G\nExec=g\nHidden=true\n'),
        desk('link', '[Desktop Entry]\nType=Link\nName=L\nURL=http://x\n'),
        desk('dir', '[Desktop Entry]\nType=Directory\nName=D\n'),
      ],
    })
    expect(r.apps).toEqual([])
    expect(r.skipped.map(s => s.why).sort()).toEqual([
      'Hidden=true (deleted)',
      'Type=Directory',
      'Type=Link',
    ])
  })

  it('marks Terminal=true rather than dropping it', () => {
    const r = build({
      desktop: [
        desk('vim', '[Desktop Entry]\nType=Application\nName=Vim\nExec=vim %F\nTerminal=true\n'),
      ],
    })
    expect(r.apps[0]).toMatchObject({ cmd: 'vim', args: [], terminal: true })
  })

  it('honours TryExec: an entry whose binary is missing is skipped', () => {
    const live = '[Desktop Entry]\nType=Application\nName=K\nExec=kitty\nTryExec=kitty\n'
    const dead = '[Desktop Entry]\nType=Application\nName=N\nExec=nsight\nTryExec=/no/such/nsight\n'
    const r = build({
      desktop: [desk('kitty', live), desk('nsight', dead)],
      onPath: c => c === 'kitty',
    })
    expect(names(r.apps)).toEqual(['K'])
    expect(r.skipped).toContainEqual({ what: 'nsight', why: 'TryExec not found: /no/such/nsight' })
  })

  it('ignores OnlyShowIn / NotShownIn deliberately', () => {
    // We are not a registered desktop environment, so no OnlyShowIn value can ever match us and
    // the strict reading would silently drop the entry. NoDisplay is the field that means "not
    // a user-facing app", and apps.conf can hide anything.
    const r = build({
      desktop: [
        desk('unity', '[Desktop Entry]\nType=Application\nName=U\nExec=u\nOnlyShowIn=Unity;\n'),
        desk('notgnome', '[Desktop Entry]\nType=Application\nName=N\nExec=n\nNotShownIn=GNOME;\n'),
      ],
    })
    expect(names(r.apps).sort()).toEqual(['N', 'U'])
  })

  it('reports an action as an action, so it can never become an app', () => {
    const tilix =
      '[Desktop Entry]\nType=Application\nName=Tilix\nExec=tilix\nActions=new-window;\n' +
      '\n[Desktop Action new-window]\nName=New Window\nExec=tilix --action=app-new-window\n'
    const r = build({ desktop: [desk('com.gexperts.Tilix', tilix)] })
    expect(names(r.apps)).toEqual(['Tilix'])
    expect(r.skipped).toContainEqual({
      what: 'com.gexperts.Tilix [Desktop Action new-window]',
      why: 'action, not an application',
    })
  })

  it('skips an entry with no Exec, and one whose Exec expands to nothing', () => {
    const r = build({
      desktop: [
        desk('noexec', '[Desktop Entry]\nType=Application\nName=X\n'),
        desk('codeonly', '[Desktop Entry]\nType=Application\nName=Y\nExec=%f\n'),
      ],
    })
    expect(r.apps).toEqual([])
    expect(r.skipped.map(s => s.why).sort()).toEqual(['Exec expanded to nothing', 'no Exec'])
  })

  it('uses the locale name when there is one', () => {
    const f = '[Desktop Entry]\nType=Application\nName=Editor\nName[ja]=エディタ\nExec=e\n'
    expect(names(build({ desktop: [desk('e', f)], locales: ['ja'] }).apps)).toEqual(['エディタ'])
    expect(names(build({ desktop: [desk('e', f)] }).apps)).toEqual(['Editor'])
  })
})

describe('source 2 — Section: x11 ∧ libX11', () => {
  it('keeps the interactive ones and names them after the command', () => {
    const r = build({ sectionX11: ['xfontsel', 'oclock', 'xcalc'] })
    expect(ids(r.apps)).toEqual(['x11:oclock', 'x11:xcalc', 'x11:xfontsel'])
    expect(r.apps.every(a => a.note === 'section-x11' && a.args.length === 0)).toBe(true)
  })

  it('this source is what makes the x11-apps suite reachable at all', () => {
    // Most plain X clients (xfontsel, oclock, bitmap, editres) ship no .desktop file.
    const r = build({ sectionX11: ['xfontsel', 'oclock', 'bitmap', 'editres'] })
    expect(r.counts.desktopApps).toBe(0)
    expect(r.counts.sectionX11Kept).toBe(4)
  })
})

describe('the shipped deny-list', () => {
  it('drops the non-interactive utilities and says which class did it', () => {
    const r = build({ sectionX11: ['xterm', 'xdpyinfo', 'Xvfb', 'x11perf', 'xmessage'] })
    expect(ids(r.apps)).toEqual(['x11:xterm'])
    expect(r.counts.denied).toBe(4)
    expect(denyClass('xdpyinfo')).toBe('query')
    expect(denyClass('Xvfb')).toBe('server')
    expect(denyClass('x11perf')).toBe('benchmark')
    expect(denyClass('xmessage')).toBe('needs-args')
    expect(denyClass('xterm')).toBeNull()
  })

  it('covers the known non-interactive set', () => {
    // Each of these maps no usable window when launched bare.
    for (const c of [
      'Xephyr',
      'Xvfb',
      'xauth',
      'xdotool',
      'xdpyinfo',
      'xmodmap',
      'xrdb',
      'xset',
      'xsetroot',
      'xhost',
      'xprop',
      'xsel',
      'xlsfonts',
      'xkbcomp',
      'setxkbmap',
      'dbus-launch',
      'x11perf',
      'rendercheck',
      'bmtoa',
      'ico',
      'xcmsdb',
      'xgamma',
      'xcursorgen',
      'xstdcmap',
    ]) {
      expect(DENY_LIST, c).toContain(c)
    }
  })

  it('never denies something that does draw a window and stay up', () => {
    for (const c of [
      'xterm',
      'urxvt',
      'rxvt',
      'xcalc',
      'xclock',
      'oclock',
      'xfontsel',
      'xeyes',
      'xlogo',
      'xload',
      'xman',
      'xedit',
      'bitmap',
      'editres',
      'viewres',
      'xev',
      'xgc',
      'xbiff',
      'xconsole',
      'xditview',
      'xclipboard',
      'xcutsel',
      'rofi',
      '9menu',
      'urclock',
      'xkbwatch',
      'xkbvleds',
    ]) {
      expect(DENY_LIST, c).not.toContain(c)
    }
  })

  it('has no duplicate entry across its classes (a command has one reason)', () => {
    expect(new Set(DENY_LIST).size).toBe(DENY_LIST.length)
  })

  it('is overridable by `show`, in the direction that matters', () => {
    const r = build({
      sectionX11: ['xdpyinfo'],
      overrides: { ...NO_OVERRIDES, show: ['xdpyinfo'] },
    })
    expect(ids(r.apps)).toEqual(['x11:xdpyinfo'])
  })

  it('applies to a .desktop entry too, so a deny cannot be smuggled in through a file', () => {
    const r = build({
      desktop: [desk('d', '[Desktop Entry]\nType=Application\nName=D\nExec=xdotool key a\n')],
    })
    expect(r.apps).toEqual([])
    expect(r.skipped).toContainEqual({ what: 'd', why: 'deny-list (query)' })
  })

  it('every class is non-empty and documented by name', () => {
    expect(Object.keys(DENY_CLASSES).sort()).toEqual(['benchmark', 'needs-args', 'query', 'server'])
    for (const [cls, list] of Object.entries(DENY_CLASSES))
      expect(list.length, cls).toBeGreaterThan(0)
  })
})

describe('source 3 — the user override file', () => {
  it('parses the four verbs, with comments and blank lines', () => {
    const o = parseOverrides(
      [
        '# even-window overrides',
        '',
        'hide xeyes',
        'show xdpyinfo',
        'app Clock = xclock -digital',
        'term Top = top',
      ].join('\n'),
    )
    expect(o.hide).toEqual(['xeyes'])
    expect(o.show).toEqual(['xdpyinfo'])
    expect(o.add).toEqual([
      { name: 'Clock', argv: ['xclock', '-digital'], terminal: false },
      { name: 'Top', argv: ['top'], terminal: true },
    ])
    expect(o.errors).toEqual([])
  })

  it('reports a bad line instead of ignoring it (a typo must not be silent)', () => {
    const o = parseOverrides('hide\nnope x\napp = x\napp Name\napp Name =\n')
    expect(o.errors).toEqual([
      'line 1: `hide` needs a value',
      'line 2: unknown directive `nope`',
      'line 3: `app` needs `<name> = <command>`',
      'line 4: `app` needs `<name> = <command>`',
      'line 5: `app` needs both a name and a command',
    ])
    expect(o.add).toEqual([])
  })

  it('keeps a quoted argument together and never interprets shell syntax', () => {
    const o = parseOverrides('app Term = xterm -fa "DejaVu Sans Mono" -e "sh -c date"\n')
    expect(o.add[0]?.argv).toEqual(['xterm', '-fa', 'DejaVu Sans Mono', '-e', 'sh -c date'])
    // The `;` and `|` below are ordinary characters: argv goes to execvp, never to a shell.
    const risky = parseOverrides('app X = echo a;rm -rf / | cat\n')
    expect(risky.add[0]?.argv).toEqual(['echo', 'a;rm', '-rf', '/', '|', 'cat'])
  })

  it('a user entry is included even when the deny-list would refuse the command', () => {
    // `show` un-denies a scanned command; an explicit `app` line is the user naming an argv,
    // which is their own configuration (same standing as EW_SPAWN).
    const r = build({
      overrides: { ...NO_OVERRIDES, add: [{ name: 'Info', argv: ['xdpyinfo'], terminal: true }] },
    })
    expect(r.apps).toEqual([
      {
        id: 'user:info',
        name: 'Info',
        cmd: 'xdpyinfo',
        args: [],
        note: 'user',
        terminal: true,
      },
    ])
  })

  it('hides by id, by command or by name — whichever the user can see', () => {
    const src = { sectionX11: ['xcalc', 'xeyes', 'xclock'] }
    expect(
      ids(build({ ...src, overrides: { ...NO_OVERRIDES, hide: ['x11:xcalc'] } }).apps),
    ).toEqual(['x11:xclock', 'x11:xeyes'])
    expect(ids(build({ ...src, overrides: { ...NO_OVERRIDES, hide: ['XEYES'] } }).apps)).toEqual([
      'x11:xcalc',
      'x11:xclock',
    ])
    const app: LauncherEntry = {
      id: 'desktop:a',
      name: 'Alpha',
      cmd: 'alpha',
      args: [],
      note: 'desktop',
      terminal: false,
    }
    expect(overrideMatches('alpha', app)).toBe(true)
    expect(overrideMatches(' ALPHA ', app)).toBe(true)
    expect(overrideMatches('desktop:a', app)).toBe(true)
    expect(overrideMatches('alph', app)).toBe(false)
    expect(overrideMatches('', app)).toBe(false)
  })

  it('counts what it hid, so `GET /api/apps` can explain a short list', () => {
    const r = build({
      sectionX11: ['xcalc', 'xeyes'],
      overrides: { ...NO_OVERRIDES, hide: ['xeyes'] },
    })
    expect(r.counts.hidden).toBe(1)
    expect(r.skipped).toContainEqual({ what: 'x11:xeyes', why: 'hidden by apps.conf' })
  })
})

describe('dedupe and ordering', () => {
  it('prefers the .desktop copy of a duplicate argv, for its human name', () => {
    const r = build({
      desktop: [
        desk(
          'rxvt-unicode',
          '[Desktop Entry]\nType=Application\nName=Rxvt Color Unicode Terminal\nExec=urxvt\n',
        ),
      ],
      sectionX11: ['urxvt'],
    })
    expect(names(r.apps)).toEqual(['Rxvt Color Unicode Terminal'])
    expect(r.counts.duplicates).toBe(1)
  })

  it('prefers a user entry over both', () => {
    const r = build({
      desktop: [
        desk('debian-xterm', '[Desktop Entry]\nType=Application\nName=XTerm\nExec=xterm\n'),
      ],
      sectionX11: ['xterm'],
      overrides: {
        ...NO_OVERRIDES,
        add: [{ name: 'My Terminal', argv: ['xterm'], terminal: false }],
      },
    })
    expect(names(r.apps)).toEqual(['My Terminal'])
  })

  it('does not dedupe entries whose argv differs — different flags are different apps', () => {
    const r = build({
      desktop: [
        desk('a', '[Desktop Entry]\nType=Application\nName=Plain\nExec=xterm\n'),
        desk(
          'b',
          '[Desktop Entry]\nType=Application\nName=Unicode\nExec=xterm -class UXTerm -u8\n',
        ),
      ],
    })
    expect(names(r.apps).sort()).toEqual(['Plain', 'Unicode'])
    expect(r.counts.duplicates).toBe(0)
  })

  it('sorts by display name so the phone list is predictable under a filter', () => {
    const r = build({ sectionX11: ['xlogo', 'bitmap', 'oclock'] })
    expect(names(r.apps)).toEqual(['bitmap', 'oclock', 'xlogo'])
  })
})

describe('launching', () => {
  it('wraps a Terminal=true entry in the default client, not a bare xterm', () => {
    // A bare `xterm -e vim` is black-on-white, which lights the whole see-through lens. The
    // wrapper is DEFAULT_SPAWN_ARGV + '-e'.
    const wrap = terminalWrapperArgv()
    expect(wrap.slice(0, -1)).toEqual([...DEFAULT_SPAWN_ARGV])
    expect(wrap[wrap.length - 1]).toBe('-e')
    expect(wrap).toContain('black')
    const app: LauncherEntry = {
      id: 'u:v',
      name: 'Vim',
      cmd: 'vim',
      args: ['-R'],
      note: 'user',
      terminal: true,
    }
    expect(launchArgv(app)).toEqual([...wrap, 'vim', '-R'])
  })

  it('passes a non-terminal entry through unchanged', () => {
    const app: LauncherEntry = {
      id: 'x11:xcalc',
      name: 'xcalc',
      cmd: 'xcalc',
      args: [],
      note: 'section-x11',
      terminal: false,
    }
    expect(launchArgv(app)).toEqual(['xcalc'])
  })
})

describe('the live scan', () => {
  it('lists the XDG application directories, user first', () => {
    const dirs = desktopDirs({ HOME: '/home/u', XDG_DATA_DIRS: '/usr/local/share:/usr/share' })
    expect(dirs[0]).toBe('/home/u/.local/share/applications')
    expect(dirs).toContain('/usr/share/applications')
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it.skipIf(!existsSync('/usr/bin/dpkg-query'))(
    'finds Section: x11 commands that link libX11 on this (Debian) host',
    async () => {
      const cmds = await scanSectionX11()
      expect(cmds.length).toBeGreaterThan(20)
      // Includes plain X clients and excludes anything that is not an X client.
      for (const c of ['xterm', 'xfontsel', 'xcalc', 'oclock', 'rofi']) expect(cmds, c).toContain(c)
      expect(cmds).not.toContain('ffmpeg')
      expect(cmds).not.toContain('X11') // /usr/bin/X11 is a directory symlink
      expect([...cmds].sort()).toEqual(cmds) // sorted and deduped
    },
    60_000,
  )

  it.skipIf(existsSync('/usr/bin/dpkg-query'))(
    'degrades to an empty section list where dpkg-query does not exist',
    async () => {
      expect(await scanSectionX11()).toEqual([])
    },
  )
})
