// even-window — which WebView instance owns the glasses
// (docs/decisions/glasses-instance-supersede.md).
//
// When the Even App dies its old page can keep running, leaving two live clients pushing at
// one pair of glasses. Two pages cannot see each other but both talk to this server, so the
// arbitration lives here: the newest instance to connect owns the glasses and the older one is
// told to stand down (`{t:'supersede'}`).
//
// The rule must be monotonic: the book remembers superseded instance ids, so a superseded
// page whose EventSource retries is told to stand down again instead of deposing the live one.

/** What an opening stream means for the instances already connected. */
export type InstanceVerdict =
  /** This instance now owns the glasses. */
  | 'adopt'
  /** This instance was superseded earlier and must stand down again. */
  | 'stale'
  /** No instance id. Left alone entirely (see `verdict`). */
  | 'ignore'

/** How many superseded ids are remembered (one per page load). The ring only bounds a
 *  pathological reconnect loop. */
export const STALE_MEMORY = 64

export class InstanceBook {
  /** cid → the instance id that currently owns the glasses for that identity. */
  private readonly current = new Map<string, string>()
  /** Superseded instance ids, newest last. */
  private stale: string[] = []

  /** The owning instance for an identity, or undefined when none has connected. */
  currentOf(cid: string): string | undefined {
    return this.current.get(cid)
  }

  /** What to do with a stream that has just opened. Pure — it changes nothing.
   *  `cid` is unused (an instance id is random per page load, so "superseded" is a property of
   *  the id alone); it stays so callers keep thinking in (identity, instance) pairs. */
  verdict(_cid: string, inst: string): InstanceVerdict {
    // A client that sends no instance id is never superseded and never supersedes anyone.
    if (!inst) return 'ignore'
    if (this.stale.includes(inst)) return 'stale'
    return 'adopt'
  }

  /** Record that `inst` now owns the glasses for `cid`. Returns the instance id it displaced,
   *  or null when it displaced nobody (first connection, or the same instance reconnecting).
   *  The displaced id is remembered, so that page's EventSource retry gets `stale`. */
  adopt(cid: string, inst: string): string | null {
    if (!inst) return null
    const prev = this.current.get(cid)
    this.current.set(cid, inst)
    if (prev === undefined || prev === inst) return null
    this.stale.push(prev)
    if (this.stale.length > STALE_MEMORY) this.stale = this.stale.slice(-STALE_MEMORY)
    return prev
  }

  /** Forget everything. Only for shutdown/tests — a disconnect must not call this: a quiet
   *  stream does not mean the old page is gone, and forgetting would let it reclaim the
   *  glasses by reconnecting. */
  reset(): void {
    this.current.clear()
    this.stale = []
  }
}
