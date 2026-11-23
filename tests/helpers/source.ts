// Source audits that do not pin the formatter.
//
// Some client tests assert on source text ("this function never calls that one", "there is
// exactly one call site"). An exact-substring match would also pin line wraps and trailing
// commas, so:
//
//   * Needle and haystack go through the same `squash()`: whitespace, `;` and a trailing `,`
//     before a closer are removed, and `(x) =>` equals `x =>`.
//   * `clientSource()` is every `src/client/**/*.ts`, and `fn(name)` finds a top-level
//     declaration in whichever module holds it.
//
// A regex is matched against the squashed text, so write it without whitespace:
// `/if\(!lift\)\{padQueue/`, not `/if \(!lift\) \{ padQueue/`.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'client')

const CLOSERS = new Set([')', ']', '}'])

/** The squashed text plus, for each squashed char, its index in the raw text. */
function squashMap(raw: string): { text: string; map: number[] } {
  const out: string[] = []
  const map: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string
    if (/\s/.test(c) || c === ';') continue
    if (c === ',') {
      // Drop a trailing comma before a closer: it belongs to the formatter.
      let j = i + 1
      while (j < raw.length && /\s/.test(raw[j] as string)) j++
      if (j < raw.length && CLOSERS.has(raw[j] as string)) continue
    }
    out.push(c)
    map.push(i)
  }
  // `(x) =>` and `x =>` are one arrow. Done on the squashed text, keeping the map in step.
  const text = out.join('')
  const re = /\((\w+)\)=>/g
  let m: RegExpExecArray | null = re.exec(text)
  if (!m) return { text, map }
  const text2: string[] = []
  const map2: number[] = []
  let last = 0
  while (m) {
    const open = m.index
    const close = m.index + 1 + (m[1] as string).length
    // Strip the parens only when they do not follow an identifier character, or follow the
    // keyword `async`: `async(x)=>` and `,(x)=>` are arrows.
    const before = text.slice(Math.max(0, open - 5), open)
    const callLike = /[\w$\])]$/.test(before) && !before.endsWith('async')
    if (!callLike) {
      for (let k = last; k < open; k++) {
        text2.push(text[k] as string)
        map2.push(map[k] as number)
      }
      for (let k = open + 1; k < close; k++) {
        text2.push(text[k] as string)
        map2.push(map[k] as number)
      }
      last = close + 1
    }
    m = re.exec(text)
  }
  for (let k = last; k < text.length; k++) {
    text2.push(text[k] as string)
    map2.push(map[k] as number)
  }
  return { text: text2.join(''), map: map2 }
}

/** The formatter-insensitive form of a piece of source: what both sides of a match go through. */
export function squash(raw: string): string {
  return squashMap(raw).text
}

function countIn(hay: string, needle: string): number {
  if (needle === '') return 0
  let n = 0
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** Lines that are nothing but a comment (`//`, `/*`, ` *`). A trailing comment stays. */
function isCommentLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')
}

/** A top-level declaration's opening line, whatever keyword introduces it. */
function declRegex(name: string): RegExp {
  const n = name.replace(/[$]/g, '\\$')
  return new RegExp(
    `^(?:export )?(?:(?:async )?function\\*? |const |let |class |interface |type )${n}\\b`,
    'm',
  )
}

/** One or more pieces of source (a module, a function, a slice), matched squashed. */
export class Source {
  readonly parts: readonly string[]
  private cache: { text: string; map: number[] }[] | null = null

  constructor(parts: string | readonly string[]) {
    this.parts = typeof parts === 'string' ? [parts] : parts
  }

  private get squashed(): { text: string; map: number[] }[] {
    this.cache ??= this.parts.map(squashMap)
    return this.cache
  }

  /** The raw text (parts joined). For the rare audit that really is about lines. */
  get raw(): string {
    return this.parts.join('\n')
  }

  /** The squashed text (parts joined by a newline, which no squashed needle can contain). */
  get text(): string {
    return this.squashed.map(s => s.text).join('\n')
  }

  /** The raw lines, for an audit that is about one-statement-per-line facts. */
  lines(): string[] {
    return this.raw.split('\n')
  }

  /** Does it contain this, formatting aside? A RegExp is tested against the squashed text. */
  has(needle: string | RegExp): boolean {
    if (typeof needle !== 'string') {
      return new RegExp(needle.source, needle.flags.replace('g', '')).test(this.text)
    }
    return this.text.includes(squash(needle))
  }

  /** How many times, formatting aside. A RegExp is counted against the squashed text. */
  count(needle: string | RegExp): number {
    if (typeof needle !== 'string') {
      const flags = needle.flags.includes('g') ? needle.flags : needle.flags + 'g'
      return [...this.text.matchAll(new RegExp(needle.source, flags))].length
    }
    return countIn(this.text, squash(needle))
  }

  /** Every match of a RegExp against the squashed text (each match is squashed source). */
  matches(re: RegExp): string[] {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
    return [...this.text.matchAll(new RegExp(re.source, flags))].map(m => m[0])
  }

  /** Position in the squashed text, or -1. Only for order comparisons within one Source. */
  indexOf(needle: string, from = 0): number {
    return this.text.indexOf(squash(needle), from)
  }

  lastIndexOf(needle: string): number {
    return this.text.lastIndexOf(squash(needle))
  }

  /** The same source with whole-line comments removed. */
  code(): Source {
    return new Source(
      this.parts.map(p =>
        p
          .split('\n')
          .filter(l => !isCommentLine(l))
          .join('\n'),
      ),
    )
  }

  /** A top-level declaration (`function`, `const`, `let`, `class`, `interface`, `type`) from
   *  its opening line to its closing one, in whichever part declares it. Throws if absent, so
   *  a renamed function fails the audit instead of auditing the empty string. */
  fn(name: string): Source {
    const re = declRegex(name)
    for (const part of this.parts) {
      const m = re.exec(part)
      if (!m) continue
      const lines = part.slice(m.index).split('\n')
      let end = 1
      // The declaration runs until the next line that starts something new at column 0. Its
      // own closing line (starting with `}`, `)` or `]`) belongs to it.
      while (end < lines.length) {
        const l = lines[end] as string
        if (l !== '' && !/^\s/.test(l) && !/^[)\]}]/.test(l)) break
        end++
      }
      // Trailing blank lines are not part of it.
      while (end > 1 && (lines[end - 1] as string).trim() === '') end--
      return new Source(lines.slice(0, end).join('\n'))
    }
    throw new Error(`source audit: no top-level declaration named \`${name}\``)
  }

  /** Several top-level declarations as one Source, a part each. */
  fns(...names: string[]): Source {
    return new Source(names.map(n => this.fn(n).raw))
  }

  /** Is there a top-level declaration of this name? */
  declares(name: string): boolean {
    const re = declRegex(name)
    return this.parts.some(p => re.test(p))
  }

  /** From the first `start` up to (not including) the first `end` after it, within one part.
   *  Throws when either is missing: an audit of the empty string passes every `not`. */
  between(start: string, end: string): Source {
    const a = squash(start)
    const b = squash(end)
    let sawStart = false
    for (let p = 0; p < this.parts.length; p++) {
      const { text, map } = this.squashed[p] as { text: string; map: number[] }
      const i = text.indexOf(a)
      if (i < 0) continue
      sawStart = true
      const j = text.indexOf(b, i + a.length)
      if (j < 0) continue
      return new Source((this.parts[p] as string).slice(map[i] as number, map[j] as number))
    }
    throw new Error(
      sawStart
        ? `source audit: \`${end}\` not found after \`${start}\``
        : `source audit: \`${start}\` not found`,
    )
  }

  /** From the first `start` to the end of its part, or just the next `rawChars` raw characters.
   *  Throws when `start` is missing. */
  from(start: string, rawChars?: number): Source {
    const a = squash(start)
    for (let p = 0; p < this.parts.length; p++) {
      const { text, map } = this.squashed[p] as { text: string; map: number[] }
      const i = text.indexOf(a)
      if (i < 0) continue
      const at = map[i] as number
      const part = this.parts[p] as string
      return new Source(rawChars === undefined ? part.slice(at) : part.slice(at, at + rawChars))
    }
    throw new Error(`source audit: \`${start}\` not found`)
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out.sort()
}

/** Every client module's path, relative to `src/client` (`main.ts`, `voice.ts`, …). */
export function clientModules(): string[] {
  return walk(CLIENT_DIR).map(p => relative(CLIENT_DIR, p))
}

let all: Source | null = null

/** The whole client (every `src/client/**\/*.ts`) as one Source, one part per module. */
export function clientSource(): Source {
  all ??= new Source(walk(CLIENT_DIR).map(p => readFileSync(p, 'utf8')))
  return all
}

/** One client module by its path under `src/client`, for an audit about one file. */
export function clientModule(name: string): Source {
  return new Source(readFileSync(join(CLIENT_DIR, name), 'utf8'))
}
