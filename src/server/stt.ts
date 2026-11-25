// even-window — speech to text: the PCM the glasses captured, turned into a string.
//
// The contract is a URL, not an engine (docs/voice.md, docs/decisions/stt-backend-contract.md):
// this module speaks OpenAI's `POST /v1/audio/transcriptions` and nothing else, so the
// recogniser is a setting.
//
// The phone goes through this server instead of calling the recogniser because its identity
// is for this server only (docs/security.md), and so the audio format conversion lives in one
// place. That holds for a local recogniser on loopback and for a hosted one alike: a hosted
// one's API key stays here (`sttApiKey`).
//
// No env is read at module load: reading inside the functions keeps these settings
// independent of import order (see env.boot.ts) and lets a test set them per case.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Recognised text. `text` may be empty: "nobody spoke" is not an error. */
export interface SttOk {
  ok: true
  text: string
}
/** Something broke. `error` is for a human to read on the phone — it is never text to inject. */
export interface SttErr {
  ok: false
  error: string
}
export type SttResult = SttOk | SttErr

/** The default capture rate (docs/voice.md); the caller states the rate it captured at. */
export const STT_RATE_DEFAULT = 16000

/** The longest utterance the server accepts, in seconds (bytes differ per rate). The dialog
 *  stops a recording long before this; the cap is for a client that does not. */
export const STT_MAX_SECONDS = 60

/** How long to wait on the recogniser, so a wedged one answers the phone instead of hanging
 *  it. Recognition runs ~5x real time, so a 60 s utterance needs ~12 s plus a cold model load. */
const STT_TIMEOUT_MS = 45_000

/** s16le mono: two bytes a sample. */
export function maxPcmBytes(rate: number): number {
  return STT_MAX_SECONDS * rate * 2
}

/** Rates a capture could plausibly have. Narrow on purpose: a wrong rate is not an error, it
 *  is audio played at the wrong speed. */
export function isPcmRate(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 8000 && n <= 48000
}

/** The configured recogniser, or '' when the feature is off. Off by default: this is the one
 *  route in the server that sends what a microphone heard to another process. */
export function sttUrl(): string {
  return (process.env.EW_STT_URL ?? '').trim()
}

/** The model id the recogniser wants: its HTTP id as listed by `/v1/models`, which differs
 *  from the model's CLI name (docs/voice.md). The default must name the model the shipped unit
 *  (systemd/speech-cpp.service) serves, or a fresh install that sets only EW_STT_URL gets a
 *  404. */
export function sttModel(): string {
  return (process.env.EW_STT_MODEL ?? 'Qwen3-ASR-0.6B').trim()
}

/** Optional language hint, and optional vocabulary bias (the API's `prompt`: proper nouns
 *  and jargon). Both empty by default. */
export function sttLang(): string {
  return (process.env.EW_STT_LANG ?? '').trim()
}
export function sttPrompt(): string {
  return (process.env.EW_STT_PROMPT ?? '').trim()
}

/** The recogniser's API key, or '' for a recogniser that wants none (a local one). Sent as
 *  `Authorization: Bearer`, which is what OpenAI's own endpoint requires. It is never logged
 *  and never reaches the phone. */
export function sttApiKey(): string {
  return (process.env.EW_STT_API_KEY ?? '').trim()
}

/** Would the key cross the network unencrypted? True for a plain `http://` URL whose host is
 *  not this machine. `transcribe` refuses that instead of sending the key. */
export function sttKeyExposed(url: string, key: string): boolean {
  if (key === '') return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false // an unusable URL fails on its own, at the fetch
  }
  if (u.protocol !== 'http:') return false
  const host = u.hostname
  return !(host === 'localhost' || host === '[::1]' || /^127\./.test(host))
}

/** What `EW_STT_OPTIONS` is when unset. `chunking_strategy` is OpenAI's field: the recogniser
 *  splits the audio where its voice detector hears speech and recognises each region. Without
 *  it a long utterance goes in as one window, and a model trained on short clips returns only
 *  part of it (seen with reazonspeech-nemo-v2 on a 30 s recording); silence can also come back
 *  as a word. */
export const STT_OPTIONS_DEFAULT = 'chunking_strategy=auto'

/** Extra form fields for the recogniser, from `EW_STT_OPTIONS`: `name=value` pairs joined by
 *  `&`, in URL query syntax, so a value may be percent-encoded. They are how a recogniser's
 *  own switches are reached without this module knowing them (`vad_filter=true`,
 *  `temperature=0`). Set to empty, nothing extra is sent. `file` is not theirs to set. */
export function sttOptions(): [string, string][] {
  const raw = (process.env.EW_STT_OPTIONS ?? STT_OPTIONS_DEFAULT).trim()
  const out: [string, string][] = []
  for (const [k, v] of new URLSearchParams(raw)) {
    const name = k.trim()
    if (name !== '' && name !== 'file') out.push([name, v])
  }
  return out
}

/** Where to keep a copy of each utterance, from `EW_STT_DUMP_DIR`; '' (the default) keeps
 *  none. It is for finding out why a transcript came back short: the file is the exact WAV
 *  the recogniser was sent, so it can be played and sent again by hand. */
export function sttDumpDir(): string {
  return (process.env.EW_STT_DUMP_DIR ?? '').trim()
}

/** How many utterances the dump directory keeps. These are recordings of the wearer, so the
 *  directory does not grow without bound: the oldest go when a new one arrives. */
export const STT_DUMP_KEEP = 20

/** `utt-20261126-010203-456`, in local time: sorts by name in the order recorded. */
function dumpStem(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `utt-${String(at.getFullYear())}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}-${p(at.getMilliseconds(), 3)}`
  )
}

/** Write the WAV into the dump directory and drop the oldest beyond `STT_DUMP_KEEP`. Returns
 *  the path without its extension, or '' when nothing was written. Never throws: a full disk
 *  or a bad path costs the copy, not the utterance. */
async function dumpWav(dir: string, wav: Uint8Array): Promise<string> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const stem = join(dir, dumpStem(new Date()))
    await writeFile(`${stem}.wav`, wav, { mode: 0o600 })
    const old = (await readdir(dir))
      .filter(f => /^utt-[\d-]+\.wav$/.test(f))
      .sort()
      .slice(0, -STT_DUMP_KEEP)
    for (const f of old) {
      await rm(join(dir, f), { force: true })
      await rm(join(dir, f.replace(/\.wav$/, '.txt')), { force: true })
    }
    console.log(`[ew] stt: kept the utterance at ${stem}.wav (EW_STT_DUMP_DIR)`)
    return stem
  } catch (e) {
    console.log(
      `[ew] stt: could not keep the utterance in ${dir}: ${e instanceof Error ? e.message : String(e)}`,
    )
    return ''
  }
}

/** Put what the recogniser answered next to the WAV, so the two can be compared later. */
async function dumpText(stem: string, text: string): Promise<void> {
  if (stem === '') return
  await writeFile(`${stem}.txt`, `${text}\n`, { mode: 0o600 }).catch(() => {})
}

export function sttEnabled(): boolean {
  return sttUrl() !== ''
}

/** Wrap raw s16le mono PCM in the 44-byte canonical WAVE header. Pure and exported for
 *  testing: a wrong field is not an error, it is a transcript of noise. */
export function pcmToWav(pcm: Uint8Array, rate: number): Uint8Array<ArrayBuffer> {
  // Allocated explicitly so the type is `Uint8Array<ArrayBuffer>`, which `Blob` accepts.
  const out = new Uint8Array(new ArrayBuffer(44 + pcm.length))
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length, true) // everything after this field
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM fmt chunk length
  v.setUint16(20, 1, true) // format 1 = PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true) // byte rate = rate * channels * bytes/sample
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, pcm.length, true)
  out.set(pcm, 44)
  return out
}

/** Keep an upstream failure readable on a phone without pasting a whole HTML error page. */
function excerpt(s: string, max = 200): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max)}…`
}

/** Recognise one utterance. Never rejects: every failure is an `SttErr` the route can send
 *  as JSON. */
export async function transcribe(pcm: Uint8Array, rate: number): Promise<SttResult> {
  const url = sttUrl()
  if (!url) return { ok: false, error: 'STT is not configured — set EW_STT_URL' }
  if (pcm.length === 0) return { ok: true, text: '' }

  const key = sttApiKey()
  if (sttKeyExposed(url, key)) {
    return {
      ok: false,
      error: 'EW_STT_API_KEY is set but EW_STT_URL is plain http to another host — use https',
    }
  }
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {}

  const wav = pcmToWav(pcm, rate)
  const dumpDir = sttDumpDir()
  const dumped = dumpDir ? await dumpWav(dumpDir, wav) : ''
  const options = sttOptions()
  const post = (extra: boolean): Promise<Response> => {
    const form = new FormData()
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav')
    form.append('model', sttModel())
    const lang = sttLang()
    if (lang) form.append('language', lang)
    const prompt = sttPrompt()
    if (prompt) form.append('prompt', prompt)
    // `set`, so an option replaces the same field from its own setting above.
    if (extra) for (const [k, v] of options) form.set(k, v)
    return fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    })
  }

  let res: Response
  try {
    res = await post(true)
    // The options are the part of the request a recogniser may not take: speech.cpp answers
    // 400 to `chunking_strategy` when it was started without a voice detector, and another
    // server may not know a field. The utterance is worth more than the options, so it is
    // sent once more without them.
    if (res.status === 400 && options.length > 0) {
      const why = await res.text().catch(() => '')
      console.log(
        `[ew] stt: the recogniser refused the request (400: ${excerpt(why, 120)}) — ` +
          `retrying without EW_STT_OPTIONS (${options.map(([k]) => k).join(', ')})`,
      )
      res = await post(false)
    }
  } catch (e) {
    // The common case: the recogniser is a separate process that has not been started.
    const why = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      error: `cannot reach the STT server at ${url} (${excerpt(why, 80)}) — is it running?`,
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { ok: false, error: `STT server answered ${String(res.status)}: ${excerpt(body)}` }
  }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    return { ok: false, error: 'STT server answered with something that is not JSON' }
  }
  const text = (parsed as { text?: unknown } | null)?.text
  if (typeof text !== 'string') {
    return { ok: false, error: 'STT server answered JSON with no `text`' }
  }
  // Trimmed, not rejected, when empty: silence is a legitimate outcome. Keeping an empty
  // string away from the injector is the injection site's rule.
  await dumpText(dumped, text.trim())
  return { ok: true, text: text.trim() }
}
