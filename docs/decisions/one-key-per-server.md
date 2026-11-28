# One device key per server

## Context

The phone kept a single key pair, generated when the pair button was tapped and replaced by
the next pairing. That was sound while the app knew one server. With a list of servers
([the app starts at the server list](root-is-the-server-list.md)) it is not: pairing with a
second server generated a new key and overwrote the first, so the first server stopped
accepting the phone.

## Decision

A key pair belongs to one server, and is stored under that server's origin
(`client@<origin>` in IndexedDB, `pw-auth.jwk@<origin>` in the bridge's durable store). It is
generated when the phone pairs with that server and discarded when the phone forgets the
server. A request, a session and the "is this device paired" answer all use the key of the
server currently addressed.

The single key that versions up to 0.1.4 kept is not carried over: its store was renamed with
the rest of the `ew` names, so a phone paired then pairs again.

## Alternatives considered

- Keep one key and enrol the same public key at every server: pairing must then stop
  generating a key, a server could recognise the phone it shares with another server, and
  forgetting a server could not discard anything.
- One key per list entry, by position or a generated id: the origin is already the identity of
  an entry, and it is what the signed session material names.

## Consequences

- Forgetting a server on the phone first asks that server to remove the key
  (`POST /api/auth/revoke-self`, signed with the key itself), then discards it. Opening that
  server again needs a new pairing. If the server does not answer, the phone discards nothing
  until the person confirms, because the key is the only thing on the phone that can withdraw
  the enrolment; confirmed, the enrolment stays until it is revoked on the host.
- Reading the phone's storage still yields every key, as before: they are kept in one place.
  The gain is that servers cannot correlate the phone, and that one server's pairing cannot
  disturb another's.
- `http` and `https` on one host are two servers and have two keys.
