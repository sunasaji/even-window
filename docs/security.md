# Security

How even-window decides who may use the server, what that decision protects, and what it
leaves to the transport in front of it. Wire shapes of the routes named here are in
[protocol.md](protocol.md); set-up steps are in [getting-started.md](getting-started.md).
Background: [design reasoning](notes/2026-11-auth-design-reasoning.md),
[measured behaviour of the gate](notes/2026-11-auth-verification.md).

## What an attacker gains

Every route is effectively remote code execution as the user running the server.
`POST /api/spawn` executes a program, and `POST /api/desktop/input` with `kind: 'type'` types into
whatever has focus in the mirrored desktop, which is usually a shell. Being able to reach an
unauthenticated server is the same as having that user's account.

There is therefore one security boundary: **client authentication**, enforced before any
handler runs. Nothing behind the gate is a second line of defence (see
[The launcher list](#the-launcher-list-is-not-a-security-control)).

## Trust boundary

- The host account running the server is trusted for everything. It owns the state
  directory, the configuration and `scripts/ew-auth.mjs`; another process of the same user is
  not a boundary.
- An enrolled device has full use of every route, but cannot enrol or revoke: no route does
  either. A client that could revoke would let a stolen token lock the operator out; one
  that could enrol would make the cap and the randomart comparison meaningless.
- The transport in front of the server is trusted for confidentiality, integrity and proving
  the server to the device ([What authentication does not provide](#what-authentication-does-not-provide)).
- Anything else that can reach the port gets the four open routes, which are rate limited.

## Model

Public-key client authentication with a cheap session token, in the spirit of SSH public-key
authentication carried over HTTP. The server side is `src/server/auth.ts`.

A device is enrolled once (pairing), then signs a server challenge to obtain a session token,
then sends that token with every request. Asymmetric crypto runs only when a session is
established; per request the server does one constant-time HMAC comparison and a `stat` of
the registry and secret files. A server compromise leaks public keys and the token-signing secret, never a
device's private key.

### Device keys

- Generated with WebCrypto: Ed25519 when the WebView supports it, otherwise ECDSA P-256. The
  server accepts both and verifies whichever was enrolled.
- In a browser the private key is non-extractable and lives in IndexedDB, so script on the
  page can use it but not export it.
- Inside the packaged Even Hub app IndexedDB does not survive a restart, so the key is
  generated extractable and a JWK copy is mirrored into the SDK's bridge storage. This is a
  deliberate weakening limited to that environment.
  Background: [decisions/packaged-app-key-mirror.md](decisions/packaged-app-key-mirror.md).
- The client id is the SHA-256 (hex) of the public-key coordinates: `crv:x` for Ed25519,
  `crv:x:y` for P-256. The same key always has the same id.

The client id formula and the signed session material are implemented in three places that
must agree byte for byte: `src/server/auth.ts`, the client's auth module
(via `src/shared/sessionBinding.ts`) and `scripts/ew-auth.mjs`.

## Enrolment

`scripts/ew-auth.mjs`, run on the host, is the only enrolment interface. It edits the state
directory directly; `list`, `revoke` and `rotate` work whether or not the server is running.

1. The operator opens a pairing window (`ew-auth pair [appUrl]`, or `open` for scripts). A
   128-bit one-time code is generated; only its SHA-256 is stored (`pairing.json`). The code
   reaches the device in a URL (`?pair=<code>`), shown also as a QR code.
2. The device generates a key pair and posts the code and public key to
   `POST /api/auth/pair`. A valid submission is staged as pending (`pending.json`) and
   authorises nothing. The window is consumed by the first valid submission.
3. Both sides draw a randomart grid (`src/shared/randomart.ts`, OpenSSH's drunken bishop) of
   the key fingerprint, each from the key material it holds: the server from the key it
   staged, the device from its own public key.
4. The operator compares the grid in the terminal with the grid on the device and approves.
   Only then does the key enter `clients.json`. The device polls
   `GET /api/auth/pair/status` and continues without a reload.

A `pair` window lasts 2 minutes, an `open` window 5 minutes (or `EW_PAIR_TTL_MS`), and a
pending entry 10 minutes.

The single-use window stops someone who saw the code but is not in the network path: whoever
submits first consumes it, and the other side gets `pairing closed`. The randomart stops an
in-path attacker who substitutes its own public key, and only because the device draws its
own grid. The `id` and `art` in the pairing response are a cross-check: on a mismatch the
device shows "do not approve" instead of waiting.
Background: [decisions/pairing-randomart.md](decisions/pairing-randomart.md).

The pairing response also reports how many slots are used and allowed, so the device can say
that approval will be refused before anyone walks to the host.

### `ew-auth` commands

| Command | Effect |
| --- | --- |
| `list` | Enrolled keys: id, name, when and from where they were added |
| `pair [appUrl]` | Interactive: open a window, wait for a device, show its grid, ask y/N |
| `open [appUrl]` | Non-interactive: open a window and print `CODE=`, `URL=`, `EXP=` |
| `pending` | Staged devices and their grids |
| `approve <id>` / `reject <id>` | Enrol or refuse a staged device |
| `revoke <id>` | Remove an enrolled key; effective on the next request |
| `rotate` | Replace the token-signing secret; see [Secret rotation](#secret-rotation) |
| `add '<jwk>' [name]` | Enrol a public key directly |
| `add-test [name]`, `sign <nonce> [origin]` | A throwaway key for exercising the gate with `curl` ([development.md](development.md)) |

`ew-auth` reads the same env file as the server, so both see the same `EW_STATE_DIR` and
`EW_MAX_CLIENTS`.

## Sessions

1. `GET /api/auth/challenge` returns a random nonce, valid for 2 minutes and single use.
2. The device signs the session material (below) and posts
   `{clientId, nonce, sig, origin}` to `POST /api/auth/session`.
3. The server checks that the nonce is live, that the signature verifies against the enrolled
   key for `clientId`, and that the named origin is its own when `EW_ORIGIN` is set. It
   answers with a session token.

Every failure answers the same 401, so a caller cannot learn which part was wrong.

A token is `base64url({cid, exp, k}) . base64url(HMAC-SHA256(server-secret, payload))`. It
is stateless and a bearer credential: whoever holds one is that client until it expires.

| Token | Kind `k` | Carried in | Lifetime | Good for |
| --- | --- | --- | --- | --- |
| Session | `s` | `Authorization: Bearer` | 1 hour | Every gated route except the stream |
| Stream ticket | `t` | `?ticket=` on `GET /api/stream` | 60 seconds | Opening the stream |

The client renews its session 60 seconds before expiry, silently, with a fresh signature.

On every request the gate also checks that the token's client is still in the registry, so
`revoke` takes effect on the next request rather than when the token expires.
Background: [decisions/registry-stat-cache.md](decisions/registry-stat-cache.md).

### The stream ticket

`EventSource` cannot set request headers, so the stream's credential has to travel in the
URL, where it can end up in proxy logs, referrers and screenshots. The session token
therefore never goes there. The client asks `GET /api/auth/ticket` (a gated route) for a
separate ticket immediately before opening the stream. The ticket only has to survive the
handshake, because the connection itself is long-lived.

The kind is inside the MAC and the gate requires it to match where the token arrived: a
ticket is refused as a Bearer, and a session token is refused in a query string. Without that
rule the short lifetime would protect nothing.

`EventSource` reconnects on its own with the same URL, so a reconnect after 60 seconds gets a
401; the client then fetches a new ticket and reopens the stream.
Background: [decisions/stream-ticket.md](decisions/stream-ticket.md).

### Session binding to `EW_ORIGIN`

The device signs the destination along with the nonce. The signed bytes are four fields
joined by newlines (`src/shared/sessionBinding.ts`):

```
ew-session-v1
<clientId>
<origin the device believes it is talking to>
<nonce>
```

The origin is normalised with `URL.origin`. It also travels in the request body, but only as
transport: the server rebuilds the material from it, so changing it breaks the signature.

When `EW_ORIGIN` is set, the server refuses a signature that names any other origin. This
stops one attack: a paired device is tricked (through a `?server=` link) into talking to an
attacker's API base, and the attacker relays the device's signature to the real server.

| Rule | Reason |
| --- | --- |
| The comparison value comes from configuration, never from the request | A relaying attacker connects directly and chooses its own `Host` header. |
| `EW_ORIGIN` is a single value, separate from the CORS list `EW_ORIGINS` | Widening CORS must not widen authentication; `*` is treated as a misconfiguration, not as "any". |
| There is no acceptance path for a signature without the origin | A fallback would hand the relay back. |
| An origin mismatch does not consume the nonce | Nothing was proved about this server. |

Unset `EW_ORIGIN` means "verify the signature, skip the comparison". That is correct for
loopback development; for a server a phone reaches, set it to the URL the device dials. The
start-up banner reports the state on every start.

Binding does not stop an in-path attacker on the true origin, and does not protect the device
from a fake server. Both are the transport's job.
Background: [decisions/session-origin-binding.md](decisions/session-origin-binding.md).

The client adds a second guard: on a paired device, a `?server=` value that differs from the
stored one is adopted only after an explicit tap (`serverChangeNeedsConfirm` in
`src/client/`). Unpaired devices, and devices with no stored value, are not asked.

## The gate

`src/server/main.ts` keeps every route in one table and rejects unauthenticated requests
before the handler runs. Four routes are open, because they are how a device with no identity
acquires one:

- `GET /api/auth/challenge`
- `POST /api/auth/session`
- `POST /api/auth/pair`
- `GET /api/auth/pair/status`

`GET /api/health` is gated too: it describes the display session and capture process, and a
liveness probe does not need it. A 401 from this server already proves the listener and the
gate are alive, so probes should accept 200 or 401.

`OPTIONS` is answered with 204 before the gate; a preflight carries no credentials and
performs no action.

### Open-route rate limiting

The four open routes share a token-bucket limiter (`src/server/ratelimit.ts`): 3 requests per
second with a burst of 30 per source address, and 12 per second with a burst of 120 across
all sources. A refused request gets 429 with `retry-after`. The limit protects availability,
not credentials: the pairing code is 128 bits and a session needs an enrolled key's
signature, but `POST /api/auth/session` runs one asymmetric verification per call. Gated
routes are never limited. Details: [protocol.md](protocol.md#rate-limiting-of-open-routes);
background: [decisions/open-route-rate-limit.md](decisions/open-route-rate-limit.md).

### CORS

Tokens are Bearer headers, not cookies, so a foreign page has no ambient credential. The
policy still refuses foreign origins, which keeps drive-by pages away from the open routes
and from a server running with `EW_AUTH=0`. Allowed: requests with no `Origin`, loopback
origins, an origin on the same host the request was addressed to, and origins listed in
`EW_ORIGINS` (`*` restores a wildcard). CORS is a browser policy and not an authorisation
decision. Details: [protocol.md](protocol.md#cors).

## Enrolled clients

### Client cap (`EW_MAX_CLIENTS`)

Re-pairing a device does not replace its key; it adds one. The device generates a new key
pair, so the old entry stays authorised with nobody holding it, and a key that is never used
never looks anomalous. The server cannot tell "the same device again" from "a second device".

The cap, default 1, turns that into a refusal: a new key cannot be enrolled while the
registry is full, so the old key must be revoked first.

`EW_MAX_CLIENTS` accepts plain decimal digits; `0`, `unlimited`, `off` or `none` remove the
cap (the banner warns); anything else, including a typo, means 1.

- The cap applies to the enrolment paths (`approve`, `add`, `add-test`, and `pair` / `open`,
  which refuse to open a window when no slot is free). Re-adding an already enrolled key is
  always allowed.
- A refused `approve` leaves the pending entry in place; revoke the old key and approve again.
- The cap gates enrolment, not requests. Lowering it revokes nothing.
- If more keys are enrolled than the cap allows, the server refuses to start (exit 1, before
  the display session or the listener is touched). There is no override. Fix it with
  `ew-auth revoke`, or raise the cap to the number in use. With `EW_AUTH=0` the check is
  skipped.
- If the registry grows past the cap while the server is running, the server keeps running,
  logs a warning and notifies clients.

Background: [decisions/client-cap.md](decisions/client-cap.md).

### Enrolled-clients notification

The cap stops an accidental spare key. It cannot stop a deliberate approval, so the remaining
job is detection. The server polls the registry once a second and sends the enrolled set
(ids, names, when and from where added; never public keys) to every connected client on
connect and on change, as the `clients` stream event ([protocol.md](protocol.md)).

The phone UI compares the set with the one the user last acknowledged, which is persisted on
the device. A new key turns the connection summary red and opens it, including for keys added
while the device was away. The warning clears only on an explicit "mark as seen". Removed
keys are noted without an alarm. The device marks its own row from its own key, not from
anything the server says. See [phone-ui.md](phone-ui.md).

## State directory

`~/.even-window`, or `EW_STATE_DIR`. The directory is created `0700` and the files `0600`.

| File | Contents |
| --- | --- |
| `clients.json` | Enrolled public keys, names, `addedAt`, `addedIp` |
| `server-secret` | The 32-byte token-signing key; created on first use |
| `pairing.json` | Hash and expiry of the open pairing window |
| `pending.json` | Staged devices awaiting approval |

The registry holds no secrets, but which keys are trusted, since when and from where is
useful to an attacker, so it is kept from other local accounts. Modes apply only at creation;
if an existing directory is group- or world-accessible the banner says so and suggests
`chmod 700`. The server does not change modes itself.

The env file (`~/.even-window/env`) is ignored if others can write to it, since it could set
`EW_AUTH=0` ([configuration.md](configuration.md)).

## Secret rotation

`ew-auth rotate` (or deleting `server-secret`) invalidates every live session and ticket at
once. Enrolments are untouched: each device re-establishes with its own key on its next
request. No restart is needed; the secret, like the registry, is re-read when its file
changes.

Rotate when a copy of the state directory may have leaked (a backup, a disk image, a restore
on another host), because the secret allows forging a token for any enrolled client, or after
the server was reachable in plaintext or without authentication. To remove a lost device use
`revoke`, not `rotate`. A `?ticket=` URL in a log needs no action; it expired within 60
seconds.

There is no scheduled rotation. The secret signs tokens whose exposure is already bounded by
their one-hour lifetime; it does not protect the transport.

## What authentication does not provide

The server speaks plain HTTP and terminates no TLS. The gate proves which client is calling;
it does not protect the channel.

| Property | Provided here |
| --- | --- |
| Client authentication | Yes |
| Destination binding of the session signature | Yes, when `EW_ORIGIN` is set |
| Confidentiality and integrity of traffic | No. A session token read off the wire can be replayed from anywhere until it expires. |
| Authentication of the server to the device | No. An in-path attacker can impersonate the host. |
| Binding of the signature to the channel | No. A web page cannot reach TLS keying material. |

Put a TLS-terminating proxy with a real certificate in front and keep the server on
loopback. `tailscale serve` is the tested arrangement
([getting-started.md](getting-started.md)); any reverse proxy with a publicly trusted
certificate serves the same role. Do not terminate a self-signed certificate.
Background: [decisions/no-tls-termination.md](decisions/no-tls-termination.md).

That arrangement rests on assumptions the code cannot check:

- The device's trust store is clean. An injected root CA breaks TLS, and with it both
  server authentication and relay protection.
- Devices that can reach the proxy are trusted. A tailnet authenticates the network, not the
  client: every device on it reaches the gate. Restrict access with ACLs.
- The proxy is not public (`tailscale funnel` is not in use).
- The server was started with the intended configuration. An unset `EW_ORIGIN` leaves
  binding off; check the banner.

## Bind address and start-up banner

The server binds `127.0.0.1` unless `EW_HOST` says otherwise. Loopback is the default even
with authentication on, so that a run with `EW_AUTH=0` is never one setting away from
publishing a shell.

The banner states the security posture on every start:

| Line | When |
| --- | --- |
| `auth ENFORCED … state <dir>` | Authentication is on |
| `N client key(s) enrolled [of M] — <dir>` | Always with auth on. Zero keys is a warning: nothing can authenticate, or `EW_STATE_DIR` points at the wrong registry |
| `session binding ENFORCED` / `NOT enforced` | Always with auth on; a value that is not an absolute URL is quoted and reported as not enforced |
| `client limit: N keys` / `UNCAPPED` warning | The cap is not 1 |
| `state dir … is mode 0NNN` | The state directory is accessible to other accounts |
| `bound to <host> over PLAIN HTTP` | Auth on and a non-loopback bind: the configuration that looks finished and is not |
| `EW_AUTH is OFF — every route is UNAUTHENTICATED` | Auth off; stronger wording when the bind is not loopback |
| `REFUSING TO START` | More keys enrolled than the cap |

## The launcher list is not a security control

`POST /api/spawn` launches only entries of the scanned application list, by id. That keeps
command lines off the wire. It does not constrain a holder of a valid token: the list can
contain shells and general launchers such as `env`, and the same token can type any command
into a shell through `/api/desktop/input`. Do not count it when deciding on a bind address, exposure or whether to
disable authentication.

## Disabling authentication (`EW_AUTH=0`)

Authentication is enforced unless `EW_AUTH` is `0`, `off`, `false` or `no`. With it off,
every route is open, the registry is never consulted and the banner warns on every start.

`scripts/dev.sh` keeps authentication on (`--no-auth` disables it): an interactive loop pairs
once per browser profile. `scripts/sim.sh` defaults to `EW_AUTH=0` (`--auth` enables it): a
headless run starts a fresh WebView each time and has no human to approve a pairing.

A harness run is confined so that an unauthenticated server cannot touch real credentials:
it uses its own state directory (`.ew-x11/state`), reads no env file and binds loopback. Both
the script and the server announce that authentication is off. See
[development.md](development.md).

## Reporting a vulnerability

Please report security issues privately through GitHub's private vulnerability reporting
("Report a vulnerability" under the repository's Security tab) rather than in a public
issue. Include the version or commit, the configuration (bind address, proxy, `EW_AUTH`,
`EW_ORIGIN`) and steps to reproduce.
