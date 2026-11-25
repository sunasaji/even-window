# The voice dialog is a view of the phone's text box

## Context

A transcript has to be shown, possibly corrected, and then typed into the mirrored desktop.
The phone already has a text box with one submit path that knows the per-application submit
and newline keys. The glasses can show ten lines of text and report tap, double tap, swipes
and a long press. The microphone takes about 0.4 s to deliver its first frame, and an overlay
left on the glasses stops the mirror.

## Decision

- The phone's text box is the source of truth. The dialog on the glasses shows that text and
  three rows (`Send`, `Again`, `Cancel`).
- `Send` calls the phone's existing submit function; there is no second injection path.
- A long press starts, a tap stops. The long-press release is unbound.
- Double tap cancels in every stage. `Cancel` also empties the text box.
- "Listening" is shown on the first audio frame, not on the press.
- The dialog resolves exactly once, and closes itself after 60 seconds without input.
- Stages, rows, gestures and layout are pure functions in `src/shared/voiceDialog.ts`.

## Alternatives considered

- **A dedicated injection path for `Send`.** Two paths drift on whether the box was cleared,
  which sends the line twice.
- **Hold to talk.** It means holding a temple for the length of a sentence, and a lost
  release event would leave the microphone open.
- **`Cancel` closes the dialog and keeps the text.** The text was editable until that moment;
  leaving it makes it unclear what was cancelled.
- **Show "listening" on the press.** The display would claim to hear before it does and the
  first word would be lost.
- **Focus the text box when the transcript arrives.** The soft keyboard opens and conflicts
  with the phone UI's keyboard-height detection.
- **Draw the transcript as an image, or in a list container.** The lens font draws Japanese,
  and the firmware wraps text itself; list containers neither scroll nor update in place.

## Consequences

- A `Submit` on the phone resolves the glasses dialog, including during recording, and must
  close the microphone.
- Rows are limited to three so that six lines remain for the transcript; longer text is
  shown in pages on the glasses, turned by the swipe that moves the cursor, and stays
  complete on the phone. The rows are on the last page only: a tap on an earlier page turns
  it, so text that has not been shown cannot be sent from the glasses. Arriving on the last
  page selects no row, at the cost of one more step before `Send`, so that the tap meant to
  turn one more page does not send. It was elided with `…` at first, which meant sending text that
  could not be read on the glasses.
- Swipes are swallowed while the dialog is up; empty text and error strings are never typed.
