/**
 * Node agents + durable inboxes.
 *
 * A *node* is a per-machine daemon (src/node.ts) that runs agents headless, one turn at a time.
 * Its agents exist on the bus even between turns: messages for them are queued in a durable
 * inbox and the node is told to wake the agent. Agents read the queue with check_inbox
 * (inboxPull). Interactive push-capable sessions get queued messages flushed when they connect.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { ChannelMeta } from './types.js'

export interface QueuedMessage {
  readonly content: string
  readonly meta: ChannelMeta
  readonly at: string
}

export interface NodeAgent {
  readonly name: string
  readonly kind: string
  readonly cwd?: string
  readonly node: string
}

const INBOX_MAX = 500

export class Inboxes {
  private readonly map = new Map<string, QueuedMessage[]>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly file?: string) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, QueuedMessage[]>
      for (const [k, v] of Object.entries(raw)) if (Array.isArray(v) && v.length) this.map.set(k, v)
    } catch {}
  }

  static inStateDir(dir: string): Inboxes {
    return new Inboxes(join(dir, 'inboxes.json'))
  }

  push(name: string, content: string, meta: ChannelMeta): number {
    const q = this.map.get(name) ?? []
    q.push({ content, meta, at: new Date().toISOString() })
    if (q.length > INBOX_MAX) q.splice(0, q.length - INBOX_MAX)
    this.map.set(name, q)
    this.save()
    return q.length
  }

  count(name: string): number {
    return this.map.get(name)?.length ?? 0
  }

  drain(name: string): QueuedMessage[] {
    const q = this.map.get(name) ?? []
    if (q.length) { this.map.delete(name); this.save() }
    return q
  }

  private save(): void {
    if (!this.file || this.saveTimer) return
    // Coalesce bursts; still durable within ~200ms.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        mkdirSync(dirname(this.file!), { recursive: true })
        const tmp = `${this.file}.tmp`
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)))
        renameSync(tmp, this.file!)
      } catch (err: unknown) {
        process.stderr.write(`discord channel: failed to save inboxes: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }, 200)
  }
}

export class NodeRegistry {
  private readonly agents = new Map<string, NodeAgent>()
  private readonly nodes = new Map<string, (msg: string) => void>()

  register(node: string, send: (msg: string) => void, agents: ReadonlyArray<{ name: string; kind: string; cwd?: string }>): void {
    // Replace this node's previous agent set.
    for (const [n, a] of this.agents) if (a.node === node) this.agents.delete(n)
    for (const a of agents) this.agents.set(a.name, { ...a, node })
    this.nodes.set(node, send)
  }

  unregister(node: string, send: (msg: string) => void): void {
    if (this.nodes.get(node) !== send) return // a newer connection took over
    this.nodes.delete(node)
    for (const [n, a] of this.agents) if (a.node === node) this.agents.delete(n)
  }

  get(name: string): NodeAgent | undefined {
    return this.agents.get(name)
  }

  list(): NodeAgent[] {
    return [...this.agents.values()]
  }

  /** Ask the owning node to run a turn for `name`. Returns false if no node owns it. */
  wake(name: string, pending: number): boolean {
    const a = this.agents.get(name)
    const send = a && this.nodes.get(a.node)
    if (!send) return false
    try { send(JSON.stringify({ type: 'wake', agent: name, pending })) } catch { return false }
    return true
  }
}
