import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelType } from 'discord.js'
import { AgentChannels, AGENT_CHANNEL_DELAY_MS, AGENT_CHANNEL_IDLE_MS } from '../agent-channels.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { Subscriptions } from '../subscriptions.js'
import { SwarmChannels, type ChannelClientLike, type GuildChannelLike, type GuildLike } from '../swarm-channels.js'
import { SwarmConfig } from '../swarm-config.js'
import { SwarmJournal } from '../swarm-journal.js'
import { createWsHandlers, knownSwarm, sendRulesForSwarm, type WsDeps, type WsLike } from '../ws.js'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarm-pr1b-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

interface MutableChannel {
  id: string
  name: string
  type: ChannelType
  parentId: string | null
  topic: string | null
  guildId: string | null
  dm?: boolean
  thread?: boolean
  isThread(): boolean
  isDMBased(): boolean
  edit(opts: { name?: string; parent?: string | null; topic?: string; reason?: string }): Promise<GuildChannelLike>
}

class FakeGuild {
  readonly id: string
  readonly backing = new Map<string, MutableChannel>()
  readonly cache = new Map<string, GuildChannelLike>()
  readonly extraClientChannels = new Map<string, MutableChannel>()
  fetchCount = 0
  createCount = 0
  nextId = 100
  createDelayMs = 0
  failNextCreates = 0

  constructor(id = 'guild-1') {
    this.id = id
  }

  addChannel(opts: {
    id?: string
    name: string
    type?: ChannelType
    parentId?: string | null
    topic?: string | null
    guildId?: string | null
    inCache?: boolean
    dm?: boolean
    thread?: boolean
    clientOnly?: boolean
  }): MutableChannel {
    const id = opts.id ?? String(++this.nextId)
    const ch: MutableChannel = {
      id,
      name: opts.name,
      type: opts.type ?? ChannelType.GuildText,
      parentId: opts.parentId ?? null,
      topic: opts.topic ?? null,
      guildId: opts.guildId === undefined ? (opts.dm ? null : this.id) : opts.guildId,
      dm: opts.dm,
      thread: opts.thread,
      isThread: () => Boolean(opts.thread || ch.type === ChannelType.PublicThread || ch.type === ChannelType.PrivateThread),
      isDMBased: () => Boolean(opts.dm || ch.type === ChannelType.DM),
      edit: async (patch) => {
        if (patch.name !== undefined) ch.name = patch.name
        if (patch.parent !== undefined) ch.parentId = patch.parent
        if (patch.topic !== undefined) ch.topic = patch.topic
        this.backing.set(ch.id, ch)
        this.cache.set(ch.id, ch)
        return ch
      },
    }
    if (opts.clientOnly) {
      this.extraClientChannels.set(id, ch)
    } else {
      this.backing.set(id, ch)
      if (opts.inCache !== false) this.cache.set(id, ch)
    }
    return ch
  }

  asGuildLike(): GuildLike {
    return {
      id: this.id,
      channels: {
        cache: this.cache,
        fetch: async (id?: string) => {
          this.fetchCount++
          if (id) {
            const found = this.backing.get(id) ?? null
            if (found) this.cache.set(id, found)
            return found
          }
          this.cache.clear()
          for (const [k, v] of this.backing) this.cache.set(k, v)
          return this.cache
        },
        create: async (opts) => {
          if (this.createDelayMs > 0) await new Promise(r => setTimeout(r, this.createDelayMs))
          if (this.failNextCreates > 0) {
            this.failNextCreates--
            throw new Error('simulated discord error')
          }
          this.createCount++
          return this.addChannel({
            name: opts.name,
            type: opts.type,
            parentId: opts.parent ?? null,
            topic: opts.topic ?? null,
            inCache: true,
          })
        },
      },
    }
  }

  asClientLike(): ChannelClientLike {
    return {
      isReady: () => true,
      channels: {
        cache: this.cache,
        fetch: async (id: string) => {
          const hit = this.extraClientChannels.get(id) ?? this.backing.get(id) ?? null
          if (hit && !hit.isDMBased() && !hit.isThread() && hit.guildId === this.id) {
            this.cache.set(id, hit)
          }
          return hit
        },
      },
    }
  }
}

describe('PR1b SwarmChannels provisioning, overflow, and adoption refusal', () => {
  test('single-flight provisioning creates one category, one general, one human; overflow splits at 50', async () => {
    const guild = new FakeGuild()
    guild.createDelayMs = 10
    guild.addChannel({ id: 'bus', name: 'general' })
    guild.addChannel({ id: 'human', name: 'human-questions' })
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const sc = new SwarmChannels({
      config: cfg,
      client: guild.asClientLike(),
      busChannelId: 'bus',
      humanChannelId: 'human',
      knownSwarm: () => 'default',
      maxPerCategory: 4, // small cap to test overflow cleanly
    })

    // Before initial fetch: unknown (except BUS/HUMAN which are always default)
    expect(sc.channelSwarm('bus')).toBe('default')
    expect(sc.channelSwarm('human')).toBe('default')
    expect(sc.channelSwarm('999')).toBe('unknown')
    expect(sc.isSwarmReady('cfd')).toBe(false)

    // Initial ready + concurrent provisionSwarm calls
    const gLike = guild.asGuildLike()
    await Promise.all([
      sc.onClientReady(gLike),
      sc.provisionSwarm('cfd', gLike),
      sc.provisionSwarm('cfd', gLike),
    ])
    expect(sc.isSwarmReady('cfd')).toBe(true)
    const cats = [...guild.backing.values()].filter(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().startsWith('cfd'))
    expect(cats).toHaveLength(1)
    const genId = sc.generalChannelId('cfd')!
    const humId = sc.humanChannelId('cfd')!
    expect(genId).toBeDefined()
    expect(humId).toBeDefined()
    expect(sc.channelSwarm(genId)).toBe('cfd')
    expect(sc.channelSwarm(humId)).toBe('cfd')

    // Concurrent creates past maxPerCategory=4 overflow cleanly to "cfd 2" with no duplicate overflow categories
    const ops = sc.createChannelOps(async () => gLike)
    await Promise.all([
      ops.create('topic-1', undefined, 'cfd'),
      ops.create('topic-2', undefined, 'cfd'),
      ops.create('topic-3', undefined, 'cfd'),
      ops.create('topic-4', undefined, 'cfd'),
    ])
    const allCfdCats = [...guild.backing.values()].filter(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().startsWith('cfd'))
    expect(allCfdCats.map(c => c.name).sort()).toEqual(['cfd', 'cfd 2'])
    // Channel in overflow category "cfd 2" classifies as 'cfd'
    const cfd2 = allCfdCats.find(c => c.name === 'cfd 2')!
    const inOverflow = [...guild.backing.values()].find(c => c.parentId === cfd2.id)!
    expect(sc.channelSwarm(inOverflow.id)).toBe('cfd')
  })

  test('adoption is refused for category holding BUS_CHANNEL, HUMAN_CHANNEL, channelOwners, foreign #26 channel, or non-member subscriber', async () => {
    // 1. BUS_CHANNEL inside category "cfd"
    const g1 = new FakeGuild()
    const badCat = g1.addChannel({ id: 'cat-cfd', name: 'cfd', type: ChannelType.GuildCategory })
    g1.addChannel({ id: 'bus', name: 'general', parentId: badCat.id })
    const otherInBad = g1.addChannel({ id: 'other', name: 'other', parentId: badCat.id })
    const subs1 = new Subscriptions()
    subs1.add('def-agent', otherInBad.id)
    const sc1 = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} } }),
      client: g1.asClientLike(),
      busChannelId: 'bus',
      subs: subs1,
      knownSwarm: () => 'default',
    })
    await sc1.onClientReady(g1.asGuildLike())
    expect(sc1.isSwarmReady('cfd')).toBe(false)
    expect(sc1.channelSwarm('bus')).toBe('default')
    expect(sc1.channelSwarm(otherInBad.id)).toBe('default') // refused category treated as default
    expect(subs1.of('def-agent')).toEqual([otherInBad.id]) // refused category never swept!

    // 2. Category holding channel with a non-member subscriber (§10.4)
    const g2 = new FakeGuild()
    const cfdCat2 = g2.addChannel({ id: 'cat-cfd2', name: 'cfd', type: ChannelType.GuildCategory })
    const topic2 = g2.addChannel({ id: 'topic2', name: 'cfd-topic', parentId: cfdCat2.id })
    const subs2 = new Subscriptions()
    subs2.add('default-worker', topic2.id)
    const sc2 = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} }, crossSwarm: ['claude@mac:ops'] }),
      client: g2.asClientLike(),
      subs: subs2,
      knownSwarm: name => (name === 'cfd-worker' ? 'cfd' : 'default'),
    })
    await sc2.onClientReady(g2.asGuildLike())
    expect(sc2.isSwarmReady('cfd')).toBe(false)
    expect(sc2.channelSwarm(topic2.id)).toBe('default')
    expect(subs2.of('default-worker')).toEqual([topic2.id])

    // 3. Category holding channel with ONLY crossSwarm subscriber IS adopted cleanly
    const g3 = new FakeGuild()
    const cfdCat3 = g3.addChannel({ id: 'cat-cfd3', name: 'cfd', type: ChannelType.GuildCategory })
    const topic3 = g3.addChannel({ id: 'topic3', name: 'cfd-topic', parentId: cfdCat3.id })
    const subs3 = new Subscriptions()
    subs3.add('claude@mac:ops', topic3.id)
    const sc3 = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} }, crossSwarm: ['claude@mac:ops'] }),
      client: g3.asClientLike(),
      subs: subs3,
      knownSwarm: () => 'default',
    })
    await sc3.onClientReady(g3.asGuildLike())
    expect(sc3.isSwarmReady('cfd')).toBe(true)
    expect(sc3.channelSwarm(topic3.id)).toBe('cfd')
    expect(subs3.of('claude@mac:ops')).toEqual([topic3.id])
  })

  test('reload adding a swarm provisions it without restart and delivers deferred rules', async () => {
    const dir = tempDir()
    const cfgFile = join(dir, 'swarms-config.json')
    writeFileSync(cfgFile, JSON.stringify({ swarms: { cfd: {} } }))
    const cfg = SwarmConfig.inStateDir(dir)
    const guild = new FakeGuild()
    guild.addChannel({ id: 'bus', name: 'general' })

    const sessions = new SessionManager()
    const deliveredRules: Array<{ name: string; chatId?: string }> = []
    let rulesSeen = new Set<string>()
    let sc!: SwarmChannels
    const deps: WsDeps = {
      sessions,
      history: new ProjectHistory(dir),
      client: guild.asClientLike() as unknown as WsDeps['client'],
      chatId: () => null,
      chunkLimit: 2000,
      chunkMode: 'length',
      replyToMode: 'first',
      busChannelId: 'bus',
      swarmConfig: cfg,
      swarmJournal: new SwarmJournal(),
      swarmGeneralChannel: s => sc.generalChannelId(s),
      rules: () => ({
        text: 'be nice',
        seen: n => rulesSeen.has(n),
        markSeen: n => { rulesSeen.add(n) },
      }),
    }
    sc = new SwarmChannels({
      config: cfg,
      client: guild.asClientLike(),
      busChannelId: 'bus',
      knownSwarm: n => knownSwarm(deps, n),
      onSwarmReady: s => sendRulesForSwarm(deps, s),
    })

    const handlers = createWsHandlers(deps)
    await sc.onClientReady(guild.asGuildLike())

    // Add swarm "test1" via hot reload
    writeFileSync(cfgFile, JSON.stringify({ swarms: { cfd: {}, test1: {} } }))
    const t = new Date(Date.now() + 5000)
    utimesSync(cfgFile, t, t)
    const diff = cfg.reload()!
    expect(diff.addedSwarms).toEqual(['test1'])

    // Session registers in test1 BEFORE test1 is provisioned -> rules deferred!
    const frames: Record<string, unknown>[] = []
    const ws: WsLike = {
      data: { sessionName: null, sendCallback: null },
      send(raw) {
        const f = JSON.parse(raw) as Record<string, unknown>
        frames.push(f)
        if (f.type === 'message' && (f.meta as Record<string, string>)?.channel === 'rules') {
          deliveredRules.push({ name: 'claude@mac:test1/src', chatId: (f.meta as Record<string, string>).chat_id })
        }
      },
    }
    handlers.message(ws, JSON.stringify({ type: 'register', name: 'claude@mac:src', generated: true, swarm: 'test1', projectPath: '/src' }))
    expect(rulesSeen.has('claude@mac:test1/src')).toBe(false)

    // Reload triggers provisioning -> test1 becomes ready & deferred rules arrive with test1:general chat_id!
    await sc.onConfigReload(async () => guild.asGuildLike(), diff)
    expect(sc.isSwarmReady('test1')).toBe(true)
    expect(rulesSeen.has('claude@mac:test1/src')).toBe(true)
    expect(deliveredRules).toEqual([{ name: 'claude@mac:test1/src', chatId: sc.generalChannelId('test1') }])
  })
})

describe('PR1b channelSwarm, cache-miss fetch, threads, archived N, retired, and sweep', () => {
  test('unknown before fetch preserves cfd subscriptions on register; cache-miss fetch resolves archived thread, DM, and foreign guild', async () => {
    const guild = new FakeGuild('guild-1')
    const cfdCat = guild.addChannel({ id: 'cat-cfd', name: 'cfd', type: ChannelType.GuildCategory, inCache: false })
    const cfdTopic = guild.addChannel({ id: 'ch-cfd', name: 'cfd-topic', parentId: cfdCat.id, inCache: false })
    const cfdArch2 = guild.addChannel({ id: 'cat-cfd-arch2', name: 'cfd (archived) 2', type: ChannelType.GuildCategory, inCache: false })
    const chInArch2 = guild.addChannel({ id: 'ch-arch2', name: 'old-cfd', parentId: cfdArch2.id, inCache: false })
    const retiredCat = guild.addChannel({ id: 'cat-old', name: 'old-swarm', type: ChannelType.GuildCategory, inCache: false })
    const chRetired = guild.addChannel({ id: 'ch-ret', name: 'dead', parentId: retiredCat.id, inCache: false })
    // Uncached archived thread inside ch-cfd (Discord omits archived threads from guild cache)
    const archThread = guild.addChannel({
      id: 'thread-arch', name: 'archived-thread', type: ChannelType.PublicThread,
      parentId: cfdTopic.id, thread: true, clientOnly: true,
    })
    // DM channel
    const dmChan = guild.addChannel({ id: 'dm-1', name: 'dm', type: ChannelType.DM, dm: true, clientOnly: true })
    // Foreign guild channel
    const foreignChan = guild.addChannel({ id: 'foreign-1', name: 'other', guildId: 'guild-2', clientOnly: true })

    const subs = new Subscriptions()
    subs.add('cfd-agent', cfdTopic.id)

    const sc = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} }, retired: ['old-swarm'] }),
      client: guild.asClientLike(),
      subs,
      knownSwarm: n => (n === 'cfd-agent' ? 'cfd' : 'default'),
    })

    // Before clientReady: unknown, and pruneSessionSubscriptions NEVER drops subscriptions!
    expect(sc.channelSwarm(cfdTopic.id)).toBe('unknown')
    expect(await sc.resolveChannelSwarm(cfdTopic.id)).toEqual({ kind: 'unknown' })
    expect(sc.pruneSessionSubscriptions('cfd-agent', 'cfd')).toBe(0)
    expect(subs.of('cfd-agent')).toEqual([cfdTopic.id])

    // After clientReady fetch
    await sc.onClientReady(guild.asGuildLike())
    expect(sc.channelSwarm(cfdTopic.id)).toBe('cfd')
    expect(sc.classifyChannel(chInArch2.id)).toEqual({ kind: 'swarm', swarm: 'cfd', archived: true })
    expect(sc.channelSwarm(chRetired.id)).toBe('retired')

    // Cache-miss fetch resolves archived thread -> 'cfd', DM -> 'dm', foreign guild -> 'unknown'
    expect(sc.channelSwarm(archThread.id)).toBe('unknown') // not in guild cache
    expect(await sc.resolveChannelSwarm(archThread.id)).toEqual({ kind: 'swarm', swarm: 'cfd', archived: false })
    expect(await sc.resolveChannelSwarm(dmChan.id)).toEqual({ kind: 'dm' })
    expect(await sc.resolveChannelSwarm(foreignChan.id)).toEqual({ kind: 'unknown' })

    // Uncategorised channel last seen in a swarm category -> 'retired' until moved to a default category
    await cfdTopic.edit({ parent: null })
    expect(sc.channelSwarm(cfdTopic.id)).toBe('retired')
    const defCat = guild.addChannel({ id: 'cat-def', name: 'General', type: ChannelType.GuildCategory })
    await cfdTopic.edit({ parent: defCat.id })
    expect(sc.channelSwarm(cfdTopic.id)).toBe('default')
  })

  test('sweep drops non-member subscriptions (keeping crossSwarm) and drops moved channelOwners', async () => {
    const guild = new FakeGuild()
    const defCat = guild.addChannel({ id: 'cat-def', name: 'General', type: ChannelType.GuildCategory })
    const cfdCat = guild.addChannel({ id: 'cat-cfd', name: 'cfd', type: ChannelType.GuildCategory })
    const topic = guild.addChannel({ id: 'topic-1', name: 'moved-topic', parentId: defCat.id })

    const subs = new Subscriptions()
    subs.add('def-agent', topic.id)
    subs.add('cfd-agent', topic.id)
    subs.add('ops-cross', topic.id)
    const channelOwners = new Map<string, string>([[topic.id, 'def-agent']])

    const sc = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} }, crossSwarm: ['ops-cross'] }),
      client: guild.asClientLike(),
      subs,
      channelOwners,
      knownSwarm: n => (n === 'cfd-agent' ? 'cfd' : 'default'),
    })

    await sc.onClientReady(guild.asGuildLike())
    // Initially in default -> cfd-agent pruned, def-agent + ops-cross kept, owner kept
    expect(subs.subscribers(topic.id).sort()).toEqual(['def-agent', 'ops-cross'])
    expect(channelOwners.get(topic.id)).toBe('def-agent')

    // Now move topic into cfd category by hand and trigger sweep (channelUpdate)
    subs.add('cfd-agent', topic.id)
    await topic.edit({ parent: cfdCat.id })
    const res = sc.sweep()
    expect(res.droppedSubs).toBe(1)
    expect(res.droppedOwners).toBe(1)
    expect(subs.subscribers(topic.id).sort()).toEqual(['cfd-agent', 'ops-cross'])
    expect(channelOwners.has(topic.id)).toBe(false)

    // Cross-swarm session keeps its subscriptions at register-time prune
    expect(sc.pruneSessionSubscriptions('ops-cross', 'default')).toBe(0)
    expect(subs.of('ops-cross')).toEqual([topic.id])
  })

  test('channelOps scopes resolve/list, forbids general/human in swarm create, and archives with overflow', async () => {
    const guild = new FakeGuild()
    guild.addChannel({ id: 'bus', name: 'general' })
    const sc = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} } }),
      client: guild.asClientLike(),
      busChannelId: 'bus',
      knownSwarm: () => 'default',
      maxPerCategory: 2,
    })
    const gLike = guild.asGuildLike()
    await sc.onClientReady(gLike)
    const ops = sc.createChannelOps(async () => gLike)

    // Refuses general and human in non-default swarm
    await expect(ops.create('general', undefined, 'cfd')).rejects.toThrow('reserved_swarm_channel')
    await expect(ops.create('human', undefined, 'cfd')).rejects.toThrow('reserved_swarm_channel')

    const c1 = await ops.create('shared-name', undefined, 'default')
    const c2 = await ops.create('shared-name', undefined, 'cfd')
    expect((await ops.resolve('shared-name', 'default'))?.id).toBe(c1.id)
    expect((await ops.resolve('shared-name', 'cfd'))?.id).toBe(c2.id)
    expect((await ops.list('cfd')).map(c => c.name)).toContain('shared-name')
    expect((await ops.list('cfd')).some(c => c.id === c1.id)).toBe(false)

    // Archive c2 + two more cfd channels -> overflows to "cfd (archived) 2" and excludes archived from resolve/list
    const c3 = await ops.create('t3', undefined, 'cfd')
    const c4 = await ops.create('t4', undefined, 'cfd')
    await ops.archive!(c2.id, 'done', 'cfd')
    await ops.archive!(c3.id, 'done', 'cfd')
    await ops.archive!(c4.id, 'done', 'cfd')
    expect(await ops.resolve('shared-name', 'cfd')).toBeNull()
    expect((await ops.list('cfd')).some(c => c.id === c2.id)).toBe(false)
    const archCats = [...guild.backing.values()].filter(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('(archived)'))
    expect(archCats.map(c => c.name).sort()).toEqual(['cfd (archived)', 'cfd (archived) 2'])
  })

  test('direct channel follows its agent when moving swarms and archives to swarm archive category', async () => {
    const dir = tempDir()
    const guild = new FakeGuild()
    guild.addChannel({ id: 'bus', name: 'general' })
    const agentChannels = new AgentChannels(dir)
    const sc = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} } }),
      client: guild.asClientLike(),
      busChannelId: 'bus',
      agentChannels,
      knownSwarm: () => 'default',
    })
    const gLike = guild.asGuildLike()
    await sc.onClientReady(gLike)
    const acOps = sc.createAgentChannelOps(async () => gLike)

    const t0 = 1_000_000
    agentChannels.register({ name: 'codex@mac:mover', kind: 'codex', host: 'mac', swarm: 'default' }, t0)
    await agentChannels.maintain(acOps, () => true, t0 + AGENT_CHANNEL_DELAY_MS)
    const directId = [...guild.backing.values()].find(c => c.name === 'a-codex-mac-mover')!.id
    expect(guild.backing.get(guild.backing.get(directId)!.parentId!)!.name).toBe('Agents')

    // Move agent to cfd -> register with swarm:'cfd' -> maintain moves direct channel to cfd category!
    agentChannels.register({ name: 'codex@mac:mover', kind: 'codex', host: 'mac', swarm: 'cfd' }, t0 + AGENT_CHANNEL_DELAY_MS + 1000)
    await agentChannels.maintain(acOps, () => true, t0 + AGENT_CHANNEL_DELAY_MS + 2000)
    expect(guild.backing.get(guild.backing.get(directId)!.parentId!)!.name).toBe('cfd')

    // Idle sweep archives it to "cfd (archived)"
    agentChannels.disconnect('codex@mac:mover', t0 + AGENT_CHANNEL_DELAY_MS + 3000)
    await agentChannels.maintain(acOps, () => false, t0 + AGENT_CHANNEL_DELAY_MS + 3000 + AGENT_CHANNEL_IDLE_MS)
    expect(guild.backing.get(guild.backing.get(directId)!.parentId!)!.name).toBe('cfd (archived)')
  })

  test('classifyInbound routes non-archived swarm channels to bus and drops archived, retired, and unknown before gate()', async () => {
    const guild = new FakeGuild()
    guild.addChannel({ id: 'bus', name: 'general' })
    const cfdArch = guild.addChannel({ id: 'cat-ca', name: 'cfd (archived)', type: ChannelType.GuildCategory })
    const chArch = guild.addChannel({ id: 'ch-ca', name: 'old', parentId: cfdArch.id })
    const retCat = guild.addChannel({ id: 'cat-ret', name: 'old-s', type: ChannelType.GuildCategory })
    const chRet = guild.addChannel({ id: 'ch-ret', name: 'dead', parentId: retCat.id })
    const dm = guild.addChannel({ id: 'dm-1', name: 'dm', type: ChannelType.DM, dm: true, clientOnly: true })

    const sc = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} }, retired: ['old-s'] }),
      client: guild.asClientLike(),
      busChannelId: 'bus',
      knownSwarm: () => 'default',
    })
    await sc.onClientReady(guild.asGuildLike())

    const isDefaultBus = (id: string) => id === 'bus'
    expect(await sc.classifyInbound(sc.generalChannelId('cfd')!, isDefaultBus)).toBe('bus')
    expect(await sc.classifyInbound(chArch.id, isDefaultBus)).toBe('drop')
    expect(await sc.classifyInbound(chRet.id, isDefaultBus)).toBe('drop')
    expect(await sc.classifyInbound('does-not-exist', isDefaultBus)).toBe('drop')
    expect(await sc.classifyInbound(dm.id, isDefaultBus)).toBe('gate')
    expect(await sc.classifyInbound('bus', isDefaultBus)).toBe('bus')
  })

  test('M3: before initial fetch DMs go to gate and default bus/direct/sub channels stay on bus; startup fetch retries with backoff', async () => {
    const guild = new FakeGuild()
    guild.addChannel({ id: 'bus', name: 'general' })
    guild.addChannel({ id: 'direct-1', name: 'a-claude-mac-a' })
    guild.addChannel({ id: 'sub-1', name: 'topic-default' })
    const dm = guild.addChannel({ id: 'dm-1', name: 'dm', type: ChannelType.DM, dm: true, clientOnly: true })

    const sc = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} } }),
      client: guild.asClientLike(),
      busChannelId: 'bus',
      knownSwarm: () => 'default',
      retryBaseMs: 15,
    })

    const isDefaultBus = (id: string) => id === 'bus' || id === 'direct-1' || id === 'sub-1'
    // Before initialFetchDone: DMs -> gate, default bus/direct/sub -> bus, unknown -> drop
    expect(sc.isInitialFetchDone()).toBe(false)
    expect(await sc.classifyInbound(dm.id, isDefaultBus, true)).toBe('gate')
    expect(await sc.classifyInbound(dm.id, isDefaultBus, false)).toBe('gate')
    expect(await sc.classifyInbound('bus', isDefaultBus)).toBe('bus')
    expect(await sc.classifyInbound('direct-1', isDefaultBus)).toBe('bus')
    expect(await sc.classifyInbound('sub-1', isDefaultBus)).toBe('bus')
    expect(await sc.classifyInbound('unknown-swarm-ch', isDefaultBus)).toBe('drop')

    // Startup fetch fails once then succeeds on retry (even with busChannelId unset)
    const g2 = new FakeGuild()
    let attempts = 0
    const sc2 = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} } }),
      client: g2.asClientLike(),
      knownSwarm: () => 'default',
      retryBaseMs: 15,
    })
    const ok1 = await sc2.startClientReady(async () => {
      attempts++
      if (attempts === 1) throw new Error('transient fetch error')
      return g2.asGuildLike()
    })
    expect(ok1).toBe(false)
    expect(sc2.isInitialFetchDone()).toBe(false)
    // Wait for retry timer to succeed
    const deadline = Date.now() + 1000
    while (!sc2.isInitialFetchDone() && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 15))
    }
    expect(sc2.isInitialFetchDone()).toBe(true)
    expect(sc2.isSwarmReady('cfd')).toBe(true)
    expect(attempts).toBeGreaterThanOrEqual(2)
    sc2.stop()
  })

  test('M4: archived default #26 direct channel stays inbound while archived non-default swarm channel drops', async () => {
    const guild = new FakeGuild()
    guild.addChannel({ id: 'bus', name: 'general' })
    const defArchAgentCat = guild.addChannel({ id: 'cat-aa', name: 'Agents (archived)', type: ChannelType.GuildCategory })
    const defDirectArch = guild.addChannel({ id: 'ch-def-direct', name: 'a-claude-mac-idle', parentId: defArchAgentCat.id })
    const defArchCat = guild.addChannel({ id: 'cat-arch', name: 'archive', type: ChannelType.GuildCategory })
    const defTopicArch = guild.addChannel({ id: 'ch-def-topic', name: 'old-topic', parentId: defArchCat.id })
    const cfdArchCat = guild.addChannel({ id: 'cat-cfd-arch', name: 'cfd (archived)', type: ChannelType.GuildCategory })
    const cfdArch = guild.addChannel({ id: 'ch-cfd-arch', name: 'old-cfd', parentId: cfdArchCat.id })

    const sc = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} } }),
      client: guild.asClientLike(),
      busChannelId: 'bus',
      knownSwarm: () => 'default',
    })
    await sc.onClientReady(guild.asGuildLike())

    const isDefaultBus = (id: string) => id === 'bus' || id === defDirectArch.id || id === defTopicArch.id
    expect(await sc.classifyInbound(defDirectArch.id, isDefaultBus)).toBe('bus')
    expect(await sc.classifyInbound(defTopicArch.id, isDefaultBus)).toBe('bus')
    expect(await sc.classifyInbound(cfdArch.id, isDefaultBus)).toBe('drop')
  })

  test('M5 & m2: restart with stale subscriber adopts & prunes instead of refusing; hand-fixed refused category recovers without creating cfd 2', async () => {
    // Part 1 (M5): already-provisioned cfd category (has general + human) with a stale non-member subscriber
    const g1 = new FakeGuild()
    const cfdCat = g1.addChannel({ id: 'cat-cfd', name: 'cfd', type: ChannelType.GuildCategory })
    const cfdGen = g1.addChannel({ id: 'ch-gen', name: 'general', parentId: cfdCat.id })
    g1.addChannel({ id: 'ch-hum', name: 'human', parentId: cfdCat.id })
    const cfdTopic = g1.addChannel({ id: 'ch-topic', name: 'work', parentId: cfdCat.id })

    const subs = new Subscriptions()
    subs.add('stale-default-agent', cfdTopic.id)
    subs.add('cfd-member', cfdTopic.id)

    const sc1 = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} } }),
      client: g1.asClientLike(),
      subs,
      knownSwarm: n => (n === 'cfd-member' ? 'cfd' : 'default'),
    })
    await sc1.onClientReady(g1.asGuildLike())
    expect(sc1.isSwarmReady('cfd')).toBe(true)
    expect(sc1.channelSwarm(cfdGen.id)).toBe('cfd')
    expect(sc1.channelSwarm(cfdTopic.id)).toBe('cfd')
    expect(subs.subscribers(cfdTopic.id)).toEqual(['cfd-member'])

    // Part 2 (m2): refused category fixed by hand recovers on re-provision without creating "cfd 2"
    const g2 = new FakeGuild()
    const badCat = g2.addChannel({ id: 'cat-cfd2', name: 'cfd', type: ChannelType.GuildCategory })
    const bus = g2.addChannel({ id: 'bus', name: 'general', parentId: badCat.id })
    const sc2 = new SwarmChannels({
      config: SwarmConfig.fromObject({ swarms: { cfd: {} } }),
      client: g2.asClientLike(),
      busChannelId: 'bus',
      knownSwarm: () => 'default',
    })
    await sc2.onClientReady(g2.asGuildLike())
    expect(sc2.isSwarmReady('cfd')).toBe(false)

    // Operator moves BUS_CHANNEL out of cfd category
    const defCat = g2.addChannel({ id: 'cat-def', name: 'General', type: ChannelType.GuildCategory })
    await bus.edit({ parent: defCat.id })

    // Re-provision adopts original "cfd" category without creating "cfd 2"
    const ok = await sc2.provisionSwarm('cfd', g2.asGuildLike())
    expect(ok).toBe(true)
    expect(sc2.isSwarmReady('cfd')).toBe(true)
    const cfdCats = [...g2.backing.values()].filter(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().startsWith('cfd'))
    expect(cfdCats.map(c => c.name)).toEqual(['cfd'])
  })

  test('M6: direct-channel cap of 100 is enforced per swarm', async () => {
    const dir = tempDir()
    const ac = new AgentChannels(dir)
    const created: string[] = []
    const ops = {
      ensure: async (info: { name: string }) => {
        const id = `ch-${created.length + 1}`
        created.push(info.name)
        return id
      },
      update: async () => {},
      archive: async () => {},
      move: async () => {},
    }
    const t0 = 1_000_000
    // Fill 100 direct channels in 'default'
    for (let i = 0; i < 100; i++) {
      ac.register({ name: `claude@mac:d${i}`, kind: 'claude', host: 'mac', swarm: 'default' }, t0)
    }
    await ac.maintain(ops, () => true, t0 + AGENT_CHANNEL_DELAY_MS)
    expect(created).toHaveLength(100)

    // 101st default agent is capped, while a cfd agent IS allowed its own per-swarm budget
    ac.register({ name: 'claude@mac:d100', kind: 'claude', host: 'mac', swarm: 'default' }, t0 + AGENT_CHANNEL_DELAY_MS + 10)
    ac.register({ name: 'claude@mac:cfd/w1', kind: 'claude', host: 'mac', swarm: 'cfd' }, t0 + AGENT_CHANNEL_DELAY_MS + 10)
    await ac.maintain(ops, () => true, t0 + AGENT_CHANNEL_DELAY_MS * 2 + 100)
    expect(created).not.toContain('claude@mac:d100')
    expect(created).toContain('claude@mac:cfd/w1')
  })

  test('m3: no-config archive uses single archive category and agent ensure fetches when cache is empty', async () => {
    const guild = new FakeGuild()
    guild.addChannel({ id: 'bus', name: 'general' })
    const c1 = guild.addChannel({ id: 'c1', name: 't1' })
    const c2 = guild.addChannel({ id: 'c2', name: 't2' })
    const c3 = guild.addChannel({ id: 'c3', name: 't3' })
    const sc = new SwarmChannels({
      config: SwarmConfig.inStateDir(tempDir()),
      client: guild.asClientLike(),
      busChannelId: 'bus',
      knownSwarm: () => 'default',
      maxPerCategory: 2,
    })
    const gLike = guild.asGuildLike()
    const ops = sc.createChannelOps(async () => gLike)
    await ops.archive!(c1.id, 'done')
    await ops.archive!(c2.id, 'done')
    await ops.archive!(c3.id, 'done')
    const archCats = [...guild.backing.values()].filter(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().startsWith('archive'))
    expect(archCats.map(c => c.name)).toEqual(['archive'])

    // Empty guild cache: agentChannelOps.ensure fetches before checking for existing direct channel
    const gEmpty = new FakeGuild()
    const agentsCat = gEmpty.addChannel({ id: 'cat-agents', name: 'Agents', type: ChannelType.GuildCategory, inCache: false })
    const existingDirect = gEmpty.addChannel({
      id: 'direct-existing',
      name: 'a-claude-mac-a',
      parentId: agentsCat.id,
      topic: 'Direct line to claude@mac:a (claude on mac)',
      inCache: false,
    })
    expect(gEmpty.cache.size).toBe(0)
    const scEmpty = new SwarmChannels({
      config: SwarmConfig.inStateDir(tempDir()),
      client: gEmpty.asClientLike(),
      knownSwarm: () => 'default',
    })
    const acOps = scEmpty.createAgentChannelOps(async () => gEmpty.asGuildLike())
    const adoptedId = await acOps.ensure({ name: 'claude@mac:a', kind: 'claude', host: 'mac' })
    expect(adoptedId).toBe(existingDirect.id)
    expect(gEmpty.fetchCount).toBe(1)
  })
})
