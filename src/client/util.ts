// even-window — small helpers with no state: sleep, timeouts, error text.
//
// A leaf: it imports no other client module, so anything may use it at load time.

export function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

export function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const h = setTimeout(() => reject(new Error(`${tag} timeout`)), ms)
    p.then(
      v => {
        clearTimeout(h)
        resolve(v)
      },
      e => {
        clearTimeout(h)
        reject(e)
      },
    )
  })
}

export function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e)
}

/** The same error with its name and the top of its stack, flattened to one line. Bounded to
 *  three frames because this goes through `log()`, which forwards to the server. */
export function errWhere(e: unknown): string {
  const err = e as Error | undefined
  const name = err?.name && err.name !== 'Error' ? `${err.name}: ` : ''
  const frames =
    typeof err?.stack === 'string'
      ? err.stack
          .split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.includes(errText(e)))
          .slice(0, 3)
      : []
  return `${name}${errText(e)}${frames.length ? ` @ ${frames.join(' < ')}` : ' @ (no stack)'}`
}
