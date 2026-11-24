import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { createWsHandlers, routeHumanBusMessage } from '../ws.js'
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

function deps(extra: Partial<WsDeps> = {}): WsDeps {
  const channel = { isTextBased: () => true, send: mock(async (p: any) => { posted.push(typeof p === 'string' ? p : p.content); return {} }) }
  return {
    sessions, history,
    client: { channels: { fetch: mock(async () => channel) } } as any,
    chatId: () => 'dm1', chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
    busChannelId: 'bus1', ...extra,
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
  test('broadcasts to all other sessions and mirrors to the bus channel', async () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    const c = register(h, 'agy@nas642:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'hello all' }))
    await new Promise(r => setTimeout(r, 10))
    for (const ws of [b, c]) {
      const m = msgs(ws).find(x => x.type === 'message')
      expect(m.content).toBe('hello all')
      expect(m.meta.from).toBe('claude@mac:src')
      expect(m.meta.source).toBe('agent-bus')
    }
    expect(msgs(a).some(x => x.type === 'message')).toBe(false)
    expect(posted[0]).toContain('[claude@mac:src → all]')
  })

  test('targets one session by unique prefix', () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    const c = register(h, 'codex-photos@nas642:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'x', to: 'codex-photos' }))
    expect(msgs(c).some(x => x.type === 'message')).toBe(true)
    expect(msgs(b).some(x => x.type === 'message')).toBe(false)
  })

  test('errors on unknown target', () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'x', to: 'nobody' }))
    expect(msgs(a).at(-1).message).toContain('No connected session')
  })

  test('reply with chat_id = bus channel is a broadcast busPost', () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    h.message(a as any, JSON.stringify({ type: 'reply', text: 'via reply', chatId: 'bus1' }))
    expect(msgs(b).find(x => x.type === 'message').content).toBe('via reply')
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
  test('"@name text" targets one session, otherwise broadcast', () => {
    const h = createWsHandlers(deps())
    const a = register(h, 'claude@mac:src')
    const b = register(h, 'codex@nas642:src')
    expect(routeHumanBusMessage('@codex do the thing', { user: 'me' }, sessions)).toEqual(['codex@nas642:src'])
    expect(msgs(b).find(x => x.type === 'message').content).toBe('do the thing')
    expect(msgs(a).some(x => x.type === 'message')).toBe(false)
    expect(routeHumanBusMessage('everyone report status', { user: 'me' }, sessions)).toHaveLength(2)
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

  test('channel_post reaches subscribers only, mirrored to that channel', async () => {
    const subs = new Subscriptions()
    const h = createWsHandlers(chDeps(subs))
    const a = register(h, 'claude@mac:src'), b = register(h, 'codex@nas642'), c = register(h, 'agy@mac:src')
    subs.add('codex@nas642', 'c2')
    h.message(a as any, JSON.stringify({ type: 'channelPost', channel: '#photos-debug', text: 'hi' }))
    await tick()
    const got = msgs(b).find(x => x.type === 'message')
    expect(got.content).toBe('hi')
    expect(got.meta.chat_id).toBe('c2')
    expect(got.meta.channel).toBe('photos-debug')
    expect(msgs(c).some(x => x.type === 'message')).toBe(false)
    expect(posted[0]).toContain('[claude@mac:src → subscribers]')
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

  test('human message in a subscribed channel goes to subscribers only', () => {
    const h = createWsHandlers(deps())
    register(h, 'claude@mac:src'); const b = register(h, 'codex@nas642')
    const out = routeHumanBusMessage('status?', { user: 'me' }, sessions, ['codex@nas642'])
    expect(out).toEqual(['codex@nas642'])
    expect(msgs(b).find(x => x.type === 'message').meta.to).toBe('subscribers')
  })

  test('subscriptions persist to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subs-'))
    const s1 = Subscriptions.inStateDir(dir); s1.add('x', 'c9')
    expect(Subscriptions.inStateDir(dir).subscribers('c9')).toEqual(['x'])
  })
})
