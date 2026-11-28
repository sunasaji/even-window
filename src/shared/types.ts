// Shared types, imported by both the server and the WebView client.
// See docs/protocol.md for the authoritative description of each shape.

import type { BindingMap } from './bindings.ts'

/** One window in the display session. */
export interface WinInfo {
  /** Window-manager window number. Numbers are recycled: never use as a persistent key. */
  id: string
  /** Window id: an opaque string, stable for the window's lifetime. */
  wid: string
  /** The window class the application declares (WM_CLASS on X11). */
  cls: string
  title: string
  active: boolean
  /** Process comm name, when resolvable. */
  app?: string
  /** Absolute path of the running binary (`/proc/<pid>/exe`, or an absolute argv[0] from
   *  WM_COMMAND). Absent when the window exposes neither, or belongs to another user. */
  exe?: string
  /** `LauncherEntry.id`, when this window was attributed to a launch this server made
   *  (src/server/launches.ts). Absent for anything started outside the launcher. */
  appId?: string
}

/** One launcher entry: something the server can start on the mirrored desktop
 *  (`GET /api/apps`, docs/protocol.md). How entries are found, and what an id looks like, is the
 *  backend's business (docs/platform.md).
 *  `cmd`/`args` are exec'd verbatim with no shell. */
export interface LauncherEntry {
  /** Opaque, and stable across rescans and restarts: the recency list, bindings and the
   *  user's own rules key on it. */
  id: string
  name: string
  cmd: string
  args: string[]
  /** A short remark the backend attaches, shown beside the entry. Free text: nothing
   *  interprets it. */
  note: string
  /** `Terminal=true`: the program needs a terminal, so the server wraps it in the default
   *  terminal client. The wrapper is not in `cmd`/`args`. */
  terminal: boolean
}

/** One enrolled client key as it travels to the phone (docs/security.md). It carries no
 *  key material: the list exists so a human can notice a key they did not add, and the
 *  client cannot enrol or revoke. */
export interface EnrolledClient {
  /** SHA-256 fingerprint of the public key: the id `pw-auth list` prints. */
  id: string
  /** The authorized_keys-style comment: `client-<id8>` unless the operator named it. */
  name: string
  addedAt: number
  /** Source address captured when the key was staged for pairing, when it was known. */
  addedIp?: string
}

export type Avail = { ok: true } | { ok: false; msg: string }

export interface SessionInfo {
  display: string
  /** The backend's own name for what provides the desktop; 'none' when there is none. */
  backend: string
  pid: number | null
  fps: number
}

/** Server → client SSE payloads. Discriminated on `t`. */
export type StreamEvent =
  | { t: 'tile'; i: number; png: string }
  | { t: 'avail'; ok: true }
  | { t: 'avail'; ok: false; msg: string }
  /** The window set, plus the focus-recency order as an array of window ids (most recent first,
   *  live windows only). `list` keeps the window manager's order because the server hashes
   *  it in order to decide whether to publish; recency travels beside it. `recent` is
   *  optional so that a client newer than the server degrades to the server's order
   *  (docs/decisions/wire-additions-are-optional.md). */
  | { t: 'windows'; list: WinInfo[]; recent?: string[] }
  /** The launchable set and the launch-recency order. Sent on subscribe and whenever either
   *  changes; never per frame. */
  | { t: 'apps'; list: LauncherEntry[]; recent: string[] }
  /** The per-app bindings in force (docs/glasses.md). Sent on subscribe and after every
   *  accepted edit, so every connected phone sees the change; never per frame. */
  | { t: 'bindings'; map: BindingMap }
  /** The enrolled keys (docs/security.md). Sent on subscribe and whenever the registry
   *  changes, so every connected device can show a key its user did not add. `enforced` is
   *  `authEnabled()`: with auth off the registry is not consulted. A server that never sends
   *  this event means "unknown", not "no keys". */
  | { t: 'clients'; list: EnrolledClient[]; enforced: boolean }
  /** Stand down: a newer WebView instance owns the glasses now. Sent to every stream of an
   *  identity whose instance id is no longer current, and to a superseded instance that
   *  reconnects; `by` is the id that took over. Only sent to clients that pass `?inst=`
   *  (src/server/instances.ts, docs/decisions/glasses-instance-supersede.md). */
  | { t: 'supersede'; by: string }

/** Normalised glasses gestures. `long` / `longRelease` (PB 9 / 10) are representable and
 *  logged but not routed to an action (docs/glasses.md). */
export type GestureName = 'tap' | 'double' | 'up' | 'down' | 'long' | 'longRelease'

/** The gestures `POST /api/input` routes to an action (docs/glasses.md). */
export type RoutedGesture = Extract<GestureName, 'tap' | 'double' | 'up' | 'down'>

/** Low-level input injection kinds. `keydown` / `keyup` are the only kinds that leave state
 *  in the display server: a modifier can be held across other injections. Whoever sends a
 *  `keydown` owns the matching `keyup`. */
export type InputKind =
  | 'key'
  | 'type'
  | 'click'
  | 'dblclick'
  | 'move'
  | 'clickat'
  | 'down'
  | 'up'
  | 'keydown'
  | 'keyup'
