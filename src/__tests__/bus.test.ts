import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { createWsHandlers, resetBusRateLimit, routeHumanBusMessage } from '../ws.js'
import { CostClasses, HumanMail, Unread } from '../wake.js'
import { Subscriptions } from '../subscriptions.js'
import { NodeRegistry } from '../nodes.js'
import type { WsData, WsDeps } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface MockWs { data: WsData; send: ReturnType<typeof mock> }
const makeWs = (): MockWs => ({ data: { sessionName: null, sendCallback: null }, send: mock((_m: string) => {}) })
const msgs = (ws: MockWs) => ws.send.mock.calls.map(c => JSON.parse(String(c[0])))

let sessions: SessionManager
let history: ProjectHistory
let posted: string[]
let unread: Unread

function deps(extra: Partial<WsDeps> = {}): WsDeps {
  const channel = { isTextBased: () => true, send: mock(async (p: any) => { posted.push(typeof p === 'string' ? p : p.content); return { id: 'mid' } }) }
  return {
    sessions, history,
    client: { channels: { fetch: mock(async () => channel) } } as any,
    chatId: () => 'dm1', chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
    busChannelId: 'bus1', unread, ...extra,
  }
}

function register(h: ReturnType<typeof createWsHandlers>, name: string, secret?: string): MockWs {
  const ws = makeWs()
  h.message(ws as any, JSON.stringify({ type: 'register', name, projectPath: '/p/' + name, ...(secret && { secret }) }))
  return ws
}

beforeEach(async () => {
  sessions = new SessionManager()
  history = new ProjectHistory(await mkdtemp(join(tmpdir(), 'bus-test-')))
  posted = []
  unread = new Unread()
  resetBusRateLimit()
})

describe('router secret', () => {
  test('rejects register with wrong secret and blocks other calls', () => {
    const h = createWsHandlers(deps({ secret: 's3cret' }))
    const ws = register(h, 'claude@mac:src', 'nope')
    expect(ws.data.sessionName).toBeNull()
    expect(msgs(ws)[0].message).toContain('register rejected')
    h.message(ws as any, JSON.stringify({ type: 'busPost', text: 'hi' }))
    expect(msgs(ws)[1].message).toContain('Not authenticated')
  })
  test('accepts the right secret', () => {
    const h = createWsHandlers(deps({ secret: 's3cret' }))
    const ws = register(h, 'claude@mac:src', 's3cret')
    expect(ws.data.sessionName).toBe('claude@mac:src')
  })
})

describe('busPost', () => {
  test('untargeted busPost is mirrored and wakes nobody', async () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    const c = register(h, 'agy@nas642:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'hello all' }))
    await new Promise(r => setTimeout(r, 20))
    expect(msgs(b).some(x => x.type === 'message')).toBe(false)
    expect(msgs(c).some(x => x.type === 'message')).toBe(false)
    expect(unread.count('codex@nas642:src')).toBe(1)
    expect(unread.count('agy@nas642:src')).toBe(1)
    expect(unread.count('claude@mac:src')).toBe(0)
    expect(posted[0]).toContain('[claude@mac:src → all]')
  })

  test('targets one session by exact name and rejects a prefix', async () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    const c = register(h, 'codex-photos@nas642:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'x', to: 'codex-photos@nas642:src' }))
    await new Promise(r => setTimeout(r, 20))
    expect(msgs(c).some(x => x.type === 'message' && x.content === 'x')).toBe(true)
    expect(msgs(c).find(x => x.type === 'message').meta.message_id).toBe('mid')
    expect(msgs(b).some(x => x.type === 'message')).toBe(false)
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'y', to: 'codex' }))
    expect(msgs(a).at(-1).message).toContain('not an exact session name')
    expect(msgs(a).at(-1).message).toContain('codex@nas642:src')
    expect(msgs(b).some(x => x.content === 'y')).toBe(false)
    expect(msgs(c).some(x => x.content === 'y')).toBe(false)
  })

  test('errors on unknown target', () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'x', to: 'nobody' }))
    expect(msgs(a).at(-1).message).toContain('No session named "nobody"')
  })

  test('reply on the bus channel without a target wakes nobody', async () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    h.message(a as any, JSON.stringify({ type: 'reply', text: 'via reply', chatId: 'bus1' }))
    await new Promise(r => setTimeout(r, 20))
    expect(msgs(b).some(x => x.type === 'message')).toBe(false)
    expect(unread.count('codex@nas642:src')).toBe(1)
    expect(posted.some(p => p.includes('via reply'))).toBe(true)
  })

  test('rate limit', () => {
    const h = createWsHandlers(deps({ busMaxPerMinute: 2 }))
    const a = register(h, 'claude@mac:rl')
    register(h, 'codex@nas642:rl')
    for (let i = 0; i < 3; i++) h.message(a as any, JSON.stringify({ type: 'busPost', text: 'x' + i }))
    expect(msgs(a).at(-1).message).toContain('rate limit')
  })

  test('listSessions returns names', () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    register(h, 'agy@nas642:src')
    h.message(a as any, JSON.stringify({ type: 'listSessions', requestId: 'r1' }))
    const res = msgs(a).find(x => x.type === 'toolResult')
    expect(JSON.parse(res.data).map((s: any) => s.name)).toEqual(['claude@mac:src', 'agy@nas642:src'])
  })
})

describe('human bus messages', () => {
  test('exact @name targets one session; untargeted human mail wakes only the dispatcher', () => {
    const d = deps({ dispatcher: 'codex@nas642:src' })
    const h = createWsHandlers(d)
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    const c = register(h, 'agy@nas642:src')
    expect(routeHumanBusMessage('@codex@nas642:src do the thing', { user: 'me', from_human: 'true' }, sessions, undefined, d)).toEqual(['codex@nas642:src'])
    expect(msgs(b).find(x => x.type === 'message').content).toBe('do the thing')
    expect(msgs(b).find(x => x.type === 'message').meta.from_human).toBe('true')
    expect(msgs(a).some(x => x.type === 'message')).toBe(false)
    expect(routeHumanBusMessage('yes', { user: 'me', from_human: 'true', message_id: 'q9' }, sessions, undefined, d)).toEqual(['codex@nas642:src'])
    expect(msgs(c).some(x => x.type === 'message')).toBe(false)
    expect(routeHumanBusMessage('@codex which one', { user: 'me', from_human: 'true' }, sessions, undefined, d)).toEqual([])
    expect(msgs(b).filter(x => x.content === 'which one')).toHaveLength(0)
    expect(msgs(c).some(x => x.type === 'message')).toBe(false)
    expect(routeHumanBusMessage('11: no', { user: 'me', from_human: 'true', message_id: 'q11' }, sessions, undefined, d)).toEqual(['codex@nas642:src'])
    const eleven = msgs(b).find(x => x.content === '11: no')
    expect(eleven.meta.from_human).toBe('true')
    expect(msgs(a).some(x => x.content === '11: no')).toBe(false)
    expect(msgs(c).some(x => x.content === '11: no')).toBe(false)
    const errors: string[] = []
    const worded = deps({ dispatcher: 'codex@nas642:src', onRoutingError: (m) => errors.push(m) })
    expect(routeHumanBusMessage('claude look at the latch', { user: 'me', from_human: 'true' }, sessions, undefined, worded)).toEqual(['codex@nas642:src'])
    expect(msgs(a).some(x => x.content === 'claude look at the latch')).toBe(false)
    expect(routeHumanBusMessage('codex: restart yourself', { user: 'me', from_human: 'true' }, sessions, undefined, worded)).toEqual([])
    expect(errors.at(-1)).toContain('not an exact session name')
    expect(msgs(b).some(x => x.content === 'restart yourself')).toBe(false)
  })

  test('with no dispatcher, a human post wakes live push sessions and skips headless agents', () => {
    const nodes = new NodeRegistry()
    const notes: string[] = []
    const d = deps({ nodes, onRouteNote: (m) => notes.push(m) })
    const h = createWsHandlers(d)
    const push = register(h, 'claude@mac:src')
    const pull = makeWs()
    h.message(pull as any, JSON.stringify({ type: 'register', name: 'pull@mac:src', projectPath: '/p', mode: 'pull' }))
    const nodeWs = makeWs()
    h.message(nodeWs as any, JSON.stringify({ type: 'registerNode', node: 'nas', agents: [{ name: 'headless@nas:src', kind: 'codex' }] }))
    const woken = routeHumanBusMessage('status?', { user: 'mick', from_human: 'true', message_id: 'q' }, sessions, undefined, d)
    expect(woken).toEqual(['claude@mac:src'])
    const got = msgs(push).find(x => x.type === 'message')
    expect(got.content).toBe('status?')
    expect(got.meta.from_human).toBe('true')
    expect(got.meta.routed).toBe('interactive')
    expect(msgs(pull).some(x => x.type === 'message')).toBe(false)
    expect(msgs(nodeWs).some(x => x.type === 'wake')).toBe(false)
    expect(notes.at(-1)).toContain('routed to claude@mac:src')
    expect(notes.at(-1)).toContain('no dispatcher')

    const onlyHeadless = new NodeRegistry()
    const quiet: string[] = []
    const d2 = deps({ nodes: onlyHeadless, onRouteNote: (m) => quiet.push(m) })
    const h2 = createWsHandlers(d2)
    const node2 = makeWs()
    h2.message(node2 as any, JSON.stringify({ type: 'registerNode', node: 'nas', agents: [{ name: 'headless@nas:src', kind: 'codex' }] }))
    sessions.deregisterSession('claude@mac:src')
    sessions.deregisterSession('pull@mac:src')
    expect(routeHumanBusMessage('status?', { user: 'mick', from_human: 'true' }, sessions, undefined, d2)).toEqual([])
    expect(msgs(node2).some(x => x.type === 'wake')).toBe(false)
    expect(quiet[0]).toContain('not routed')
    expect(quiet[0]).toContain('Headless')

    const none: string[] = []
    const d3 = deps({ onRouteNote: (m) => none.push(m) })
    expect(routeHumanBusMessage('hello', { user: 'mick', from_human: 'true' }, new SessionManager(), undefined, d3)).toEqual([])
    expect(none[0]).toContain('no agent sessions are connected')
  })

  test('a Discord reply that names a session wakes that session, not the dispatcher', () => {
    const d = deps({ dispatcher: 'codex@nas642:src' })
    const h = createWsHandlers(d)
    register(h, 'codex@nas642:src')
    const agy = register(h, 'agy@nas642:src')
    const woken = routeHumanBusMessage('@agy@nas642:src do this', { user: 'mick', from_human: 'true', unbound_reply: 'hm1', message_id: 'r1' }, sessions, undefined, d)
    expect(woken).toEqual(['agy@nas642:src'])
    const got = msgs(agy).find(x => x.type === 'message')
    expect(got.content).toBe('do this')
    expect(got.meta.from_human).toBe('true')
    expect(got.meta.question_id).toBe('hm1')
  })

  test('an incomplete @all token does not fan out', () => {
    const errors: string[] = []
    const d = deps({ onRoutingError: (m) => errors.push(m) })
    const h = createWsHandlers(d)
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    expect(routeHumanBusMessage('@all-team@mac:src do this', { user: 'mick', from_human: 'true' }, sessions, undefined, d)).toEqual([])
    expect(routeHumanBusMessage('@all:synthesiz compare', { user: 'mick', from_human: 'true' }, sessions, undefined, d)).toEqual([])
    expect(msgs(a).some(x => x.type === 'message')).toBe(false)
    expect(msgs(b).some(x => x.type === 'message')).toBe(false)
    expect(errors).toHaveLength(2)
  })

  test('dispatch re-delivers the original human message and only the dispatcher may call it', async () => {
    const humanMail = new HumanMail()
    const d = deps({ dispatcher: 'codex@nas642:src', humanMail })
    const h = createWsHandlers(d)
    const claude = register(h, 'claude@mac:src')
    const dispatcher = register(h, 'codex@nas642:src')
    const agy = register(h, 'agy@nas642:src')
    routeHumanBusMessage('fix the router', { user: 'mick', from: 'mick', from_human: 'true', message_id: 'm1', chat_id: 'bus1' }, sessions, undefined, d)
    expect(msgs(dispatcher).find(x => x.type === 'message').content).toBe('fix the router')
    expect(msgs(agy).some(x => x.type === 'message')).toBe(false)

    h.message(claude as any, JSON.stringify({ type: 'dispatch', requestId: 'no', messageId: 'm1', to: ['agy@nas642:src'] }))
    expect(msgs(claude).at(-1).success).toBe(false)
    expect(msgs(agy).some(x => x.type === 'message')).toBe(false)

    h.message(dispatcher as any, JSON.stringify({ type: 'dispatch', requestId: 'bad', messageId: 'm1', to: ['agy'] }))
    expect(msgs(dispatcher).at(-1).success).toBe(false)
    expect(String(msgs(dispatcher).at(-1).data)).toContain('not an exact session name')
    expect(msgs(agy).some(x => x.type === 'message')).toBe(false)

    h.message(dispatcher as any, JSON.stringify({ type: 'dispatch', requestId: 'ok', messageId: 'm1', to: ['agy@nas642:src'] }))
    const res = msgs(dispatcher).find(x => x.requestId === 'ok')
    expect(res.success).toBe(true)
    const got = msgs(agy).find(x => x.type === 'message')
    expect(got.content).toBe('fix the router')
    expect(got.meta.from_human).toBe('true')
    expect(got.meta.question_id).toBe('m1')
    expect(got.meta.from).toBe('mick')
    expect(got.meta.routed).toBe('dispatch')
    expect(msgs(claude).some(x => x.content === 'fix the router')).toBe(false)
    await new Promise(r => setTimeout(r, 20))
    expect(posted.some(p => p.includes('routed to agy@nas642:src'))).toBe(true)
  })

  test('when the dispatcher is offline, the channel owner gets the original human message', () => {
    const d = deps({ dispatcher: 'offline@nowhere', channelOwners: new Map([['bus1', 'agy@nas642:src']]) })
    const h = createWsHandlers(d)
    register(h, 'claude@mac:src')
    const owner = register(h, 'agy@nas642:src')
    const woken = routeHumanBusMessage('yes', { user: 'mick', from_human: 'true', chat_id: 'bus1', message_id: 'q1' }, sessions, undefined, d)
    expect(woken).toEqual(['agy@nas642:src'])
    const got = msgs(owner).find(x => x.type === 'message')
    expect(got.content).toBe('yes')
    expect(got.meta.from_human).toBe('true')
    expect(got.meta.message_id).toBe('q1')
  })
})

describe('to human', () => {
  test('posts to channel without fan-out', async () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'status: done', to: 'human' }))
    await new Promise(r => setTimeout(r, 10))
    expect(msgs(b).some(x => x.type === 'message')).toBe(false)
    expect(posted[0]).toContain('[claude@mac:src → human]')
  })
})

describe('channels', () => {
  const { Subscriptions } = require('../subscriptions.js')
  function chDeps(subs: any) {
    const chans = [{ id: 'bus1', name: 'general' }, { id: 'c2', name: 'photos-debug', topic: 't' }]
    return deps({
      subs,
      channelOps: {
        resolve: async (r: string) => chans.find(c => c.id === r || c.name === r.replace(/^#/, '')) ?? null,
        list: async () => chans,
        create: async (name: string) => { const c = { id: 'c3', name }; chans.push(c); return c },
      },
    })
  }
  const tick = () => new Promise(r => setTimeout(r, 10))

  test('channel_post is mirrored to subscribers and does not wake them', async () => {
    const subs = new Subscriptions()
    const h = createWsHandlers(chDeps(subs))
    const a = register(h, 'claude@mac:src'), b = register(h, 'codex@nas642'), c = register(h, 'agy@mac:src')
    subs.add('codex@nas642', 'c2')
    h.message(a as any, JSON.stringify({ type: 'channelPost', channel: '#photos-debug', text: 'hi' }))
    await tick()
    expect(msgs(b).some(x => x.type === 'message')).toBe(false)
    expect(msgs(c).some(x => x.type === 'message')).toBe(false)
    expect(unread.count('codex@nas642')).toBe(1)
    expect(unread.count('agy@mac:src')).toBe(0)
    expect(posted[0]).toContain('[claude@mac:src → subscribers]')
    expect(posted[0]).toContain('hi')
  })

  test('subscribe / list / unsubscribe / create', async () => {
    const subs = new Subscriptions()
    const h = createWsHandlers(chDeps(subs))
    const a = register(h, 'claude@mac:src')
    const res = (id: string) => msgs(a).find(x => x.type === 'toolResult' && x.requestId === id)
    h.message(a as any, JSON.stringify({ type: 'channelSubscribe', requestId: 's1', channel: 'photos-debug' }))
    await tick()
    expect(subs.has('claude@mac:src', 'c2')).toBe(true)
    h.message(a as any, JSON.stringify({ type: 'channelList', requestId: 'l1' }))
    await tick()
    const list = JSON.parse(res('l1').data)
    expect(list.find((c: any) => c.id === 'c2').subscribed).toBe(true)
    expect(list.find((c: any) => c.id === 'bus1').default).toBe(true)
    h.message(a as any, JSON.stringify({ type: 'channelUnsubscribe', requestId: 'u1', channel: 'c2' }))
    await tick()
    expect(subs.has('claude@mac:src', 'c2')).toBe(false)
    h.message(a as any, JSON.stringify({ type: 'channelCreate', requestId: 'k1', name: 'new-task', topic: 'x' }))
    await tick()
    expect(JSON.parse(res('k1').data).created).toBe(true)
    expect(subs.has('claude@mac:src', 'c3')).toBe(true)
  })

  test('untargeted human message wakes the dispatcher, not every subscriber', () => {
    const d = deps({ dispatcher: 'codex@nas642' })
    const h = createWsHandlers(d)
    register(h, 'claude@mac:src'); const b = register(h, 'codex@nas642'); const c = register(h, 'agy@mac:src')
    const out = routeHumanBusMessage('status?', { user: 'me', from_human: 'true', chat_id: 'c2' }, sessions, ['codex@nas642', 'agy@mac:src'], d)
    expect(out).toEqual(['codex@nas642'])
    const got = msgs(b).find(x => x.type === 'message')
    expect(got.content).toBe('status?')
    expect(got.meta.from_human).toBe('true')
    expect(got.meta.routed).toBe('dispatcher')
    expect(msgs(c).some(x => x.type === 'message')).toBe(false)
  })

  test('@all is explicit, cheap first, and synthesis does not paste earlier replies', () => {
    const costs = new CostClasses()
    costs.set('cheap@x', 'cheap')
    costs.set('premium@x', 'premium')
    const d = deps({ costs, staggerMs: 40 })
    const h = createWsHandlers(d)
    register(h, 'claude@mac:src')
    const cheap = register(h, 'cheap@x')
    const premium = register(h, 'premium@x')
    const woken = routeHumanBusMessage('@all compare', { user: 'me', from_human: 'true' }, sessions, undefined, d)
    expect(woken[0]).toBe('cheap@x')
    expect(woken).toEqual(['cheap@x', 'claude@mac:src', 'premium@x'])
    expect(msgs(cheap).find(x => x.type === 'message').content).toBe('compare')
    expect(msgs(premium).some(x => x.type === 'message')).toBe(false)
    const synth = routeHumanBusMessage('@all:synthesis compare', { user: 'me', from_human: 'true' }, sessions, undefined, d)
    expect(synth[0]).toBe('cheap@x')
    expect(msgs(cheap).filter(x => x.type === 'message').at(-1).content).toContain('synthesis: read this channel')
    expect(msgs(cheap).filter(x => x.type === 'message').at(-1).content).not.toContain('[claude')
  })

  test('legacy subscriptions follow a rename and a same-instance reclaim across router restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subs-reclaim-'))
    const subs = Subscriptions.inStateDir(dir)
    const d = chDeps(subs)
    const h = createWsHandlers(d)
    const ws = makeWs()
    const instanceId = 'same-instance'
    h.message(ws, JSON.stringify({ type: 'register', name: 'claude@mac:bbq-2', projectPath: '/p', instanceId }))
    h.message(ws, JSON.stringify({ type: 'channelSubscribe', requestId: 's', channel: 'photos-debug' }))
    await tick()
    expect(subs.subscribers('c2')).toEqual(['claude@mac:bbq-2'])
    h.message(ws, JSON.stringify({ type: 'rename', name: 'claude@mac:bbq-tmp' }))
    expect(subs.subscribers('c2')).toEqual(['claude@mac:bbq-tmp'])
    h.close(ws)

    const restarted = Subscriptions.inStateDir(dir)
    const next = createWsHandlers({ ...d, sessions: new SessionManager(), subs: restarted })
    const reconnect = makeWs()
    next.message(reconnect, JSON.stringify({ type: 'register', name: 'claude@mac:bbq', projectPath: '/p', instanceId }))
    expect(restarted.subscribers('c2')).toEqual(['claude@mac:bbq'])
    expect(Subscriptions.inStateDir(dir).subscribers('c2')).toEqual(['claude@mac:bbq'])
  })

  test('old alias-keyed files migrate existing native bindings and preserve legacy names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subs-migration-'))
    await writeFile(join(dir, 'subscriptions.json'), JSON.stringify({ 'old-native': ['c2'], legacy: ['c2'] }))
    const subs = Subscriptions.inStateDir(dir)
    subs.upgradeNativeAliases([['old-native', 'native-identity']])
    const restarted = Subscriptions.inStateDir(dir)
    expect(restarted.subscribers('c2')).toEqual(['legacy'])
    expect(restarted.nativeSubscribers('c2')).toEqual(['native-identity'])
    restarted.upgradeNativeAliases([['legacy', 'another-identity']])
    expect(restarted.subscribers('c2')).toEqual(['legacy'])
  })

  test('subscriptions persist to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subs-'))
    const s1 = Subscriptions.inStateDir(dir); s1.add('x', 'c9')
    expect(Subscriptions.inStateDir(dir).subscribers('c9')).toEqual(['x'])
  })
})

test('channel_set_topic allows only the creator or an admin and exposes the updated topic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'channel-owner-'))
  const subs = Subscriptions.inStateDir(dir)
  const channels = new Map<string, { id: string; name: string; topic: string | null }>()
  const edited: { id: string; topic: string; reason: string }[] = []
  const d = deps({
    subs, admins: new Set(['admin@mac']),
    channelOps: {
      resolve: async ref => channels.get(ref) ?? null,
      list: async () => [...channels.values()],
      create: async (name, topic) => {
        const result = { id: name, name, topic: topic ?? null }
        channels.set(name, result)
        return result
      },
      setTopic: async (id, topic, reason) => {
        edited.push({ id, topic, reason })
        const result = { ...channels.get(id)!, topic: topic || null }
        channels.set(id, result)
        return result
      },
    },
  })
  const h = createWsHandlers(d)
  const owner = makeWs()
  h.message(owner, JSON.stringify({ type: 'register', name: 'owner@mac', projectPath: '/', instanceId: 'owner-instance' }))
  const outsider = register(h, 'outsider@mac')
  const admin = register(h, 'admin@mac')
  let request = 0
  async function call(ws: MockWs, type: string, fields: object = {}) {
    const requestId = 'topic-' + ++request
    h.message(ws, JSON.stringify({ type, requestId, ...fields }))
    await new Promise(resolve => setTimeout(resolve, 0))
    return msgs(ws).find(frame => frame.requestId === requestId)
  }
  expect(await call(owner, 'channelCreate', { name: 'cfd-injection', topic: '17 species' })).toMatchObject({ success: true })
  expect(await call(outsider, 'channelCreate', { name: 'cfd-injection' })).toMatchObject({ success: true })
  expect(await call(outsider, 'channelSetTopic', { channel: 'cfd-injection', topic: 'takeover' })).toMatchObject({
    success: false, data: 'not_channel_owner',
  })
  expect(await call(owner, 'channelSetTopic', { channel: 'cfd-injection', topic: 'x'.repeat(1025) })).toMatchObject({
    success: false, data: 'invalid_channel_topic',
  })
  expect(edited).toEqual([])
  expect(await call(owner, 'channelSetTopic', { channel: 'cfd-injection', topic: '13 species' })).toMatchObject({ success: true })
  const list = await call(outsider, 'channelList')
  expect(JSON.parse(list.data)).toMatchObject([{ id: 'cfd-injection', topic: '13 species' }])
  expect(await call(admin, 'channelSetTopic', { channel: 'cfd-injection', topic: '' })).toMatchObject({ success: true })
  expect(edited).toEqual([
    { id: 'cfd-injection', topic: '13 species', reason: expect.stringContaining('owner@mac') },
    { id: 'cfd-injection', topic: '', reason: expect.stringContaining('admin@mac') },
  ])

  h.message(owner, JSON.stringify({ type: 'rename', name: 'renamed@mac' }))
  const persisted = Subscriptions.inStateDir(dir)
  expect(persisted.isChannelOwner('cfd-injection', { name: 'renamed@mac', instanceId: 'owner-instance' })).toBe(true)
  expect(persisted.isChannelOwner('cfd-injection', { name: 'renamed@mac', instanceId: 'replacement' })).toBe(false)
})
