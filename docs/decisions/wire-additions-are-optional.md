# Wire additions are optional fields and ignorable events

## Context

The client is served from the working tree by the development server, while the API server is
a long-running process. A phone reload picks up a new client without a server restart, so a
client that is newer than its server is the normal state during development.

A field added to the `windows` event and read as always present once made the client throw
inside the handler that opens the window list. Swipes still worked, so the fault looked like a
gesture problem.

## Decision

The protocol grows only in ways an older peer survives.

- A field added to an existing shape is declared optional in `src/shared/types.ts`
  (`recent?: string[]`), so the compiler demands the absent case at every use.
- A new event type must be safe to never receive. The client treats "never received" as
  "unknown", not as "empty": a server that predates the `clients` event has not said that no
  keys are enrolled.
- A new request parameter is optional, and a peer that omits it is left alone (`inst`: a stream
  without it neither supersedes nor is superseded).
- Unknown event types are ignored by the client.

## Alternatives considered

- **Declare the new field required.** This is what failed: an older server omits it and the
  reader throws.
- **Runtime checks only.** They are forgotten; the optional type is enforced by the compiler.

## Consequences

- Readers carry a fallback path for each optional field, and the fallback is the older
  behaviour (server order instead of recency order, for example).
- Removing or renaming a field is a breaking change and needs both sides updated together.
