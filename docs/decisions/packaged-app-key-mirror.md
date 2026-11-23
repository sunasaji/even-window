# The packaged app mirrors an extractable private key

## Context

A device's identity is a WebCrypto key pair. In a browser the private key is generated
non-extractable and stored in IndexedDB, so script on the page can use it but cannot export
it. In the packaged Even Hub app, IndexedDB survives the session but not a full restart of
the app. A key kept only there is lost on reopen and the device silently un-pairs. The SDK's
bridge storage (`getLocalStorage` / `setLocalStorage`) is the only key-value store that
survives a restart there.

## Decision

When a durable store is wired up (the client is running inside the app), the key pair is
generated extractable and its JWK is mirrored into the bridge storage. On start, if IndexedDB
is empty, the key pair is rebuilt from the mirror, re-imported non-extractable, and written
back to IndexedDB. In a plain browser no JWK is ever written.

## Alternatives considered

- **Keep the key non-extractable everywhere.** Pairing would not survive an app restart, and
  each restart would need a new human approval on the host, and a revoke of the previous key
  under the default client cap.
- **Derive the key from a stored seed.** That stores the same secret in the same place under
  another name.

## Consequences

- Inside the packaged app the private key exists in exportable form in the host app's
  storage. Anything that can read that storage, or a device backup containing it, can copy
  the identity. This is a scoped weakening accepted for that environment only.
- A copied key is a reason to `revoke` on the host; the client cap and the enrolled-clients
  notification do not detect use of a copied key.
- The client opens the stream before the bridge is ready, so wiring the durable store
  invalidates a cached "no identity" result; otherwise the mirror would never be consulted.
- There is no unpair control in the client. Discarding the key on the device does not remove
  the enrolment; `ew-auth revoke` does.
