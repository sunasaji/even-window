// /proc readers: what the kernel says about a pid (the X11 backend's `ProcessInspector`, and the
// identity half of `WindowControl.identify`).

import { readFileSync, readlinkSync } from 'node:fs'

/** PID → executable name, lowercased with a trailing "-bin" stripped (firefox-bin → firefox).
 *  '' when the process is gone or not ours to read. */
export function commOfPid(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase().replace(/-bin$/, '')
  } catch {
    return '' // process gone, or not ours to read
  }
}

/** PID → absolute path of the running binary. '' when the symlink is not readable (another
 *  user's process) or the process is gone. A binary replaced while running reads back as
 *  "<path> (deleted)"; the marker is stripped, because the identity is the path. */
export function exeOfPid(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  try {
    const p = readlinkSync(`/proc/${pid}/exe`)
    return p.endsWith(' (deleted)') ? p.slice(0, -' (deleted)'.length) : p
  } catch {
    return ''
  }
}

/** PID → parent pid, from `/proc/<pid>/stat`. 0 when the process is gone or unreadable. */
export function parentPid(pid: number): number {
  try {
    // Field 4 of /proc/<pid>/stat is ppid, but field 2 (comm) may contain spaces and
    // parentheses, so the fields are counted from after the last ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const tail = stat
      .slice(stat.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/)
    const ppid = Number(tail[1])
    return Number.isInteger(ppid) ? ppid : 0
  } catch {
    return 0 // process gone mid-walk
  }
}
