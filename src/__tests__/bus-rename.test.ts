import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Inboxes } from '../inboxes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { Subscriptions } from '../subscriptions.js'
import { Conversations } from '../wake.js'
import { createWsHandlers, deliver, type WsData, type WsDeps, type WsLike } from '../ws.js'

test('bus_rename reports the collision suffix and keeps inbox and subscriptions across reconnect and plugin replacement', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'bus-rename-'))
  const subscriptions = Subscriptions.inStateDir(stateDir)
  const inboxes = Inboxes.inStateDir(stateDir)
  const deps: WsDeps = {
    sessions: new SessionManager(), history: new ProjectHistory(stateDir), subs: subscriptions, inboxes,
    conversations: new Conversations(), client: {} as WsDeps['client'], busChannelId: 'bus',
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
  }
  const handlers = createWsHandlers(deps)
  const renamed = 'cfd-injection-smart-2'
  const original = 'agy@nas642:p1'
  const registrations: string[] = []
  const clients: Client[] = []
  const sockets = new Set<Bun.ServerWebSocket<WsData>>()
  const fixture = Bun.serve<WsData>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { sessionName: null, sendCallback: null } })) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      open(ws) { sockets.add(ws) },
      message(ws, raw) {
        handlers.message(ws, raw)
        if (JSON.parse(String(raw)).type === 'register') registrations.push(ws.data.sessionName!)
      },
      close(ws) { sockets.delete(ws); handlers.close(ws) },
    },
  })
  const existing: WsLike = { data: { sessionName: null, sendCallback: null }, send() {} }
  handlers.message(existing, JSON.stringify({ type: 'register', name: 'cfd-injection-smart', projectPath: stateDir }))

  async function plugin() {
    const client = new Client({ name: 'rename-fixture', version: '1' })
    clients.push(client)
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, '..', 'plugin.ts')],
      stderr: 'ignore',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: stateDir,
        DISCORD_AGENT: 'agy',
        DISCORD_SUPERVISOR_PID: 'fixture-supervisor',
        DISCORD_PARENT_PID: String(process.pid),
        DISCORD_CONVERSATION_ID: 'injection-conversation',
        DISCORD_STATE_DIR: stateDir,
        DISCORD_ROUTER_URL: `ws://127.0.0.1:${fixture.port}`,
        DISCORD_SESSION_NAME: original,
        DISCORD_MODE: 'pull',
      },
    }))
    return client
  }

  try {
    const first = await plugin()
    await waitFor(() => registrations.length === 1)
    expect(registrations[0]).toBe(original)
    subscriptions.add(original, 'topic')
    expect(deliver(deps, original, 'queued for the original name', { from: 'fixture' })).toBe(true)
    inboxes.push(original, 'approval for another conversation', {
      from_human: 'true', question_id: 'old-approval', conversation_id: 'different-conversation',
    })

    const tools = await first.listTools()
    expect(tools.tools.find(tool => tool.name === 'bus_rename')?.description).toContain('Call this after the user renames you')
    for (const name of ['has spaces', '', 'x'.repeat(129)]) {
      const invalid = await first.callTool({ name: 'bus_rename', arguments: { name } })
      expect(invalid.isError).toBe(true)
    }
    const result = await first.callTool({ name: 'bus_rename', arguments: { name: 'cfd-injection-smart' } })
    expect(result.content).toEqual([{ type: 'text', text: renamed }])
    expect(subscriptions.subscribers('topic')).toEqual([renamed])
    expect(inboxes.list(original).map(entry => entry.content)).toEqual(['approval for another conversation'])

    for (const socket of sockets) socket.close()
    await waitFor(() => registrations.length === 2)
    expect(registrations[1]).toBe(renamed)
    await first.close()
    await waitFor(() => sockets.size === 0)

    const restarted = await plugin()
    await waitFor(() => registrations.length === 3)
    expect(registrations[2]).toBe(renamed)
    const inbox = await restarted.callTool({ name: 'check_inbox', arguments: {} })
    expect(JSON.stringify(inbox.content)).toContain('queued for the original name')
    expect(inboxes.count(renamed)).toBe(0)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await fixture.stop(true)
    rmSync(stateDir, { recursive: true, force: true })
  }
}, 12_000)

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for plugin registration')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
