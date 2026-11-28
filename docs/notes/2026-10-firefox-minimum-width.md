# Firefox minimum width investigation

Snapshot — not maintained. Conditions: Firefox 157 (deb), WSL2 + WSLg, nested X at 576×288 under ratpoison, measured 2026-10-11 and 2026-10-16.

## Symptom

On the 576×288 display, the right end of every line is cut off. No horizontal
scrollbar appears and the right end of the toolbar is invisible. Windowed and
full-screen (F11) behave the same.

## Cause

ratpoison gives the window the correct 576×288. Firefox declares a larger minimum
size to X and lays itself out at that width; X discards the overflow.

```
$ xprop -id $win WM_NORMAL_HINTS
        program specified minimum size: 638 by 120
        program specified base size: 638 by 120
$ xwininfo -id $win | grep -E 'Width|Height'
  Width: 576
  Height: 288
```

638 − 576 = 62 px are lost. The page cannot observe this: `document.scrollWidth`
equals the laid-out width.

| Value | Windowed | Full screen (F11) |
| --- | --- | --- |
| `window.innerWidth` | 587 | 638 |
| Breakdown | 638 − sidebar rail (about 51) | 638 − frame (2) |

F11 is unrelated to the overflow; it only collapses the chrome.

## Minimum size by profile (2026-10-11, throwaway `Xvfb :199`)

| Profile | `minimum size` | Fits 576×288 |
| --- | --- | --- |
| Default (sidebar rail shown) | 638 by 120 | No, 62 px overflow |
| `min-width` removed only | 500 by 120 | Yes |
| Shipped template (plus collapsed tab strip, compact density, no bookmarks bar) | 387 by 1 | Yes, 189 px spare |

`WM_CLASS(STRING) = "Firefox", "pinhole-window-firefox"` was confirmed in the same run.

The sidebar rail is on by default in Firefox 157 and already costs 36 px of width,
so putting the tabs there costs no extra width, while the horizontal tab strip costs
height out of 288 px.

## `layout.css.devPixelsPerPx` fallback

| Value | Minimum width | Viewport (CSS px) |
| --- | --- | --- |
| `0.9` | 638 → 574 | 640×320 |
| `0.85` | 542 | 677×339 |

terminal-mode-console's web UI collapses its header and footer at heights of 320 px
or less, so `0.9` triggers that exactly; at `0.85` it needs `&compact=340` in the URL.

## User agent override (2026-10-16)

Measured by having a page write `navigator.userAgent` into `document.title` and
reading the X window name.

| Action | Result |
| --- | --- |
| Global `general.useragent.override` | Works |
| Per-domain `general.useragent.override.<host>` | Does not work in Firefox 157 (`general.useragent.site_specific_overrides` is gone) |
| Setting the override to `""` | The user agent becomes empty; the preference must be deleted instead |

Per-site switching therefore needs an extension. Deleting the preference in
`about:config` takes effect on the next page load, and `user.js` re-applies it on
the next start.

The mobile user agent was retired from the template on 2026-10-16: at 576 px nearly
every responsive site is already below its 768 px breakpoint and shows a single
column with a desktop user agent. A mobile user agent matters only on sites that
choose the variant on the server, where fixed headers and "open in app" banners cost
height. `meta viewport` handling stays off because enabling it draws a second,
inset scrollbar (measured earlier).

To restore it locally, in `user-local.js`:

```js
user_pref("general.useragent.override", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36");
user_pref("dom.w3c_touch_events.enabled", 1);
```

## Other observations

- snap Firefox cannot be used under WSLg: `/tmp/.X11-unix` is mounted read-only, so
  the nested X listens on TCP only, and snap confinement forbids TCP X connections
  (`cannot open display`).
- `user.js` values are written into `prefs.js` and persist after the line is removed
  from the template; hence `RETIRED_PREFS` in `ew-firefox.sh`.
- The Firefox 157 deb keeps profiles under `~/.config/mozilla/firefox/`, not `~/.mozilla`.
- `extensions.activeThemeID` has no effect on a new profile: the add-on manager
  re-enables the default theme and writes the preference back. Dark chrome comes
  from the `ui.systemUsesDarkTheme` preferences, black from `userChrome.css`.
- The runtime profile is under `$HOME`, not `/tmp`, because WSL clears `/tmp`.

## Not adopted

- Bundled Dark Reader. It is the practical way to darken sites without a dark theme.
  Known traps: forcing black unconditionally makes Dark Reader decide the page is
  already dark, so the rule must be gated with `:not([data-darkreader-scheme])`; and
  the scrim of a closed drawer must be reset to transparent or the page goes black.
- A bundled start page of large, tab-ordered links as a substitute for typing URLs.
- Marionette-based link navigation: heavy, and `navigator.webdriver` becomes true,
  which blocks sign-in on Google and similar sites.

## Alternative considered

Running the nested X larger and scaling down to 576×288 in capture would fit every
application with a large minimum size at once, but scaling to a 16-level panel
blurs edges and hurts legibility. Rendering at native resolution is preferred.
