# Pairing is approve-then-enrol, with randomart drawn by each side

## Context

Pairing is how a device with no identity acquires one, so it cannot require authentication.
Whoever gets a key enrolled gets code execution on the host. A one-time code can be
overlooked or photographed, and on an untrusted path the public key itself can be replaced in
flight.

## Decision

A valid code only stages a pending entry. A human on the host compares a randomart grid of
the staged key with the grid on the device and approves; only then is the key enrolled. Each
side computes the grid from the key material it holds, using one shared module
(`src/shared/randomart.ts`): the server from the key it staged, the device from its own
public key. The `art` in the pairing response is used by the device only as a cross-check.

## Alternatives considered

- **Enrol on a valid code.** Anyone who saw the code is enrolled.
- **Show the server-computed grid on the device.** An earlier version did. An in-path
  attacker substitutes its own key and echoes that key's grid, so both screens match and the
  operator approves the attacker. A grid proves something only when the verifier draws it
  from its own material, as OpenSSH's `VisualHostKey` does.
- **Reimplement randomart in `pw-auth.mjs`.** It prints the `art` stored in `pending.json`
  instead. The CLI and the server are the same host and user, not a trust boundary, and a
  further copy of the formula is a liability.
- **Auto-submit when the pairing link is opened.** The dialog is pre-filled but needs a tap,
  so opening a link does not consume the single-use window.

## Consequences

- First contact always needs an out-of-band human check; unattended runs cannot pair, which
  is why the simulator harness defaults to `PINHOLE_AUTH=0` in a confined set-up.
- The single-use window handles the attacker who has the code but is not in the path; the
  grid handles the one who is. Neither replaces the other.
- A grid mismatch on the device stops the flow with "do not approve".
- No route enrols or revokes. `scripts/pw-auth.mjs` on the host is the only enrolment UI.
