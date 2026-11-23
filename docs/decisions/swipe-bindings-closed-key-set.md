# Swipe bindings use a closed key set and structured chords

## Context

Swipes are the glasses' only repeatable input, and what they should send differs per
application. Bindings are stored on the server and edited from the phone. The low-level key
injection route passes unknown key names through unchanged.

## Decision

A binding is `{mods: [...], key}` where `key` is a member of a fixed catalogue
(`src/shared/keys.ts`) whose names are the exact injection spellings, and `mods` is a set drawn
from `ctrl`, `alt`, `shift`. The server validates by set membership. Bindings are keyed by
application identity, resolved most specific first (`app:`, `exe:`, `comm:`, `cls:`, `title:`,
`*`), with `title:` offered only when nothing more durable exists.

## Alternatives considered

- Free-text key names: a plausible but wrong name saves cleanly and sends nothing.
- A `"C-u"` style string: needs normalisation for duplicates and ordering; a set cannot express
  either.
- A single identity kind: no single window property identifies every application.
- Window id or window-manager number as identity: neither survives a close or a reuse.
- `super` as a modifier: likely to be grabbed outside the mirrored desktop.

## Consequences

- What is stored is what is sent; a third key vocabulary is not created.
- Adding a key means adding a catalogue entry.
- Wheel entries are the one exception to "names are key spellings" and are executed as pointer
  buttons.
- With only the `*` entry, no focused-window lookup happens on the gesture path.

Background: [per-app swipe bindings](../notes/2026-10-swipe-bindings.md).
