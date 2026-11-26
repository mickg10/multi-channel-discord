/**
 * Channel subscriptions for the agent bus: which sessions receive messages posted in
 * which Discord channels. Native sessions use their durable identity. Legacy
 * subscriptions follow a renamed or reconnecting instance.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

export type ChannelOwner = { name: string; instanceId?: string; host?: string } | { identity: string }

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

  recordChannelOwner(channel: string, owner: ChannelOwner): void {
    if (this.channelOwners.has(channel)) return
    this.channelOwners.set(channel, owner)
    this.save()
  }

  isChannelOwner(channel: string, caller: ChannelOwner): boolean {
    const owner = this.channelOwners.get(channel)
    if (!owner) return false
    if ('identity' in owner) return 'identity' in caller && owner.identity === caller.identity
    return 'name' in caller && !!owner.host && !!owner.instanceId &&
      owner.host === caller.host && owner.instanceId === caller.instanceId
  }

  private moveChannelOwnership(name: string, destination: ChannelOwner): boolean {
    let changed = false
    const instanceId = this.owners.get(name)
    for (const [channel, owner] of this.channelOwners) {
      if (!('name' in owner) || owner.name !== name ||
          (owner.instanceId !== undefined && owner.instanceId !== instanceId)) continue
      this.channelOwners.set(channel, 'name' in destination ? { ...owner, name: destination.name } : destination)
      changed = true
    }
    return changed
  }

  channelOwnerAliases(): string[] {
    return [...this.channelOwners.values()].flatMap(owner => owner && 'name' in owner ? [owner.name] : [])
  }

  reclaim(name: string, instanceId?: string): void {
    if (this.owners.get(name) === instanceId) return
    const old = instanceId && [...this.owners].find(([, owner]) => owner === instanceId)?.[0]
    if (old) {
      this.move(this.map, old, name)
      this.moveChannelOwnership(old, { name, instanceId })
      this.owners.delete(old)
    }
    if (instanceId) this.owners.set(name, instanceId)
    else this.owners.delete(name)
    this.save()
  }

  rename(oldName: string, name: string): void {
    if (oldName === name) return
    this.move(this.map, oldName, name)
    const owner = this.owners.get(oldName)
    this.moveChannelOwnership(oldName, { name, instanceId: owner })
    this.owners.delete(oldName)
    if (owner) this.owners.set(name, owner)
    else this.owners.delete(name)
    this.save()
  }

  migrateToNative(name: string, identity: string): void {
    const movedOwner = this.moveChannelOwnership(name, { identity })
    if (!this.map.has(name) && !movedOwner) return
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
