// even-window — URL / stored flag parsing (pure) and the sticky-flag note.
//
// A leaf: it imports no other client module, so anything may use it at load time.

// ── the phone mirror's rendering mode ──────────────────────────────────────────────────────
//
// Colour by default: the server sends a 16-colour indexed PNG, so the colour mirror is cheap and
// more informative. `green` simulates the lens and is the way to judge polarity and legibility
// without putting the glasses on. `invert` has no visible effect on the colour mirror.
export type MirrorMode = 'color' | 'green'

/** Parse the mirror mode. `null` = "not specified, defer to the next source" — an unknown value
 *  is not coerced: `?mirror=gren` must not read as a deliberate choice of anything. */
export function parseMirrorMode(raw: string | null | undefined): MirrorMode | null {
  if (raw === null || raw === undefined) return null
  const s = raw.trim().toLowerCase()
  if (s === 'color' || s === 'colour' || s === '1') return 'color'
  if (s === 'green' || s === 'grey' || s === 'gray' || s === 'mono' || s === '0') return 'green'
  return null
}

/** The mode the preview can actually be drawn in, given the user's choice and whether the pump
 *  is live. The green plane is written by `deriveGrey`, which runs inside the pump; when the
 *  pump stands down (link down, lens paused) a green preview would freeze, while colour is
 *  painted on arrival. The choice itself is remembered (`mirrorChoice`) and comes back. */
export function effectiveMirrorMode(chosen: MirrorMode, pumpLive: boolean): MirrorMode {
  return pumpLive ? chosen : 'color'
}

/** Parse a boolean flag from a query string / storage value. `null` = "not specified, defer to
 *  the next source". A bare `?flag` (empty value) reads as on — presence is the flag. */
export function parseFlag(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null
  const s = raw.trim().toLowerCase()
  if (s === '' || s === '1' || s === 'true' || s === 'on' || s === 'yes') return true
  if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false
  return null
}

/** The invert flag's parser. It is `parseFlag` — every `?flag=` in this client shares one
 *  grammar — under the name the invert tests use. */
export const parseInvert = parseFlag

/** Read a flag from this URL only, with the shared grammar and no persistence.
 *
 *  Two kinds of flag (docs/decisions/instrument-flags-query-only.md): a setting (`server`,
 *  `invert`, `scrollnat`) is what this install runs as and persists across WebView teardowns;
 *  an instrument or run mode (`stats`, `debug`) belongs to one capture and persists nowhere, so
 *  it is off by default on every load. */
export function queryFlag(name: string): boolean {
  try {
    return parseFlag(new URLSearchParams(location.search).get(name)) ?? false
  } catch {
    return false
  } // no location (vitest/node)
}

// ── which source decided a flag ────────────────────────────────────────────────────────────
//
// The resolvers record where each value came from, so the boot log can name the stored ones
// outright instead of leaving the reader to compare the query with the resolved values.

export type FlagSource = 'query' | 'stored' | 'default'

/** Which source decided, given whether each one spoke. Speaking is not the same as being
 *  present: `?invert=banana` parses to `null` and decides nothing. */
export function flagSource(queried: boolean, stored: boolean): FlagSource {
  return queried ? 'query' : stored ? 'stored' : 'default'
}

/** The flags this load took from localStorage rather than from its URL, in resolution order.
 *  Written by the setting resolvers at init, read once by the boot log. */
export const stickyFlags: { name: string; value: string }[] = []

export function noteFlag(name: string, from: FlagSource, value: string): void {
  if (from === 'stored') stickyFlags.push({ name, value })
}

/** The line that makes a stale stored flag self-diagnosing, or `''` when this load's URL (or
 *  the defaults) decided everything. It prints each value and a per-flag hint. */
export function stickyLine(stuck: readonly { name: string; value: string }[]): string {
  if (stuck.length === 0) return ''
  return (
    `sticky: ${stuck.map(s => `${s.name}=${s.value}`).join(' ')}` +
    ' — these came from localStorage, not from this URL. A flag that was ever passed stays' +
    ` set; only an explicit ${stuck.map(s => `?${s.name}=`).join(' / ')} changes it`
  )
}
