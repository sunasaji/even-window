// The card that asks for the server address.
//
// The packaged app is served by the Even App, so it cannot guess where the user's server is
// and falls back to a loopback address that leads nowhere on a phone. A device that has no
// key gets the pairing dialog, whose pairing URL carries the address. A device that already
// holds a key (the Even App keeps it across installs) only lacks the address, and pairing it
// again would enrol a second key, so it gets this card.

import { normaliseOrigin } from '../shared/sessionBinding.ts'

/** Should the client ask where the server is? Pure.
 *  Only when nobody chose the address (`guessed`) and that guess did not answer (`offline`).
 *  A chosen address that is down is an outage, not a missing setting. */
export function needsServerAddress(guessed: boolean, offline: boolean): boolean {
  return guessed && offline
}

/** The server origin named by what the user typed or pasted, or `''`. Pure.
 *  Accepts an origin, any URL on the server, a pairing URL (whose `server=` wins) and a bare
 *  `host:port`, which is taken as https because a phone reaches the server through a TLS
 *  proxy (docs/getting-started.md). */
export function serverFromInput(raw: string): string {
  const t = (raw || '').trim()
  if (!t) return ''
  const explicit = t.match(/[?&]server=([^&#\s]+)/)
  if (explicit?.[1]) {
    try {
      const named = normaliseOrigin(decodeURIComponent(explicit[1]))
      if (/^https?:\/\//.test(named)) return named
    } catch {
      /* malformed escape: fall through to the URL itself */
    }
  }
  const origin = normaliseOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
  return /^https?:\/\//.test(origin) ? origin : ''
}

const BTN =
  'padding:8px 18px;font:14px system-ui;border:1px solid #555;border-radius:6px;background:#2d2d2d;color:#e5e5e5;cursor:pointer'

const el = (tag: string, style: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.style.cssText = style
  if (text) e.textContent = text
  return e
}

export interface ServerSetupOpts {
  /** The address that did not answer, shown so the user sees what was tried. */
  tried: string
  /** Tapped "Connect" with a usable address. */
  onServer(origin: string): void
}

/** The card. Nothing changes until `onServer` fires; "Later" leaves the guess in place. */
export function openServerSetup(o: ServerSetupOpts): void {
  document.getElementById('ew-server-setup')?.remove()

  // Below the pairing card (99999) and the server-change confirm (100000): both are answers to
  // something the user did, and this one is unprompted.
  const back = el(
    'div',
    'position:fixed;inset:0;z-index:99998;background:#151515e8;color:#e5e5e5;display:flex;align-items:flex-start;justify-content:center;font:14px/1.4 system-ui,sans-serif;padding:16px;box-sizing:border-box;overflow:auto',
  )
  back.id = 'ew-server-setup'
  const card = el(
    'div',
    'max-width:520px;width:100%;background:#232323;border:1px solid #555;border-radius:10px;padding:18px',
  )
  const title = el('div', 'font:600 17px system-ui;margin-bottom:8px', 'Where is your server?')
  const msg = el(
    'div',
    'margin-bottom:12px;color:#bdbdbd',
    'PinholeWindow shows a window from the server on your own PC. Enter the address this phone ' +
      'reaches it at, for example https://host.ts.net:8443. A pairing URL works too.',
  )
  const tried = el(
    'div',
    'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#888;word-break:break-all;margin-bottom:8px',
    `no answer from ${o.tried}`,
  )
  const field = el(
    'input',
    'width:100%;box-sizing:border-box;padding:9px;font:16px ui-monospace,monospace;background:#000;color:#e5e5e5;border:1px solid #333;border-radius:6px',
  ) as HTMLInputElement
  field.type = 'url'
  field.placeholder = 'https://host.ts.net:8443'
  field.autocapitalize = 'off'
  field.autocomplete = 'off'
  field.spellcheck = false
  const err = el('div', 'min-height:18px;margin-top:6px;color:#ff9d8a;font:12px system-ui')
  const btnRow = el('div', 'display:flex;gap:10px;justify-content:flex-end;margin-top:10px')
  const laterBtn = el('button', BTN, 'Later') as HTMLButtonElement
  const goBtn = el('button', BTN + ';border-color:#8ab4ff', 'Connect') as HTMLButtonElement
  btnRow.append(laterBtn, goBtn)
  card.append(title, msg, tried, field, err, btnRow)
  back.append(card)
  document.body.append(back)

  const submit = (): void => {
    const origin = serverFromInput(field.value)
    if (!origin) {
      err.textContent = 'That is not a server address. It looks like https://host:port.'
      return
    }
    back.remove()
    o.onServer(origin)
  }
  laterBtn.onclick = () => back.remove()
  goBtn.onclick = submit
  field.onkeydown = e => {
    if (e.key === 'Enter') submit()
  }
}
