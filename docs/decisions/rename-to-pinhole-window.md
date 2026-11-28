# Renamed from even-window to pinhole-window

## Context

The project was called even-window. Even Hub's naming rule rejects app names that contain
"Even", and other developers were made to rename apps of the form "Even" + noun. A lower-case,
hyphenated "even" was untested, and the only app left with the word in its name would not be a
strong position. Separately, only the client's drawing and gesture layer is specific to the Even
G2: the server (capture, tiles, input, authentication) would serve another display, so a name
tied to one vendor described less than the project is.

## Decision

The name is pinhole-window: a small, single-colour image of something that is elsewhere. It
replaces the old name wherever a person reads it: the app name in `app.json`, the page title,
the lens notices, the package name, the repository and the documentation.

The paths and unit names follow, with no fallback to the old ones: the state directory is
`~/.pinhole-window`, the env files are `~/.pinhole-window/env` and
`~/.config/pinhole-window/env`, the unit is `pinhole-window@.service`, and the Firefox profile
is `~/.local/share/pinhole-window/firefox` with window class `pinhole-window-firefox`.

An install made under the old name has to be moved by hand: stop the server, rename
`~/.even-window`, `~/.config/even-window` and `~/.local/share/even-window`, disable the
`even-window@…` unit and enable the new one. Until then the server starts as a fresh install.

The package id changes too, to `dev.sunasaji.pinholewindow`. Even Hub treats a new id as a
new app, so the beta listed as `dev.sunasaji.evenwindow` is retired and the app is created
again: its testers are invited again, and a phone pairs again unless the Even App keeps the
key across the two. The id cannot be changed once an app is public, and during the beta the
cost was one tester.

`EW_*` variables, `ew.*` storage keys and `ew-auth.mjs` stay: they never spelled the old name.

## Alternatives considered

- Keep the name and see whether review accepts it: a rename after public release costs more
  than one during beta, with one tester.
- Keep reading the old paths as a fallback: it protects existing installs, but there were
  almost none during the beta, and the fallback would stay in the code for good.
- Keep the package id, as other renamed apps did: it would have carried the old name for good,
  and a later app under the new id could not have taken the same display name.
- eye-window, following-window and others: "following" reads as "the window below" in running
  text; "pinhole" is a noun that does not blend into a sentence, and no project or package of
  that name was found on npm or GitHub.

## Consequences

- `even-window` no longer appears in the code, the paths or the package id.
- GitHub redirects the old repository URL.
- The old Even Hub app is deleted once the new one is confirmed on a phone.
