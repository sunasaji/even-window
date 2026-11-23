// stateDir.ts — where the server keeps its own files (apps.conf, apps-recent.json,
// bindings.json). OS-neutral, so both the neutral modules and a backend may import it.

import { homedir } from 'node:os'
import { join } from 'node:path'

/** State dir — the same resolution as src/server/auth.ts; read per call so a test can move it. */
export function appStateDir(): string {
  return process.env.EW_STATE_DIR || join(homedir(), '.even-window')
}
