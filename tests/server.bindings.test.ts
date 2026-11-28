// Tests for the swipe-binding store (src/server/bindings.ts) — the file on disk, its
// validation on read, and the "did anything change" gate the SSE publication hangs off.
//
// The model itself is tested in shared.bindings.test.ts; nothing here re-tests resolution.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BINDINGS_FILE,
  bindingErrors,
  bindingsMap,
  bindingsPath,
  resetBindingsCache,
  setBinding,
} from '../src/server/bindings.ts'
import type { AppBinding } from '../src/shared/bindings.ts'

const PAGER: AppBinding = {
  up: { mods: [], key: 'Page_Up' },
  down: { mods: [], key: 'Page_Down' },
}
const VIM: AppBinding = {
  up: { mods: ['ctrl'], key: 'u' },
  down: { mods: ['ctrl'], key: 'd' },
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pw-bind-'))
  process.env.PINHOLE_STATE_DIR = dir
  resetBindingsCache()
})

afterEach(() => {
  delete process.env.PINHOLE_STATE_DIR
  resetBindingsCache()
  rmSync(dir, { recursive: true, force: true })
})

function writeRaw(text: string): void {
  writeFileSync(join(dir, BINDINGS_FILE), text)
  resetBindingsCache()
}

describe('a fresh install', () => {
  // Until someone configures a binding there is no file, no map, and DEFAULT_SWIPE applies.
  it('has no file, an empty map and no complaints', () => {
    expect(bindingsMap()).toEqual({})
    expect(bindingErrors()).toEqual([])
    expect(bindingsPath()).toBe(join(dir, BINDINGS_FILE))
  })
})

describe('setBinding', () => {
  it('writes the file and reports that something changed', () => {
    expect(setBinding('comm:less', PAGER)).toBe(true)
    expect(bindingsMap()).toEqual({ 'comm:less': PAGER })
    const onDisk: unknown = JSON.parse(readFileSync(bindingsPath(), 'utf8'))
    expect(onDisk).toEqual({ bindings: { 'comm:less': PAGER } })
  })

  // What a double-tap on `apply` must look like: accepted, not an error, but no SSE storm.
  it('reports false for a write that changes nothing', () => {
    expect(setBinding('comm:less', PAGER)).toBe(true)
    expect(
      setBinding('comm:less', {
        up: { mods: [], key: 'Page_Up' },
        down: { mods: [], key: 'Page_Down' },
      }),
    ).toBe(false)
    expect(setBinding('comm:less', VIM)).toBe(true)
  })

  it('refuses a key that is not an app key, without touching the map', () => {
    expect(setBinding('xterm', PAGER)).toBe(false)
    expect(setBinding('nope:foo', PAGER)).toBe(false)
    expect(setBinding('comm:XTerm', PAGER)).toBe(false) // un-normalised
    expect(bindingsMap()).toEqual({})
  })

  it('deletes with null, and says so only when there was something to delete', () => {
    setBinding('comm:less', PAGER)
    setBinding('*', VIM)
    expect(setBinding('comm:less', null)).toBe(true)
    expect(setBinding('comm:less', null)).toBe(false)
    expect(bindingsMap()).toEqual({ '*': VIM })
  })

  it('survives a reload — the point of persisting at all', () => {
    setBinding('cls:navigator', VIM)
    resetBindingsCache()
    expect(bindingsMap()).toEqual({ 'cls:navigator': VIM })
  })
})

describe('reading a file a human has edited', () => {
  it('accepts a bare map as well as the {bindings:…} wrapper', () => {
    writeRaw(JSON.stringify({ 'comm:less': PAGER }))
    expect(bindingsMap()).toEqual({ 'comm:less': PAGER })
  })

  it('canonicalises modifier order on the way in', () => {
    writeRaw(
      JSON.stringify({
        bindings: { 'comm:vim': { up: { mods: ['shift', 'ctrl'], key: 'u' }, down: { key: 'd' } } },
      }),
    )
    expect(bindingsMap()['comm:vim']?.up).toEqual({ mods: ['ctrl', 'shift'], key: 'u' })
    expect(bindingsMap()['comm:vim']?.down).toEqual({ mods: [], key: 'd' })
  })

  // One bad entry must not cost the user the others, and it must not be dropped silently.
  it('keeps the good entries, drops the bad ones and complains about them', () => {
    writeRaw(
      JSON.stringify({
        bindings: {
          'comm:less': PAGER,
          'comm:typo': { up: { key: 'PageUp' }, down: { key: 'PageDown' } }, // tmux-ish spelling
        },
      }),
    )
    expect(Object.keys(bindingsMap())).toEqual(['comm:less'])
    expect(bindingErrors().join('\n')).toContain('comm:typo')
  })

  it('treats unparseable JSON as "no bindings" rather than crashing the gesture path', () => {
    writeRaw('{ this is not json')
    expect(bindingsMap()).toEqual({})
  })

  // A write after a bad read must not resurrect the dropped entry, and must not lose the
  // complaint that explains why it is gone.
  it('a later write keeps the surviving entries and the complaint', () => {
    writeRaw(
      JSON.stringify({ bindings: { 'comm:bad': { up: { key: 'nope' }, down: { key: 'Down' } } } }),
    )
    expect(bindingErrors()).toHaveLength(1)
    expect(setBinding('comm:less', PAGER)).toBe(true)
    expect(bindingsMap()).toEqual({ 'comm:less': PAGER })
    expect(bindingErrors()).toHaveLength(1)
  })
})

// ── the submit key rides in the same record (docs/phone-ui.md) ─────────────────────────────

describe('the per-app submit key on disk', () => {
  it('round-trips through the file, id and all', () => {
    expect(setBinding('comm:firefox', { ...PAGER, submit: 'ctrl+Return' })).toBe(true)
    resetBindingsCache()
    expect(bindingsMap()['comm:firefox']).toEqual({ ...PAGER, submit: 'ctrl+Return' })
    expect(readFileSync(join(dir, BINDINGS_FILE), 'utf8')).toContain('"submit": "ctrl+Return"')
  })

  // The gate `setBinding` uses to decide whether anything is worth writing and publishing.
  it('counts as a change on its own', () => {
    expect(setBinding('comm:less', PAGER)).toBe(true)
    expect(setBinding('comm:less', PAGER)).toBe(false)
    expect(setBinding('comm:less', { ...PAGER, submit: 'off' })).toBe(true)
  })

  // Reachable only by a hand edit: an id outside the closed list would save and do nothing.
  it('refuses an id that is not in the catalogue, and says so', () => {
    writeRaw(
      JSON.stringify({
        bindings: {
          'comm:less': { ...PAGER, submit: 'ctrl+Return' },
          'comm:vim': { ...VIM, submit: 'ctrl+alt+shift+Return' },
        },
      }),
    )
    expect(Object.keys(bindingsMap())).toEqual(['comm:less'])
    expect(bindingErrors().join('\n')).toContain('comm:vim')
  })
})
