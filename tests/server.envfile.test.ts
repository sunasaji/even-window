// pinhole-window — `PINHOLE_*` settings from a file (src/server/envFile.ts), in systemd's format.
//
// The format is a strict subset of systemd's `EnvironmentFile=`, so one file works in both
// places and anything systemd rejects is rejected here too.
//
// Also pinned: the environment always beats the file, only PINHOLE_* keys are honoured (a file
// that could set PATH or LD_PRELOAD would be code execution for every child process), and a
// group- or world-writable file is ignored.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyEnvFile,
  envFileBanner,
  envFileCandidates,
  parseEnvFile,
} from '../src/server/envFile.ts'

const dirs: string[] = []
function tempFile(contents: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'pw-env-'))
  dirs.push(dir)
  const file = join(dir, 'env')
  writeFileSync(file, contents, 'utf8')
  chmodSync(file, mode)
  return file
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('parseEnvFile — what it accepts', () => {
  it('reads KEY=VALUE, blank lines and both comment markers', () => {
    const { vars, warnings } = parseEnvFile(
      [
        '# a comment',
        '; another one',
        '',
        'PINHOLE_ORIGIN=https://host.ts.net:8443',
        '   PINHOLE_MAX_CLIENTS=2   ',
        'PINHOLE_PORT=9999',
      ].join('\n'),
    )
    expect(vars).toEqual({
      PINHOLE_ORIGIN: 'https://host.ts.net:8443',
      PINHOLE_MAX_CLIENTS: '2',
      PINHOLE_PORT: '9999',
    })
    expect(warnings).toEqual([])
  })

  it('strips one layer of matching quotes, like systemd', () => {
    const { vars } = parseEnvFile(
      [
        'PINHOLE_SPAWN="xterm -bg black -fg white"',
        "PINHOLE_ORIGINS='https://a,https://b'",
        'PINHOLE_AUTH="1', // unmatched: left alone rather than guessed at
      ].join('\n'),
    )
    expect(vars.PINHOLE_SPAWN).toBe('xterm -bg black -fg white')
    expect(vars.PINHOLE_ORIGINS).toBe('https://a,https://b')
    expect(vars.PINHOLE_AUTH).toBe('"1')
  })

  it('keeps an empty value — "set to empty" is a real setting here', () => {
    // PINHOLE_SPAWN='' means "inject nothing" and PINHOLE_HOST_DISPLAY='' means "there is no host
    // desktop" (docs/configuration.md). Dropping empty values would change both.
    const { vars } = parseEnvFile('PINHOLE_SPAWN=\nPINHOLE_HOST_DISPLAY=""')
    expect(vars.PINHOLE_SPAWN).toBe('')
    expect(vars.PINHOLE_HOST_DISPLAY).toBe('')
  })

  it('lets a later line win, as systemd does', () => {
    expect(parseEnvFile('PINHOLE_PORT=1\nPINHOLE_PORT=2').vars.PINHOLE_PORT).toBe('2')
  })

  it('tolerates CRLF', () => {
    expect(parseEnvFile('PINHOLE_PORT=8787\r\nPINHOLE_HOST=127.0.0.1\r\n').vars).toEqual({
      PINHOLE_PORT: '8787',
      PINHOLE_HOST: '127.0.0.1',
    })
  })
})

describe('parseEnvFile — what it refuses, and why each one matters', () => {
  it('refuses `export`, because systemd would read the key as "export PINHOLE_…"', () => {
    const { vars, warnings } = parseEnvFile('export PINHOLE_ORIGIN=https://x')
    expect(vars).toEqual({})
    expect(warnings.join('\n')).toMatch(/export/)
  })

  it('refuses spaces around `=`, because the key would include the space', () => {
    const { vars, warnings } = parseEnvFile('PINHOLE_ORIGIN = https://x')
    expect(vars).toEqual({})
    expect(warnings.join('\n')).toMatch(/no spaces around/)
  })

  it('refuses keys that are not PINHOLE_* — a file that sets PATH is a code-execution path', () => {
    const { vars, warnings } = parseEnvFile(
      [
        'PATH=/tmp/evil',
        'LD_PRELOAD=/tmp/evil.so',
        'DISPLAY=:0',
        'ew_origin=https://x', // case matters: PINHOLE_* is upper case
      ].join('\n'),
    )
    expect(vars).toEqual({})
    expect(warnings).toHaveLength(4)
    expect(warnings.join('\n')).toMatch(/only set PINHOLE_\* keys/)
  })

  it('refuses line continuations', () => {
    const { vars, warnings } = parseEnvFile('PINHOLE_SPAWN=xterm \\\n  -bg black')
    expect(vars).toEqual({})
    expect(warnings.join('\n')).toMatch(/continuation/)
  })

  it('refuses a line with no `=`', () => {
    expect(parseEnvFile('PINHOLE_ORIGIN').warnings.join('\n')).toMatch(/KEY=VALUE/)
  })

  it('does not expand `$` — it keeps the literal and says so', () => {
    // systemd does no expansion either, so the literal is what production would see. The
    // warning is about the author's expectation, not about the file being unusable.
    const { vars, warnings } = parseEnvFile('PINHOLE_SPAWN_CWD=$HOME/work\nPINHOLE_ORIGIN=${BASE}')
    expect(vars.PINHOLE_SPAWN_CWD).toBe('$HOME/work')
    expect(vars.PINHOLE_ORIGIN).toBe('${BASE}')
    expect(warnings).toHaveLength(2)
    expect(warnings.join('\n')).toMatch(/literal/)
  })

  it('keeps `~` literal, as docs/configuration.md documents', () => {
    // `PINHOLE_SPAWN_CWD=~/work` reaches the server as the four characters `~/wo…`; resolveSpawnCwd
    // expands it itself precisely because systemd hands it over unexpanded.
    expect(parseEnvFile('PINHOLE_SPAWN_CWD=~/work').vars.PINHOLE_SPAWN_CWD).toBe('~/work')
  })
})

describe('applyEnvFile — the environment always wins', () => {
  it('fills only what is unset, and reports both halves', () => {
    const file = tempFile('PINHOLE_ORIGIN=https://from-file\nPINHOLE_MAX_CLIENTS=5\n')
    const env: NodeJS.ProcessEnv = { PINHOLE_ENV_FILE: file, PINHOLE_MAX_CLIENTS: '1' }
    const r = applyEnvFile(env)
    expect(env.PINHOLE_ORIGIN).toBe('https://from-file') // was unset ⇒ the file sets it
    expect(env.PINHOLE_MAX_CLIENTS).toBe('1') // was set ⇒ the file loses
    expect(r.applied).toEqual(['PINHOLE_ORIGIN'])
    expect(r.overridden).toEqual(['PINHOLE_MAX_CLIENTS'])
    expect(r.files).toEqual([file])
  })

  it('names what came from the file, the way the client names sticky flags', () => {
    const file = tempFile('PINHOLE_ORIGIN=https://x\n')
    const r = applyEnvFile({ PINHOLE_ENV_FILE: file })
    const banner = envFileBanner(r).join('\n')
    expect(banner).toContain(file)
    expect(banner).toContain('PINHOLE_ORIGIN')
  })

  it('ignores a group- or world-writable file instead of obeying it', () => {
    // Another local account could put PINHOLE_AUTH=0 in it. Refusing the file (not the start-up)
    // fails safe: every control keeps its secure default and the reason is on screen.
    const file = tempFile('PINHOLE_AUTH=0\n', 0o666)
    const env: NodeJS.ProcessEnv = { PINHOLE_ENV_FILE: file }
    const r = applyEnvFile(env)
    expect(env.PINHOLE_AUTH).toBeUndefined()
    expect(r.applied).toEqual([])
    expect(r.lines.join('\n')).toMatch(/WRITABLE by others/)
    expect(r.lines.join('\n')).toMatch(/chmod 600/)
  })

  it('says so when an explicit path is missing (a typo), and stays quiet for a missing default', () => {
    const r = applyEnvFile({ PINHOLE_ENV_FILE: '/nonexistent/pw/env' })
    expect(r.lines.join('\n')).toMatch(/not found/)
    // No PINHOLE_ENV_FILE at all and no files on disk ⇒ nothing to say. (HOME is pointed somewhere
    // empty so this does not depend on the developer's own machine.)
    const empty = mkdtempSync(join(tmpdir(), 'pw-home-'))
    dirs.push(empty)
    expect(applyEnvFile({ HOME: empty, XDG_CONFIG_HOME: empty }).lines).toEqual([])
  })

  it('does nothing at all when PINHOLE_ENV_FILE is empty — the "ignore my config" switch', () => {
    const env: NodeJS.ProcessEnv = { PINHOLE_ENV_FILE: '' }
    const r = applyEnvFile(env)
    expect(r.files).toEqual([])
    expect(r.applied).toEqual([])
    expect(envFileCandidates(env)).toEqual([])
  })
})

describe('envFileCandidates — where it looks', () => {
  it('prefers the state dir, then XDG config', () => {
    expect(envFileCandidates({ HOME: '/home/u', XDG_CONFIG_HOME: '/home/u/.conf' })).toEqual([
      '/home/u/.pinhole-window/env',
      '/home/u/.conf/pinhole-window/env',
    ])
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset or empty', () => {
    expect(envFileCandidates({ HOME: '/home/u' })[1]).toBe('/home/u/.config/pinhole-window/env')
    expect(envFileCandidates({ HOME: '/home/u', XDG_CONFIG_HOME: '' })[1]).toBe(
      '/home/u/.config/pinhole-window/env',
    )
  })

  it('does not follow PINHOLE_STATE_DIR — the file may set it, so that would be circular', () => {
    const c = envFileCandidates({ HOME: '/home/u', PINHOLE_STATE_DIR: '/somewhere/else' })
    expect(c.join(' ')).not.toContain('/somewhere/else')
  })

  it('reads both files, and the state-dir file wins a key both set, as in the unit', () => {
    const home = mkdtempSync(join(tmpdir(), 'pw-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.pinhole-window'))
    mkdirSync(join(home, '.config', 'pinhole-window'), { recursive: true })
    writeFileSync(join(home, '.pinhole-window', 'env'), 'PINHOLE_PORT=1\n')
    chmodSync(join(home, '.pinhole-window', 'env'), 0o600)
    writeFileSync(join(home, '.config', 'pinhole-window', 'env'), 'PINHOLE_PORT=2\nPINHOLE_FPS=7\n')
    chmodSync(join(home, '.config', 'pinhole-window', 'env'), 0o600)
    const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') }
    const r = applyEnvFile(env)
    expect(env.PINHOLE_PORT).toBe('1') // set by both: the earlier candidate wins
    expect(env.PINHOLE_FPS).toBe('7') // set only by the second file: still applied
    expect(r.files).toHaveLength(2)
    expect(r.applied).toEqual(['PINHOLE_PORT', 'PINHOLE_FPS'])
    expect(r.overridden).toEqual([]) // the environment set neither
    expect(r.lines.join('\n')).toMatch(
      /PINHOLE_PORT is already set by .*\.pinhole-window\/env, which wins/,
    )
  })
})

// ── the shipped example ───────────────────────────────────────────────────────────────────
//
// `systemd/env.example` is the file an operator copies, so it must parse cleanly here — and,
// the format being systemd's subset, under `EnvironmentFile=` too.

describe('systemd/env.example', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const text = readFileSync(`${root}/systemd/env.example`, 'utf8')

  it('parses with no warnings — the example never teaches a rejected form', () => {
    expect(parseEnvFile(text).warnings).toEqual([])
  })

  it('ships auth on and the revoke-first cap, and nothing else uncommented', () => {
    // Everything optional is commented out, so copying the file verbatim changes only the
    // settings that have a defensible default to state out loud.
    expect(parseEnvFile(text).vars).toEqual({
      PINHOLE_AUTH: '1',
      PINHOLE_MAX_CLIENTS: '1',
      PINHOLE_HOST: '127.0.0.1',
      PINHOLE_PORT: '8787',
    })
  })

  it('does not ship a value this parser would drop', () => {
    // A commented line is not checked by `parseEnvFile`, so the examples inside comments are
    // checked here: uncommenting one must not produce a warning.
    const uncommented = text
      .split('\n')
      .map(l => l.replace(/^#\s?(PINHOLE_[A-Z0-9_]+=)/, '$1'))
      .filter(l => /^PINHOLE_[A-Z0-9_]+=/.test(l))
      // Drop trailing `# …` notes, which a real operator would also not type.
      .map(l => l.replace(/\s+#.*$/, ''))
      .join('\n')
    expect(parseEnvFile(uncommented).warnings).toEqual([])
  })
})
