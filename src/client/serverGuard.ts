// A link may not silently repoint a paired device at another server.
//
// `?server=` accepts an arbitrary URL and points the auth handshake at it. A paired device
// proves its identity to whatever base it is given and sends its input there, so a changed
// base on a paired device needs one human tap. An unpaired device has no identity to relay
// and is left alone. The signature is additionally bound to the origin
// (src/shared/sessionBinding.ts); this guard is the part a human sees.

/** Does this `?server=` need a human tap before it is adopted? Pure.
 *  True only when the link asks for a change (`param` differs from `stored`), a previous
 *  choice exists (`stored` non-empty) and the device is paired. `normalise` is injected so
 *  this module stays a leaf. */
export function serverChangeNeedsConfirm(
  param: string,
  stored: string,
  paired: boolean,
  normalise: (s: string) => string,
): boolean {
  if (!paired) return false
  const p = normalise(param || '')
  const s = normalise(stored || '')
  if (!p || !s) return false
  return p !== s
}

const BTN =
  'padding:8px 18px;font:14px system-ui;border:1px solid #555;border-radius:6px;background:#2d2d2d;color:#e5e5e5;cursor:pointer'

const el = (tag: string, style: string, text = ''): HTMLElement => {
  const e = document.createElement(tag)
  e.style.cssText = style
  if (text) e.textContent = text
  return e
}

export interface ServerConfirmOpts {
  from: string
  to: string
  /** Tapped "Use the new server": adopt `to` and re-handshake. */
  onAccept(): void
  /** Tapped "Keep current server". */
  onKeep(): void
}

/** The confirm card. Nothing is adopted until `onAccept` fires. */
export function confirmServerChange(o: ServerConfirmOpts): void {
  const existing = document.getElementById('ew-server-confirm')
  if (existing) existing.remove()

  // Above the pairing card (99999): when `?pair=` and `?server=` arrive together, where the
  // pairing submit goes is decided first.
  const back = el(
    'div',
    'position:fixed;inset:0;z-index:100000;background:#151515e8;color:#e5e5e5;display:flex;align-items:flex-start;justify-content:center;font:14px/1.4 system-ui,sans-serif;padding:16px;box-sizing:border-box;overflow:auto',
  )
  back.id = 'ew-server-confirm'
  const card = el(
    'div',
    'max-width:520px;width:100%;background:#232323;border:1px solid #b4402f;border-radius:10px;padding:18px;text-align:center',
  )
  const title = el(
    'div',
    'font:600 17px system-ui;margin-bottom:8px;color:#ff9d8a',
    'This link changes your server',
  )
  const msg = el(
    'div',
    'margin-bottom:12px;color:#bdbdbd',
    'A paired device proves its identity to whatever server it talks to. Only continue if you ' +
      'changed the address.',
  )
  const rows = el(
    'div',
    'font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;background:#111;border:1px solid #333;border-radius:6px;padding:10px;text-align:left;word-break:break-all',
  )
  rows.append(
    el('div', 'color:#9ad', 'now:  ' + o.from),
    el('div', 'color:#ff9d8a', 'link: ' + o.to),
  )

  const btnRow = el(
    'div',
    'display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap',
  )
  const keepBtn = el('button', BTN, 'Keep current server') as HTMLButtonElement
  const useBtn = el(
    'button',
    BTN + ';border-color:#b4402f',
    'Use the new server',
  ) as HTMLButtonElement
  btnRow.append(keepBtn, useBtn)

  card.append(title, msg, rows, btnRow)
  back.append(card)
  document.body.append(back)

  const close = (): void => {
    back.remove()
  }
  keepBtn.onclick = () => {
    close()
    o.onKeep()
  }
  useBtn.onclick = () => {
    close()
    o.onAccept()
  }
}
