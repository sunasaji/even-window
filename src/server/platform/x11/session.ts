// Nested-X lifecycle and screen capture (the X11 backend's `DisplaySession`).
//
// Runs a 576x288 nested X server (the glasses' screen size) with ratpoison as a monocle WM,
// launches a client into it, and captures the root framebuffer with ffmpeg x11grab. Each raw
// rgb24 frame goes to the session sink (src/server/tiles.ts).
//
// Lifetime rule (docs/platform.md, docs/decisions/display-session-outlives-server.md): the X
// server, WM and clients are spawned detached and outlive this process; only ffmpeg dies with
// it. A restart reattaches to the X recorded in the state file and respawns ffmpeg only, and
// stopCapture() kills ffmpeg and nothing else.

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'
import { FRAME_BYTES, SCREEN_H, SCREEN_W } from '../../../shared/geom.ts'
import type { Avail, SessionInfo } from '../../../shared/types.ts'
import type { SessionSink } from '../types.ts'
import { childEnv, DISPLAY, FPS, HOST_DISPLAY, RUNTIME_DIR, run, SPAWN_CWD } from './xenv.ts'

type Backend = 'Xephyr' | 'Xvfb'

const STATE_FILE = join(RUNTIME_DIR, 'session.json')
const RC_FILE = join(RUNTIME_DIR, 'ratpoisonrc')

// The default client. The G2 is an optical see-through display: a black pixel is transparent
// and a bright one emits, so the mirrored client must be light-on-dark and the colours are
// spelled out (a stock xterm is black-on-white). xterm rather than urxvt because it falls back
// to `fixed` when a font is missing instead of exiting. The font is a core bitmap face (never
// antialiased) giving 64x16 cells; its XLFD has no whitespace or shell metacharacter, which
// DEFAULT_SPAWN_CMD relies on. `-bw 0 -b 0 +sb` remove border, margin and scrollbar; `-cr white`
// makes the cursor an emitting block. See docs/decisions/default-terminal-client.md.
export const DEFAULT_SPAWN_ARGV: readonly string[] = [
  'xterm',
  '-bg',
  'black',
  '-fg',
  'white',
  '-cr',
  'white',
  '-fn',
  '-misc-fixed-bold-r-normal--18-120-100-100-c-90-iso10646-1',
  '-bw',
  '0',
  '-b',
  '0',
  '+sb',
]

/** The same default as one string, for the two call sites that take a shell command line
 *  (`sh -c` in ensureClient, and ratpoison's `alias pwterm exec …`); the argv form wraps
 *  terminal applications (./apps.ts). Lossless only because no
 *  token in DEFAULT_SPAWN_ARGV contains whitespace or shell syntax, which a unit test pins. */
export const DEFAULT_SPAWN_CMD: string = DEFAULT_SPAWN_ARGV.join(' ')

/** Pure: PINHOLE_SPAWN as its commands. `;` separates them, also inside quotes: each part is
 *  one `sh -c` line of its own, so a command that needs a literal `;` belongs in a script. */
export function splitSpawn(value: string): string[] {
  return value
    .split(';')
    .map(c => c.trim())
    .filter(c => c !== '')
}

/** Clients launched into a fresh/empty nested X so there is something to mirror. Empty disables.
 *  The first is also the "new terminal" of the menu (ratpoison's `c`). PINHOLE_SPAWN is the
 *  operator's configuration and is not validated. */
const SPAWN_LIST = splitSpawn(process.env.PINHOLE_SPAWN ?? DEFAULT_SPAWN_CMD)
const SPAWN_CMD = SPAWN_LIST[0] ?? ''

/** How long ensureClient waits for one client's window before starting the next. */
const SPAWN_MAP_WAIT_MS = 3000

/** Backend preference. Xephyr draws a window on the host desktop, so it is preferred when
 *  there is a host display and headless Xvfb otherwise; the other stays as the fallback on the
 *  same display. PINHOLE_BACKEND=xephyr|xvfb pins one with no fallback. Keyed on HOST_DISPLAY, not
 *  process.env.DISPLAY, which is absent under systemd. `host` is a seam for the tests. */
export function backendOrder(host: string | null = HOST_DISPLAY): Backend[] {
  const pin = (process.env.PINHOLE_BACKEND || 'auto').toLowerCase()
  if (pin === 'xephyr') return ['Xephyr']
  if (pin === 'xvfb') return ['Xvfb']
  return host ? ['Xephyr', 'Xvfb'] : ['Xvfb', 'Xephyr']
}

function logX(msg: string): void {
  console.log(`[x11] ${msg}`)
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── module state (single nested X per process) ──────────────────────────────────
interface Session {
  display: string // identity, e.g. ':100'
  displayEnv: string // how clients connect: ':100' (unix) or '127.0.0.1:100' (tcp-only)
  backend: Backend
  xPid: number // the nested X server's pid — detached, so this outlives us
  wmPid: number
  ffmpeg: ChildProcess | null
  acc: Buffer // ffmpeg stdout accumulator (frames arrive in arbitrary chunk sizes)
  stopping: boolean
}
let session: Session | null = null

/** Where frames and availability are reported: the OS-neutral side (src/server/tiles.ts and
 *  src/server/stream.ts), handed in by `startX11`. */
let sink: SessionSink | null = null

function setAvail(next: Avail): void {
  sink?.avail(next)
}

// ── display probing ─────────────────────────────────────────────────────────────
function displayNum(d: string): number {
  return Number(d.replace(/^:/, ''))
}
function xSocket(d: string): string {
  return `/tmp/.X11-unix/X${d.replace(/^:/, '')}`
}
function lockPath(d: string): string {
  return `/tmp/.X${displayNum(d)}-lock`
}

// Can we open the X TCP port (6000 + display)? This is the fallback transport: when
// /tmp/.X11-unix is not mode 1777 (some WSL/container setups) the X server serves TCP only and
// the unix socket never appears.
type TcpProbe = 'open' | 'refused' | 'silent' | 'error'

/** One connection attempt at the X TCP port. `refused` = nothing listens there (the answer is
 *  immediate); `silent` = no answer at all within 400 ms, which on loopback means the packets
 *  are being dropped. */
function tcpProbe(num: number): Promise<TcpProbe> {
  return new Promise(res => {
    const sock = netConnect(6000 + num, '127.0.0.1')
    const done = (r: TcpProbe): void => {
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      res(r)
    }
    sock.setTimeout(400)
    sock.once('connect', () => done('open'))
    sock.once('timeout', () => done('silent'))
    sock.once('error', e =>
      done((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'error'),
    )
  })
}

async function tcpReady(num: number): Promise<boolean> {
  return (await tcpProbe(num)) === 'open'
}

function unixReady(display: string): Promise<boolean> {
  return new Promise(res => {
    if (!existsSync(xSocket(display))) return res(false)
    const sock = netConnect(xSocket(display))
    const done = (ok: boolean): void => {
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      res(ok)
    }
    sock.setTimeout(400)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/** Is an X server actually reachable here? A lock file is not enough: it outlives a crash. */
async function xAlive(display: string): Promise<boolean> {
  if (await unixReady(display)) return true
  return tcpReady(displayNum(display))
}

/** kill(pid, 0) throws ESRCH when dead; EPERM means alive but not ours. */
function pidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Remove an orphaned lock/socket so the fixed display can be reused instead of climbing. The
 *  caller must have confirmed !xAlive(display) first: never unlink a live server's lock. */
function reclaimStaleLock(display: string): void {
  for (const f of [lockPath(display), xSocket(display)]) {
    try {
      unlinkSync(f)
    } catch {
      /* none */
    }
  }
}

const START_ATTEMPTS = 6

/** Prefer the configured display; reclaim its orphaned lock when nothing is listening. Only a
 *  live foreign server (or a display a previous attempt failed on) makes us climb. Our own X
 *  is found through the state file, not by scanning. */
async function pickDisplay(exclude: number[]): Promise<string> {
  const ex = new Set(exclude)
  const fixed = displayNum(DISPLAY)
  if (!ex.has(fixed)) {
    if (!existsSync(lockPath(DISPLAY)) && !existsSync(xSocket(DISPLAY))) return DISPLAY
    if (!(await xAlive(DISPLAY))) {
      reclaimStaleLock(DISPLAY)
      return DISPLAY
    }
  }
  for (let n = fixed + 1; n < fixed + 120; n++) {
    if (ex.has(n)) continue
    if (!existsSync(`/tmp/.X${n}-lock`) && !existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`
  }
  return DISPLAY
}

// ── persisted session identity (survives a node restart) ────────────────────────
interface X11State {
  display: string
  displayEnv: string
  backend: Backend
  xPid: number
  wmPid: number
}

function readState(): X11State | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as X11State
  } catch {
    return null
  }
}
function writeState(st: X11State): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(st))
  } catch (e) {
    logX(`state write failed: ${(e as Error).message}`)
  }
}
function clearState(): void {
  try {
    unlinkSync(STATE_FILE)
  } catch {
    /* none */
  }
}

// ── spawning ────────────────────────────────────────────────────────────────────
/** Spawn detached, in its own process group, with no stdio, so the child survives this
 *  process. Nothing here is awaited or reaped. `cwd` defaults to RUNTIME_DIR, which suits the
 *  X server and ffmpeg; anything whose cwd a user sees (the injected client, and ratpoison
 *  because `C-t c` inherits from it) must pass SPAWN_CWD. */
function spawnDetached(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string = RUNTIME_DIR,
): ChildProcess {
  const p = spawn(cmd, args, { env, cwd, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
  p.unref()
  return p
}

// The X server gets process.env with DISPLAY forced to the host display, so Xephyr has a
// desktop to map its window into; childEnv() would point it at the nested display it is about
// to create. Forcing matters because the environment may carry no DISPLAY at all (systemd).
// `-listen tcp` enables the TCP transport fallback probed by tcpReady.
function spawnXServer(backend: Backend, display: string): ChildProcess {
  const args =
    backend === 'Xephyr'
      ? [display, '-screen', `${SCREEN_W}x${SCREEN_H}`, '-resizeable', '-ac', '-listen', 'tcp']
      : [display, '-screen', '0', `${SCREEN_W}x${SCREEN_H}x24`, '-ac', '-listen', 'tcp']
  const env = HOST_DISPLAY ? { ...process.env, DISPLAY: HOST_DISPLAY } : process.env
  if (backend === 'Xephyr' && HOST_DISPLAY && !process.env.DISPLAY) {
    logX(`no DISPLAY in the environment; mapping Xephyr into the host display ${HOST_DISPLAY}`)
  }
  const xs = spawnDetached(backend, args, env)
  xs.on('error', e => logX(`${backend} spawn error: ${(e as Error).message}`))
  return xs
}

/** How long a just-spawned X server gets to answer. A healthy one takes well under a second. */
export const X_READY_MS = 5000

/** Why a just-spawned X server did not become usable. */
export type XStartFailure =
  | { kind: 'exited'; code: number | null; signal: string | null; afterMs: number }
  | { kind: 'no-answer'; afterMs: number; tcp: TcpProbe | 'not-probed' }

/** Pure: one log clause naming the cause, so the log says what to look at. */
export function describeXStartFailure(f: XStartFailure, display: string): string {
  const num = displayNum(display)
  if (f.kind === 'exited') {
    const how = f.signal ? `was killed by ${f.signal}` : `exited with code ${f.code}`
    return (
      `the X server ${how} after ${f.afterMs} ms — it could not start ` +
      '(not installed, the display is taken, or no host display to open a window on)'
    )
  }
  const tcp =
    f.tcp === 'silent'
      ? `TCP port ${6000 + num} gave no answer at all (loopback packets are being dropped: a firewall?)`
      : f.tcp === 'refused'
        ? `nothing listens on TCP port ${6000 + num}`
        : f.tcp === 'error'
          ? `TCP port ${6000 + num} could not be probed`
          : `TCP port ${6000 + num} was not probed`
  return (
    `the X server is still running after ${f.afterMs} ms but accepts no connection: ` +
    `no unix socket at ${xSocket(display)}, and ${tcp}`
  )
}

/** Wait up to X_READY_MS for a just-spawned X to answer on either transport; whichever does
 *  becomes the displayEnv clients use. The limit is on elapsed time, so slow probes cannot
 *  stretch it. Fails as soon as the X process exits, so a backend that cannot start falls
 *  through to the next one without waiting out the limit. */
async function xServerReady(
  xs: ChildProcess,
  display: string,
): Promise<{ displayEnv: string } | { failure: XStartFailure }> {
  const num = displayNum(display)
  const t0 = Date.now()
  let tcp: TcpProbe | 'not-probed' = 'not-probed'
  for (;;) {
    if (existsSync(xSocket(display))) return { displayEnv: display }
    // TCP answered. Re-check the unix socket before settling for it: the 400ms TCP probe is
    // long enough for the socket file to appear mid-probe, and unix is preferable (no
    // loopback, and it is what a bare ':N' in DISPLAY means to every other client).
    tcp = await tcpProbe(num)
    if (tcp === 'open')
      return { displayEnv: existsSync(xSocket(display)) ? display : `127.0.0.1:${num}` }
    const afterMs = Date.now() - t0
    if (xs.exitCode !== null || xs.signalCode !== null)
      return {
        failure: { kind: 'exited', code: xs.exitCode, signal: xs.signalCode, afterMs },
      }
    if (afterMs >= X_READY_MS) return { failure: { kind: 'no-answer', afterMs, tcp } }
    await sleep(100)
  }
}

/** Stock bindings dropped from ratpoison's root keymap, for two reasons.
 *  1. `C-t ?` help draws one line per binding with no paging and must be usable on a 576x288
 *     panel: this list cuts the stock 86 lines to 38 by removing the redundant `C-` twins, the
 *     `select <digit>` rows and the widest row.
 *  2. Frame operations (`s`, `S`, `R`, `M-arrows`, `C-underscore`) break the
 *     one-client-fills-the-screen invariant that the mirror and the pointer maths assume. `Q`
 *     (only) stays bound as the repair for a split.
 *  `colon` / `exclam` / `apostrophe` need free-form typing; `r` has nothing to resize. Never
 *  add `C-t` itself (`other`) or the plain keys `RP_KEYS` sends (src/shared/glassMenu.ts). */
const RP_UNBIND: readonly string[] = [
  // 1) redundant Control twins of a plain key
  'C-A',
  'C-K',
  'C-Return',
  'C-a',
  'C-b',
  'C-c',
  'C-i',
  'C-k',
  'C-l',
  'C-m',
  'C-n',
  'C-p',
  'C-apostrophe',
  'C-space',
  'C-v',
  'C-V',
  'C-w',
  'C-s',
  'C-S',
  'C-f',
  'C-r',
  'C-u',
  'C-x',
  // 1) the widest help row: the run-a-command-in-a-terminal prompt
  'C-exclam',
  // 1) `select 0`..`select 9` / `select -`: eleven rows that select by ratpoison window
  //    number, which is recycled and has no key on the glasses. Unbinding the keys does not
  //    affect `ratpoison -c 'select N'`, which ./windows.ts uses to switch windows.
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'minus',
  // 1) `period` = Debian's `update-menus` alias, which runs ratmenu over machine-dependent
  //    data in /var/lib/ratpoison/menu.
  'period',
  // 2) frame ops that would break the one-client-fills-the-screen invariant, and prompts that
  //    need a keyboard the glasses do not have
  's',
  'S',
  'R',
  'M-Left',
  'M-Right',
  'M-Up',
  'M-Down',
  'C-underscore',
  'r',
  'colon',
  'exclam',
  'apostrophe',
]

/** Start ratpoison: keyboard-driven, monocle, no decoration; its job is "one client fills the
 *  576x288 screen" (docs/decisions/monocle-window-manager.md). The generated rc must keep:
 *  - white-on-black UI: the stock message/input bars are black-on-white, a lit slab on the lens;
 *  - `unmanage ratmenu`: managed, the popup is centred across the tile boundary, so every menu
 *    movement dirties all four tiles; unmanaged it keeps its compact top-left geometry;
 *  - `C-t c` rebound to our own client: the stock `x-terminal-emulator` can resolve to a
 *    single-instance terminal that opens its window on the host desktop instead.
 *  Spawned at SPAWN_CWD: ratpoison hands its cwd to everything it `exec`s. */
function startWm(env: NodeJS.ProcessEnv): number {
  try {
    let rc = ''
    rc += 'set fgcolor white\n'
    rc += 'set bgcolor black\n'
    rc += 'set bwcolor white\n'
    rc += 'set border 0\n' // no decoration: every pixel is mirror surface
    rc += 'set padding 0 0 0 0\n'
    rc += 'set font monospace:pixelsize=11\n' // the stock 9x15bold overflows a 576x288 screen
    rc += 'unmanage ratmenu\n'
    for (const k of RP_UNBIND) rc += `unbind ${k}\n`
    if (SPAWN_CMD) {
      rc += `alias pwterm exec ${SPAWN_CMD}\n`
      rc += 'bind c pwterm\n'
    }
    writeFileSync(RC_FILE, rc)
  } catch (e) {
    logX(`ratpoisonrc write failed: ${(e as Error).message}`)
  }
  const wm = spawnDetached('ratpoison', ['-f', RC_FILE], env, SPAWN_CWD)
  wm.on('error', e => logX(`ratpoison spawn error: ${(e as Error).message} — is it installed?`))
  return wm.pid ?? 0
}

/** Count ratpoison-managed windows. 0 means the nested X has nothing to mirror. */
async function windowCount(): Promise<number> {
  const r = await run('ratpoison', ['-c', 'windows'], 3000)
  if (r.code !== 0) return 0
  return r.out.split('\n').filter(l => /^\s*\d+/.test(l)).length
}

/** Put the configured clients on the nested display when it is empty, so there is something
 *  to mirror. Skipped when PINHOLE_SPAWN='' or when clients are already up (the reattach case:
 *  the previous process's clients are still running and must not be duplicated). Starts in
 *  SPAWN_CWD because the client is usually a terminal whose prompt the operator reads.
 *  ratpoison shows the window that mapped last, so the list is started back to front and each
 *  client is given time to map: the first one named ends up in view. */
async function ensureClient(env: NodeJS.ProcessEnv): Promise<void> {
  if (SPAWN_LIST.length === 0) return
  if ((await windowCount()) > 0) return
  for (let i = SPAWN_LIST.length - 1; i >= 0; i--) {
    const cmd = SPAWN_LIST[i] as string
    const before = i > 0 ? await windowCount() : 0
    const p = spawnDetached('sh', ['-c', cmd], env, SPAWN_CWD)
    p.on('error', e => logX(`client spawn error: ${(e as Error).message}`))
    logX(`spawned client in ${SPAWN_CWD}: ${cmd}`)
    if (i === 0) break
    const until = Date.now() + SPAWN_MAP_WAIT_MS
    while (Date.now() < until && (await windowCount()) <= before) await sleep(100)
  }
}

// ── capture ─────────────────────────────────────────────────────────────────────
/** ffmpeg x11grab → raw rgb24 on stdout. Not detached and not persisted: it is the one part of
 *  the stack that dies with this process (its stdout pipe breaks), so a reattach only has to
 *  respawn this. */
function startCapture(s: Session, env: NodeJS.ProcessEnv): void {
  const ff = spawn(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-nostdin',
      // -draw_mouse 0: the nested X can fail the xcb pointer query (notably Xvfb over TCP),
      // which makes ffmpeg log an error per frame. The client draws its own cursor.
      '-f',
      'x11grab',
      '-draw_mouse',
      '0',
      '-video_size',
      `${SCREEN_W}x${SCREEN_H}`,
      '-framerate',
      String(FPS),
      '-i',
      `${s.displayEnv}.0`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    { env, cwd: RUNTIME_DIR, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  s.ffmpeg = ff
  ff.on('error', e => logX(`ffmpeg spawn error: ${(e as Error).message} — is it installed?`))
  ff.stderr?.on('data', d => {
    const m = String(d).trim()
    if (m) logX(`ffmpeg: ${m}`)
  })
  ff.stdout?.on('data', (d: Buffer) => onCapture(s, d))
  ff.on('exit', () => {
    if (session !== s || s.stopping) return
    s.ffmpeg = null
    // Not requested, so the display it was grabbing is gone or broken. Report unavailable but
    // leave the X stack alone: it is detached, and the next startX11 reattaches or respawns.
    logX('capture ended unexpectedly (x server gone?)')
    setAvail({ ok: false, msg: 'capture ended (nested X gone?)' })
  })
}

/** ffmpeg writes a continuous byte stream; chunk boundaries have nothing to do with frame
 *  boundaries. Accumulate and cut at exactly FRAME_BYTES. */
function onCapture(s: Session, chunkBuf: Buffer): void {
  if (s.stopping) return
  s.acc = s.acc.length ? Buffer.concat([s.acc, chunkBuf]) : chunkBuf
  while (s.acc.length >= FRAME_BYTES) {
    const frame = s.acc.subarray(0, FRAME_BYTES)
    s.acc = s.acc.subarray(FRAME_BYTES)
    sink?.frame(frame)
  }
  // Desync guard: if framing ever slips (a short write, a restarted encoder) the accumulator
  // would grow without bound and every frame after would be torn. Drop back to the newest
  // frame's worth of bytes and resynchronise there.
  if (s.acc.length > FRAME_BYTES * 4) s.acc = s.acc.subarray(s.acc.length - FRAME_BYTES)
}
// ── reattach ────────────────────────────────────────────────────────────────────
/** Rebuild the in-memory session from the state file left by a previous process whose X stack
 *  is still running, and respawn only what died (always ffmpeg; the WM only if it is gone).
 *  Returns false when there is nothing live to reattach to. */
async function tryReattach(): Promise<boolean> {
  const st = readState()
  if (!st) return false
  if (!pidAlive(st.xPid) || !(await xAlive(st.display))) {
    clearState()
    return false
  }
  const displayEnv = (await unixReady(st.display))
    ? st.display
    : `127.0.0.1:${displayNum(st.display)}`
  process.env.PINHOLE_X11_DISPLAY_ENV = displayEnv // publish the live transport to childEnv()
  const s: Session = {
    display: st.display,
    displayEnv,
    backend: st.backend === 'Xephyr' ? 'Xephyr' : 'Xvfb',
    xPid: st.xPid,
    wmPid: st.wmPid,
    ffmpeg: null,
    acc: Buffer.alloc(0),
    stopping: false,
  }
  session = s
  const env = childEnv({ DISPLAY: displayEnv })
  if (!pidAlive(s.wmPid)) {
    s.wmPid = startWm(env)
    await sleep(300)
  }
  // A ratpoison that is already running may predate the current rc, so apply `unmanage ratmenu`
  // and the unbinds live. One `-c` call per command (ratpoison takes one).
  void run('ratpoison', ['-c', 'unmanage ratmenu'], 2000)
  for (const k of RP_UNBIND) void run('ratpoison', ['-c', `unbind ${k}`], 2000)
  await ensureClient(env)
  startCapture(s, env)
  writeState({ display: s.display, displayEnv, backend: s.backend, xPid: s.xPid, wmPid: s.wmPid })
  setAvail({ ok: true })
  logX(`reattached to ${s.backend} on ${s.display} (xPid ${s.xPid}) via ${displayEnv}, ${FPS}fps`)
  return true
}

// ── public API ──────────────────────────────────────────────────────────────────
let startInFlight: Promise<void> | null = null

/** Bring the nested X up, or reattach to the one already running, then start capturing.
 *  Never throws: a host with no Xephyr/Xvfb is a state the client must be able to render, so
 *  every failure is reported through setAvail and the HTTP server keeps serving. Concurrent
 *  callers share one in-flight start; otherwise two could each spawn an X server. */
export function startX11(to: SessionSink): Promise<void> {
  sink = to
  if (startInFlight) return startInFlight
  startInFlight = startImpl().finally(() => {
    startInFlight = null
  })
  return startInFlight
}

async function startImpl(): Promise<void> {
  try {
    // Already live in this process? Reuse only if the X is still there: a closed Xephyr
    // window leaves a session object that will never produce another frame.
    if (session && !session.stopping && pidAlive(session.xPid) && (await xAlive(session.display))) {
      if (!session.ffmpeg) startCapture(session, childEnv({ DISPLAY: session.displayEnv }))
      setAvail({ ok: true })
      return
    }
    if (await tryReattach()) return

    const chain = backendOrder()
    const tried: number[] = []
    let fresh: Session | null = null

    // Outer loop: climb to another display if no backend comes up on this one (pickDisplay's
    // lock/socket checks cannot see a foreign X whose display files were removed while it
    // stayed alive). Inner loop: backend fallback on the same display before climbing.
    outer: for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      const display = await pickDisplay(tried)
      tried.push(displayNum(display))
      for (const backend of chain) {
        const xs = spawnXServer(backend, display)
        const ready = await xServerReady(xs, display)
        if ('displayEnv' in ready) {
          fresh = {
            display,
            displayEnv: ready.displayEnv,
            backend,
            xPid: xs.pid ?? 0,
            wmPid: 0,
            ffmpeg: null,
            acc: Buffer.alloc(0),
            stopping: false,
          }
          break outer
        }
        logX(
          `${backend} did not come up on ${display}: ${describeXStartFailure(ready.failure, display)}`,
        )
        try {
          if (xs.pid) process.kill(-xs.pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }

    if (!fresh) {
      const msg = `X server did not start (tried ${chain.join('/')} on :${tried.join(', :')}) — Xephyr/Xvfb installed?`
      logX(msg)
      setAvail({ ok: false, msg })
      return
    }

    const s = fresh
    session = s
    process.env.PINHOLE_X11_DISPLAY_ENV = s.displayEnv // publish the live transport to childEnv()
    const env = childEnv({ DISPLAY: s.displayEnv })

    s.wmPid = startWm(env)
    await sleep(300) // let ratpoison own the screen before any client maps
    await ensureClient(env)
    startCapture(s, env)

    // Persist after the stack is up: this is the handle the next process reattaches through.
    writeState({
      display: s.display,
      displayEnv: s.displayEnv,
      backend: s.backend,
      xPid: s.xPid,
      wmPid: s.wmPid,
    })
    setAvail({ ok: true })
    logX(`started ${s.backend} on ${s.display} via ${s.displayEnv}, ${FPS}fps`)
  } catch (e) {
    const msg = `X11 start failed: ${(e as Error).message}`
    logX(msg)
    setAvail({ ok: false, msg })
  }
}

/** Stop capturing. Kills ffmpeg only: the X server, WM and clients are detached and stay up so
 *  the next process reattaches to them (docs/platform.md). Idempotent. */
export function stopCapture(): void {
  const s = session
  if (!s) return
  s.stopping = true
  const ff = s.ffmpeg
  s.ffmpeg = null
  if (ff?.pid) {
    try {
      ff.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  s.acc = Buffer.alloc(0)
}

export function x11Info(): SessionInfo {
  const s = session
  return {
    display: s?.display ?? DISPLAY,
    backend: s ? s.backend : 'none',
    pid: s && s.xPid > 0 ? s.xPid : null,
    fps: FPS,
  }
}
