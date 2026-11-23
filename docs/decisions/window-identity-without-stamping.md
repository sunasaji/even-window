# Window identity is derived, never stamped on the window

## Context

Per-app bindings and the launcher need to know which program a window belongs to, and which
launcher entry started it. Two entries can run the same binary with different arguments, so
the executable alone does not separate them. A window carries no trace of what launched it. The
project this code descends from wrote a property onto every window and read it back from every
window on every poll.

## Decision

Nothing is written onto windows, and nothing is read back per poll.

- **Identity** (`pid`, executable name, executable path) is resolved once, the first time a
  window is seen, and cached until the window disappears. Empty answers are cached too. The
  backend supplies the lookup (`WindowControl.identify`); the cache is OS-neutral
  (`src/server/windows.ts`).
- **Launch attribution** (`src/server/launches.ts`) relies on the server being the process that
  launched the program. The spawn route records the launcher entry and the child pid. A window
  seen for the first time is matched to a pending launch by pid ancestry: the window's pid, or
  one of its ancestors, is a pid the server spawned. A window that exposes no pid is matched by
  timing instead: the most recent unclaimed launch within 15 seconds (`CLAIM_MS`) takes it.
- Only a window the server has never seen can be claimed, and one launch claims one window.

## Alternatives considered

- **Stamp a property on each window.** Costs a read per window per poll, forever.
- **Ask the X server for the client's pid** (X-Resource extension). Answers only for clients
  connected over a local socket, and the children here may connect over TCP.
- **Persist attributions across restarts.** Window ids are reused, so a persisted claim could
  attach to an unrelated window.

## Consequences

- An idle desktop costs one window enumeration per second and nothing else; a new window costs
  up to two lookups once.
- Attribution is lost on a server restart, and windows the server did not launch never have
  it. Bindings then fall back to the executable path, the name or the window class.
- A window that sets its identifying properties late keeps an empty identity until it closes.
- The timing match is a heuristic and can mislabel a pid-less window.
