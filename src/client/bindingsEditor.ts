// pinhole-window — the per-app bindings editor (the `▶ app` panel).
//
// Client modules import each other freely, but only from inside functions: nothing here may use
// another non-leaf module while this one is still loading.

import {
  type AppBinding,
  type AppIdentity,
  appKeys,
  type BindingMap,
  bindingLabel,
  DEFAULT_BINDING_KEY,
  DEFAULT_SWIPE,
  extrasSuffix,
  KEY_KIND_LABEL,
  keyKind,
  preferredKey,
  resolveFontsize,
  resolveNewline,
  resolveSubmit,
  resolveSwipe,
} from '../shared/bindings.ts'
import {
  type Chord,
  chordCommand,
  chordLabel,
  chordToXdo,
  FONTSIZE_DEFAULT,
  FONTSIZE_STEPS,
  type FontStep,
  fontInjectLabel,
  fontStepById,
  GROUP_LABEL,
  KEYS,
  type KeyGroup,
  keyDef,
  MODS,
  type Mod,
  NEWLINE_CHORDS,
  NEWLINE_DEFAULT,
  newlineChordById,
  SUBMIT_CHORDS,
  SUBMIT_DEFAULT,
  SUBMIT_GROUP_LABEL,
  type SubmitChord,
  type SubmitGroup,
  submitChordById,
  submitChordLabel,
} from '../shared/keys.ts'
import type { WinInfo } from '../shared/types.ts'
import { button, SELECT_CHROME, setLit } from './chrome.ts'
import { log } from './debugLog.ts'
import { windows } from './menu.ts'
import { apiPost } from './serverLink.ts'

/** The bindings in force, from `{t:'bindings'}`. Server-owned; this is a cache for the editor
 *  and for the summary line, never the thing a swipe is resolved against. */
export let bindings: BindingMap = {}

let appSumEl: HTMLElement | null = null
let appNoteEl: HTMLElement | null = null
let appTargetEl: HTMLSelectElement | null = null
let appTargetSig = ''
let appWarnEl: HTMLElement | null = null
let appListEl: HTMLElement | null = null

/** One half of the editor: the three modifier toggles, the key picker, and the live `→ ctrl+u`
 *  readout, which is the exact string handed to `xdotool key`. */
interface ChordEditor {
  mods: { mod: Mod; el: HTMLButtonElement }[]
  sel: HTMLSelectElement
  xdoEl: HTMLElement
}

let upEd: ChordEditor | null = null
let downEd: ChordEditor | null = null
interface SendRow {
  noteEl: HTMLElement
  sel: HTMLSelectElement
  xdoEl: HTMLElement
}
let submitEd: SendRow | null = null
let newlineEd: SendRow | null = null
let fontsizeEd: SendRow | null = null

/** The row being edited: which binding key, and the two chords. Mutated by the controls and
 *  read by `applyBinding`; nothing is sent until `apply`. */
let editKey = ''

/** Has the human touched this editor yet?
 *
 *  Until they have, the editor follows the focused app. Once anything is touched (the target, a
 *  modifier, a key) it pins, so a window switch arriving over SSE mid-edit cannot wipe what was
 *  being assembled. */
let editTouched = false
const edit: { up: Chord; down: Chord; submit: string; newline: string; fontsize: string } = {
  up: { mods: [], key: DEFAULT_SWIPE.up.key },
  down: { mods: [], key: DEFAULT_SWIPE.down.key },
  submit: SUBMIT_DEFAULT.id,
  newline: NEWLINE_DEFAULT.id,
  fontsize: FONTSIZE_DEFAULT.id,
}

/** Keys whose repeat is not harmless. A swipe burst is a move-N by design (docs/glasses.md), so
 *  whatever is bound fires `count` times; the editor warns when one of these is bound. */
const REPEAT_RISKY: readonly string[] = ['Return', 'KP_Enter', 'Delete', 'BackSpace']

export function activeWin(): WinInfo | null {
  return windows.find(w => w.active) ?? null
}

export function setBindings(map: BindingMap): void {
  bindings = map
  renderAppPanel()
}

/** Which key `Submit` presses in `w`, as a catalogue entry.
 *
 *  The fallback is the default, not `off`: an id this build does not know (from a bindings.json
 *  validated against another catalogue) must not silently stop running lines. */
export function submitChordFor(w: AppIdentity | null): SubmitChord {
  return submitChordById(resolveSubmit(bindings, w).id) ?? SUBMIT_DEFAULT
}

/** What a line break in the box becomes in `w`. Same shape and fallback rule as
 *  `submitChordFor`. */
export function newlineChordFor(w: AppIdentity | null): SubmitChord {
  return newlineChordById(resolveNewline(bindings, w).id) ?? NEWLINE_DEFAULT
}

/** What `font −` / `font +` press in `w`. Same shape and fallback rule. */
export function fontStepFor(w: AppIdentity | null): FontStep {
  return fontStepById(resolveFontsize(bindings, w).id) ?? FONTSIZE_DEFAULT
}

/** Pure: the target pulldown's options, in order: every identity the focused window has (in
 *  resolution order), then the global default, then everything else already bound.
 *
 *  All identities are offered because they are different promises: `exe:` follows the program,
 *  `app:` follows the launcher entry (and separates two entries running the same binary),
 *  `cls:` survives when no pid is readable. Deduplicated, because the focused window's identity
 *  is usually also one of the bound keys. */
export function bindTargets(w: AppIdentity | null, map: BindingMap): string[] {
  const own = w ? appKeys(w).filter(k => k !== DEFAULT_BINDING_KEY) : []
  return [...new Set([...own, DEFAULT_BINDING_KEY, ...Object.keys(map)])]
}

/** Pure: what the editor shows for `key`: that entry if it exists, otherwise the value the
 *  focused app would get today (the inherited one). Because the editor opens on the value in
 *  force, committing it unchanged cannot undo an inherited binding. */
export function editorBase(key: string, map: BindingMap, w: AppIdentity | null): AppBinding {
  const own = map[key]
  if (own) return own
  if (key === DEFAULT_BINDING_KEY) return DEFAULT_SWIPE
  return resolveSwipe(map, w).binding
}

/** Pure: which submit key the editor shows for `key`: this entry's own, else the one the
 *  focused app would get today.
 *
 *  Separate from `editorBase` because `submit` resolves separately (`resolveSubmit`): an entry
 *  can hold a swipe and no submit key, and the row must then show the inherited value. */
export function editorSubmit(key: string, map: BindingMap, w: AppIdentity | null): string {
  const own = map[key]?.submit
  if (own !== undefined) return own
  if (key === DEFAULT_BINDING_KEY) return SUBMIT_DEFAULT.id
  return resolveSubmit(map, w).id
}

/** Pure: which newline key the editor shows for `key`. Same inheritance rule as `editorSubmit`. */
export function editorNewline(key: string, map: BindingMap, w: AppIdentity | null): string {
  const own = map[key]?.newline
  if (own !== undefined) return own
  if (key === DEFAULT_BINDING_KEY) return NEWLINE_DEFAULT.id
  return resolveNewline(map, w).id
}

/** Pure: which fontsize pair the editor shows for `key`. Same rule as `editorSubmit`. */
export function editorFontsize(key: string, map: BindingMap, w: AppIdentity | null): string {
  const own = map[key]?.fontsize
  if (own !== undefined) return own
  if (key === DEFAULT_BINDING_KEY) return FONTSIZE_DEFAULT.id
  return resolveFontsize(map, w).id
}

/** Point the editor at `key` and fill it from `editorBase`. Copies the chords, so editing the
 *  row cannot mutate the map the server sent us. */
function loadEditor(key: string): void {
  editKey = key
  const w = activeWin()
  const base = editorBase(key, bindings, w)
  edit.up = { mods: [...base.up.mods], key: base.up.key }
  edit.down = { mods: [...base.down.mods], key: base.down.key }
  edit.submit = editorSubmit(key, bindings, w)
  edit.newline = editorNewline(key, bindings, w)
  edit.fontsize = editorFontsize(key, bindings, w)
}

/** The key picker: every catalogue entry, grouped. Built once: re-creating the options under a
 *  native picker the user has open loses the selection being made. */
function buildKeySelect(): HTMLSelectElement {
  const sel = document.createElement('select')
  sel.style.cssText =
    SELECT_CHROME + 'flex:1;min-width:0;padding:5px 6px;font:14px ui-monospace,monospace'
  const groups = new Map<KeyGroup, HTMLOptGroupElement>()
  for (const k of KEYS) {
    let g = groups.get(k.group)
    if (!g) {
      g = document.createElement('optgroup')
      g.label = GROUP_LABEL[k.group]
      groups.set(k.group, g)
      sel.appendChild(g)
    }
    const o = document.createElement('option')
    o.value = k.name
    // Both spellings on the row: the friendly one to recognise, the keysym because it is what
    // gets sent and what a log line says.
    o.textContent = k.label === k.name ? k.name : `${k.label}  (${k.name})`
    g.appendChild(o)
  }
  return sel
}

function buildChordEditor(dir: 'up' | 'down'): { row: HTMLDivElement; ed: ChordEditor } {
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px'

  const tag = document.createElement('span')
  tag.style.cssText = 'font:12px ui-monospace,monospace;color:#9ad;min-width:46px'
  tag.textContent = dir === 'up' ? '▲ up' : '▼ dn'
  row.appendChild(tag)

  const mods: { mod: Mod; el: HTMLButtonElement }[] = []
  for (const m of MODS) {
    const label = m === 'ctrl' ? 'Ctrl' : m === 'alt' ? 'Alt' : 'Shift'
    const b = button(
      label,
      () => {
        const c = edit[dir]
        const on = c.mods.includes(m)
        // Rebuilt in MODS order rather than pushed, so the record is already canonical.
        c.mods = MODS.filter(x => (x === m ? !on : c.mods.includes(x)))
        editTouched = true
        renderAppPanel()
      },
      `hold ${label} with the ${dir === 'up' ? 'up' : 'down'} key`,
    )
    b.style.cssText = 'font:11px system-ui'
    mods.push({ mod: m, el: b })
    row.appendChild(b)
  }

  const sel = buildKeySelect()
  sel.addEventListener('change', () => {
    edit[dir].key = sel.value
    editTouched = true
    renderAppPanel()
  })
  row.appendChild(sel)

  const xdoEl = document.createElement('span')
  xdoEl.style.cssText = 'font:11px ui-monospace,monospace;color:#5f6;min-width:92px'
  row.appendChild(xdoEl)

  return { row, ed: { mods, sel, xdoEl } }
}

/** The `submit` and `newline` rows: one closed list, as one native pulldown each.
 *
 *  They live in this panel because the value is remembered per application, and the `app`
 *  pulldown above them is what states the scope.
 *
 *  No modifier toggles, unlike the chord rows: the question is which one chord does the job
 *  (see `SUBMIT_CHORDS` in src/shared/keys.ts).
 *
 *  One builder for both rows, so the gate, the note line and the xdotool preview cannot drift.
 *  Only the list differs; `newline` gets the narrower one (`NEWLINE_CHORDS`). */
function buildSendRow(kind: 'submit' | 'newline'): {
  row: HTMLDivElement
  noteEl: HTMLElement
  sel: HTMLSelectElement
  xdoEl: HTMLElement
} {
  const rows = kind === 'submit' ? SUBMIT_CHORDS : NEWLINE_CHORDS
  const gate = kind === 'submit' ? submitChordById : newlineChordById

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px'

  const tag = document.createElement('span')
  tag.style.cssText = 'font:12px ui-monospace,monospace;color:#9ad;min-width:46px'
  tag.textContent = kind
  tag.title =
    kind === 'submit'
      ? 'the key Submit presses after the text. `off` types without running, and holding Submit' +
        ' leaves it out for one send'
      : 'what a line break in the box becomes. `Return` in a terminal; `S-Enter` in a chat box,' +
        ' where Return would send each line instead of breaking it'
  row.appendChild(tag)

  const sel = document.createElement('select')
  // `SELECT_CHROME`, like the chord pulldowns beside it. The dark fill depends on
  // `color-scheme:dark` (see SELECT_CHROME).
  sel.style.cssText =
    SELECT_CHROME + 'flex:1;min-width:0;padding:5px 6px;font:14px ui-monospace,monospace'
  let group: SubmitGroup | null = null
  let g: HTMLOptGroupElement | null = null
  for (const s of rows) {
    if (!g || s.group !== group) {
      g = document.createElement('optgroup')
      g.label = SUBMIT_GROUP_LABEL[s.group]
      group = s.group
      sel.appendChild(g)
    }
    const o = document.createElement('option')
    o.value = s.id
    o.textContent = submitChordLabel(s)
    o.title = `${s.chord ? chordToXdo(s.chord) : 'nothing'} — ${s.note}`
    g.appendChild(o)
  }
  sel.addEventListener('change', () => {
    // The list is the gate, here as on the server: a value that is not in the catalogue never
    // becomes the thing Submit presses.
    const next = gate(sel.value)
    if (!next) {
      sel.value = edit[kind]
      return
    }
    edit[kind] = next.id
    editTouched = true
    renderAppPanel()
  })
  row.appendChild(sel)

  const xdoEl = document.createElement('span')
  xdoEl.style.cssText = 'font:11px ui-monospace,monospace;color:#5f6;min-width:92px'
  row.appendChild(xdoEl)

  // The selected entry's note, on its own line under the row. On screen rather than only in the
  // `<option>`'s `title`, because a phone has no hover and for `C-s` and `C-d` the note is a
  // warning (XOFF; logout).
  const noteEl = document.createElement('div')
  noteEl.style.cssText = 'margin:2px 0 0 52px;font:11px/1.45 system-ui;color:#888'

  return { row, noteEl, sel, xdoEl }
}

/** The `fontsize` row: which zoom convention `font −` / `font +` follow in this app.
 *
 *  `buildSendRow`'s shape (tag, pulldown, xdotool preview, note line) but its own builder: the
 *  entries are pairs of injection sequences rather than one chord, so the preview and the gate
 *  differ. */
function buildFontsizeRow(): {
  row: HTMLDivElement
  noteEl: HTMLElement
  sel: HTMLSelectElement
  xdoEl: HTMLElement
} {
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px'

  const tag = document.createElement('span')
  tag.style.cssText = 'font:12px ui-monospace,monospace;color:#9ad;min-width:46px'
  tag.textContent = 'fontsize'
  tag.title = 'what `font −` / `font +` press in this app — every app spells "zoom" its own way'
  row.appendChild(tag)

  const sel = document.createElement('select')
  sel.style.cssText =
    SELECT_CHROME + 'flex:1;min-width:0;padding:5px 6px;font:14px ui-monospace,monospace'
  for (const f of FONTSIZE_STEPS) {
    const o = document.createElement('option')
    o.value = f.id
    o.textContent = f.label
    o.title = `+ ${fontInjectLabel(f.bigger)} / − ${fontInjectLabel(f.smaller)} — ${f.note}`
    sel.appendChild(o)
  }
  sel.addEventListener('change', () => {
    const next = fontStepById(sel.value)
    if (!next) {
      sel.value = edit.fontsize
      return
    }
    edit.fontsize = next.id
    editTouched = true
    renderAppPanel()
  })
  row.appendChild(sel)

  const xdoEl = document.createElement('span')
  xdoEl.style.cssText = 'font:11px ui-monospace,monospace;color:#5f6;min-width:92px'
  row.appendChild(xdoEl)

  const noteEl = document.createElement('div')
  noteEl.style.cssText = 'margin:2px 0 0 52px;font:11px/1.45 system-ui;color:#888'

  return { row, noteEl, sel, xdoEl }
}

async function applyBinding(): Promise<void> {
  if (!editKey) {
    log('app: no target selected')
    return
  }
  const body = {
    key: editKey,
    up: edit.up,
    down: edit.down,
    submit: edit.submit,
    newline: edit.newline,
    fontsize: edit.fontsize,
  }
  const r = await apiPost<{ ok?: boolean; msg?: string; map?: BindingMap }>('/api/bindings', body)
  if (!r?.ok) {
    log(`app: ${editKey} refused — ${r?.msg ?? 'no answer'}`)
    return
  }
  const press = submitChordById(edit.submit)
  const brk = newlineChordById(edit.newline)
  log(
    `app: ${editKey} → up=${chordCommand(edit.up)} down=${chordCommand(edit.down)}` +
      ` submit=${press?.chord ? chordToXdo(press.chord) : 'none'}` +
      ` newline=${brk?.chord ? chordToXdo(brk.chord) : 'none'}` +
      ` fontsize=${edit.fontsize}`,
  )
  // The SSE event carries this too; applying the answer as well keeps the panel correct on a
  // client whose stream is momentarily down.
  if (r.map) setBindings(r.map)
}

async function clearBinding(key: string): Promise<void> {
  const r = await apiPost<{ ok?: boolean; msg?: string; map?: BindingMap }>('/api/bindings', {
    key,
    clear: true,
  })
  if (!r?.ok) {
    log(`app: clearing ${key} failed — ${r?.msg ?? 'no answer'}`)
    return
  }
  log(`app: ${key} unbound — it inherits again`)
  if (r.map) setBindings(r.map)
  // Whatever the editor was showing for that key is now the inherited value, not an override.
  if (key === editKey) loadEditor(editKey)
  renderAppPanel()
}

/** The `▶ app` panel: everything this app is bound to (the two swipe chords, the submit and
 *  newline keys, the fontsize pair).
 *
 *  Folded by default and placed with the tools: these are set once per app. The summary carries
 *  the state and leads with the submit key, which decides whether a line is typed or run. */
export function buildAppPanel(): HTMLDetailsElement {
  const box = document.createElement('details')
  box.style.cssText = 'margin:0 0 8px'

  appSumEl = document.createElement('summary')
  box.appendChild(appSumEl)

  appNoteEl = document.createElement('div')
  appNoteEl.style.cssText =
    'margin:6px 0 0;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;' +
    'color:#888;white-space:pre-wrap;word-break:break-word'
  box.appendChild(appNoteEl)

  // The target: which app is being bound. Explicit, so the global default is editable and it is
  // clear whether one app or all of them is about to change.
  const tRow = document.createElement('div')
  tRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:8px'
  const tTag = document.createElement('span')
  tTag.style.cssText = 'font:12px ui-monospace,monospace;color:#9ad;min-width:46px'
  tTag.textContent = 'app'
  appTargetEl = document.createElement('select')
  appTargetEl.style.cssText =
    SELECT_CHROME + 'flex:1;min-width:0;padding:5px 6px;font:13px ui-monospace,monospace'
  appTargetEl.addEventListener('change', () => {
    editTouched = true
    loadEditor(appTargetEl?.value ?? '')
    renderAppPanel()
  })
  tRow.append(tTag, appTargetEl)
  box.appendChild(tRow)

  const up = buildChordEditor('up')
  const dn = buildChordEditor('down')
  upEd = up.ed
  downEd = dn.ed
  const sub = buildSendRow('submit')
  const nl = buildSendRow('newline')
  const fs = buildFontsizeRow()
  submitEd = sub
  newlineEd = nl
  fontsizeEd = fs
  box.append(up.row, dn.row, sub.row, sub.noteEl, nl.row, nl.noteEl, fs.row, fs.noteEl)

  appWarnEl = document.createElement('div')
  appWarnEl.style.cssText = 'margin:6px 0 0;font:11px/1.4 system-ui;color:#ffb46e;display:none'
  box.appendChild(appWarnEl)

  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;gap:6px;margin-top:8px;align-items:center'
  const applyBtn = button(
    'apply',
    () => {
      void applyBinding()
    },
    'store this up/down pair for the selected app',
  )
  const clearBtn = button(
    'clear',
    () => {
      if (editKey) void clearBinding(editKey)
    },
    "remove this app's binding so it inherits the default again",
  )
  for (const b of [applyBtn, clearBtn]) b.style.cssText = 'font:11px system-ui'
  actions.append(applyBtn, clearBtn)
  box.appendChild(actions)

  // Everything currently stored. A binding on another identity of the same app can explain a
  // swipe that "ignores" the row being edited, so the whole map is listed; each row has its
  // own ✕.
  appListEl = document.createElement('div')
  appListEl.style.cssText = 'margin:8px 0 0;display:flex;flex-direction:column;gap:4px'
  box.appendChild(appListEl)

  loadEditor(DEFAULT_BINDING_KEY)
  renderAppPanel()
  return box
}

/** Repaint everything the panel shows from `bindings` + the focused window. Called on every
 *  control, on `{t:'bindings'}` and on `{t:'windows'}` — the focused app is half the state. */
export function renderAppPanel(): void {
  if (!appSumEl) return
  const w = activeWin()
  const eff = resolveSwipe(bindings, w)
  const sub = resolveSubmit(bindings, w)
  const subChord = submitChordFor(w)
  const nl = resolveNewline(bindings, w)
  const nlChord = newlineChordFor(w)
  const fs = resolveFontsize(bindings, w)
  const fsStep = fontStepFor(w)

  // The folded line: what this app does right now, and where that came from. `(default)`
  // distinguishes "nothing is bound" from "something is bound to the arrows".
  //
  // Submit leads: this line is the only always-visible statement of whether pressing `Submit`
  // types a line or runs it (docs/phone-ui.md), so the key is spelled out.
  appSumEl.textContent =
    `app — submit ${submitChordLabel(subChord)}` +
    (sub.via ? ` via ${sub.via}` : ' (default)') +
    ` · swipe ${bindingLabel(eff.binding)}` +
    (eff.via ? ` via ${eff.via}` : ' (default)')

  const ids = appKeys(w).filter(k => k !== DEFAULT_BINDING_KEY)
  // The window has only a title. A `title:` binding stops matching when the app renames its
  // window, so it is offered (some programs publish neither WM_CLASS, _NET_WM_PID nor
  // WM_COMMAND) but never silently.
  const titleOnly = ids.some(k => k.startsWith('title:'))
  if (appNoteEl) {
    appNoteEl.textContent =
      (w
        ? `focused: ${w.title || w.cls || w.wid}  [${ids.join(' → ') || 'no app id'}]`
        : 'no focused window — only the default is editable') +
      (w && ids.length === 0
        ? '\nthis window has no identity at all: only the default (*) can hold a binding for it'
        : '') +
      (titleOnly
        ? '\nonly a title to key on (no pid, no WM_CLASS, no WM_COMMAND) — a title binding stops' +
          ' matching if the app renames its own window'
        : '') +
      `\nin force: ${bindingLabel(eff.binding)} ${eff.via ? `from ${eff.via}` : '(built-in default)'}` +
      // Separately, because it resolves separately: an app can take its swipe from `comm:xterm`
      // and its submit key from `*`.
      `\nin force: submit=${submitChordLabel(subChord)} ${sub.via ? `from ${sub.via}` : '(built-in default)'}` +
      `\nin force: newline=${submitChordLabel(nlChord)} ${nl.via ? `from ${nl.via}` : '(built-in default)'}` +
      `\nin force: fontsize=${fsStep.label} ${fs.via ? `from ${fs.via}` : '(built-in default)'}` +
      `\norder: app → exe → comm → cls → title → * → built-in`
  }

  // The target options: this app, the default, and anything already bound. Rebuilt only when
  // the set changes: a native picker that is open when its options are replaced loses the
  // user's selection, and `{t:'windows'}` can arrive while someone is choosing.
  if (appTargetEl) {
    const pref = preferredKey(w)
    const keys = bindTargets(w, bindings)
    const sig = keys.join('\u0001') + '\u0002' + Object.keys(bindings).join('\u0001')
    if (sig !== appTargetSig) {
      appTargetSig = sig
      appTargetEl.textContent = ''
      for (const k of keys) {
        const o = document.createElement('option')
        o.value = k
        // Each row says what kind of identity it is; `✓` marks the ones that already hold a
        // binding.
        const bound = bindings[k] ? ' ✓' : ''
        o.textContent =
          k === DEFAULT_BINDING_KEY
            ? `every app (*)${bound}`
            : `${k} · ${KEY_KIND_LABEL[keyKind(k)]}${bound}`
        appTargetEl.appendChild(o)
      }
    }
    // Follow the focused app until the editor is touched (see `editTouched`), and re-point if
    // the key being edited has left the list (its binding was cleared elsewhere).
    //
    // Reloaded on every render while untouched, not only when the key changes: `{t:'windows'}`
    // and `{t:'bindings'}` arrive in either order, so the editor may have been filled from an
    // empty map. `apply` on an untouched editor would then write the stale value as an override.
    const want = editTouched && keys.includes(editKey) ? editKey : pref || DEFAULT_BINDING_KEY
    if (want !== editKey || !editTouched) loadEditor(want)
    appTargetEl.value = editKey
  }

  // The two chord rows: toggles lit from the record, picker on the record's key, and the exact
  // xdotool string next to each.
  for (const [dir, ed] of [
    ['up', upEd],
    ['down', downEd],
  ] as const) {
    if (!ed) continue
    const c = edit[dir]
    for (const m of ed.mods) setLit(m.el, c.mods.includes(m.mod))
    if (ed.sel.value !== c.key) ed.sel.value = c.key
    ed.xdoEl.textContent = `→ ${chordCommand(c)}`
  }

  // The submit and newline rows: each picker on the record's id, and the exact xdotool string
  // beside it. `off` shows `(nothing)`, not an empty cell, so it reads as "presses nothing".
  for (const [ed, pick] of [
    [submitEd, submitChordById(edit.submit) ?? SUBMIT_DEFAULT],
    [newlineEd, newlineChordById(edit.newline) ?? NEWLINE_DEFAULT],
  ] as const) {
    if (!ed) continue
    if (ed.sel.value !== pick.id) ed.sel.value = pick.id
    ed.xdoEl.textContent = `→ ${pick.chord ? chordToXdo(pick.chord) : '(nothing)'}`
    ed.noteEl.textContent = pick.note
  }
  if (fontsizeEd) {
    const pick = fontStepById(edit.fontsize) ?? FONTSIZE_DEFAULT
    if (fontsizeEd.sel.value !== pick.id) fontsizeEd.sel.value = pick.id
    fontsizeEd.xdoEl.textContent = `→ + ${fontInjectLabel(pick.bigger)}`
    fontsizeEd.noteEl.textContent = `${pick.note}  (− ${fontInjectLabel(pick.smaller)})`
  }

  if (appWarnEl) {
    const warn: string[] = []
    for (const dir of ['up', 'down'] as const) {
      const c = edit[dir]
      if (REPEAT_RISKY.includes(c.key)) {
        warn.push(
          `A swipe burst repeats the key (move-N), so ${chordLabel(c)} on ${dir} fires ` +
            'once per swipe in the burst — five swipes is five of them.',
        )
      }
      if (c.mods.includes('shift') && keyDef(c.key)?.shiftsToGlyph) {
        warn.push(
          `Shift+${c.key} sends a different character (the shifted glyph), not a ` +
            'shifted key — which is usually not what a binding wants.',
        )
      }
    }
    appWarnEl.textContent = warn.join(' ')
    appWarnEl.style.display = warn.length ? 'block' : 'none'
  }

  if (appListEl) {
    appListEl.textContent = ''
    const entries = Object.entries(bindings)
    if (entries.length === 0) {
      const none = document.createElement('div')
      none.style.cssText = 'font:11px system-ui;color:#777'
      none.textContent = 'nothing bound — every app gets Up / Down'
      appListEl.appendChild(none)
    }
    // `*` last, so the list reads in the order it resolves.
    entries.sort(([a], [b]) =>
      a === DEFAULT_BINDING_KEY ? 1 : b === DEFAULT_BINDING_KEY ? -1 : a.localeCompare(b),
    )
    for (const [k, b] of entries) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:6px;align-items:center'
      const txt = document.createElement('span')
      txt.style.cssText =
        'flex:1;min-width:0;font:11px ui-monospace,monospace;color:#cfe;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      txt.textContent = `${k}  ${bindingLabel(b)}${extrasSuffix(b)}`
      const x = button(
        '✕',
        () => {
          void clearBinding(k)
        },
        `unbind ${k}`,
      )
      x.style.cssText = 'font:11px system-ui'
      row.append(txt, x)
      appListEl.appendChild(row)
    }
  }
}
