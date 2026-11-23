# Establish once, never rebuild a live page

## Context

`createStartUpPageContainer` may be called once per glasses-UI lifetime, and on a reloaded page
it can answer success without making the new containers live; tile pushes then report success
and paint nothing. Only `rebuildPageContainer` makes containers live. Rebuilding a page that is
streaming blacks out the display.

## Decision

Establishing is `create` followed unconditionally by one `rebuild`; the page counts as
established if either succeeded. After that the page is only ever updated by image and text
pushes. The rebuild call has one call site. Its only other caller is the retry for a page that
never established, which repeats the rebuild alone with a backoff (5 s doubling to 60 s, or to
15 s while the link is down) and stops on the first success.

## Alternatives considered

- Create only: black or stale display after a reload.
- Rebuild to recover from link loss, to change the menu, or to clear the tiles: each is a
  rebuild during streaming. Recovery resets the diff baseline and repaints instead.
- Retrying create: the call is spent for this glasses-UI lifetime.
- Calling `shutDownPageContainer` to start over: it ends the app.
- Streaming without a page: every push waits out its timeout ladder (about 34 s a tile).

## Consequences

- The page layout is fixed for the lifetime of the page; nothing adaptive is possible.
- No tile is pushed until a page exists.
- If the Even App has lost its device record, no retry succeeds and the user must restart the app
  from the phone; the phone UI says so.
- Whether a page whose create was refused can come up by rebuild alone after the link returns
  has not been observed on hardware.

Background: [link loss, establish and recovery](../notes/2026-10-glasses-link-and-establish.md).
