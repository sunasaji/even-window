# Firefox on the mirrored desktop

English | [日本語](firefox.ja.md)

Firefox needs a dedicated profile to be usable on a 576×288, 16-level display. With
a default profile its window is laid out wider than the screen and the right edge is
cut off; its toolbars are grey, which on the glasses is a permanently lit band; and
its scrollbars disappear. `scripts/ew-firefox.sh` starts Firefox with a profile that
fixes these.

Only the Firefox started by this script is affected. It never shares a profile or a
process with a Firefox on your desktop.

## Set-up

Add one line to `~/.even-window/apps.conf` ([configuration.md](configuration.md#appsconf)),
with the absolute path of your checkout:

```
app Firefox (G2) = /home/you/src/pinhole-window/scripts/ew-firefox.sh
```

No restart is needed. `Firefox (G2)` appears in the phone's **apps** palette, and on
the glasses menu after its first launch.

Use a Firefox installed from a `.deb` package or the official tarball. On WSL2, the
snap package cannot connect to the mirrored desktop
([troubleshooting.md](troubleshooting.md#firefox-does-not-start-on-wsl2)).

## What the launcher does

1. Copies the profile template in `scripts/firefox-profile/` into the runtime
   profile (`~/.local/share/even-window/firefox`) on every launch. Edit the
   template, not the runtime copy. Cookies, history and logins live in the runtime
   profile and survive.
2. Appends `<profile>/user-local.js` to the profile's `user.js`. The script creates
   this file once and never overwrites it. Put settings that belong to this machine
   there, such as a home page that carries a token.
3. Starts Firefox as its own instance (`--no-remote --new-instance`,
   `MOZ_DBUS_REMOTE=0`), on X11, with window class `even-window-firefox`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EW_FIREFOX_PROFILE` | `~/.local/share/even-window/firefox` | Runtime profile directory |
| `EW_FIREFOX_URL` | unset | Open this URL instead of the home page |
| `EW_FIREFOX_BIN` | `firefox` | Firefox binary |

### Choosing the start page

The launcher passes no arguments from the application list, so set the home page in
`<profile>/user-local.js`:

```js
user_pref("browser.startup.homepage", "https://<host>:<port>/?token=<token>");
```

For a one-off run from a shell: `EW_FIREFOX_URL=https://example.org scripts/ew-firefox.sh`.

## What the profile changes

| File | Change | Reason |
| --- | --- | --- |
| `userChrome.css` | Removes the browser chrome's minimum width | Firefox otherwise declares a minimum window width of 638 px, wider than the 576 px screen. Everything else depends on this. |
| `userChrome.css` | Pure black chrome, menus, URL bar and notification bars, with green accents | The built-in dark theme is dark grey, which stays lit on an emissive display |
| `user.js`, `userChrome.css` | Tabs in the sidebar rail (`sidebar.verticalTabs`); the horizontal tab strip is collapsed | Height is the scarce dimension at 288 px, and visible tabs let you get back from a link that opened a new tab |
| `user.js` | First-run pages, prompts and nags disabled | A modal dialog is hard to dismiss with gestures |
| `user.js` | Thin, always-visible scrollbars | Scrolling is done by swipe, so the bar is the only indication of position |
| `user.js` | Desktop user agent; `meta viewport` handling off | At 576 px most responsive sites already use their single-column layout. Mobile variants add fixed headers that cost height. |
| `userContent.css` | 3 px green focus ring, dashed outline on text fields | A thin default ring disappears at 16 levels |
| `userContent.css` | Blank pages are black | A white flash lights the whole lens |
| `ew-firefox.sh` | `GTK_THEME=Adwaita:dark` | Native dialogs such as the file picker are not reached by CSS |

Antialiasing is already off for every application on the mirrored desktop, so the
launcher does nothing about fonts.

Press `F11` to give the page the whole screen. Full-screen mode hides the tab rail
and the toolbar; press it again to choose a tab.

## Check that it worked

On the mirrored desktop (display `:100` by default; use `127.0.0.1:100` where the
server logs that address):

```bash
win=$(DISPLAY=:100 xdotool search --onlyvisible --class even-window-firefox | head -1)
DISPLAY=:100 xprop -id "$win" WM_NORMAL_HINTS WM_CLASS
DISPLAY=:100 xwininfo -id "$win" | grep -E 'Width|Height'
```

It worked when the `program specified minimum size` is below 576 (387 by 1 with the
shipped template), the window is 576 by 288, and the right edge of the page is
visible. To test without touching the mirrored desktop, run the same check in a
throwaway server:

```bash
export DISPLAY=:199
Xvfb :199 -screen 0 576x288x24 -nolisten tcp &
until xdpyinfo >/dev/null 2>&1; do sleep 0.2; done
EW_FIREFOX_URL=about:blank scripts/ew-firefox.sh &
```

## If the window is still too wide

The minimum width depends on what is in the toolbar, so an extension can push it
back over 576. In `<profile>/user-local.js`, in order of preference:

1. `user_pref("layout.css.devPixelsPerPx", "0.9");` — a string preference. Every CSS
   pixel shrinks, so the minimum width does too. Text gets smaller.
2. `"0.85"` if that is not enough.
3. Start with `--kiosk` to remove the chrome entirely. There is then no URL bar and
   no tab list, so the home page is the only destination.

## Changing the template

- Removing a preference from `user.js` does not unset it in a profile that has
  already run, because Firefox copies `user.js` values into `prefs.js`. Add the
  preference name to `RETIRED_PREFS` in `ew-firefox.sh` so the launcher removes it.
- To use a mobile user agent, set `general.useragent.override` in `user-local.js`.
  It applies to every site; Firefox no longer supports per-site overrides.

Background: [Firefox minimum width investigation](notes/2026-10-firefox-minimum-width.md).
