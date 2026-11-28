// stateDir.ts — where the server keeps its own files (apps.conf, apps-recent.json,
// bindings.json). OS-neutral, so both the neutral modules and a backend may import it.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The directory name the project used before it was renamed. An install made then keeps
 *  working without moving anything (docs/decisions/rename-to-pinhole-window.md). */
export const LEGACY_NAME = 'even-window'

/** The default state dir: `~/.pinhole-window`, or `~/.even-window` when only that one exists.
 *  The new name wins as soon as it exists, so moving the directory is the whole migration. */
export function defaultStateDir(home: string = homedir()): string {
  const now = join(home, '.pinhole-window')
  const old = join(home, `.${LEGACY_NAME}`)
  return !existsSync(now) && existsSync(old) ? old : now
}

/** State dir — the same resolution as src/server/auth.ts; read per call so a test can move it. */
export function appStateDir(): string {
  return process.env.EW_STATE_DIR || defaultStateDir()
}
