// even-window — `{t:'supersede'}` on the wire: two live streams, one pair of glasses.
//
// `tests/server.instances.test.ts` pins the rule. This file pins that the rule reaches the
// socket (docs/decisions/glasses-instance-supersede.md).
//
// Auth is disabled so the stream needs no ticket — every connection lands in the `-` identity
// bucket, which models two WebViews on one phone.

import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { route } from '../src/server/main.ts'
import { useTempStateDir } from './authFixture.ts'

let server: Server
let origin = ''
let dispose: () => void
let prevAuth: string | undefined

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
  prevAuth = process.env.EW_AUTH
  process.env.EW_AUTH = '0'
})
afterEach(() => {
  if (prevAuth === undefined) delete process.env.EW_AUTH
  else process.env.EW_AUTH = prevAuth
  dispose()
})

interface OpenStream {
  /** Everything the server has written so far. */
  text: () => string
  /** Resolves once `needle` appears, or rejects after `ms`. */
  waitFor: (needle: string, ms?: number) => Promise<string>
  close: () => void
}

async function openStream(inst: string): Promise<OpenStream> {
  const ctl = new AbortController()
  const res = await fetch(`${origin}/api/stream?inst=${encodeURIComponent(inst)}`, {
    signal: ctl.signal,
  })
  expect(res.status).toBe(200)
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let buf = ''
  let done = false
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        buf += dec.decode(r.value, { stream: true })
      }
    } catch {
      /* aborted */
    } finally {
      done = true
    }
  })()
  return {
    text: () => buf,
    // Cancel then abort: cancelling the reader is what releases the socket through undici's
    // pool, so the server sees the close promptly.
    close: () => {
      void reader.cancel().catch(() => null)
      ctl.abort()
    },
    waitFor: async (needle, ms = 2000) => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        if (buf.includes(needle)) return buf
        if (done) break
        await new Promise(r => setTimeout(r, 10))
      }
      throw new Error(`timed out waiting for ${needle} in:\n${buf}`)
    },
  }
}

describe('a newer instance supersedes the older one, on the wire', () => {
  it('tells the first stream to stand down when a second instance connects', async () => {
    const a = await openStream('wire-A1')
    // Nothing yet: one instance owns the glasses uncontested.
    expect(a.text()).not.toContain('supersede')
    const b = await openStream('wire-B1')
    await a.waitFor('"t":"supersede"')
    expect(a.text()).toContain('"by":"wire-B1"')
    // …and the winner is not told anything about itself.
    expect(b.text()).not.toContain('supersede')
    a.close()
    b.close()
  })

  it('tells a superseded instance again when it reconnects — the retry must not win', async () => {
    const a = await openStream('wire-A2')
    const b = await openStream('wire-B2')
    await a.waitFor('"t":"supersede"')
    a.close()
    // The old page is still running, so its EventSource comes back. Under plain "newest
    // connection wins" this reconnect would take the glasses from B.
    const again = await openStream('wire-A2')
    await again.waitFor('"t":"supersede"')
    expect(again.text()).toContain('"by":"wire-B2"')
    // B was never disturbed.
    expect(b.text()).not.toContain('supersede')
    again.close()
    b.close()
  })

  it('leaves the same instance alone when its own stream reconnects', async () => {
    // A ticket lasts 60s, so an ordinary re-open is routine and must not look like a rival.
    const a = await openStream('wire-C1')
    a.close()
    const again = await openStream('wire-C1')
    await new Promise(r => setTimeout(r, 150))
    expect(again.text()).not.toContain('supersede')
    again.close()
  })

  it('counts the streams it told, because silence afterwards is ambiguous', async () => {
    // A takeover with no close line after it is ambiguous (heard and let go / wedged / nobody
    // there); the count tells them apart. Zero is the good outcome: the old page was gone.
    const lines: string[] = []
    const realLog = console.log
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(' '))
    }
    try {
      const a = await openStream('wire-G1')
      const b = await openStream('wire-H1') // one live stream to tell
      await a.waitFor('"t":"supersede"')
      a.close()
      b.close()
      await new Promise(r => setTimeout(r, 100))
      const c = await openStream('wire-I1') // nobody left: the pages are gone
      await new Promise(r => setTimeout(r, 100))
      c.close()
    } finally {
      console.log = realLog
    }
    expect(lines.some(l => l.includes('wire-H1') && l.includes('1 live stream(s) told'))).toBe(true)
    expect(
      lines.some(l => l.includes('wire-I1') && l.includes('the old page was already gone')),
    ).toBe(true)
  })

  it('logs the close of a stream it told to stand down — the only proof in a crash', async () => {
    // A client that heard the stand-down closes its stream, which the server logs. The
    // line's absence means the old page is wedged or does not understand the message.
    const lines: string[] = []
    const realLog = console.log
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(' '))
    }
    try {
      const a = await openStream('wire-E1')
      const b = await openStream('wire-F1')
      await a.waitFor('"t":"supersede"')
      a.close() // what `standDownSuperseded` does
      // An aborted `fetch` releases its socket through the agent's pool, so the server's
      // `close` can land a moment after the abort. The loop pokes an unrelated route to keep
      // the event loop turning, and waits for this stream's own line: a close left over from
      // an earlier case can land here too.
      const mine = (l: string): boolean =>
        l.includes('wire-E1') && l.includes('CLOSED after being told')
      const until = Date.now() + 5000
      while (Date.now() < until && !lines.some(mine)) {
        await fetch(`${origin}/api/health`).catch(() => null)
        await new Promise(r => setTimeout(r, 50))
      }
      b.close()
    } finally {
      console.log = realLog
    }
    expect(lines.some(l => l.includes('wire-E1') && l.includes('CLOSED after being told'))).toBe(
      true,
    )
    // …and the winner's own close is not reported as a stand-down.
    expect(lines.some(l => l.includes('wire-F1') && l.includes('CLOSED after being told'))).toBe(
      false,
    )
  })

  it('never supersedes a client that sends no instance id', async () => {
    const legacy = await fetch(`${origin}/api/stream`, { signal: AbortSignal.timeout(1500) })
      .then(async r => {
        const reader = (r.body as ReadableStream<Uint8Array>).getReader()
        const chunk = await reader.read()
        void reader.cancel()
        return new TextDecoder().decode(chunk.value ?? new Uint8Array())
      })
      .catch(() => '')
    expect(legacy).not.toContain('supersede')
    // …and it does not take ownership either, so a new instance arriving later is uncontested.
    const a = await openStream('wire-D1')
    await new Promise(r => setTimeout(r, 150))
    expect(a.text()).not.toContain('supersede')
    a.close()
  })
})
