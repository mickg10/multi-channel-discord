/**
 * Channel subscriptions for the agent bus: which sessions receive messages posted in
 * which Discord channels. Native sessions use their durable identity. Legacy
 * subscriptions follow a renamed or reconnecting instance.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

export type ChannelOwner = { name: string; instanceId?: string } | { identity: string }

interface SubscriptionState {
  version: 1
  legacy: Record<string, string[]>
  native: Record<string, string[]>
  owners: Record<string, string>
  channelOwners?: Record<string, ChannelOwner>
}

export class Subscriptions {
  private readonly map = new Map<string, Set<string>>()
  private readonly native = new Map<string, Set<string>>()
  private readonly owners = new Map<string, string>()
  private readonly channelOwners = new Map<string, ChannelOwner>()
  private unversioned = false

  constructor(private readonly file?: string) {
    if (!file) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as SubscriptionState | Record<string, string[]>
      if (raw.version === 1) {
        const state = raw as SubscriptionState
        for (const [name, channels] of Object.entries(state.legacy)) this.map.set(name, new Set(channels))
        for (const [key, channels] of Object.entries(state.native)) this.native.set(key, new Set(channels))
        for (const [name, instance] of Object.entries(state.owners)) this.owners.set(name, instance)
        for (const [channel, owner] of Object.entries(state.channelOwners ?? {})) this.channelOwners.set(channel, owner)
      } else {
        this.unversioned = true
        for (const [name, channels] of Object.entries(raw)) this.map.set(name, new Set(channels))
      }
    } catch {}
  }

  static inStateDir(stateDir: string): Subscriptions {
    return new Subscriptions(join(stateDir, 'subscriptions.json'))
  }

  of(name: string): string[] {
    return [...(this.map.get(name) ?? [])]
  }

  has(name: string, channelId: string, identity?: string): boolean {
    return (identity === undefined ? this.map.get(name) : this.native.get(identity))?.has(channelId) ?? false
  }

  add(name: string, channelId: string, identity?: string): boolean {
    const map = identity === undefined ? this.map : this.native
    const key = identity ?? name
    const set = map.get(key) ?? new Set<string>()
    if (set.has(channelId)) return false
    set.add(channelId)
    map.set(key, set)
    this.save()
    return true
  }

  remove(name: string, channelId: string, identity?: string): boolean {
    const map = identity === undefined ? this.map : this.native
    const key = identity ?? name
    const set = map.get(key)
    if (!set?.delete(channelId)) return false
    if (set.size === 0) map.delete(key)
    this.save()
    return true
  }

  /** Session names subscribed to a channel. */
  subscribers(channelId: string): string[] {
    return [...this.map.entries()].filter(([, s]) => s.has(channelId)).map(([n]) => n)
  }

  nativeSubscribers(channelId: string): string[] {
    return [...this.native].filter(([, channels]) => channels.has(channelId)).map(([key]) => key)
  }

  channelOwnerAliases(): string[] {
    return [...this.channelOwners.values()].flatMap(owner => owner && 'name' in owner ? [owner.name] : [])
  }

  reclaim(name: string, instanceId?: string, host?: string): void {
    const ownerKey = instanceId ? (host ? `${host}:${instanceId}` : instanceId) : undefined
    if (this.owners.get(name) === ownerKey) return
    const old = ownerKey && (
      [...this.owners].find(([, owner]) => owner === ownerKey)?.[0] ??
      (host && instanceId ? [...this.owners].find(([, owner]) => owner === instanceId)?.[0] : undefined)
    )
    if (old) {
      if (old !== name) this.move(this.map, old, name)
      this.owners.delete(old)
    }
    if (ownerKey) this.owners.set(name, ownerKey)
    else this.owners.delete(name)
    this.save()
  }

  /** Drop all legacy channel subscriptions for `name` (e.g. when a name moves swarms). */
  clear(name: string): boolean {
    if (!this.map.delete(name)) return false
    this.save()
    return true
  }

  /** Whether `name` has any legacy channel subscriptions. */
  hasAny(name: string): boolean {
    const set = this.map.get(name)
    return !!set && set.size > 0
  }

  rename(oldName: string, name: string): void {
    if (oldName === name) return
    this.move(this.map, oldName, name)
    const owner = this.owners.get(oldName)
    this.owners.delete(oldName)
    if (owner) this.owners.set(name, owner)
    else this.owners.delete(name)
    this.save()
  }

  migrateToNative(name: string, identity: string): void {
    if (!this.map.has(name)) return
    this.move(this.native, name, identity)
    this.owners.delete(name)
    this.save()
  }

  upgradeNativeAliases(aliases: Iterable<[string, string]>): void {
    if (!this.unversioned) return
    this.unversioned = false
    for (const [name, identity] of aliases) {
      this.move(this.native, name, identity)
      this.owners.delete(name)
    }
    this.save()
  }

  moveChannel(from: string, to?: string): void {
    for (const map of [this.map, this.native]) for (const [key, channels] of map) {
      if (!channels.delete(from)) continue
      if (to) channels.add(to)
      if (channels.size === 0) map.delete(key)
    }
    this.save()
  }

  private move(destination: Map<string, Set<string>>, oldName: string, key: string): void {
    const channels = this.map.get(oldName)
    if (!channels) return
    this.map.delete(oldName)
    destination.set(key, new Set([...(destination.get(key) ?? []), ...channels]))
  }

  /** Every channel that has at least one subscriber. */
  channels(): Set<string> {
    const out = new Set<string>()
    for (const map of [this.map, this.native]) for (const channels of map.values()) for (const c of channels) out.add(c)
    return out
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      const serialize = (map: Map<string, Set<string>>) => Object.fromEntries([...map].map(([key, channels]) => [key, [...channels]]))
      const state: SubscriptionState = {
        version: 1, legacy: serialize(this.map), native: serialize(this.native), owners: Object.fromEntries(this.owners),
        channelOwners: Object.fromEntries(this.channelOwners),
      }
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, this.file)
    } catch (err: unknown) {
      process.stderr.write(`discord channel: failed to save subscriptions: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}
