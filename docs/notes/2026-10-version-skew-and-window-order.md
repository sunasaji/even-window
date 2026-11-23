# Version skew, window recency order and instance supersede

Snapshot — not maintained. Conditions: 2026-10-13 (recency order, skew) and 2026-10-20
(supersede, crash logs); simulator 0.9.5, isolated runs on separate ports and displays.

## Recency order in the window list (2026-10-13)

The server produces the order (`recent` in the `windows` event); the client only reorders
rows for display. `list` must stay in the window manager's own order, or the menu signature
changes on every focus change and each switch costs a page rebuild.

```bash
EW_X11_RUNTIME_DIR=/tmp/ew-mru-x11 EW_X11_DISPLAY=:171 EW_PORT=8799 \
VITE_PORT=5274 EW_AUTOMATION_PORT=9900 EW_SIM_DISPLAY=:181 scripts/sim.sh --headless --keep
```

After spawning `xclock` and `xlogo` and focusing xterm, then xclock:

| | Observed |
| --- | --- |
| `list` | `xterm(0)` → `xclock(1)` → `xlogo(2)`, unchanged by focus |
| `recent` | `['0x80000a','0x40000c','0xa00003']` = xclock → xterm → xlogo |
| Menu rows after a double tap | `> *xclock` / `xterm` / `xlogo` / `+ …` ×3 / `Menu...`, in `recent` order |
| Focus moved from outside while the menu is open | Row order unchanged; only `*` moves to xlogo; cursor stays |
| Closed and reopened | `> *xlogo` / `xclock` / `xterm` |
| Third row (`xterm`) chosen | Switched to xterm, which is first by item id; a mismatch between display and selection arrays would have picked another window |

## Version skew (2026-10-13)

Right after `recent` was added to the `windows` event, a new client against a server started
hours earlier stopped reacting to double taps only:

```
[ew] CLIENT … double — opening the overlay root list
                                       (no `overlay SHOW`; the log ends here)
```

Swipes still worked, so it looked like a gesture bug. The exception was visible only in the
WebView console: `/api/debug/log` forwards `log()` calls, and an uncaught exception is not
one. Two fixes followed: receivers tolerate missing new fields, and uncaught errors are
logged. The same failure now reads:

```
[ew] CLIENT … UNCAUGHT rejection: Spread syntax requires ...iterable not be null or undefined
```

A quieter form the same day: the list stayed in launch order because the ordering is made by
the (old) server and the client degraded as designed.

To reproduce skew deliberately, run an old server with a new client from a worktree:

```bash
git worktree add --detach /tmp/ew-old <old-commit>
ln -s "$PWD/node_modules" /tmp/ew-old/node_modules
# copy the current client and shared types over the old ones, then:
cd /tmp/ew-old && EW_X11_RUNTIME_DIR=/tmp/ew-old-x11 EW_X11_DISPLAY=:172 EW_PORT=8798 \
  VITE_PORT=5275 EW_AUTOMATION_PORT=9901 EW_SIM_DISPLAY=:182 \
  scripts/sim.sh --headless --keep --app-query "debug=1"
```

## Instance supersede (2026-10-20)

No second WebView is needed: subscribing to the stream with another `?inst=` id is a new
instance as far as the server is concerned.

| Action | Observed |
| --- | --- |
| Subscribe with another id | Server `stream inst=fake-tak TAKES OVER from ew-wl1rh`; client `SUPERSEDED by instance fake-takeover`; full-screen curtain ("another instance owns the glasses", both ids, "take over here") |
| Tap "take over here" | Reload, new id, `TAKES OVER`, tiles flow again |
| Subscribe again with a displaced id | `stream inst=fake2 is STALE (current=…) — told to stand down`; ownership never goes back, otherwise two pages would trade it forever |

That day the first attempt ran against a server started three days earlier: `?inst=` was
silently ignored and nothing was logged. Another false result came from copying an id off a
screenshot (the server prints eight characters), which created a different id that never
went stale.

On hardware, judge by the server log, since a crashed app shows no curtain:

```bash
grep -E 'TAKES OVER|is STALE|CLOSED after being told' .ew-x11/logs/dev-api.log | tail
grep 'CLIENT.*re-establish failed' .ew-x11/logs/dev-api.log | tail   # must stop after the new boot:
```

After replacing only the server, `reattached to Xephyr on :100 (xPid …)` in the banner means
the windows survived, and `session binding ENFORCED — EW_ORIGIN=…` that pairings did.

## The server log after a crash on hardware (2026-10-20)

When the whole WebView dies, the phone's log panel is gone. With `?debug=1` the lines are on
the server's stdout:

```bash
ss -ltnp | grep :8787            # server pid
ls -l /proc/<pid>/fd/1           # where its stdout goes
grep 'CLIENT' .ew-x11/logs/dev-api.log | tail -60
```

In that session the phone showed everything up to the disconnect; `create => 1`,
`rebuild => false`, push timeouts of 15–27 s and `UNCAUGHT rejection: rebuild timeout`
existed only on the server. Link transitions are flushed immediately; everything else goes
in 700 ms batches, so the last lines before a crash can be missing.
