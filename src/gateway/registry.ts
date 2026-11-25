import { identityKey, type Target } from './types.js'

export type AgentRec = Target & {
  pid: number
  cwd?: string
  transport: 'native' | 'pull' | 'tmux'
  /** Bumped on every add. Pipe connections captured an older generation are stale. */
  gen?: number
}

export class Registry {
  private byKey = new Map<string, AgentRec>()
  private pids = new Map<number, Set<string>>()
  private aliases = new Map<string, string>()
  private generation = 0

  add(rec: AgentRec): void {
    const stored: AgentRec = { ...rec, gen: ++this.generation }
    const oldKey = this.aliases.get(stored.alias)
    if (oldKey) this.dropKey(oldKey)
    const key = identityKey(stored)
    rec = stored
    const prev = this.byKey.get(key)
    if (prev) this.unlink(prev.pid, key)
    this.byKey.set(key, rec)
    const pids = this.pids.get(rec.pid) ?? new Set<string>()
    pids.add(key)
    this.pids.set(rec.pid, pids)
    this.aliases.set(rec.alias, key)
  }

  remove(alias: string): void {
    const key = this.aliases.get(alias)
    if (key) this.dropKey(key)
  }

  get(id: Target): AgentRec | undefined {
    return this.byKey.get(identityKey(id))
  }

  /** One process can host several conversations. */
  byPid(pid: number): AgentRec[] {
    const keys = this.pids.get(pid)
    if (!keys) return []
    return [...keys].flatMap(key => {
      const rec = this.byKey.get(key)
      return rec ? [rec] : []
    })
  }

  byAlias(alias: string): AgentRec | undefined {
    const key = this.aliases.get(alias)
    return key ? this.byKey.get(key) : undefined
  }

  /** True only for the record currently bound to this alias and generation. */
  matches(rec: AgentRec): boolean {
    const current = this.byAlias(rec.alias)
    return !!current && current.gen !== undefined && current.gen === rec.gen && identityKey(current) === identityKey(rec)
  }

  list(): AgentRec[] {
    return [...this.byKey.values()]
  }

  private unlink(pid: number, key: string): void {
    const keys = this.pids.get(pid)
    if (!keys) return
    keys.delete(key)
    if (keys.size === 0) this.pids.delete(pid)
  }

  private dropKey(key: string): void {
    const prev = this.byKey.get(key)
    if (!prev) return
    this.unlink(prev.pid, key)
    this.byKey.delete(key)
    if (this.aliases.get(prev.alias) === key) this.aliases.delete(prev.alias)
  }
}
