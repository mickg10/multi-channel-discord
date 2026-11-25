/**
 * Wake policy for the agent bus.
 *
 * Directed mail (exact session, a reply to that session, an explicit @all, a human
 * approval bound to a question) may wake. Everything else is a passive unread count:
 * the body stays in channel history and is not copied into the durable inbox.
 * A router restart therefore cannot replay chatter as wakes.
 */

export type CostClass = 'cheap' | 'standard' | 'premium'

const COST_RANK: Record<CostClass, number> = { cheap: 0, standard: 1, premium: 2 }

export function isCostClass(value: unknown): value is CostClass {
  return value === 'cheap' || value === 'standard' || value === 'premium'
}

/** Exact session name only. A prefix, even a unique one, is not a delivery. */
export function resolveExact(to: string, names: readonly string[]): { ok: true; name: string } | { ok: false; error: string } {
  if (names.includes(to)) return { ok: true, name: to }
  const prefix = names.filter(n => n.startsWith(to))
  if (prefix.length === 0) return { ok: false, error: `No session named "${to}". Connected: ${names.join(', ') || '(none)'}` }
  return { ok: false, error: `"${to}" is not an exact session name. Matches: ${prefix.join(', ')}. Use the full name.` }
}

export function orderByCost(names: readonly string[], costOf: (name: string) => CostClass): string[] {
  return [...names].sort((a, b) => COST_RANK[costOf(a)] - COST_RANK[costOf(b)] || a.localeCompare(b))
}

/** Passive messages since this process started. Not durable: a restart drops the count and wakes nobody. */
export class Unread {
  private readonly counts = new Map<string, number>()
  /** Messages that did not start a turn. Bodies are not attached, so they add no prompt tokens here. */
  turnsAvoided = 0

  bump(names: readonly string[]): void {
    for (const name of names) {
      this.counts.set(name, (this.counts.get(name) ?? 0) + 1)
      this.turnsAvoided++
    }
  }

  count(name: string): number {
    return this.counts.get(name) ?? 0
  }

  /** Read and zero. The next check does not see the same chatter again. */
  take(name: string): number {
    const n = this.counts.get(name) ?? 0
    if (n) this.counts.set(name, 0)
    return n
  }
}

export class CostClasses {
  private readonly m = new Map<string, CostClass>()
  set(name: string, value: unknown): void {
    if (isCostClass(value)) this.m.set(name, value)
  }
  get(name: string): CostClass {
    return this.m.get(name) ?? 'standard'
  }
}

/**
 * Recent human posts, keyed by Discord message id. The dispatcher re-delivers
 * one of these verbatim. Not durable: a restart forgets them.
 */
export class HumanMail {
  private readonly items = new Map<string, { content: string; meta: Record<string, string | undefined> }>()
  private readonly ids: string[] = []

  remember(content: string, meta: { message_id?: string; from_human?: string }): void {
    const id = meta.message_id
    if (!id || meta.from_human !== 'true' || this.items.has(id)) return
    this.items.set(id, { content, meta: { ...meta } })
    this.ids.push(id)
    while (this.ids.length > 200) {
      const old = this.ids.shift()
      if (old) this.items.delete(old)
    }
  }

  get(id: string): { content: string; meta: Record<string, string | undefined> } | undefined {
    return this.items.get(id)
  }
}

/** Last conversation id a session registered with. Kept after disconnect so a held approval can be stamped. */
export class Conversations {
  private readonly ids = new Map<string, string>()
  set(name: string, id: string): void {
    if (id) this.ids.set(name, id)
  }
  get(name: string): string | undefined {
    return this.ids.get(name)
  }
}

/** One directed inbox line. question_id and in_reply_to stay visible so two short replies are not the same. */
export function formatInboxLine(m: { content: string; meta: { [key: string]: string | undefined }; at: string }): string {
  const from = m.meta.from ?? m.meta.user ?? 'unknown'
  const where = m.meta.source === 'agent-bus'
    ? `#${m.meta.channel ?? 'bus'} chat_id=${m.meta.chat_id ?? '?'}`
    : `chat ${m.meta.chat_id ?? '?'}`
  const ids = [
    m.meta.message_id ? `msg=${m.meta.message_id}` : '',
    m.meta.question_id ? `question_id=${m.meta.question_id}` : '',
    m.meta.in_reply_to ? `in_reply_to=${m.meta.in_reply_to}` : '',
  ].filter(Boolean).join(' ')
  return `[${m.meta.ts ?? m.at}] (${where}) from ${from}${ids ? ` ${ids}` : ''}:\n${m.content}`
}

/** Last time a session posted. Separate from "connected" and from inbox depth. */
export class Activity {
  private readonly posts = new Map<string, string>()
  markPost(name: string, at = new Date().toISOString()): void {
    this.posts.set(name, at)
  }
  lastPost(name: string): string | undefined {
    return this.posts.get(name)
  }
}

export interface WakeEmission {
  readonly name: string
  readonly messageId?: string
  readonly pending: number
  readonly cold: boolean
  readonly at: number
}

/** Test seam: every wake deliver() actually performed, with the id the recipient was given. */
export class WakeLog {
  readonly emissions: WakeEmission[] = []
  cold = 0
  piggyback = 0
  record(e: WakeEmission): void {
    this.emissions.push(e)
    if (e.cold) this.cold++
    else this.piggyback++
  }
  for(name: string): WakeEmission[] {
    return this.emissions.filter(e => e.name === name)
  }
}

/**
 * Cold wakes (a turn started for an idle session) per cost class, per window.
 * Human-addressed mail does not count. Over the cap the message stays in channel
 * history as unread and does not wake.
 */
export class WakeBudget {
  private readonly hits = new Map<string, number[]>()
  constructor(
    private readonly limits: Record<CostClass, number>,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  allow(name: string, cost: CostClass, now = Date.now()): boolean {
    const limit = this.limits[cost]
    const recent = (this.hits.get(name) ?? []).filter(t => now - t < this.windowMs)
    if (recent.length >= limit) {
      this.hits.set(name, recent)
      return false
    }
    recent.push(now)
    this.hits.set(name, recent)
    return true
  }
}

export type LatchDecision = 'send' | 'hold' | 'skip'

/**
 * Single-flight tmux nudge. `hold` means a directed message arrived while a nudge
 * is unacked: it stays in the inbox and must not be dropped. `skip` means there is
 * nothing addressed, so an empty inbox must not start a turn.
 */
export function latchDecision(inFlight: boolean, pendingDirected: number): LatchDecision {
  if (pendingDirected <= 0) return 'skip'
  if (inFlight) return 'hold'
  return 'send'
}

/** Ack from check_inbox. A message that landed after the drain still nudges once. */
export function afterDrain(remainingDirected: number): { inFlight: false; nudge: boolean } {
  return { inFlight: false, nudge: remainingDirected > 0 }
}
