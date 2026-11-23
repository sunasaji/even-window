// appRecency.ts — launch recency: which applications were launched last, most recent first.
// OS-neutral; the application catalogue itself belongs to the backend (`platform.apps`).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LauncherEntry } from '../shared/types.ts'
import { appStateDir } from './stateDir.ts'

const RECENT_FILE = 'apps-recent.json'

function recentPath(): string {
  return join(appStateDir(), RECENT_FILE)
}

/** Launch recency, most recent first. The glasses menu's curated slots are the head of this
 *  list (docs/glasses.md), so it is persisted across server restarts. */
const RECENT_MAX = 8
let recent: string[] | null = null

function loadRecent(): string[] {
  if (recent) return recent
  try {
    const v: unknown = JSON.parse(readFileSync(recentPath(), 'utf8'))
    const list = (v as { recent?: unknown }).recent
    recent = Array.isArray(list)
      ? list.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX)
      : []
  } catch {
    recent = []
  }
  return recent
}

function saveRecent(list: string[]): void {
  try {
    mkdirSync(appStateDir(), { recursive: true })
    writeFileSync(recentPath(), JSON.stringify({ recent: list }, null, 2) + '\n')
  } catch {
    /* a non-writable state dir must not break a launch */
  }
}

/** Ids known to the current list, in recency order. Filtered against the live list so a hidden
 *  or uninstalled entry drops out of the glasses menu.
 *  `boot` is the command of the default client (`platform.apps.seedCommand()`); '' for none. */
export function recentApps(apps: readonly LauncherEntry[], boot: string): string[] {
  const ids = new Set(apps.map(a => a.id))
  const out = loadRecent().filter(id => ids.has(id))
  // The seed: the default client (EW_SPAWN) is appended at the back as a filler, not only when
  // the list is empty. A fresh install then shows a non-empty launcher, and after one launch
  // the remaining glasses slots still offer "open another terminal". Anything actually
  // launched outranks it.
  const seed = boot ? apps.find(a => a.cmd === boot) : undefined
  if (seed && !out.includes(seed.id)) out.push(seed.id)
  return out.slice(0, RECENT_MAX)
}

/** Record a launch. Returns true when the recency order changed (the caller publishes then). */
export function noteLaunch(id: string): boolean {
  const list = loadRecent()
  if (list[0] === id) return false
  const next = [id, ...list.filter(x => x !== id)].slice(0, RECENT_MAX)
  recent = next
  saveRecent(next)
  return true
}

/** Forget the in-memory copy so the next read comes from disk (tests). */
export function resetAppRecency(): void {
  recent = null
}
