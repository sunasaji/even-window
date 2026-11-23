# Instance supersede

## Context

When the host app crashes, its WebView can keep running. A newly started page then shares the
bridge and the glasses with the old one, which keeps its event stream and keeps calling the
bridge. Pages cannot see each other: there is no shared worker or lock.

## Decision

Each page load mints a random instance id and sends it on the event stream URL. The server,
which already fans out to every client, decides per authenticated client that the newest
instance owns the glasses and sends the older one `{t:'supersede'}`. The superseded page stands
down by itself: it closes its stream, stops the pump, pushes, establish retries and microphone,
and shows a curtain whose button reloads the page. The server remembers deposed ids and tells
them again if they reconnect. A disconnect does not release ownership.

## Alternatives considered

- Plain "last connection wins": the deposed page's `EventSource` reconnects and takes the glasses
  back, forever.
- Killing the old page from the server: a page that stands down itself can explain why on its own
  screen and offer a way back.
- `shutDownPageContainer` on the old page: it ends the app the new page runs in.
- Arbitration in the page: impossible without a shared channel.

## Consequences

- The instance id is not a credential.
- Two tabs of one paired phone compete; two separately paired phones do not. Clients that send no
  id are left alone.
- Supersede stops the contention; it cannot move live containers from one page to another.
- In the crash case nobody sees the curtain, so the server log is where the hand-over is
  verified.

Background: [link loss, establish and recovery](../notes/2026-10-glasses-link-and-establish.md).
