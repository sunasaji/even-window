// Device-side pairing dialog: take a one-time code from the URL or a pasted one, submit this
// device's fresh public key, show its randomart, and poll until a human approves it on the
// server. Manual mode and a failed submit show a server-side setup guide.
//
// Invariants: the grid is drawn from this device's own key, never from the server's response
// (`pairingArtView`). Approval re-opens the stream through `onPaired` and never reloads the
// page, because a reload would re-establish the glasses page (docs/glasses.md). Nothing is
// submitted without a tap: opening a pairing link must not consume the one-time code.

import { randomart } from '../shared/randomart.ts'
import { normaliseOrigin } from '../shared/sessionBinding.ts'
import { clientId, pairStatus, submitPairing } from './authClient.ts'

/** What the pairing card shows once a submit has landed. Pure.
 *  `localId` is this device's own key fingerprint; `serverId`/`serverArt` are the pairing
 *  response's claim. The displayed grid is always drawn from `localId`. A disagreement means
 *  the staged key is not this device's key, and `mismatch` tells the operator not to approve. */
export function pairingArtView(
  localId: string,
  serverId: string,
  serverArt: string,
): { id: string; art: string; mismatch: boolean } {
  const id = localId || serverId
  // No local identity (key generation failed): show the server's grid, flagged as untrusted.
  if (!localId) return { id, art: serverArt, mismatch: true }
  const art = randomart(localId)
  const mismatch =
    (serverId !== '' && serverId !== localId) || (serverArt !== '' && serverArt !== art)
  return { id, art, mismatch }
}

/** Pull a pairing code out of the URL and scrub it from the address bar so a reload or a
 *  screenshot cannot replay it. Accepts both `?pair=` and `#pair=`. */
export function takeCode(): string {
  let code = ''
  try {
    const h = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash
    code =
      new URLSearchParams(location.search).get('pair') || new URLSearchParams(h).get('pair') || ''
    if (code) {
      const q = new URLSearchParams(location.search)
      q.delete('pair')
      const qs = q.toString()
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''))
    }
  } catch {
    /* no location (tests) */
  }
  return code
}

/** What a pasted pairing URL (or bare code) carries. Pure.
 *  The app may run on a different origin than the server, so the URL names the server with
 *  `server=`; failing that, an absolute URL's own origin is used. The caller adopts `server`
 *  only on an explicit tap, after naming it on screen. */
export function pairingTarget(pasted: string): { code: string; server: string } {
  const t = (pasted || '').trim()
  const code = extractCode(t)
  let server = ''
  const explicit = t.match(/[?&]server=([^&#\s]+)/)
  if (explicit?.[1]) server = normaliseOrigin(decodeURIComponent(explicit[1]))
  if (!server && /^https?:\/\//i.test(t)) server = normaliseOrigin(t)
  return { code, server }
}

/** How the enrolled-slot count reads on the device, and whether approval would be refused.
 *  Pure. `EW_MAX_CLIENTS` is enforced by `ew-auth approve` on the host, so the device warns
 *  beforehand. `alreadyEnrolled` is never blocked: re-submitting an enrolled key takes no slot. */
export function slotLine(
  used: number,
  max: number,
  alreadyEnrolled = false,
): { text: string; blocked: boolean } {
  if (max === 0)
    return { text: `${used} key(s) enrolled on the server (no limit set)`, blocked: false }
  if (alreadyEnrolled)
    return {
      text: `${used} of ${max} slot(s) used — this device is already one of them`,
      blocked: false,
    }
  const free = Math.max(0, max - used)
  if (free > 0)
    return {
      text: `${used} of ${max} slot(s) used — ${free} free, so this device fits`,
      blocked: false,
    }
  return {
    text:
      `${used} of ${max} slot(s) used — NO FREE SLOT, so approving this device will be` +
      ' REFUSED. On the server, either revoke the key it replaces' +
      ' (`ew-auth list` then `ew-auth revoke <id>`), or raise the cap for the whole run' +
      ' (EW_MAX_CLIENTS=2 in ~/.pinhole-window/env, then restart).',
    blocked: true,
  }
}

/** Accept a raw code or a pasted pairing URL and return the code. Pure. */
export function extractCode(s: string): string {
  const t = (s || '').trim()
  const m = t.match(/[#?&]pair=([A-Za-z0-9_-]+)/)
  if (m?.[1]) return m[1]
  return /^[A-Za-z0-9_-]+$/.test(t) ? t : ''
}

const el = (tag: string, style: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.style.cssText = style
  if (text) e.textContent = text
  return e
}

const BTN =
  'padding:8px 18px;font:14px system-ui;border:1px solid #555;border-radius:6px;background:#2d2d2d;color:#e5e5e5;cursor:pointer'
const POLL_MS = 2000

export interface PairingHooks {
  /** Called once the server has enrolled this device. Re-opens the stream with the new
   *  token; must not reload the page (see the header). */
  onPaired(): void
  /** The API base in force, so the copyable URL can carry `server=` when the app and the API
   *  are on different origins. */
  serverBase(): string
  /** Adopt an API base carried by a pasted pairing URL. Called only from the Pair tap, after
   *  the dialog has shown which origin it is. */
  onServerUrl(origin: string): void
  /** Mirror pairing progress into the debug log. */
  log(line: string): void
}

/** Non-empty `initialCode`: URL-triggered. Empty: manual, with an input for the code or the
 *  whole pairing URL. Nothing is submitted until the Pair button is tapped. */
async function runDialog(initialCode: string, hooks: PairingHooks): Promise<void> {
  const existing = document.getElementById('ew-pair')
  if (existing) existing.remove()

  const back = el(
    'div',
    'position:fixed;inset:0;z-index:99999;background:#151515e8;color:#e5e5e5;display:flex;align-items:flex-start;justify-content:center;font:14px/1.4 system-ui,sans-serif;padding:16px;box-sizing:border-box;overflow:auto',
  )
  back.id = 'ew-pair'
  const card = el(
    'div',
    'max-width:520px;width:100%;background:#232323;border:1px solid #3a3a3a;border-radius:10px;padding:20px;text-align:center',
  )
  const title = el('div', 'font:600 18px system-ui;margin-bottom:8px', 'Pair this device')
  const msg = el(
    'div',
    'margin-bottom:12px;color:#bdbdbd',
    initialCode
      ? 'Tap “Pair this device” to register it with your server. It is enrolled only after you' +
          ' approve it there, so nothing is granted by this tap alone.'
      : 'Paste the pairing URL (or just the code) printed by `ew-auth pair`, then tap Pair.' +
          ' A full URL also tells this app which server to talk to.',
  )

  const input = el(
    'input',
    'display:none;width:100%;box-sizing:border-box;padding:9px 10px;font:13px ui-monospace,monospace;background:#111;border:1px solid #444;border-radius:6px;color:#e5e5e5;margin-bottom:8px',
  ) as HTMLInputElement
  input.setAttribute('placeholder', 'Paste pairing URL or code')
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocorrect', 'off')
  input.spellcheck = false

  // The pairing URL, copyable and as a QR, for moving the code to the app or device that
  // should hold the key: the key is generated wherever the code is submitted. The URL carries
  // `server=` when the app and the API are on different origins (see `pairingTarget`). The
  // code is consumed by the first valid submit, so one window pairs one device.
  const codeRow = el('div', 'display:none;margin-bottom:8px')
  const codeBox = el(
    'code',
    'display:block;width:100%;box-sizing:border-box;word-break:break-all;' +
      'text-align:left;padding:6px 8px;font:12px ui-monospace,monospace;background:#111;' +
      'border:1px solid #333;border-radius:6px;color:#9ad',
  )
  const copyBtn = el(
    'button',
    'margin-top:6px;padding:4px 12px;font:12px system-ui;border:1px solid #555;' +
      'border-radius:6px;background:#2d2d2d;color:#e5e5e5;cursor:pointer',
    'Copy',
  ) as HTMLButtonElement
  const qrBox = el(
    'div',
    'display:none;margin:8px auto 2px;width:min(60vw,220px);' +
      'background:#fff;padding:8px;border-radius:6px;line-height:0',
  )
  const note = el('div', 'display:none;margin-bottom:8px;color:#8a8a8a;font:11px/1.45 system-ui')
  codeRow.append(codeBox, copyBtn)

  // Server-side setup guide. Shown in manual mode and after a failed submit.
  const guide = el(
    'div',
    'display:none;text-align:left;margin:2px 0 10px;color:#9a9a9a;font:12px/1.5 system-ui',
  )
  const cS =
    'background:#111;border:1px solid #333;border-radius:4px;padding:1px 4px;color:#9ad;' +
    'font:11px ui-monospace,monospace;word-break:break-all'
  const pS =
    'white-space:pre-wrap;word-break:break-all;background:#111;border:1px solid #333;' +
    'border-radius:5px;padding:6px 8px;margin:4px 0 2px;color:#9ad;font:11px/1.4 ui-monospace,monospace'
  guide.innerHTML =
    '<div style="margin-bottom:6px;color:#bdbdbd">First time? Set the server up, then pair:</div>' +
    '<ol style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">' +
    '<li>Start the server:' +
    `<pre style="${pS}">cd pinhole-window &amp;&amp; npm install\nnode src/server/main.ts</pre>` +
    `(or install the unit: <code style="${cS}">systemd/pinhole-window@.service</code>)</li>` +
    '<li>Put TLS in front — this server terminates none:' +
    `<pre style="${pS}">tailscale serve --bg --yes --https 8443 \\\n  --set-path /api http://127.0.0.1:8787/api\ntailscale serve --bg --yes --https 8443 http://127.0.0.1:5273</pre>` +
    'it prints an https URL that works inside your tailnet only.</li>' +
    `<li>Put that URL in <code style="${cS}">~/.pinhole-window/env</code> as` +
    ` <code style="${cS}">EW_ORIGIN=…</code> and restart the server.</li>` +
    '<li>Open a pairing window:' +
    `<pre style="${pS}">node scripts/ew-auth.mjs pair '&lt;that https URL&gt;'</pre>` +
    'it prints a pairing URL, and a QR if <code style="' +
    cS +
    '">qrencode</code> is installed.</li>' +
    '<li>Open that URL on this device (or paste it above), then tap <b>Pair</b>.</li>' +
    '<li>Compare the pattern that appears here with the one on the server, and approve it' +
    ` there — answer <b>y</b>, or run <code style="${cS}">node scripts/ew-auth.mjs approve &lt;id&gt;</code>` +
    ' (the device id is shown on this screen; the first 4 characters are enough).</li>' +
    '</ol>' +
    '<div style="margin-top:8px;color:#8a8a8a">If pairing is approved but the app still gets' +
    ` 401s, the server's <code style="${cS}">EW_ORIGIN</code> does not match the URL this` +
    ' device dials: every signature names its destination, and the server refuses one made' +
    ' out to anywhere else.</div>'

  // The enrolled-slot line, filled from the pairing response; amber when no slot is free.
  const slotEl = el('div', 'display:none;margin:0 0 8px;font:11px/1.45 system-ui;color:#9a9a9a')

  // The randomart. Fixed pitch, so two grids can be compared at a glance.
  const art = el(
    'pre',
    'display:none;font:12px/1.15 ui-monospace,Menlo,Consolas,monospace;background:#111;border:1px solid #333;border-radius:6px;padding:10px;overflow:auto;text-align:left;white-space:pre',
  )
  art.id = 'ew-pair-art'
  const idLine = el(
    'div',
    'display:none;margin-top:6px;font:12px ui-monospace,monospace;color:#9ad',
  )
  idLine.id = 'ew-pair-id'
  const hint = el('div', 'display:none;margin-top:12px;color:#bdbdbd')

  const btnRow = el('div', 'display:flex;gap:10px;justify-content:center;margin-top:16px')
  const pairBtn = el('button', BTN, 'Pair this device') as HTMLButtonElement
  const cancelBtn = el('button', BTN, 'Cancel') as HTMLButtonElement
  btnRow.append(pairBtn, cancelBtn)

  card.append(title, msg, input, guide, codeRow, qrBox, note, slotEl, art, idLine, hint, btnRow)
  back.append(card)
  document.body.append(back)

  if (!initialCode) {
    input.style.display = 'block'
    guide.style.display = 'block'
    setTimeout(() => input.focus(), 50)
  } else {
    // Rebuild the pairing URL: `takeCode` scrubbed `?pair=` out of the address bar, and the
    // base belongs in it only when the API is on another origin than this page.
    let url = initialCode
    try {
      const q = new URLSearchParams(location.search)
      q.set('pair', initialCode)
      const base = normaliseOrigin(hooks.serverBase())
      if (base && base !== location.origin) q.set('server', base)
      url = `${location.origin}${location.pathname}?${q.toString()}`
    } catch {
      /* no location (tests): the bare code is still copyable */
    }
    codeBox.textContent = url
    codeRow.style.display = 'block'
    note.style.display = 'block'
    note.innerHTML =
      'Pairing a different app or browser (a store build runs on its own origin)?' +
      ' <b>Copy</b> this and paste it into that app’s pair dialog — the key is generated' +
      ' wherever you paste it, and the URL carries the server address too.' +
      ' Or scan the code from the device you want to pair.' +
      '<br><b>One window pairs one device</b>: whichever submits first uses it up.'
    // The QR encoder is loaded on demand to keep it out of the boot path. A failure here
    // (offline, over-long URL) leaves Copy working.
    void (async () => {
      try {
        const { default: qrcode } = await import('qrcode-generator')
        const qr = qrcode(0, 'M')
        qr.addData(url)
        qr.make()
        qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true })
        qrBox.style.display = 'block'
      } catch {
        /* no QR; the URL above is still copyable */
      }
    })()
  }
  copyBtn.onclick = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(codeBox.textContent ?? '')
        copyBtn.textContent = 'Copied'
      } catch {
        copyBtn.textContent = 'Copy failed — select it by hand'
      }
    })()
  }

  let timer: ReturnType<typeof setInterval> | null = null
  const finish = (): void => {
    if (timer !== null) clearInterval(timer)
    back.remove()
  }
  cancelBtn.onclick = finish

  const showWaiting = (view: { id: string; art: string; mismatch: boolean }): void => {
    input.style.display = 'none'
    guide.style.display = 'none'
    codeRow.style.display = 'none'
    qrBox.style.display = 'none'
    note.style.display = 'none'
    pairBtn.style.display = 'none'
    if (view.art) {
      art.textContent = view.art
      art.style.display = 'block'
    }
    idLine.textContent = 'device id: ' + view.id.slice(0, 12) + '…'
    idLine.style.display = 'block'
    hint.style.display = 'block'
    if (view.mismatch) {
      // The one case where the operator must not approve: the grid cannot be vouched for.
      art.style.borderColor = '#b4402f'
      msg.textContent = 'STOP — do not approve this device.'
      msg.style.color = '#ff9d8a'
      hint.innerHTML =
        'The key your server staged is <b>not the key on this device</b>, so ' +
        'something between them changed it. Reject it on the server:' +
        '<br><code style="font:12px ui-monospace,monospace;color:#9ad">node scripts/ew-auth.mjs pending</code>' +
        '<br>Then check the server URL below and pair again over a trusted path ' +
        '(<code style="font:12px ui-monospace,monospace;color:#9ad">tailscale serve</code>, docs/getting-started.md).'
      return
    }
    msg.textContent = 'Your server is waiting to approve this device.'
    hint.innerHTML =
      'Check that this pattern matches the one your server shows, then approve it there:' +
      '<br><code style="font:12px ui-monospace,monospace;color:#9ad">node scripts/ew-auth.mjs pending</code>' +
      '<br>Waiting for approval…'
  }

  const approved = (text: string): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    title.textContent = 'Paired'
    msg.textContent = text
    hint.style.display = 'none'
    cancelBtn.textContent = 'Close'
    hooks.log('pairing approved')
    hooks.onPaired()
  }

  const doSubmit = async (code: string): Promise<void> => {
    pairBtn.disabled = true
    input.disabled = true
    msg.textContent = 'Contacting server…'
    const r = await submitPairing(code)
    if (!r || r.error || (r.status !== 'pending' && r.status !== 'approved')) {
      pairBtn.disabled = false
      input.disabled = false
      // Reveal the guide even in URL mode: a failed submit is the first-run case.
      guide.style.display = 'block'
      msg.textContent =
        r?.error === 'pairing closed'
          ? 'The pairing window closed, or it was already used — one window pairs one device.' +
            ' Run `ew-auth pair` again on the server.'
          : r?.error === 'bad code'
            ? 'That pairing code is invalid. Copy it again from the' +
              ' `ew-auth pair` output — a code is single-use and expires in a few minutes.'
            : r?.error === 'bad key'
              ? 'The server rejected this device key. Reload the app and try' +
                ' once more; if it keeps happening, this WebView may not support WebCrypto keys.'
              : 'Could not reach the server. Check the address in the `server` field just above this' +
                ' dialog (▶ connection), and that the server is running.'
      hooks.log(`pairing submit failed: ${r?.error ?? r?.status ?? 'no response'}`)
      return
    }
    // This device's own id, from the key `submitPairing` generated. The grid is drawn from it
    // and approval is polled for it, never for the id the response names.
    const localId = (await clientId()) ?? ''
    const view = pairingArtView(localId, r.id ?? '', r.art ?? '')
    const id = view.id
    // Warn about a refused approval before the operator goes to the server.
    if (r.slots) {
      const sl = slotLine(r.slots.used, r.slots.max, r.status === 'approved')
      slotEl.textContent = sl.text
      slotEl.style.color = sl.blocked ? '#ffb46e' : '#9a9a9a'
      slotEl.style.display = 'block'
      hooks.log(
        `pairing slots: ${r.slots.used}/${r.slots.max || '∞'}${sl.blocked ? ' — NO FREE SLOT' : ''}`,
      )
    }
    hooks.log(
      `pairing submitted: ${r.status} ${id.slice(0, 12)}${view.mismatch ? ' ART MISMATCH — staged key is not ours' : ''}`,
    )
    showWaiting(view)
    if (view.mismatch) return // nothing to wait for: approving this would authorise another key
    if (r.status === 'approved') {
      approved('This key was already enrolled — session re-established.')
      return
    }
    timer = setInterval(() => {
      void (async () => {
        const st = await pairStatus(id)
        if (st === 'approved') approved('This device is now paired.')
        else if (st === 'rejected') {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
          title.textContent = 'Rejected'
          msg.textContent = 'The server rejected this device. Run `ew-auth pair` again to retry.'
          hint.style.display = 'none'
          hooks.log('pairing rejected by operator')
        } else if (st === 'unknown') {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
          title.textContent = 'Expired'
          msg.textContent = 'The pairing request expired. Run `ew-auth pair` again to retry.'
          hint.style.display = 'none'
          hooks.log('pairing request expired')
        }
      })()
    }, POLL_MS)
  }

  pairBtn.onclick = () => {
    if (initialCode) {
      void doSubmit(initialCode)
      return
    }
    const { code, server } = pairingTarget(input.value)
    if (!code) {
      msg.textContent = 'Enter the pairing code, or paste the whole pairing URL from your server.'
      return
    }
    // A pasted URL may name the API base (see `pairingTarget`); the note names the origin adopted.
    const base = normaliseOrigin(hooks.serverBase())
    if (server && server !== base) {
      hooks.log(`pairing: the pasted URL names ${server} — adopting it as the server`)
      note.textContent = `Using the server named by that URL: ${server}`
      note.style.display = 'block'
      hooks.onServerUrl(server)
    }
    void doSubmit(code)
  }
}

/** URL-triggered pairing (`?pair=<code>` / `#pair=<code>`). Returns true if a dialog opened.
 *  The app keeps booting underneath (see the header). */
export function maybeStartPairing(hooks: PairingHooks): boolean {
  const code = takeCode()
  if (!code) return false
  void runDialog(code, hooks)
  return true
}

/** The debug pad's "pair" button: manual code entry. */
export function openPairingDialog(hooks: PairingHooks): void {
  void runDialog('', hooks)
}
