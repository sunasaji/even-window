# Authentication: design reasoning

Snapshot — not maintained. Conditions: reasoning recorded up to 2026-11; the code in
`src/server/auth.ts` is authoritative.

## Design points

The authentication code is `src/server/auth.ts`, the client auth module and
`scripts/ew-auth.mjs`. Choices worth recording:

- The state directory is `~/.even-window`, overridable with `EW_STATE_DIR` and resolved per
  call, so the caches are keyed by the resolved path.
- The gate checks the registry on every request, so a revoked key stops working at once.
  A stateless token would survive for its full lifetime after revocation.
- The page is not reloaded after pairing: a reload re-creates the
  glasses page, and doing that while streaming blacks out a lens.
- The client's key loader invalidates a cached "no identity" when the bridge store is wired
  up, because this client opens the stream before the bridge is ready.

## Key refresh compared with SSH

Three different things are easy to conflate.

| | SSH | pinhole-window |
| --- | --- | --- |
| Keys that encrypt traffic | Session keys from the key exchange, rekeyed by data volume (OpenSSH default; RFC 4253 suggests 1 GB or 1 hour) | None of its own. TLS and WireGuard do this and rekey more often (WireGuard about every 2 minutes; TLS 1.3 ephemeral keys per handshake) |
| How long "authenticated" lasts | As long as the connection, possibly days | 1 hour, then a new signature with the device key; ticket 60 s; challenge 2 minutes, single use |
| Long-lived symmetric secret | None | `server-secret`, rotated only by hand |

Forward secrecy comes from the transport's ephemeral keys, not from token renewal. Scheduled
rotation of `server-secret` was not added: token exposure is already bounded by the one-hour
lifetime, and if a continuously synchronised backup is leaking, the new secret leaks with it.

## The `?server=` relay

1. The victim opens the real app with `?server=` pointing at the attacker. The app origin is
   genuine; only the API base moves.
2. The attacker fetches a challenge from the real server and gives that nonce to the device.
3. The device signs it with its enrolled key.
4. The attacker redeems the signature at the real server and holds a session for the
   victim's key.

It is also a phishing surface: the app mirrors the attacker's "desktop" and sends keystrokes
there. Two measures address it: a confirmation tap when a paired device is given a different
`?server=`, and the origin inside the signed material. The confirmation is not
asked of unpaired devices or when no value is stored, so the simulator, which passes the same
`?server=` every run, does not train anyone to dismiss it. The pending value is adopted
without a reload.

General principle: verification is done by the side that has something
to lose, using material the other side did not hand it. The device-drawn randomart is the
same principle in the other direction.

## Alternatives rejected

| Alternative | Problem | Chosen instead |
| --- | --- | --- |
| Signature over a bare nonce | Relayable through `?server=` | Origin-bound material, no fallback |
| Long-lived session token, also used in the stream URL | Long-lived credential in logs | 1-hour session, 60-second ticket, kind inside the MAC |
| Device displays the server's randomart | Vacuous against an in-path attacker | Device draws its own |
| Reminder to revoke after re-pairing | Not a control | `EW_MAX_CLIENTS` default 1 |
| Warn at start when the registry is over the cap | The exposure is wider than the warning suggests | Refuses to start |
| An override for the cap | Guarded only by a log line | None; a test asserts no such switch exists |
| Secret cached by directory only | Deleting the file has no effect until restart | Stat-gated cache |
| State directory `0755` | Registry readable by local accounts | `0700` / `0600`, banner for old directories |
| CORS `*` | Any page could reach an auth-off server | Narrow origin policy |
| `GET /api/health` open | Reconnaissance | Gated; probes accept 401 |
| `qrencode` required for the pairing QR | Absent on most machines | Rendered by the script |

## Smaller choices

- The pairing QR uses two spaces per module with explicit ANSI background colours (square
  modules, same on light and dark terminals) and error-correction level L: a 53-character
  URL is 29 modules, 66 columns, fitting an 80-column terminal (level M: 33 modules, 74
  columns). It is not printed when stdout is not a terminal.
- `pair` and `open` refuse to open a window when no slot is free, so nobody walks to the
  device only to be refused at `approve`.
- The source address recorded at pairing prefers `X-Forwarded-For`; it is shown to a human
  and never compared. The rate limiter ignores that header.
- The server does not `chmod` an existing state directory; changing modes unasked is its own
  surprise.
- Removed keys are reported to clients without an alarm; red is reserved for additions.
- A harness started where a production server was meant shows up as "no client keys
  enrolled", which is why the key count and registry path are in the banner.
- A liveness probe that treats 401 as failure reports a healthy server as down.
