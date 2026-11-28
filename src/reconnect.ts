const MAX_BACKOFF_MS = 30_000 as const

/** Plugin ping interval. The router drops a client after three of these with no ping. */
export const PING_INTERVAL_MS = 15_000

/** True when a ping was sent and no pong has arrived for it. */
export function pingMissed(sentAt: number | undefined, pongAt: number | undefined): boolean {
  return sentAt !== undefined && (pongAt === undefined || pongAt < sentAt)
}

/** Compute exponential backoff delay for a given attempt (0-indexed). */
export function computeBackoff(attempt: number): number {
  const delay = 1000 * Math.pow(2, attempt)
  return Math.min(delay, MAX_BACKOFF_MS)
}
