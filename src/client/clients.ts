// The enrolled-clients table (docs/security.md).
//
// The client modules import each other freely, but only from inside functions: nothing here may
// use another non-leaf module while this one is still loading.

import type { EnrolledClient } from '../shared/types.ts'
import { log } from './debugLog.ts'
import { keep } from './durableKv.ts'
import { myClientId } from './main.ts'
import { keysAckBtn, keysNoteEl, keysTableEl } from './phoneUi.ts'
import { renderConnSummary } from './statusUi.ts'

/** The enrolled set as last reported, or null until a `{t:'clients'}` event arrives; null is
 *  shown as "unknown", not as "no keys". */
let enrolledKeys: EnrolledClient[] | null = null
let enrolledEnforced = true
/** The ids this device has acknowledged. null = nothing acknowledged yet, so the first report
 *  becomes the baseline instead of an alert. */
let ackedKeyIds: string[] | null = null
export let keysAlert: KeyDiff = { added: [], removed: [], alert: false }
const ACKED_KEYS_STORE = 'ew.keys.acked'

export interface KeyDiff {
  added: string[]
  removed: string[]
  alert: boolean
}

/** What changed since this device last acknowledged the enrolled set. Pure.
 *  `acked === null` (first report) is not an alert, and neither is a rename. Only added keys
 *  raise the alert; removed keys are reported without it. */
export function enrolledKeyDiff(
  current: readonly { id: string }[],
  acked: readonly string[] | null,
): KeyDiff {
  if (acked === null) return { added: [], removed: [], alert: false }
  const now = new Set(current.map(c => c.id))
  const seen = new Set(acked)
  const added = [...now].filter(id => !seen.has(id))
  const removed = [...seen].filter(id => !now.has(id))
  return { added, removed, alert: added.length > 0 }
}

function loadAckedKeys(): void {
  try {
    const raw = localStorage.getItem(ACKED_KEYS_STORE)
    if (raw === null) {
      ackedKeyIds = null
      return
    }
    const v = JSON.parse(raw) as unknown
    ackedKeyIds = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    ackedKeyIds = null
  }
}

/** Mark the current set as seen. This deliberate tap is the only way the alert clears. */
export function ackKeys(): void {
  if (!enrolledKeys) return
  ackedKeyIds = enrolledKeys.map(c => c.id)
  keep(ACKED_KEYS_STORE, JSON.stringify(ackedKeyIds))
  keysAlert = { added: [], removed: [], alert: false }
  log(`keys: acknowledged ${ackedKeyIds.length} enrolled key(s)`)
  renderKeys()
  renderConnSummary()
}

/** `{t:'clients'}`: the enrolled set, on connect and on every change. */
export function setEnrolledKeys(list: EnrolledClient[], enforced: boolean): void {
  if (ackedKeyIds === null && enrolledKeys === null) loadAckedKeys()
  enrolledKeys = list
  enrolledEnforced = enforced
  const d = enrolledKeyDiff(list, ackedKeyIds)
  // An alert latches until acknowledged: a later event must not clear an unseen warning.
  keysAlert =
    d.alert || keysAlert.alert
      ? { added: d.added, removed: d.removed, alert: d.added.length > 0 || keysAlert.alert }
      : d
  if (ackedKeyIds === null) {
    // First report on this device: adopt it as the baseline silently.
    ackedKeyIds = list.map(c => c.id)
    keep(ACKED_KEYS_STORE, JSON.stringify(ackedKeyIds))
  }
  log(
    `keys: ${list.length} enrolled${enforced ? '' : ' (auth OFF — the registry is not consulted)'}` +
      `${d.added.length ? ` — ${d.added.length} NEW: ${d.added.map(i => i.slice(0, 12)).join(' ')}` : ''}` +
      `${d.removed.length ? ` — ${d.removed.length} removed` : ''}`,
  )
  renderKeys()
  renderConnSummary()
}

/** The table: one row per enrolled key. An unacknowledged row is red and labelled NEW;
 *  keys revoked since the last acknowledgement are counted in the note below. */
export function renderKeys(): void {
  if (!keysTableEl || !keysNoteEl) return
  keysTableEl.textContent = ''
  if (!enrolledKeys) {
    keysNoteEl.textContent = 'enrolled keys: unknown (this server does not report them)'
    keysNoteEl.style.color = '#888'
    if (keysAckBtn) keysAckBtn.style.display = 'none'
    return
  }
  const newIds = new Set(keysAlert.added)
  const head = document.createElement('div')
  head.style.cssText =
    'display:grid;grid-template-columns:1fr 92px 86px;gap:6px;color:#888;' +
    'font:10px/1.5 ui-monospace,monospace;border-bottom:1px solid #333;padding-bottom:2px'
  for (const h of ['key', 'id', 'added']) {
    const c = document.createElement('div')
    c.textContent = h
    head.appendChild(c)
  }
  keysTableEl.appendChild(head)
  for (const c of enrolledKeys) {
    const row = document.createElement('div')
    const isNew = newIds.has(c.id)
    const isMe = c.id === myClientId
    row.style.cssText =
      'display:grid;grid-template-columns:1fr 92px 86px;gap:6px;' +
      'font:11px/1.6 ui-monospace,monospace;' +
      `color:${isNew ? '#ff6b57' : isMe ? '#9ad' : '#bdbdbd'}`
    const label = document.createElement('div')
    label.textContent = `${isNew ? '⚠ NEW ' : ''}${c.name}${isMe ? ' (this device)' : ''}`
    const id = document.createElement('div')
    id.textContent = c.id.slice(0, 12)
    const when = document.createElement('div')
    // Date only: the phone column is narrow.
    when.textContent = new Date(c.addedAt).toISOString().slice(0, 10)
    row.append(label, id, when)
    keysTableEl.appendChild(row)
  }
  const parts: string[] = []
  if (!enrolledEnforced) parts.push('auth is OFF — these keys are not checked')
  if (keysAlert.added.length)
    parts.push(
      `${keysAlert.added.length} key(s) enrolled since you last looked — if you did not approve this, revoke it on the host: ew-auth revoke <id>`,
    )
  if (keysAlert.removed.length)
    parts.push(`${keysAlert.removed.length} key(s) revoked since you last looked`)
  if (!parts.length)
    parts.push('only the host can change this list (`ew-auth` there) — this is a read-only view')
  keysNoteEl.textContent = parts.join(' · ')
  keysNoteEl.style.color = keysAlert.alert ? '#ff6b57' : '#888'
  if (keysAckBtn)
    keysAckBtn.style.display = keysAlert.added.length || keysAlert.removed.length ? '' : 'none'
}
