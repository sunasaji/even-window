# Harness runs: auth off in `sim.sh`, own registry, no operator config

## Context

The server enforces authentication by default, and pairing deliberately needs a human to
compare a randomart out of band. `scripts/sim.sh` starts a fresh WebView on every run, often
unattended; `scripts/dev.sh` is an interactive loop with a browser profile that persists.
Both run on machines that may also host the real, paired instance in `~/.even-window`.

## Decision

- `sim.sh` runs the server with `EW_AUTH=0` by default and prints a boxed notice every time;
  the server prints its own warning as well. `--auth` runs the real gate.
- `dev.sh` keeps auth on by default (one pairing per browser profile); `--no-auth` turns it
  off with the same notice.
- Both use their own auth registry (`EW_STATE_DIR=<runtime>/state`), bind loopback only, and
  do not read `~/.even-window/env`. A git-ignored `dev.env` in the repo is read if present;
  an explicit `EW_ENV_FILE` or `EW_STATE_DIR` from the caller wins.
- Both refuse to start on a busy server or Vite port.

## Alternatives considered

- Auth on in `sim.sh`: puts a pairing click at fixed coordinates on the critical path of
  every screenshot check.
- Auth off silently: this is how an insecure default ships unnoticed.
- Sharing `~/.even-window`: a harness pairing would be refused by `EW_MAX_CLIENTS=1` (the
  phone holds the slot), or would add keys to the registry that matters; an `EW_AUTH=0` run
  would sit next to real keys.
- Reading the operator's env file: an inherited `EW_ORIGIN` makes every signature from
  `127.0.0.1` fail with an undifferentiated 401.

## Consequences

- An unauthenticated run is confined to a throwaway registry on loopback.
- `ew-auth.mjs` must be pointed at the harness registry; the scripts print the command.
- Readiness probes accept `401` as "up", because `/api/health` is gated when auth is on.
- Starting a long-lived server with `dev.sh` by mistake shows up as
  `NO CLIENT KEYS ENROLLED in …` in the banner.
