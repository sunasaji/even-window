// What a device signs to establish a session.
//
// The signed material names the origin the device believes it is talking to, and the server
// refuses a signature that names anything but itself. That stops a relay that deceived the
// device about its destination (a phished `?server=`). It does not stop an in-path attacker
// on the true origin, which is TLS's job, and it does not protect the device from a fake
// server (src/client/serverGuard.ts). See docs/security.md and
// docs/decisions/session-origin-binding.md.
//
// The material must match byte for byte here (imported by src/server/auth.ts and
// src/client/authClient.ts) and in the re-implementation in scripts/pw-auth.mjs.

/** Version tag of the signed material; it is the first signed field. No unversioned
 *  bare-nonce signature is accepted alongside it, since that would reopen the relay. */
export const SESSION_BINDING_V1 = 'pw-session-v1'

/** Canonical origin of a URL: scheme, host and non-default port. `''` when the input is empty
 *  or not a usable absolute URL (including the CORS wildcard `*`). `URL.origin` canonicalises
 *  identically in node and in the browser, which the two sides rely on. */
export function normaliseOrigin(raw: string | undefined | null): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  try {
    const o = new URL(s).origin
    // Opaque origins (`file:`, non-special schemes) stringify to "null": not an identity.
    return o && o !== 'null' ? o : ''
  } catch {
    return ''
  }
}

/** The exact bytes a client signs and the server verifies to redeem a challenge.
 *  Newline-joined: hex, a URL origin and base64url cannot contain a newline, so the encoding
 *  is unambiguous. `origin` is the origin the client believes it is talking to; the copy in
 *  the request body is transport only, and the server rebuilds this string from it. */
export function sessionMaterial(clientId: string, origin: string, nonce: string): string {
  return [SESSION_BINDING_V1, clientId, normaliseOrigin(origin), nonce].join('\n')
}
