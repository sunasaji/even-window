import { defineConfig } from 'vite'

// The WebView app is served to the phone (or the simulator). The server half
// runs separately as a plain node process; see scripts/sim.sh.
export default defineConfig({
  server: {
    host: true,
    port: 5273,
    strictPort: true,
  },
  build: { target: 'es2022' },
})
