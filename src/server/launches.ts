// pinhole-window — which launcher entry a window came from (the `app:` identity, docs/glasses.md;
// docs/decisions/window-identity-without-stamping.md).
//
// `LauncherEntry.id` is the only identity that separates two launcher entries running the same
// binary with different arguments. A window carries no trace of its launcher, but the server
// started the process: it remembers what it launched and claims the window that turns up,
// 1. by pid ancestry (exact): the window's process descends from a pid we launched;
// 2. by timing (heuristic): a window that exposes no pid goes to the most recent unclaimed
//    launch within `CLAIM_MS`.
// The map is wid-keyed and deliberately not persisted: a recycled wid must not inherit a
// dead claim. Unclaimed windows fall back to the `exe:` / `comm:` identities.

import { platform } from './platform/index.ts'

/** How long after a launch a new window may still be attributed to it by timing. Generous
 *  because a missed claim fails silently; bounded so a stale launch cannot claim an unrelated
 *  window. */
export const CLAIM_MS = 15_000

/** How many launches may be waiting for a window at once; bounds a pathological caller. */
const PENDING_MAX = 8

interface Launch {
  appId: string
  /** The pid we spawned. 0 if the spawn reported none. */
  pid: number
  at: number
  /** Set once this launch has been matched to a window, so one launch claims one window. */
  claimed: boolean
}

let pending: Launch[] = []
const appIdByWid = new Map<string, string>()

/** Record that we just launched `appId` as process `pid`. Called from the spawn route. */
export function noteLaunchPid(appId: string, pid: number, now = Date.now()): void {
  if (!appId) return
  pending = [
    ...pending.filter(l => now - l.at < CLAIM_MS),
    { appId, pid, at: now, claimed: false },
  ].slice(-PENDING_MAX)
}

/** The pid and its ancestors, walked through `platform.processes.parentPid`. Bounded by `max`
 *  so a corrupt ppid chain cannot spin. */
function ancestry(pid: number, max = 12): number[] {
  const out: number[] = []
  let cur = pid
  for (let i = 0; i < max && Number.isInteger(cur) && cur > 1; i++) {
    out.push(cur)
    // 0 means the process is gone mid-walk.
    const ppid = platform.processes.parentPid(cur)
    if (!Number.isInteger(ppid) || ppid <= 1) break
    cur = ppid
  }
  return out
}

/** Offer a newly-seen window to the pending launches. Returns the `LauncherEntry.id` that claimed
 *  it, or '' if none did. Idempotent per wid: a window already claimed keeps its answer. */
export function claimWindow(wid: string, pid: number, now = Date.now()): string {
  if (!wid) return ''
  const had = appIdByWid.get(wid)
  if (had) return had
  const live = pending.filter(l => !l.claimed && now - l.at < CLAIM_MS)
  if (live.length === 0) return ''

  // 1. Exact: this window's process descends from something we launched.
  if (pid > 0) {
    const line = ancestry(pid)
    for (const l of live) {
      if (l.pid > 0 && line.includes(l.pid)) {
        l.claimed = true
        appIdByWid.set(wid, l.appId)
        return l.appId
      }
    }
  }

  // 2. Heuristic, only for a window that exposes no pid: the most recent unclaimed launch
  //    takes it. A window whose pid traced to nothing of ours is left unclaimed.
  if (pid > 0) return ''
  const l = live[live.length - 1]
  if (!l) return ''
  l.claimed = true
  appIdByWid.set(wid, l.appId)
  return l.appId
}

/** The launcher entry a window was attributed to, or '' . */
export function appIdOfWindow(wid: string): string {
  return appIdByWid.get(wid) ?? ''
}

/** Drop attributions for windows that are gone. Called with the live list from the poll: window ids
 *  are reused, and an inherited claim would be a wrong answer rather than a missing one. */
export function pruneClaims(liveWids: readonly string[]): void {
  if (appIdByWid.size === 0) return
  const alive = new Set(liveWids)
  for (const wid of appIdByWid.keys()) if (!alive.has(wid)) appIdByWid.delete(wid)
}

/** For tests. */
export function resetLaunches(): void {
  pending = []
  appIdByWid.clear()
}
