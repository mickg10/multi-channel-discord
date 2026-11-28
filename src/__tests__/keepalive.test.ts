import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Inboxes, NodeRegistry } from '../nodes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { KEEPALIVE_DEAD_MS, createWsHandlers, resetBusRateLimit, type WsData, type WsDeps, type WsLike } from '../ws.js'

interface MockWs extends WsLike { send: ReturnType<typeof mock> }
const makeWs = (): MockWs => {
  const ws: MockWs = {
    data: { sessionName: null, sendCallback: null },
    send: mock((_m: string) => {}),
    close() { handlers.close(ws) },
  }
  return ws
}
const msgs = (ws: MockWs) => ws.send.mock.calls.map(c => JSON.parse(String(c[0])))

let sessions: SessionManager, handlers: ReturnType<typeof createWsHandlers>
function deps(): WsDeps {
  return {
    sessions, history: new ProjectHistory('/tmp/keepalive-unused'), inboxes: new Inboxes(), nodes: new NodeRegistry(),
    client: { channels: { fetch: async () => null } } as unknown as WsDeps['client'],
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
  }
}

beforeEach(async () => {
  sessions = new SessionManager()
  handlers = createWsHandlers({ ...deps(), history: new ProjectHistory(await mkdtemp(join(tmpdir(), 'ka-'))) })
  resetBusRateLimit()
})

describe('protocol keepalive', () => {
  test('a ping is answered and a silent client is dropped', () => {
    const ws = makeWs()
    handlers.open(ws)
    handlers.message(ws, JSON.stringify({ type: 'register', name: 'grok@mac:src', projectPath: '/p', instanceId: 'live' }))
    handlers.message(ws, JSON.stringify({ type: 'ping' }))
    expect(msgs(ws).some(m => m.type === 'pong')).toBe(true)
    expect(sessions.getSessions().map(s => s.name)).toEqual(['grok@mac:src'])

    const quiet = makeWs()
    handlers.open(quiet)
    handlers.message(quiet, JSON.stringify({ type: 'register', name: 'codex@mac:old', projectPath: '/p', instanceId: 'old' }))

    const now = Date.now()
    expect(handlers.sweepKeepalive(now)).toEqual([])
    expect(sessions.getSessions().map(s => s.name).sort()).toEqual(['codex@mac:old', 'grok@mac:src'])

    expect(handlers.sweepKeepalive(now + KEEPALIVE_DEAD_MS + 1)).toEqual(['grok@mac:src'])
    expect(sessions.getSessions().map(s => s.name)).toEqual(['codex@mac:old'])
  })
})
