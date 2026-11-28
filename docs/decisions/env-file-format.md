# The env file is a parsed subset of systemd's EnvironmentFile

## Context

Started from a shell, the server's settings are whatever that shell exported, so
whether a security control (`EW_AUTH`, `EW_ORIGIN`, `EW_MAX_CLIENTS`) is enforced
depends on which terminal launched it. A file in a known place removes that, and a
systemd unit needs the same file. Every authenticated route is already equivalent to
code execution, and the env file is the first thing the server reads.

## Decision

- `~/.pinhole-window/env` is read by a small parser (`src/server/envFile.ts`) whose
  format is a strict subset of systemd's `EnvironmentFile=`: `KEY=VALUE`, comments,
  one layer of quotes. No `export`, no expansion, no continuation lines, no spaces
  around `=`, `EW_*` keys only. Lines that break a rule are refused with a message.
- The environment wins; the file fills only unset variables and the banner names them.
- A file writable by group or others is ignored with a warning; start-up continues.
- The file is applied by `src/server/env.boot.ts`, the first import of `main.ts`,
  because several settings are read when modules load.
- `scripts/ew-auth.mjs` reads the same file, to share the state directory and limit.

## Alternatives considered

- Sourcing the file from a shell. A sourced file can run commands.
- A richer format (shell-style expansion, `export`). Anything accepted here but not
  by systemd would work in a manual start and silently not under the unit.
- Accepting any key. A file that can set `PATH` or `LD_PRELOAD` is an execution path
  for every child the server starts.
- Letting the file override the environment. A forgotten file would then override
  the command just typed, such as `EW_PORT=8788 node src/server/main.ts`.

## Consequences

- Values are literal, so `~` and `$HOME` are not expanded. `EW_SPAWN_CWD` expands a
  leading `~` itself; `EW_STATE_DIR` needs an absolute path.
- The parser is duplicated in `ew-auth.mjs`, which must stay dependency-free; the
  two must be kept in agreement.
- The development harness does not read the operator's file: an inherited
  `EW_ORIGIN` would make every signature from a loopback browser fail.
