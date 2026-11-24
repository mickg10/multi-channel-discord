/**
 * Channel subscriptions for the agent bus: which sessions receive messages posted in
 * which Discord channels. Keyed by session name (stable: "<agent>@<host>:<dir>") so
 * subscriptions survive reconnects and router restarts. Persisted as JSON in the state dir.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

export class Subscriptions {
  private readonly map = new Map<string, Set<string>>()

  constructor(private readonly file?: string) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>
      for (const [name, chans] of Object.entries(raw)) this.map.set(name, new Set(chans))
    } catch {}
  }

  static inStateDir(stateDir: string): Subscriptions {
    return new Subscriptions(join(stateDir, 'subscriptions.json'))
  }

  of(name: string): string[] {
    return [...(this.map.get(name) ?? [])]
  }

  has(name: string, channelId: string): boolean {
    return this.map.get(name)?.has(channelId) ?? false
  }

  add(name: string, channelId: string): boolean {
    const set = this.map.get(name) ?? new Set<string>()
    if (set.has(channelId)) return false
    set.add(channelId)
    this.map.set(name, set)
    this.save()
    return true
  }

  remove(name: string, channelId: string): boolean {
    const set = this.map.get(name)
    if (!set?.delete(channelId)) return false
    if (set.size === 0) this.map.delete(name)
    this.save()
    return true
  }

  /** Session names subscribed to a channel. */
  subscribers(channelId: string): string[] {
    return [...this.map.entries()].filter(([, s]) => s.has(channelId)).map(([n]) => n)
  }

  /** Every channel that has at least one subscriber. */
  channels(): Set<string> {
    const out = new Set<string>()
    for (const s of this.map.values()) for (const c of s) out.add(c)
    return out
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries([...this.map].map(([k, v]) => [k, [...v]])), null, 2))
      renameSync(tmp, this.file)
    } catch (err: unknown) {
      process.stderr.write(`discord channel: failed to save subscriptions: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}
