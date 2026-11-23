import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The env file has to be applied before any module reads process.env at load, so the
// entry point's first import must be the bare side-effect import of env.boot.ts.
describe('server entry point', () => {
  it('imports env.boot.ts before anything else', () => {
    const src = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8')
    const first = /^import\s.*$/m.exec(src)?.[0]
    expect(first).toBe("import './env.boot.ts'")
  })
})
