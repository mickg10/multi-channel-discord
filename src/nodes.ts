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

export { Inboxes } from './inboxes.js'
export type { QueuedMessage } from './inboxes.js'

export interface NodeAgent {
  readonly name: string
  readonly kind: string
  readonly cwd?: string
  readonly node: string
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

  /** Send a raw message to a named node's daemon (e.g. mcpExec). False if it is not connected. */
  sendToNode(node: string, msg: unknown): boolean {
    const send = this.nodes.get(node)
    if (!send) return false
    try { send(JSON.stringify(msg)) } catch { return false }
    return true
  }

  /** Is a daemon connected under this node name? */
  nodeConnected(node: string): boolean { return this.nodes.has(node) }
}

export interface Claim {
  readonly task: string
  readonly owner: string
  readonly since: string
  readonly note?: string
  readonly swarm?: string
}

/** Atomic first-come task claims, partitioned by `(swarm, task)` so swarms are isolated (§4). */
export class Claims {
  private readonly map = new Map<string, Claim>()
  constructor(private readonly file?: string, private readonly ttlMs = 12 * 3600_000) {
    if (!file) return
    try {
      for (const c of JSON.parse(readFileSync(file, 'utf8')) as Claim[]) {
        this.map.set(Claims.compositeKey(c.task, c.swarm), c)
      }
    } catch {}
  }
  static inStateDir(dir: string): Claims { return new Claims(join(dir, 'claims.json')) }
  static key(task: string): string { return task.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200) }
  private static compositeKey(task: string, swarm = 'default'): string {
    const k = Claims.key(task)
    return swarm === 'default' ? k : `${swarm}\0${k}`
  }
  private expire(): void {
    const now = Date.now()
    for (const [k, c] of this.map) if (now - Date.parse(c.since) > this.ttlMs) this.map.delete(k)
  }
  /** Claim `task` for `owner` within `swarm`. Returns the winning claim (yours if you got it or already had it). */
  claim(task: string, owner: string, note?: string, swarm = 'default'): { won: boolean; claim: Claim } {
    this.expire()
    const k = Claims.key(task)
    const ck = Claims.compositeKey(task, swarm)
    const cur = this.map.get(ck)
    if (cur && cur.owner !== owner) return { won: false, claim: cur }
    const c: Claim = cur ?? {
      task: k, owner, since: new Date().toISOString(),
      ...(note && { note }),
      ...(swarm !== 'default' && { swarm }),
    }
    this.map.set(ck, c); this.save()
    return { won: true, claim: c }
  }
  /** Release (owner only), or hand over to `to`, within `swarm`. */
  release(task: string, owner: string, to?: string, swarm = 'default'): { ok: boolean; claim?: Claim } {
    const ck = Claims.compositeKey(task, swarm)
    const cur = this.map.get(ck)
    if (!cur) return { ok: true }
    if (cur.owner !== owner) return { ok: false, claim: cur }
    if (to) this.map.set(ck, { ...cur, owner: to, since: new Date().toISOString() })
    else this.map.delete(ck)
    this.save()
    return { ok: true, claim: this.map.get(ck) }
  }
  list(swarm?: string): Claim[] {
    this.expire()
    const all = [...this.map.values()]
    return swarm === undefined ? all : all.filter(c => (c.swarm ?? 'default') === swarm)
  }
  hasOwner(owner: string, swarm?: string): boolean {
    this.expire()
    for (const c of this.map.values()) {
      if (c.owner === owner && (swarm === undefined || (c.swarm ?? 'default') === swarm)) return true
    }
    return false
  }
  dropByOwner(owner: string, swarm?: string): number {
    this.expire()
    let dropped = 0
    for (const [k, c] of this.map) {
      if (c.owner === owner && (swarm === undefined || (c.swarm ?? 'default') === swarm)) {
        this.map.delete(k)
        dropped++
      }
    }
    if (dropped > 0) this.save()
    return dropped
  }
  private save(): void {
    if (!this.file) return
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(this.list(), null, 2)) } catch {}
  }
}
