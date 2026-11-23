// The one place that chooses a backend. Everything OS-neutral imports `platform` from here and
// nothing else under `platform/`, bar the types.
//
// The backend is loaded with a dynamic import: the X11 modules do work at import time (create
// the runtime directory, resolve the host display), and none of that may run on an operating
// system that gets a different backend.

import type { Platform } from './types.ts'
import { unsupportedPlatform } from './unsupported.ts'

/** Which backend an operating system gets (docs/platform.md):
 *    linux  — the X11 backend, the one that is developed and tested;
 *    win32  — none: X11 is not a native display there;
 *    others — the X11 backend, untested. macOS and the BSDs can run an X server, so it is
 *             tried instead of refused. */
export function backendFor(os: string): 'x11' | 'x11-untested' | 'none' {
  if (os === 'linux') return 'x11'
  if (os === 'win32') return 'none'
  return 'x11-untested'
}

const choice = backendFor(process.platform)

if (choice === 'x11-untested') {
  console.warn(
    `[ew] ${process.platform} is untested: trying the X11 backend. It needs an X server ` +
      '(Xvfb or Xephyr), ratpoison, xdotool and ffmpeg. Per-application bindings need /proc, ' +
      'and the package scan needs dpkg; without them those two are simply empty.',
  )
}

export const platform: Platform =
  choice === 'none'
    ? unsupportedPlatform(process.platform)
    : (await import('./x11/index.ts')).x11Platform
