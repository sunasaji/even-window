# Revocation is immediate: the registry is cached behind a stat

## Context

Session tokens are stateless, so on their own they stay valid for their full hour after the
key behind them is revoked. Revocation and rotation happen in another process:
`scripts/ew-auth.mjs` edits `clients.json` and `server-secret` directly. The gate runs on
every request, so reading and parsing a file each time is wasteful.

## Decision

The gate checks registry membership on every request, not only when a session is
established. The registry and the token-signing secret are cached in memory, keyed by the
resolved path and a stamp of `ino`, `mtimeNs` and `size` taken with one `statSync`. Any
difference in any field causes a re-read. The stat is taken before the read. A missing file
is cached as "no clients".

## Alternatives considered

- **A plain in-memory list.** The server would never learn of an external edit and would
  honour a revoked key until restart.
- **`fs.watch`.** It drops events on some platforms and watches an inode, which a
  rename-into-place replaces. A missed event means a revoked key keeps working. It would be
  acceptable only as an optimisation on top of the stat.
- **`mtimeMs` and size.** Millisecond resolution is the classic stale-cache trap; nanosecond
  mtime plus inode costs the same single call.
- **Read and parse on every request.** Correct but needless work on the hot path.

## Consequences

- `ew-auth revoke` and `ew-auth rotate` take effect on the next request with no restart,
  even when the server is stuck or refusing to start.
- The steady-state cost of the gate is one HMAC and two `stat` calls.
- Stat-before-read means a racing write causes a redundant re-read, never a stale answer.
- The remaining hole needs another process to swap in a key of identical byte length within
  one timestamp tick; revocation always shrinks the file.
- The state directory is resolved per call, so the cache key includes the path.

Background: [notes/2026-11-auth-verification.md](../notes/2026-11-auth-verification.md).
