// The X11 backend: a nested X server (Xephyr/Xvfb) with ratpoison on it, driven with
// xdotool/xprop and captured with ffmpeg x11grab. Process identity comes from /proc and part
// of the application list from dpkg; both are used when present and yield nothing otherwise,
// so the backend also runs, reduced, on a Unix that lacks them.

import type { Platform } from '../types.ts'
import { appById, appList, launchArgv, overridesPath, seedCommand } from './apps.ts'
import { x11Input, x11InputRepeat, x11RatpoisonKey, x11Wheel } from './input.ts'
import { parentPid } from './proc.ts'
import { startX11, stopCapture, x11Info } from './session.ts'
import {
  enumerate,
  focusedId,
  identify,
  x11CloseWindow,
  x11SelectWindow,
  x11Spawn,
} from './windows.ts'

export const x11Platform: Platform = {
  id: 'x11',
  session: {
    start: startX11,
    stopCapture,
    info: x11Info,
  },
  windows: {
    enumerate,
    identify,
    focusedId,
    select: x11SelectWindow,
    close: x11CloseWindow,
    spawn: x11Spawn,
  },
  input: {
    inject: x11Input,
    repeatKey: x11InputRepeat,
    wheel: x11Wheel,
    wmKey: x11RatpoisonKey,
  },
  processes: { parentPid },
  apps: {
    list: appList,
    byId: appById,
    launchArgv,
    overridesPath,
    seedCommand,
  },
}
