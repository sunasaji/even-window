// `POST /api/stt` and src/server/stt.ts.
//
// No mock of the recogniser: the upstream is a real node:http listener that reads the real
// multipart body, because the part most likely to be wrong is whether `FormData` + `Blob` put
// a WAVE file on the wire under a field OpenAI's API recognises.
//
// The WAVE header is checked against bytes written out by hand, not against the arithmetic
// that produced it: a wrong field does not raise, it transcribes noise.

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { route } from '../src/server/main.ts'
import {
  isPcmRate,
  maxPcmBytes,
  pcmToWav,
  STT_DUMP_KEEP,
  STT_MAX_SECONDS,
  sttDumpDir,
  sttEnabled,
  sttKeyExposed,
  sttModel,
  sttOptions,
  transcribe,
} from '../src/server/stt.ts'
import { enrolAndSession, makeEd25519Key, useTempStateDir } from './authFixture.ts'

// ── a real upstream, so the multipart body is really parsed by somebody else ───────────────

interface Upstream {
  origin: string
  /** Raw bytes of the last request body, for asserting what actually crossed. */
  lastBody: string
  lastType: string
  /** The last request's `Authorization` header, '' when it had none. */
  lastAuth: string
  /** What to answer next: a status and a body. */
  reply: { status: number; body: string; type?: string }
  /** Answer 400 to a request that carries `chunking_strategy`, as speech.cpp does when it
   *  was started without a voice detector. */
  refuseChunking: boolean
  /** Requests received. */
  hits: number
  close(): Promise<void>
}

async function startUpstream(): Promise<Upstream> {
  const u: Partial<Upstream> = {
    lastBody: '',
    lastType: '',
    lastAuth: '',
    reply: { status: 200, body: '{"text":"こんにちは"}' },
    refuseChunking: false,
    hits: 0,
  }
  const srv: Server = createServer((q: IncomingMessage, s: ServerResponse) => {
    const chunks: Buffer[] = []
    q.on('data', (d: Buffer) => chunks.push(d))
    q.on('end', () => {
      u.lastBody = Buffer.concat(chunks).toString('latin1')
      u.lastType = q.headers['content-type'] ?? ''
      u.lastAuth = q.headers.authorization ?? ''
      u.hits = (u.hits ?? 0) + 1
      const refused = u.refuseChunking === true && u.lastBody.includes('name="chunking_strategy"')
      const r = refused
        ? { status: 400, body: '{"error":{"param":"chunking_strategy"}}', type: undefined }
        : (u.reply ?? { status: 200, body: '{}' })
      s.statusCode = r.status
      s.setHeader('content-type', r.type ?? 'application/json')
      s.end(r.body)
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const a = srv.address()
  u.origin = typeof a === 'object' && a ? `http://127.0.0.1:${a.port}` : ''
  u.close = () =>
    new Promise<void>(r => {
      srv.close(() => r())
    })
  return u as Upstream
}

let up: Upstream
beforeAll(async () => {
  up = await startUpstream()
})
afterAll(async () => {
  await up.close()
})

beforeEach(() => {
  delete process.env.EW_STT_URL
  delete process.env.EW_STT_MODEL
  delete process.env.EW_STT_LANG
  delete process.env.EW_STT_PROMPT
  delete process.env.EW_STT_OPTIONS
  delete process.env.EW_STT_API_KEY
  delete process.env.EW_STT_DUMP_DIR
  up.refuseChunking = false
  up.lastAuth = ''
  up.hits = 0
  up.reply = { status: 200, body: '{"text":"こんにちは"}' }
})

// ── the WAVE header ────────────────────────────────────────────────────────────────────────

describe('pcmToWav', () => {
  it('writes the canonical 44-byte header, byte for byte', () => {
    const pcm = new Uint8Array([1, 2, 3, 4])
    const got = [...pcmToWav(pcm, 16000)]
    const want = [
      0x52,
      0x49,
      0x46,
      0x46, // "RIFF"
      40,
      0,
      0,
      0, // 36 + 4 payload bytes, little-endian
      0x57,
      0x41,
      0x56,
      0x45, // "WAVE"
      0x66,
      0x6d,
      0x74,
      0x20, // "fmt "
      16,
      0,
      0,
      0, // fmt chunk length
      1,
      0, // PCM
      1,
      0, // mono
      0x80,
      0x3e,
      0,
      0, // 16000 Hz
      0x00,
      0x7d,
      0,
      0, // 32000 B/s
      2,
      0, // block align
      16,
      0, // bits per sample
      0x64,
      0x61,
      0x74,
      0x61, // "data"
      4,
      0,
      0,
      0, // payload length
      1,
      2,
      3,
      4, // the payload, verbatim
    ]
    expect(got).toEqual(want)
  })

  it('tracks the rate in both the rate and the byte-rate field', () => {
    const w = pcmToWav(new Uint8Array(2), 48000)
    const v = new DataView(w.buffer)
    expect(v.getUint32(24, true)).toBe(48000)
    expect(v.getUint32(28, true)).toBe(96000)
  })

  it('survives an empty capture without producing a header that lies', () => {
    const w = pcmToWav(new Uint8Array(0), 16000)
    expect(w.length).toBe(44)
    expect(new DataView(w.buffer).getUint32(40, true)).toBe(0)
  })
})

// ── the caps and the config ────────────────────────────────────────────────────────────────

describe('caps and configuration', () => {
  it('states the cap in seconds, so every rate gets the same ceiling in time', () => {
    expect(maxPcmBytes(16000)).toBe(STT_MAX_SECONDS * 32000)
    expect(maxPcmBytes(48000)).toBe(STT_MAX_SECONDS * 96000)
  })

  it('accepts plausible capture rates and nothing else', () => {
    for (const ok of [8000, 16000, 44100, 48000]) expect(isPcmRate(ok)).toBe(true)
    for (const bad of [0, -16000, 7999, 48001, 16000.5, NaN, '16000', null, undefined]) {
      expect(isPcmRate(bad)).toBe(false)
    }
  })

  it('is off until EW_STT_URL is set — a microphone path must not default to on', () => {
    expect(sttEnabled()).toBe(false)
    process.env.EW_STT_URL = 'http://127.0.0.1:8757/v1/audio/transcriptions'
    expect(sttEnabled()).toBe(true)
  })

  it('defaults to the HTTP model id of the model the shipped systemd unit serves', () => {
    // A model's CLI name and its HTTP id differ (qwen3-asr-0.6b -> Qwen3-ASR-0.6B), and this
    // default must name what systemd/speech-cpp.service serves (docs/voice.md).
    expect(sttModel()).toBe('Qwen3-ASR-0.6B')
    process.env.EW_STT_MODEL = 'whisper-1'
    expect(sttModel()).toBe('whisper-1')
  })
})

// ── transcribe(), against the real upstream ────────────────────────────────────────────────

describe('transcribe', () => {
  it('puts a real WAVE file and the model on the wire as multipart', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    const r = await transcribe(new Uint8Array([1, 2, 3, 4]), 16000)
    expect(r).toEqual({ ok: true, text: 'こんにちは' })
    expect(up.lastType).toMatch(/^multipart\/form-data; *boundary=/)
    expect(up.lastBody).toContain('name="file"')
    expect(up.lastBody).toContain('filename="utterance.wav"')
    expect(up.lastBody).toContain('RIFF') // the header really crossed
    expect(up.lastBody).toContain('WAVE')
    expect(up.lastBody).toContain('name="model"')
    expect(up.lastBody).toContain('Qwen3-ASR-0.6B')
  })

  it('sends language and prompt only when they are configured', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.lastBody).not.toContain('name="language"')
    expect(up.lastBody).not.toContain('name="prompt"')

    process.env.EW_STT_LANG = 'ja'
    process.env.EW_STT_PROMPT = 'Claude Code'
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.lastBody).toContain('name="language"')
    expect(up.lastBody).toContain('name="prompt"')
    expect(up.lastBody).toContain('Claude Code')
  })

  it('asks the recogniser to chunk by default, and sends nothing extra when the options are empty', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.lastBody).toContain('name="chunking_strategy"')
    expect(up.lastBody).toContain('auto')

    process.env.EW_STT_OPTIONS = ''
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.lastBody).not.toContain('name="chunking_strategy"')
  })

  it('sends the API key as a bearer token, on the retry too, and no header without one', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.lastAuth).toBe('')

    process.env.EW_STT_API_KEY = ' sk-test-123 '
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.lastAuth).toBe('Bearer sk-test-123')
    // The key is a header, never a form field.
    expect(up.lastBody).not.toContain('sk-test-123')

    up.refuseChunking = true
    up.lastAuth = ''
    up.hits = 0
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.hits).toBe(2)
    expect(up.lastAuth).toBe('Bearer sk-test-123')
  })

  it('refuses to send the key over plain http to another host', async () => {
    expect(sttKeyExposed('http://192.168.1.5:8757/v1/audio/transcriptions', 'k')).toBe(true)
    expect(sttKeyExposed('http://stt.example/v1/audio/transcriptions', 'k')).toBe(true)
    expect(sttKeyExposed('https://api.openai.com/v1/audio/transcriptions', 'k')).toBe(false)
    expect(sttKeyExposed('http://127.0.0.1:8757/v1/audio/transcriptions', 'k')).toBe(false)
    expect(sttKeyExposed('http://localhost:8757/x', 'k')).toBe(false)
    expect(sttKeyExposed('http://[::1]:8757/x', 'k')).toBe(false)
    expect(sttKeyExposed('http://stt.example/x', '')).toBe(false)

    process.env.EW_STT_URL = 'http://stt.example/v1/audio/transcriptions'
    process.env.EW_STT_API_KEY = 'sk-test-123'
    const r = await transcribe(new Uint8Array([1, 2]), 16000)
    expect(r.ok).toBe(false)
    // The complaint goes to the phone: it must not carry the key.
    expect(JSON.stringify(r)).not.toContain('sk-test-123')
    expect(up.hits).toBe(0)
  })

  it('sends whatever fields EW_STT_OPTIONS names, in place of the default', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    process.env.EW_STT_OPTIONS = 'vad_filter=true&temperature=0'
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.lastBody).toContain('name="vad_filter"')
    expect(up.lastBody).toContain('name="temperature"')
    expect(up.lastBody).not.toContain('name="chunking_strategy"')
  })

  it('parses the options as a query string: encoded values, blanks and `file` left out', () => {
    process.env.EW_STT_OPTIONS = ' a=1&b=x%20y&&=z&file=evil&c '
    expect(sttOptions()).toEqual([
      ['a', '1'],
      ['b', 'x y'],
      ['c', ''],
    ])
    process.env.EW_STT_OPTIONS = 'chunking_strategy={"type":"server_vad"}'
    expect(sttOptions()).toEqual([['chunking_strategy', '{"type":"server_vad"}']])
    delete process.env.EW_STT_OPTIONS
    expect(sttOptions()).toEqual([['chunking_strategy', 'auto']])
  })

  it('lets an option replace the same field from its own setting', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    process.env.EW_STT_LANG = 'ja'
    process.env.EW_STT_OPTIONS = 'language=en'
    await transcribe(new Uint8Array([1, 2]), 16000)
    expect(up.lastBody.split('name="language"').length - 1).toBe(1)
  })

  it('sends the utterance again without the options when the recogniser refuses them', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    up.refuseChunking = true
    expect(await transcribe(new Uint8Array([1, 2]), 16000)).toEqual({
      ok: true,
      text: 'こんにちは',
    })
    expect(up.hits).toBe(2)
    expect(up.lastBody).not.toContain('name="chunking_strategy"')
    expect(up.lastBody).toContain('RIFF')
  })

  it('does not retry a 400 when no options were sent', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    process.env.EW_STT_OPTIONS = ''
    up.reply = { status: 400, body: 'bad audio' }
    const r = await transcribe(new Uint8Array([1, 2]), 16000)
    expect(r.ok).toBe(false)
    expect(up.hits).toBe(1)
  })

  it('keeps nothing on disk unless EW_STT_DUMP_DIR is set', () => {
    expect(sttDumpDir()).toBe('')
  })

  it('keeps the WAV it sent and the text it got back when EW_STT_DUMP_DIR is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ew-stt-dump-'))
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    process.env.EW_STT_DUMP_DIR = join(dir, 'made', 'on', 'demand')
    try {
      const pcm = new Uint8Array([1, 0, 2, 0])
      expect(await transcribe(pcm, 16000)).toEqual({ ok: true, text: 'こんにちは' })
      const kept = readdirSync(process.env.EW_STT_DUMP_DIR).sort()
      expect(kept).toHaveLength(2)
      expect(kept[0]).toMatch(/^utt-\d{8}-\d{6}-\d{3}\.txt$/)
      expect(kept[1]).toBe(kept[0]?.replace('.txt', '.wav'))
      const at = (f: string | undefined): string => join(process.env.EW_STT_DUMP_DIR ?? '', f ?? '')
      expect(new Uint8Array(readFileSync(at(kept[1])))).toEqual(pcmToWav(pcm, 16000))
      expect(readFileSync(at(kept[0]), 'utf8')).toBe('こんにちは\n')
    } finally {
      delete process.env.EW_STT_DUMP_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the WAV even when the recogniser fails, and only the newest few', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ew-stt-dump-'))
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    process.env.EW_STT_DUMP_DIR = dir
    try {
      for (let i = 0; i < STT_DUMP_KEEP; i++) {
        const stem = `utt-20200101-0000${String(i).padStart(2, '0')}-000`
        writeFileSync(join(dir, `${stem}.wav`), '')
        writeFileSync(join(dir, `${stem}.txt`), '')
      }
      writeFileSync(join(dir, 'notes.md'), 'not ours')
      up.reply = { status: 500, body: 'boom' }
      expect((await transcribe(new Uint8Array([1, 0]), 16000)).ok).toBe(false)
      const kept = readdirSync(dir)
      expect(kept.filter(f => f.endsWith('.wav'))).toHaveLength(STT_DUMP_KEEP)
      expect(kept).not.toContain('utt-20200101-000000-000.wav')
      expect(kept).not.toContain('utt-20200101-000000-000.txt')
      expect(kept).toContain('notes.md')
    } finally {
      delete process.env.EW_STT_DUMP_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still answers the transcript when the dump directory cannot be written', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    // A path under a regular file: no directory can be made there.
    const dir = mkdtempSync(join(tmpdir(), 'ew-stt-dump-'))
    writeFileSync(join(dir, 'file'), '')
    process.env.EW_STT_DUMP_DIR = join(dir, 'file', 'sub')
    try {
      expect(await transcribe(new Uint8Array([1, 0]), 16000)).toEqual({
        ok: true,
        text: 'こんにちは',
      })
    } finally {
      delete process.env.EW_STT_DUMP_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats silence as success with an empty string, not as an error', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    up.reply = { status: 200, body: '{"text":"   "}' }
    // Nobody spoke is an outcome, not a fault: the dialog offers another go.
    expect(await transcribe(new Uint8Array([1, 2]), 16000)).toEqual({ ok: true, text: '' })
  })

  it('short-circuits an empty capture without troubling the recogniser', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    up.lastBody = 'untouched'
    expect(await transcribe(new Uint8Array(0), 16000)).toEqual({ ok: true, text: '' })
    expect(up.lastBody).toBe('untouched')
  })

  it('reports an unconfigured recogniser by naming the setting', async () => {
    const r = await transcribe(new Uint8Array([1, 2]), 16000)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('EW_STT_URL')
  })

  it('reports an upstream status, with an excerpt of what it said', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    up.reply = { status: 404, body: 'no such model' }
    const r = await transcribe(new Uint8Array([1, 2]), 16000)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('404')
    expect(r.ok === false && r.error).toContain('no such model')
  })

  it('does not throw on a non-JSON answer', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    up.reply = { status: 200, body: '<html>nope</html>', type: 'text/html' }
    const r = await transcribe(new Uint8Array([1, 2]), 16000)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('not JSON')
  })

  it('does not throw on JSON without a text field', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    up.reply = { status: 200, body: '{"error":"busy"}' }
    const r = await transcribe(new Uint8Array([1, 2]), 16000)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('no `text`')
  })

  it('says what to do when the recogniser is not running', async () => {
    // Port 1 is never listening. The message has to name the URL and suggest starting the
    // recogniser, which is a separate process.
    process.env.EW_STT_URL = 'http://127.0.0.1:1/v1/audio/transcriptions'
    const r = await transcribe(new Uint8Array([1, 2]), 16000)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('127.0.0.1:1')
    expect(r.ok === false && r.error).toContain('is it running?')
  })
})

// ── the route, through the real gate ───────────────────────────────────────────────────────

describe('POST /api/stt', () => {
  let server: Server
  let origin = ''
  let dispose: () => void
  let token = ''

  beforeAll(async () => {
    server = createServer((q, s) => {
      void route(q, s).catch(() => {
        s.statusCode = 500
        s.end()
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const a = server.address()
    origin = typeof a === 'object' && a ? `http://127.0.0.1:${a.port}` : ''
  })
  afterAll(async () => {
    await new Promise<void>(r => {
      server.close(() => r())
    })
  })
  beforeEach(() => {
    dispose = useTempStateDir()
    delete process.env.EW_AUTH
    token = enrolAndSession(makeEd25519Key()).token
  })
  afterEach(() => {
    dispose()
  })

  /** `fetch` and `Blob` want a plain-ArrayBuffer-backed view; `new Uint8Array(n)` is typed as
   *  possibly SharedArrayBuffer-backed, which they refuse. */
  const bytes = (...v: number[]): Uint8Array<ArrayBuffer> => {
    const a = new Uint8Array(new ArrayBuffer(v.length))
    a.set(v)
    return a
  }
  const zeros = (n: number): Uint8Array<ArrayBuffer> => new Uint8Array(new ArrayBuffer(n))

  const post = async (query: string, body: Uint8Array<ArrayBuffer>): Promise<Response> =>
    await fetch(`${origin}/api/stt${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body,
      signal: AbortSignal.timeout(10_000),
    })

  it('answers 503 and names the setting when STT is not configured', async () => {
    const res = await post('', bytes(0, 0))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ ok: false })
    // The operator must not have to read the source to find out what to set.
    expect(JSON.stringify(await (await post('', bytes(0, 0))).json())).toContain('EW_STT_URL')
  })

  it('refuses a rate it cannot interpret', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    const res = await post('?rate=999999', bytes(0, 0))
    expect(res.status).toBe(400)
  })

  it('refuses an odd byte count — that cannot be s16le, so the client is framing wrong', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    const res = await post('', bytes(0, 0, 0))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('s16le')
  })

  it('refuses more audio than the cap, rather than truncating it', async () => {
    // A truncated recording would transcribe into a sentence that is wrong, not missing.
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    const res = await post('?rate=8000', zeros(maxPcmBytes(8000) + 2))
    expect(res.status).toBe(413)
    // The 413 body must arrive: the server drains the request instead of destroying the
    // socket, which the client would see as a network error.
    expect(JSON.stringify(await res.json())).toContain(String(STT_MAX_SECONDS))
  })

  it('answers the transcript on the happy path', async () => {
    process.env.EW_STT_URL = `${up.origin}/v1/audio/transcriptions`
    up.reply = { status: 200, body: '{"text":"このファイルのバグを直して"}' }
    const res = await post('', bytes(1, 2, 3, 4))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, text: 'このファイルのバグを直して' })
  })

  it('answers 502 when the recogniser is the thing that broke', async () => {
    process.env.EW_STT_URL = 'http://127.0.0.1:1/v1/audio/transcriptions'
    const res = await post('', bytes(1, 2))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false })
  })
})
