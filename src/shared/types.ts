// even-window — shared types. Imported by both the server and the WebView client.
// See docs/CONTRACT.md for the authoritative description of each shape.

/** One window living in the nested X server. */
export interface WinInfo {
  /** ratpoison window number. NOTE: numbers are recycled — never use as a persistent key. */
  id: string
  /** X window id, e.g. "0x400001". Stable for the window's lifetime. */
  xid: string
  /** WM_CLASS. */
  cls: string
  title: string
  active: boolean
  /** Process comm name, when resolvable. */
  app?: string
}

export type Avail = { ok: true } | { ok: false; msg: string }

export interface X11Info {
  display: string
  backend: 'Xephyr' | 'Xvfb' | 'none'
  pid: number | null
  fps: number
}

/** Server → client SSE payloads. Discriminated on `t`. */
export type StreamEvent =
  | { t: 'tile'; i: number; png: string }
  | { t: 'avail'; ok: true }
  | { t: 'avail'; ok: false; msg: string }
  | { t: 'windows'; list: WinInfo[] }

/** Normalised glasses gestures. */
export type GestureName = 'tap' | 'double' | 'up' | 'down'

/** Low-level xdotool injection kinds. */
export type InputKind = 'key' | 'type' | 'click' | 'dblclick' | 'move' | 'clickat' | 'down' | 'up'

export interface InputRequest {
  gesture: GestureName
  /** move-N batching; absent means 1. Values < 1 are clamped to 1. */
  count?: number
}

export interface InputResponse {
  handled: boolean
  msg?: string
}
