// even-window — persistence for the per-app swipe bindings (docs/glasses.md).
//
// The model and every validator live in src/shared/bindings.ts, so the client edits and the
// server writes through the same code; this file is only the file on disk.
//
// The server owns the bindings because it resolves a gesture to its action
// (`POST /api/input {gesture,count}` keeps the move-N repeat in one round trip), and because
// they belong to the machine being driven, not to the phone driving it.
//
// The file is machine-written JSON. A hand edit still works: `normBindingMap` drops bad
// entries and reports them through `GET /api/bindings` instead of failing the whole file.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppBinding, BindingMap } from '../shared/bindings.ts'
import { bindingEq, isBindingKey, normBindingMap } from '../shared/bindings.ts'
import { appStateDir } from './stateDir.ts'

export const BINDINGS_FILE = 'bindings.json'

export function bindingsPath(): string {
  return join(appStateDir(), BINDINGS_FILE)
}

interface Loaded {
  map: BindingMap
  errors: string[]
}

let loaded: Loaded | null = null

/** Read-through cache: the map is consulted on every swipe. `setBinding` is the only writer
 *  and updates file and cache together, so no mtime check is needed. */
function load(): Loaded {
  if (loaded) return loaded
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(bindingsPath(), 'utf8'))
  } catch {
    raw = null // no file yet (the normal case), or unreadable — either way: no bindings
  }
  const { map, errors } = normBindingMap((raw as { bindings?: unknown } | null)?.bindings ?? raw)
  loaded = { map, errors }
  return loaded
}

/** The live map. Returned by reference and treated as read-only by callers — `setBinding` is
 *  the only writer. */
export function bindingsMap(): BindingMap {
  return load().map
}

/** Complaints from the last read, for `GET /api/bindings`, so a typo in a hand edit is visible
 *  instead of silently doing nothing. */
export function bindingErrors(): string[] {
  return load().errors
}

function save(map: BindingMap): void {
  try {
    mkdirSync(appStateDir(), { recursive: true })
    // Wrapped in `{bindings:…}` so the file can grow a version or a sibling key. The reader
    // accepts both the wrapped and the bare map.
    writeFileSync(bindingsPath(), JSON.stringify({ bindings: map }, null, 2) + '\n')
  } catch {
    /* a non-writable state dir must not break the gesture that triggered the write */
  }
}

/** Set (or, with `b === null`, delete) one entry. Returns false when the key is invalid or
 *  nothing changed — the caller publishes the SSE event only on true. */
export function setBinding(key: string, b: AppBinding | null): boolean {
  if (!isBindingKey(key)) return false
  const cur = load()
  const had = cur.map[key]
  if (b === null) {
    if (!had) return false
    const next: BindingMap = { ...cur.map }
    delete next[key]
    loaded = { map: next, errors: cur.errors }
    save(next)
    return true
  }
  if (had && bindingEq(had, b)) return false
  const next: BindingMap = { ...cur.map, [key]: b }
  loaded = { map: next, errors: cur.errors }
  save(next)
  return true
}

/** Drop the in-memory copy so the next read re-reads the file. For tests. */
export function resetBindingsCache(): void {
  loaded = null
}
