// Enumerate, switch, close and spawn windows in the nested X server (the X11 backend's
// `WindowControl`). Identity caching, focus recency and launch attribution are OS-neutral and
// live in src/server/windows.ts.
//
// All window management goes through ratpoison's command socket, never EWMH: ratpoison sets no
// _NET_ACTIVE_WINDOW, so `xdotool getactivewindow` / `windowactivate` do not work. Window
// numbers are recycled, so an wid is resolved to a number by re-listing on every call.

import { spawn } from 'node:child_process'
import type { WinInfo } from '../../../shared/types.ts'
import type { WinIdent, WinSel } from '../types.ts'
import { commOfPid, exeOfPid } from './proc.ts'
import { childEnv, run, SPAWN_CWD } from './xenv.ts'

/** Normalise an X window id (decimal from ratpoison `%i`, hex from the wire) to lowercase
 *  "0x…" so the two spellings compare equal. Returns '' when it is not a number at all. */
export function normXid(v: string | number | undefined): string {
  if (v == null) return ''
  const s = String(v).trim()
  if (!s) return ''
  const n = /^0x/i.test(s) ? Number.parseInt(s, 16) : Number(s)
  if (!Number.isInteger(n) || n < 0) return ''
  return '0x' + n.toString(16)
}

/** ratpoison's `%c` for a window with no WM_CLASS is the literal string `None`. It is read as
 *  absent: `cls` keys a swipe binding (docs/glasses.md), and a class named `none` would be one
 *  key shared by every class-less app. A real WM_CLASS of "None" is given up deliberately. */
function ratpoisonClass(v: string | undefined): string {
  const s = (v ?? '').trim()
  return s === 'None' ? '' : s
}

/** Pure: parse `ratpoison -c 'windows %n|%s|%i|%c|%t'` output into WinInfo[].
 *  Format is number | status ('*' = current) | X id (decimal) | WM_CLASS | title.
 *  Unparseable lines (including ratpoison's "No managed windows") are skipped. */
export function parseRatpoisonWindows(out: string): WinInfo[] {
  const list: WinInfo[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    // The title (%t) is last and may itself contain '|', so re-join everything past field 4.
    const parts = line.split('|')
    if (parts.length < 5) continue
    const id = (parts[0] ?? '').trim()
    const wid = normXid(parts[2])
    if (!/^\d+$/.test(id) || !wid) continue
    const title = parts.slice(4).join('|').trim()
    list.push({
      id,
      wid,
      cls: ratpoisonClass(parts[3]),
      title: title || `win ${id}`,
      active: (parts[1] ?? '').trim() === '*',
    })
  }
  return list
}

/** Fire a single `ratpoison -c <cmd>` and report whether it exited 0. */
async function ratpoison(cmd: string): Promise<boolean> {
  const { code } = await run('ratpoison', ['-c', cmd], 3000)
  return code === 0
}

const EMPTY_IDENT: WinIdent = { pid: 0, comm: '', exe: '' }

/** Pure: pull the argv out of `xprop -id <w> WM_COMMAND` output, e.g.
 *  `WM_COMMAND(STRING) = { "/usr/bin/xterm", "-bg", "black" }`. Clients that publish no
 *  `_NET_WM_PID` often still set this ICCCM property. `[]` when absent or unparseable. */
export function parseWmCommand(out: string): string[] {
  const eq = out.indexOf('=')
  if (eq < 0 || !out.slice(0, eq).includes('WM_COMMAND')) return []
  const args: string[] = []
  // Quoted, comma-separated. Escaped quotes are not produced by xprop for argv strings in
  // practice, but a backslash before a quote is honoured anyway so one cannot end the list.
  const re = /"((?:[^"\\]|\\.)*)"/g
  for (const m of out.slice(eq).matchAll(re)) args.push((m[1] ?? '').replace(/\\(.)/g, '$1'))
  return args
}

/** Resolve a window's identity: pid → comm + exe, falling back to WM_COMMAND for windows that
 *  expose no pid. Up to two spawns; src/server/windows.ts caches the result for the window's
 *  life. */
export async function identify(wid: string): Promise<WinIdent> {
  const dec = String(Number.parseInt(wid, 16))
  const r = await run('xdotool', ['getwindowpid', dec], 2000)
  const pid = r.code === 0 ? Number(r.out.trim()) : 0
  if (Number.isInteger(pid) && pid > 0) {
    return { pid, comm: commOfPid(pid), exe: exeOfPid(pid) }
  }
  // No `_NET_WM_PID`. An absolute argv[0] is as good an identity as the exe symlink, and a
  // relative one still names the program.
  const x = await run('xprop', ['-id', dec, 'WM_COMMAND'], 2000)
  const argv = x.code === 0 ? parseWmCommand(x.out) : []
  const a0 = argv[0] ?? ''
  if (!a0) return EMPTY_IDENT
  const base = a0.slice(a0.lastIndexOf('/') + 1).toLowerCase()
  return { pid: 0, comm: base, exe: a0.startsWith('/') ? a0 : '' }
}

/** The window that has input focus right now, as a normalised wid; '' when xdotool cannot say.
 *  Uses `getwindowfocus` (input focus), not `getactivewindow`, which needs the EWMH
 *  `_NET_ACTIVE_WINDOW` property that ratpoison never sets. */
export async function focusedId(): Promise<string> {
  const { out, code } = await run('xdotool', ['getwindowfocus'], 2000)
  return code === 0 ? normXid(out.trim()) : ''
}

/** The WM's managed windows, in ratpoison's own (number) order. No identity, no side effects. */
export async function enumerate(): Promise<WinInfo[]> {
  const { out } = await run('ratpoison', ['-c', 'windows %n|%s|%i|%c|%t'], 3000)
  return parseRatpoisonWindows(out)
}

/** Switch the WM to a window. An `wid` selector is resolved to the window's current ratpoison
 *  number by re-listing: numbers are recycled, so a cached mapping can point at a different
 *  window. The switch is `ratpoison -c 'select N'`; `xdotool windowactivate` needs EWMH. */
export async function x11SelectWindow(sel: WinSel): Promise<boolean> {
  let n = typeof sel.sel === 'string' && /^\d+$/.test(sel.sel.trim()) ? sel.sel.trim() : ''
  if (!n) {
    const want = normXid(sel.wid)
    if (!want) return false
    const w = (await enumerate()).find(w => w.wid === want)
    if (!w) return false
    n = w.id
  }
  return ratpoison(`select ${n}`)
}

/** Close a window gracefully: ratpoison `delete` sends WM_DELETE_WINDOW so the app can clean
 *  up and exit itself; never `kill`, which force-destroys the client. With no selector it
 *  closes the current window; a selector switches to that window first. */
export async function x11CloseWindow(sel?: WinSel): Promise<boolean> {
  if (sel && (sel.sel || sel.wid)) {
    if (!(await x11SelectWindow(sel))) return false
  }
  return ratpoison('delete')
}

/** Spawn a new X client into the running nested session and return its pid (0 on failure);
 *  src/server/launches.ts uses the pid to attribute the window to an app
 *  (docs/decisions/window-identity-without-stamping.md). Detached and unref'd: the X stack
 *  outlives this process (docs/platform.md), so the client must not die with it nor keep the
 *  event loop alive. argv is passed verbatim, with no shell. cwd is SPAWN_CWD, the same
 *  directory the start-up client and ratpoison's `C-t c` use. */
export function x11Spawn(cmd: string, args: readonly string[] = []): number {
  const c = cmd.trim()
  if (!c) return 0
  try {
    const p = spawn(c, [...args], {
      env: childEnv(),
      cwd: SPAWN_CWD,
      stdio: 'ignore',
      detached: true,
    })
    p.on('error', () => {
      /* reported via the next window poll showing no new window */
    })
    if (!p.pid) return 0
    p.unref()
    return p.pid
  } catch {
    return 0
  }
}
