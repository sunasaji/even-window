// The application list: what the nested X can be told to launch (docs/platform.md).
//
// Sources: `.desktop` files ∪ (Debian `Section: x11` packages whose binaries link libX11),
// minus the shipped deny-list, plus and minus the user's apps.conf. `.desktop` alone is not
// enough: most plain X clients (the x11-apps suite) ship none. Without `dpkg-query` the section
// source yields nothing and the list degrades to `.desktop` + the user's entries.
//
// Not a security control: `POST /api/spawn` launches only entries of this list, but the list
// can contain shells and launchers such as `env`. Authentication is the only boundary
// (docs/security.md).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { LauncherEntry } from '../../../shared/types.ts'
import { appStateDir } from '../../stateDir.ts'
import type { AppScan } from '../types.ts'
import {
  type DesktopFile,
  expandFieldCodes,
  localesFromEnv,
  parseDesktopFile,
  splitExec,
} from './desktop.ts'
import { DEFAULT_SPAWN_ARGV } from './session.ts'
import { run } from './xenv.ts'

// The shipped deny-list: `Section: x11` commands that are not applications, grouped by the
// reason they map no usable window. It is a default, not a policy: `show <cmd>` in apps.conf
// takes an entry back.
export const DENY_CLASSES: Readonly<Record<string, readonly string[]>> = {
  // X servers, daemons and window managers. A second WM fights ratpoison for the nested
  // screen, another X server inside the capture is meaningless, and a daemon maps nothing.
  server: [
    'Xephyr',
    'Xvfb',
    'Xorg',
    'X',
    'xinit',
    'startx',
    'ratpoison',
    'ratmenu',
    'urxvtd',
    'xkbevd',
    'dbus-launch',
    'xcompmgr',
  ],
  // One-shot tools: they print to stdout or change a server setting, then exit. A few
  // (`xprop`, `xwd`, `xkill`) wait for a click on a target window and look hung.
  query: [
    'appres',
    'listres',
    'bmtoa',
    'setxkbmap',
    'xauth',
    'xcmsdb',
    'xcursorgen',
    'xdotool',
    'xdpyinfo',
    'xdriinfo',
    'xgamma',
    'xhost',
    'xkbbell',
    'xkbcomp',
    'xkbprint',
    'xkill',
    'xlsatoms',
    'xlsclients',
    'xlsfonts',
    'xinput',
    'xbacklight',
    'xmodmap',
    'xprop',
    'xrandr',
    'xrdb',
    'xrefresh',
    'xsel',
    'xset',
    'xsetmode',
    'xsetpointer',
    'xsetroot',
    'xstdcmap',
    'xvidtune',
    'xvinfo',
    'xwd',
    'xwininfo',
    'xwud',
  ],
  // Benchmarks and load generators. They map a window but repaint continuously, so every frame
  // dirties all four tiles and spends tile bandwidth on output that carries no information.
  benchmark: ['ico', 'rendercheck', 'x11perf'],
  // Programs that need an argument a glasses menu cannot supply: a font name (`xfd`), a
  // message (`xmessage`), a file (`xmore`) or a pointer-selected region (`xmag`, `transset`).
  'needs-args': ['xfd', 'xmessage', 'xmore', 'xmag', 'transset'],
}

/** Flattened deny-list. */
export const DENY_LIST: readonly string[] = Object.values(DENY_CLASSES).flat()

/** Which class denied a command, for `GET /api/apps`. */
export function denyClass(cmd: string): string | null {
  for (const [cls, list] of Object.entries(DENY_CLASSES)) if (list.includes(cmd)) return cls
  return null
}

// The user's override file (docs/configuration.md). One directive per line, `#` comments:
//
//   hide <id | command | name>     drop a scanned entry
//   show <command>                 take a command back off the shipped deny-list
//   app  <name> = <argv>           add an entry
//   term <name> = <argv>           add an entry that needs a terminal wrapper
//
// Nothing is interpreted as code or handed to a shell: the value after `=` is split by the
// Desktop Entry argv rules and exec'd directly. The file is hand-written only; this program
// never rewrites it (launch recency lives in a separate file).
export const OVERRIDE_FILE = 'apps.conf'

export interface Overrides {
  hide: string[]
  show: string[]
  add: { name: string; argv: string[]; terminal: boolean }[]
  /** Unparseable lines, reported through `GET /api/apps` rather than ignored: a typo in a hide
   *  rule is otherwise invisible. */
  errors: string[]
}

/** Pure. Never throws; a bad line becomes an `errors` entry. */
export function parseOverrides(text: string): Overrides {
  const out: Overrides = { hide: [], show: [], add: [], errors: [] }
  let n = 0
  for (const raw of text.split('\n')) {
    n++
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const sp = line.search(/\s/)
    const verb = (sp < 0 ? line : line.slice(0, sp)).toLowerCase()
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim()
    if (verb === 'hide' || verb === 'show') {
      if (!rest) {
        out.errors.push(`line ${n}: \`${verb}\` needs a value`)
        continue
      }
      out[verb].push(rest)
      continue
    }
    if (verb === 'app' || verb === 'term') {
      const eq = rest.indexOf('=')
      if (eq <= 0) {
        out.errors.push(`line ${n}: \`${verb}\` needs \`<name> = <command>\``)
        continue
      }
      const name = rest.slice(0, eq).trim()
      const argv = splitExec(rest.slice(eq + 1).trim())
      if (!name || argv.length === 0 || !argv[0]) {
        out.errors.push(`line ${n}: \`${verb}\` needs both a name and a command`)
        continue
      }
      out.add.push({ name, argv, terminal: verb === 'term' })
      continue
    }
    out.errors.push(`line ${n}: unknown directive \`${verb}\``)
  }
  return out
}

// ── building the list (pure) ────────────────────────────────────────────────────────────────

/** One `.desktop` file as the scanner found it. */
export interface DesktopInput {
  /** Desktop file id: the basename without `.desktop` (`com.gexperts.Tilix`). */
  id: string
  path: string
  text: string
}

export interface BuildInput {
  desktop: readonly DesktopInput[]
  /** Commands from `Section: x11` ∧ libX11. */
  sectionX11: readonly string[]
  overrides: Overrides
  locales: readonly string[]
  /** Is this command on $PATH? Used for `TryExec`. Injected so the build stays pure. */
  onPath: (cmd: string) => boolean
}

/** Where this backend finds an entry, which is also what it puts in `LauncherEntry.note`: `desktop` = an XDG `.desktop` file, `section-x11` = a
 *  Debian `Section: x11` package whose binary links libX11, `user` = an `apps.conf` entry.
 *  Ids are `desktop:<file id>`, `x11:<command>` and `user:<slug>`. */
export type AppSource = 'desktop' | 'section-x11' | 'user'

/** What a scan produced: the seam's `AppScan`, with this backend's own count names. */
export type BuildResult = AppScan & {
  counts: {
    desktopFiles: number
    desktopApps: number
    sectionX11: number
    sectionX11Kept: number
    denied: number
    user: number
    hidden: number
    duplicates: number
    total: number
  }
}

/** Stable id for a scanned entry. The `.desktop` id and the command name are stable across
 *  rescans and reboots, which the recency list and the user's `hide` rules key on. */
function appId(source: AppSource, key: string): string {
  return `${source === 'section-x11' ? 'x11' : source}:${key}`
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'app'
  )
}

/** The argv key two entries are duplicates on. */
function argvKey(app: LauncherEntry): string {
  return [app.cmd, ...app.args].join('\u0000')
}

/** Does an override token name this app? Matches the id, the command or the display name,
 *  case-insensitively — a user hiding something types whichever of the three they can see. */
export function overrideMatches(token: string, app: LauncherEntry): boolean {
  const t = token.trim().toLowerCase()
  if (!t) return false
  return t === app.id.toLowerCase() || t === app.cmd.toLowerCase() || t === app.name.toLowerCase()
}

/** Pure: sources + overrides → the effective list. */
export function buildAppList(input: BuildInput): BuildResult {
  const skipped: { what: string; why: string }[] = []
  const apps: LauncherEntry[] = []
  const shown = new Set(input.overrides.show.map(s => s.trim()))
  const denied = (cmd: string): boolean => !shown.has(cmd) && DENY_LIST.includes(cmd)

  // ── source 1: .desktop ────────────────────────────────────────────────────────────────────
  let desktopApps = 0
  for (const f of input.desktop) {
    let parsed: DesktopFile
    try {
      parsed = parseDesktopFile(f.text, input.locales)
    } catch {
      parsed = { entry: null, actions: [] }
    }
    const e = parsed.entry
    if (!e) {
      skipped.push({ what: f.id, why: 'no [Desktop Entry] group' })
      continue
    }
    // Type: only Application is launchable. Link and Directory are not programs.
    if (e.type && e.type !== 'Application') {
      skipped.push({ what: f.id, why: `Type=${e.type}` })
      continue
    }
    if (e.hidden) {
      skipped.push({ what: f.id, why: 'Hidden=true (deleted)' })
      continue
    }
    // NoDisplay=true means the entry exists to claim a MIME type or URL scheme, not to be
    // shown in a menu; launched bare it does nothing.
    if (e.noDisplay) {
      skipped.push({ what: f.id, why: 'NoDisplay=true' })
      continue
    }
    // OnlyShowIn / NotShownIn are deliberately ignored: we are not a registered desktop
    // environment, so no `OnlyShowIn` value can match and honouring it would silently drop
    // every entry carrying one. `NoDisplay` is honoured, and apps.conf can hide the rest.
    const argv0 = splitExec(e.exec)
    if (argv0.length === 0) {
      skipped.push({ what: f.id, why: 'no Exec' })
      continue
    }
    // TryExec names the binary whose presence decides whether the entry is live.
    if (e.tryExec) {
      const ok = isAbsolute(e.tryExec) ? existsSync(e.tryExec) : input.onPath(e.tryExec)
      if (!ok) {
        skipped.push({ what: f.id, why: `TryExec not found: ${e.tryExec}` })
        continue
      }
    }
    const argv = expandFieldCodes(argv0, { icon: e.icon, name: e.name || f.id, path: f.path })
    const cmd = argv[0]
    if (!cmd) {
      skipped.push({ what: f.id, why: 'Exec expanded to nothing' })
      continue
    }
    if (denied(cmd)) {
      skipped.push({ what: f.id, why: `deny-list (${denyClass(cmd) ?? '?'})` })
      continue
    }
    apps.push({
      id: appId('desktop', f.id),
      name: e.name || f.id,
      cmd,
      args: argv.slice(1),
      note: 'desktop',
      terminal: e.terminal,
    })
    desktopApps++
    // Actions are not listed: they are variant launches of the same program and are not
    // reliably nameable. They are recorded as skipped so the omission can be explained.
    for (const a of parsed.actions) {
      skipped.push({ what: `${f.id} [Desktop Action ${a.id}]`, why: 'action, not an application' })
    }
  }

  // ── source 2: Section: x11 ∧ libX11 ───────────────────────────────────────────────────────
  let sectionKept = 0
  let deniedCount = 0
  for (const cmd of input.sectionX11) {
    if (denied(cmd)) {
      deniedCount++
      continue
    }
    apps.push({
      id: appId('section-x11', cmd),
      name: cmd,
      cmd,
      args: [],
      note: 'section-x11',
      terminal: false,
    })
    sectionKept++
  }

  // ── source 3: the user's own entries (always win) ──────────────────────────────────────────
  for (const a of input.overrides.add) {
    const cmd = a.argv[0]
    if (!cmd) continue
    apps.push({
      id: appId('user', slug(a.name)),
      name: a.name,
      cmd,
      args: a.argv.slice(1),
      note: 'user',
      terminal: a.terminal,
    })
  }

  // ── dedupe ────────────────────────────────────────────────────────────────────────────────
  // Duplicates share an argv. The `.desktop` copy beats the section scan because it carries a
  // human name; a `user` entry beats both, since the user wrote it on purpose.
  const rank: Record<string, number> = { user: 0, desktop: 1, 'section-x11': 2 }
  const best = new Map<string, LauncherEntry>()
  let duplicates = 0
  for (const a of apps) {
    const k = argvKey(a)
    const prev = best.get(k)
    if (!prev) {
      best.set(k, a)
      continue
    }
    duplicates++
    if ((rank[a.note] ?? 9) < (rank[prev.note] ?? 9)) best.set(k, a)
  }

  // ── hide ──────────────────────────────────────────────────────────────────────────────────
  let hidden = 0
  const kept: LauncherEntry[] = []
  for (const a of best.values()) {
    if (input.overrides.hide.some(t => overrideMatches(t, a))) {
      hidden++
      skipped.push({ what: a.id, why: 'hidden by apps.conf' })
      continue
    }
    kept.push(a)
  }

  // Alphabetical by display name: the phone list has a filter box, so the only ordering that
  // helps is the one you can predict. Ties break on id so a rescan cannot reorder the list.
  kept.sort(
    (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
  )

  return {
    apps: kept,
    counts: {
      desktopFiles: input.desktop.length,
      desktopApps,
      sectionX11: input.sectionX11.length,
      sectionX11Kept: sectionKept,
      denied: deniedCount,
      user: input.overrides.add.length,
      hidden,
      duplicates,
      total: kept.length,
    },
    summary:
      `${kept.length} launchable (${desktopApps} .desktop, ` +
      `${sectionKept}/${input.sectionX11.length} Section:x11, ${input.overrides.add.length} user; ` +
      `${deniedCount} denied, ${hidden} hidden, ${duplicates} dup)`,
    skipped,
    errors: input.overrides.errors,
  }
}

// ── launching ───────────────────────────────────────────────────────────────────────────────

/** `Terminal=true` entries are wrapped in the default client's argv (docs/configuration.md),
 *  not a bare `xterm`, which would be black-on-white and light the whole see-through lens. */
export function terminalWrapperArgv(): string[] {
  return [...DEFAULT_SPAWN_ARGV, '-e']
}

/** The command of the default client, whose entry seeds the launch-recency list
 *  (src/server/appRecency.ts). */
export function seedCommand(): string {
  return DEFAULT_SPAWN_ARGV[0] ?? ''
}

/** The argv `POST /api/spawn` will exec for an entry. */
export function launchArgv(app: LauncherEntry): string[] {
  const own = [app.cmd, ...app.args]
  return app.terminal ? [...terminalWrapperArgv(), ...own] : own
}

// The cache. A full scan runs `dpkg-query`, `dpkg -L` and `ldd` and takes about a second, so
// the result is cached for the process, prewarmed at boot, and refreshed when apps.conf's
// mtime changes (one `stat` per read) or `GET /api/apps?rescan=1` asks for it.

/** Where the user's override file is; also what `GET /api/apps` reports. */
export function overridesPath(): string {
  return join(appStateDir(), OVERRIDE_FILE)
}

function readOverrides(): { overrides: Overrides; mtimeMs: number } {
  const p = overridesPath()
  try {
    const st = statSync(p)
    return { overrides: parseOverrides(readFileSync(p, 'utf8')), mtimeMs: st.mtimeMs }
  } catch {
    // No file is the normal case, not an error.
    return { overrides: { hide: [], show: [], add: [], errors: [] }, mtimeMs: 0 }
  }
}

/** XDG application directories, most specific first (the user's own wins a dedupe tie). */
export function desktopDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir()
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  const out: string[] = [join(dataHome, 'applications')]
  for (const d of dataDirs) out.push(join(d, 'applications'))
  return [...new Set(out)]
}

function readDesktopInputs(): DesktopInput[] {
  const seen = new Set<string>()
  const out: DesktopInput[] = []
  for (const dir of desktopDirs()) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names.sort()) {
      if (!n.endsWith('.desktop')) continue
      const id = n.slice(0, -'.desktop'.length)
      // Per the spec, a `.desktop` id found in an earlier directory shadows the later one —
      // which is how a user overrides a system entry by filename alone.
      if (seen.has(id)) continue
      seen.add(id)
      const path = join(dir, n)
      try {
        out.push({ id, path, text: readFileSync(path, 'utf8') })
      } catch {
        /* unreadable */
      }
    }
  }
  return out
}

/** Is `cmd` on $PATH and executable? For `TryExec`. */
function onPath(cmd: string): boolean {
  if (cmd.includes('/')) return existsSync(cmd)
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    try {
      if (statSync(join(dir, cmd)).isFile()) return true
    } catch {
      /* next */
    }
  }
  return false
}

/** Commands from Debian's `Section: x11` whose binary links libX11. Three child processes in
 *  total: `dpkg -L` and `ldd` take many arguments, and `ldd` prefixes each file with `<path>:`
 *  when given more than one. `ldd` reports the transitive closure, which is wanted (`rofi`
 *  reaches libX11 through other libraries). Returns [] on a host without `dpkg-query`. */
export async function scanSectionX11(): Promise<string[]> {
  const q = await run('dpkg-query', ['-W', '-f=${Package}|${Section}|${Status}\n'], 15_000)
  if (q.code !== 0 || !q.out.trim()) return []
  const pkgs: string[] = []
  for (const line of q.out.split('\n')) {
    const [pkg, section, status] = line.split('|')
    if (!pkg || section !== 'x11' || !status?.includes('installed')) continue
    pkgs.push(pkg)
  }
  if (!pkgs.length) return []

  const files = await run('dpkg', ['-L', ...pkgs], 20_000)
  const bins: string[] = []
  for (const f of files.out.split('\n')) {
    const p = f.trim()
    if (!/^\/(usr\/)?s?bin\/|^\/usr\/games\//.test(p)) continue
    // `/usr/bin/X11` is a directory symlink in x11-common and would otherwise be "executable".
    try {
      if (!statSync(p).isFile()) continue
    } catch {
      continue
    }
    bins.push(p)
  }
  if (!bins.length) return []

  const ldd = await run('ldd', bins, 30_000)
  const out = new Set<string>()
  let cur = ''
  for (const line of ldd.out.split('\n')) {
    const head = /^(\/\S+):$/.exec(line.trim())
    if (head?.[1]) {
      cur = head[1]
      continue
    }
    if (cur && line.includes('libX11.so')) {
      out.add(cur.slice(cur.lastIndexOf('/') + 1))
      cur = '' // one hit per file is enough
    }
  }
  // A single-file `ldd` prints no `<path>:` header, so handle that shape too.
  if (bins.length === 1 && out.size === 0 && ldd.out.includes('libX11.so')) {
    const only = bins[0]
    if (only) out.add(only.slice(only.lastIndexOf('/') + 1))
  }
  return [...out].sort()
}

interface Cache {
  result: BuildResult
  overrideMtimeMs: number
  sectionX11: string[]
  scannedAt: number
}
let cache: Cache | null = null

async function scan(): Promise<Cache> {
  const { overrides, mtimeMs } = readOverrides()
  const sectionX11 = await scanSectionX11()
  const result = buildAppList({
    desktop: readDesktopInputs(),
    sectionX11,
    overrides,
    locales: localesFromEnv(process.env),
    onPath,
  })
  return { result, overrideMtimeMs: mtimeMs, sectionX11, scannedAt: Date.now() }
}

/** The cached list. Rebuilds (without re-running dpkg) when apps.conf changed on disk. */
export async function appList(force = false): Promise<BuildResult> {
  if (force || !cache) {
    cache = await scan()
    return cache.result
  }
  let mtimeMs = 0
  try {
    mtimeMs = statSync(overridesPath()).mtimeMs
  } catch {
    mtimeMs = 0
  }
  if (mtimeMs !== cache.overrideMtimeMs) {
    const { overrides } = readOverrides()
    cache = {
      ...cache,
      overrideMtimeMs: mtimeMs,
      result: buildAppList({
        desktop: readDesktopInputs(),
        sectionX11: cache.sectionX11,
        overrides,
        locales: localesFromEnv(process.env),
        onPath,
      }),
    }
  }
  return cache.result
}

/** Drop the cache (tests, and `?rescan=1`). */
export function resetAppCache(): void {
  cache = null
}

/** Find an entry by id. */
export async function appById(id: string): Promise<LauncherEntry | null> {
  const { apps } = await appList()
  return apps.find(a => a.id === id) ?? null
}
