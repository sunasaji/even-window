// stateDir.ts — where the server keeps its own files (apps.conf, apps-recent.json,
// bindings.json). OS-neutral, so both the neutral modules and a backend may import it.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The default state dir. */
export function defaultStateDir(home: string = homedir()): string {
  return join(home, '.pinhole-window')
}

/** State dir — the same resolution as src/server/auth.ts; read per call so a test can move it. */
export function appStateDir(): string {
  return process.env.PINHOLE_STATE_DIR || defaultStateDir()
}
