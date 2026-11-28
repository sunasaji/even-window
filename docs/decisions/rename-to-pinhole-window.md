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

The paths and unit names follow, with a fallback so that an install made under the old name
keeps working without moving anything:

| Now | Former name, still honoured |
| --- | --- |
| State directory `~/.pinhole-window` | `~/.even-window` is used while it is the only one of the two (`defaultStateDir`) |
| Env files `~/.pinhole-window/env`, `~/.config/pinhole-window/env` | The same two under `even-window` are read after them, so the new files win a key both set |
| Unit `pinhole-window@.service` | An enabled `even-window@…` unit has to be disabled and the new one enabled; the unit reads all four env files |
| Firefox profile `~/.local/share/pinhole-window/firefox`, window class `pinhole-window-firefox` | The old profile directory is used while it is the only one |

To migrate, stop the server, move each directory to its new name and start again.

Two things keep the old spelling:

| Kept | Why |
| --- | --- |
| `package_id` `dev.sunasaji.evenwindow` | Even Hub treats a new id as a new app; testers and enrolled keys would not carry over |
| `EW_*` variables, `ew.*` storage keys, `ew-auth.mjs` | They never spelled the old name out |

## Alternatives considered

- Keep the name and see whether review accepts it: a rename after public release costs more
  than one during beta, with one tester.
- Rename the paths with no fallback: a clean break, at the price of every existing install
  losing its pairings and settings until someone moves the directory by hand.
- Change the package id too: it would be a different app on Even Hub.
- eye-window, following-window and others: "following" reads as "the window below" in running
  text; "pinhole" is a noun that does not blend into a sentence, and no project or package of
  that name was found on npm or GitHub.

## Consequences

- `even-window` in the code is the fallback above (`LEGACY_NAME`), not a leftover.
- GitHub redirects the old repository URL.
- The Even Hub display name has to be changed to match `app.json`.
