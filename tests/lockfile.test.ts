// `npm ci` refuses a lockfile that does not hold every package it names, and CI starts with
// `npm ci`. `npm install` has dropped entries for optional dependencies of platforms other than
// the one it ran on, and the local npm did not notice (`npm ci --dry-run` passed). These checks
// read package-lock.json directly, so they need no network and no particular npm version.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type Deps = Record<string, string>
interface Entry {
  dependencies?: Deps
  devDependencies?: Deps
  optionalDependencies?: Deps
  peerDependencies?: Deps
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, name), 'utf8'))
}

const lock = readJson<{ packages: Record<string, Entry> }>('package-lock.json')
const manifest = readJson<Entry>('package.json')

/** Where node would find `name` from the package at `from`: its own node_modules first, then
 *  each enclosing one, as the lockfile lays them out. '' when no entry exists. */
function resolveFrom(from: string, name: string): string {
  let dir = from
  for (;;) {
    const candidate = `${dir ? `${dir}/` : ''}node_modules/${name}`
    if (lock.packages[candidate]) return candidate
    if (!dir) return ''
    const cut = dir.lastIndexOf('/node_modules/')
    dir = cut < 0 ? '' : dir.slice(0, cut)
  }
}

/** Names a package needs installed. An optional peer may legitimately be absent. */
function required(entry: Entry): string[] {
  const peers = Object.keys(entry.peerDependencies ?? {}).filter(
    name => !entry.peerDependenciesMeta?.[name]?.optional,
  )
  return [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...peers,
  ]
}

describe('package-lock.json', () => {
  it('holds an entry for every dependency of every package it lists', () => {
    const missing: string[] = []
    for (const [path, entry] of Object.entries(lock.packages)) {
      const names = path
        ? required(entry)
        : [...required(entry), ...Object.keys(entry.devDependencies ?? {})]
      for (const name of names) {
        if (!resolveFrom(path, name)) missing.push(`${name} (needed by ${path || 'the project'})`)
      }
    }
    expect(missing).toEqual([])
  })

  it('records the same direct dependencies as package.json', () => {
    const root = lock.packages[''] ?? {}
    expect(root.dependencies ?? {}).toEqual(manifest.dependencies ?? {})
    expect(root.devDependencies ?? {}).toEqual(manifest.devDependencies ?? {})
  })
})
