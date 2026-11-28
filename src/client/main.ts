// pinhole-window — Even Hub WebView client entry point: boot sequence, pairing hooks and the
// console test hooks (`ewInvert`, `ewMenu`, `ewVoice`, `ewCursor`).
//
// Invariants this client keeps (docs/glasses.md):
//   * The page is established once (glassPage.ts); after that only differential pushes.
//   * `updateImageRawData` is strictly serial, and frames coalesce latest-wins per tile (pump.ts).
//   * `shutDownPageContainer` exits the app; it is never used for page recovery.

import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { voiceOverlay, voiceRowsFor } from '../shared/voiceDialog.ts'
import { clientId, type DurableStore, isPaired, setDurableStore } from './authClient.ts'
import { renderKeys } from './clients.ts'
import { DEBUG_EVENTS, installErrorFunnel, log } from './debugLog.ts'
import { wireKv } from './durableKv.ts'
import { stickyFlags, stickyLine } from './flags.ts'
import { onDouble, onHubEvent } from './gestures.ts'
import {
  establishPage,
  onDeviceStatus,
  restateOverlayOnNewPage,
  seedDeviceStatus,
} from './glassPage.ts'
import { KEY_PROBE } from './keyProbe.ts'
import {
  chooseMenu,
  keyMods,
  menuItems,
  menuLevelRows,
  menuOpen,
  menuPath,
  menuRootOrder,
  menuSel,
  openMenu,
  rootRows,
  setMenuSel,
  winRecent,
} from './menu.ts'
import { INSTANCE_ID, measureLinkBaseline, syncOverlay } from './overlay.ts'
import { maybeStartPairing, openPairingDialog, type PairingHooks } from './pairingUI.ts'
import { invertBtn, mountUi, textBox } from './phoneUi.ts'
import { initStats, kickPump, STATS_PERIOD_MS, setForcePending, statsOn } from './pump.ts'
import {
  identityIsSettled,
  initServer,
  SERVER,
  setAuthState,
  settlePendingServer,
  switchServer,
  wireServerStore,
} from './serverLink.ts'
import {
  initInvert,
  initMirrorMode,
  initScrollNatural,
  invert,
  mirrorMode,
  padScrollNatural,
  reapplyStoredSettings,
  scrollNatLabel,
  setInvert,
} from './settings.ts'
import { invertLabel, setStatus } from './statusUi.ts'
import { startStream, streamTicketed, sttReady } from './stream.ts'
import { cursor, refreshGrey } from './tiles.ts'
import { errText, withTimeout } from './util.ts'
import {
  onVoiceFrame,
  setVoice,
  voice,
  voiceCancel,
  voiceFeedRun,
  voiceFeedUrl,
  voiceGestureRoute,
  voiceStart,
  voiceStop,
} from './voice.ts'

// The SDK is imported dynamically inside boot(): it touches `window` on import, and keeping it
// out of the eager module graph lets the client's pure exports be unit-tested under plain node.
export type SdkModule = typeof import('@evenrealities/even_hub_sdk')
export let sdk: SdkModule | null = null
export let bridge: EvenAppBridge | null = null
export let pairingPrompted = false
export function setPairingPrompted(v: boolean): void {
  pairingPrompted = v
}

/** This device's fingerprint, so the enrolled-keys table can mark its own row. Computed in-page
 *  from our public key (`clientId()`), never asked of the server. '' until resolved or unpaired. */
export let myClientId = ''

// ── pairing (docs/security.md) ─────────────────────────────────────────────────────────────
//
// Approval does not reload the page: a reload re-runs `createStartUpPageContainer`, and the page
// must not be re-established while the glasses are live (docs/glasses.md). Instead the stream is
// re-opened with a ticket and the diff baseline reset so all four tiles re-send.

export const pairingHooks: PairingHooks = {
  // The base the copyable pairing URL should carry, so a store build (a different origin)
  // learns where the API is from the same paste that carries the code.
  serverBase: () => SERVER,
  // A pasted pairing URL may name the API base. This is the one path that adopts a server
  // without the confirm card of serverGuard.ts: an unpaired device has no identity to relay, and
  // the dialog names the origin first.
  onServerUrl: (origin: string) => {
    switchServer(origin)
  },
  onPaired: () => {
    setAuthState('ok')
    setStatus(`paired — reconnecting: ${SERVER}`)
    setForcePending(true)
    startStream()
    kickPump()
  },
  log: line => log(`[pair] ${line}`),
}

/** Open the pairing dialog at most once per page load. Without the latch, every 401 from the
 *  stream probe and every gesture POST would stack another dialog on top. */
export function maybePromptPairing(): void {
  if (pairingPrompted) return
  pairingPrompted = true
  log('server requires pairing — opening the pairing dialog')
  openPairingDialog(pairingHooks)
}

// ── boot ───────────────────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // First, before anything that can throw, so an uncaught error below still leaves a log line.
  installErrorFunnel()
  initServer()
  initInvert()
  initMirrorMode()
  initScrollNatural()
  initStats()
  mountUi()
  // The first lines in the log state which flags are in effect. A setting resolves
  // `?param=` → localStorage → default and persists the winner, so the raw query is printed next
  // to the resolved values, and `sticky:` below names the stored ones outright.
  let rawQuery = ''
  try {
    rawQuery = location.search
  } catch {
    /* no location */
  }
  // The instance id matches this page load to the server's `stream inst=` log line.
  log(`boot: query=${rawQuery || '(none)'} inst=${INSTANCE_ID}`)
  log(
    `config: server=${SERVER} ` +
      `invert=${invert ? 'on' : 'off'} mirror=${mirrorMode} debug=${DEBUG_EVENTS ? 'on' : 'off'} ` +
      `stats=${statsOn ? `every ${STATS_PERIOD_MS / 1000}s` : 'off'}` +
      // Says what the instrument looks like: the link baseline freezes the mirror and paints a
      // bright mosaic over all four quadrants for ~3.5 s, at boot and again at +60 s.
      `${
        statsOn
          ? ' (brackets the run with a link baseline: a ~3.5s mosaic on the glass now' +
            ' and again at +60s — expected, docs/glasses.md)'
          : ''
      }` +
      // The key probe is named with what it does not do: it only tallies and logs
      // (docs/phone-ui.md).
      ` scroll=${scrollNatLabel(padScrollNatural)}` +
      `${KEY_PROBE ? ' keyprobe=on (observes keys and pointer; injects nothing)' : ''}`,
  )
  // Only when something is actually sticky; the quiet case is the common one.
  const sticky = stickyLine(stickyFlags)
  if (sticky) log(sticky)
  setStatus('connecting')
  // A `?pair=<code>` URL takes precedence over the auto-prompt: it already carries the
  // one-time code, so the dialog opens pre-filled and `maybePromptPairing` must not replace
  // it with the blank manual form when the first 401 lands a moment later.
  if (maybeStartPairing(pairingHooks)) pairingPrompted = true
  // One `isPaired()` for both answers: the identity line, and the verdict on a deferred
  // `?server=` (serverGuard.ts — only a device with an enrolled key has a signature worth
  // relaying, so only that device is asked).
  void isPaired().then(p => {
    log(`identity: ${p ? 'paired' : 'none (unpaired)'}`)
    settlePendingServer(p)
  })
  // Our own fingerprint, for the "(this device)" row of the enrolled-keys table.
  void clientId()
    .then(id => {
      if (!id) return
      myClientId = id
      renderKeys()
    })
    .catch(() => {
      /* unpaired, or no WebCrypto: the table simply marks no row */
    })
  startStream() // works with no bridge at all, so desktop dev sees the pipeline

  try {
    sdk = await import('@evenrealities/even_hub_sdk')
  } catch (e) {
    setStatus(`sdk load failed: ${errText(e)}`)
    identityIsSettled() // no bridge is coming, so IndexedDB is the whole answer
    return
  }
  log(
    'menu: root list + levels in container 6, opened by a double-tap; ' +
      'zOrderIndex on every container (geom.ts) — no menuObject, the two cannot coexist',
  )

  try {
    bridge = await withTimeout(waitBridge(sdk), 8000, 'bridge')
  } catch (e) {
    setStatus(`no glasses bridge (${errText(e)}) — DOM-only mode`)
    identityIsSettled()
    return
  }

  // Mirror the device identity into the bridge's durable KV: IndexedDB is not durable in the
  // packaged Even Hub app, so a key kept only there is lost on restart. Must be wired before
  // any auth use (see DurableStore in authClient.ts).
  const br = bridge
  const store: DurableStore = {
    get: async k => {
      try {
        return (await br.getLocalStorage(k)) || null
      } catch {
        return null
      }
    },
    set: async (k, v) => {
      try {
        await br.setLocalStorage(k, v)
      } catch {
        /* ignore */
      }
    },
  }
  setDurableStore(store)
  // First, so that everything below reads what the last run left: settings, the tour and hint
  // records, the acknowledged keys (durableKv.ts).
  const restored = await wireKv(store)
  if (restored.length > 0) {
    log(`settings recovered from the durable store: ${restored.join(' ')}`)
    reapplyStoredSettings()
    if (invertBtn) invertBtn.textContent = invertLabel()
  }
  // Before the identity is declared settled: an address kept in the store must be adopted
  // before anyone is asked for one.
  await wireServerStore(store)
  // From here `isPaired()` sees the mirrored key too, so "no server address" can be told apart
  // from "never paired" (serverLink.ts, `maybeAskForServer`).
  identityIsSettled()
  // The stream above was opened before the bridge existed, so it may be running without a
  // ticket while the durable mirror does hold an identity. Re-open it once if so.
  if (!streamTicketed && (await isPaired())) {
    log('identity recovered from the durable store')
    startStream()
  }

  bridge.onEvenHubEvent(onHubEvent)
  // Link state before the establish: a phone that opens the app with the glasses away learns
  // that from one `getDeviceInfo()` rather than from a drain's worth of 34-second pushes.
  bridge.onDeviceStatusChanged(onDeviceStatus)
  await seedDeviceStatus(br)
  try {
    const ok = await establishPage()
    // The combined verdict of create + rebuild (src/shared/establishPage.ts), logged so it
    // reaches the server log as well as the phone's status line.
    log(`establish => ${ok ? 'ESTABLISHED' : 'NOT established (streaming anyway)'}`)
    // The narrative says what the client is doing; `renderStatus()` already prints the page bit.
    setStatus(ok ? `mirroring ${SERVER}` : 'streaming without an established page')
  } catch (e) {
    log(`establish FAILED: ${errText(e)}`)
    setStatus(`establish failed: ${errText(e)}`)
  }
  // After the establish (the probe pushes into containers 2-5, which need the page) and before
  // the first kickPump here, so the samples are the fixed payload. Tiles arrive over SSE from
  // boot, so the pump may already be mid-drain: the baseline takes its hold before quiescing.
  if (statsOn) {
    setStatus('measuring the link…')
    await measureLinkBaseline('start')
    setStatus(`mirroring ${SERVER}`)
  }
  // A pause decided before the page existed must be re-stated now: `seedDeviceStatus` runs ahead
  // of the establish, so a boot-time `isWearing:false` wrote its notice into containers that
  // were not live yet. One idempotent re-sync of whatever the overlay holds.
  restateOverlayOnNewPage()
  setForcePending(true)
  kickPump()
}

function waitBridge(mod: SdkModule): Promise<EvenAppBridge> {
  return Promise.resolve(mod.waitForEvenAppBridge())
}

// Boot only in a real document. Under vitest (node environment) there is none, so importing
// this module has no side effects and never touches the SDK or the bridge.
if (typeof document !== 'undefined') {
  void boot()
  // The one way to drive voice with no microphone — see `voiceFeedRun`. Inert without a URL.
  const feedUrl = voiceFeedUrl()
  if (feedUrl) void voiceFeedRun(feedUrl)
  ;(window as unknown as { ewInvert: unknown }).ewInvert = {
    set: (on: boolean) => {
      setInvert(on)
      if (invertBtn) invertBtn.textContent = invertLabel()
    },
    toggle: () => {
      setInvert(!invert)
      if (invertBtn) invertBtn.textContent = invertLabel()
    },
    state: () => invert,
  }
  // Drives the menu with no hardware input: `open()` is a double-tap, `path()`/`rows()` are what
  // is on the glass, and `sel`/`choose`/`back` are the three gestures.
  ;(window as unknown as { ewMenu: unknown }).ewMenu = {
    items: () => menuItems.map(it => ({ ...it })),
    open: () => {
      openMenu()
    },
    path: () => menuPath.map(p => ({ id: p.id, label: p.label })),
    // `rootRows()` rather than `menuItems`: the rows as drawn, in MRU display order, which is
    // what `sel()` and `choose()` index. `items()` above is the list as built, in server order.
    rows: () =>
      menuPath.length === 0
        ? rootRows().map(it => ({ label: it.itemName, token: `item:${String(it.itemID)}` }))
        : menuLevelRows.map(r => ({ ...r })),
    /** The focus recency the root list is ordered by — frozen while open, live while shut. */
    recent: () => (menuOpen ? [...menuRootOrder] : [...winRecent]),
    sel: (i?: number) => {
      if (typeof i === 'number') {
        setMenuSel(i)
        syncOverlay()
      }
      return menuSel
    },
    choose: () => {
      void chooseMenu()
    },
    back: () => {
      void onDouble()
    },
    mods: () => [...keyMods],
  }
  // Drives the voice dialog with no microphone (the simulator has no audio). `frame()` is what
  // an `audioEvent` would deliver, so real PCM fed through it exercises the whole path.
  ;(window as unknown as { ewVoice: unknown }).ewVoice = {
    ready: () => sttReady,
    start: () => voiceStart(),
    /** One audio frame, as the host would have delivered it. */
    frame: (bytes: number[] | Uint8Array) => {
      onVoiceFrame(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    },
    stop: () => voiceStop('ewVoice'),
    cancel: () => {
      voiceCancel('ewVoice')
    },
    state: () => (voice ? { ...voice } : null),
    rows: () => (voice ? voiceRowsFor(voice).map(r => ({ ...r })) : []),
    sel: (i?: number) => {
      if (typeof i === 'number' && voice) setVoice({ ...voice, sel: i })
      return voice?.sel ?? 0
    },
    choose: () => {
      voiceGestureRoute('tap')
    },
    /** What the glass is showing, so a test can assert on it without a screenshot. */
    overlay: () => (voice ? voiceOverlay(voice) : ''),
    box: () => textBox?.value ?? '',
  }
  ;(window as unknown as { ewCursor: unknown }).ewCursor = {
    set: (x: number, y: number) => {
      cursor.x = x
      cursor.y = y
      refreshGrey()
    },
    show: (on: boolean) => {
      cursor.shown = on
      refreshGrey()
    },
    state: () => ({ ...cursor }),
  }
}
