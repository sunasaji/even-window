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

Identifiers that an installation already depends on keep the old name:

| Kept | Why |
| --- | --- |
| `package_id` `dev.sunasaji.evenwindow` | Even Hub treats a new id as a new app; testers and enrolled keys would not carry over |
| State directory `~/.even-window`, env file `~/.config/even-window/env` | Renaming them would orphan pairings, bindings and settings on every existing install |
| systemd unit `even-window@.service` | Enabled units are addressed by this name |
| Firefox profile `~/.local/share/even-window/firefox`, launcher id `even-window-firefox` | Same: existing profiles and launcher entries |
| `EW_*` variables, `ew.*` storage keys, `ew-auth.mjs` | They never spelled the old name out |

## Alternatives considered

- Keep the name and see whether review accepts it: a rename after public release costs more
  than one during beta, with one tester.
- Rename the identifiers too: a clean break, at the price of every existing install. Nothing a
  user sees depends on them.
- eye-window, following-window and others: "following" reads as "the window below" in running
  text; "pinhole" is a noun that does not blend into a sentence, and no project or package of
  that name was found on npm or GitHub.

## Consequences

- A path or unit containing `even-window` is not a leftover; it is one of the identifiers above.
- GitHub redirects the old repository URL.
- The Even Hub display name has to be changed to match `app.json`.
