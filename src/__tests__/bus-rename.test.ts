import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  for (const name of ['human', 'all:synthesis', 'claude@otherhost:x', 'has spaces', 'x'.repeat(129)]) {
    const responses: { type: string; message: string }[] = []
    const candidate: WsLike = {
      data: { sessionName: null, sendCallback: null },
      send(raw) { responses.push(JSON.parse(raw)) },
    }
    handlers.message(candidate, JSON.stringify({ type: 'register', host: 'nas642', name, projectPath: stateDir }))
    expect(responses).toEqual([{ type: 'error', message: 'register rejected: invalid_bus_alias' }])
    expect(candidate.data.sessionName).toBeNull()
  }


  const rawReplies: { type: string; message?: string; newName?: string }[] = []
  const raw: WsLike = {
    data: { sessionName: null, sendCallback: null },
    send(frame) { rawReplies.push(JSON.parse(frame)) },
  }
  handlers.message(raw, JSON.stringify({ type: 'register', name: 'unqualified-legacy', projectPath: stateDir }))
  for (const name of ['has spaces', 'x'.repeat(129), 'HUMAN', 'Router', '@All', 'x@nas642:y']) {
    handlers.message(raw, JSON.stringify({ type: 'rename', name }))
    expect(rawReplies.at(-1)).toEqual({ type: 'error', message: 'invalid_bus_alias' })
    expect(raw.data.sessionName).toBe('unqualified-legacy')
  }
  const longName = 'a'.repeat(128)
  handlers.message(existing, JSON.stringify({ type: 'rename', name: longName }))
  handlers.message(raw, JSON.stringify({ type: 'rename', name: longName }))
  expect(rawReplies.at(-1)?.newName).toBe('a'.repeat(126) + '-2')
  handlers.message(existing, JSON.stringify({ type: 'rename', name: 'cfd-injection-smart' }))

  const reclaimClock = join(stateDir, 'reclaim-clock.js')
  writeFileSync(reclaimClock, `const schedule = globalThis.setTimeout;
globalThis.setTimeout = (cb, ms, ...args) => schedule(cb, ms === 60000 ? 100 : ms, ...args);`)
  async function plugin(name = original, host = 'nas642', instanceId?: string, agent = 'agy') {
    const client = new Client({ name: 'rename-fixture', version: '1' })
    clients.push(client)
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['--preload', reclaimClock, join(import.meta.dir, '..', 'plugin.ts')],
      stderr: 'ignore',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: stateDir,
        DISCORD_AGENT: agent,
        DISCORD_HOST_LABEL: host,
        ...((instanceId || host !== 'nas642') && { DISCORD_INSTANCE_ID: instanceId ?? 'invalid-host-fixture' }),
        DISCORD_PARENT_PID: String(process.pid),
        DISCORD_CONVERSATION_ID: 'injection-conversation',
        DISCORD_STATE_DIR: stateDir,
        DISCORD_ROUTER_URL: `ws://127.0.0.1:${fixture.port}`,
        DISCORD_SESSION_NAME: name,
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
    for (const name of ['human', 'router', 'all:synthesis', 'claude@otherhost:x']) {
      const denied = await first.callTool({ name: 'bus_rename', arguments: { name } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('invalid_bus_alias')
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

    const misconfigured = await plugin('agy@mac_mini:p1', 'mac_mini')
    await waitFor(() => registrations.length === 4 && sockets.size === 1)
    const denied = await misconfigured.callTool({ name: 'bus_rename', arguments: { name: 'new-name' } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('Check DISCORD_SESSION_NAME and DISCORD_HOST_LABEL')
    await new Promise(resolve => setTimeout(resolve, 1_100))
    expect(registrations.length).toBe(4)
    await restarted.close()
    await waitFor(() => sockets.size === 0)
    const pinned = 'agy-tools@nas642:pinned'
    const holder = await plugin(pinned, 'nas642', 'pinned-holder')
    await waitFor(() => registrations.includes(pinned))
    const taker = makePeer()
    const wrong = makePeer()
    handlers.message(wrong.ws, JSON.stringify({
      type: 'register', name: pinned, projectPath: '/', host: 'nas642', agent: 'claude',
      instanceId: 'pinned-holder', takeover: true,
    }))
    expect(wrong.frames.at(-1)).toEqual({ type: 'error', message: 'takeover_refused' })
    expect(wrong.ws.data.sessionName).toBeNull()
    expect(deps.sessions.isSameInstance(pinned, 'pinned-holder')).toBe(true)

    handlers.message(taker.ws, JSON.stringify({
      type: 'register', name: pinned, projectPath: '/', host: 'nas642', agent: 'agy',
      instanceId: 'legitimate-taker', takeover: true,
    }))
    expect(taker.frames.at(-1)).toMatchObject({ type: 'registered', name: pinned })
    await waitFor(() => registrations.length > 5)
    expect(deps.sessions.isSameInstance(pinned, 'legitimate-taker')).toBe(true)
    expect(deps.sessions.getSessions().some(session => session.name.startsWith(pinned + '-'))).toBe(false)
    handlers.close(taker.ws)
    await waitFor(() => deps.sessions.isSameInstance(pinned, 'pinned-holder'))
    await waitFor(async () => {
      const restored = await holder.callTool({ name: 'bus_sessions', arguments: {} })
      return !restored.isError && JSON.stringify(restored.content).includes(pinned + '  (you)')
    })

    const codexName = 'codex@nas642:abandoned'
    const abandoned = await plugin(codexName, 'nas642', 'old-codex-instance', 'codex')
    await waitFor(() => registrations.includes(codexName))
    const successor = makePeer()
    handlers.message(successor.ws, JSON.stringify({
      type: 'register', agent: 'codex', name: codexName, projectPath: '/', instanceId: 'new-codex-instance',
      takeover: true, conversationId: 'new-codex-thread',
    }))
    await waitFor(async () => {
      const status = await abandoned.callTool({ name: 'bus_sessions', arguments: {} })
      return status.isError === true && JSON.stringify(status.content).includes('superseded')
    })
    handlers.close(successor.ws)
    const count = registrations.length
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(registrations.length).toBe(count)
    expect(deps.sessions.registeredIdentity(codexName)).toBeUndefined()
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await fixture.stop(true)
    rmSync(stateDir, { recursive: true, force: true })
  }
}, 16_000)

function makePeer() {
  const frames: object[] = []
  const ws: WsLike = {
    data: { sessionName: null, sendCallback: null },
    send(raw) { frames.push(JSON.parse(raw)) },
  }
  return { ws, frames }
}

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for plugin registration')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
