# Only the open routes are rate limited

## Context

Four routes answer before authentication. One of them, `POST /api/auth/session`, runs an
asymmetric signature verification per call, the only unauthenticated CPU lever in the server;
`GET /api/auth/challenge` allocates a nonce that lives two minutes. There is nothing to brute
force: the pairing code is 128 bits and a session needs an enrolled key's signature.

## Decision

A token bucket (`src/server/ratelimit.ts`) on the open routes only, checked before the
handler: 3/s with a burst of 30 per source address, and 12/s with a burst of 120 globally.
Excess requests get 429 with `retry-after`. The source is the socket's remote address. The
table of sources is capped (1024) and evicts the fullest buckets first. Refusals are logged
at most once every 5 seconds with a count.

## Alternatives considered

- **Limit every route.** An authenticated client is meant to be chatty: every swipe is a
  POST, the tile pump fetches continuously and the menu polls. Throttling it would cause the
  outage the limiter exists to prevent.
- **Per-source bucket only.** Behind a proxy every request arrives from 127.0.0.1, so the
  per-source bucket degenerates to one. The global bucket covers that topology.
- **Key on `X-Forwarded-For`.** It is a header, so any caller can mint a fresh bucket per
  request.
- **Evict by insertion order.** A flood rotating through fresh sources evicts its own record
  and starts full again. The source being refused has the fewest tokens, so fullest-first
  keeps it longest.
- **An unbounded table.** That is itself a memory denial of service.

## Consequences

- The limit protects availability only and is not an authorisation control.
- The defaults are about ten times a real client's open-route traffic (one challenge and one
  session per hour, plus one status poll every two seconds while pairing).
- Behind a proxy, one abusive caller can consume the shared global budget for pairing and
  session establishment; established sessions are unaffected.
