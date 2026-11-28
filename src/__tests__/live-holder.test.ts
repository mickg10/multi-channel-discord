import { beforeEach, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    history: new ProjectHistory(await mkdtemp(join(tmpdir(), 'live-'))),
    inboxes: new Inboxes(), nodes: new NodeRegistry(),
    client: { channels: { fetch: async () => null } } as unknown as WsDeps['client'],
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
  }
  handlers = createWsHandlers(deps)
  resetBusRateLimit()
})

const reg = (name: string, instanceId: string, extra: Record<string, unknown> = {}) => {
  const ws = makeWs()
  handlers.message(ws, JSON.stringify({ type: 'register', name, projectPath: '/p', instanceId, agent: 'claude', ...extra }))
  return ws
}

test('a live holder refuses a different instance and parent', () => {
  const start = 1_700_000_000_000
  const real = Date.now
  Date.now = () => start
  try {
    const holder = reg('claude@mac:ops', 'parent-1', { parent: 'parent-1' })
    handlers.message(holder, JSON.stringify({ type: 'ping' }))
    expect(last(holder).type).toBe('pong')
    Date.now = () => start + 1_000
    const stolen = reg('claude@mac:ops', 'mcp-list', { parent: 'mcp-list', takeover: true })
    expect(last(stolen)).toEqual({ type: 'error', message: 'takeover_refused' })
    expect(holder.data.sessionName).toBe('claude@mac:ops')

    const sameParent = reg('claude@mac:ops', 'other-instance', { parent: 'parent-1', takeover: true })
    expect(last(sameParent).type).toBe('registered')
    expect(last(sameParent).name).toBe('claude@mac:ops')
  } finally { Date.now = real }
})

test('a holder that never pinged can still be replaced by a resumed thread', () => {
  reg('codex@mac', 'old', { agent: 'codex' })
  const resumed = reg('codex@mac', 'new', { agent: 'codex', takeover: true, conversationId: 'thread-2' })
  expect(last(resumed).type).toBe('registered')
})

test('a ping older than the live window no longer blocks takeover', () => {
  const start = 1_700_000_000_000
  const real = Date.now
  Date.now = () => start
  try {
    const holder = reg('claude@mac:ops', 'parent-1', { parent: 'parent-1' })
    handlers.message(holder, JSON.stringify({ type: 'ping' }))
    Date.now = () => start + 45_000 + 1
    const resumed = reg('claude@mac:ops', 'resumed', { parent: 'other', takeover: true })
    expect(last(resumed).type).toBe('registered')
  } finally { Date.now = real }
})
