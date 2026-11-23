#!/usr/bin/env bash
#
# bench-workload.sh — put a deterministic workload on the running mirrored desktop, so
# that before/after timing captures are driven by the same bytes (docs/development.md).
#
# Usage:
#   scripts/bench-workload.sh                 # counter64 (the default)
#   scripts/bench-workload.sh sl              # the steam locomotive, looped
#   scripts/bench-workload.sh --display :100  # override the display
#
# A workload must change all four quadrant tiles on every frame. One whose changing
# region is horizontally confined (`seq` at the left margin, or a single zero-padded
# counter whose moving digits sit at the right) dirties only two tiles, which reads
# like tile starvation. counter64 varies every column; `sl` crosses the full width.
# See docs/notes/2026-10-bench-workload-selection.md.
#
# The window is titled BENCH64 or BENCHSL; close it by that title, not by killing
# every xterm on the display.

set -uo pipefail

WORKLOAD=counter64
DISPLAY_OVERRIDE=

while [ $# -gt 0 ]; do
  case "$1" in
    counter64|sl) WORKLOAD=$1; shift ;;
    --display) DISPLAY_OVERRIDE=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "bench-workload.sh: unknown argument '$1' (expected counter64 | sl | --display)" >&2; exit 2 ;;
  esac
done

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SESSION="$ROOT/.ew-x11/session.json"

# Use the transport the server recorded for its X: Xvfb is started with -listen tcp and
# its unix socket is not always answerable (src/server/platform/x11/session.ts).
if [ -n "$DISPLAY_OVERRIDE" ]; then
  DISP=$DISPLAY_OVERRIDE
elif [ -r "$SESSION" ]; then
  DISP=$(node -e 'const s=require(process.argv[1]);process.stdout.write(s.displayEnv||s.display||"")' "$SESSION" 2>/dev/null)
else
  DISP=${EW_X11_DISPLAY:-:100}
fi

if [ -z "$DISP" ]; then
  echo "bench-workload.sh: no display — is the server running? (looked in $SESSION)" >&2
  exit 1
fi

if ! DISPLAY="$DISP" xdotool getdisplaygeometry >/dev/null 2>&1; then
  echo "bench-workload.sh: cannot reach X on $DISP — start the server first (scripts/dev.sh)" >&2
  exit 1
fi

# The default client's flags (DEFAULT_SPAWN_ARGV in src/server/platform/x11/session.ts):
# a light background would light the whole lens, and the 64-column line below is sized
# for the 9x18 bitmap font. +sb because a scrollbar takes columns.
XTERM_FLAGS=(
  -bg black -fg white -cr white
  -fn -misc-fixed-bold-r-normal--18-120-100-100-c-90-iso10646-1
  -bw 0 -b 0 +sb
)

case "$WORKLOAD" in
  counter64)
    TITLE=BENCH64
    # 64 columns is the full width at 9 px per character on a 576 px screen. Eight
    # 8-digit fields, each a different multiple of i, so every column changes on every
    # line; the moduli keep each field 8 digits wide.
    CMD='awk "BEGIN{for(i=0;;i++)printf \"%08d%08d%08d%08d%08d%08d%08d%08d\n\", i%99999999,(i*7)%99999999,(i*13)%99999999,(i*31)%99999999,(i*71)%99999999,(i*131)%99999999,(i*311)%99999999,(i*719)%99999999}"'
    ;;
  sl)
    TITLE=BENCHSL
    command -v sl >/dev/null 2>&1 || { echo "bench-workload.sh: sl is not installed" >&2; exit 1; }
    CMD='while :; do sl -l; done'
    ;;
esac

if DISPLAY="$DISP" ratpoison -c windows 2>/dev/null | grep -q "$TITLE"; then
  echo "bench-workload.sh: a $TITLE window is already running on $DISP — nothing to do"
  exit 0
fi

DISPLAY="$DISP" \
GDK_BACKEND=x11 MOZ_ENABLE_WAYLAND=0 \
  setsid xterm -T "$TITLE" "${XTERM_FLAGS[@]}" -e sh -c "$CMD" >/dev/null 2>&1 &

sleep 2
if DISPLAY="$DISP" ratpoison -c windows 2>/dev/null | grep -q "$TITLE"; then
  echo "bench-workload.sh: $WORKLOAD running on $DISP as '$TITLE'"
  DISPLAY="$DISP" ratpoison -c windows 2>/dev/null | sed 's/^/  /'
else
  echo "bench-workload.sh: $TITLE did not appear on $DISP — check that xterm has the 9x18 font" >&2
  exit 1
fi
