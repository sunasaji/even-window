// envFile.ts — `EW_*` settings from a file, in systemd's `EnvironmentFile=` format.
//
// A file in a known place makes the security settings (`EW_ORIGIN`, `EW_AUTH`,
// `EW_MAX_CLIENTS`) independent of which shell started the server
// (docs/decisions/env-file-format.md).
//
// The format is a strict subset of systemd's `EnvironmentFile=`, so one file works in both:
// `KEY=value`, `#` or `;` comments, one layer of matching quotes stripped. Nothing systemd
// rejects is accepted: no `export`, no `$VAR` expansion (so `~` is literal), no line
// continuations, no spaces around `=`.
//
// Invariants: the file is parsed, never sourced, so it cannot execute anything; only `EW_*`
// keys are accepted (a file that could set `PATH` or `LD_PRELOAD` would be code execution for
// every child process); and the environment always wins — the file fills only what is unset,
// and `applyEnvFile` reports which keys it set.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface EnvFileParse {
  /** Accepted `EW_*` assignments, in file order (a later line wins, as in systemd). */
  vars: Record<string, string>
  /** One line per rejected line, each naming the line number and what is wrong. */
  warnings: string[]
}

/** Pure parse of an env file's text. Rejects, with a message per line, everything systemd
 *  would also reject. */
export function parseEnvFile(text: string): EnvFileParse {
  const vars: Record<string, string> = {}
  const warnings: string[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const at = `line ${i + 1}`
    if (/^export\s/.test(line)) {
      warnings.push(
        `${at}: drop the \`export\` — systemd's EnvironmentFile has no shell, and would read the key as "export …"`,
      )
      continue
    }
    if (line.endsWith('\\')) {
      warnings.push(`${at}: line continuations are not supported — put the whole value on one line`)
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) {
      warnings.push(`${at}: expected KEY=VALUE`)
      continue
    }
    const key = line.slice(0, eq)
    if (!/^EW_[A-Z0-9_]+$/.test(key)) {
      warnings.push(
        key.trim() !== key
          ? `${at}: no spaces around \`=\` (the key would be "${key}")`
          : `${at}: "${key}" is not an EW_* setting — this file may only set EW_* keys`,
      )
      continue
    }
    let value = line.slice(eq + 1).trim()
    // One layer of matching quotes, like systemd. No escape processing inside them.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (/\$\(|\$\{|\$[A-Za-z_]/.test(value)) {
      warnings.push(
        `${at}: ${key} contains \`$\` — values are literal here and in systemd; no expansion happens`,
      )
      // Kept anyway: the literal value is what systemd would also hand over.
    }
    vars[key] = value
  }
  return { vars, warnings }
}

/** Where to look, highest precedence first. `EW_ENV_FILE` overrides: a path means exactly that
 *  file (and a complaint if it is missing); empty means no file and no search. The defaults
 *  are `~/.even-window/env`, then `$XDG_CONFIG_HOME/even-window/env`; both are read. The lookup does not follow
 *  `EW_STATE_DIR`: the file may set it. */
export function envFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.EW_ENV_FILE
  if (explicit !== undefined) return explicit === '' ? [] : [explicit]
  // HOME comes from the passed env so this stays a function of its argument (testable);
  // `homedir()` is the fallback for a context with no HOME.
  const home = env.HOME && env.HOME !== '' ? env.HOME : homedir()
  const xdg =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(home, '.config')
  return [join(home, '.even-window', 'env'), join(xdg, 'even-window', 'env')]
}

export interface EnvFileReport {
  /** The files that were read, in precedence order. Empty when there was none. */
  files: string[]
  /** Keys the files actually set (absent from the environment). */
  applied: string[]
  /** Keys the files name that the environment had already set, so the files lost. */
  overridden: string[]
  lines: string[]
}

/** Read every candidate that exists and apply them to `env`, filling only what is unset. A key
 *  set in more than one file takes the earlier candidate's value. That is the result systemd
 *  produces from the unit's two `EnvironmentFile=` lines, so the server sees the same settings
 *  whether it is started by the unit or by hand.
 *  Called for effect from src/server/env.boot.ts, which src/server/main.ts imports first. */
export function applyEnvFile(env: NodeJS.ProcessEnv = process.env): EnvFileReport {
  const report: EnvFileReport = { files: [], applied: [], overridden: [], lines: [] }
  // Decided before any file is applied: a key that an earlier file sets must not look like
  // one the environment had set when a later file names it too.
  const fromEnvironment = new Set(Object.keys(env).filter(k => env[k] !== undefined))
  for (const file of envFileCandidates(env)) {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(file)
    } catch {
      // An explicit path that is missing is a typo worth a line; a missing default is normal.
      if (env.EW_ENV_FILE)
        report.lines.push(`env file ${file}: not found (EW_ENV_FILE points at it)`)
      continue
    }
    // Group- or world-writable: do not load it — another local account could set EW_AUTH=0.
    // Refusing the file (not the start) fails safe: every control keeps its secure default.
    if ((st.mode & 0o022) !== 0) {
      report.lines.push(
        `env file ${file} is mode 0${(st.mode & 0o777).toString(8)} — WRITABLE by others, so it was IGNORED.`,
      )
      report.lines.push(`  Someone else could set EW_AUTH=0 in it. Fix: chmod 600 ${file}`)
      continue
    }
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      report.lines.push(`env file ${file}: unreadable (${(e as Error).message})`)
      continue
    }
    report.files.push(file)
    const { vars, warnings } = parseEnvFile(text)
    for (const w of warnings) report.lines.push(`env file ${file}: ${w}`)
    for (const [k, v] of Object.entries(vars)) {
      if (fromEnvironment.has(k)) {
        if (!report.overridden.includes(k)) report.overridden.push(k)
        continue
      }
      if (env[k] !== undefined) {
        report.lines.push(`env file ${file}: ${k} is already set by ${report.files[0]}, which wins`)
        continue
      }
      env[k] = v
      report.applied.push(k)
    }
  }
  return report
}

/** The banner lines for a report — what the files set, and what they did not get to set. []
 *  when there was no file and nothing to complain about. */
export function envFileBanner(r: EnvFileReport): string[] {
  const out = [...r.lines]
  const names = r.files.join(', ')
  if (names && r.applied.length) out.unshift(`env file ${names}: set ${r.applied.join(' ')}`)
  else if (names) out.unshift(`env file ${names}: read, set nothing new`)
  if (r.overridden.length) {
    out.push(
      `env file: the environment already set ${r.overridden.join(' ')} — the file did not override it`,
    )
  }
  return out
}
