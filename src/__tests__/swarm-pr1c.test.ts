import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelType } from 'discord.js'
import { AgentChannels } from '../agent-channels.js'
import { Inboxes } from '../inboxes.js'
import { Claims, NodeRegistry } from '../nodes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { _setRegisteredSkillsForTest, handleAutocomplete, handleSlashCommand, type SlashCommandDeps } from '../slash-commands.js'
import { Subscriptions } from '../subscriptions.js'
import { SwarmChannels, type ChannelClientLike, type GuildChannelLike, type GuildLike } from '../swarm-channels.js'
import { SwarmConfig } from '../swarm-config.js'
import { SwarmJournal } from '../swarm-journal.js'
import { HumanMail } from '../wake.js'
import {
  channelSubscribers,
  createWsHandlers,
  flushHeldPermissionsForSwarm,
  handlePermissionButton,
  killSession,
  knownSwarm,
  resetBusRateLimit,
  routeHumanBusMessage,
  type WsDeps,
  type WsLike,
} from '../ws.js'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarm-pr1c-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const tick = (ms = 20) => new Promise(res => setTimeout(res, ms))

interface FakeChan extends GuildChannelLike {
  parentId: string | null
  topic: string | null
  sent: Array<{ content: string; components?: unknown[] }>
  isTextBased(): boolean
  send(opts: { content: string; components?: unknown[] }): Promise<{ id: string }>
  messages: {
    fetch(arg: unknown): Promise<unknown>
  }
}

class FakeEnv {
  readonly dir = tempDir()
  readonly backing = new Map<string, FakeChan>()
  readonly cache = new Map<string, GuildChannelLike>()
  readonly clientOnly = new Map<string, FakeChan>()
  readonly sentByChan = new Map<string, Array<{ content: string; components?: unknown[] }>>()
  nextId = 100

  addChan(opts: {
    id?: string
    name: string
    type?: ChannelType
    parentId?: string | null
    dm?: boolean
    thread?: boolean
    clientOnly?: boolean
  }): FakeChan {
    const id = opts.id ?? String(++this.nextId)
    const sent: Array<{ content: string; components?: unknown[] }> = []
    this.sentByChan.set(id, sent)
    const ch: FakeChan = {
      id,
      name: opts.name,
      type: opts.type ?? ChannelType.GuildText,
      parentId: opts.parentId ?? null,
      topic: null,
      guildId: opts.dm ? null : 'guild-1',
      sent,
      isThread: () => Boolean(opts.thread || ch.type === ChannelType.PublicThread),
      isDMBased: () => Boolean(opts.dm || ch.type === ChannelType.DM),
      isTextBased: () => ch.type !== ChannelType.GuildCategory,
      send: async (payload) => {
        sent.push(payload)
        return { id: `m-${id}-${sent.length}` }
      },
      messages: {
        fetch: async (arg: unknown) => {
          if (typeof arg === 'string') {
            return {
              id: arg,
              author: { id: 'bot-1', username: 'bot' },
              attachments: new Map(),
              react: async () => {},
              edit: async () => {},
            }
          }
          return [{ id: 'm1', author: { username: 'mick' }, content: 'hi', createdAt: new Date(), attachments: [] }]
        },
      },
      edit: async (patch) => {
        if (patch.name !== undefined) (ch as { name: string }).name = patch.name
        if (patch.parent !== undefined) ch.parentId = patch.parent
        if (patch.topic !== undefined) ch.topic = patch.topic
        this.backing.set(ch.id, ch)
        this.cache.set(ch.id, ch)
        return ch
      },
    }
    if (opts.clientOnly) this.clientOnly.set(id, ch)
    else {
      this.backing.set(id, ch)
      this.cache.set(id, ch)
    }
    return ch
  }

  asGuildLike(): GuildLike {
    return {
      id: 'guild-1',
      channels: {
        cache: this.cache,
        fetch: async (id?: string) => {
          if (id) return this.backing.get(id) ?? null
          this.cache.clear()
          for (const [k, v] of this.backing) this.cache.set(k, v)
          return this.cache
        },
        create: async (opts) => this.addChan({ name: opts.name, type: opts.type, parentId: opts.parent ?? null }),
      },
    }
  }

  asClient() {
    return {
      user: { id: 'bot-1' },
      isReady: () => true,
      channels: {
        cache: this.cache,
        fetch: async (id: string) => this.clientOnly.get(id) ?? this.backing.get(id) ?? null,
      },
    }
  }
}

async function setupSwarmWorld(opts: { ready?: boolean; extraDeps?: Partial<WsDeps> } = {}) {
  resetBusRateLimit()
  const env = new FakeEnv()
  const defCat = env.addChan({ id: 'cat-def', name: 'General', type: ChannelType.GuildCategory })
  const busCh = env.addChan({ id: 'ch-bus', name: 'general', parentId: defCat.id })
  const humanCh = env.addChan({ id: 'ch-human', name: 'human-questions', parentId: defCat.id })
  const defTopic = env.addChan({ id: 'ch-def-topic', name: 'def-topic', parentId: defCat.id })
  const defThread = env.addChan({ id: 'th-def', name: 'def-thread', type: ChannelType.PublicThread, parentId: defTopic.id, thread: true, clientOnly: true })
  const dmCh = env.addChan({ id: 'ch-dm', name: 'dm', type: ChannelType.DM, dm: true, clientOnly: true })
  const retCat = env.addChan({ id: 'cat-ret', name: 'retired-s', type: ChannelType.GuildCategory })
  const retCh = env.addChan({ id: 'ch-ret', name: 'dead', parentId: retCat.id })

  const swarmConfig = SwarmConfig.fromObject({
    swarms: { cfd: {} },
    crossSwarm: ['claude@mac:ops'],
    retired: ['retired-s'],
  })
  const sessions = new SessionManager()
  const history = new ProjectHistory(env.dir)
  const subs = new Subscriptions()
  const inboxes = new Inboxes()
  const claims = new Claims()
  const nodes = new NodeRegistry()
  const humanMail = new HumanMail()
  const swarmJournal = new SwarmJournal()
  const skillsCalls: unknown[] = []

  let deps!: WsDeps
  const swarmChannels = new SwarmChannels({
    config: swarmConfig,
    client: env.asClient() as unknown as ChannelClientLike,
    busChannelId: busCh.id,
    humanChannelId: humanCh.id,
    subs,
    knownSwarm: n => knownSwarm(deps, n),
  })
  const gLike = env.asGuildLike()
  const channelOps = swarmChannels.createChannelOps(async () => gLike)

  deps = {
    sessions,
    history,
    client: env.asClient() as unknown as WsDeps['client'],
    chatId: () => dmCh.id,
    chunkLimit: 2000,
    chunkMode: 'length',
    replyToMode: 'first',
    busChannelId: busCh.id,
    humanChannelId: humanCh.id,
    subs,
    channelOps,
    inboxes,
    claims,
    nodes,
    humanMail,
    admins: new Set(['claude@mac:def-admin', 'claude@mac:ops']),
    dispatcher: 'claude@mac:def-dispatcher',
    swarmConfig,
    swarmJournal,
    swarmChannels,
    swarmGeneralChannel: s => swarmChannels.generalChannelId(s),
    onSkillsRegistered: s => { skillsCalls.push(s) },
    ...opts.extraDeps,
  }
  const handlers = createWsHandlers(deps)

  if (opts.ready !== false) {
    await swarmChannels.onClientReady(gLike)
  }
  const cfdGeneral = swarmChannels.generalChannelId('cfd')
  const cfdHuman = swarmChannels.humanChannelId('cfd')
  const cfdTopic = opts.ready !== false
    ? await channelOps.create('cfd-topic', undefined, 'cfd')
    : null
  const cfdArchivedThread = cfdTopic
    ? env.addChan({ id: 'th-cfd-arch', name: 'cfd-arch-thread', type: ChannelType.PublicThread, parentId: cfdTopic.id, thread: true, clientOnly: true })
    : null

  function connect(name: string, swarm: string, instanceId: string) {
    const frames: Record<string, unknown>[] = []
    let closed = false
    const ws: WsLike = {
      data: { sessionName: null, sendCallback: null },
      send(raw) { frames.push(JSON.parse(raw)) },
      close() { closed = true },
    }
    const send = (frame: Record<string, unknown>) => handlers.message(ws, JSON.stringify(frame))
    send({ type: 'register', name, swarm, projectPath: '/p', instanceId })
    return {
      ws,
      frames,
      send,
      isClosed: () => closed,
      result(reqId: string) {
        return frames.find(f => f.type === 'toolResult' && f.requestId === reqId)
      },
    }
  }

  return {
    env, deps, handlers, swarmConfig, swarmChannels, channelOps,
    busCh, humanCh, defTopic, defThread, dmCh, retCh, cfdGeneral, cfdHuman, cfdTopic, cfdArchivedThread,
    skillsCalls, connect,
  }
}

describe('PR1c cross-swarm rejection per op', () => {
  test('every op rejects cross-swarm channel/swarm/DM/thread/retired targets', async () => {
    const w = await setupSwarmWorld()
    const cfd = w.connect('claude@mac:cfd-1', 'cfd', 'c1')
    const def = w.connect('claude@mac:def-1', 'agents', 'd1')
    const defAdmin = w.connect('claude@mac:def-admin', 'agents', 'da1')

    // 1. channelCreate with foreign swarm
    cfd.send({ type: 'channelCreate', requestId: 'op-create', name: 'sneak', swarm: 'default' })
    // 2. busPost with foreign swarm
    cfd.send({ type: 'busPost', requestId: 'op-buspost', text: 'hi', swarm: 'default' })
    // 3. channelPost on default channel id + default thread + retired channel
    cfd.send({ type: 'channelPost', requestId: 'op-chpost', channel: w.defTopic.id, text: 'hi' })
    cfd.send({ type: 'channelPost', requestId: 'op-retired', channel: w.retCh.id, text: 'hi' })
    // 4. channelSubscribe on default channel id + non-crossSwarm admin acting for cfd session
    cfd.send({ type: 'channelSubscribe', requestId: 'op-sub', channel: w.defTopic.id })
    defAdmin.send({ type: 'channelSubscribe', requestId: 'op-admin-cross', channel: w.cfdTopic!.id, session: 'claude@mac:cfd-1' })
    // 5. channelUnsubscribe on default channel id
    cfd.send({ type: 'channelUnsubscribe', requestId: 'op-unsub', channel: w.defTopic.id })
    // 6. channelList with foreign swarm
    cfd.send({ type: 'channelList', requestId: 'op-list', swarm: 'default' })
    // 7. channelArchive: default channel, cfd:general, cfd:human, cross-swarm replacement
    cfd.send({ type: 'channelArchive', requestId: 'op-arch-def', channel: w.defTopic.id })
    cfd.send({ type: 'channelArchive', requestId: 'op-arch-gen', channel: w.cfdGeneral! })
    cfd.send({ type: 'channelArchive', requestId: 'op-arch-hum', channel: w.cfdHuman! })
    cfd.send({ type: 'channelArchive', requestId: 'op-arch-repl', channel: w.cfdTopic!.id, replacement: w.defTopic.id })
    // 8. reply to default channel, default thread, and DM from non-default caller
    cfd.send({ type: 'reply', requestId: 'op-reply-def', chatId: w.defTopic.id, text: 'hi' })
    cfd.send({ type: 'reply', requestId: 'op-reply-thread', chatId: w.defThread.id, text: 'hi' })
    cfd.send({ type: 'reply', requestId: 'op-reply-dm', chatId: w.dmCh.id, text: 'hi' })
    // 9. fetchMessages on default channel + default reading uncached archived cfd thread
    cfd.send({ type: 'fetchMessages', requestId: 'op-fetch', channel: w.defTopic.id })
    def.send({ type: 'fetchMessages', requestId: 'op-fetch-arch-thread', channel: w.cfdArchivedThread!.id })
    // 10. react on default channel
    cfd.send({ type: 'react', requestId: 'op-react', chatId: w.defTopic.id, messageId: 'm1', emoji: '👍' })
    // 11. editMessage on default channel
    cfd.send({ type: 'editMessage', requestId: 'op-edit', chatId: w.defTopic.id, messageId: 'm1', text: 'edited' })
    // 12. downloadAttachment on default channel
    cfd.send({ type: 'downloadAttachment', requestId: 'op-dl', chatId: w.defTopic.id, messageId: 'm1' })
    // 13. askUser on default channel
    cfd.send({ type: 'askUser', requestId: 'op-ask', chatId: w.defTopic.id, question: 'q?', options: [{ label: 'a', value: 'a' }] })

    await tick(40)

    for (const id of [
      'op-create', 'op-buspost', 'op-chpost', 'op-sub', 'op-unsub', 'op-list',
      'op-arch-def', 'op-arch-repl', 'op-reply-def', 'op-reply-thread', 'op-reply-dm',
      'op-fetch', 'op-react', 'op-edit', 'op-dl', 'op-ask',
    ]) {
      expect(cfd.result(id)).toEqual({ type: 'toolResult', requestId: id, success: false, data: 'cross_swarm' })
    }
    expect(cfd.result('op-retired')).toEqual({ type: 'toolResult', requestId: 'op-retired', success: false, data: 'retired_swarm' })
    expect(cfd.result('op-arch-gen')?.success).toBe(false)
    expect(cfd.result('op-arch-hum')?.success).toBe(false)
    expect(defAdmin.result('op-admin-cross')).toEqual({ type: 'toolResult', requestId: 'op-admin-cross', success: false, data: 'cross_swarm' })
    expect(def.result('op-fetch-arch-thread')).toEqual({ type: 'toolResult', requestId: 'op-fetch-arch-thread', success: false, data: 'cross_swarm' })

    // Default caller CAN access DM
    def.send({ type: 'reply', requestId: 'def-dm-ok', chatId: w.dmCh.id, text: 'hello dm' })
    await tick()
    expect(def.result('def-dm-ok')?.success).toBe(true)
  })
})

describe('PR1c to=, crossSwarm, outbound, claims, dispatch, skills, and inbound', () => {
  test('to= scoping, crossSwarm auto-swarm routing, bus_sessions, and human mirror per swarm', async () => {
    const w = await setupSwarmWorld()
    const cfd1 = w.connect('claude@mac:cfd-1', 'cfd', 'c1')
    const cfd2 = w.connect('claude@mac:cfd-2', 'cfd', 'c2')
    const def1 = w.connect('claude@mac:def-1', 'agents', 'd1')
    const ops = w.connect('claude@mac:ops', 'agents', 'o1')

    // cfd1 -> def1 rejected without leaking default names in Connected list
    cfd1.send({ type: 'busPost', requestId: 'bad-to', text: 'hi', to: 'claude@mac:def-1' })
    await tick()
    const badRes = cfd1.result('bad-to')!
    expect(badRes.success).toBe(false)
    expect(String(badRes.data)).toBe('No session named "claude@mac:def-1" in swarm cfd. Connected: claude@mac:cfd-2')

    // cfd1 -> ops (crossSwarm) succeeds!
    cfd1.send({ type: 'busPost', requestId: 'to-cross', text: 'need help', to: 'claude@mac:ops' })
    await tick()
    expect(cfd1.result('to-cross')?.success).toBe(true)
    expect(ops.frames.some(f => f.type === 'message' && f.content === 'need help' && (f.meta as Record<string, string>).chat_id === w.cfdGeneral)).toBe(true)

    // ops (crossSwarm) bus_post(to=cfd1) with NO swarm -> auto-targets cfd:general!
    ops.send({ type: 'busPost', requestId: 'cross-auto', text: 'got it', to: 'claude@mac:cfd-1' })
    await tick()
    expect(ops.result('cross-auto')?.success).toBe(true)
    expect(cfd1.frames.some(f => f.type === 'message' && f.content === 'got it' && (f.meta as Record<string, string>).chat_id === w.cfdGeneral)).toBe(true)

    // ops bus_post(swarm="cfd", to=def1) -> rejected because both given and def1 not in cfd!
    ops.send({ type: 'busPost', requestId: 'cross-mismatch', text: 'nope', swarm: 'cfd', to: 'claude@mac:def-1' })
    await tick()
    expect(ops.result('cross-mismatch')?.success).toBe(false)

    // cfd1 to="all" wakes cfd2 ONLY (not ops, not def1)
    cfd1.send({ type: 'busPost', requestId: 'cfd-all', text: 'cfd broadcast', to: 'all' })
    await tick()
    expect(cfd2.frames.some(f => f.type === 'message' && f.content === 'cfd broadcast')).toBe(true)
    expect(def1.frames.some(f => f.type === 'message' && f.content === 'cfd broadcast')).toBe(false)
    expect(ops.frames.some(f => f.type === 'message' && f.content === 'cfd broadcast')).toBe(false)

    // cfd1 to="human" redirects to cfd:human (NOT default HUMAN_CHANNEL!)
    cfd1.send({ type: 'busPost', requestId: 'cfd-hum', text: 'question for mick', to: 'human' })
    await tick()
    expect(cfd1.result('cfd-hum')?.success).toBe(true)
    expect(w.env.sentByChan.get(w.cfdHuman!)!.some(m => m.content.includes('question for mick'))).toBe(true)
    expect(w.env.sentByChan.get(w.humanCh.id)!.some(m => m.content.includes('question for mick'))).toBe(false)

    // Per-swarm #26 human guard rejects raw post to cfd:human without to="human"
    cfd1.send({ type: 'channelPost', requestId: 'cfd-hum-guard', channel: w.cfdHuman!, text: 'chatter' })
    await tick()
    expect(cfd1.result('cfd-hum-guard')?.success).toBe(false)

    // bus_sessions scoping: ops sees cfd with swarm="cfd"; cfd1 cannot list default
    ops.send({ type: 'listSessions', requestId: 'ls-cfd', swarm: 'cfd' })
    cfd1.send({ type: 'listSessions', requestId: 'ls-def', swarm: 'default' })
    await tick()
    const cfdList = JSON.parse(String(ops.result('ls-cfd')!.data)) as Array<{ name: string; swarm: string }>
    expect(cfdList.map(s => s.name).sort()).toEqual(['claude@mac:cfd-1', 'claude@mac:cfd-2'])
    expect(cfdList.every(s => s.swarm === 'cfd')).toBe(true)
    expect(cfd1.result('ls-def')).toEqual({ type: 'toolResult', requestId: 'ls-def', success: false, data: 'cross_swarm' })

    // Subscriber that changed swarm gets no fan-out in channelSubscribers
    w.deps.subs!.add('claude@mac:def-1', w.cfdTopic!.id)
    w.deps.subs!.add('claude@mac:cfd-1', w.cfdTopic!.id)
    w.deps.subs!.add('claude@mac:ops', w.cfdTopic!.id)
    expect(channelSubscribers(w.deps, w.cfdTopic!.id).sort()).toEqual(['claude@mac:cfd-1', 'claude@mac:ops'])
  })

  test('claims isolation, cross-swarm dispatch refusal, and non-default skills/history ignored', async () => {
    const w = await setupSwarmWorld()
    const cfd1 = w.connect('claude@mac:cfd-1', 'cfd', 'c1')
    const def1 = w.connect('claude@mac:def-1', 'agents', 'd1')
    const disp = w.connect('claude@mac:def-dispatcher', 'agents', 'disp1')

    // Claims partitioned by (swarm, task): same task won in both swarms, no note leak!
    cfd1.send({ type: 'claim', requestId: 'cl1', task: 'deploy', note: 'cfd-secret-note' })
    def1.send({ type: 'claim', requestId: 'cl2', task: 'deploy', note: 'def-note' })
    def1.send({ type: 'listClaims', requestId: 'lc1' })
    cfd1.send({ type: 'releaseClaim', requestId: 'rc-cross', task: 'deploy', to: 'claude@mac:def-1' })
    await tick()
    expect(JSON.parse(String(cfd1.result('cl1')!.data)).won).toBe(true)
    expect(JSON.parse(String(def1.result('cl2')!.data)).won).toBe(true)
    const defClaims = JSON.parse(String(def1.result('lc1')!.data)) as Array<{ note?: string }>
    expect(defClaims).toHaveLength(1)
    expect(defClaims[0]!.note).toBe('def-note')
    expect(cfd1.result('rc-cross')?.success).toBe(false)

    // Human post in cfd:general recorded in cfd HumanMail partition -> default dispatcher cannot dispatch it!
    routeHumanBusMessage('cfd question', { chat_id: w.cfdGeneral!, message_id: 'cfd-msg-1', from_human: 'true' }, w.deps.sessions, undefined, w.deps, 'cfd')
    disp.send({ type: 'dispatch', requestId: 'disp-cross', messageId: 'cfd-msg-1', to: ['claude@mac:def-1'] })
    await tick()
    expect(disp.result('disp-cross')).toEqual({ type: 'toolResult', requestId: 'disp-cross', success: false, data: 'cross_swarm' })

    // Non-default registerSkills ignored; default accepted; non-default not in ProjectHistory
    cfd1.send({ type: 'registerSkills', skills: [{ name: 'cfd-skill', description: 'nope' }] })
    expect(w.skillsCalls).toHaveLength(0)
    def1.send({ type: 'registerSkills', skills: [{ name: 'def-skill', description: 'ok' }] })
    expect(w.skillsCalls).toHaveLength(1)
    expect(w.deps.history.getRecent().map(p => p.name)).not.toContain('claude@mac:cfd-1')
  })
})

function extractButtonCustomIds(payload: { components?: unknown[] } | undefined): string[] {
  const rows = payload?.components ?? []
  const ids: string[] = []
  for (const r of rows) {
    const json = (r as { toJSON?: () => { components?: Array<{ custom_id?: string }> } }).toJSON?.()
    for (const c of json?.components ?? []) {
      if (typeof c.custom_id === 'string') ids.push(c.custom_id)
    }
  }
  return ids
}

describe('PR1c permission round trip in cfd:human and slash command scoping', () => {
  test('cfd permissionRequest routes to cfd:human with unique promptId, honours allowFrom, and holds until ready or timeout', async () => {
    const w = await setupSwarmWorld()
    const cfd1 = w.connect('claude@mac:cfd-1', 'cfd', 'c1')

    cfd1.send({ type: 'permissionRequest', requestId: 'abcde', toolName: 'Bash', description: 'run test', inputPreview: 'bun test' })
    await tick()
    // Posted in cfd:human, NOT in DM!
    const permMsg = w.env.sentByChan.get(w.cfdHuman!)!.find(m => m.content.includes('Permission Request'))
    expect(permMsg).toBeDefined()
    expect(w.env.sentByChan.get(w.dmCh.id)!.length).toBe(0)
    const yesId = extractButtonCustomIds(permMsg).find(id => id.startsWith('perm_yes_'))!
    expect(yesId).toBeDefined()
    expect(yesId).not.toBe('perm_yes_abcde') // router-minted promptId

    // Unauthorized user click ignored
    expect(handlePermissionButton(yesId, 'stranger-999', ['mick-123'])).toBe(false)
    expect(cfd1.frames.some(f => f.type === 'permissionVerdict')).toBe(false)

    // Authorized allowFrom user click sends allow verdict with original requestId
    expect(handlePermissionButton(yesId, 'mick-123', ['mick-123'])).toBe(true)
    expect(cfd1.frames.at(-1)).toEqual({ type: 'permissionVerdict', requestId: 'abcde', behavior: 'allow' })
    // Second click on same button returns false (already consumed / expired)
    expect(handlePermissionButton(yesId, 'mick-123', ['mick-123'])).toBe(false)

    // When swarm is NOT ready, router holds in memory up to permissionHoldMs, then denies with swarm_not_ready
    const wNotReady = await setupSwarmWorld({ ready: false, extraDeps: { permissionHoldMs: 40 } })
    const cfdNotReady = wNotReady.connect('claude@mac:cfd-1', 'cfd', 'c1')
    cfdNotReady.send({ type: 'permissionRequest', requestId: 'zzzzz', toolName: 'Bash', description: 'run', inputPreview: 'ls' })
    // Held immediately (not denied synchronously)
    expect(cfdNotReady.frames.some(f => f.type === 'permissionVerdict')).toBe(false)
    await tick(70)
    expect(cfdNotReady.frames.at(-1)).toEqual({ type: 'permissionVerdict', requestId: 'zzzzz', behavior: 'deny', reason: 'swarm_not_ready' })
  })

  test('slash commands: /switch, /spawn, skills rejected in cfd:general; /list, /kill (closes sockets), /broadcast, autocomplete scoped', async () => {
    const w = await setupSwarmWorld()
    const cfd1 = w.connect('claude@mac:cfd-1', 'cfd', 'c1')
    const def1 = w.connect('claude@mac:def-1', 'agents', 'd1')
    _setRegisteredSkillsForTest(['deploy-skill'])

    const slashDeps: SlashCommandDeps = {
      sessions: w.deps.sessions,
      history: w.deps.history,
      startedAt: Date.now() - 10_000,
      channelSwarm: id => w.swarmChannels.channelSwarm(id),
      isSwarmConfigured: () => w.swarmConfig.isConfigured(),
    }

    function makeInteraction(commandName: string, channelId: string, opts: Record<string, string> = {}) {
      const replies: string[] = []
      return {
        replies,
        interaction: {
          commandName,
          channelId,
          user: { id: 'mick-123', username: 'mick' },
          options: { getString: (k: string) => opts[k] ?? null },
          reply: async (p: { content?: string }) => { replies.push(p.content ?? '') },
        } as unknown as Parameters<typeof handleSlashCommand>[0],
      }
    }

    // /switch, /spawn, and skill rejected in cfd:general
    const sw = makeInteraction('switch', w.cfdGeneral!, { session: 'claude@mac:def-1' })
    await handleSlashCommand(sw.interaction, slashDeps)
    expect(sw.replies[0]).toContain('only available in default')

    const sp = makeInteraction('spawn', w.cfdGeneral!)
    await handleSlashCommand(sp.interaction, slashDeps)
    expect(sp.replies[0]).toContain('only available in default')

    const sk = makeInteraction('deploy-skill', w.cfdGeneral!)
    await handleSlashCommand(sk.interaction, slashDeps)
    expect(sk.replies[0]).toContain('only available in default')

    // /list in cfd:general lists cfd1 only
    const ls = makeInteraction('list', w.cfdGeneral!)
    await handleSlashCommand(ls.interaction, slashDeps)
    expect(ls.replies[0]).toContain('claude@mac:cfd-1')
    expect(ls.replies[0]).not.toContain('claude@mac:def-1')

    // Autocomplete in cfd:general: /switch returns [], /kill returns ['all', 'claude@mac:cfd-1']
    const autoResults: unknown[] = []
    handleAutocomplete({
      commandName: 'switch',
      channelId: w.cfdGeneral!,
      options: { getFocused: () => ({ name: 'session', value: '' }) },
      respond: async (r: unknown) => { autoResults.push(r) },
    } as unknown as Parameters<typeof handleAutocomplete>[0], slashDeps)
    handleAutocomplete({
      commandName: 'kill',
      channelId: w.cfdGeneral!,
      options: { getFocused: () => ({ name: 'session', value: '' }) },
      respond: async (r: unknown) => { autoResults.push(r) },
    } as unknown as Parameters<typeof handleAutocomplete>[0], slashDeps)
    expect(autoResults[0]).toEqual([])
    expect(autoResults[1]).toEqual([
      { name: 'all', value: 'all' },
      { name: 'claude@mac:cfd-1', value: 'claude@mac:cfd-1' },
    ])

    // /broadcast in cfd:general hits cfd1 only
    const bc = makeInteraction('broadcast', w.cfdGeneral!, { message: 'cfd-only-msg' })
    await handleSlashCommand(bc.interaction, slashDeps)
    expect(cfd1.frames.some(f => f.type === 'message' && f.content === 'cfd-only-msg')).toBe(true)
    expect(def1.frames.some(f => f.type === 'message' && f.content === 'cfd-only-msg')).toBe(false)

    // /kill in cfd:general cannot kill def1, CAN kill cfd1 and CLOSES its socket!
    const killDef = makeInteraction('kill', w.cfdGeneral!, { session: 'claude@mac:def-1' })
    await handleSlashCommand(killDef.interaction, slashDeps)
    expect(killDef.replies[0]).toContain('not found')
    expect(def1.isClosed()).toBe(false)

    const killCfd = makeInteraction('kill', w.cfdGeneral!, { session: 'claude@mac:cfd-1' })
    await handleSlashCommand(killCfd.interaction, slashDeps)
    expect(cfd1.isClosed()).toBe(true)
    expect(w.deps.sessions.getSessions().map(s => s.name)).toEqual(['claude@mac:def-1'])

    _setRegisteredSkillsForTest([])
  })

  test('B2, M3, m1, m2, m4: no-config back-compat (permission no-chat, /kill, channelArchive on BUS_CHANNEL, button) and pre-fetch topic swarm_not_ready', async () => {
    // Unconfigured world with chatId: () => null
    const env = new FakeEnv()
    const defCat = env.addChan({ id: 'cat-def', name: 'General', type: ChannelType.GuildCategory })
    const busCh = env.addChan({ id: 'ch-bus', name: 'general', parentId: defCat.id })
    const swarmConfig = SwarmConfig.inStateDir(env.dir)
    const sessions = new SessionManager()
    const history = new ProjectHistory(env.dir)
    const subs = new Subscriptions()
    const swarmChannels = new SwarmChannels({
      config: swarmConfig,
      client: env.asClient() as unknown as ChannelClientLike,
      busChannelId: busCh.id,
      subs,
      knownSwarm: () => 'default',
    })
    const channelOps = swarmChannels.createChannelOps(async () => env.asGuildLike())
    const deps: WsDeps = {
      sessions,
      history,
      client: env.asClient() as unknown as WsDeps['client'],
      chatId: () => null,
      chunkLimit: 2000,
      chunkMode: 'length',
      replyToMode: 'first',
      busChannelId: busCh.id,
      subs,
      channelOps,
      swarmConfig,
      swarmChannels,
    }
    const handlers = createWsHandlers(deps)
    const frames: Record<string, unknown>[] = []
    let closed = false
    const ws: WsLike = {
      data: { sessionName: null, sendCallback: null },
      send(raw) { frames.push(JSON.parse(raw)) },
      close() { closed = true },
    }
    handlers.message(ws, JSON.stringify({ type: 'register', name: 'claude@mac:nocfg', projectPath: '/p', instanceId: 'nc-1' }))
    const reg = frames.find(f => f.type === 'registered')
    expect(reg?.swarmConfigured).toBeUndefined()

    // B2: Permission request with NO active chat and NO config -> silent return (NO deny verdict!)
    handlers.message(ws, JSON.stringify({
      type: 'permissionRequest',
      requestId: 'nocfg',
      toolName: 'Bash',
      description: 'run',
      inputPreview: 'ls',
    }))
    await tick()
    expect(frames.some(f => f.type === 'permissionVerdict')).toBe(false)

    // m1: channelArchive on BUS_CHANNEL with NO config -> success: true with legacy note
    handlers.message(ws, JSON.stringify({ type: 'channelArchive', requestId: 'arch-bus', channel: busCh.id }))
    await tick()
    const archRes = frames.find(f => f.type === 'toolResult' && f.requestId === 'arch-bus')
    expect(archRes?.success).toBe(true)
    expect(String(archRes?.data)).toContain('default bus channel: every session always receives it')

    // M3: /kill with NO config deregisters session without closing the socket
    const replies: string[] = []
    await handleSlashCommand({
      commandName: 'kill',
      channelId: busCh.id,
      user: { id: 'mick-123', username: 'mick' },
      options: { getString: () => 'claude@mac:nocfg' },
      reply: async (p: { content?: string }) => { replies.push(p.content ?? '') },
    } as unknown as Parameters<typeof handleSlashCommand>[0], {
      sessions,
      history,
      startedAt: Date.now(),
      isSwarmConfigured: () => swarmConfig.isConfigured(),
    })
    expect(closed).toBe(false)
    expect(sessions.getSessions()).toHaveLength(0)

    // B2 (configured default swarm with no active chat): ALSO keeps silent return
    const wDefNoChat = await setupSwarmWorld({ extraDeps: { chatId: () => null } })
    const def1 = wDefNoChat.connect('claude@mac:def-nc', 'agents', 'd-nc')
    def1.send({ type: 'permissionRequest', requestId: 'defnc', toolName: 'Bash', description: 'run', inputPreview: 'ls' })
    await tick()
    expect(def1.frames.some(f => f.type === 'permissionVerdict')).toBe(false)

    // m2: handlePermissionButton without allowFrom (no-config path) still honours button click
    const wPerm = await setupSwarmWorld()
    const cfdPerm = wPerm.connect('claude@mac:cfd-p', 'cfd', 'cp1')
    cfdPerm.send({ type: 'permissionRequest', requestId: 'allow', toolName: 'Bash', description: 'run', inputPreview: 'ls' })
    await tick()
    const allowMsg = wPerm.env.sentByChan.get(wPerm.cfdHuman!)!.find(m => m.content.includes('Permission Request'))
    const allowYesId = extractButtonCustomIds(allowMsg).find(id => id.startsWith('perm_yes_'))!
    expect(handlePermissionButton(allowYesId, 'anyone', undefined)).toBe(true)
    expect(cfdPerm.frames.at(-1)).toEqual({ type: 'permissionVerdict', requestId: 'allow', behavior: 'allow' })

    // m4: configured topic post BEFORE initialFetchDone reports swarm_not_ready instead of silent empty fan-out
    const routingErrors: string[] = []
    const wPreFetch = await setupSwarmWorld({
      ready: false,
      extraDeps: { onRoutingError: err => routingErrors.push(err) },
    })
    wPreFetch.connect('claude@mac:def-sub', 'agents', 'ds1')
    wPreFetch.deps.subs!.add('claude@mac:def-sub', wPreFetch.defTopic.id)
    const delivered = routeHumanBusMessage(
      'hello topic',
      { chat_id: wPreFetch.defTopic.id, message_id: 'm-pre', from_human: 'true' },
      wPreFetch.deps.sessions,
      channelSubscribers(wPreFetch.deps, wPreFetch.defTopic.id),
      wPreFetch.deps,
    )
    expect(delivered).toEqual([])
    expect(routingErrors).toEqual(['swarm_not_ready'])
  })

  test('impl-plan-v2 #31-1: /kill sends killed + closes sockets + full cleanup when configured; no-config preserves deregister without closing', async () => {
    const envDir = tempDir()
    const agentChannels = new AgentChannels(envDir)
    const w = await setupSwarmWorld({ extraDeps: { agentChannels } })
    const frames: Record<string, unknown>[] = []
    let closed = false
    const ws: WsLike = {
      data: { sessionName: null, sendCallback: null },
      send(raw) { frames.push(JSON.parse(raw)) },
      close() { closed = true },
    }
    // Register pull-mode session in cfd with a pending permission prompt
    w.handlers.message(ws, JSON.stringify({
      type: 'register', name: 'claude@mac:cfd-kill', swarm: 'cfd', mode: 'pull', projectPath: '/p', instanceId: 'k1',
    }))
    w.handlers.message(ws, JSON.stringify({
      type: 'permissionRequest', requestId: 'kperm', toolName: 'Bash', description: 'kill test', inputPreview: 'ls',
    }))
    await tick()
    const kMsg = w.env.sentByChan.get(w.cfdHuman!)!.find(m => m.content.includes('kill test'))
    const kYesId = extractButtonCustomIds(kMsg).find(id => id.startsWith('perm_yes_'))!
    expect(w.deps.swarmJournal!.get('claude@mac:cfd-kill')?.swarm).toBe('cfd')

    const replies: string[] = []
    await handleSlashCommand({
      commandName: 'kill',
      channelId: w.cfdGeneral!,
      user: { id: 'mick-123', username: 'mick' },
      options: { getString: () => 'claude@mac:cfd-kill' },
      reply: async (p: { content?: string }) => { replies.push(p.content ?? '') },
    } as unknown as Parameters<typeof handleSlashCommand>[0], {
      sessions: w.deps.sessions,
      history: w.deps.history,
      startedAt: Date.now(),
      channelSwarm: id => w.swarmChannels.channelSwarm(id),
      isSwarmConfigured: () => w.swarmConfig.isConfigured(),
      killSession: name => killSession(w.deps, name),
    })

    // Sent { type: 'killed', reconnect: false } before closing socket
    expect(frames.some(f => f.type === 'killed' && f.reconnect === false)).toBe(true)
    expect(closed).toBe(true)
    expect(w.deps.sessions.getSessions()).toHaveLength(0)
    // Pending permission prompt purged on /kill
    expect(handlePermissionButton(kYesId, 'mick-123', ['mick-123'])).toBe(false)
    // Journal cleaned up (no offline state besides direct channel which was never provisioned, or journal deleted)
    // Re-registering as push proves pullSessions was cleared (mode !== 'pull')
    const ws2 = w.connect('claude@mac:cfd-kill', 'cfd', 'k2')
    ws2.send({ type: 'agentStatus', requestId: 'st1', agent: 'claude@mac:cfd-kill' })
    // Check mode via status
    const st = JSON.parse(String(ws2.result('st1')?.data ?? '{}')) as { mode?: string }
    expect(st.mode).toBe('push')

    // No-config /kill: deregisters + cleans pullSessions/prompts WITHOUT sending killed or closing socket
    const ncEnv = new FakeEnv()
    const ncBus = ncEnv.addChan({ id: 'ch-nc-bus', name: 'general' })
    const ncConfig = SwarmConfig.absent()
    const ncSessions = new SessionManager()
    const ncDeps: WsDeps = {
      sessions: ncSessions,
      history: new ProjectHistory(ncEnv.dir),
      client: ncEnv.asClient() as unknown as WsDeps['client'],
      chatId: () => ncBus.id,
      chunkLimit: 2000,
      chunkMode: 'length',
      replyToMode: 'first',
      busChannelId: ncBus.id,
      swarmConfig: ncConfig,
    }
    const ncHandlers = createWsHandlers(ncDeps)
    const ncFrames: Record<string, unknown>[] = []
    let ncClosed = false
    const ncWs: WsLike = {
      data: { sessionName: null, sendCallback: null },
      send(raw) { ncFrames.push(JSON.parse(raw)) },
      close() { ncClosed = true },
    }
    ncHandlers.message(ncWs, JSON.stringify({ type: 'register', name: 'claude@mac:nc-pull', mode: 'pull', projectPath: '/p', instanceId: 'nc1' }))
    killSession(ncDeps, 'claude@mac:nc-pull')
    expect(ncClosed).toBe(false)
    expect(ncFrames.some(f => f.type === 'killed')).toBe(false)
    expect(ncSessions.getSessions()).toHaveLength(0)
  })

  test('impl-plan-v2 #31-2: unique promptId prevents collision, ws.close purges, delete-before-send, held prompt flushes on ready & purges on close', async () => {
    const w = await setupSwarmWorld()
    const cfd1 = w.connect('claude@mac:cfd-1', 'cfd', 'c1')
    const cfd2 = w.connect('claude@mac:cfd-2', 'cfd', 'c2')

    // Both send the SAME requestId 'same1'
    cfd1.send({ type: 'permissionRequest', requestId: 'same1', toolName: 'Bash', description: 'from-cfd1', inputPreview: 'echo 1' })
    cfd2.send({ type: 'permissionRequest', requestId: 'same1', toolName: 'Bash', description: 'from-cfd2', inputPreview: 'echo 2' })
    await tick()

    const sent = w.env.sentByChan.get(w.cfdHuman!)!
    const msg1 = sent.find(m => m.content.includes('from-cfd1'))!
    const msg2 = sent.find(m => m.content.includes('from-cfd2'))!
    const yes1 = extractButtonCustomIds(msg1).find(id => id.startsWith('perm_yes_'))!
    const no2 = extractButtonCustomIds(msg2).find(id => id.startsWith('perm_no_'))!
    expect(yes1).not.toBe(no2.replace('perm_no_', 'perm_yes_'))

    // Click button 1 -> ONLY cfd1 gets allow
    expect(handlePermissionButton(yes1, 'mick-123', ['mick-123'])).toBe(true)
    expect(cfd1.frames.at(-1)).toEqual({ type: 'permissionVerdict', requestId: 'same1', behavior: 'allow' })
    expect(cfd2.frames.some(f => f.type === 'permissionVerdict')).toBe(false)

    // Close cfd2 BEFORE clicking button 2 -> purged, button click returns false (Expired)
    w.handlers.close(cfd2.ws)
    expect(handlePermissionButton(no2, 'mick-123', ['mick-123'])).toBe(false)

    // Delete-before-send: throwing ws.send deletes record and returns false (no leak)
    let shouldThrow = false
    const throwFrames: Record<string, unknown>[] = []
    const throwWs: WsLike = {
      data: { sessionName: null, sendCallback: null },
      send(raw) {
        if (shouldThrow) throw new Error('socket dead')
        throwFrames.push(JSON.parse(raw))
      },
    }
    w.handlers.message(throwWs, JSON.stringify({ type: 'register', name: 'claude@mac:cfd-throw', swarm: 'cfd', projectPath: '/p', instanceId: 'ct1' }))
    w.handlers.message(throwWs, JSON.stringify({ type: 'permissionRequest', requestId: 'thr1', toolName: 'Bash', description: 'throw-test', inputPreview: 'ls' }))
    await tick()
    const throwMsg = w.env.sentByChan.get(w.cfdHuman!)!.find(m => m.content.includes('throw-test'))!
    const throwYes = extractButtonCustomIds(throwMsg).find(id => id.startsWith('perm_yes_'))!
    shouldThrow = true
    expect(handlePermissionButton(throwYes, 'mick-123', ['mick-123'])).toBe(false)
    shouldThrow = false
    // Record was already deleted before ws.send threw, so a retry also returns false!
    expect(handlePermissionButton(throwYes, 'mick-123', ['mick-123'])).toBe(false)

    // Held prompt flushes cleanly when swarm becomes ready before hold timeout
    const wHold = await setupSwarmWorld({ ready: false, extraDeps: { permissionHoldMs: 5_000 } })
    const cfdHold = wHold.connect('claude@mac:cfd-hold', 'cfd', 'ch1')
    const cfdHoldClose = wHold.connect('claude@mac:cfd-hold-close', 'cfd', 'ch2')
    cfdHold.send({ type: 'permissionRequest', requestId: 'h1', toolName: 'Bash', description: 'held-flush', inputPreview: 'ls' })
    cfdHoldClose.send({ type: 'permissionRequest', requestId: 'h2', toolName: 'Bash', description: 'held-close', inputPreview: 'ls' })
    // Close second socket while held -> purged silently
    wHold.handlers.close(cfdHoldClose.ws)
    await wHold.swarmChannels.onClientReady(wHold.env.asGuildLike())
    flushHeldPermissionsForSwarm('cfd')
    await tick()
    const cfdHoldHuman = wHold.swarmChannels.humanChannelId('cfd')!
    const flushedMsgs = wHold.env.sentByChan.get(cfdHoldHuman) ?? []
    expect(flushedMsgs.some(m => m.content.includes('held-flush'))).toBe(true)
    expect(flushedMsgs.some(m => m.content.includes('held-close'))).toBe(false)
    const flushedYes = extractButtonCustomIds(flushedMsgs.find(m => m.content.includes('held-flush'))!).find(id => id.startsWith('perm_yes_'))!
    expect(handlePermissionButton(flushedYes, 'mick-123', ['mick-123'])).toBe(true)
    expect(cfdHold.frames.at(-1)).toEqual({ type: 'permissionVerdict', requestId: 'h1', behavior: 'allow' })
  })

  test('impl-plan-v2 #31-3 & #31-4: oneHumanTarget skips dispatcher/channelOwners when default has candidates; releaseClaim rejects cross-swarm handoff even for crossSwarm', async () => {
    // #31-3a: default has candidates -> dispatcher and channelOwners are NOT used as oneHumanTarget
    const cfgWithDefCand = SwarmConfig.fromObject({
      default: { candidates: [{ alias: 'claude@mac:def-master', priority: 1 }] },
      swarms: { cfd: {} },
    })
    const wCand = await setupSwarmWorld({
      extraDeps: {
        swarmConfig: cfgWithDefCand,
        dispatcher: 'claude@mac:def-dispatcher',
        channelOwners: new Map([['ch-def-topic', 'claude@mac:def-owner']]),
      },
    })
    wCand.connect('claude@mac:def-dispatcher', 'agents', 'dd1')
    wCand.connect('claude@mac:def-worker', 'agents', 'dw1')
    const deliveredWithCand = routeHumanBusMessage(
      'untargeted question',
      { chat_id: wCand.busCh.id, message_id: 'm-cand-1', from_human: 'true' },
      wCand.deps.sessions,
      undefined,
      wCand.deps,
      'default',
    )
    // Falls through to all live interactive sessions in default (both dispatcher and worker), NOT just dispatcher!
    expect(deliveredWithCand.sort()).toEqual(['claude@mac:def-dispatcher', 'claude@mac:def-worker'])

    // #31-3b: default has NO candidates -> dispatcher IS still used
    const wNoCand = await setupSwarmWorld()
    wNoCand.connect('claude@mac:def-dispatcher', 'agents', 'dd2')
    wNoCand.connect('claude@mac:def-worker', 'agents', 'dw2')
    const deliveredNoCand = routeHumanBusMessage(
      'untargeted question',
      { chat_id: wNoCand.busCh.id, message_id: 'm-nocand-1', from_human: 'true' },
      wNoCand.deps.sessions,
      undefined,
      wNoCand.deps,
      'default',
    )
    expect(deliveredNoCand).toEqual(['claude@mac:def-dispatcher'])

    // #31-4: releaseClaim(to=...) rejects cross-swarm handoff even when caller or target is crossSwarm!
    const cfd1 = wNoCand.connect('claude@mac:cfd-1', 'cfd', 'c1')
    const cfd2 = wNoCand.connect('claude@mac:cfd-2', 'cfd', 'c2')
    const ops = wNoCand.connect('claude@mac:ops', 'agents', 'o1') // crossSwarm!
    cfd1.send({ type: 'claim', requestId: 'cl-cfd', task: 'mesh' })
    ops.send({ type: 'claim', requestId: 'cl-ops', task: 'ops-task' })
    // cfd1 -> ops (target is crossSwarm, in default): REJECTED!
    cfd1.send({ type: 'releaseClaim', requestId: 'rc-to-ops', task: 'mesh', to: 'claude@mac:ops' })
    // ops -> cfd1 (caller is crossSwarm, target in cfd): REJECTED!
    ops.send({ type: 'releaseClaim', requestId: 'rc-from-ops', task: 'ops-task', to: 'claude@mac:cfd-1' })
    // cfd1 -> cfd2 (same swarm): SUCCEEDS!
    cfd1.send({ type: 'releaseClaim', requestId: 'rc-same', task: 'mesh', to: 'claude@mac:cfd-2' })
    await tick()
    expect(cfd1.result('rc-to-ops')?.success).toBe(false)
    expect(String(cfd1.result('rc-to-ops')?.data)).toContain('cross_swarm')
    expect(ops.result('rc-from-ops')?.success).toBe(false)
    expect(String(ops.result('rc-from-ops')?.data)).toContain('cross_swarm')
    expect(cfd1.result('rc-same')?.success).toBe(true)
  })

  test('Carbon re-review #31-2: bus_rename migrates heldPermissions and pendingPermissions so flush delivers and /kill purges', async () => {
    // Part 1: Held prompt survives bus_rename while cfd is provisioning and flushes under the new name!
    const wHold = await setupSwarmWorld({ ready: false, extraDeps: { permissionHoldMs: 5_000 } })
    const seat = wHold.connect('claude@mac:cfd-before', 'cfd', 'r1')
    seat.send({ type: 'permissionRequest', requestId: 'ren1', toolName: 'Bash', description: 'held-across-rename', inputPreview: 'ls' })
    seat.send({ type: 'rename', requestId: 'rn-1', name: 'claude@mac:cfd-after' })
    expect(seat.frames.some(f => f.type === 'renamed' && f.newName === 'claude@mac:cfd-after')).toBe(true)

    await wHold.swarmChannels.onClientReady(wHold.env.asGuildLike())
    flushHeldPermissionsForSwarm('cfd')
    await tick()

    const cfdHum = wHold.swarmChannels.humanChannelId('cfd')!
    const flushedMsg = (wHold.env.sentByChan.get(cfdHum) ?? []).find(m => m.content.includes('held-across-rename'))
    expect(flushedMsg).toBeDefined()
    expect(flushedMsg!.content).toContain('**[claude@mac:cfd-after] Permission Request**')
    const yesBtn = extractButtonCustomIds(flushedMsg).find(id => id.startsWith('perm_yes_'))!

    // Part 2: Renaming a seat with a pending prompt, then /kill on the new name purges the pending prompt!
    seat.send({ type: 'rename', requestId: 'rn-2', name: 'claude@mac:cfd-final' })
    expect(seat.frames.some(f => f.type === 'renamed' && f.newName === 'claude@mac:cfd-final')).toBe(true)
    killSession(wHold.deps, 'claude@mac:cfd-final')
    expect(handlePermissionButton(yesBtn, 'mick-123', ['mick-123'])).toBe(false)
  })
})
