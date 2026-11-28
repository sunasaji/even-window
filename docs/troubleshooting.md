# Troubleshooting

English | [日本語](troubleshooting.ja.md)

Start with the logs; most problems name themselves there.

## Where the logs are

| Source | Location |
| --- | --- |
| Server, started by hand | The terminal. Lines start with `[ew]`; the X11 backend uses `[x11]`. |
| Server, as a systemd unit | `journalctl --user -u 'pinhole-window@*' -f` |
| Server, under `scripts/dev.sh` | `.ew-x11/logs/dev-api.log` (and `dev-vite.log`) |
| Client | The **log** panel on the phone screen, with a **copy** button |
| Client, after the app crashed | Load the app with `?debug=1` beforehand. Client lines are then forwarded to the server log as `[ew] CLIENT …`. They are sent in batches, so the last lines before a crash can be missing. |
| Speech service | `journalctl --user -u speech-cpp -n 50` |

The server's start-up banner reports the authentication state, the number of
enrolled devices and their registry, the env file in use, and session binding.

## Connection and pairing

| Symptom | Cause | Fix |
| --- | --- | --- |
| A health check on `/api/health` gets `401` | Expected: the route requires authentication. `401` proves that the listener and the gate are up. | Treat both `200` and `401` as alive. |
| Every request gets `401` after pairing was approved | `EW_ORIGIN` does not match the URL the device dials. Signatures name their destination. | Set `EW_ORIGIN` to exactly the URL in the device's address bar (scheme, host, port) and restart. |
| Every request gets `401`; the banner says `NO CLIENT KEYS ENROLLED in …` | The server is using a different state directory than the one the device was enrolled in. `scripts/dev.sh` uses `.ew-x11/state`. | Start the server the same way you paired, or set `EW_STATE_DIR` consistently for the server and `ew-auth.mjs`. |
| `ew-auth pair` prints `NO FREE SLOT`, or `approve` prints `REFUSED` | The enrolment limit (`EW_MAX_CLIENTS`, default 1) is reached. Pairing again adds a key; it does not replace one. | `ew-auth.mjs list`, `revoke <id>` the key being replaced, then pair. A refused pending device stays pending and can be approved after the revoke. To keep several devices, raise `EW_MAX_CLIENTS` and restart. |
| The server exits with `REFUSING TO START` | More keys are enrolled than `EW_MAX_CLIENTS` allows. Lowering the limit revokes nothing. | Revoke the extra keys (no server needed), or set the limit to the number you use. |
| `No device paired within the window` | The pairing window (two minutes, one device) expired. | Run `pair` again. |
| The phone asks to confirm a different server | A `?server=` link points a paired device at another API base. | Confirm only if you changed the address yourself. |
| Vite answers `Blocked request. This host is not allowed.` | The host name is not in Vite's allow-list. | `EW_ALLOWED_HOSTS=<name> npm run dev`. `*.ts.net` is always allowed. |
| `/api/...` returns `404` through `tailscale serve` | The proxy target has no `/api` suffix, so the prefix is stripped. | Use `--set-path /api http://127.0.0.1:8787/api`. |
| Hot reload stopped working behind the proxy | The hot-reload client dials the dev port. | Set `EW_HMR_HOST` and `EW_HMR_PORT`. |
| After a server restart the phone stays disconnected | The Even App does not always reopen the stream. | Reopen the app. |
| A setting in the env file has no effect | The file was ignored (writable by others), the line was refused, or the environment already set the variable. | Read the `env file` lines in the banner; `chmod 600` the file; remove `export` and spaces around `=`. |

## Nothing on the glasses

Check the phone first: if the preview shows the desktop, the server side is fine.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Preview is live, lenses are dark, the button reads **lens:off** or **lens:case** | The mirror is paused by the latch or the case sensor. | Tap the **lens** button. |
| Preview is live, lenses are dark, the screen is mostly black | Black is transparent on the glasses. An empty desktop or a black window shows nothing. | Launch something, or check `EW_SPAWN` is not empty. |
| The phone shows `another instance owns the glasses` | A newer copy of the app took over. | Close the other copy, or reload this one to take the glasses back. |
| The log shows `glasses link DOWN` | The Bluetooth link to the glasses is lost; updates stop until it returns. | Reconnect the glasses in the Even App. If the mirror does not resume, reopen the app. |
| The preview is black or frozen too | The server has no session or no capture. | Look for `[x11]` lines in the server log; see the next section. |

## Gestures and input

| Symptom | Cause | Fix |
| --- | --- | --- |
| Double tap does nothing while swipes work, or a new feature seems missing | Version skew: the client is served fresh from the working tree while the server process is older. | Restart the server. Open windows survive the restart. Compare `ps -o lstart= -p <pid>` with the time of your last update. |
| A swipe sends the wrong key | A binding applies that you did not expect. | The server logs `input gesture=up … key=… via=…`; `via` names the binding that won. Edit it in the **app** panel. |
| **Submit** types the text but does not run it | The submit key is `off` by default. | Set **submit** for that application in the **app** panel. |
| Arrow keys from a Bluetooth keyboard do nothing | The iOS WebView does not deliver them. | Use the **keys** panel. |
| The Even App closes when Bluetooth is switched off | A known Even App failure after a link loss; see [status.md](status.md). | To use the app without glasses, start it with Bluetooth already off. |

## Voice input

| Symptom | Cause | Fix |
| --- | --- | --- |
| Long press does nothing and there is no **voice** button | No recogniser is configured; the client offers voice only when the server reports one. | Set `EW_STT_URL` and restart the server. |
| Transcription fails with `404` | The model id sent differs from the id the recogniser serves. | Compare `EW_STT_MODEL` with `curl -s http://127.0.0.1:8757/v1/models`. |
| The recogniser does not answer right after its first start | It is downloading a model. | Run `speech pull <model>` from a shell first. |
| `no audio` after a few seconds, using the phone microphone | The Even App has no microphone permission. | Grant it in the phone's settings. |

## The mirrored desktop (X11 backend)

| Symptom | Cause | Fix |
| --- | --- | --- |
| The log shows `127.0.0.1:100` instead of `:100` | `/tmp/.X11-unix` does not allow a new socket (on WSLg it is not a sticky, writable directory), so the nested X listens on TCP. | Normal. When running X tools by hand, use `DISPLAY=127.0.0.1:100`. |
| A nested X server started by hand exits with `failed to create listener for unix` | The same `/tmp/.X11-unix` restriction. | Start it with `-listen tcp` and connect to `127.0.0.1:<n>`. |
| An application started by hand appears on the Windows desktop | Under WSLg, GTK applications prefer Wayland when `WAYLAND_DISPLAY` is set. The server cleans this for what it launches; a shell does not. | `env -u WAYLAND_DISPLAY GDK_BACKEND=x11 DISPLAY=127.0.0.1:100 <command>` |
| No Xephyr window appears on the desktop, or one appears when you wanted headless | The backend follows the host display, and a live session is re-attached as it is. | Set `EW_HOST_DISPLAY` (empty for headless) or `EW_BACKEND`, kill the old X server by pid, delete `.ew-x11/session.json`, and restart. |
| No session starts with `EW_BACKEND=xephyr` | A pinned backend does not fall back, and Xephyr needs a host display. | Use `auto`, or provide a host display. |
| The log says `<backend> did not come up on :N` | The line names the cause. `exited with code …`: the X server could not start (not installed, display taken, no host display). `still running … but accepts no connection`: it started but neither its unix socket nor its TCP port answered within 5 s; `gave no answer at all` on the TCP port means loopback packets are being dropped. | Install the X server, free the display or provide a host display; for the second, check `/tmp/.X11-unix` permissions and any local firewall. |
| The server cannot listen because the port is in use | Another instance is running. | `ss -ltnp \| grep 8787`; stop it, or change `EW_PORT` (and `EW_X11_DISPLAY` to keep a separate desktop). |
| Launched programs start in the wrong directory | `EW_SPAWN_CWD` is not a directory; the server falls back to `$HOME` with a warning. | Fix the path. |

### Firefox is cut off at the right edge

Firefox's default minimum window width exceeds the screen. Launch it through
`scripts/ew-firefox.sh`; see [firefox.md](firefox.md).

### Firefox does not start on WSL2

The snap package of Firefox cannot open a TCP X connection, which is the only kind
available under WSLg (`cannot open display`). Install Firefox from a `.deb` package
or the official tarball and point `EW_FIREFOX_BIN` at it if it is not first on `PATH`.

## Still stuck

Collect the server log from start-up, the phone's **log** panel, and the output of
`node scripts/ew-auth.mjs list`, and check [status.md](status.md) for known
limitations before reporting an issue.
