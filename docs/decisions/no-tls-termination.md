# The server does not terminate TLS

## Context

The server is reached by a phone over a network, and every route is remote code execution.
The authentication gate proves which client is calling. It does not encrypt the channel or
prove the server to the device: a session token read off the wire is replayable until it
expires, and an in-path attacker can impersonate the host. Something has to provide TLS.

## Decision

The process speaks plain `node:http` only and binds loopback by default. TLS is delegated to
a proxy in front that holds a real certificate for a real hostname; `tailscale serve` is the
tested arrangement. When authentication is on and the bind is not loopback, the start-up
banner warns on every start.

## Alternatives considered

- **Terminate a self-signed certificate in the server.** The packaged WebView does not trust
  it, offers no click-through and no pinning UI. Making it work means hand-rolling
  trust-on-first-use, which is a second trust system to get wrong.
- **Bind the signature to the TLS channel** (as SSH binds its signature to the key exchange).
  A web page cannot reach TLS keying material: there is no `tls-exporter` on the web, and
  HTTP public key pinning was removed from browsers. It would require a custom authenticated
  key exchange.
- **Rely on authentication alone on a LAN bind.** This is the configuration that looks
  finished and is not, which is why it is the one the banner warns about.

## Consequences

- A proxy is a required part of any deployment a phone reaches, not a convenience.
- Confidentiality, integrity and server authentication rest on assumptions the code cannot
  check: a clean device trust store, a proxy that is not public, and trusted devices on the
  tailnet. They are listed in [security.md](../security.md#what-authentication-does-not-provide).
- A tailnet authenticates the network, not the client, so the gate stays on behind it.
- The auth-off banner is separate and louder; transport advice is not added to it so that the
  bigger problem is not buried.
