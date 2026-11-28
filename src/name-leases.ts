/**
 * Name leases: which instance last held each session name, kept across router restarts.
 *
 * Instances that share a name (`<agent>@<host>:<project>` for three seats in one directory)
 * get `-2`, `-3`, ... in the order they register. After a router restarted, that was the
 * order they reconnected in, so two instances could come back with each other's name, and a
 * message meant for one reached the other.
 *
 * A lease remembers the holder. When a plain registration would be given a name, names
 * leased to another instance seen within the lease time are passed over, so each instance
 * gets its own name back whatever order it returns in. An instance that disconnects keeps
 * its lease until it expires; one that renames, or whose name is taken over, hands it on.
 *
 * `${STATE_DIR}/name-leases.json` is `{ "<name>": { "instanceId": "...", "lastSeen": <ms> } }`.
 * Only clients that present an instance id take part; one without it is named as before.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isBusAlias } from './bus-alias.js'

/** How long after its holder was last seen a lease keeps a name from another instance. */
export const NAME_LEASE_MS = 10 * 60_000

export interface NameLease {
  readonly instanceId: string
  readonly host?: string
  /** Epoch milliseconds of the last time the router saw the holder connected. */
  readonly lastSeen: number
}

type LeaseFile = Record<string, NameLease>

export class NameLeases {
  private readonly leases = new Map<string, NameLease>()

  /** Without a file the leases live in memory only. `now` is injectable, for tests. */
  constructor(
    private readonly file?: string,
    private readonly ttlMs = NAME_LEASE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as LeaseFile
      for (const [name, lease] of Object.entries(raw)) {
        if (isBusAlias(name) && lease && typeof lease.instanceId === 'string' &&
            typeof lease.lastSeen === 'number') {
          const host = typeof lease.host === 'string' && lease.host.length > 0 ? lease.host : undefined
          this.leases.set(name, host !== undefined
            ? { instanceId: lease.instanceId, host, lastSeen: lease.lastSeen }
            : { instanceId: lease.instanceId, lastSeen: lease.lastSeen })
        }
      }
    } catch {}
    this.expire()
  }

  static inStateDir(stateDir: string, ttlMs?: number, now?: () => number): NameLeases {
    return new NameLeases(join(stateDir, 'name-leases.json'), ttlMs, now)
  }

  /** `instanceId` (optionally scoped by `host`) holds `name` from now on. An instance holds one name, so its other leases end. */
  touch(name: string, instanceId: string, host?: string): void {
    this.hold(name, instanceId, host)
    this.save()
  }

  /** Several holders seen at once (the periodic refresh); the file is written once. */
  touchAll(holders: Iterable<readonly [name: string, instanceId: string, host?: string]>): void {
    let any = false
    for (const [name, instanceId, host] of holders) {
      this.hold(name, instanceId, host)
      any = true
    }
    if (any) this.save()
  }

  /** Whether `name` is leased to an instance other than `(host, instanceId)` that was seen within the lease time.
   *  A pre-PR1 row without `host` matches any host (§10.3). */
  heldByAnother(name: string, instanceId: string | undefined, host?: string): boolean {
    if (!instanceId) return false
    const lease = this.leases.get(name)
    return !!lease && !this.sameHolder(lease, instanceId, host) && this.now() - lease.lastSeen < this.ttlMs
  }

  /** End every lease whose holder has not been seen within the lease time. Returns how many. */
  expire(): number {
    let ended = 0
    for (const [name, lease] of this.leases) {
      if (this.now() - lease.lastSeen >= this.ttlMs) {
        this.leases.delete(name)
        ended++
      }
    }
    return ended
  }

  get(name: string): NameLease | undefined {
    return this.leases.get(name)
  }

  get size(): number {
    return this.leases.size
  }

  private sameHolder(lease: NameLease, instanceId: string, host?: string): boolean {
    if (lease.instanceId !== instanceId) return false
    return !lease.host || !host || lease.host === host
  }

  private hold(name: string, instanceId: string, host?: string): void {
    for (const [held, lease] of this.leases) {
      if (this.sameHolder(lease, instanceId, host) && held !== name) this.leases.delete(held)
    }
    this.leases.set(name, host !== undefined
      ? { instanceId, host, lastSeen: this.now() }
      : { instanceId, lastSeen: this.now() })
  }

  private save(): void {
    if (!this.file) return
    this.expire()
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.leases), null, 2))
      renameSync(tmp, this.file)
    } catch (err: unknown) {
      process.stderr.write(`discord channel: failed to save name leases: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}
