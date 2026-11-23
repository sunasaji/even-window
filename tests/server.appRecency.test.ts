// even-window — launch recency (src/server/appRecency.ts): the order behind the glasses menu's
// curated slots. OS-neutral; the application list it filters against is a plain array here.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recentApps, resetAppRecency } from '../src/server/appRecency.ts'
import type { LauncherEntry } from '../src/shared/types.ts'

/** The default client's command, as `platform.apps.seedCommand()` reports it on the X11 backend. */
const BOOT = 'xterm'

describe("launch recency — the glasses menu's curated slots", () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ew-apps-'))
    process.env.EW_STATE_DIR = dir
    resetAppRecency()
  })
  afterEach(() => {
    delete process.env.EW_STATE_DIR
    resetAppRecency()
    rmSync(dir, { recursive: true, force: true })
  })

  const list: LauncherEntry[] = [
    {
      id: 'x11:xcalc',
      name: 'xcalc',
      cmd: 'xcalc',
      args: [],
      note: 'section-x11',
      terminal: false,
    },
    {
      id: 'desktop:debian-xterm',
      name: 'XTerm',
      cmd: 'xterm',
      args: [],
      note: 'desktop',
      terminal: false,
    },
  ]

  it('seeds with the default client, so a fresh install has a non-empty menu', () => {
    // EW_SPAWN's program is the one application we know the operator wants on that display.
    expect(recentApps(list, BOOT)).toEqual(['desktop:debian-xterm'])
  })

  it('reads back what was written, most recent first', () => {
    writeFileSync(
      join(dir, 'apps-recent.json'),
      JSON.stringify({ recent: ['x11:xcalc', 'desktop:debian-xterm'] }),
    )
    expect(recentApps(list, BOOT)).toEqual(['x11:xcalc', 'desktop:debian-xterm'])
  })

  it('drops an id the list no longer has (uninstalled, or hidden in apps.conf)', () => {
    writeFileSync(
      join(dir, 'apps-recent.json'),
      JSON.stringify({ recent: ['x11:gone', 'x11:xcalc'] }),
    )
    // …and the seed fills the slot the dead id left, at the back.
    expect(recentApps(list, BOOT)).toEqual(['x11:xcalc', 'desktop:debian-xterm'])
  })

  it('keeps the seed as a filler after a launch, but never ahead of it', () => {
    writeFileSync(join(dir, 'apps-recent.json'), JSON.stringify({ recent: ['x11:xcalc'] }))
    expect(recentApps(list, BOOT)).toEqual(['x11:xcalc', 'desktop:debian-xterm'])
    // The seed is not duplicated when it is the most recent thing.
    writeFileSync(
      join(dir, 'apps-recent.json'),
      JSON.stringify({ recent: ['desktop:debian-xterm', 'x11:xcalc'] }),
    )
    resetAppRecency()
    expect(recentApps(list, BOOT)).toEqual(['desktop:debian-xterm', 'x11:xcalc'])
  })

  it('survives a corrupt or non-JSON file by falling back to the seed', () => {
    writeFileSync(join(dir, 'apps-recent.json'), 'not json {')
    expect(recentApps(list, BOOT)).toEqual(['desktop:debian-xterm'])
  })
})
