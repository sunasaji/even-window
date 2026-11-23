# Typing non-ASCII text, and how the lens draws transcripts

Snapshot — not maintained. Conditions: 2026-10-17 to 2026-10-19; typing measured with
`xdotool type` into `cat > file` on Xephyr and Xvfb displays; lens text observed on G2
hardware (576 px wide, proportional font), SDK 0.0.16.

## `xdotool type` drops non-ASCII characters at the default delay

Byte comparison of what the client application received:

| Input | Result |
| --- | --- |
| 48 ASCII characters, default delay (12 ms) | 3/3 identical |
| 26 Japanese characters, default delay | 3/3 lossy (20, 25 and 23 characters arrived) |
| 26 Japanese characters, `--delay 25` | 1 of 3 runs lost one character |
| 26 Japanese characters, `--delay 40` | 8/8 identical |

ASCII characters already have keycodes. For anything else xdotool remaps a spare keycode to
the keysym, presses it and restores it; the application must see the MappingNotify before
the key press, and 12 ms is often too short. So `--delay 40` is applied only to strings
containing non-ASCII characters. 26 Japanese characters then take about 1.0 s.

40 is a margin, not a threshold. The race depends on timing and load: the same string was
byte-identical at the default delay on a Xephyr display and lossy on Xvfb. An earlier claim
of "byte-identical" generalised from one run on one display and was wrong.

Related hazard: injecting `ctrl+t` into the nested X collides with ratpoison's prefix key.
The window manager entered its prefix state, the following text ran as window-manager
commands, and `ratpoison -c` hung until an Escape was injected.

## The lens font draws CJK; missing glyphs vanish

| Drawn | Not drawn |
| --- | --- |
| Hiragana, katakana, kanji (including JIS level 2 such as 鬱 齟 齬), `ー 、 。 「 」 ～ ？ ・`, full-width alphanumerics | Half-width kana (`ｱ` U+FF71), characters outside the BMP (`𠮷` U+20BB7) |

A missing glyph is not drawn as a box; it disappears, so the text is silently one character
shorter (confirmed by character count of the pushed payload). Nothing compensates for this:
recogniser output rarely contains such characters. Window titles are arbitrary and can.

Transcripts are therefore pushed as plain text (one `textContainerUpgrade`, no image push).

## The firmware wraps lines

| Content | Fitted on the first line | In units (wide = 2, narrow = 1) |
| --- | --- | --- |
| Pure CJK | 28 characters | 56 |
| Kana and digits mixed | 32 characters (23 wide + 9 narrow) | 55 |
| ASCII (`-` and digits) | 53 characters | 53 |

Overflow is not clipped; it flows to the next line, and all three rulers were fully readable.
The width model is "wide 2, narrow 1, 56 units per line". The ASCII figure was measured with
narrow glyphs; a line of `W` wraps sooner. The model is used only to estimate line counts,
and overestimating is the safe direction.

The 10-line panel height still applies: wrapped lines beyond it disappear at the bottom edge,
which would hide the rows under a long transcript. The transcript is limited to
10 − 1 header − 3 rows = 6 lines (about 168 wide characters).

## No scrolling, and list containers do not help

`TextContainerProperty` has no scroll, offset or overflow field. A list container was tried
on hardware (2026-10-17), on a page of 7 containers (1 list, 2 text, 4 image):

| Question | Answer |
| --- | --- |
| Is the page accepted? | Yes (`create => 0`) |
| Is the list drawn? | Yes, but only 7 rows (a text container shows 10 lines) |
| Does it scroll? | No; items after the 7th of 20 were unreachable |
| Does `List_ItemEvent` arrive? | No |
| Do the app's own gestures survive? | Yes; double tap and swipes worked as before |

The deciding fact: there is no incremental update for lists. `EvenAppMethod` offers only
`UpdateImageRawData` and `TextContainerUpgrade`; changing list items needs
`rebuildPageContainer`, which is not allowed outside page establishment. Lists are unusable
for changing content, so the client's own paging remains.

By-product: containers without a painted background do not occlude each other. A list at
z=7 and overlay text at z=6 were visible mixed together; z-order matters only against opaque
tiles.
