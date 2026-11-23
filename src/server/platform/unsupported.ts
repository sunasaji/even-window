// The backend for an operating system that has no backend: the server still starts and
// serves, and every subscriber is told why there is nothing to mirror.

import type { Platform } from './types.ts'

export function unsupportedPlatform(id: string): Platform {
  return {
    id,
    session: {
      start: async sink => {
        sink.avail({ ok: false, msg: `unsupported platform: ${id}` })
      },
      stopCapture: () => {},
      info: () => ({ display: '', backend: 'none', pid: null, fps: 0 }),
    },
    windows: {
      enumerate: async () => [],
      identify: async () => ({ pid: 0, comm: '', exe: '' }),
      focusedId: async () => '',
      select: async () => false,
      close: async () => false,
      spawn: () => 0,
    },
    input: {
      inject: async () => false,
      repeatKey: async () => false,
      wheel: async () => false,
      wmKey: async () => false,
    },
    processes: { parentPid: () => 0 },
    apps: {
      list: async () => ({
        apps: [],
        counts: { total: 0 },
        summary: 'no launcher on this platform',
        skipped: [],
        errors: [],
      }),
      byId: async () => null,
      launchArgv: () => [],
      overridesPath: () => '',
      seedCommand: () => '',
    },
  }
}
