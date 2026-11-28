# Link loss, establish and recovery on hardware

Snapshot — not maintained. Conditions: Even G2 with an iPhone, Even App developer mode, SDK 0.0.16; sessions of 2026-10-20 (plus one reproduction on 2026-11-23), logs via `?debug=1`.

Reference: [glasses.md](../glasses.md#establishing-the-page).

## Why a rebuild always follows create

`updateImageRawData` repaints only containers that a `rebuildPageContainer` has made live.
`createStartUpPageContainer` may be called once per glasses-UI lifetime (SDK: "cannot be called
again after first start-up; later updates must use rebuildPageContainer"). On a page reload the
host answers create with 0 but does not make the fresh containers the live page; every tile push
then returns success and paints nothing. The path "create => 1, then rebuild" only ever worked
because it always rebuilt. Hence: always rebuild once after create.

A second finding: `established` used to be set before create and never cleared, so a page that
failed to establish claimed to be established and could not draw until a manual reload. Observed
right after the glasses' battery died:

```
create => 1 (REFUSED …)      138 ms after config; rebuild false 1 ms later
establish => NOT established (streaming anyway)
```

Rebuilding a live page during streaming blacks out the right lens (observed earlier); this is
why the rebuild is restricted to pages that are not established.

## The push ladder against absent glasses

`pushImage` retries 4 times with an 8 s timeout and 500 ms gaps: up to about 34 s per tile, and
the pump pays a 41,472-pixel derive plus a PNG encode before each. With a dropped link this ran
at frame rate, invisibly, for as long as the app was open. A show transition blanking four tiles
would take about 136 s.

## Sessions

**A** (glasses taken off 20 s after start):

```
00:41:16.662  device: disconnected battery=40% wearing=true
00:41:16.664  glasses link DOWN — pump stands down and image pushes are refused
00:41:16.666  device status from sn=(none) — not the glasses (S211GABD070098), ignored from now on
```

**C** (taken off and put back on, `?debug=1`): not a single log line. The panel went dark and
came back by itself with its content intact.

**D** (Bluetooth switched off):

```
01:10:49.999  device: disconnected battery=36% wearing=true
01:10:50.002  glasses link DOWN — pump stands down and image pushes are refused
01:10:50.004  device: none battery=0% wearing=false
```

**E** (started with Bluetooth off; recovered only from the server-side log):

```
01:13:09.806  deviceInfo: none — the link state starts at "reachable"
01:13:09.857  create => 1 (REFUSED: invalid — …)
01:13:09.901  rebuild(establish) => false (REFUSED)
01:13:09.903  establish => NOT established (streaming anyway)
01:13:24.941  TL=err(tile0 timeout)/2667B/14841ms
01:13:43.730  TR=err(tile1 timeout)/2251B/18776ms
01:13:46.978  BL=sendFailed/2031B/3239ms
01:14:13.613  BR=err(tile3 timeout)/1611B/26631ms
01:14:34.233  UNCAUGHT rejection: rebuild timeout
```

**F** (after the fixes below; Bluetooth off at start, then on):

```
01:24:29.704  deviceInfo: no device — treating the link as DOWN (the establish retry can still find one)
01:24:29.705  glasses link DOWN — pump stands down and image pushes are refused
01:24:29.742  create => 1 (REFUSED)
01:24:42.958  re-establish failed: rebuild timeout
01:25:01.152  re-establish failed: rebuild timeout      (10 s)
01:25:29.252  re-establish failed: rebuild timeout      (20 s)
01:26:17.348  re-establish failed: rebuild timeout      (40 s)
01:27:25.453  re-establish failed: rebuild timeout      (60 s)
```

Zero tile pushes in those three minutes.

## Findings

1. Taking the glasses off is not a disconnect. Wear-driven blanking and recovery are firmware
   behaviour, invisible to the app; the page and its content survive. A link drop can follow
   removal (A); the trigger is unknown. Waste while unworn cannot be closed on this path; the
   user's lever is the `lens` latch.
2. A status record without a serial follows a disconnect by about 5 ms: it is a `connectType:
   none` reset record (battery 0, wearing false). The first serial filter classified it as
   another device and ignored the glasses permanently, so link recovery was never heard. An
   empty serial means "did not say", not "another device".
3. Treating `none` as "no opinion" is what makes this work: read as connected, the client would
   push again 5 ms after the drop; read as disconnected, an uninitialised `none` at start-up
   would stop the pump.
4. `isWearing` is unusable: `false` at start-up while being worn (session B; the lens showed
   `mirror paused (not being worn)` and the user read it through the lens), `true` in session C,
   and a stale `true` in the disconnect record (A). The wearing-based pause was removed after one
   day; a user who has just put the glasses on has no reason to read a dark lens as a deliberate
   pause, and it took two presses of an unexplained control to recover.
5. `?debug=1` logs a status event even when unchanged, so that silence can be read as "the host
   sent nothing".
6. Pushing without a page (E) reintroduced the ladder through another door. The pump and
   `pushImage` are gated on `established`.
7. `getDeviceInfo()` returning null is evidence ("the host says there is no device"), not absence
   of evidence; the link starts down in that case. A successful establish marks it up again, which
   is why the establish retry is not gated on the link.
8. `void promise` does not stop a rejection. `rebuildPage` throws on its 8 s timeout; uncaught,
   that also ended the retry ladder for the session. It is caught and re-armed (F shows
   5 -> 10 -> 20 -> 40 -> 60 s continuing).
9. The two link-transition log lines are flushed immediately; the 700 ms log batch dies with the
   host.
10. A burst of `UNCAUGHT rejection: The object does not support the operation or argument.` (20
    lines in 10 ms, the log cap) preceded one crash. The flood was a client bug: the stream's
    tile branch called `processTile` as a floating promise, one unhandled rejection per tile. It
    is caught and reported once per distinct message. The underlying WebKit `NotSupportedError`
    was not identified.

## `isInCase` agrees with physics (2026-10-20, 20:04-20:11)

```
20:04:43.972  device: connected battery=96% wearing=false in-case            put in
20:04:46.881  device: connected battery=96% charging wearing=false in-case   charging starts
20:04:54.680  device: connected battery=97% wearing=false in-case            charging flag drops
20:04:55.667  device: connected battery=97% charging wearing=false in-case   and returns
20:10:39.105  device: connected battery=100% charging wearing=false in-case  start-up, in the case
20:11:03.459  device: connected battery=100% wearing=false                   taken out
20:11:04.028  device: connected battery=100% wearing=true                    put on
```

The link stays `connected` in the case, so the link gate does not stop the pump there. `isInCase`
was correct in both directions and corroborated by charging, which was the bar set for wiring a
sensor.

| Signal | Trustworthy |
| --- | --- |
| `isWearing` snapshot at start-up | No |
| Fields inside a `disconnected` record | No (stale) |
| `wearing` false -> true transition when put on | Yes |
| `in-case` transitions | Yes, both directions |
| `isCharging` alone | No (flaps within seconds) |

## `create => 1` means the glasses are not connected

| `connectType` at start | `create` | Result |
| --- | --- | --- |
| `connected` (16:47) | 0 | `rebuild => true`, the lens showed content |
| `disconnected` (17:05) | 1 | `rebuild => false`, nothing on the lens |

Same phone, glasses and build; only the link differed. `device info: model=g2 sn=…` only proves
a device record exists. An earlier explanation ("a zombie page holds the once-per-lifetime
create") was withdrawn: both earlier `create => 1` observations were Bluetooth-off sessions, and
after a crash plus BLE reconnect a restart gave `create => 0` on a server without any
arbitration code. "A glasses reboot is required" was withdrawn with it.

### The status stream is unreliable during an outage (17:38)

```
17:38:09.885  device: disconnected -> glasses link DOWN
17:38:09.891  create => 1 / rebuild => false -> retry ladder
17:38:17.605  device: connecting            Bluetooth switched on
17:38:17.607  device: none                  reset record 2 ms later
(no status event for the next 25 s; `connected` never arrived)
```

`getDeviceInfo()` was correct at every start (host IPC, about 5 ms, no BLE round trip). So each
retry re-reads it, the backoff ceiling is 15 s while the link is down, `connecting` only pulls
the next retry forward, and a re-entrancy guard covers the path from the refresh back into the
retry.

### The Even App can lose the device record (17:51-17:55)

```
17:51:07.497  device: connecting
17:51:07.499  device: none
17:51:11.553  deviceInfo (retry): still no device
17:51:11.560  rebuild(re-establish) => false
```

After Bluetooth came back the glasses' own home screen showed "connected", `getDeviceInfo()`
still returned null three times, reloading the page did not help, and the Even App's connection
screen cannot be opened while this app is in front. The dead record is in the host, not the
page. The working recipe, which the phone warning bar states: quit the app from the phone,
reconnect the glasses in the Even App (a glasses reboot is sometimes needed), start again.

### An in-app exit button does not work

```
18:08:47  exit (shutDownPageContainer(1)) => false   no page to show the confirmation layer on
18:13:49  exit (shutDownPageContainer(0)) => true    accepted; the app did not close
```

Both phone-side buttons (`exit app`, armed with two taps, and `reload`) were removed. A control
that does nothing is worse than none when the operator's attention is at its thinnest.
`shutDownPageContainer` is back to one caller, the menu's `Exit` row.

Still unverified: whether a page whose create failed can come up by rebuild alone once the link
returns. In three attempts the link never came back. To verify: confirm "connected" in the Even
App, do not touch the app, and look for `glasses link UP … (page=no)` followed by
`rebuild(re-establish) => true`. Also unverified: whether the start-up page survives a real
reconnect (`glasses link UP … (page=established)` followed by tiles that return success and
actually appear).

## Host crash on BLE disconnect

The Even App (developer mode) crashed shortly after a disconnect in sessions A and D, and three
more times on 2026-10-20 (17:04:38, 17:27:33, 17:33:23). A wear cycle without a disconnect (C)
did not crash it. In D no push was in flight (last push 01:10:07, disconnect 01:10:50), and in
the later three there was no `UNCAUGHT` line: the client's last line is `device: none`, then the
host disappears. Abandoning the push ladder mid-way was added after A as a mitigation, but it
does not explain the symptom. Most plausible reading: the host crashes on a BLE disconnect while
an app is running, independently of this client. Reproduced on 2026-11-23 (Bluetooth switched off
while running; the app screen went down right after `glasses link DOWN`).

## Pages that outlive a crash, and supersede

After F, a new `boot:` at 01:28:11 connected and established, yet `re-establish failed` lines
from F's ladder continued at 01:28:35 and 01:29:45, on its own 70 s cadence: the old WebView was
still running, holding its stream and calling rebuild every minute. Another instance did so for
12 minutes (08:48 to 09:00).

A page cannot see another page, but both talk to the server, so the server arbitrates and tells
the loser. "Last connection wins" alone is a trap: the stood-down page's `EventSource`
reconnects, becomes the newest and takes the glasses back; the server therefore remembers
deposed instance ids and tells them again.

First firings (17:05, 17:34):

```
[pw] stream inst=pw-fp0lf TAKES OVER from pw-fqlay — 0 live stream(s) told to stand down (the old page was already gone)
```

- Zero told is a good outcome: the crash took the page with it. That was the case for all three
  crashes that day; the two morning cases (01:28, 08:48) survived. Correlation only: the
  survivors were pages still in the establish retry ladder; the ones that died had established.
- Silence proves nothing: an established page that lost its link stays quiet even if alive.
  Hence the count of streams told.
- In a crash nobody sees the old page's curtain. Verify in the server log:

```
[pw] stream inst=<new> TAKES OVER from <old>
[pw] CLIENT … SUPERSEDED by instance <new>                       (only with ?debug=1)
[pw] stream inst=<old> CLOSED after being told to stand down
```

  The third line is the proof that the old page heard and let go.

Supersede stops two pages fighting over the bridge. It does not transfer the display: only the
page that owns live containers can draw, and no API moves them.
