# The CORS default follows authentication

## Context

The packaged app (the `.ehpk` installed through Even Hub) is served by the Even App, not by
the server, so every API call from it is cross-origin. Which origin the Even App gives a
package is not documented, and it may differ between the beta channel and the store, or be
shared by every app on the platform.

The server used to refuse foreign origins unless `PINHOLE_ORIGINS` listed them. Every user of the
packaged app would have had to find that origin and configure it, or set `PINHOLE_ORIGINS=*`.

What a narrow CORS policy protects depends on the gate:

- With authentication enforced, tokens are Bearer headers and device keys are origin-scoped.
  A foreign page holds neither, so it gets the four open routes and nothing else. Those need
  a 128-bit pairing code or an enrolled key's signature, and are rate limited.
- With `PINHOLE_AUTH=0`, a refused preflight is the only thing that stops a web page the operator
  happens to open from sending `POST /api/spawn`.

## Decision

`corsOrigin()` takes its default from `PINHOLE_AUTH` when `PINHOLE_ORIGINS` is unset or empty:

| `PINHOLE_AUTH` | `PINHOLE_ORIGINS` unset | `PINHOLE_ORIGINS` set |
| --- | --- | --- |
| enforced (default) | any origin (`*`) | loopback, same host, and the listed origins |
| `0` | loopback and same host | loopback, same host, and the listed origins |

`PINHOLE_ORIGINS=*` remains an explicit wildcard in both rows.

## Alternatives considered

- **Keep the narrow default and document `PINHOLE_ORIGINS=*` for the packaged app.** Every user
  of the published app would set it, so the default would only add a step and a failure that
  shows on the glasses as "cannot reach the server".
- **Build the packaged app's origin into the allowlist.** It is not known, may change with an
  Even App update, and if it is shared by all Even Hub apps or is `null`, listing it is close
  to a wildcard anyway.
- **A wildcard regardless of `PINHOLE_AUTH`.** That would remove the only protection an
  unauthenticated server has against a drive-by page.

## Consequences

- The packaged app needs no CORS configuration against a default server.
- Under auth, any web page can reach the open routes and read their answers. This is the
  same exposure as any non-browser client that can reach the port already has.
- An operator narrows CORS by setting `PINHOLE_ORIGINS` to a list; any value other than `*`
  replaces the wildcard default.
- Turning `PINHOLE_AUTH` off also narrows CORS, so a packaged app stops working against that
  server unless `PINHOLE_ORIGINS` names its origin.
- CORS is not an authorisation control in either mode. The security boundary is the gate.
