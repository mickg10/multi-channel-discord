/**
 * Name -> swarm journal: `${STATE_DIR}/agent-swarms.json`.
 *
 * Persists `{ "<name>": { "swarm": "<swarm>", "holder": "<host>:<instanceId>" } }`.
 * Written on register and rename; cleaned up when a name is offline and has no
 * inbox rows, subscriptions, claims, or direct channel.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isBusAlias } from './bus-alias.js'

export interface SwarmJournalEntry {
  readonly swarm: string
  readonly holder?: string
}

type JournalFile = Record<string, SwarmJournalEntry>

export function holderKey(host: string | undefined, instanceId: string | undefined): string | undefined {
  return instanceId ? `${host ?? ''}:${instanceId}` : undefined
}

export class SwarmJournal {
  private readonly map = new Map<string, SwarmJournalEntry>()

  constructor(private readonly file?: string) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as JournalFile
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [name, entry] of Object.entries(raw)) {
          if (isBusAlias(name) && entry && typeof entry.swarm === 'string' && entry.swarm.length > 0) {
            const holder = typeof entry.holder === 'string' && entry.holder.length > 0 ? entry.holder : undefined
            this.map.set(name, holder !== undefined ? { swarm: entry.swarm, holder } : { swarm: entry.swarm })
          }
        }
      }
    } catch {}
  }

  static inStateDir(stateDir: string): SwarmJournal {
    return new SwarmJournal(join(stateDir, 'agent-swarms.json'))
  }

  get(name: string): SwarmJournalEntry | undefined {
    return this.map.get(name)
  }

  set(name: string, swarm: string, holder?: string): void {
    const prev = this.map.get(name)
    const next: SwarmJournalEntry = holder ? { swarm, holder } : { swarm }
    if (prev && prev.swarm === next.swarm && prev.holder === next.holder) return
    this.map.set(name, next)
    this.save()
  }

  delete(name: string): boolean {
    if (!this.map.delete(name)) return false
    this.save()
    return true
  }

  entries(): IterableIterator<[string, SwarmJournalEntry]> {
    return this.map.entries()
  }

  get size(): number {
    return this.map.size
  }

  /** Remove all entries where `keep(name)` returns false. Returns count removed. */
  cleanup(keep: (name: string) => boolean): number {
    let removed = 0
    for (const name of [...this.map.keys()]) {
      if (!keep(name)) {
        this.map.delete(name)
        removed++
      }
    }
    if (removed > 0) this.save()
    return removed
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map), null, 2), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err: unknown) {
      process.stderr.write(`discord channel: failed to save agent swarms journal: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}
