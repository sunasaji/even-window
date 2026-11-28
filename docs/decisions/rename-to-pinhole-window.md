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

Two things keep the old spelling:

| Kept | Why |
| --- | --- |
| `package_id` `dev.sunasaji.evenwindow` | Even Hub treats a new id as a new app; testers and enrolled keys would not carry over |
| `EW_*` variables, `ew.*` storage keys, `ew-auth.mjs` | They never spelled the old name out |

## Alternatives considered

- Keep the name and see whether review accepts it: a rename after public release costs more
  than one during beta, with one tester.
- Keep reading the old paths as a fallback: it protects existing installs, but there were
  almost none during the beta, and the fallback would stay in the code for good.
- Change the package id too: it would be a different app on Even Hub.
- eye-window, following-window and others: "following" reads as "the window below" in running
  text; "pinhole" is a noun that does not blend into a sentence, and no project or package of
  that name was found on npm or GitHub.

## Consequences

- `even-window` no longer appears in the code or the paths; only the package id carries it.
- GitHub redirects the old repository URL.
- The Even Hub display name has to be changed to match `app.json`.
