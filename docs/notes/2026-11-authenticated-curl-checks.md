# Authenticated curl checks

Snapshot — not maintained. Conditions: November 2026, server with `PINHOLE_AUTH=1` on loopback,
test key from `scripts/pw-auth.mjs add-test`. The recipe is in
[development.md](../development.md#authenticated-curl); the contract is in
[security.md](../security.md).

## Session token and stream ticket are not interchangeable

| Sent | Result |
| --- | --- |
| `/api/stream?ticket=<ticket>` | 200 |
| `/api/stream?ticket=<session token>` | 401 |
| `Authorization: Bearer <session token>` → `/api/health` | 200 |
| `Authorization: Bearer <ticket>` → `/api/health` | 401 |

The kind is inside the MAC. Otherwise the long-lived token (1 h) would be what ends up in
URLs and the 60 s ticket lifetime would mean nothing.

## Origin binding

| Sent | Result |
| --- | --- |
| Signature over the right origin, same origin in the body | 200, token returned |
| Signature over an attacker origin (enrolled key, genuine nonce) | 401 |
| Attacker-origin signature with the body's origin rewritten to the right one | 401 |
| Origin omitted (old format) | 401 |

With `PINHOLE_ORIGIN` set, a harness run that inherits it refuses every signature a browser makes
at `127.0.0.1`, and all auth failures are the same 401; this is one reason the harness does
not read the operator's env file.

## Other observations

- A nonce is single-use: the second `POST /api/auth/session` with it is 401.
- Rate limit on unauthenticated routes: 60 rapid `GET /api/auth/challenge` gave 31 × 200 and
  29 × 429 (`retry-after: 1`); 120 rapid authenticated `GET /api/windows` gave 120 × 200. Log:
  `[pw] rate limit: refused 29 request(s) on open routes (latest /api/auth/challenge)`.
- `/api/health` requires auth, so `curl -f …/api/health` fails with auth on. The scripts
  accept 200 or 401 as ready.
- Pairing the simulator's WebView with `--auth`, headless: the "Pair this device" button was
  at `251 114` in the `Browser` window that day; on approval the client reconnects its stream
  with a ticket without reloading.
