# The Even Hub SDK is not pre-bundled by Vite

## Context

The client runs in a WebView inside the Even App, which offers no hard reload. Vite serves
pre-bundled dependencies at `?v=<hash>` with `cache-control: max-age=31536000, immutable`. An
SDK upgrade did not change that hash, so the WebView kept running the old SDK bundle
underneath updated application code, and the glasses page failed to establish with an error
that pointed nowhere near the cause.

## Decision

`vite.config.ts` lists `@evenrealities/even_hub_sdk` in `optimizeDeps.exclude`. The SDK is
served as an ordinary source module that is revalidated like application code. The dev server
also sends `cache-control: no-store` on every response.

Dependencies that are reached only through a dynamic `import()` go in
`optimizeDeps.include` (currently `qrcode-generator`), so they are bundled at start-up rather
than discovered mid-session.

## Alternatives considered

- `vite --force` after upgrades: did not change the URL the cache keys on.
- Clearing the WebView's site data on the phone: manual, easy to forget, and the failure it
  prevents does not announce itself.
- Excluding every dependency: unnecessary; only the SDK changes underneath a client that
  cannot be refreshed, and the QR encoder needs the opposite treatment.

## Consequences

- Slightly slower cold start in development.
- No class of bug where the application is current and one dependency is stale.
- Production builds are unaffected; these are dev-server settings.

Background: [notes/2026-10-simulator-harness-traps.md](../notes/2026-10-simulator-harness-traps.md).
