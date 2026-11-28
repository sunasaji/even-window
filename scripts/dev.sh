#!/usr/bin/env bash
#
# dev.sh — run the pinhole-window API/capture server and the Vite dev server together,
# without the Even Hub simulator (scripts/sim.sh is the full end-to-end harness).
#
#   1. node src/server/main.ts -> HTTP on EW_PORT (default 8787); it owns its nested
#      X display (EW_X11_DISPLAY, default :100) and the capture
#   2. Vite -> the WebView app on 5273
#   3. both logs are streamed with [api] / [vite] prefixes
#   4. Ctrl-C stops both by recorded pid
#
# Readiness is polled (GET /api/health, the Vite port), never slept for.
#
# Usage: scripts/dev.sh [--port 5273] [--api-port 8787] [--display :100] [--no-auth]
#
# Open http://127.0.0.1:5273/?server=http://127.0.0.1:8787 in a browser. The client
# resolves its API base from ?server=, then localStorage, then http://localhost:8787.
#
# Auth is enforced by default, as in production: the browser profile keeps its key, so
# pairing (the command this script prints) is needed once per profile. --no-auth runs
# with EW_AUTH=0 and prints a notice every time. See docs/security.md.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VITE_PORT="${VITE_PORT:-5273}"
API_PORT="${EW_PORT:-8787}"
AUTH=1
X_DISPLAY="${EW_X11_DISPLAY:-:100}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"

usage() {
  cat <<'EOF'
usage: scripts/dev.sh [options]

  Runs the pinhole-window API/capture server and Vite together (no simulator).

  --port <N>       Vite port                      (default 5273)
  --api-port <N>   API server port / EW_PORT      (default 8787)
  --display <:N>   server's nested X display      (default :100)
  --auth           run with the REAL auth gate (EW_AUTH enforced) — THE DEFAULT.
                   Pair the browser once with the command this script prints;
                   the key lives in that profile, so later runs are warm.
  --no-auth        run with EW_AUTH=0 instead, with a visible notice. The run is
                   still scoped to its own registry, no config file, loopback.
  -h, --help       this help

  Ctrl-C stops both. See docs/development.md.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port)      VITE_PORT="$2"; shift 2;;
    --api-port)  API_PORT="$2";  shift 2;;
    --display)   X_DISPLAY="$2"; shift 2;;
    --auth)      AUTH=1; shift;;        # the default; accepted so a habit keeps working
    --no-auth)   AUTH=0; shift;;
    -h|--help)   usage; exit 0;;
    *) echo "dev.sh: unknown argument: $1" >&2; usage >&2; exit 2;;
  esac
done

LOG_DIR="${EW_X11_RUNTIME_DIR:-${REPO_ROOT}/.ew-x11}/logs"

# The run has its own auth registry instead of ~/.even-window: pairing into the real
# registry would be refused by EW_MAX_CLIENTS (default 1) when a phone already holds the
# slot, and an EW_AUTH=0 run must not touch the real keys. An explicit EW_STATE_DIR wins.
STATE_DIR="${EW_STATE_DIR:-${EW_X11_RUNTIME_DIR:-${REPO_ROOT}/.ew-x11}/state}"
# The operator's ~/.even-window/env is not read: an EW_ORIGIN naming the tailnet URL
# would refuse every signature a browser makes at 127.0.0.1. The untracked dev.env in
# the checkout is read when it exists, for per-developer settings. An explicit
# EW_ENV_FILE wins, and an empty one means "no file".
# See docs/decisions/harness-auth-and-isolation.md.
HARNESS_ENV="${REPO_ROOT}/dev.env"
if [ "${EW_ENV_FILE+set}" = set ]; then ENV_FILE="${EW_ENV_FILE}"
elif [ -f "${HARNESS_ENV}" ];      then ENV_FILE="${HARNESS_ENV}"
else                                    ENV_FILE=""
fi

mkdir -p "${LOG_DIR}"
API_LOG="${LOG_DIR}/dev-api.log"
VITE_LOG="${LOG_DIR}/dev-vite.log"

die() { echo "dev.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── child bookkeeping ────────────────────────────────────────────────────────
# Every child is started under `setsid`, so it leads its own process group and one
# `kill -- -PID` reaps its grandchildren too (npx -> node, node -> ffmpeg / Xephyr).
# Kill by recorded pid only: `pkill -f` also matches this script's own command line.
PIDS=()
PNAMES=()
track() { PIDS+=("$1"); PNAMES+=("$2"); }

kill_pid() { # pid signal — process group first, bare pid as fallback
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
  local i n
  n=${#PIDS[@]}
  [ "${n}" -eq 0 ] && return 0
  echo "dev.sh: shutting down..." >&2
  for (( i = n - 1; i >= 0; i-- )); do
    kill -0 "${PIDS[i]}" 2>/dev/null || continue
    echo "dev.sh:   TERM ${PNAMES[i]} (pid ${PIDS[i]})" >&2
    kill_pid "${PIDS[i]}" TERM
  done
  # give them a moment, then escalate
  for (( i = 0; i < 25; i++ )); do
    local alive=0 j
    for (( j = 0; j < n; j++ )); do
      kill -0 "${PIDS[j]}" 2>/dev/null && alive=1
    done
    [ "${alive}" = 0 ] && break
    sleep 0.2
  done
  for (( i = n - 1; i >= 0; i-- )); do
    if kill -0 "${PIDS[i]}" 2>/dev/null; then
      echo "dev.sh:   KILL ${PNAMES[i]} (pid ${PIDS[i]})" >&2
      kill_pid "${PIDS[i]}" KILL
    fi
  done
  reap_log_pumps
  return 0
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

prefix() { # read stdin, tag every line, also append to a log file
  local tag="$1" file="$2" line
  while IFS= read -r line; do
    printf '%s %s\n' "${tag}" "${line}"
    printf '%s\n' "${line}" >>"${file}"
  done
}

wait_http() { # url seconds pid — poll, but bail out early if the child died
  # Readiness, not authorization: with auth on, /api/health answers 401, which still
  # shows that the listener is up.
  local url="$1" secs="$2" pid="$3" i code
  for (( i = 0; i < secs * 5; i++ )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${url}" || true)"
    case "${code}" in 2??|401) return 0;; esac
    kill -0 "${pid}" 2>/dev/null || return 2
    sleep 0.2
  done
  return 1
}

# ── environment hygiene for every child ──────────────────────────────────────
# On WSL2 with WSLg, a GTK/GDK child that sees $WAYLAND_DISPLAY renders on the host
# desktop instead of the nested X. The server scrubs its own children; this covers the
# processes started here. An inherited $TMUX/$TMUX_PANE would likewise attach a child
# to the caller's tmux session.
unset WAYLAND_DISPLAY TMUX TMUX_PANE
export GDK_BACKEND=x11
export MOZ_ENABLE_WAYLAND=0
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-${UID}}"
mkdir -p "${XDG_RUNTIME_DIR}" 2>/dev/null && chmod 700 "${XDG_RUNTIME_DIR}" 2>/dev/null || true

have node || die "node not found"
have curl || die "curl not found (needed for the readiness poll)"
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

# Line-buffer the children so the prefixed logs interleave in real time.
SB=()
have stdbuf && SB=(stdbuf -oL -eL)

echo "dev.sh: api :${API_PORT} (nested X ${X_DISPLAY})   vite :${VITE_PORT}"
echo "dev.sh: logs ${API_LOG} / ${VITE_LOG}"

# ── 1. API / capture server ──────────────────────────────────────────────────
: >"${API_LOG}"
if [ "${AUTH}" = 1 ]; then
  EW_AUTH_VAL=1
  echo "dev.sh: AUTH ENFORCED (EW_AUTH=1) — pair the browser (note the state dir: this run"
  echo "dev.sh: has its own registry, so ew-auth must be pointed at the same one):"
  echo "dev.sh:   EW_STATE_DIR='${STATE_DIR}' \\"
  echo "dev.sh:     node scripts/ew-auth.mjs pair 'http://127.0.0.1:${VITE_PORT}/?server=http://127.0.0.1:${API_PORT}'"
else
  EW_AUTH_VAL=0
  echo "dev.sh: ###############################################################"
  echo "dev.sh: # NOTICE: running with EW_AUTH=0 — THE AUTH GATE IS DISABLED. #"
  echo "dev.sh: # Every /api route is unauthenticated for this run, including #"
  echo "dev.sh: # /api/spawn and /api/desktop/input (= code execution). Loopback  #"
  echo "dev.sh: # only. Pass --auth to exercise the real gate.                #"
  echo "dev.sh: ###############################################################"
fi
setsid env EW_ENV_FILE="${ENV_FILE}" EW_STATE_DIR="${STATE_DIR}" \
  EW_PORT="${API_PORT}" EW_X11_DISPLAY="${X_DISPLAY}" EW_AUTH="${EW_AUTH_VAL}" \
  "${SB[@]}" node "${REPO_ROOT}/src/server/main.ts" \
  > >(prefix '[api] ' "${API_LOG}") 2>&1 &
API_PID=$!
track "${API_PID}" api

if ! wait_http "http://127.0.0.1:${API_PORT}/api/health" "${READY_TIMEOUT}" "${API_PID}"; then
  die "API server did not come up on :${API_PORT} (GET /api/health never answered). See ${API_LOG}"
fi
echo "dev.sh: api ready (pid ${API_PID})"

# ── 2. Vite ──────────────────────────────────────────────────────────────────
# Prefer the locally installed binary over `npx`: one fewer process between this script
# and the pid it has to kill. vite.config.ts pins port/strictPort/host.
: >"${VITE_LOG}"
if [ -x "${REPO_ROOT}/node_modules/.bin/vite" ]; then
  VITE_CMD=("${REPO_ROOT}/node_modules/.bin/vite")
else
  VITE_CMD=(npx --no-install vite)
fi
setsid env -C "${REPO_ROOT}" "${SB[@]}" "${VITE_CMD[@]}" --port "${VITE_PORT}" --strictPort \
  > >(prefix '[vite]' "${VITE_LOG}") 2>&1 &
VITE_PID=$!
track "${VITE_PID}" vite

if ! wait_http "http://127.0.0.1:${VITE_PORT}/" "${READY_TIMEOUT}" "${VITE_PID}"; then
  die "Vite did not come up on :${VITE_PORT}. See ${VITE_LOG}"
fi
echo "dev.sh: vite ready (pid ${VITE_PID})"

cat <<EOF
dev.sh: both up. Ctrl-C to stop.
  app   http://127.0.0.1:${VITE_PORT}/?server=http://127.0.0.1:${API_PORT}
  api   http://127.0.0.1:${API_PORT}/api/health
  auth  EW_AUTH=${EW_AUTH_VAL} $([ "${AUTH}" = 1 ] && echo '(ENFORCED)' || echo '(DISABLED for this run)')
  state ${STATE_DIR} (this run's own registry; ~/.even-window is untouched)
  env   ${ENV_FILE:-none — create dev.env (mode 600) for persistent EW_* in dev runs}
EOF

# Exit as soon as either half dies, so a crash is not silently half-running.
while kill -0 "${API_PID}" 2>/dev/null && kill -0 "${VITE_PID}" 2>/dev/null; do
  sleep 1
done
kill -0 "${API_PID}" 2>/dev/null || echo "dev.sh: API server exited — see ${API_LOG}" >&2
kill -0 "${VITE_PID}" 2>/dev/null || echo "dev.sh: Vite exited — see ${VITE_LOG}" >&2
exit 1
