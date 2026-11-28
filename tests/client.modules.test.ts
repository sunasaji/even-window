// pinhole-window — every client module loads on its own.
//
// src/client is a set of modules that import each other in cycles. That is fine as long as a
// module only uses another one from inside a function; a top-level statement that reaches into
// a module which has not finished loading reads an uninitialised binding. Which module finishes
// first depends on which one is imported first — so the entry point (main.ts) can work while a
// test that happens to import `voice.ts` first does not, or the other way round.
//
// So: import each module as the first one, in a fresh module registry, and require that it loads.
// Under node there is no `document`, so main.ts does not boot and nothing touches the SDK.

import { describe, expect, it, vi } from 'vitest'
import { clientModules } from './helpers/source.ts'

// The worker script is not a module anyone imports: it talks to `self` as it loads.
const NOT_IMPORTABLE = new Set(['encodeWorker.ts'])

describe('each client module can be the first one imported', () => {
  const modules = clientModules().filter(m => !NOT_IMPORTABLE.has(m))

  it('finds the modules', () => {
    expect(modules).toContain('main.ts')
    expect(modules.length).toBeGreaterThan(10)
  })

  for (const name of modules) {
    it(name, async () => {
      vi.resetModules()
      const mod = (await import(/* @vite-ignore */ `../src/client/${name}`)) as object
      expect(Object.keys(mod).length, name).toBeGreaterThan(0)
    })
  }
})
