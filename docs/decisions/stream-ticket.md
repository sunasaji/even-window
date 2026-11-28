# A separate short-lived ticket opens the stream

## Context

`EventSource` cannot set request headers, so the credential for `GET /api/stream` has to be
in the URL. A URL is the worst place for a credential: it lands in proxy access logs,
referrers, history and screenshots. Both the session token and any stream credential are
bearer credentials, so the only lever is how long they live.

## Decision

Two token kinds, with the kind inside the MAC:

- a session token (`s`), 1 hour, accepted only in `Authorization: Bearer`;
- a stream ticket (`t`), 60 seconds, accepted only as `?ticket=`, minted by the gated route
  `GET /api/auth/ticket` immediately before the stream is opened.

The gate requires the kind to match where the token arrived. A token without a kind is
refused.

## Alternatives considered

- **Put the session token in the URL.** The long-lived credential would be the one that
  leaks.
- **One token kind with two lifetimes.** Without the kind check a leaked session token would
  still work in a query string and a ticket as a Bearer, so the short lifetime would protect
  nothing.
- **Replace `EventSource` with `fetch` streaming** to send a header. Possible, but it gives up
  the built-in reconnect and parsing for no security gain over a 60-second ticket.
- **A 12-hour session.** The first version had one. Re-establishing costs two requests and
  one signature and is silent, and the WebView is rebuilt so often that most sessions never
  reach expiry; a long window on a credential that grants code execution has no upside.

## Consequences

- A ticket found in a log has expired before anyone reads it.
- `EventSource` reconnects by itself with the same URL, so a reconnect after 60 seconds gets
  a 401. The client must fetch a new ticket and reopen the stream (debounced by
  `STREAM_REOPEN_MS`); this is the only recovery path, not a fallback.
- With `PINHOLE_AUTH=0` the ticket route answers an empty ticket and the stream is open.
