// OpenSSH's "drunken bishop" ASCII art over a key fingerprint.
//
// Randomart is only worth comparing when each side computes it from the key material that
// side holds: a pre-rendered grid is whatever the sender chose to draw. So the device draws
// its grid from its own public key (src/client/pairingUI.ts) and the server from the key it
// staged (src/server/auth.ts). `scripts/pw-auth.mjs` displays the server's stored `art`: same
// host and user, so no trust boundary. See docs/decisions/pairing-randomart.md.

/** Randomart over a hex fingerprint: a small ASCII grid a human can compare at a glance.
 *  Pure; both sides import this one implementation. */
export function randomart(fpHex: string, label = 'PinholeWindow'): string {
  const W = 17,
    H = 9,
    CH = ' .o+=*BOX@%&#/^SE'
  const board: number[] = new Array<number>(W * H).fill(0)
  let x = (W - 1) >> 1,
    y = (H - 1) >> 1
  const bytes = fpHex.match(/../g)?.map(h => parseInt(h, 16)) ?? []
  for (const byte of bytes) {
    for (let i = 0; i < 4; i++) {
      const b = (byte >> (2 * i)) & 3
      x = Math.max(0, Math.min(W - 1, x + (b & 1 ? 1 : -1)))
      y = Math.max(0, Math.min(H - 1, y + (b & 2 ? 1 : -1)))
      const p = y * W + x
      if ((board[p] ?? 0) < 14) board[p] = (board[p] ?? 0) + 1
    }
  }
  board[((H - 1) >> 1) * W + ((W - 1) >> 1)] = 15 // S (start)
  board[y * W + x] = 16 // E (end)
  const bar = (mid: string): string => {
    const t = mid ? `[${mid}]` : ''
    const dash = W - t.length
    const l = dash >> 1
    return '+' + '-'.repeat(l) + t + '-'.repeat(dash - l) + '+'
  }
  const rows: string[] = [bar(label.slice(0, W - 2))]
  for (let r = 0; r < H; r++)
    rows.push(
      '|' +
        board
          .slice(r * W, r * W + W)
          .map(v => CH[v] ?? ' ')
          .join('') +
        '|',
    )
  rows.push(bar(''))
  return rows.join('\n')
}
