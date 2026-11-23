# Authentication gate: measured behaviour

Snapshot — not maintained. Conditions: 2026-11, server on loopback under WSL2 (ext4), driven
with `curl` and `scripts/ew-auth.mjs`.

Token-kind, origin-binding and rate-limit request tables are in
[2026-11-authenticated-curl-checks.md](2026-11-authenticated-curl-checks.md).

## Rate limiter faults found by tests

An eviction test caught a real fault: evicting sources by insertion order let a flood
rotating through fresh addresses evict its own record. A second fault was found by using an
injected clock starting at 0: a bucket whose "never used" marker was timestamp 0 never
refilled.

## Rotation without a restart

Same server process throughout: `GET /api/health` → 200; `ew-auth rotate`; same token → 401;
re-established with the same key → 200.

## Enrolled-clients event

Stream held open with `curl` while another process ran `ew-auth`:

```
{"t":"clients","list":[],"enforced":true}                          primed on connect
{"t":"clients","list":[{"id":"a1b2…","name":"my-phone",…}],…}        after enrolling
{"t":"clients","list":[{…"my-phone"…},{…"intruder"…}],…}             within 1 s of a second key
{"t":"clients","list":[{…"my-phone"…}],…}                            after revoke
```

Four events for the priming and three changes; nothing is sent while the set is unchanged.
Reordering alone is not a change; a rename or a change of the enforcement flag is.

## Registry cache granularity

2000 back-to-back rewrites of one file produced 2000 distinct `mtimeNs` values, consecutive
writes 230–390 µs apart.

## Proxy

`tailscale serve` did not buffer server-sent events: events sent 700 ms apart arrived at the
same spacing as on a direct connection. Through the proxy, an unauthenticated
`GET /api/health` and `POST /api/spawn` answer 401 and `GET /api/auth/challenge` answers 200.

## Launch allow-set

On the development machine the scanned set held 45 commands, including `env` (from
`Exec=env TERM=xterm-256color byobu` in `byobu.desktop`), which can start any program. A
request such as `{"cmd":"xterm","args":["-e","sh","-c","…"]}` passes the check.
