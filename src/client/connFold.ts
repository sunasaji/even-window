// When the `connection` fold opens and closes by itself. Pure, and a leaf.
//
// The fold opens when something about the connection needs the user, and closes again when
// that is resolved, but only if it was this code that opened it and the user has not touched
// it since. A fold the user opened is the user's.

export interface ConnFold {
  /** Is the fold open right now? */
  open: boolean
  /** We opened it, and the user has not toggled it since. */
  auto: boolean
  /** The problem it was last opened for; '' when there is none. A problem opens the fold once,
   *  so a user who closes it during an outage is not fought on every redraw. */
  reason: string
}

/** The next state. `reason` names what needs the user now ('' for nothing); `resolved` is true
 *  when the connection is known to work, as opposed to not yet known. */
export function connFoldStep(s: ConnFold, reason: string, resolved: boolean): ConnFold {
  if (reason) {
    if (reason === s.reason) return s
    return s.open ? { ...s, reason } : { open: true, auto: true, reason }
  }
  if (!resolved) return s
  // Pairing completed, the address was entered, or the server came back.
  if (s.open && s.auto) return { open: false, auto: false, reason: '' }
  return s.reason ? { ...s, reason: '' } : s
}

/** The user tapped the summary: from here on the fold is theirs. */
export function connFoldTouched(s: ConnFold, open: boolean): ConnFold {
  return { ...s, open, auto: false }
}
