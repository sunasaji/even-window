# The app starts at the server list

## Context

The app opened its one stored server by itself, so its top screen was the mirror, and a
double-tap there opened the menu. Even Hub's submission rules require a double-tap at the top
of an app to reach the system exit dialog, and an app that opened its own menu there was
rejected. The app's own rule, that a tap chooses and a double-tap opens the menu or goes back,
is worth keeping inside a server, where all the work happens.

Nothing in the design needs the server to be single: a server is an address, and the device key
can be enrolled at any number of them.

## Decision

The top of the app is the list of servers this device knows. Nothing is mirrored and no request
is sent until one is opened, even when the list has one entry.

| Where | Tap | Double-tap |
| --- | --- | --- |
| Server list | Opens the server under the cursor | Leaves the app (`shutDownPageContainer(1)`, the system dialog) |
| Inside a server | As before | As before: opens the menu, goes up a level, closes it |

The menu's `Exit...` and its confirmation level are replaced by `Disconnect`, which returns to
the list. The app has no exit row of its own: the list's double-tap and the system menu's Close
row are the two ways out.

A URL that names a server (`?server=`) or carries a pairing code (`?pair=`) opens that server
directly. The simulator harness and a pairing link rely on it; the packaged app has no query
and always starts at the list.

Every address somebody chose (typed, pasted in a pairing URL, recovered from the durable store)
is added to the list. The list has no limit, since nothing about a server makes nine a natural
number and other kinds of target may join it. The lens shows nine rows under its header and
pages a longer list by the cursor: swiping past the last row of a page turns it, and the
header shows the page (`2/3`). On the phone the rows scroll inside the card.

## Alternatives considered

- Keep opening the stored server and make the mirror's double-tap exit: the menu would lose its
  only gesture.
- Keep opening the stored server and move the menu into the system context menu
  (tap-then-long-press): that menu is one flat level of one-shot items, and its opening cannot
  be told from a notification ([measured](../notes/2026-11-context-menu-on-hardware.md)).
- Start at the list only when there are two or more servers: the top of the app would then be a
  different screen depending on the count, and so would the meaning of a double-tap.

## Consequences

- Every start costs one more tap. The cursor starts on the server used last.
- Each server has its own device key ([decision](one-key-per-server.md)). Forgetting a server
  on the phone removes the row and its key, and asks that server to drop the enrolment.
- The gesture hint of the first launches waits for the first server to be opened, since the
  gestures it lists mean nothing at the list.
- While the list is up the client sends nothing: `authFetch` refuses everything except the
  pairing routes, which is how the first server gets into the list.
- Opening a second server repaints from the tiles the first one left until the new ones arrive.
