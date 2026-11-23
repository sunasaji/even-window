// encodeWorker.ts — the off-main-thread half of the tile encode. See encodeOffload.ts for why
// it exists and for the fallback that makes this file optional.
//
// It returns the PNG's IDAT, not the PNG. Framing (`assemblePng`) stays on the main thread,
// which keeps the palette in one place (`TILE_PLTE` in tiles.ts).
//
// `lib` in tsconfig.json is DOM, not WebWorker, so the worker globals are reached through one
// narrow local type: `self` under the DOM lib is a `Window`, whose `postMessage` differs.

import { TILE_H, TILE_W } from '../shared/geom.ts'
import { filter0Rows, pack4bit, zlibDeflate } from '../shared/png.ts'
import type { OffloadReply, OffloadRequest } from './encodeOffload.ts'

const ctx = globalThis as unknown as {
  addEventListener(type: 'message', handler: (event: { data: OffloadRequest }) => void): void
  postMessage(message: OffloadReply): void
}

ctx.addEventListener('message', event => {
  const { id, idx } = event.data
  void (async () => {
    try {
      const { data, bytesPerRow } = pack4bit(idx, TILE_W, TILE_H)
      const idat = await zlibDeflate(filter0Rows(data, bytesPerRow, TILE_H))
      ctx.postMessage({ id, idat })
    } catch (error) {
      // Reported rather than thrown: `onerror` in a worker loses the id, and the other side
      // needs to know which request failed to fall back without waiting out the timeout.
      ctx.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  })()
})
