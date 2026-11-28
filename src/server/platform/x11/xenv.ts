// Nested-X environment: tunables, the env every X client must inherit, and a small
// promise-wrapped process runner. Invariants kept here (docs/platform.md):
//   - antialiasing is off for every child (generated FONTCONFIG_FILE): the capture quantises
//     to 16 colours and antialiased edges snap to the wrong hue;
//   - Wayland is removed from the child env, or GTK/Firefox render on the host desktop;
//   - transient state lives in RUNTIME_DIR so a restarted server finds the X it left running;
//   - a client's cwd is SPAWN_CWD ($HOME by default), never the runtime dir;
//   - the host display is found from the X socket directory, not only from the environment.

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // <repo>/src/server/platform/x11
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')

function clampInt(v: string | undefined, def: number, lo: number, hi: number): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def
}

/** The nested X display, e.g. ':100'. Must not collide with the host display (:0). */
export const DISPLAY: string = process.env.PINHOLE_X11_DISPLAY || ':100'

/** Where session.json / ratpoisonrc / fonts.conf live. Tree-local by default. */
export const RUNTIME_DIR: string = process.env.PINHOLE_X11_RUNTIME_DIR || join(REPO_ROOT, '.pw-x11')

/** The directory a listening X server publishes its unix socket in, as `X<display number>`. */
const X11_SOCKET_DIR = '/tmp/.X11-unix'

function x11Sockets(): string[] {
  try {
    return readdirSync(X11_SOCKET_DIR)
  } catch {
    return []
  }
}

/** The host display: the desktop Xephyr maps its window into. `null` means no host desktop,
 *  which makes session.ts prefer headless Xvfb. Resolution order:
 *  1. PINHOLE_HOST_DISPLAY (the empty string asserts "no host desktop");
 *  2. DISPLAY;
 *  3. the lowest `X<n>` socket in /tmp/.X11-unix that is not our own nested display, because a
 *     systemd unit has no DISPLAY even when a desktop is reachable. Excluding our own number
 *     matters: Xephyr mapped into the display it is creating would nest inside itself.
 *  The display is not probed; a stale socket only costs the Xephyr→Xvfb fallback. */
export function resolveHostDisplay(
  env: NodeJS.ProcessEnv = process.env,
  sockets: () => string[] = x11Sockets,
  nested: string = DISPLAY,
): string | null {
  if (env.PINHOLE_HOST_DISPLAY !== undefined) return env.PINHOLE_HOST_DISPLAY.trim() || null
  const fromEnv = (env.DISPLAY ?? '').trim()
  if (fromEnv) return fromEnv
  const ours = Number(nested.replace(/^:/, ''))
  const nums = sockets()
    .map(f => /^X(\d+)$/.exec(f)?.[1])
    .filter((s): s is string => s !== undefined)
    .map(Number)
    .filter(n => n !== ours)
    .sort((a, b) => a - b)
  return nums.length ? `:${nums[0]}` : null
}

/** Where Xephyr can draw. `null` ⇒ headless; session.ts turns that into the Xvfb preference. */
export const HOST_DISPLAY: string | null = resolveHostDisplay()

/** Resolve PINHOLE_SPAWN_CWD (callers want SPAWN_CWD). Unset or blank → `home`. A leading `~` is
 *  expanded here because a systemd EnvironmentFile runs no shell. A relative path resolves
 *  against `home`, never process.cwd(), which is whatever the launcher used. A missing or
 *  non-directory path falls back to `home` with one warning, so a typo cannot fail the client
 *  spawn and blank the glasses. */
export function resolveSpawnCwd(
  raw: string | undefined,
  home: string = homedir(),
  warn: (msg: string) => void = m => console.log(`[xenv] ${m}`),
): string {
  const v = (raw ?? '').trim()
  if (!v) return home
  const expanded = v === '~' ? home : v.startsWith('~/') ? join(home, v.slice(2)) : v
  const abs = isAbsolute(expanded) ? expanded : resolve(home, expanded)
  try {
    if (statSync(abs).isDirectory()) return abs
    warn(`PINHOLE_SPAWN_CWD is not a directory: ${abs} — using ${home}`)
  } catch {
    warn(`PINHOLE_SPAWN_CWD does not exist: ${abs} — using ${home}`)
  }
  return home
}

/** Where a client launched into the nested X starts: $HOME unless PINHOLE_SPAWN_CWD says
 *  otherwise. User-visible, so not the runtime dir. */
export const SPAWN_CWD: string = resolveSpawnCwd(process.env.PINHOLE_SPAWN_CWD)

/** ffmpeg capture framerate. Clamped to a sane 1..30 — the BLE link cannot use more. */
export const FPS: number = clampInt(process.env.PINHOLE_FPS, 10, 1, 30)

/** PINHOLE_AA=1 permits antialiasing, for comparison experiments only. Default off. */
export const ALLOW_AA: boolean = process.env.PINHOLE_AA === '1'

try {
  mkdirSync(RUNTIME_DIR, { recursive: true })
} catch {
  /* created lazily on first write */
}

/** Generated per-launch fontconfig, handed to children via FONTCONFIG_FILE. */
const FONTS_FILE = join(RUNTIME_DIR, 'fonts.conf')

// Include the system config first so children keep the host's font set and aliases; only the
// rasterisation knobs are overridden. hintfull + autohint keeps stems on pixel boundaries at
// small sizes; rgba=none removes subpixel fringing.
function fontconfigXml(aa: boolean): string {
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <match target="font">
    <edit name="antialias" mode="assign"><bool>${aa ? 'true' : 'false'}</bool></edit>
    <edit name="hinting" mode="assign"><bool>true</bool></edit>
    <edit name="hintstyle" mode="assign"><const>hintfull</const></edit>
    <edit name="autohint" mode="assign"><bool>true</bool></edit>
    <edit name="rgba" mode="assign"><const>none</const></edit>
  </match>
</fontconfig>
`
}

let fontsWritten = false

/** Write the generated fonts.conf and return its absolute path. Written at most once per
 *  process, because childEnv() calls this on every child spawn. A failed write is non-fatal:
 *  the child falls back to the system fontconfig (antialiased). */
export function ensureFontsConf(): string {
  if (fontsWritten) return FONTS_FILE
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
  } catch {
    /* exists */
  }
  try {
    writeFileSync(FONTS_FILE, fontconfigXml(ALLOW_AA))
    fontsWritten = true
  } catch (e) {
    console.log(`[xenv] fontconfig write failed: ${(e as Error).message}`)
  }
  return FONTS_FILE
}

/** Build the env for a process that must talk to the nested X. DISPLAY defaults to
 *  PINHOLE_X11_DISPLAY_ENV when session.ts has set it, because the nested server may be reachable
 *  over TCP only ('127.0.0.1:100' instead of ':100'). `extra` wins over everything. */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: process.env.PINHOLE_X11_DISPLAY_ENV || DISPLAY,
    FONTCONFIG_FILE: ensureFontsConf(),
    GDK_BACKEND: 'x11',
    MOZ_ENABLE_WAYLAND: '0',
    ...extra,
  }
  // An inherited Wayland socket (WSLg) would make GTK render on the host desktop instead of
  // the nested display. It must be deleted, not merely overridden.
  delete env.WAYLAND_DISPLAY
  return env
}

/** Run a command against the nested X and collect its output. Never rejects: a spawn error or
 *  a timeout resolves with a non-zero `code` and the reason in `err`, so callers can branch on
 *  data (xdotool / ratpoison probes routinely fail while the X is still coming up). */
export function run(
  cmd: string,
  args: string[],
  timeoutMs = 4000,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve_ => {
    let out = '',
      err = '',
      settled = false
    const finish = (code: number): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve_({ code, out, err })
      }
    }
    const p = spawn(cmd, args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      err += `\n[timeout after ${timeoutMs}ms]`
      try {
        p.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      finish(124)
    }, timeoutMs)
    p.stdout?.on('data', d => {
      out += String(d)
    })
    p.stderr?.on('data', d => {
      err += String(d)
    })
    p.on('error', e => {
      err += (e as Error).message
      finish(127)
    })
    p.on('close', code => finish(code ?? 0))
  })
}
