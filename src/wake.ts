/**
 * Wake policy for the agent bus.
 *
 * A model turn is expensive. Only a message addressed to one session may start one.
 * Everything else is passive history: stored here, summarized on the next check_inbox,
 * and never written to the durable inbox (so a router restart cannot replay it as a wake).
 */

export interface PassiveNote {
  readonly id: string
  readonly channelId: string
  readonly from: string
  readonly text: string
  readonly at: string
}

export class PassiveLog {
  private notes: PassiveNote[] = []
  private readonly cursor = new Map<string, number>()
  private seq = 0

  constructor(private readonly max = 100) {}

  add(note: { channelId: string; from: string; text: string; at?: string }): void {
    this.seq++
    this.notes.push({
      id: String(this.seq),
      channelId: note.channelId,
      from: note.from,
      text: note.text.replace(/\s+/g, ' ').slice(0, 240),
      at: note.at ?? new Date().toISOString(),
    })
    if (this.notes.length > this.max) {
      const drop = this.notes.length - this.max
      this.notes.splice(0, drop)
      for (const [k, v] of this.cursor) this.cursor.set(k, Math.max(0, v - drop))
    }
  }

  /** Notes this session has not pulled and is allowed to see. Advances the cursor. */
  summary(name: string, allow: (channelId: string) => boolean, limit = 20): string {
    const start = this.cursor.get(name) ?? 0
    const unseen = this.notes.slice(start).filter(n => allow(n.channelId))
    this.cursor.set(name, this.notes.length)
    if (unseen.length === 0) return ''
    const shown = unseen.slice(0, limit)
    const lines = shown.map(n => `${n.from}: ${n.text.slice(0, 80)}`)
    const more = unseen.length - shown.length
    return `Since you last looked (${unseen.length} passive, not a wake):\n${lines.join('\n')}${more > 0 ? `\n… and ${more} more` : ''}`
  }
}

export type ResolveResult = { ok: true; names: string[] } | { ok: false; error: string }

/** Exact name, or a prefix that matches exactly one session. Two or more matches do not fan out. */
export function resolveRecipients(want: string, names: readonly string[]): ResolveResult {
  const exact = names.filter(n => n === want)
  if (exact.length === 1) return { ok: true, names: exact }
  const prefix = names.filter(n => n.startsWith(want))
  if (prefix.length === 1) return { ok: true, names: prefix }
  if (prefix.length > 1) {
    return { ok: false, error: `"${want}" matches ${prefix.join(', ')}. Name one exact session. Not sent.` }
  }
  return { ok: false, error: `No connected session matches "${want}". Connected: ${names.join(', ') || '(none)'}` }
}

/** Author of an agent post the router mirrored to Discord: `**[name → …]**`. */
export function askerFromBotPost(content: string): string | null {
  const m = content.match(/^\*\*\[([^\]\s]+) →/)
  return m ? m[1] : null
}

export interface WakeLatch {
  /** A directed message arrived. At most one nudge is emitted until ack. */
  arrive(): void
  /** The client drained its inbox. `left` is how many directed messages remain. */
  ack(left: number): void
}

/**
 * Single-flight tmux wake. A burst emits one nudge. A message that arrives while that
 * nudge is unacked stays queued and causes one more nudge only if `left > 0` after ack.
 * An empty drain emits nothing. If the client never acks, the latch opens again after
 * `maxInFlightMs` so a dropped turn cannot swallow later mail.
 */
export function createWakeLatch(emit: () => void, opts: { coalesceMs?: number; maxInFlightMs?: number; pending?: () => number } = {}): WakeLatch {
  const coalesceMs = opts.coalesceMs ?? 2000
  const maxInFlightMs = opts.maxInFlightMs ?? 15 * 60_000
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let flight: ReturnType<typeof setTimeout> | null = null
  function schedule(): void {
    if (inFlight || timer) return
    timer = setTimeout(() => {
      timer = null
      if (inFlight) return
      inFlight = true
      if (flight) clearTimeout(flight)
      // If check_inbox never runs, open the latch and nudge again only while mail is still queued.
      flight = setTimeout(() => {
        inFlight = false
        flight = null
        if ((opts.pending?.() ?? 0) > 0) schedule()
      }, maxInFlightMs)
      emit()
    }, coalesceMs)
  }
  return {
    arrive() { schedule() },
    ack(left: number) {
      inFlight = false
      if (flight) { clearTimeout(flight); flight = null }
      if (left > 0) schedule()
    },
  }
}
