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
