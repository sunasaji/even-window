// Where Xephyr draws. Xephyr needs a host desktop to map its window into; with none, the
// server prefers headless Xvfb. A systemd user unit has no DISPLAY even when a desktop socket
// is reachable, so the host display is resolved from the socket directory, with the
// environment as a hint and EW_HOST_DISPLAY as the override. These tests pin that order, the
// explicit opt-out, and the one case that must never resolve: our own nested display.

import { describe, expect, it } from 'vitest'
import {
  backendOrder,
  describeXStartFailure,
  X_READY_MS,
} from '../src/server/platform/x11/session.ts'
import { resolveHostDisplay } from '../src/server/platform/x11/xenv.ts'

const socketsOf =
  (...names: string[]) =>
  () =>
    names

describe('resolveHostDisplay — the host desktop, if there is one', () => {
  it('prefers EW_HOST_DISPLAY over everything', () => {
    expect(resolveHostDisplay({ EW_HOST_DISPLAY: ':5', DISPLAY: ':0' }, socketsOf('X0'))).toBe(':5')
    expect(resolveHostDisplay({ EW_HOST_DISPLAY: '  :5  ' }, socketsOf())).toBe(':5')
  })

  // The operator must be able to say "there is no desktop" on a box that has one, to force the
  // headless preference. An empty value is that assertion, so it has to beat DISPLAY too.
  it('treats an empty EW_HOST_DISPLAY as "headless", even with a DISPLAY and a live socket', () => {
    expect(resolveHostDisplay({ EW_HOST_DISPLAY: '', DISPLAY: ':0' }, socketsOf('X0'))).toBeNull()
    expect(resolveHostDisplay({ EW_HOST_DISPLAY: '   ' }, socketsOf('X0'))).toBeNull()
  })

  it('takes DISPLAY when it is set — a login shell or scripts/dev.sh exported it', () => {
    expect(resolveHostDisplay({ DISPLAY: ':0' }, socketsOf('X0', 'X7'))).toBe(':0')
    // Not normalised: a host:port form is a legitimate DISPLAY and must survive verbatim.
    expect(resolveHostDisplay({ DISPLAY: '127.0.0.1:0' }, socketsOf())).toBe('127.0.0.1:0')
  })

  // The systemd case: no DISPLAY at all, desktop reachable anyway.
  it('falls back to the lowest X socket when the environment says nothing', () => {
    expect(resolveHostDisplay({}, socketsOf('X100', 'X7', 'X0'), ':100')).toBe(':0')
    expect(resolveHostDisplay({ DISPLAY: '' }, socketsOf('X0'), ':100')).toBe(':0')
  })

  // Load-bearing: Xephyr pointed at the display it is creating would nest inside itself.
  it('never offers our own nested display as the host', () => {
    expect(resolveHostDisplay({}, socketsOf('X100'), ':100')).toBeNull()
    expect(resolveHostDisplay({}, socketsOf('X100', 'X180'), ':100')).toBe(':180')
  })

  it('ignores anything in the directory that is not an X<n> socket, and an unreadable dir', () => {
    expect(resolveHostDisplay({}, socketsOf('Xtest', 'X11-unix', 'X1'), ':100')).toBe(':1')
    expect(resolveHostDisplay({}, socketsOf(), ':100')).toBeNull()
  })
})

describe('backendOrder — the preference the host display decides', () => {
  it('prefers Xephyr with a host display, Xvfb without, and keeps the other as fallback', () => {
    expect(backendOrder(':0')).toEqual(['Xephyr', 'Xvfb'])
    expect(backendOrder(null)).toEqual(['Xvfb', 'Xephyr'])
  })

  it('EW_BACKEND pins one backend with no fallback, host display or not', () => {
    const saved = process.env.EW_BACKEND
    try {
      process.env.EW_BACKEND = 'xephyr'
      expect(backendOrder(null)).toEqual(['Xephyr'])
      process.env.EW_BACKEND = 'XVFB'
      expect(backendOrder(':0')).toEqual(['Xvfb'])
      process.env.EW_BACKEND = 'auto'
      expect(backendOrder(':0')).toEqual(['Xephyr', 'Xvfb'])
    } finally {
      if (saved === undefined) delete process.env.EW_BACKEND
      else process.env.EW_BACKEND = saved
    }
  })
})

describe('describeXStartFailure — the log names the cause', () => {
  it('an X server that exited: how, and how soon', () => {
    const s = describeXStartFailure({ kind: 'exited', code: 1, signal: null, afterMs: 120 }, ':100')
    expect(s).toContain('exited with code 1 after 120 ms')
    expect(
      describeXStartFailure({ kind: 'exited', code: null, signal: 'SIGKILL', afterMs: 9 }, ':100'),
    ).toContain('killed by SIGKILL')
  })

  it('an X server that runs but accepts nothing: which transport said what', () => {
    const refused = describeXStartFailure(
      { kind: 'no-answer', afterMs: 5000, tcp: 'refused' },
      ':100',
    )
    expect(refused).toContain('still running after 5000 ms')
    expect(refused).toContain('/tmp/.X11-unix/X100')
    expect(refused).toContain('nothing listens on TCP port 6100')
    // Silence on loopback is not "not listening": it points at something dropping packets.
    expect(
      describeXStartFailure({ kind: 'no-answer', afterMs: 5000, tcp: 'silent' }, ':100'),
    ).toContain('gave no answer at all')
  })

  it('the wait is five seconds of elapsed time', () => {
    expect(X_READY_MS).toBe(5000)
  })
})
