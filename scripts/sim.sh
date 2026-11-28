#!/usr/bin/env bash
#
# sim.sh — end-to-end harness: API/capture server + Vite + the Even Hub simulator,
# pointed at each other.
#
#   node src/server/main.ts   :8787   owns nested X EW_X11_DISPLAY (:100) and the capture
#   vite                      :5273   serves the WebView app
#   evenhub-simulator                 renders the app and the glasses panel in its own
#                                     nested X (:180+); automation HTTP API on :9899
#
# The simulator opens http://127.0.0.1:<vite>/?server=http://127.0.0.1:<api>; the
# client resolves its API base from ?server=, then localStorage, then
# http://localhost:8787.
#
# Auth: the server enforces authentication by default. This script runs it with
# EW_AUTH=0 and prints a notice, because an unattended run has nobody to approve a
# pairing. --auth keeps the real gate; pair the WebView first:
#     node scripts/ew-auth.mjs open '<app-url>'    # prints CODE=/URL=
#     scripts/sim.sh --auth --app-query "pair=<CODE>"
#     node scripts/ew-auth.mjs pending && node scripts/ew-auth.mjs approve <id>
#
# Usage:
#   scripts/sim.sh                          # visible if a host X is available
#   scripts/sim.sh --headless --keep        # Xvfb, leave it running
#   scripts/sim.sh --screenshot /tmp/g.png  # one-shot capture, then exit
#
# The simulator is not the device: byte sizes, API responses and control flow are
# meaningful here, latency is not (there is no BLE). See docs/development.md.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VITE_PORT="${VITE_PORT:-5273}"
API_PORT="${EW_PORT:-8787}"
X_DISPLAY="${EW_X11_DISPLAY:-:100}"      # the server's nested X (capture source)
SIM_DISPLAY="${EW_SIM_DISPLAY:-:180}"    # the simulator's own nested X
AUTOMATION_PORT="${EW_AUTOMATION_PORT:-9899}"
HOST_DISPLAY="${EW_HOST_DISPLAY:-${DISPLAY:-}}"
SIM_SCREEN="${EW_SIM_SCREEN:-608x1150}"  # portrait: browser panel + glasses below
READY_TIMEOUT="${READY_TIMEOUT:-60}"
SETTLE_MS="${EW_SETTLE_MS:-6000}"        # let the app establish its page containers
# Extra query parameters appended to the app URL. The client resolves its settings
# `?param=` → localStorage → default, so this is how a verification run pins one
# (e.g. EW_APP_QUERY='invert=1' / --app-query invert=1) without touching stored state.
APP_QUERY="${EW_APP_QUERY:-}"

HEADLESS=0
KEEP=0
SHOT=""
# The server enforces auth by default; the harness opts out by default and says so.
# --auth keeps the real gate on.
AUTH=0

usage() {
  cat <<'EOF'
usage: scripts/sim.sh [options]

  Brings up API server + Vite + Even Hub simulator, wired together.

  --screenshot <path>  after everything settles, GET the glasses framebuffer
                       (576x288 PNG) from the sim's automation API and write it
                       to <path>. Exits NON-ZERO if the capture failed or the
                       bytes are not a real PNG. Implies a clean shutdown
                       afterwards unless --keep is also given.
  --headless           use Xvfb instead of Xephyr for the simulator's nested X,
                       so no host display is needed. The simulator itself has no
                       headless mode (`--help` lists none); this works because it
                       is an ordinary X client and Xvfb is an ordinary X server.
                       Screenshots still come from the automation API, not the
                       screen, so they are unaffected.
  --keep               leave everything running for manual poking (Ctrl-C stops).
  --auth               run the server with its REAL auth gate (EW_AUTH enforced).
                       Default is EW_AUTH=0 with a visible notice, because an
                       unattended run has nobody to approve a pairing. With
                       --auth, pair the WebView first: see docs/development.md.
  --port <N>           Vite port                        (default 5273)
  --api-port <N>       API server port / EW_PORT        (default 8787)
  --display <:N>       the SERVER's nested X display    (default :100)
  --sim-display <:N>   the SIMULATOR's nested X display (default :180)
  --automation-port <N>  sim automation HTTP port       (default 9899)
  --app-query <qs>     extra query parameters for the app URL, e.g. `invert=1`
                       (also settable as EW_APP_QUERY). The client reads its
                       settings `?param=` -> localStorage -> default.
  -h, --help           this help

  Sim-only displays start at :180 deliberately, clear of the server's own :100.
  See docs/development.md.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --screenshot)      SHOT="$2"; shift 2;;
    --headless)        HEADLESS=1; shift;;
    --keep)            KEEP=1; shift;;
    --auth)            AUTH=1; shift;;
    --port)            VITE_PORT="$2"; shift 2;;
    --api-port)        API_PORT="$2"; shift 2;;
    --display)         X_DISPLAY="$2"; shift 2;;
    --sim-display)     SIM_DISPLAY="$2"; shift 2;;
    --automation-port) AUTOMATION_PORT="$2"; shift 2;;
    --app-query)       APP_QUERY="$2"; shift 2;;
    -h|--help)         usage; exit 0;;
    *) echo "sim.sh: unknown argument: $1" >&2; usage >&2; exit 2;;
  esac
done

RUNTIME_DIR="${EW_X11_RUNTIME_DIR:-${REPO_ROOT}/.ew-x11}"
LOG_DIR="${RUNTIME_DIR}/logs"
# This run's own auth registry, as in scripts/dev.sh: a harness run must not pair into
# (or be refused by) the registry that serves the real phone.
STATE_DIR="${EW_STATE_DIR:-${RUNTIME_DIR}/state}"
# The untracked dev.env in the checkout is read when it exists; the operator's
# ~/.even-window/env is not. An explicit EW_ENV_FILE wins, and an empty one means
# "no file".
HARNESS_ENV="${REPO_ROOT}/dev.env"
if [ "${EW_ENV_FILE+set}" = set ]; then ENV_FILE="${EW_ENV_FILE}"
elif [ -f "${HARNESS_ENV}" ];      then ENV_FILE="${HARNESS_ENV}"
else                                    ENV_FILE=""
fi

mkdir -p "${LOG_DIR}"
API_LOG="${LOG_DIR}/sim-api.log"
VITE_LOG="${LOG_DIR}/sim-vite.log"
SIM_LOG="${LOG_DIR}/sim-sim.log"
X_LOG="${LOG_DIR}/sim-x.log"

die() { echo "sim.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── child bookkeeping (kill by recorded pid, never by pattern) ───────────────
# `pkill -f sim-linux-x64` also matches this script's own command line. Every child is
# tracked by pid and started under setsid, so one `kill -- -PID` reaps grandchildren.
PIDS=()
PNAMES=()
track() { PIDS+=("$1"); PNAMES+=("$2"); }

kill_pid() {
  local pid="$1" sig="$2"
  kill "-${sig}" -- "-${pid}" 2>/dev/null || kill "-${sig}" "${pid}" 2>/dev/null || true
}

reap_log_pumps() {
  # The `>(prefix ...)` log pumps are direct children that are not in PIDS, and they
  # never see EOF: the server's nested X stack is detached so that it outlives node
  # (docs/platform.md), and it inherits the pump's pipe. Kill the remaining direct
  # children by pid.
  local kid
  for kid in $(ps -o pid= --ppid $$ 2>/dev/null); do
    kill "${kid}" 2>/dev/null || true
  done
  return 0
}

CLEANED=0
cleanup() {
  [ "${CLEANED}" = 1 ] && return 0
  CLEANED=1
  local n i j alive
  n=${#PIDS[@]}
  [ "${n}" -eq 0 ] && return 0
  echo "sim.sh: shutting down..." >&2
  for (( i = n - 1; i >= 0; i-- )); do
    kill -0 "${PIDS[i]}" 2>/dev/null || continue
    echo "sim.sh:   TERM ${PNAMES[i]} (pid ${PIDS[i]})" >&2
    kill_pid "${PIDS[i]}" TERM
  done
  for (( i = 0; i < 25; i++ )); do
    alive=0
    for (( j = 0; j < n; j++ )); do
      kill -0 "${PIDS[j]}" 2>/dev/null && alive=1
    done
    [ "${alive}" = 0 ] && break
    sleep 0.2
  done
  for (( i = n - 1; i >= 0; i-- )); do
    if kill -0 "${PIDS[i]}" 2>/dev/null; then
      echo "sim.sh:   KILL ${PNAMES[i]} (pid ${PIDS[i]})" >&2
      kill_pid "${PIDS[i]}" KILL
    fi
  done
  reap_log_pumps
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

prefix() {
  local tag="$1" file="$2" line
  while IFS= read -r line; do
    printf '%s %s\n' "${tag}" "${line}"
    printf '%s\n' "${line}" >>"${file}"
  done
}

wait_http() { # url seconds pid
  # Readiness, not authorization: with --auth, /api/health answers 401, which still
  # shows that the listener is up. Accept 2xx or 401.
  local url="$1" secs="$2" pid="$3" i code
  for (( i = 0; i < secs * 5; i++ )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${url}" || true)"
    case "${code}" in 2??|401) return 0;; esac
    kill -0 "${pid}" 2>/dev/null || return 2
    sleep 0.2
  done
  return 1
}

disp_in_use() { # :N — true if something already owns that display
  local n="${1#:}"
  [ -e "/tmp/.X11-unix/X${n}" ] && return 0
  DISPLAY=":${n}" xdpyinfo >/dev/null 2>&1 && return 0
  # A server started with -nolisten unix (the headless mode) leaves no socket in
  # /tmp/.X11-unix, so probe the TCP transport too.
  DISPLAY="127.0.0.1:${n}" xdpyinfo >/dev/null 2>&1
}

pick_display() { # start_at — first free display at or after it
  local base="${1#:}" n
  for n in $(seq "${base}" "$((base + 20))"); do
    disp_in_use ":${n}" || { echo ":${n}"; return 0; }
  done
  echo ":${base}"
}

# ── environment hygiene ──────────────────────────────────────────────────────
# On WSL2 with WSLg, a GTK/GDK child that sees $WAYLAND_DISPLAY renders on the host
# desktop instead of the nested X. The simulator is a GTK3 + WebKit2GTK (Tauri) app.
unset WAYLAND_DISPLAY TMUX TMUX_PANE
export GDK_BACKEND=x11
export MOZ_ENABLE_WAYLAND=0
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-${UID}}"
mkdir -p "${XDG_RUNTIME_DIR}" 2>/dev/null && chmod 700 "${XDG_RUNTIME_DIR}" 2>/dev/null || true

have node    || die "node not found"
have curl    || die "curl not found (needed for the readiness polls and screenshots)"
have xdpyinfo || die "xdpyinfo not found (install: sudo apt install x11-utils)"
[ -f "${REPO_ROOT}/src/server/main.ts" ] \
  || die "src/server/main.ts not found — the server half is not implemented yet in ${REPO_ROOT}"

# Refuse to start on a port something else owns: the readiness poll below would be
# satisfied by the other service while this run's node failed to bind.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/${1}") >/dev/null 2>&1; }
if port_busy "${API_PORT}"; then
  die "port :${API_PORT} is already in use — something else is listening there (another pinhole-window stack?).
  Use --api-port <N>, or stop the other one.  ss -ltnp \"sport = :${API_PORT}\""
fi
if port_busy "${VITE_PORT}"; then
  die "port :${VITE_PORT} is already in use — something else is listening there.
  Use --port <N>, or stop the other one.  ss -ltnp \"sport = :${VITE_PORT}\""
fi

# Resolve the simulator binary. The `evenhub-simulator` npm package is a launcher that
# execs the per-platform binary; running that binary directly leaves one pid to kill.
SIM_BIN="$(node -e 'try{process.stdout.write(require.resolve(`@evenrealities/sim-${process.platform}-${process.arch}/bin/evenhub-simulator`))}catch(e){}' 2>/dev/null || true)"
if [ -z "${SIM_BIN}" ] || [ ! -x "${SIM_BIN}" ]; then
  die "Even Hub simulator binary not found. Expected @evenrealities/sim-$(node -p 'process.platform+"-"+process.arch') in node_modules (run `npm ci`)"
fi

# A live automation port means a simulator is already running. A second one would be a
# second client on the same API server, and the two would fight over the mirror.
if curl -fs --max-time 2 -o /dev/null "http://127.0.0.1:${AUTOMATION_PORT}/api/ping"; then
  die "automation port :${AUTOMATION_PORT} already answers /api/ping — a simulator is already running.
  Reuse it:   curl -s http://127.0.0.1:${AUTOMATION_PORT}/api/screenshot/glasses -o g.png
  Or isolate: --automation-port <N> --sim-display :<M>
  Do NOT start a second sim against the same API server."
fi

# ── the simulator's own nested X ─────────────────────────────────────────────
SIM_DISPLAY="$(pick_display "${SIM_DISPLAY}")"
if [ "${HEADLESS}" = 0 ] && [ -z "${HOST_DISPLAY}" ]; then
  echo "sim.sh: no host X display (\$DISPLAY unset) — falling back to --headless" >&2
  HEADLESS=1
fi

if [ "${HEADLESS}" = 1 ]; then
  have Xvfb || die "Xvfb not found (install: sudo apt install xvfb)"
  XBACKEND=Xvfb
  # -listen tcp / -nolisten unix: on WSL2 /tmp/.X11-unix can lose its sticky bit, and
  # an X server whose only transport is unix then exits with "failed to create listener
  # for unix". TCP on loopback avoids that.
  setsid Xvfb "${SIM_DISPLAY}" -screen 0 "${SIM_SCREEN}x24" -listen tcp -nolisten unix \
    >"${X_LOG}" 2>&1 &
else
  have Xephyr || die "Xephyr not found (install: sudo apt install xserver-xephyr)"
  XBACKEND=Xephyr
  setsid env DISPLAY="${HOST_DISPLAY}" Xephyr "${SIM_DISPLAY}" \
    -screen "${SIM_SCREEN}" -ac -resizeable -no-host-grab -listen tcp \
    -title "even-sim ${SIM_DISPLAY}" >"${X_LOG}" 2>&1 &
fi
X_PID=$!
track "${X_PID}" "${XBACKEND}"

# Talk to the nested server over TCP (see -listen tcp above).
NX_DISPLAY="127.0.0.1:${SIM_DISPLAY#:}"
for (( i = 0; i < 100; i++ )); do
  DISPLAY="${NX_DISPLAY}" xdpyinfo >/dev/null 2>&1 && break
  kill -0 "${X_PID}" 2>/dev/null || die "${XBACKEND} exited immediately. See ${X_LOG}"
  sleep 0.2
done
DISPLAY="${NX_DISPLAY}" xdpyinfo >/dev/null 2>&1 \
  || die "${XBACKEND} never became ready on ${SIM_DISPLAY}. See ${X_LOG}"
echo "sim.sh: ${XBACKEND} ${SIM_DISPLAY} (${SIM_SCREEN}) ready"

SB=()
have stdbuf && SB=(stdbuf -oL -eL)

# ── 1. API / capture server ──────────────────────────────────────────────────
# The server does not inherit DISPLAY: it creates and owns its nested X at
# EW_X11_DISPLAY. Given the simulator's display, it would capture the simulator.
: >"${API_LOG}"
if [ "${AUTH}" = 1 ]; then
  EW_AUTH_VAL=1
  echo "sim.sh: AUTH ENFORCED (EW_AUTH=1). The WebView must be paired or it gets 401s."
  echo "sim.sh: This run has its own registry, so point ew-auth at the same one:"
  echo "sim.sh:   EW_STATE_DIR='${STATE_DIR}' node scripts/ew-auth.mjs open '<app-url>'"
  echo "sim.sh:   then re-launch with --app-query \"pair=<CODE>\""
else
  EW_AUTH_VAL=0
  echo "sim.sh: ###############################################################"
  echo "sim.sh: # NOTICE: running with EW_AUTH=0 — THE AUTH GATE IS DISABLED. #"
  echo "sim.sh: # Every /api route is unauthenticated for this run, including #"
  echo "sim.sh: # /api/spawn and /api/desktop/input (= code execution). Loopback  #"
  echo "sim.sh: # only. Pass --auth to exercise the real gate.                #"
  echo "sim.sh: ###############################################################"
fi
setsid env -u DISPLAY EW_ENV_FILE="${ENV_FILE}" EW_STATE_DIR="${STATE_DIR}" \
  EW_PORT="${API_PORT}" EW_X11_DISPLAY="${X_DISPLAY}" \
  EW_X11_RUNTIME_DIR="${RUNTIME_DIR}" EW_AUTH="${EW_AUTH_VAL}" \
  "${SB[@]}" node "${REPO_ROOT}/src/server/main.ts" \
  > >(prefix '[api] ' "${API_LOG}") 2>&1 &
API_PID=$!
track "${API_PID}" api

if ! wait_http "http://127.0.0.1:${API_PORT}/api/health" "${READY_TIMEOUT}" "${API_PID}"; then
  die "API server did not come up on :${API_PORT} (GET /api/health never answered). See ${API_LOG}"
fi
echo "sim.sh: api ready (pid ${API_PID})"

# ── 2. Vite ──────────────────────────────────────────────────────────────────
: >"${VITE_LOG}"
if [ -x "${REPO_ROOT}/node_modules/.bin/vite" ]; then
  VITE_CMD=("${REPO_ROOT}/node_modules/.bin/vite")
else
  VITE_CMD=(npx --no-install vite)
fi
setsid env -u DISPLAY -C "${REPO_ROOT}" "${SB[@]}" "${VITE_CMD[@]}" \
  --port "${VITE_PORT}" --strictPort \
  > >(prefix '[vite]' "${VITE_LOG}") 2>&1 &
VITE_PID=$!
track "${VITE_PID}" vite

if ! wait_http "http://127.0.0.1:${VITE_PORT}/" "${READY_TIMEOUT}" "${VITE_PID}"; then
  die "Vite did not come up on :${VITE_PORT}. See ${VITE_LOG}"
fi
echo "sim.sh: vite ready (pid ${VITE_PID})"

# ── 3. the simulator ─────────────────────────────────────────────────────────
APP_URL="http://127.0.0.1:${VITE_PORT}/?server=http://127.0.0.1:${API_PORT}${APP_QUERY:+&${APP_QUERY#&}}"
: >"${SIM_LOG}"
# WEBKIT_DISABLE_*/LIBGL_ALWAYS_SOFTWARE: WebKit's DMABUF/GL compositing path
# fails on a nested/virtual X (blank window or crash). Force the software path.
setsid env -u WAYLAND_DISPLAY \
  DISPLAY="${NX_DISPLAY}" GDK_BACKEND=x11 MOZ_ENABLE_WAYLAND=0 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 \
  LIBGL_ALWAYS_SOFTWARE=1 \
  "${SIM_BIN}" --automation-port "${AUTOMATION_PORT}" "${APP_URL}" \
  > >(prefix '[sim] ' "${SIM_LOG}") 2>&1 &
SIM_PID=$!
track "${SIM_PID}" sim

if ! wait_http "http://127.0.0.1:${AUTOMATION_PORT}/api/ping" "${READY_TIMEOUT}" "${SIM_PID}"; then
  die "simulator did not come up (automation API :${AUTOMATION_PORT}/api/ping never answered). See ${SIM_LOG}"
fi
echo "sim.sh: sim ready (pid ${SIM_PID}) -> ${APP_URL}"

# ── optional: tidy the two panels into a portrait column (visible mode only) ──
# The simulator opens two top-level X windows and the nested server has no window
# manager, so they would land side by side. Cosmetic only.
#
# On the simulator's display the panels are named "Browser" and "Glasses Display". A
# window named "even-sim" is the Xephyr host window on $HOST_DISPLAY (the -title passed
# above), not a simulator window. Window ids change on every launch.
stack_windows() {
  have xdotool || return 0
  local bw="" gw="" i B_HEIGHT=800
  for (( i = 0; i < 100; i++ )); do
    # `|| true` is required under `set -euo pipefail`: until the windows exist, xdotool
    # search exits non-zero.
    bw="$(DISPLAY="${NX_DISPLAY}" xdotool search --name '^Browser$' 2>/dev/null | head -1 || true)"
    gw="$(DISPLAY="${NX_DISPLAY}" xdotool search --name '^Glasses Display$' 2>/dev/null | head -1 || true)"
    [ -n "${bw}" ] && [ -n "${gw}" ] && break
    sleep 0.2
  done
  [ -n "${bw}" ] && [ -n "${gw}" ] || return 0
  eval "$(DISPLAY="${NX_DISPLAY}" xdotool getwindowgeometry --shell "${bw}" 2>/dev/null | sed -n 's/^HEIGHT=/B_HEIGHT=/p')"
  # The simulator re-places its windows for a moment after they appear, so re-assert
  # until the positions hold.
  local held=0 X=0 Y=0 gX=0 gY=0
  local bx=2 by=2 gx=2 gy=$((2 + B_HEIGHT + 6))
  for (( i = 0; i < 40; i++ )); do
    DISPLAY="${NX_DISPLAY}" xdotool windowmove "${bw}" "${bx}" "${by}" 2>/dev/null || true
    DISPLAY="${NX_DISPLAY}" xdotool windowmove "${gw}" "${gx}" "${gy}" 2>/dev/null || true
    sleep 0.25
    eval "$(DISPLAY="${NX_DISPLAY}" xdotool getwindowgeometry --shell "${bw}" 2>/dev/null | sed -n 's/^\([XY]\)=/\1=/p')"
    eval "$(DISPLAY="${NX_DISPLAY}" xdotool getwindowgeometry --shell "${gw}" 2>/dev/null | sed -n 's/^\([XY]\)=/g\1=/p')"
    if [ "${X}" = "${bx}" ] && [ "${Y}" = "${by}" ] && [ "${gX}" = "${gx}" ] && [ "${gY}" = "${gy}" ]; then
      held=$((held + 1)); [ "${held}" -ge 3 ] && break
    else
      held=0
    fi
  done
  return 0
}
[ "${HEADLESS}" = 0 ] && stack_windows &

# ── optional: glasses screenshot ─────────────────────────────────────────────
# Validate the bytes instead of trusting HTTP 200: a wrong URL against the Vite port
# returns index.html as 200 text/html.
plane_levels() { # png [ffmpeg_filter] -> count of distinct 8-bit values in that plane
  local f="$1" filt="${2:-}" vf=()
  [ -n "${filt}" ] && vf=(-vf "${filt}")
  ffmpeg -v error -i "${f}" "${vf[@]}" -pix_fmt gray -f rawvideo - 2>/dev/null \
    | od -An -v -tu1 | tr -s ' ' '\n' | sed '/^$/d' | sort -u | wc -l
}

grab_glasses() { # out_path -> 0 only if it is genuinely a PNG
  local out="$1" hdr magic sz ctype
  hdr="$(mktemp)"
  if ! curl -fsS -D "${hdr}" -o "${out}" --max-time 20 \
       "http://127.0.0.1:${AUTOMATION_PORT}/api/screenshot/glasses"; then
    echo "sim.sh: screenshot request FAILED (curl)" >&2
    rm -f "${hdr}"; return 1
  fi
  ctype="$(tr -d '\r' <"${hdr}" | sed -n 's/^[Cc]ontent-[Tt]ype: *//p' | head -1)"
  rm -f "${hdr}"
  case "${ctype}" in
    image/png) ;;
    *) echo "sim.sh: screenshot content-type was '${ctype}', expected image/png" >&2; return 1;;
  esac
  magic="$(od -An -tx1 -N8 "${out}" | tr -d ' \n')"
  [ "${magic}" = "89504e470d0a1a0a" ] \
    || { echo "sim.sh: screenshot is not a PNG (magic ${magic})" >&2; return 1; }
  sz="$(stat -c %s "${out}")"
  [ "${sz}" -gt 256 ] || { echo "sim.sh: screenshot is implausibly small (${sz} bytes)" >&2; return 1; }
  echo "sim.sh: screenshot ok -> ${out} (${sz} bytes, $(file -b "${out}" 2>/dev/null || echo PNG))"
  # A valid PNG shows that the simulator answered, not that the mirror pipeline ran.
  # File size cannot tell the two apart: a mostly blank mirrored frame compresses to
  # about the size of an unpainted one. A frame with a single level was never painted.
  local lum alpha levels
  if have ffmpeg; then
    # Check the alpha plane too: the automation API returns RGBA whose RGB is a uniform
    # green with the content carried in alpha, so luma alone reads one level on a good
    # frame.
    lum="$(plane_levels "${out}" '')"
    alpha="$(plane_levels "${out}" 'alphaextract')"
    levels="${lum}"
    [ "${alpha}" -gt "${levels}" ] 2>/dev/null && levels="${alpha}"
    if [ "${levels}" = "1" ]; then
      echo "sim.sh: WARNING — the glasses frame is a single uniform colour (nothing rendered)." >&2
      echo "sim.sh:   The sim is up but the app pushed no tiles. Things to check:" >&2
      echo "sim.sh:     curl -s http://127.0.0.1:${AUTOMATION_PORT}/api/console   # client-side errors" >&2
      echo "sim.sh:     curl -s http://127.0.0.1:${API_PORT}/api/health           # is capture running" >&2
      echo "sim.sh:     tail ${SIM_LOG}" >&2
    else
      echo "sim.sh: frame has content (luma ${lum} / alpha ${alpha} distinct levels)."
    fi
  fi
  return 0
}

RC=0
if [ -n "${SHOT}" ]; then
  mkdir -p "$(dirname "${SHOT}")"
  echo "sim.sh: settling ${SETTLE_MS}ms before the capture..."
  sleep "$(awk "BEGIN{print ${SETTLE_MS}/1000}")"
  grab_glasses "${SHOT}" || RC=1
fi

if [ "${KEEP}" = 1 ] || [ -z "${SHOT}" ]; then
  cat <<EOF
sim.sh: up. Ctrl-C to stop.
  app        ${APP_URL}
  auth       EW_AUTH=${EW_AUTH_VAL} $([ "${AUTH}" = 1 ] && echo '(ENFORCED)' || echo '(DISABLED for this run)')
  state      ${STATE_DIR} (this run's own registry; ~/.even-window is untouched)
  env        ${ENV_FILE:-none — create dev.env (mode 600) for persistent EW_* in harness runs}
  api        http://127.0.0.1:${API_PORT}/api/health
  automation http://127.0.0.1:${AUTOMATION_PORT}/api/{ping,screenshot/glasses,screenshot/webview,console}
  sim X      ${SIM_DISPLAY} (${XBACKEND}, reach it as DISPLAY=${NX_DISPLAY})
  logs       ${API_LOG} / ${VITE_LOG} / ${SIM_LOG}
  pids       api ${API_PID}  vite ${VITE_PID}  sim ${SIM_PID}  ${XBACKEND} ${X_PID}
EOF
  while kill -0 "${API_PID}" 2>/dev/null \
     && kill -0 "${VITE_PID}" 2>/dev/null \
     && kill -0 "${SIM_PID}" 2>/dev/null; do
    sleep 1
  done
  kill -0 "${API_PID}"  2>/dev/null || echo "sim.sh: API server exited — see ${API_LOG}" >&2
  kill -0 "${VITE_PID}" 2>/dev/null || echo "sim.sh: Vite exited — see ${VITE_LOG}" >&2
  kill -0 "${SIM_PID}"  2>/dev/null || echo "sim.sh: simulator exited — see ${SIM_LOG}" >&2
  if [ "${RC}" = 0 ]; then RC=1; fi
fi

exit "${RC}"
