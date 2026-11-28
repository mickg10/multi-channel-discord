/**
 * Multi-swarm Discord channel classification, provisioning, overflow picking, and sweep (§3, §10.4).
 *
 * - Category-derived `channelSwarm(id)` — no persisted id->swarm map.
 * - `unknown` until the first full `guild.channels.fetch()` after `clientReady` completes (when configured).
 * - Single-flight per-swarm provisioning through one shared locked overflow picker (50/category).
 * - Adoption refusal guard for BUS_CHANNEL, HUMAN_CHANNEL, DISCORD_CHANNEL_OWNERS, foreign #26 channels,
 *   and channels with non-member (non-crossSwarm) subscribers.
 * - Sweep on clientReady, channelUpdate, and config reload.
 */

import { ChannelType } from 'discord.js'
import { agentChannelSlug, agentChannelTopic, type AgentChannelOps, type AgentChannels } from './agent-channels.js'
import { DEFAULT_SWARM, type SwarmConfig, type SwarmConfigDiff } from './swarm-config.js'
import type { Subscriptions } from './subscriptions.js'
import type { ChannelOps } from './ws.js'

export const ACTIVE_AGENT_CATEGORY = 'Agents'
export const ARCHIVED_AGENT_CATEGORY = 'Agents (archived)'
export const MAX_CHANNELS_PER_CATEGORY = 50

export interface GuildChannelLike {
  readonly id: string
  readonly name: string
  readonly type: ChannelType
  readonly parentId?: string | null
  readonly topic?: string | null
  readonly guildId?: string | null
  isThread?(): boolean
  isDMBased?(): boolean
  edit?(opts: { name?: string; parent?: string | null; topic?: string; reason?: string }): Promise<GuildChannelLike>
}

export interface ChannelCacheLike {
  get(id: string): GuildChannelLike | undefined
  values(): IterableIterator<GuildChannelLike>
  set?(id: string, ch: GuildChannelLike): unknown
  readonly size: number
}

export interface GuildLike {
  readonly id: string
  readonly channels: {
    readonly cache: ChannelCacheLike
    fetch(id?: string): Promise<unknown>
    create(opts: { name: string; type: ChannelType; parent?: string; topic?: string; reason?: string }): Promise<GuildChannelLike>
  }
}

export interface ChannelClientLike {
  readonly channels: {
    readonly cache?: { get(id: string): GuildChannelLike | undefined }
    fetch(id: string): Promise<GuildChannelLike | null>
  }
  isReady?(): boolean
}

export type ChannelSwarmResult =
  | { readonly kind: 'swarm'; readonly swarm: string; readonly archived: boolean }
  | { readonly kind: 'retired'; readonly swarm: string; readonly archived: boolean }
  | { readonly kind: 'dm' }
  | { readonly kind: 'unknown' }

export interface SwarmChannelsDeps {
  readonly config: SwarmConfig
  readonly client: ChannelClientLike
  readonly busChannelId?: string
  readonly humanChannelId?: string
  readonly subs?: Subscriptions
  readonly channelOwners?: Map<string, string>
  readonly agentChannels?: AgentChannels
  /** Lookup a session/offline agent's known swarm (for adoption guard and sweep). */
  readonly knownSwarm: (name: string) => string | undefined
  /** Resolve a native inbox identity key to its alias (if known), for crossSwarm checks. */
  readonly nativeAlias?: (identity: string) => string | undefined
  /** Called when a swarm finishes provisioning and its `<swarm>:general` exists (for deferred rules). */
  readonly onSwarmReady?: (swarm: string, generalId: string) => void
  /** Base backoff delay in ms for transient provisioning retries (default 2000). */
  readonly retryBaseMs?: number
  readonly maxPerCategory?: number
}

export function compareChannelIds(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a.localeCompare(b)
}

export function parseSwarmCategoryName(name: string): { id: string; archived: boolean } | null {
  const low = name.trim().toLowerCase()
  const arch = /^([a-z0-9][a-z0-9-]{0,30}) \(archived\)(?: (\d+))?$/.exec(low)
  if (arch) return { id: arch[1]!, archived: true }
  const act = /^([a-z0-9][a-z0-9-]{0,30})(?: (\d+))?$/.exec(low)
  if (act) return { id: act[1]!, archived: false }
  return null
}

export function matchesCategoryBase(name: string, base: string): boolean {
  const low = name.trim().toLowerCase()
  const b = base.trim().toLowerCase()
  return low === b || (low.startsWith(b + ' ') && /^\d+$/.test(low.slice(b.length + 1)))
}

function isThreadChannel(ch: GuildChannelLike): boolean {
  return ch.isThread?.() === true ||
    ch.type === ChannelType.PublicThread ||
    ch.type === ChannelType.PrivateThread ||
    ch.type === ChannelType.AnnouncementThread
}

function isDmChannel(ch: GuildChannelLike): boolean {
  return ch.isDMBased?.() === true || ch.type === ChannelType.DM
}

export class SwarmChannels {
  private guild: GuildLike | null = null
  private initialFetchDone = false
  private readonly refusedCategories = new Set<string>()
  /** In-memory last-seen swarm id for channels seen in a swarm/retired category (§10.4). */
  private readonly lastSeenSwarm = new Map<string, string>()
  private readonly readySwarms = new Map<string, { generalId: string; humanId: string }>()
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryAttempts = new Map<string, number>()
  private startupRetryTimer: ReturnType<typeof setTimeout> | null = null
  private startupRetryAttempt = 0
  private overflowTail: Promise<unknown> = Promise.resolve()
  private lastChannelFetch = 0
  private stopped = false

  constructor(private readonly deps: SwarmChannelsDeps) {}

  private get maxPerCategory(): number {
    return this.deps.maxPerCategory ?? MAX_CHANNELS_PER_CATEGORY
  }

  isInitialFetchDone(): boolean {
    return this.initialFetchDone
  }

  /** Serializes category selection/creation across concurrent provisions, creates, archives, and direct-channel moves. */
  private withOverflowLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.overflowTail.then(fn, fn)
    this.overflowTail = next.then(() => undefined, () => undefined)
    return next
  }

  /** Stop any pending provisioning or startup retry timers. */
  stop(): void {
    this.stopped = true
    if (this.startupRetryTimer) { clearTimeout(this.startupRetryTimer); this.startupRetryTimer = null }
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
  }

  /** Synchronously seed channel->swarm state from Discord.js's GUILD_CREATE cache inside `clientReady`
   *  before any inbound message is processed (impl-plan-v2 / T3 consensus). Returns true if seeded. */
  seedFromGuildCache(guild: GuildLike | null): boolean {
    if (!guild || guild.channels.cache.size === 0) return false
    this.guild = guild
    this.recordLastSeenFromCache(guild)
    this.initialFetchDone = true
    return true
  }

  /** Called once after `clientReady` (regardless of BUS_CHANNEL). Retries initial fetch with backoff on failure (M3). */
  async startClientReady(getGuild: () => Promise<GuildLike | null>): Promise<boolean> {
    if (this.stopped) return false
    try {
      const guild = await getGuild()
      if (!guild) return false
      await this.onClientReady(guild)
      this.startupRetryAttempt = 0
      if (this.startupRetryTimer) { clearTimeout(this.startupRetryTimer); this.startupRetryTimer = null }
      return true
    } catch (err: unknown) {
      process.stderr.write(`discord channel: initial guild fetch failed, scheduling retry: ${err instanceof Error ? err.message : String(err)}\n`)
      this.scheduleStartupRetry(getGuild)
      return false
    }
  }

  private scheduleStartupRetry(getGuild: () => Promise<GuildLike | null>): void {
    if (this.stopped || this.startupRetryTimer) return
    this.startupRetryAttempt++
    const base = this.deps.retryBaseMs ?? 2_000
    const delay = Math.min(base * 2 ** (this.startupRetryAttempt - 1), 60_000)
    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = null
      if (!this.stopped) void this.startClientReady(getGuild)
    }, delay)
    this.startupRetryTimer.unref()
  }

  /** Called once after `clientReady`. Performs an unthrottled `guild.channels.fetch()`, then provisions and sweeps. */
  async onClientReady(guild: GuildLike): Promise<void> {
    this.guild = guild
    await guild.channels.fetch()
    this.lastChannelFetch = Date.now()
    this.recordLastSeenFromCache(guild)
    this.initialFetchDone = true
    if (!this.deps.config.isConfigured()) return
    await this.provisionAll(guild)
    this.sweep()
  }

  /** Called on config reload when `client.isReady()` is true (§10.4). */
  async onConfigReload(getGuild: () => Promise<GuildLike>, diff: SwarmConfigDiff): Promise<void> {
    if (!this.guild) {
      try {
        this.guild = await getGuild()
      } catch {
        return
      }
    }
    const guild = this.guild
    if (!this.initialFetchDone && this.deps.config.isConfigured()) {
      await guild.channels.fetch()
      this.lastChannelFetch = Date.now()
      this.recordLastSeenFromCache(guild)
      this.initialFetchDone = true
    }
    for (const removed of [...diff.removedSwarms, ...diff.addedRetired]) {
      this.readySwarms.delete(removed)
      const t = this.retryTimers.get(removed)
      if (t) { clearTimeout(t); this.retryTimers.delete(removed) }
    }
    if (this.deps.config.isConfigured()) {
      const toProvision = diff.addedSwarms.length > 0 ? diff.addedSwarms : this.deps.config.swarmIds().filter(id => !this.readySwarms.has(id))
      await Promise.all(toProvision.map(id => this.provisionSwarm(id, guild)))
      this.sweep()
    }
  }

  /** Provision all configured swarms concurrently (single-flight per swarm). */
  async provisionAll(guild = this.guild): Promise<void> {
    if (!guild || !this.deps.config.isConfigured()) return
    const ids = this.deps.config.swarmIds()
    await Promise.all(ids.map(id => this.provisionSwarm(id, guild)))
  }

  /** Single-flight provisioning for one swarm id (§3, §10.4). Returns true if swarm is ready. */
  provisionSwarm(swarmId: string, guild = this.guild): Promise<boolean> {
    if (!guild || !this.deps.config.hasSwarm(swarmId)) return Promise.resolve(false)
    const existing = this.inFlight.get(swarmId)
    if (existing) return existing
    const p = this.doProvisionSwarm(swarmId, guild).finally(() => {
      if (this.inFlight.get(swarmId) === p) this.inFlight.delete(swarmId)
    })
    this.inFlight.set(swarmId, p)
    return p
  }

  private async doProvisionSwarm(swarmId: string, guild: GuildLike): Promise<boolean> {
    try {
      const all = [...guild.channels.cache.values()]
      const matchingCats = all
        .filter(c => c.type === ChannelType.GuildCategory && matchesCategoryBase(c.name, swarmId))
        .sort((a, b) => compareChannelIds(a.id, b.id))

      // Clear any previous refusal on re-provision so a hand-fixed category recovers without restart (M5, m2).
      for (const cat of matchingCats) this.refusedCategories.delete(cat.id)

      // Determine whether this swarm category was already fully provisioned (requires BOTH general AND human).
      // Partial crashes (only general created) still run first-adoption guards on restart (impl-plan-v2 #30-3).
      const matchingCatIds = new Set(matchingCats.map(c => c.id))
      const hasGeneral = all.some(c =>
        c.type === ChannelType.GuildText && c.parentId && matchingCatIds.has(c.parentId) && c.name.toLowerCase() === 'general',
      )
      const hasHuman = all.some(c =>
        c.type === ChannelType.GuildText && c.parentId && matchingCatIds.has(c.parentId) && c.name.toLowerCase() === 'human',
      )
      const alreadyProvisioned = hasGeneral && hasHuman

      // Adoption guard (§3, §10.4, M5)
      let refused = false
      for (const cat of matchingCats) {
        const blocker = this.adoptionBlocker(guild, cat.id, swarmId, !alreadyProvisioned)
        if (blocker) {
          this.refusedCategories.add(cat.id)
          process.stderr.write(`discord channel: refusing adoption of category "${cat.name}" (${cat.id}) for swarm "${swarmId}": ${blocker}\n`)
          refused = true
        }
      }
      if (refused) {
        this.readySwarms.delete(swarmId)
        return false
      }

      const activeCatIds = new Set(matchingCats.map(c => c.id))
      // Ensure at least one active category exists for this swarm
      if (activeCatIds.size === 0) {
        const createdCatId = await this.pickOrCreateCategory(guild, swarmId)
        activeCatIds.add(createdCatId)
      }

      const findCore = (name: 'general' | 'human'): GuildChannelLike | undefined => {
        const catsNow = new Set(
          [...guild.channels.cache.values()]
            .filter(c => c.type === ChannelType.GuildCategory && matchesCategoryBase(c.name, swarmId) && !this.refusedCategories.has(c.id))
            .map(c => c.id),
        )
        const matches = [...guild.channels.cache.values()]
          .filter(c => c.type === ChannelType.GuildText && c.parentId && catsNow.has(c.parentId) && c.name.toLowerCase() === name)
          .sort((a, b) => compareChannelIds(a.id, b.id))
        return matches[0]
      }

      let general = findCore('general')
      if (!general) {
        general = await this.withCategorySlot(guild, swarmId, undefined, async (parent) => {
          const created = await guild.channels.create({
            name: 'general',
            type: ChannelType.GuildText,
            parent,
            reason: `agent-bus swarm "${swarmId}" provision`,
          })
          guild.channels.cache.set?.(created.id, created)
          return created
        })
      }

      let human = findCore('human')
      if (!human) {
        human = await this.withCategorySlot(guild, swarmId, undefined, async (parent) => {
          const created = await guild.channels.create({
            name: 'human',
            type: ChannelType.GuildText,
            parent,
            reason: `agent-bus swarm "${swarmId}" provision`,
          })
          guild.channels.cache.set?.(created.id, created)
          return created
        })
      }

      this.lastSeenSwarm.set(general.id, swarmId)
      this.lastSeenSwarm.set(human.id, swarmId)
      this.readySwarms.set(swarmId, { generalId: general.id, humanId: human.id })
      this.retryAttempts.delete(swarmId)
      const timer = this.retryTimers.get(swarmId)
      if (timer) { clearTimeout(timer); this.retryTimers.delete(swarmId) }
      if (alreadyProvisioned) this.sweep()
      this.deps.onSwarmReady?.(swarmId, general.id)
      return true
    } catch (err: unknown) {
      process.stderr.write(`discord channel: swarm "${swarmId}" provisioning failed: ${err instanceof Error ? err.message : String(err)}\n`)
      this.scheduleRetry(swarmId, guild)
      return false
    }
  }

  private scheduleRetry(swarmId: string, guild: GuildLike): void {
    if (this.stopped || !this.deps.config.hasSwarm(swarmId) || this.retryTimers.has(swarmId)) return
    const attempt = (this.retryAttempts.get(swarmId) ?? 0) + 1
    this.retryAttempts.set(swarmId, attempt)
    const base = this.deps.retryBaseMs ?? 2_000
    const delay = Math.min(base * 2 ** (attempt - 1), 60_000)
    const timer = setTimeout(() => {
      this.retryTimers.delete(swarmId)
      if (!this.stopped && this.deps.config.hasSwarm(swarmId)) {
        void this.provisionSwarm(swarmId, guild)
      }
    }, delay)
    timer.unref()
    this.retryTimers.set(swarmId, timer)
  }

  /** Check whether adopting `categoryId` for `swarmId` violates any §3 / §10.4 guard. Returns reason or null.
   *  `firstAdoption` controls whether #26 direct-channel and non-member subscriber guards run (M5). */
  private adoptionBlocker(guild: GuildLike, categoryId: string, swarmId: string, firstAdoption = true): string | null {
    const children = [...guild.channels.cache.values()].filter(c => c.parentId === categoryId)
    for (const child of children) {
      if (this.deps.busChannelId && child.id === this.deps.busChannelId) {
        return `contains BUS_CHANNEL (${child.id})`
      }
      if (this.deps.humanChannelId && child.id === this.deps.humanChannelId) {
        return `contains HUMAN_CHANNEL (${child.id})`
      }
      if (this.deps.channelOwners?.has(child.id)) {
        return `contains DISCORD_CHANNEL_OWNERS channel (${child.id})`
      }
      if (!firstAdoption) continue
      const directOwner = this.deps.agentChannels?.owner(child.id)
      if (directOwner) {
        const ownerSwarm = this.deps.knownSwarm(directOwner)
        if (ownerSwarm !== swarmId) {
          return `contains direct channel for ${directOwner} (swarm ${ownerSwarm ?? 'default'})`
        }
      }
      if (this.deps.subs) {
        for (const sub of this.deps.subs.subscribers(child.id)) {
          if (this.deps.config.isCrossSwarm(sub)) continue
          const subSwarm = this.deps.knownSwarm(sub)
          if (subSwarm !== swarmId) {
            return `channel ${child.id} has non-member subscriber ${sub}`
          }
        }
        for (const identity of this.deps.subs.nativeSubscribers(child.id)) {
          const alias = this.deps.nativeAlias?.(identity)
          if (alias && this.deps.config.isCrossSwarm(alias)) continue
          return `channel ${child.id} has native default subscriber`
        }
      }
    }
    return null
  }

  private async pickOrCreateCategoryUnlocked(guild: GuildLike, baseName: string, currentParentId?: string | null): Promise<string> {
    const all = [...guild.channels.cache.values()]
    const matching = all
      .filter(c => c.type === ChannelType.GuildCategory && matchesCategoryBase(c.name, baseName) && !this.refusedCategories.has(c.id))
      .sort((a, b) => compareChannelIds(a.id, b.id))

    if (currentParentId && matching.some(c => c.id === currentParentId)) {
      return currentParentId
    }

    const available = matching.find(cat =>
      all.filter(child => child.parentId === cat.id).length < this.maxPerCategory,
    )
    if (available) return available.id

    const existingNames = new Set(
      all.filter(c => c.type === ChannelType.GuildCategory).map(c => c.name.trim().toLowerCase()),
    )
    let suffix = 1
    let name = baseName
    while (existingNames.has(name.trim().toLowerCase())) {
      name = `${baseName} ${++suffix}`
    }
    const created = await guild.channels.create({
      type: ChannelType.GuildCategory,
      name,
      reason: `agent-bus category "${baseName}"`,
    })
    guild.channels.cache.set?.(created.id, created)
    return created.id
  }

  /** Shared locked overflow picker: picks an existing `<base>` or `<base> N` category with < 50 children,
   *  or creates the next overflow category. */
  pickOrCreateCategory(guild: GuildLike, baseName: string, currentParentId?: string | null): Promise<string> {
    return this.withOverflowLock(() => this.pickOrCreateCategoryUnlocked(guild, baseName, currentParentId))
  }

  /** Holds the shared overflow lock across both category picking and channel creation/edit so concurrent
   *  callers observe updated child counts and overflow accurately at 50 channels. */
  withCategorySlot<T>(
    guild: GuildLike,
    baseName: string,
    currentParentId: string | null | undefined,
    action: (parentId: string) => Promise<T>,
  ): Promise<T> {
    return this.withOverflowLock(async () => {
      const parentId = await this.pickOrCreateCategoryUnlocked(guild, baseName, currentParentId)
      return action(parentId)
    })
  }

  private recordLastSeenFromCache(guild: GuildLike): void {
    if (!this.deps.config.isConfigured()) return
    for (const ch of guild.channels.cache.values()) {
      if (ch.type === ChannelType.GuildCategory) continue
      if (ch.id === this.deps.busChannelId || ch.id === this.deps.humanChannelId) continue
      if (!ch.parentId) continue
      const parent = guild.channels.cache.get(ch.parentId)
      if (!parent || parent.type !== ChannelType.GuildCategory) continue
      const parsed = parseSwarmCategoryName(parent.name)
      if (!parsed) continue
      if (this.deps.config.isRetired(parsed.id)) {
        this.lastSeenSwarm.set(ch.id, parsed.id)
      } else if (this.deps.config.hasSwarm(parsed.id) && !this.refusedCategories.has(parent.id) && !this.adoptionBlocker(guild, parent.id, parsed.id, false)) {
        this.lastSeenSwarm.set(ch.id, parsed.id)
      }
    }
  }

  /** Classify a channel object against current cache/config. */
  private classifyChannelObj(ch: GuildChannelLike, guild: GuildLike | null): ChannelSwarmResult {
    if (ch.id === this.deps.busChannelId || ch.id === this.deps.humanChannelId) {
      return { kind: 'swarm', swarm: DEFAULT_SWARM, archived: false }
    }
    if (isDmChannel(ch)) return { kind: 'dm' }
    if (guild && ch.guildId && ch.guildId !== guild.id) return { kind: 'unknown' }
    if (isThreadChannel(ch)) {
      if (!ch.parentId) return { kind: 'unknown' }
      const parent = guild?.channels.cache.get(ch.parentId) ?? this.deps.client.channels.cache?.get(ch.parentId)
      if (!parent) return { kind: 'unknown' }
      return this.classifyChannelObj(parent, guild)
    }

    if (!ch.parentId) {
      const prev = this.lastSeenSwarm.get(ch.id)
      if (prev) return { kind: 'retired', swarm: prev, archived: false }
      return { kind: 'swarm', swarm: DEFAULT_SWARM, archived: false }
    }

    const parent = guild?.channels.cache.get(ch.parentId) ?? this.deps.client.channels.cache?.get(ch.parentId)
    if (!parent) return { kind: 'unknown' }
    if (parent.type !== ChannelType.GuildCategory) {
      return { kind: 'swarm', swarm: DEFAULT_SWARM, archived: false }
    }

    const parsed = parseSwarmCategoryName(parent.name)
    if (parsed) {
      if (this.deps.config.isRetired(parsed.id)) {
        this.lastSeenSwarm.set(ch.id, parsed.id)
        return { kind: 'retired', swarm: parsed.id, archived: parsed.archived }
      }
      if (this.deps.config.hasSwarm(parsed.id)) {
        // Refused categories stay default; before first provisioning, also guard core blockers (BUS/HUMAN/owners).
        if (this.refusedCategories.has(parent.id) ||
            (!this.readySwarms.has(parsed.id) && guild && this.adoptionBlocker(guild, parent.id, parsed.id, false) !== null)) {
          return { kind: 'swarm', swarm: DEFAULT_SWARM, archived: false }
        }
        this.lastSeenSwarm.set(ch.id, parsed.id)
        return { kind: 'swarm', swarm: parsed.id, archived: parsed.archived }
      }
    }

    // Moved to a non-swarm category -> belongs to default; clear any prior swarm last-seen.
    this.lastSeenSwarm.delete(ch.id)
    const isDefaultArchive = matchesCategoryBase(parent.name, 'archive') || matchesCategoryBase(parent.name, ARCHIVED_AGENT_CATEGORY)
    return { kind: 'swarm', swarm: DEFAULT_SWARM, archived: isDefaultArchive }
  }

  /** Synchronous channel classification (§3, §10.4). */
  classifyChannel(channelId: string): ChannelSwarmResult {
    if (channelId === this.deps.busChannelId || channelId === this.deps.humanChannelId) {
      return { kind: 'swarm', swarm: DEFAULT_SWARM, archived: false }
    }
    if (!this.deps.config.isConfigured()) {
      return { kind: 'swarm', swarm: DEFAULT_SWARM, archived: false }
    }
    if (!this.initialFetchDone) {
      return { kind: 'unknown' }
    }
    const ch = this.guild?.channels.cache.get(channelId) ?? this.deps.client.channels.cache?.get(channelId)
    if (!ch) return { kind: 'unknown' }
    return this.classifyChannelObj(ch, this.guild)
  }

  /** String convenience view of `classifyChannel`: `'default' | '<swarm>' | 'retired' | 'dm' | 'unknown'`. */
  channelSwarm(channelId: string): string {
    const cls = this.classifyChannel(channelId)
    return cls.kind === 'swarm' ? cls.swarm : cls.kind
  }

  /** Async classification with cache-miss `client.channels.fetch(id)` (handles DMs, archived threads, guild check; §10.4). */
  async resolveChannelSwarm(channelId: string): Promise<ChannelSwarmResult> {
    const cached = this.classifyChannel(channelId)
    if (cached.kind !== 'unknown') return cached
    if (!this.deps.config.isConfigured()) return { kind: 'swarm', swarm: DEFAULT_SWARM, archived: false }
    if (!this.initialFetchDone) return { kind: 'unknown' }

    const fetched = await this.deps.client.channels.fetch(channelId).catch(() => null)
    if (!fetched) return { kind: 'unknown' }
    if (isDmChannel(fetched)) return { kind: 'dm' }
    if (this.guild && fetched.guildId && fetched.guildId !== this.guild.id) return { kind: 'unknown' }

    if (isThreadChannel(fetched)) {
      if (!fetched.parentId) return { kind: 'unknown' }
      return this.resolveChannelSwarm(fetched.parentId)
    }

    if (fetched.parentId && this.guild && !this.guild.channels.cache.get(fetched.parentId)) {
      const fetchedParent = await this.deps.client.channels.fetch(fetched.parentId).catch(() => null)
      if (fetchedParent) this.guild.channels.cache.set?.(fetchedParent.id, fetchedParent)
    }
    return this.classifyChannelObj(fetched, this.guild)
  }

  /** Whether `swarm` is provisioned and ready to accept posts/channel creation. */
  isSwarmReady(swarm: string): boolean {
    if (swarm === DEFAULT_SWARM) return true
    if (!this.deps.config.isConfigured() || !this.initialFetchDone) return false
    const entry = this.readySwarms.get(swarm)
    if (!entry) return false
    return this.generalChannelId(swarm) !== undefined && this.humanChannelId(swarm) !== undefined
  }

  /** Resolve `<swarm>:general` channel id (oldest id wins on duplicates; BUS_CHANNEL for `default`). */
  generalChannelId(swarm: string): string | undefined {
    if (swarm === DEFAULT_SWARM) return this.deps.busChannelId
    if (!this.initialFetchDone || !this.guild) return undefined
    const found = this.findSwarmCoreChannel(swarm, 'general')
    return found ?? undefined
  }

  /** Resolve `<swarm>:human` channel id (oldest id wins on duplicates; HUMAN_CHANNEL for `default`). */
  humanChannelId(swarm: string): string | undefined {
    if (swarm === DEFAULT_SWARM) return this.deps.humanChannelId
    if (!this.initialFetchDone || !this.guild) return undefined
    const found = this.findSwarmCoreChannel(swarm, 'human')
    return found ?? undefined
  }

  private findSwarmCoreChannel(swarm: string, role: 'general' | 'human'): string | undefined {
    if (!this.guild || !this.deps.config.hasSwarm(swarm)) return undefined
    const all = [...this.guild.channels.cache.values()]
    const catIds = new Set(
      all
        .filter(c => c.type === ChannelType.GuildCategory && matchesCategoryBase(c.name, swarm) && !this.refusedCategories.has(c.id))
        .map(c => c.id),
    )
    const matches = all
      .filter(c => c.type === ChannelType.GuildText && c.parentId && catIds.has(c.parentId) && c.name.toLowerCase() === role)
      .sort((a, b) => compareChannelIds(a.id, b.id))
    return matches[0]?.id
  }

  /** Identify whether `channelId` is `<swarm>:general` or `<swarm>:human`. */
  isSwarmCoreChannel(channelId: string): { swarm: string; role: 'general' | 'human' } | null {
    if (channelId === this.deps.busChannelId) return { swarm: DEFAULT_SWARM, role: 'general' }
    if (channelId === this.deps.humanChannelId) return { swarm: DEFAULT_SWARM, role: 'human' }
    if (!this.deps.config.isConfigured() || !this.initialFetchDone) return null
    const cls = this.classifyChannel(channelId)
    if (cls.kind !== 'swarm' || cls.archived || cls.swarm === DEFAULT_SWARM) return null
    if (this.generalChannelId(cls.swarm) === channelId) return { swarm: cls.swarm, role: 'general' }
    if (this.humanChannelId(cls.swarm) === channelId) return { swarm: cls.swarm, role: 'human' }
    return null
  }

  /** Sweep on `clientReady`, `channelUpdate`, and reload (§3, §10.4).
   *  Drops non-member subscriptions (keeping crossSwarm) and moved `channelOwners` entries.
   *  Never touches `unknown`, refused categories, or a swarm's general/human/direct channels. */
  sweep(): { droppedSubs: number; droppedOwners: number } {
    if (!this.deps.config.isConfigured() || !this.initialFetchDone || !this.guild) {
      return { droppedSubs: 0, droppedOwners: 0 }
    }
    this.recordLastSeenFromCache(this.guild)
    let droppedSubs = 0
    let droppedOwners = 0

    // Drop DISCORD_CHANNEL_OWNERS entries for channels moved into a non-default or retired swarm
    if (this.deps.channelOwners) {
      for (const chId of [...this.deps.channelOwners.keys()]) {
        if (chId === this.deps.busChannelId || chId === this.deps.humanChannelId) continue
        const ch = this.guild.channels.cache.get(chId)
        if (ch?.parentId && this.refusedCategories.has(ch.parentId)) continue
        const cls = this.classifyChannel(chId)
        if (cls.kind === 'unknown') continue
        if (cls.kind === 'retired' || (cls.kind === 'swarm' && cls.swarm !== DEFAULT_SWARM)) {
          this.deps.channelOwners.delete(chId)
          droppedOwners++
        }
      }
    }

    // Drop subscriptions of non-members on swarm channels, keeping crossSwarm sessions
    if (this.deps.subs) {
      for (const chId of this.deps.subs.channels()) {
        const ch = this.guild.channels.cache.get(chId)
        if (ch?.parentId && this.refusedCategories.has(ch.parentId)) continue
        if (this.isSwarmCoreChannel(chId)) continue
        if (this.deps.agentChannels?.owner(chId)) continue
        const cls = this.classifyChannel(chId)
        if (cls.kind === 'unknown') continue // Never drop on unknown (§10.4)
        const targetSwarm = cls.kind === 'swarm' ? cls.swarm : null

        for (const sub of this.deps.subs.subscribers(chId)) {
          if (this.deps.config.isCrossSwarm(sub)) continue
          const subSwarm = this.deps.knownSwarm(sub)
          if (targetSwarm === null || subSwarm !== targetSwarm) {
            if (this.deps.subs.remove(sub, chId)) droppedSubs++
          }
        }
        for (const identity of this.deps.subs.nativeSubscribers(chId)) {
          const alias = this.deps.nativeAlias?.(identity)
          if (alias && this.deps.config.isCrossSwarm(alias)) continue
          if (targetSwarm !== DEFAULT_SWARM) {
            if (this.deps.subs.remove('', chId, identity)) droppedSubs++
          }
        }
      }
    }

    return { droppedSubs, droppedOwners }
  }

  /** Register-time subscription prune (§4, §10.4). Runs only after initial fetch, skips crossSwarm and `unknown`. */
  pruneSessionSubscriptions(name: string, swarm: string): number {
    if (!this.deps.config.isConfigured() || !this.initialFetchDone || !this.deps.subs) return 0
    if (this.deps.config.isCrossSwarm(name)) return 0
    let dropped = 0
    for (const chId of this.deps.subs.of(name)) {
      const cls = this.classifyChannel(chId)
      if (cls.kind === 'unknown') continue // Never drop on unknown (§10.4)
      if (cls.kind === 'retired' || (cls.kind === 'swarm' && cls.swarm !== swarm)) {
        if (this.deps.subs.remove(name, chId)) dropped++
      }
    }
    return dropped
  }

  /** Inbound classification for `handleInbound` (§4, §10.6, M3, M4, impl-plan-v2):
   *  - `'bus'`  -> handleBusInbound
   *  - `'gate'` -> DM / legacy default channel gate() / fail-closed when guild cache is missing
   *  - `'drop'` -> drop before gate() (non-default archived, retired, or unknown after verification) */
  async classifyInbound(
    channelId: string,
    isDefaultBusChannel: (id: string) => boolean,
    isDmHint?: boolean,
  ): Promise<'bus' | 'gate' | 'drop'> {
    if (!this.deps.config.isConfigured()) {
      return isDefaultBusChannel(channelId) ? 'bus' : 'gate'
    }
    if (isDmHint) return 'gate'
    // Before verification (guild cache missing/empty): never route #26 direct channels owned by
    // non-default or retired seats through isDefaultBusChannel; fail closed to 'gate' (impl-plan-v2 #30-2).
    if (!this.initialFetchDone) {
      const cached = this.deps.client.channels.cache?.get(channelId)
      if (cached && isDmChannel(cached)) return 'gate'
      const directOwner = this.deps.agentChannels?.owner(channelId)
      if (directOwner) {
        const ownerSwarm = this.deps.knownSwarm(directOwner)
        if (ownerSwarm && (ownerSwarm !== DEFAULT_SWARM || this.deps.config.isRetired(ownerSwarm))) {
          return 'gate'
        }
      }
      if (isDefaultBusChannel(channelId)) return 'bus'
      return 'gate'
    }
    const cls = await this.resolveChannelSwarm(channelId)
    if (cls.kind === 'dm') return 'gate'
    if (cls.kind === 'retired' || cls.kind === 'unknown') return 'drop'
    if (cls.swarm !== DEFAULT_SWARM) {
      // Archived drop applies only to non-default swarm categories (M4: archived #26 default channels stay inbound).
      if (cls.archived) return 'drop'
      // Active non-default swarms route to 'bus' even when BUS_CHANNEL is unset (impl-plan-v2 #30-1).
      return 'bus'
    }
    return isDefaultBusChannel(channelId) ? 'bus' : 'gate'
  }

  /** Build swarm-aware `ChannelOps` backed by this `SwarmChannels` instance (§3, §10.4, §10.6). */
  createChannelOps(getGuild: () => Promise<GuildLike>): ChannelOps {
    const guildChannels = async (guild: GuildLike, forceRefresh = false): Promise<GuildChannelLike[]> => {
      const fresh = guild.channels.cache.size === 0 || (forceRefresh && Date.now() - this.lastChannelFetch > 30_000)
      if (fresh) {
        this.lastChannelFetch = Date.now()
        await guild.channels.fetch()
      }
      return [...guild.channels.cache.values()]
    }

    return {
      resolve: async (ref: string, swarm = DEFAULT_SWARM) => {
        const guild = await getGuild()
        const want = ref.replace(/^<#(\d+)>$/, '$1').replace(/^#/, '').trim()
        const wantLower = want.toLowerCase()
        const match = (all: GuildChannelLike[]): GuildChannelLike | undefined => {
          // Exact channel ID match (assertChannelInSwarm handles cross-swarm rejection with exact error).
          const byId = all.find(c => c.type === ChannelType.GuildText && c.id === want)
          if (byId) return byId

          // Name match: when unconfigured keep exact legacy `.find()` order (m3); when configured,
          // match within caller's swarm excluding archived categories, oldest id wins (§3, §10.4, §10.6).
          if (!this.deps.config.isConfigured()) {
            return all.find(c => c.type === ChannelType.GuildText && c.name === wantLower)
          }
          const byName = all
            .filter(c => {
              if (c.type !== ChannelType.GuildText || c.name.toLowerCase() !== wantLower) return false
              const cls = this.classifyChannel(c.id)
              return cls.kind === 'swarm' && cls.swarm === swarm && !cls.archived
            })
            .sort((a, b) => compareChannelIds(a.id, b.id))
          return byName[0]
        }
        const hit = match(await guildChannels(guild)) ?? match(await guildChannels(guild, true))
        return hit ? { id: hit.id, name: hit.name } : null
      },

      list: async (swarm = DEFAULT_SWARM) => {
        const guild = await getGuild()
        const all = await guildChannels(guild)
        return all
          .filter(c => {
            if (c.type !== ChannelType.GuildText) return false
            if (!this.deps.config.isConfigured()) return true
            const cls = this.classifyChannel(c.id)
            return cls.kind === 'swarm' && cls.swarm === swarm && !cls.archived
          })
          .map(c => ({ id: c.id, name: c.name, topic: c.topic ?? null }))
      },

      create: async (name: string, topic?: string, swarm = DEFAULT_SWARM) => {
        const clean = name.replace(/^#/, '').trim()
        if (swarm !== DEFAULT_SWARM && (clean.toLowerCase() === 'general' || clean.toLowerCase() === 'human')) {
          throw new Error('reserved_swarm_channel')
        }
        const guild = await getGuild()
        if (swarm !== DEFAULT_SWARM) {
          if (!this.isSwarmReady(swarm)) throw new Error('swarm_not_ready')
          const ch = await this.withCategorySlot(guild, swarm, undefined, async (parent) => {
            const created = await guild.channels.create({
              name: clean,
              type: ChannelType.GuildText,
              ...(topic && { topic }),
              parent,
              reason: 'agent-bus channel_create',
            })
            guild.channels.cache.set?.(created.id, created)
            this.lastSeenSwarm.set(created.id, swarm)
            return created
          })
          return { id: ch.id, name: ch.name }
        }
        let parent: string | undefined
        if (this.deps.busChannelId) {
          const bus = await this.deps.client.channels.fetch(this.deps.busChannelId)
          parent = bus && 'parentId' in bus ? bus.parentId ?? undefined : undefined
        }
        const ch = await guild.channels.create({
          name: clean,
          type: ChannelType.GuildText,
          ...(topic && { topic }),
          ...(parent && { parent }),
          reason: 'agent-bus channel_create',
        })
        guild.channels.cache.set?.(ch.id, ch)
        return { id: ch.id, name: ch.name }
      },

      archive: async (id: string, topic: string, swarm?: string) => {
        const guild = await getGuild()
        if (!this.deps.config.isConfigured()) {
          // No-config back-compat: single "archive" category (no overflow suffix, m3).
          const all = await guildChannels(guild)
          const catInfo = all.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'archive')
          const cat = catInfo ?? await guild.channels.create({ name: 'archive', type: ChannelType.GuildCategory, reason: 'agent-bus channel_archive' })
          guild.channels.cache.set?.(cat.id, cat)
          const ch = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id) as GuildChannelLike | null)
          if (ch && ch.type === ChannelType.GuildText && ch.edit) {
            const updated = await ch.edit({ parent: cat.id, topic: topic.slice(0, 1000), reason: 'agent-bus channel_archive' })
            guild.channels.cache.set?.(id, updated)
          }
          return
        }
        const cls = this.classifyChannel(id)
        const effectiveSwarm = swarm ?? (cls.kind === 'swarm' ? cls.swarm : DEFAULT_SWARM)
        const archiveBase = effectiveSwarm !== DEFAULT_SWARM ? `${effectiveSwarm} (archived)` : 'archive'
        const ch = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id) as GuildChannelLike | null)
        if (ch && ch.type === ChannelType.GuildText && ch.edit) {
          await this.withCategorySlot(guild, archiveBase, ch.parentId, async (catId) => {
            const updated = await ch.edit!({ parent: catId, topic: topic.slice(0, 1000), reason: 'agent-bus channel_archive' })
            guild.channels.cache.set?.(id, updated)
          })
        }
      },
    }
  }

  /** Build swarm-aware #26 `AgentChannelOps` backed by the shared overflow picker (§3, §10.4). */
  createAgentChannelOps(getGuild: () => Promise<GuildLike>): AgentChannelOps {
    const categoryBases = (swarm: string) => swarm === DEFAULT_SWARM
      ? { active: ACTIVE_AGENT_CATEGORY, archived: ARCHIVED_AGENT_CATEGORY }
      : { active: swarm, archived: `${swarm} (archived)` }

    return {
      ensure: async (info) => {
        const swarm = info.swarm ?? DEFAULT_SWARM
        if (swarm !== DEFAULT_SWARM && !this.isSwarmReady(swarm)) {
          throw new Error('swarm_not_ready')
        }
        const guild = await getGuild()
        // Fetch when cache is empty so direct-channel adopt works after restart (m3).
        if (guild.channels.cache.size === 0) {
          this.lastChannelFetch = Date.now()
          await guild.channels.fetch()
        }
        const channels = [...guild.channels.cache.values()]
        const bases = categoryBases(swarm)
        const categoryIds = new Set(
          channels
            .filter(c => c.type === ChannelType.GuildCategory &&
              (matchesCategoryBase(c.name, bases.active) || matchesCategoryBase(c.name, bases.archived)) &&
              !this.refusedCategories.has(c.id))
            .map(c => c.id),
        )
        const existing = channels
          .filter(c => c.type === ChannelType.GuildText && c.parentId && categoryIds.has(c.parentId) &&
            c.name.startsWith('a-') && c.topic?.startsWith(`Direct line to ${info.name} (`))
          .sort((a, b) => compareChannelIds(a.id, b.id))[0]
        if (existing) {
          await this.createAgentChannelOps(getGuild).update(existing.id, info, false)
          return existing.id
        }
        const created = await this.withCategorySlot(guild, bases.active, undefined, async (parent) => {
          const allNow = [...guild.channels.cache.values()]
          const slug = agentChannelSlug(info.name)
          const name = allNow.some(c => c.name === slug) ? agentChannelSlug(info.name, true) : slug
          const ch = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent,
            topic: agentChannelTopic(info),
            reason: 'agent-bus direct channel provision',
          })
          guild.channels.cache.set?.(ch.id, ch)
          if (swarm !== DEFAULT_SWARM) this.lastSeenSwarm.set(ch.id, swarm)
          return ch
        })
        return created.id
      },

      update: async (id, info, archived) => {
        const swarm = info.swarm ?? DEFAULT_SWARM
        if (swarm !== DEFAULT_SWARM && !this.isSwarmReady(swarm)) {
          throw new Error('swarm_not_ready')
        }
        const guild = await getGuild()
        const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id) as GuildChannelLike | null)
        if (!channel || channel.type !== ChannelType.GuildText || !channel.edit) {
          throw new Error('direct channel is unavailable')
        }
        const bases = categoryBases(swarm)
        const targetBase = archived ? bases.archived : bases.active
        await this.withCategorySlot(guild, targetBase, channel.parentId, async (parent) => {
          const allNow = [...guild.channels.cache.values()]
          const slug = agentChannelSlug(info.name)
          const name = allNow.some(c => c.id !== id && c.name === slug) ? agentChannelSlug(info.name, true) : slug
          const updated = await channel.edit!({
            name,
            parent,
            topic: agentChannelTopic(info),
            reason: archived ? 'agent-bus idle direct channel archive' : 'agent-bus direct channel registration',
          })
          guild.channels.cache.set?.(id, updated)
          if (swarm !== DEFAULT_SWARM) this.lastSeenSwarm.set(id, swarm)
          else this.lastSeenSwarm.delete(id)
        })
      },
    }
  }
}
