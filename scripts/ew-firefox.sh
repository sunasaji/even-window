#!/usr/bin/env bash
# ew-firefox.sh — launch Firefox as an even-window X11 client, tuned for the G2.
#
# Point ~/.even-window/apps.conf at this script so that the launcher lists it:
#
#     app Firefox (G2) = /abs/path/to/scripts/ew-firefox.sh
#
# even-window execs an app's argv directly, without a shell and without arguments, so
# everything configurable comes from the environment or the profile.
#
#   1. Re-syncs the runtime profile from the template in scripts/firefox-profile/ on
#      every launch (edit the template, not the runtime copy). Cookies, history and
#      logins persist in the runtime directory.
#   2. Appends <profile>/user-local.js, created once and never overwritten, for
#      machine-specific prefs (homepage, UI scale) that stay out of the repository.
#   3. Execs Firefox as its own instance, so it never attaches to a desktop Firefox.
#
# Background: docs/firefox.md.
#
# Environment:
#   EW_FIREFOX_PROFILE  runtime profile dir (default ~/.local/share/even-window/firefox)
#   EW_FIREFOX_URL      open this URL instead of the profile's homepage
#   EW_FIREFOX_BIN      firefox binary (default: firefox)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
TEMPLATE="$SCRIPT_DIR/firefox-profile"
# Persistent and under $HOME, not /tmp: WSL clears /tmp, and the profile holds logins
# and site storage.
PROFILE="${EW_FIREFOX_PROFILE:-$HOME/.local/share/even-window/firefox}"
FIREFOX_BIN="${EW_FIREFOX_BIN:-firefox}"

[ -d "$TEMPLATE" ] || { echo "ew-firefox: template not found: $TEMPLATE" >&2; exit 1; }

# 1. provision / re-sync the runtime profile from the template
mkdir -p "$PROFILE/chrome"
chmod 700 "$PROFILE"
cp -f "$TEMPLATE/user.js" "$PROFILE/user.js"
cp -f "$TEMPLATE/chrome/userChrome.css" "$PROFILE/chrome/userChrome.css"
cp -f "$TEMPLATE/chrome/userContent.css" "$PROFILE/chrome/userContent.css"

# 1b. retired prefs. A pref set in user.js is written to prefs.js and stays there, so
#     deleting a line from the template does not unset it on a profile that has run.
#     Prefs dropped from the template are removed from prefs.js here; add to this list
#     when retiring one.
RETIRED_PREFS=(
  general.useragent.override # the mobile user agent (see user.js)
  dom.w3c_touch_events.enabled
)
if [ -f "$PROFILE/prefs.js" ]; then
  for p in "${RETIRED_PREFS[@]}"; do
    sed -i "/^user_pref(\"${p//./\\.}\"/d" "$PROFILE/prefs.js"
  done
fi

# 2. local overrides. Firefox reads only user.js, so they are appended to the copy made
#    above.
LOCAL="$PROFILE/user-local.js"
if [ ! -e "$LOCAL" ]; then
  cat > "$LOCAL" <<'LOCALEOF'
// even-window Firefox — LOCAL prefs for this machine. Appended to user.js on
// every launch and never overwritten by the template. Keep secrets here, not in
// the repository.

// Where the browser lands on start (browser.startup.page=1 in the template).
// user_pref("browser.startup.homepage", "https://<host>:<port>/?token=<token>");

// If the chrome's minimum width ever climbs back over the screen width (check
// with `xprop -id <win> WM_NORMAL_HINTS`), shrink every CSS pixel instead.
// A string pref, not a number. See docs/firefox.md.
// user_pref("layout.css.devPixelsPerPx", "0.9");
LOCALEOF
  chmod 600 "$LOCAL"
fi
printf '\n// ── appended from user-local.js ──\n' >> "$PROFILE/user.js"
cat "$LOCAL" >> "$PROFILE/user.js"

# 3. launch.
#    --no-remote --new-instance : never adopt (or be adopted by) a Firefox on :0;
#      MOZ_DBUS_REMOTE=0 does the same on the D-Bus side.
#    GTK_THEME=Adwaita:dark     : darkens native GTK parts (file picker, some popups)
#      that the Firefox theme and userChrome.css do not reach.
#    --class                    : WM_CLASS for ratpoison / xdotool --class.
#    X11, never Wayland         : the server already sets this for what it spawns; a
#      hand-run from a WSLg shell would otherwise render on the host desktop.
#    FONTCONFIG_FILE is not set : the server gives every client its antialias-off
#      fontconfig (src/server/platform/x11/xenv.ts), and a manual run on :0 should
#      use the desktop's fonts.
URL=()
[ -n "${EW_FIREFOX_URL:-}" ] && URL=("$EW_FIREFOX_URL")

exec env -u WAYLAND_DISPLAY \
  GTK_THEME="Adwaita:dark" \
  GDK_BACKEND=x11 \
  MOZ_ENABLE_WAYLAND=0 \
  MOZ_DBUS_REMOTE=0 \
  "$FIREFOX_BIN" --no-remote --new-instance --class even-window-firefox \
  --profile "$PROFILE" "${URL[@]}"
