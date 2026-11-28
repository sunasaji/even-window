# Configuration

English | [日本語](configuration.ja.md)

pinhole-window is configured with `EW_*` environment variables, optionally kept in an
env file, and with three files in its state directory.

## Precedence

Environment variable, then the env file, then the built-in default. The env file
only fills in variables that are not already set, and the start-up banner names
every setting it took from the file. Changes take effect when the server restarts.

## Environment variables

### Network and authentication

| Variable | Default | Meaning |
| --- | --- | --- |
| `EW_HOST` | `127.0.0.1` | Bind address. The server terminates no TLS, so leave it on loopback and put a TLS proxy in front; it warns on every start when bound elsewhere. |
| `EW_PORT` | `8787` | HTTP port. |
| `EW_AUTH` | enforced | Authentication is disabled only by `0`, `off`, `false` or `no`. Any other value, including a typo, keeps it enforced. |
| `EW_ORIGIN` | unset | The URL the device dials, for example `https://host.ts.net:8443`. When set, the server refuses session signatures made out to any other origin. Unset means signatures are verified but the origin is not compared. A value that is not an absolute URL, such as `*` or a bare host name, is unusable and leaves the comparison off. The banner states which case applies. |
| `EW_MAX_CLIENTS` | `1` | Maximum number of enrolled device keys. `0`, `unlimited`, `off` or `none` removes the limit. Any value that is not a plain decimal number counts as `1`. If more keys are enrolled than the limit allows, the server refuses to start. |
| `EW_ORIGINS` | unset | Origins allowed by CORS, comma-separated; `*` allows any. Unset allows any origin while authentication is enforced, and only loopback origins and the server's own host with `EW_AUTH=0`. A list narrows CORS to those two plus the listed origins. Unrelated to `EW_ORIGIN`. See [security.md](security.md#cors). |

### Mirrored desktop (X11 backend)

| Variable | Default | Meaning |
| --- | --- | --- |
| `EW_X11_DISPLAY` | `:100` | Display number of the nested X server. |
| `EW_X11_RUNTIME_DIR` | `<checkout>/.ew-x11` | Runtime files of the nested X session. |
| `EW_BACKEND` | `auto` | `auto`, `xephyr` or `xvfb`. `auto` tries Xephyr first when a host display exists and Xvfb first otherwise, and falls back to the other. A pinned backend does not fall back. |
| `EW_HOST_DISPLAY` | detected | The host display Xephyr opens its window on. Detected from `DISPLAY`, then from the lowest socket in `/tmp/.X11-unix`. Set it to empty to declare that there is no host desktop and prefer Xvfb. |
| `EW_SPAWN` | a dark xterm | The program started in an empty mirrored desktop. Empty starts nothing. The default is `xterm` with a black background, white text, a 9×18 bold bitmap font, no border and no scrollbar. |
| `EW_SPAWN_CWD` | `$HOME` | Working directory of launched programs. A leading `~` is expanded, a relative path is taken from `$HOME`, and a path that is not a directory falls back to `$HOME` with a warning. |
| `EW_FPS` | `10` | Capture rate, 1 to 30. |
| `EW_AA` | `0` | `1` allows font antialiasing in the mirrored desktop. Off by default because grey fringes quantise badly to 16 levels. |

Keep the default client dark: the glasses are optical see-through, so black is
transparent and a light background lights the whole lens.

### State and diagnostics

| Variable | Default | Meaning |
| --- | --- | --- |
| `EW_STATE_DIR` | `~/.even-window` | The state directory. Use an absolute path. The default keeps the project's former name ([why](decisions/rename-to-pinhole-window.md)). |
| `EW_ENV_FILE` | unset | An explicit env file. Empty means "read no file". |
| `EW_QUIET` | unset | `1` silences the per-request access log. |

### Voice input

| Variable | Default | Meaning |
| --- | --- | --- |
| `EW_STT_URL` | unset | URL of an OpenAI-compatible `POST /v1/audio/transcriptions` endpoint. Unset disables voice input. |
| `EW_STT_MODEL` | `Qwen3-ASR-0.6B` | Model id sent to the recogniser. It must be the id the recogniser's `/v1/models` reports. |
| `EW_STT_LANG` | unset | Language hint, for example `en`. Not sent when unset. |
| `EW_STT_PROMPT` | unset | Vocabulary hint passed as `prompt`. It also makes the recogniser likelier to hear these words when they were not said. |
| `EW_STT_OPTIONS` | unset | Extra form fields for the recogniser, as `name=value` pairs joined by `&` (URL query syntax) (`name=value&other=value`). Nothing extra is sent by default. Which fields exist depends on the recogniser: see [voice.md](voice.md#recogniser-options). A recogniser that answers 400 is asked again without them. |
| `EW_STT_API_KEY` | unset | API key for a hosted recogniser such as OpenAI's, sent as `Authorization: Bearer`. A local recogniser needs none. It is a secret: keep it in the env file (mode 600). With it set, `EW_STT_URL` must be `https` unless it is this machine. See [voice.md](voice.md#a-hosted-recogniser). |
| `EW_STT_DUMP_DIR` | unset | For diagnosis. A directory that receives a copy of each utterance: the WAV sent to the recogniser and a `.txt` with what it answered. The newest 20 are kept. These are recordings of your voice; leave it unset in normal use. See [voice.md](voice.md#keeping-the-audio-for-diagnosis). |

### Client dev server (Vite)

Read by `vite.config.ts`, not by the server, and not from the env file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EW_ALLOWED_HOSTS` | unset | Extra `Host` names Vite accepts, comma-separated. `.ts.net` is always accepted. |
| `EW_HMR_HOST` | unset | Host the hot-reload client dials back to when the page is served through a TLS proxy. |
| `EW_HMR_PORT` | `443` | Port for the same; used only when `EW_HMR_HOST` is set. |

### Scripts

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `EW_APP_URL` | `ew-auth.mjs` | unset | App URL used by `pair` and `open` when none is given as an argument. |
| `EW_PAIR_TTL_MS` | `ew-auth.mjs open` | `300000` | Lifetime of a pairing window opened with `open`. `pair` always uses two minutes. |
| `EW_FIREFOX_PROFILE` | `ew-firefox.sh` | `~/.local/share/even-window/firefox` | Runtime Firefox profile directory. |
| `EW_FIREFOX_URL` | `ew-firefox.sh` | unset | URL to open instead of the profile's home page. |
| `EW_FIREFOX_BIN` | `ew-firefox.sh` | `firefox` | Firefox binary. |
| `EW_SIM_DISPLAY`, `EW_SIM_SCREEN`, `EW_AUTOMATION_PORT`, `EW_SETTLE_MS`, `EW_APP_QUERY` | `sim.sh` | `:180`, `608x1150`, `9899`, `6000`, unset | Simulator harness settings; see [development.md](development.md). |

`ew-auth.mjs` also honours `EW_STATE_DIR`, `EW_MAX_CLIENTS` and `EW_ENV_FILE`, so that
it edits the same registry under the same limit as the server. `EW_X11_DISPLAY_ENV`
is set by the server for its child processes; do not set it.

## The env file

With `EW_ENV_FILE` set, the server reads exactly that file. Otherwise it reads both of these,
and a key set in both takes the value from the first:

1. `~/.even-window/env`;
2. `$XDG_CONFIG_HOME/even-window/env` (by default `~/.config/even-window/env`).

The systemd unit lists the same two files and produces the same result, so the settings do
not depend on how the server was started.

The location does not follow `EW_STATE_DIR`. Start from `systemd/env.example`:

```bash
install -m 600 systemd/env.example ~/.even-window/env
```

The format is a strict subset of systemd's `EnvironmentFile=`, so the same file works
for a manual start and for the systemd unit:

```
# comments start with # or ;
EW_ORIGIN=https://host.ts.net:8443
EW_MAX_CLIENTS=1
EW_SPAWN="xterm -bg black -fg white"
```

| Rule | Detail |
| --- | --- |
| `KEY=VALUE`, one per line | No spaces around `=`, no `export`, no line continuation. A line that breaks a rule is refused with a message naming it. |
| `EW_*` keys only | Any other key, such as `PATH`, is refused. |
| Values are literal | No `$VAR` expansion and no `~` expansion. One layer of matching quotes is removed. |
| Permissions | A file writable by group or others is ignored entirely, with a warning. Use mode `600`. |
| Never sourced | The file is parsed, not executed. Do not `source` it from a shell either. |

Background: [the env file format](decisions/env-file-format.md).

## The state directory

`~/.even-window`, or `EW_STATE_DIR`. It is created with mode `700`; the server warns
when an existing directory is readable by others, and does not change it for you.

| File | Written by | Contents |
| --- | --- | --- |
| `env` | you | Settings, as above |
| `clients.json` | `ew-auth.mjs`, server | Enrolled device keys |
| `server-secret` | server | Token-signing secret; `ew-auth.mjs rotate` replaces it |
| `pending.json`, `pairing.json` | server, `ew-auth.mjs` | Pairing in progress |
| `apps.conf` | you | Application list overrides |
| `apps-recent.json` | server | Recently launched applications |
| `bindings.json` | server | Per-application bindings |

Treat a copy of this directory as a credential: with `server-secret`, tokens can be
forged for any enrolled device. See [security.md](security.md).

The X11 backend keeps runtime files (`session.json`, the generated window manager
and font configuration) in `.ew-x11/` inside the checkout (`EW_X11_RUNTIME_DIR`).

## `apps.conf`

The launcher lists the applications the server finds on the machine. `apps.conf`
adjusts that list. It is hand-written, one directive per line; a line starting with
`#` is a comment. The server re-reads it when its modification time changes; no
restart is needed.

| Directive | Effect |
| --- | --- |
| `hide <id \| command \| name>` | Remove a scanned entry |
| `show <command>` | Bring back a command that the built-in deny-list removes |
| `app <name> = <command line>` | Add an entry |
| `term <name> = <command line>` | Add an entry that runs inside a terminal |

```
# pinhole-window application overrides
hide xeyes
show xdpyinfo
app Clock = xclock -digital
term Top = top
app Firefox (G2) = /home/you/src/pinhole-window/scripts/ew-firefox.sh
```

Command lines are split into arguments and executed directly, without a shell.
Syntax errors are reported in the start-up banner and in the `errors` field of
`GET /api/apps`. The **rescan** button in the phone's **apps** palette also repeats
the package scan. How the list is built: [platform.md](platform.md).

## `bindings.json`

Per-application bindings: what a swipe sends, what **Submit** presses after the text,
what a line break becomes, and what **font −/+** press. The phone's **app** panel
writes this file ([usage.md](usage.md#per-application-bindings)); you can also edit
it by hand and restart the server.

```json
{
  "bindings": {
    "comm:less": {
      "up": { "mods": [], "key": "Page_Up" },
      "down": { "mods": [], "key": "Page_Down" }
    },
    "comm:firefox": {
      "up": { "mods": [], "key": "WheelUp" },
      "down": { "mods": [], "key": "WheelDown" },
      "submit": "ctrl+Return",
      "newline": "shift+Return",
      "fontsize": "ctrl+equal"
    }
  }
}
```

| Field | Values |
| --- | --- |
| `up`, `down` (required) | `{ "mods": [...], "key": ... }`. `mods` is any of `ctrl`, `alt`, `shift`; `key` is a name from the catalogue in `src/shared/keys.ts`, including `WheelUp` and `WheelDown`. |
| `submit` | `off`, `Return`, `ctrl+Return`, `shift+Return`, `alt+Return`, `Tab`, `ctrl+s`, `ctrl+d` |
| `newline` | `Return`, `ctrl+Return`, `shift+Return`, `alt+Return` |
| `fontsize` | `shift+KP`, `ctrl+equal`, `ctrl+plus`, `ctrl+shift+equal`, `ctrl+shift+Page`, `emacs`, `ctrl+wheel` |

An omitted optional field means "no opinion", and the value is inherited from a less
specific entry. An invalid entry is dropped and reported at start-up and in
`GET /api/bindings`; the rest of the file still loads.

### Binding keys

| Key form | Matches |
| --- | --- |
| `app:<launcher id>` | A window launched from pinhole-window's launcher entry with that id, for example `app:desktop:xmountains`. The server remembers launches in memory, so the match is lost when it restarts. |
| `exe:<absolute path>` | The executable of the window's process, for example `exe:/usr/bin/xterm` |
| `comm:<name>` | The process name, for example `comm:vim` |
| `cls:<class>` | The window class, in lower case, for example `cls:firefox` |
| `title:<title>` | The window title. Offered only for windows that have no other identity. |
| `*` | Every application |

Each field is resolved separately, in the order `app:`, `exe:`, `comm:`, `cls:`,
`title:`, `*`, then the built-in default (swipes send `Up` and `Down`, `submit` is
`off`, `newline` is `Return`, `fontsize` is `shift+KP`). Avoid `comm:` and `exe:` for
wrapper runtimes such as `electron`, `java` or `python3`; they match every program
that runs on the same runtime, so use `cls:` there.
