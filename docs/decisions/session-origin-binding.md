# The session signature names its destination

## Context

`?server=` sets the client's API base, and the client proves its identity to whatever base it
is given. If a device signs only a nonce, the signature says nothing about who asked for it.
An attacker can then send a paired device a link to the real app with `?server=` pointing at
the attacker, fetch a challenge from the real server, pass that nonce to the device, and
redeem the device's signature at the real server. The packaged WebView has no address bar to
inspect.

## Decision

The device signs `pw-session-v1`, its client id, the origin it believes it is talking to, and
the nonce (`src/shared/sessionBinding.ts`). The server refuses a signature whose origin is
not the configured `PINHOLE_ORIGIN`. Three rules keep the check real:

1. The comparison value is configured, never derived from the request (`Host` is chosen by
   the caller, and behind a proxy it is the loopback address anyway).
2. `PINHOLE_ORIGIN` is its own single-valued setting, not the CORS list `PINHOLE_ORIGINS`.
3. There is no fallback for signatures without an origin.

## Alternatives considered

- **Derive the server's origin from `Host`.** A relaying attacker connects directly and names
  any host, so the check would compare the attacker's value with itself.
- **Reuse `PINHOLE_ORIGINS`.** It is multi-valued and accepts `*`; widening CORS would silently
  widen or disable the binding.
- **Accept old bare-nonce signatures for compatibility.** That returns the relay to anyone
  who can obtain one such signature. An old client gets a 401 and re-pairs.
- **Only a confirmation prompt on `?server=` changes.** Kept as a second guard
  (`serverChangeNeedsConfirm`), but a prompt alone depends on the user reading it.

## Consequences

- The check runs on the side with something to lose, using material the other side did not
  supply. An attacker who skips the check on its own endpoint gains nothing.
- It does not stop an in-path attacker on the true origin, and does not protect the device
  from a fake server. Those need TLS ([no-tls-termination.md](no-tls-termination.md)).
- Unset `PINHOLE_ORIGIN` is legitimate for loopback development and means "skip the comparison".
  The banner reports it on every start; with the recommended proxy set-up it is the only
  line that can.
