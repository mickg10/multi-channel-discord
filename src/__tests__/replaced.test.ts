import { beforeEach, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replacedToolText } from '../plugin-replaced.js'
import { Inboxes, NodeRegistry } from '../nodes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { createWsHandlers, resetBusRateLimit, type WsDeps, type WsLike } from '../ws.js'

const makeWs = (): WsLike & { sent: string[] } => {
  const ws = {
    data: { sessionName: null, sendCallback: null },
    sent: [] as string[],
    send(msg: string) { ws.sent.push(msg) },
  }
  return ws
}
const last = (ws: { sent: string[] }) => JSON.parse(ws.sent.at(-1)!)

let handlers: ReturnType<typeof createWsHandlers>
beforeEach(async () => {
  const deps: WsDeps = {
    sessions: new SessionManager(),
    history: new ProjectHistory(await mkdtemp(join(tmpdir(), 'rep-'))),
    inboxes: new Inboxes(), nodes: new NodeRegistry(),
    client: { channels: { fetch: async () => null } } as unknown as WsDeps['client'],
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
    busChannelId: 'bus',
  }
  handlers = createWsHandlers(deps)
  resetBusRateLimit()
})

test('a replaced client cannot keep sending', () => {
  const stale = makeWs()
  handlers.message(stale, JSON.stringify({ type: 'register', name: 'claude@mac:ops', projectPath: '/p', instanceId: 'live', agent: 'claude' }))
  const next = makeWs()
  handlers.message(next, JSON.stringify({ type: 'register', name: 'claude@mac:ops', projectPath: '/p', instanceId: 'mcp-list', agent: 'claude', takeover: true }))
  expect(last(stale)).toEqual({ type: 'replaced', name: 'claude@mac:ops' })
  handlers.message(stale, JSON.stringify({ type: 'busPost', text: 'still here', requestId: 'p' }))
  expect(last(stale)).toEqual({ type: 'toolResult', requestId: 'p', success: false, data: 'replaced' })
  handlers.message(stale, JSON.stringify({ type: 'busPost', text: 'again' }))
  expect(last(stale)).toEqual({ type: 'error', message: 'replaced' })
  expect(stale.sent.some(raw => raw.includes('still here'))).toBe(false)
})

test('replaced tool text names the bus and says replaced', () => {
  expect(replacedToolText('claude@mac:ops', false, true)).toContain('replaced:')
  expect(replacedToolText('claude@mac:ops', true, true)).toContain('claude@mac:ops')
  expect(replacedToolText('claude@mac:ops', true, false)).toContain('does not support automatic reclaim')
})
