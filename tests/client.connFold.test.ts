// The `connection` fold opens for a problem and closes when it is resolved, but never takes a
// fold away from a user who opened or toggled it.

import { describe, expect, it } from 'vitest'
import { type ConnFold, connFoldStep, connFoldTouched } from '../src/client/connFold.ts'

const shut: ConnFold = { open: false, auto: false, reason: '' }

describe('connFoldStep', () => {
  it('opens for a problem and closes when the connection works again', () => {
    const down = connFoldStep(shut, 'offline', false)
    expect(down).toEqual({ open: true, auto: true, reason: 'offline' })
    expect(connFoldStep(down, '', true)).toEqual(shut)
  })

  it('closes after pairing completes or an address is entered, the same way', () => {
    const unpaired = connFoldStep(shut, 'unpaired', false)
    // `unknown` in between (the stream is being re-opened): nothing is known yet, so wait.
    const waiting = connFoldStep(unpaired, '', false)
    expect(waiting.open).toBe(true)
    expect(connFoldStep(waiting, '', true).open).toBe(false)
  })

  it('leaves a fold the user opened', () => {
    const mine = connFoldTouched(shut, true)
    const down = connFoldStep(mine, 'offline', false)
    expect(down).toEqual({ open: true, auto: false, reason: 'offline' })
    expect(connFoldStep(down, '', true).open).toBe(true)
  })

  it('leaves a fold the user touched after it opened by itself', () => {
    const down = connFoldStep(shut, 'offline', false)
    // Closed and reopened by hand while the server was down.
    const touched = connFoldTouched(connFoldTouched(down, false), true)
    expect(connFoldStep(touched, '', true).open).toBe(true)
  })

  it('does not reopen for the same problem after the user closed it', () => {
    const down = connFoldStep(shut, 'offline', false)
    const closed = connFoldTouched(down, false)
    expect(connFoldStep(closed, 'offline', false).open).toBe(false)
    // A different problem is news, and so is the same one after a recovery.
    expect(connFoldStep(closed, 'unauthorized', false).open).toBe(true)
    const recovered = connFoldStep(closed, '', true)
    expect(connFoldStep(recovered, 'offline', false).open).toBe(true)
  })

  it('stays open while a new enrolled key is unacknowledged, even with the server answering', () => {
    const keys = connFoldStep(shut, 'keys', true)
    expect(keys.open).toBe(true)
    expect(connFoldStep(keys, 'keys', true).open).toBe(true)
    expect(connFoldStep(keys, '', true).open).toBe(false) // acknowledged
  })
})
