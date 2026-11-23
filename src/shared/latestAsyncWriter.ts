// Serialise async writes per key, coalescing stale queued values.
//
// Used by the client for glasses text-container writes, which must never run concurrently
// and for which only the newest content matters.

/** Serialise asynchronous writes per key while coalescing queued stale values. An in-flight
 *  write cannot be cancelled, but the newest value always runs after it and owns the final state. */
export class LatestAsyncWriter<K, V> {
  private desired = new Map<K, V>()
  private tails = new Map<K, Promise<void>>()

  write(key: K, value: V, apply: (value: V) => Promise<void>): Promise<void> {
    this.desired.set(key, value)
    const prior = this.tails.get(key) ?? Promise.resolve()
    const next = prior
      .catch(() => {})
      .then(async () => {
        if (this.desired.get(key) === value) await apply(value)
      })
    this.tails.set(key, next)
    // Not `finally()`: it returns a second promise carrying the rejection, which would be
    // unhandled even when the caller catches `next`.
    const cleanup = () => {
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
    void next.then(cleanup, cleanup)
    return next
  }
}
