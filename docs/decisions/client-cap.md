# Enrolled keys are capped, and an over-cap registry refuses to start

## Context

A device that pairs again generates a new key pair. Enrolment is idempotent on the
fingerprint, so the new key is added and the old one stays authorised with nobody holding it.
The server cannot tell a re-paired device from a second device. A spare key grants code
execution, is never used and therefore never looks anomalous; if it leaks from an old backup
or a lost device, the leak is silent and permanent.

## Decision

- `PINHOLE_MAX_CLIENTS` defaults to 1. Enrolling a new fingerprint into a full registry is
  refused, on every enrolment path, before anything is written. The operator must revoke
  first.
- If the registry holds more keys than the cap at start-up, the server exits before touching
  the display session or the listener. There is no override.
- If the registry grows past the cap while running, the server keeps running, warns in its
  log and notifies every client (`clients` stream event).

## Alternatives considered

- **A reminder after approving.** A message is not a control; it fails silently.
- **Warn instead of refusing to start.** Lowering the cap has one intent, to narrow the gate,
  and the cap gates enrolment, not requests. A warning leaves a gate that is believed narrow
  and is wide, for as long as nobody reads the log. The over-cap state is also exactly what a
  hand-edited or tampered registry looks like.
- **An opt-out variable (`PINHOLE_ALLOW_OVER_CAP`).** Added and removed. Its only safeguard was a
  log line, which the argument above says cannot be relied on, and both honest intents
  already have an expression: revoke the extra key, or set the cap to the number in use.
- **Exit when the cap is exceeded at run time.** Anyone who can write the state directory
  could then switch the server off by adding a key.

## Consequences

- Refusing to start is recoverable without a server: `pw-auth revoke` edits the registry
  directly.
- The cap is silent at 1 and announces itself when relaxed. Unparseable values mean 1, and
  only plain decimal digits are accepted, so the value in the environment is the value in
  force.
- The cap is not a filesystem policy; an operator can still edit `clients.json` by hand.
- Deliberate approvals are not prevented, only made visible by the notification.
