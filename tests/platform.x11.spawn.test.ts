// The default spawned client.
//
// The G2 is an optical see-through display: black = no emission = transparent, bright =
// emitting. A light-background terminal therefore lights the entire lens. These tests pin the
// polarity of the default client and the property that makes a default with flags safe: its
// shell-string form (`sh -c` at start-up) and its argv form (the terminal wrapper) are the
// same command.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitExec } from '../src/server/platform/x11/desktop.ts'
import { DEFAULT_SPAWN_ARGV, DEFAULT_SPAWN_CMD } from '../src/server/platform/x11/session.ts'
import { resolveSpawnCwd, SPAWN_CWD } from '../src/server/platform/x11/xenv.ts'

describe('the default client is dark-background', () => {
  it('sets an explicit black background and a light foreground', () => {
    const argv = [...DEFAULT_SPAWN_ARGV]
    expect(argv[argv.indexOf('-bg') + 1]).toBe('black')
    expect(argv[argv.indexOf('-fg') + 1]).toBe('white')
  })

  it('is not a bare terminal — a bare xterm is black-on-white and lights the whole lens', () => {
    expect(DEFAULT_SPAWN_ARGV.length).toBeGreaterThan(1)
    expect(DEFAULT_SPAWN_CMD).not.toBe('xterm')
  })

  it('pins a legible fixed-pitch bitmap font (no antialiasing to quantise wrong)', () => {
    const argv = [...DEFAULT_SPAWN_ARGV]
    const fn = argv[argv.indexOf('-fn') + 1] ?? ''
    expect(fn).not.toBe('')
    // An X core XLFD, bold, 18px tall, 9px wide (c-90) => 64x16 cells on 576x288.
    expect(fn).toMatch(/^-misc-fixed-bold-/)
    expect(fn).toContain('-c-90-')
  })

  it('leaves the cursor emitting rather than punched out of the text', () => {
    const argv = [...DEFAULT_SPAWN_ARGV]
    expect(argv[argv.indexOf('-cr') + 1]).toBe('white')
  })
})

describe('the default survives both call sites', () => {
  // ensureClient runs `sh -c SPAWN_CMD`; a terminal application is exec'd with the argv form.
  // Joining argv into a command line is only lossless if no token needs quoting, so that is a
  // property of the default, enforced here rather than hoped for.
  it('no token contains whitespace or shell syntax, so the join is lossless', () => {
    for (const tok of DEFAULT_SPAWN_ARGV) {
      expect(tok, `token ${JSON.stringify(tok)}`).not.toMatch(/\s/)
      expect(tok, `token ${JSON.stringify(tok)}`).not.toMatch(/['"`$\\*?~;&|<>()]/)
    }
  })

  it('the shell-string form starts with the same program as the argv form', () => {
    expect(DEFAULT_SPAWN_CMD.split(' ')[0]).toBe(DEFAULT_SPAWN_ARGV[0])
  })
})

describe('the default parsed as a .desktop Exec line', () => {
  it('splits back into the argv form, so both forms name the same command', () => {
    expect(splitExec(DEFAULT_SPAWN_CMD)).toEqual([...DEFAULT_SPAWN_ARGV])
  })
})

// Where the client starts (PINHOLE_SPAWN_CWD). A spawned client is usually a terminal whose prompt
// the operator reads on the glasses, so its cwd is part of the UI and must not be the state
// directory. These tests pin the resolution rules, including the two that exist because a
// systemd EnvironmentFile never runs a shell and because a typo must degrade, not kill the spawn.

describe('PINHOLE_SPAWN_CWD resolution', () => {
  const home = mkdtempSync(join(tmpdir(), 'pw-home-'))
  const sub = join(home, 'work')
  mkdirSync(sub, { recursive: true })
  const file = join(home, 'notadir')
  writeFileSync(file, 'x')
  const never = (): void => {
    throw new Error('warned when it should not have')
  }

  it('falls back to $HOME when unset, empty or blank', () => {
    expect(resolveSpawnCwd(undefined, home, never)).toBe(home)
    expect(resolveSpawnCwd('', home, never)).toBe(home)
    expect(resolveSpawnCwd('   ', home, never)).toBe(home)
  })

  it('takes an absolute directory as-is, whitespace trimmed', () => {
    expect(resolveSpawnCwd(sub, home, never)).toBe(sub)
    expect(resolveSpawnCwd(`  ${sub}  `, home, never)).toBe(sub)
  })

  // systemd's EnvironmentFile does not run a shell: `PINHOLE_SPAWN_CWD=~/work` arrives as the
  // literal string '~/work'. Without this expansion it would mean a directory named '~'.
  it("expands a leading '~' itself, because no shell will", () => {
    expect(resolveSpawnCwd('~', home, never)).toBe(home)
    expect(resolveSpawnCwd('~/work', home, never)).toBe(sub)
  })

  // process.cwd() is whatever the unit or launcher happened to use, so $HOME is the only base
  // that can be relied on.
  it('resolves a relative path against $HOME, not the process cwd', () => {
    expect(resolveSpawnCwd('work', home, never)).toBe(sub)
    expect(resolveSpawnCwd('./work', home, never)).toBe(sub)
  })

  // A bad value must not take the client down: spawn() would fail ENOENT, ensureClient() only
  // logs it, and the glasses would go blank with no visible cause.
  it('degrades to $HOME with one warning when the path is missing or not a directory', () => {
    const warns: string[] = []
    const warn = (m: string): void => {
      warns.push(m)
    }
    expect(resolveSpawnCwd(join(home, 'nope'), home, warn)).toBe(home)
    expect(resolveSpawnCwd(file, home, warn)).toBe(home)
    expect(warns.length).toBe(2)
    expect(warns[0]).toContain('does not exist')
    expect(warns[1]).toContain('not a directory')
  })

  it('never silently points a client at our own state directory', () => {
    expect(resolveSpawnCwd(undefined, home, never)).not.toContain('.pw-x11')
    expect(SPAWN_CWD).not.toContain('.pw-x11')
  })
})
