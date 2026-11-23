// even-window — speech to text: the PCM the glasses captured, turned into a string.
//
// The contract is a URL, not an engine (docs/voice.md, docs/decisions/stt-backend-contract.md):
// this module speaks OpenAI's `POST /v1/audio/transcriptions` and nothing else, so the
// recogniser is a setting.
//
// The phone goes through this server instead of calling the recogniser because its identity
// is for this server only (docs/security.md), and so the audio format conversion lives in one
// place.
//
// No env is read at module load: reading inside the functions keeps these settings
// independent of import order (see env.boot.ts) and lets a test set them per case.

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

  const form = new FormData()
  form.append('file', new Blob([pcmToWav(pcm, rate)], { type: 'audio/wav' }), 'utterance.wav')
  form.append('model', sttModel())
  const lang = sttLang()
  if (lang) form.append('language', lang)
  const prompt = sttPrompt()
  if (prompt) form.append('prompt', prompt)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    })
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
  return { ok: true, text: text.trim() }
}
