import { beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Inboxes, NodeRegistry } from '../nodes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { createWsHandlers, resetBusRateLimit, type WsDeps, type WsLike } from '../ws.js'

const makeWs = (): WsLike & { send: (msg: string) => void } => ({
  data: { sessionName: null, sendCallback: null },
  send: () => {},
})

let sessions: SessionManager
let handlers: ReturnType<typeof createWsHandlers>

beforeEach(async () => {
  sessions = new SessionManager()
  const deps: WsDeps = {
    sessions, history: new ProjectHistory(await mkdtemp(join(tmpdir(), 'life-'))),
    inboxes: new Inboxes(), nodes: new NodeRegistry(),
    client: { channels: { fetch: async () => null } } as unknown as WsDeps['client'],
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
  }
  handlers = createWsHandlers(deps)
  resetBusRateLimit()
})

function lines(spy: ReturnType<typeof spyOn>): string[] {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.startsWith('discord: register') || line.startsWith('discord: replace') || line.startsWith('discord: deregister'))
}

test('register, replace and deregister are logged', () => {
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const first = makeWs()
    handlers.message(first, JSON.stringify({ type: 'register', name: 'grok@mac:src', projectPath: '/p', instanceId: 'a', agent: 'grok' }))
    const second = makeWs()
    handlers.message(second, JSON.stringify({ type: 'register', name: 'grok@mac:src', projectPath: '/p', instanceId: 'b', agent: 'grok', takeover: true }))
    handlers.close(first)
    handlers.message(second, JSON.stringify({ type: 'deregister' }))
    expect(lines(stderr)).toEqual([
      'discord: register grok@mac:src\n',
      'discord: replace grok@mac:src\n',
      'discord: register grok@mac:src\n',
      'discord: deregister grok@mac:src\n',
    ])
  } finally { stderr.mockRestore() }
})
