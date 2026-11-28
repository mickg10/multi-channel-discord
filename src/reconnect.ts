const MAX_BACKOFF_MS = 30_000 as const

/** Compute exponential backoff delay for a given attempt (0-indexed). */
export function computeBackoff(attempt: number): number {
  const delay = 1000 * Math.pow(2, attempt)
  return Math.min(delay, MAX_BACKOFF_MS)
}

/** A synthetic close and the eventual real close belong to the same connection. */
export function connectionClosed(isCurrent: () => boolean, clear: () => void, reconnect: () => void): () => void {
  let handled = false
  return () => {
    if (handled || !isCurrent()) return
    handled = true
    clear()
    reconnect()
  }
}
