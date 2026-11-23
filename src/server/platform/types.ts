// The seam between the OS-neutral server and one operating system's desktop.
//
// Everything above this interface — HTTP routes, auth, the SSE stream, tile encoding, window
// recency, launch attribution, swipe bindings — is OS-neutral and must not import from a
// backend directory (`platform/x11/…`). Everything below it is free to use whatever the OS
// offers. `tests/architecture.test.ts` enforces the import direction.
//
// A backend's job, in one sentence: keep a SCREEN_W x SCREEN_H desktop alive that outlives this
// process, deliver its pixels as raw frames, and let the server list, focus, close and drive
// the windows on it.
//
// Vocabulary that crosses the seam and the wire, and is therefore not backend-specific
// (docs/decisions/platform-wire-vocabulary.md):
//   - a window id (`WinInfo.wid`) is an opaque string, stable for the window's lifetime;
//   - a key chord is spelled `[ctrl+][alt+][shift+]<key name>` (`ctrl+Return`). Key names are
//     the X keysym names, used as a fixed catalogue; a backend for another OS translates them
//     to its own key codes;
//   - pointer buttons are numbered 1=left 2=middle 3=right 4=wheel-up 5=wheel-down.

import type { Avail, InputKind, LauncherEntry, SessionInfo, WinInfo } from '../../shared/types.ts'

/** Where a display session reports to. Supplied by the OS-neutral side. */
export interface SessionSink {
  /** One captured frame: SCREEN_W x SCREEN_H, rgb24, rows top to bottom, FRAME_BYTES long.
   *  The buffer is only valid for the duration of the call. */
  frame(rgb24: Buffer): void
  /** The mirrored desktop became available or unavailable. */
  avail(state: Avail): void
}

/** The mirrored desktop: its lifecycle and its pixels. */
export interface DisplaySession {
  /** Bring the desktop up, or reattach to the one a previous process left running, then start
   *  capturing into `sink`. Never rejects: failure is reported through `sink.avail`.
   *  Concurrent calls share one in-flight start. */
  start(sink: SessionSink): Promise<void>
  /** Stop capturing. The desktop and its applications stay up for the next process. */
  stopCapture(): void
  /** The `GET /api/health` description of the session. */
  info(): SessionInfo
}

/** A window selector as it arrives on the wire (`POST /api/windows`). */
export interface WinSel {
  /** The backend's own short window handle (`WinInfo.id`). May be recycled. */
  sel?: string
  /** The stable window id (`WinInfo.wid`). */
  wid?: string
}

/** What a window admits about the process behind it. Constant for the window's lifetime. */
export interface WinIdent {
  /** Owning process id, or 0 when the window exposes none. */
  pid: number
  /** Executable name, lowercased. '' when unknown. */
  comm: string
  /** Absolute executable path. '' when unknown. */
  exe: string
}

/** Enumerating and driving the windows of the mirrored desktop. */
export interface WindowControl {
  /** The managed windows in the backend's own stable order. Carries no identity or launch
   *  attribution — the OS-neutral side adds those. Side-effect free. */
  enumerate(): Promise<WinInfo[]>
  /** Resolve a window's identity. Uncached: the caller caches per window lifetime. */
  identify(wid: string): Promise<WinIdent>
  /** The id of the window holding input focus right now, or '' when unknown. */
  focusedId(): Promise<string>
  /** Bring a window to the front and focus it. */
  select(sel: WinSel): Promise<boolean>
  /** Ask a window to close gracefully (never force-kill). No selector: the current window. */
  close(sel?: WinSel): Promise<boolean>
  /** Start a program on the mirrored desktop, detached, argv verbatim with no shell.
   *  Returns the child's pid, or 0 on failure. */
  spawn(cmd: string, args: readonly string[]): number
}

/** Synthetic keyboard and pointer input into the mirrored desktop. */
export interface InputInjector {
  /** Inject one low-level event (`POST /api/desktop/input`). False on failure; never rejects. */
  inject(kind: InputKind, arg: string): Promise<boolean>
  /** Press `chord` `n` times, in order. */
  repeatKey(chord: string, n: number): Promise<boolean>
  /** Turn the wheel `n` notches with `mods` held around the whole burst. */
  wheel(button: 4 | 5, n: number, mods: readonly string[]): Promise<boolean>
  /** Send one key of the window manager's own menu catalogue (`POST /api/wm/key`).
   *  A backend with no such surface returns false. */
  wmKey(key: string): Promise<boolean>
}

/** Reading the OS process table. */
export interface ProcessInspector {
  /** The parent pid of `pid`, or 0 when it is gone or unreadable. */
  parentPid(pid: number): number
}

/** What a launcher scan produced. `counts`, `skipped` and `errors` go out on the wire as they
 *  are (`GET /api/apps`). */
export interface AppScan {
  apps: LauncherEntry[]
  /** `total` is the number of entries. Every other key is the backend's own, naming its
   *  sources and filters so that a short list can be explained. */
  counts: { total: number } & Record<string, number>
  /** One line for the startup log saying what was found, in the backend's own terms. */
  summary: string
  /** Per-file skip reasons, so "why is X not in the list" has an answer. */
  skipped: { what: string; why: string }[]
  /** Problems in the user's own override file. */
  errors: string[]
}

/** Discovering what can be launched. Launch recency is not here: it is OS-neutral
 *  (`src/server/appRecency.ts`). */
export interface AppCatalogue {
  /** The launchable set. `force` rescans instead of answering from the cache. */
  list(force?: boolean): Promise<AppScan>
  byId(id: string): Promise<LauncherEntry | null>
  /** The argv that launches `app`, including any terminal wrapper it needs. */
  launchArgv(app: LauncherEntry): string[]
  /** Where the user's own override file lives, for `GET /api/apps` to report. */
  overridesPath(): string
  /** The command of the backend's built-in default application; the entry with that command
   *  fills the tail of the launch-recency list. '' for none. */
  seedCommand(): string
}

export interface Platform {
  /** `process.platform`-style name of the backend, for logs. */
  readonly id: string
  readonly session: DisplaySession
  readonly windows: WindowControl
  readonly input: InputInjector
  readonly processes: ProcessInspector
  readonly apps: AppCatalogue
}
