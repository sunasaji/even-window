# Instrument flags are read from the URL only

## Context

Client options resolve `?param=` → `localStorage` → default, and the winner is stored. That
suits settings the WebView must keep across its frequent reboots. `stats` was once handled
the same way: a `?stats=1` typed long before kept re-running the link baseline, which paints
a bright test pattern on the glasses, on loads whose URL said nothing about it. It was
reported as a rendering fault.

## Decision

Two kinds of query parameter:

- Settings (`server`, `invert`, `mirror`, `scrollnat`) describe how this install runs. They
  persist, and the boot log names any value that came from storage (`sticky: …`).
- Instruments and run modes (`debug`, `stats`, `keyprobe`, `encworker`, `voicefeed`) belong to
  one capture. They are read from the current URL and stored nowhere.

## Alternatives considered

- Persisting instruments for convenience: a real capture needs `debug` and `stats` together
  and `debug` was never persistent, so the URL is typed anyway.
- Printing the raw query next to the resolved values and letting the reader compare: the one
  time it mattered, nobody did.

## Consequences

- Every measurement run carries its flags in the URL; `sim.sh --app-query` sets them for the
  simulator.
- A load without flags is never being measured.
- Verification runs still pin settings explicitly, since a stored setting can decide a run
  that passes none.
