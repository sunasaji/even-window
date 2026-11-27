// Small settings that must survive a restart of the Even App.
//
// In the packaged app `localStorage` is emptied when the Even App is restarted (observed on an
// iPhone, 2026-11-27), so everything the client remembers there would reset on every launch:
// the tour reopens, hints repeat, polarity returns to the default, and the acknowledged set of
// enrolled keys is forgotten. The bridge's storage does survive, so each value written through
// `keep` is also held in one JSON object there, and `wireKv` puts the values back.
//
// `localStorage` stays the store every reader uses; this module only fills it again. The device
// key and the server address have their own entries (authClient.ts, serverLink.ts).

import type { DurableStore } from './authClient.ts'
import { withTimeout } from './util.ts'

const BLOB_KEY = 'ew.kv'

let store: DurableStore | null = null
let blob: Record<string, string> = {}
/** Choices made before the store was wired (a `?flag=` or a tap). They win over what was kept. */
const chosen = new Map<string, string>()

function flush(): void {
  void store?.set(BLOB_KEY, JSON.stringify(blob))
}

/** Write a value. `choice` is false when the value is a default being recorded at boot: such a
 *  write must not replace what an earlier run kept, because it happens before the store is
 *  wired and nobody asked for it. */
export function keep(key: string, value: string, choice = true): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage blocked */
  }
  if (!store) {
    if (choice) chosen.set(key, value)
    return
  }
  if (blob[key] === value) return
  blob[key] = value
  flush()
}

/** Wire the durable store and put kept values back into `localStorage`. Returns the keys whose
 *  value changed, so the caller can re-read the settings resolved before this point. */
export async function wireKv(s: DurableStore): Promise<string[]> {
  let saved: Record<string, string> = {}
  try {
    const raw = await withTimeout(s.get(BLOB_KEY), 3000, 'kv store')
    const v = raw ? (JSON.parse(raw) as unknown) : null
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v)) if (typeof val === 'string') saved[k] = val
    }
  } catch {
    saved = {} // slow or failing bridge, or a damaged entry: start over rather than guess
  }
  store = s
  const restored: string[] = []
  for (const [k, v] of Object.entries(saved)) {
    if (chosen.has(k)) continue
    try {
      if (localStorage.getItem(k) === v) continue
      localStorage.setItem(k, v)
      restored.push(k)
    } catch {
      /* storage blocked: nothing reads it either */
    }
  }
  blob = { ...saved, ...Object.fromEntries(chosen) }
  if (chosen.size > 0) flush()
  chosen.clear()
  return restored
}

/** For tests: forget the store and everything pending. */
export function resetKv(): void {
  store = null
  blob = {}
  chosen.clear()
}
