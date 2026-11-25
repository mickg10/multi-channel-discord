import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { createWsHandlers, resetBusRateLimit, routeHumanBusMessage } from '../ws.js'
import { CostClasses, Unread } from '../wake.js'
import type { WsData, WsDeps } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { mkdtemp } from 'node:fs/promises'
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
    const nobody = deps()
    expect(routeHumanBusMessage('everyone report status', { user: 'me', from_human: 'true' }, sessions, undefined, nobody)).toEqual([])
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

  test('subscriptions persist to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subs-'))
    const s1 = Subscriptions.inStateDir(dir); s1.add('x', 'c9')
    expect(Subscriptions.inStateDir(dir).subscribers('c9')).toEqual(['x'])
  })
})
