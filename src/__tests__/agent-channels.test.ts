import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentChannels, AGENT_CHANNEL_DELAY_MS, AGENT_CHANNEL_IDLE_MS, agentChannelSlug, agentChannelTopic } from '../agent-channels.js'
import type { AgentChannelOps, AgentChannelRegistration } from '../agent-channels.js'
import { Inboxes } from '../inboxes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { Subscriptions } from '../subscriptions.js'
import { channelSubscribers, createWsHandlers, directChannelOwner, onlineBusAgent, routeHumanBusMessage, type WsDeps, type WsLike } from '../ws.js'

const owner = 'codex@mac:study'
const observer = 'claude@mac:observer'
const now = 100_000
const registration = { name: owner, host: 'mac', kind: 'codex' }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function discordOperations() {
  const channels = new Map<string, AgentChannelRegistration>()
  const creates: AgentChannelRegistration[] = []
  const updates: { id: string; info: AgentChannelRegistration; archived: boolean }[] = []
  const ops: AgentChannelOps = {
    async ensure(info) {
      const found = [...channels].find(([, value]) => value.name === info.name)?.[0]
      if (found) return found
      creates.push(info)
      const id = 'direct-' + creates.length
      channels.set(id, info)
      return id
    },
    async update(id, info, archived) { updates.push({ id, info, archived }); channels.set(id, info) },
  }
  return { ops, creates, updates }
}

test('direct provisioning waits for continuous registration, persists, and applies renames in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-channels-'))
  const fake = discordOperations()
  try {
    const channels = new AgentChannels(dir)
    channels.register(registration, now)
    await channels.maintain(fake.ops, () => true, now + AGENT_CHANNEL_DELAY_MS - 1)
    expect(fake.creates).toEqual([])
    channels.disconnect(owner, now + AGENT_CHANNEL_DELAY_MS - 1)
    channels.register(registration, now + AGENT_CHANNEL_DELAY_MS)
    await channels.maintain(fake.ops, () => true, now + AGENT_CHANNEL_DELAY_MS + 1)
    expect(fake.creates).toEqual([])
    await channels.maintain(fake.ops, () => true, now + 2 * AGENT_CHANNEL_DELAY_MS)
    expect(fake.creates).toEqual([registration])
    expect(agentChannelSlug(owner)).toBe('a-codex-mac-study')
    expect(agentChannelTopic(registration)).toBe('Direct line to codex@mac:study (codex, mac)')
    const json = () => JSON.parse(readFileSync(join(dir, 'agent-channels.json'), 'utf8'))
    expect(json()).toEqual({ 'direct-1': owner })

    const renamed = 'codex@mac:new-study'
    const restarted = new AgentChannels(dir)
    restarted.register(registration, now + 180_000)
    restarted.rename(owner, renamed, now + 180_001)
    expect(json()).toEqual({ 'direct-1': renamed })
    await new AgentChannels(dir).maintain(fake.ops, () => true, now + 180_002)
    expect(fake.creates).toHaveLength(1)
    expect(fake.updates).toEqual([{ id: 'direct-1', info: expect.objectContaining({ name: renamed }), archived: false }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('archive keeps the binding and re-registration reactivates the same channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-archive-'))
  const fake = discordOperations()
  try {
    const channels = new AgentChannels(dir)
    channels.register(registration, now)
    const created = now + AGENT_CHANNEL_DELAY_MS
    await channels.maintain(fake.ops, () => true, created)
    channels.disconnect(owner, created)
    const restarted = new AgentChannels(dir)
    await restarted.maintain(fake.ops, () => false, created + AGENT_CHANNEL_IDLE_MS)
    expect(restarted.owner('direct-1')).toBe(owner)
    expect(fake.updates.at(-1)).toMatchObject({ id: 'direct-1', archived: true })
    restarted.register(registration, created + AGENT_CHANNEL_IDLE_MS + 1)
    await restarted.maintain(fake.ops, () => true, created + AGENT_CHANNEL_IDLE_MS + 1)
    expect(fake.updates.at(-1)).toMatchObject({ id: 'direct-1', archived: false })
    expect(fake.creates).toHaveLength(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the cap includes archived channels and a rename conflict leaves both bindings intact', async () => {
  const channels = new AgentChannels()
  const fake = discordOperations()
  for (let i = 0; i < 101; i++) channels.register({ name: 'candidate' + i }, now)
  await channels.maintain(fake.ops, () => true, now + AGENT_CHANNEL_DELAY_MS)
  expect(fake.creates).toHaveLength(100)
  channels.rename('candidate0', 'candidate1', now + AGENT_CHANNEL_DELAY_MS)
  expect(channels.owner('direct-1')).toBe('candidate0')
  expect(channels.owner('direct-2')).toBe('candidate1')
  expect(agentChannelSlug('x'.repeat(100)).length).toBe(92)
  expect(agentChannelSlug('codex@mac:study', true)).not.toBe(agentChannelSlug(owner))
})

function wsFixture(dir: string, extra: Partial<WsDeps> = {}) {
  const sends: { id: string; content: string }[] = []
  const deps: WsDeps = {
    sessions: new SessionManager(), history: new ProjectHistory(dir),
    inboxes: Inboxes.inStateDir(dir), agentChannels: new AgentChannels(dir), subs: new Subscriptions(),
    busChannelId: 'bus', humanChannelId: 'human-questions', dispatcher: observer,
    admins: new Set(['admin@mac']), channelOwners: new Map([['configured', 'owner@mac']]),
    client: { channels: { fetch: async (id: string) => ({
      isTextBased: () => true,
      send: async (message: { content: string }) => { sends.push({ id, content: message.content }); return { id: 'message' } },
    }) } } as unknown as WsDeps['client'],
    channelOps: {
      resolve: async ref => ({ id: ref, name: ref }),
      list: async () => [{ id: 'direct-1', name: 'a-codex-mac-study' }],
      create: async name => ({ id: name, name }),
    },
    chatId: () => null, replyToMode: 'first', chunkLimit: 2000, chunkMode: 'length', ...extra,
  }
  const h = createWsHandlers(deps)
  function register(name: string) {
    const frames: { type: string; requestId?: string; message?: string; success?: boolean; data?: string; content?: string }[] = []
    const ws: WsLike = { data: { sessionName: null, sendCallback: null }, send: raw => frames.push(JSON.parse(raw)) }
    const send = (frame: object) => h.message(ws, JSON.stringify(frame))
    send({ type: 'register', name, projectPath: '/' })
    return { frames, send, close: () => h.close(ws) }
  }
  return { deps, register, sends }
}

test('direct channel posts bypass the dispatcher, keep replies local and queue when the owner is offline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-route-'))
  try {
    const { deps, register, sends } = wsFixture(dir)
    const fake = discordOperations()
    const agent = register(owner)
    const dispatcher = register(observer)
    register(owner)
    register('admin@mac')
    register('owner@mac')
    register('human')
    const seen = Date.now() + AGENT_CHANNEL_DELAY_MS + 10
    await deps.agentChannels!.maintain(fake.ops, name => onlineBusAgent(deps, name), seen)
    expect(fake.creates.map(info => info.name)).toEqual([owner, observer])
    deps.subs!.add(observer, 'direct-1')
    expect(channelSubscribers(deps, 'direct-1')).toEqual([owner])
    const meta = { chat_id: 'direct-1', from_human: 'true', user: 'Mick' }
    expect(routeHumanBusMessage('status please', meta, deps.sessions, [observer], deps)).toEqual([owner])
    expect(agent.frames).toContainEqual(expect.objectContaining({ type: 'message', content: 'status please' }))
    expect(dispatcher.frames.some(frame => frame.type === 'message')).toBe(false)
    agent.send({ type: 'reply', text: 'my reply', chatId: 'direct-1', requestId: 'reply' })
    agent.send({ type: 'channelPost', text: 'private update', to: 'human', channel: 'direct-1', requestId: 'private' })
    dispatcher.send({ type: 'channelPost', text: 'wrong author', channel: 'direct-1', requestId: 'other' })
    dispatcher.send({ type: 'channelSubscribe', channel: 'direct-1', requestId: 'sub' })
    await tick()
    expect(sends).toEqual([
      { id: 'direct-1', content: '[codex@mac:study] my reply' },
      { id: 'direct-1', content: '**[codex@mac:study → human]** private update' },
    ])
    expect(dispatcher.frames.find(frame => frame.requestId === 'other')?.success).toBe(false)
    expect(dispatcher.frames.find(frame => frame.requestId === 'sub')?.data).toBe('direct_channel_managed')

    const overrides = { ...deps, channelOwners: new Map([['direct-1', observer]]) }
    expect(directChannelOwner(overrides, 'direct-1')).toBe(observer)
    expect(channelSubscribers(overrides, 'direct-1')).toEqual([observer])
    agent.close()
    expect(routeHumanBusMessage('@all stays here', meta, deps.sessions, [observer], deps)).toEqual([owner])
    expect(deps.inboxes!.list(owner).map(entry => entry.content)).toEqual(['@all stays here'])
    expect(dispatcher.frames.some(frame => frame.type === 'message')).toBe(false)
    expect(register(owner).frames).toContainEqual(expect.objectContaining({ type: 'message', content: '@all stays here' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('human-questions rejects agent posts without to=human and allows explicit human posts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'human-guard-'))
  try {
    const { register, sends } = wsFixture(dir)
    const agent = register(owner)
    agent.send({ type: 'channelPost', text: 'internal', channel: 'human-questions', to: observer, requestId: 'internal' })
    agent.send({ type: 'channelPost', text: 'passive', channel: 'human-questions', requestId: 'passive' })
    agent.send({ type: 'reply', text: 'raw reply', chatId: 'human-questions', requestId: 'raw' })
    await tick()
    for (const id of ['internal', 'passive', 'raw']) {
      expect(agent.frames.find(frame => frame.requestId === id)).toMatchObject({
        success: false, data: expect.stringContaining('topic channel or #general'),
      })
    }
    expect(sends).toEqual([])
    agent.send({ type: 'channelPost', text: 'explicit human', channel: 'human-questions', to: 'human', requestId: 'human' })
    agent.send({ type: 'busPost', text: 'general human', to: 'human', requestId: 'general' })
    await tick()
    expect(sends.map(send => send.id)).toEqual(['human-questions', 'human-questions'])
    expect(agent.frames.find(frame => frame.requestId === 'human')?.success).toBe(true)
    expect(agent.frames.find(frame => frame.requestId === 'general')?.success).toBe(true)

    const sameChannel = wsFixture(dir, { busChannelId: 'human-questions' })
    const legacy = sameChannel.register(owner)
    legacy.send({ type: 'busPost', text: 'must not render', requestId: 'bus-guard' })
    expect(legacy.frames.find(frame => frame.requestId === 'bus-guard')).toMatchObject({ success: false })
    expect(sameChannel.sends).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
