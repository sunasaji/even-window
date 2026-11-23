import { defineConfig } from 'vitest/config'

// The WebView app is served to the phone or the simulator. The server half runs separately
// as a plain node process (scripts/dev.sh, scripts/sim.sh).

// Vite refuses requests whose Host header it does not recognise, which protects the dev
// server against DNS rebinding, so the check is narrowed and not switched off. `.ts.net`
// covers any Tailscale MagicDNS name (what `tailscale serve` puts in front);
// EW_ALLOWED_HOSTS (comma-separated) adds more.
const extraHosts = (process.env.EW_ALLOWED_HOSTS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

export default defineConfig({
  server: {
    host: true,
    port: 5273,
    strictPort: true,
    allowedHosts: ['.ts.net', ...extraHosts],
    // Behind a TLS proxy the browser reaches the page on the proxy's port, not on 5273, so
    // the HMR client must be told where to dial back; otherwise hot reload fails silently.
    hmr: process.env.EW_HMR_HOST
      ? {
          protocol: 'wss',
          host: process.env.EW_HMR_HOST,
          clientPort: Number(process.env.EW_HMR_PORT) || 443,
        }
      : undefined,
    // The WebView inside the Even App cannot be hard-reloaded, so nothing served to it may
    // be cacheable.
    headers: { 'cache-control': 'no-store' },
  },
  // The SDK is not pre-bundled: optimised deps are served as immutable under a hash that an
  // SDK upgrade does not change, so the WebView would keep running a stale SDK. As a source
  // module it is revalidated like the app code. See docs/decisions/sdk-not-prebundled.md.
  optimizeDeps: {
    exclude: ['@evenrealities/even_hub_sdk'],
    // The QR encoder is reached only through a dynamic import, which the dep scan does not
    // see. Without `include`, the first pairing dialog makes the dev server re-optimise
    // mid-session, which can wedge it.
    include: ['qrcode-generator'],
  },
  build: { target: 'es2022' },
  // src/server/env.boot.ts applies the operator's env file as an import side effect;
  // tests/setup.ts switches that off so the suite does not depend on a file outside the repo.
  test: { setupFiles: ['tests/setup.ts'] },
})
