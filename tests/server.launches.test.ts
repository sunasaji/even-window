// Tests for the window → launcher-entry attribution (src/server/launches.ts), which gives a
// window its `app:` swipe identity (docs/glasses.md) without stamping anything onto it.
//
// The pid-ancestry path runs against real processes (this test's own, and a child it spawns):
// what is tested is a process-table walk. The timing path is driven by passing `now`.

import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appIdOfWindow,
  CLAIM_MS,
  claimWindow,
  noteLaunchPid,
  pruneClaims,
  resetLaunches,
} from '../src/server/launches.ts'

afterEach(() => {
  resetLaunches()
})

describe('no launch pending', () => {
  it('claims nothing, and says so rather than guessing', () => {
    expect(claimWindow('0x400001', 1234)).toBe('')
    expect(appIdOfWindow('0x400001')).toBe('')
  })
})

describe('claim by pid ancestry (the exact path)', () => {
  it('attributes a window whose process is the one we launched', () => {
    noteLaunchPid('x11:xcalc', process.pid)
    expect(claimWindow('0x400001', process.pid)).toBe('x11:xcalc')
    expect(appIdOfWindow('0x400001')).toBe('x11:xcalc')
  })

  // A real launch has indirection (`sh -c 'xterm …'`, `xterm -e htop`, a wrapper script): the
  // window belongs to a descendant of what was spawned, so pid equality would miss it.
  it('attributes a window owned by a child of the launched process', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
    try {
      expect(child.pid).toBeTruthy()
      noteLaunchPid('x11:wrapper', process.pid) // we "launched" this test process
      expect(claimWindow('0x400002', child.pid ?? 0)).toBe('x11:wrapper')
    } finally {
      child.kill()
    }
  })

  it('does not attribute an unrelated process to a pending launch', () => {
    noteLaunchPid('x11:xcalc', process.pid)
    // pid 1 is nobody's descendant here, and it has a pid — so the timing fallback must not
    // fire either. A wrong identity is worse than none: it fires someone else's binding.
    expect(claimWindow('0x400003', 1)).toBe('')
  })

  it('gives one launch to one window', () => {
    noteLaunchPid('x11:xcalc', process.pid)
    expect(claimWindow('0x400001', process.pid)).toBe('x11:xcalc')
    expect(claimWindow('0x400002', process.pid)).toBe('')
  })
})

describe('claim by timing (the fallback for windows with no pid at all)', () => {
  // A window that exposes no pid cannot be traced, so the unmatched launch takes it.
  it('attributes a pid-less window to the pending launch', () => {
    noteLaunchPid('desktop:xmountains', 4242, 1_000)
    expect(claimWindow('0xa', 0, 1_500)).toBe('desktop:xmountains')
  })

  it('expires: a window appearing long after the launch is not attributed', () => {
    noteLaunchPid('desktop:xmountains', 4242, 1_000)
    expect(claimWindow('0xb', 0, 1_000 + CLAIM_MS + 1)).toBe('')
  })

  it('takes the most recent unclaimed launch when two are in flight', () => {
    noteLaunchPid('x11:first', 1111, 1_000)
    noteLaunchPid('x11:second', 2222, 1_100)
    expect(claimWindow('0xc', 0, 1_200)).toBe('x11:second')
    expect(claimWindow('0xd', 0, 1_300)).toBe('x11:first')
    expect(claimWindow('0xe', 0, 1_400)).toBe('')
  })
})

describe('pruning', () => {
  // Window ids are reused; an inherited claim would be a wrong identity, not a missing one.
  it('forgets a claim once its window is gone', () => {
    noteLaunchPid('x11:xcalc', process.pid)
    claimWindow('0x400001', process.pid)
    expect(appIdOfWindow('0x400001')).toBe('x11:xcalc')
    pruneClaims(['0x400009'])
    expect(appIdOfWindow('0x400001')).toBe('')
  })

  it('keeps claims for windows that are still there', () => {
    noteLaunchPid('x11:xcalc', process.pid)
    claimWindow('0x400001', process.pid)
    pruneClaims(['0x400001', '0x400009'])
    expect(appIdOfWindow('0x400001')).toBe('x11:xcalc')
  })
})
