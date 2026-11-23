# Phone UI: the submit key is a closed, per-app list

## Context

The text box sends a string to the focused application. Whether a key is pressed afterwards
is the difference between typing and running a command, and the right key differs per
application (Enter in a shell, Ctrl+Enter in many web forms, Tab in a login form). Multi-line
text has the same problem for line breaks (Enter in a terminal, Shift+Enter in a chat box).

## Decision

- `submit` is a choice from the closed list `SUBMIT_CHORDS` (`off` plus seven chords), stored
  as an id string in the same per-app record as swipe bindings. `newline` is the Enter-family
  subset `NEWLINE_CHORDS`.
- The default submit key is `off`. The default newline key is Enter.
- Line breaks are sent as key presses between per-line `type` injections (`sendPlan()`), not
  as characters and not folded into spaces.
- `submit`, `newline` and `fontsize` resolve per field: the first matching entry that states
  an opinion on that field wins. "Not set" inherits; `off` is an explicit value.
- In the text box, plain Enter inserts a line break and Ctrl/Cmd+Enter submits. Holding
  `Submit` sends once without the submit key.

## Alternatives considered

- Ctrl/Alt/Shift toggles next to an Enter toggle: offers 16 combinations to reach four,
  makes `Ctrl+Alt+Shift+Enter` storable, and cannot express `Tab` or `Ctrl+S`.
- Storing a `Chord`, or a second picker beside the text box: any combination becomes
  storable; two editors mean two commit styles.
- Default Enter: for an app nobody configured, the irreversible choice (run) is the wrong one.
- Folding newlines to spaces: safe only while the trailing key was always Enter; it made
  multi-line input impossible.
- One `type` injection containing newlines: `type` sends Linefeed, which some shells do not
  accept as Enter, and it can never produce Shift+Enter.

## Consequences

- A wrong `newline` for a chat app sends N messages instead of one; the editor shows a note
  for every entry, and `C-s` / `C-d` carry warnings.
- Record-level resolution would silently reset an app's submit key when a swipe binding is
  added for it; per-field resolution prevents that.
