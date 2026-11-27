// app.json is what `evenhub pack` reads and what Even Hub shows; package.json is what npm and
// the repository show. Neither file can refer to the other, so the two versions are kept equal
// by hand and compared here.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, name), 'utf8'))
}

describe('app manifest', () => {
  it('carries the same version as package.json', () => {
    expect(readJson('app.json').version).toBe(readJson('package.json').version)
  })
})
