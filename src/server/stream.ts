// stream.ts — the SSE fan-out: the subscriber hub, the state retained for priming a new
// subscriber (avail, windows, apps, bindings, clients, tiles) and the publishers that feed it.
// OS-neutral.

import type { BindingMap } from '../shared/bindings.ts'
import { TILES } from '../shared/geom.ts'
import type { Avail, EnrolledClient, LauncherEntry, StreamEvent, WinInfo } from '../shared/types.ts'

/** The last PNG emitted per tile, base64. Module level, like the diff baseline in
 *  src/server/tiles.ts: a reattach must keep priming new subscribers from the tiles the
 *  previous capture produced. */
const lastTilePngB64: (string | null)[] = [null, null, null, null]

let availState: Avail = { ok: false, msg: 'starting' }
let winList: WinInfo[] = []
/** The focus-recency order that came with `winList` (src/server/windows.ts `mruFold`), retained
 *  for priming alongside it. `[]` is a truthful "nothing has been focused yet". */
let winRecent: string[] = []
/** The launchable set, retained for priming. Published by main.ts (the backend's catalogue
 *  owns the scan). `null` — not `[]` — until the first scan has published: the client's
 *  establish waits a bounded moment for this event, and "scanned, found nothing" must prime a
 *  subscriber while "has not scanned yet" must not. */
let appsList: LauncherEntry[] | null = null
let appsRecent: string[] = []
/** The per-app swipe bindings (docs/glasses.md), retained for priming. Published by main.ts;
 *  src/server/bindings.ts owns the file. `null` until the boot publication, because the empty
 *  map is a meaningful answer that must reach a subscriber. */
let bindingsRetained: BindingMap | null = null
/** The enrolled client keys (docs/security.md), retained for priming. Published by main.ts;
 *  src/server/auth.ts owns the registry. `null` until the boot publication, because "no keys
 *  enrolled" is a meaningful answer that must reach a subscriber. */
let clientsRetained: { list: EnrolledClient[]; enforced: boolean } | null = null

type Sub = (ev: StreamEvent) => void
const subs = new Set<Sub>()

function emit(ev: StreamEvent): void {
  for (const fn of subs) {
    try {
      fn(ev)
    } catch {
      /* a bad subscriber must not stall the rest */
    }
  }
}

function availEvent(a: Avail): StreamEvent {
  return a.ok ? { t: 'avail', ok: true } : { t: 'avail', ok: false, msg: a.msg }
}

/** The display session reports here (`SessionSink.avail`). A no-op when nothing changed. */
export function setAvail(next: Avail): void {
  if (availState.ok === next.ok && (next.ok || (!availState.ok && availState.msg === next.msg)))
    return
  availState = next
  emit(availEvent(next))
}

export function avail(): Avail {
  return availState.ok ? { ok: true } : { ok: false, msg: availState.msg }
}

/** Register a stream subscriber and prime it immediately with every retained state, tiles
 *  last. A static screen emits nothing (per-tile diff), so an unprimed subscriber would never
 *  paint. Returns the unsubscribe function. */
export function subscribe(fn: Sub): () => void {
  subs.add(fn)
  try {
    fn(availEvent(availState))
    fn({ t: 'windows', list: winList, recent: winRecent })
    // The launchable set, if the boot scan has finished; otherwise the scan's own `apps` event
    // delivers it.
    if (appsList) fn({ t: 'apps', list: appsList, recent: appsRecent })
    if (bindingsRetained) fn({ t: 'bindings', map: bindingsRetained })
    // Primed on connect as well as pushed on change: the client compares the enrolled keys
    // against what it last saw (persisted), so a key added while the phone was away must show
    // as soon as it returns.
    if (clientsRetained)
      fn({ t: 'clients', list: clientsRetained.list, enforced: clientsRetained.enforced })
    for (let i = 0; i < TILES; i++) {
      const png = lastTilePngB64[i]
      if (png) fn({ t: 'tile', i, png })
    }
  } catch {
    /* a subscriber that throws on prime still stays subscribed */
  }
  return () => {
    subs.delete(fn)
  }
}

/** The last PNG emitted for tile `i`, base64. null when that tile has never been captured. */
export function lastTilePng(i: number): string | null {
  return lastTilePngB64[i] ?? null
}

/** tiles.ts calls this for every tile that changed. Retained so a later subscriber is primed
 *  with it. */
export function onTile(i: number, png: string): void {
  lastTilePngB64[i] = png
  emit({ t: 'tile', i, png })
}

/** Called when the mirrored desktop's window set changes. The list and the recency order are
 *  both retained for priming. `recent` needs no publication rule of its own: it moves only
 *  when the active window changes or a window appears/disappears, and all three already move
 *  `windowsKey`. */
export function onWindowsChanged(list: WinInfo[], recent: string[]): void {
  winList = list
  winRecent = recent
  emit({ t: 'windows', list, recent })
}

/** main.ts calls this when the launchable set or the launch-recency order changes: the boot
 *  scan, an explicit `?rescan=1`, an apps.conf edit or a successful spawn — never per request
 *  or per frame. Retained so a later subscriber is primed with it. */
export function onAppsChanged(list: LauncherEntry[], recentIds: string[]): void {
  appsList = list
  appsRecent = recentIds
  emit({ t: 'apps', list, recent: recentIds })
}

/** main.ts calls this at boot and whenever the client registry's contents change (it polls the
 *  stat-gated registry on the 1 Hz window tick; `pw-auth` is the only writer). Retained so a
 *  later subscriber is primed with it. The event only informs: nothing on the wire can change
 *  the registry. */
export function onClientsChanged(list: EnrolledClient[], enforced: boolean): void {
  clientsRetained = { list, enforced }
  emit({ t: 'clients', list, enforced })
}

/** main.ts calls this at boot and after every `POST /api/bindings` that changed something
 *  (`setBinding` returned true). Retained so a later subscriber is primed with it. */
export function onBindingsChanged(map: BindingMap): void {
  bindingsRetained = map
  emit({ t: 'bindings', map })
}
