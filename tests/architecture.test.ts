// The import direction across the platform seam (src/server/platform/types.ts).
//
//   * nothing in src/server outside platform/x11/ may import from platform/x11/ — except
//     platform/index.ts, the one place that chooses a backend;
//   * src/shared imports nothing from src/server or src/client.
//
// Read from the source text, so a violation fails here rather than on the first machine that
// has no X11.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const SERVER = join(SRC, 'server')
const X11_DIR = join(SERVER, 'platform', 'x11')
const CHOOSER = join(SERVER, 'platform', 'index.ts')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Every relative module specifier in a file — `import … from`, `export … from`, a bare
 *  `import '…'` and a dynamic `import('…')` — resolved to an absolute path. */
function relativeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const specs = [
    ...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g),
    ...src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
    ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map(m => m[1] ?? '')
  return specs.filter(s => s.startsWith('.')).map(s => resolve(dirname(file), s))
}

const inside = (dir: string, p: string): boolean => p === dir || p.startsWith(dir + sep)
const rel = (p: string): string => relative(SRC, p)

describe('the platform seam', () => {
  it('finds the files it is supposed to be checking', () => {
    expect(tsFiles(X11_DIR).length).toBeGreaterThan(3)
    expect(relativeImports(CHOOSER).some(p => inside(X11_DIR, p))).toBe(true)
  })

  it('only platform/index.ts imports from platform/x11/', () => {
    const bad: string[] = []
    for (const f of tsFiles(SERVER)) {
      if (inside(X11_DIR, f) || f === CHOOSER) continue
      for (const p of relativeImports(f)) if (inside(X11_DIR, p)) bad.push(`${rel(f)} -> ${rel(p)}`)
    }
    expect(bad, `OS-neutral modules import the X11 backend:\n${bad.join('\n')}`).toEqual([])
  })

  it('src/shared imports nothing from src/server or src/client', () => {
    const bad: string[] = []
    for (const f of tsFiles(join(SRC, 'shared'))) {
      for (const p of relativeImports(f)) {
        if (inside(SERVER, p) || inside(join(SRC, 'client'), p)) bad.push(`${rel(f)} -> ${rel(p)}`)
      }
    }
    expect(bad, bad.join('\n')).toEqual([])
  })
})

describe('backendFor — which operating system gets which backend', () => {
  it('gives Linux the X11 backend, Windows none, and tries X11 elsewhere', async () => {
    const { backendFor } = await import('../src/server/platform/index.ts')
    expect(backendFor('linux')).toBe('x11')
    expect(backendFor('win32')).toBe('none')
    expect(backendFor('darwin')).toBe('x11-untested')
    expect(backendFor('freebsd')).toBe('x11-untested')
  })
})
