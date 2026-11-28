import { afterAll, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ChannelType } from 'discord.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { BusAlias } from '../bus-alias.js'
import { Inboxes } from '../inboxes.js'
import { NameLeases } from '../name-leases.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { Subscriptions } from '../subscriptions.js'
import { SwarmChannels, type ChannelClientLike, type GuildChannelLike, type GuildLike } from '../swarm-channels.js'
import { SwarmConfig } from '../swarm-config.js'
import { SwarmJournal } from '../swarm-journal.js'
import {
  aliasKeyForSwarm,
  detectSwarmAndPaneSync,
  expectedGeneratedName,
  findAncestorTmuxPane,
  isDuplicateClaudePluginUnderForeignAgent,
  loadPersistedSwarmState,
  normalizeSwarmLocally,
  parsePsPpidTable,
  parseTmuxPanes,
  pruneOldSwarmStates,
  resolveRawSwarmFromWindows,
  savePersistedSwarmState,
  SWARM_STATE_TTL_MS,
} from '../plugin.js'
import { createWsHandlers, knownSwarm, type WsData, type WsDeps, type WsLike } from '../ws.js'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarm-pr2-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise(r => setTimeout(r, 15))
  }
}

describe('PR2 plugin pure helpers', () => {
  test('parseTmuxPanes reads #{pane_pid} #{pane_id} #{window_id}', () => {
    const map = parseTmuxPanes('1001 %1 @10\n2002 %5 @20\nbadline\n')
    expect(map.get('1001')).toEqual({ paneId: '%1', windowId: '@10' })
    expect(map.get('2002')).toEqual({ paneId: '%5', windowId: '@20' })
    expect(map.size).toBe(2)
  })

  test('resolveRawSwarmFromWindows prefers session_group and breaks ungrouped ties by lowest numeric #{session_id}', () => {
    // Grouped session wins over session_name
    const grouped = '@10\t$3\tcfd\tcfd-view-2\n@11\t$1\t\tagents\n'
    expect(resolveRawSwarmFromWindows('@10', grouped)).toBe('cfd')

    // Window linked into several ungrouped sessions -> lowest numeric session_id ($2 < $10)
    const linked = '@5\t$10\t\tzebra\n@5\t$2\t\tcfd\n@5\t$7\t\talpha\n'
    expect(resolveRawSwarmFromWindows('@5', linked)).toBe('cfd')
    expect(resolveRawSwarmFromWindows('@999', linked)).toBeUndefined()
  })

  test('normalizeSwarmLocally, aliasKeyForSwarm, and expectedGeneratedName match router semantics', () => {
    expect(normalizeSwarmLocally(undefined, ['agents', '0'])).toBe('default')
    expect(normalizeSwarmLocally('', ['agents', '0'])).toBe('default')
    expect(normalizeSwarmLocally('agents', ['agents', '0'])).toBe('default')
    expect(normalizeSwarmLocally('0', ['agents'])).toBe('default')
    expect(normalizeSwarmLocally('42', ['agents'])).toBe('default')
    expect(normalizeSwarmLocally('default', ['agents'])).toBe('default')
    expect(normalizeSwarmLocally('cfd', ['agents'])).toBe('cfd')

    expect(aliasKeyForSwarm('default', 'pid-1')).toBe('pid-1')
    expect(aliasKeyForSwarm('cfd', 'pid-1')).toBe('cfd:pid-1')

    expect(expectedGeneratedName('claude@mac:src', 'default')).toBe('claude@mac:src')
    expect(expectedGeneratedName('claude@mac:src', 'cfd')).toBe('claude@mac:cfd/src')
  })

  test('isDuplicateClaudePluginUnderForeignAgent detects grok/opencode when DISCORD_AGENT is unset', () => {
    expect(isDuplicateClaudePluginUnderForeignAgent({}, ['/usr/local/bin/grok --leader-socket /tmp/x'])).toBe('grok')
    expect(isDuplicateClaudePluginUnderForeignAgent({}, ['/Users/m/.opencode/bin/opencode --standalone'])).toBe('opencode')
    expect(isDuplicateClaudePluginUnderForeignAgent({ DISCORD_AGENT: 'grok' }, ['/usr/local/bin/grok'])).toBeNull()
    expect(isDuplicateClaudePluginUnderForeignAgent({ DISCORD_AGENT: 'opencode' }, ['opencode --standalone'])).toBeNull()
    expect(isDuplicateClaudePluginUnderForeignAgent({}, ['/usr/local/bin/claude --channels'])).toBeNull()
  })
})

describe('PR2 plugin end-to-end against local router', () => {
  test('two-session run (default + cfd): generated names, tool schemas, error surfacing via sendToolRequest, and unknown_swarm 60s retry', async () => {
    const stateDir = tempDir()
    const cache = new Map<string, GuildChannelLike>()
    const addCh = (id: string, name: string, type: ChannelType, parentId: string | null) => {
      const ch: GuildChannelLike & { isTextBased(): boolean; send(p: unknown): Promise<{ id: string }>; messages: { fetch(): Promise<unknown> } } = {
        id, name, type, parentId, guildId: 'g1',
        isTextBased: () => type !== ChannelType.GuildCategory,
        send: async () => ({ id: `msg-${id}` }),
        messages: { fetch: async () => ({ id: 'm1', author: { id: 'bot', username: 'bot' }, attachments: new Map(), react: async () => {} }) },
      }
      cache.set(id, ch)
      return ch
    }
    const defCat = addCh('cat-def', 'General', ChannelType.GuildCategory, null)
    const busCh = addCh('ch-bus', 'general', ChannelType.GuildText, defCat.id)
    const humCh = addCh('ch-hum', 'human-questions', ChannelType.GuildText, defCat.id)
    const defTopic = addCh('ch-def-topic', 'def-topic', ChannelType.GuildText, defCat.id)
    const cfdCat = addCh('cat-cfd', 'cfd', ChannelType.GuildCategory, null)
    addCh('ch-cfd-gen', 'general', ChannelType.GuildText, cfdCat.id)
    addCh('ch-cfd-hum', 'human', ChannelType.GuildText, cfdCat.id)

    const guildLike: GuildLike = {
      id: 'g1',
      channels: {
        cache,
        fetch: async () => cache,
        create: async (opts) => addCh(`ch-${cache.size + 1}`, opts.name, opts.type, opts.parent ?? null),
      },
    }
    const clientLike: ChannelClientLike = {
      isReady: () => true,
      channels: { cache, fetch: async (id: string) => cache.get(id) ?? null },
    }

    const swarmConfig = SwarmConfig.fromObject({ swarms: { cfd: {} }, defaultSessions: ['agents', '0'] })
    const sessions = new SessionManager(NameLeases.inStateDir(stateDir))
    const subs = Subscriptions.inStateDir(stateDir)
    let deps!: WsDeps
    const swarmChannels = new SwarmChannels({
      config: swarmConfig,
      client: clientLike,
      busChannelId: busCh.id,
      humanChannelId: humCh.id,
      subs,
      knownSwarm: n => knownSwarm(deps, n),
    })
    await swarmChannels.onClientReady(guildLike)

    deps = {
      sessions,
      history: new ProjectHistory(stateDir),
      client: clientLike as unknown as WsDeps['client'],
      chatId: () => null,
      chunkLimit: 2000,
      chunkMode: 'length',
      replyToMode: 'first',
      busChannelId: busCh.id,
      humanChannelId: humCh.id,
      subs,
      channelOps: swarmChannels.createChannelOps(async () => guildLike),
      inboxes: Inboxes.inStateDir(stateDir),
      swarmConfig,
      swarmJournal: SwarmJournal.inStateDir(stateDir),
      swarmChannels,
    }
    const handlers = createWsHandlers(deps)
    const registerFrames: Array<Record<string, unknown>> = []
    const server = Bun.serve<WsData>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: { sessionName: null, sendCallback: null } })) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const parsed = JSON.parse(String(raw)) as Record<string, unknown>
          if (parsed.type === 'register') registerFrames.push(parsed)
          handlers.message(ws, raw)
        },
        close(ws) { handlers.close(ws) },
      },
    })

    // Preload script to speed up 60s reject retry to 150ms in test
    const fastClock = join(stateDir, 'fast-clock.js')
    writeFileSync(fastClock, `const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (cb, ms, ...a) => origSetTimeout(cb, ms === 60000 ? 150 : ms, ...a);`)

    const clients: Client[] = []
    const spawnSeat = async (instanceId: string, swarmId: string, useFastClock = false) => {
      const client = new Client({ name: `test-${instanceId}`, version: '1' })
      clients.push(client)
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [...(useFastClock ? ['--preload', fastClock] : []), join(import.meta.dir, '..', 'plugin.ts')],
        stderr: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: stateDir,
          TMUX_TMPDIR: stateDir,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: instanceId,
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${server.port}`,
          SWARM_ID: swarmId,
        },
      }))
      return client
    }

    try {
      const dirName = basename(process.cwd())
      const seatDefault = await spawnSeat('seat-def', 'agents')
      const seatCfd = await spawnSeat('seat-cfd', 'cfd')
      await waitFor(() => sessions.getSessions().length === 2)

      const defName = `agy@mac:${dirName}`
      const cfdName = `agy@mac:cfd/${dirName}`
      expect(sessions.getSwarm(defName)).toBe('default')
      expect(sessions.getSwarm(cfdName)).toBe('cfd')

      // Neither non-colliding generated name should be saved as assignedAlias!
      const cfdKey = createHash('sha256').update('cfd:seat-cfd').digest('hex')
      expect(existsSync(join(stateDir, 'assigned-aliases', cfdKey))).toBe(false)

      // Tool schemas include optional `swarm` on all swarm-addressable tools
      const tools = (await seatCfd.listTools()).tools
      for (const toolName of [
        'bus_post', 'channel_post', 'channel_list', 'channel_create',
        'channel_archive', 'channel_subscribe', 'channel_unsubscribe',
        'bus_sessions', 'fetch_messages',
      ]) {
        const schema = tools.find(t => t.name === toolName)?.inputSchema as { properties?: Record<string, unknown> }
        expect(schema?.properties?.swarm).toBeDefined()
      }

      // bus_sessions isolation
      const defSessions = await seatDefault.callTool({ name: 'bus_sessions', arguments: {} })
      expect(JSON.stringify(defSessions.content)).toContain(defName)
      expect(JSON.stringify(defSessions.content)).not.toContain(cfdName)

      const cfdSessions = await seatCfd.callTool({ name: 'bus_sessions', arguments: {} })
      expect(JSON.stringify(cfdSessions.content)).toContain(cfdName)
      expect(JSON.stringify(cfdSessions.content)).not.toContain(defName)

      // Cross-swarm errors surface via sendToolRequest for bus_post, channel_post, reply, react, bus_sessions!
      const crossBus = await seatCfd.callTool({ name: 'bus_post', arguments: { text: 'hi', to: defName } })
      expect(crossBus.isError).toBe(true)
      expect(JSON.stringify(crossBus.content)).toContain('in swarm cfd')

      const crossChPost = await seatCfd.callTool({ name: 'channel_post', arguments: { channel: defTopic.id, text: 'hi' } })
      expect(crossChPost.isError).toBe(true)
      expect(JSON.stringify(crossChPost.content)).toContain('cross_swarm')

      const crossReply = await seatCfd.callTool({ name: 'reply', arguments: { chat_id: defTopic.id, text: 'hi' } })
      expect(crossReply.isError).toBe(true)
      expect(JSON.stringify(crossReply.content)).toContain('cross_swarm')

      const crossReact = await seatCfd.callTool({ name: 'react', arguments: { chat_id: defTopic.id, message_id: 'm1', emoji: '👍' } })
      expect(crossReact.isError).toBe(true)
      expect(JSON.stringify(crossReact.content)).toContain('cross_swarm')

      // Unlisted swarm -> register rejected: unknown_swarm -> lastRejectReason surfaces on tools + 60s retry!
      const beforeRejectCount = registerFrames.filter(f => f.swarm === 'unlisted').length
      const seatRejected = await spawnSeat('seat-bad', 'unlisted', true)
      await waitFor(() => registerFrames.filter(f => f.swarm === 'unlisted').length >= beforeRejectCount + 2)
      const toolWhileRejected = await seatRejected.callTool({ name: 'bus_sessions', arguments: {} })
      expect(toolWhileRejected.isError).toBe(true)
      expect(JSON.stringify(toolWhileRejected.content)).toContain('unknown_swarm')
      expect(JSON.stringify(toolWhileRejected.content)).toContain('unlisted')
    } finally {
      await Promise.allSettled(clients.map(c => c.close()))
      server.stop(true)
    }
  }, 20_000)

  test('new plugin works against an old router (no swarm field in WsRegistered)', async () => {
    const stateDir = tempDir()
    const received: Array<Record<string, unknown>> = []
    const oldRouter = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          received.push(msg)
          if (msg.type === 'register') {
            // Old router response: NO swarm, NO defaultSessions!
            ws.send(JSON.stringify({ type: 'registered', name: msg.name }))
          } else if (msg.type === 'listSessions') {
            ws.send(JSON.stringify({
              type: 'toolResult',
              requestId: msg.requestId,
              success: true,
              data: JSON.stringify([{ name: 'agy@mac:old', projectPath: '/', connectedAt: '' }]),
            }))
          }
        },
      },
    })

    const client = new Client({ name: 'old-router-test', version: '1' })
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, '..', 'plugin.ts')],
        stderr: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: stateDir,
          TMUX_TMPDIR: stateDir,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'old-1',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${oldRouter.port}`,
        },
      }))
      await waitFor(() => received.some(m => m.type === 'register'))
      const res = await client.callTool({ name: 'bus_sessions', arguments: {} })
      expect(res.isError).toBeFalsy()
      // react against old router uses fire-and-forget fallback and does NOT hang!
      const reactRes = await client.callTool({ name: 'react', arguments: { chat_id: '123', message_id: 'm1', emoji: '👍' } })
      expect(reactRes.isError).toBeFalsy()
      await waitFor(() => received.some(m => m.type === 'react'))
    } finally {
      await client.close()
      oldRouter.stop(true)
    }
  }, 15_000)

  test('plugin handles swarm_changed by re-registering in place without closing its socket', async () => {
    const stateDir = tempDir()
    const registers: Array<Record<string, unknown>> = []
    let closeCount = 0
    let activeWs: { send(m: string): void } | null = null
    const mockRouter = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg.type === 'register') {
            activeWs = ws
            registers.push(msg)
            const swarm = registers.length === 1 ? 'default' : 'cfd'
            const name = swarm === 'default' ? String(msg.name) : String(msg.name).replace(':', ':cfd/')
            ws.send(JSON.stringify({ type: 'registered', name, swarm, defaultSessions: ['agents'] }))
          }
        },
        close() { closeCount++ },
      },
    })

    const client = new Client({ name: 'swarm-changed-test', version: '1' })
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, '..', 'plugin.ts')],
        stderr: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: stateDir,
          TMUX_TMPDIR: stateDir,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'sib-1',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
          SWARM_ID: 'agents',
        },
      }))
      await waitFor(() => registers.length === 1 && activeWs !== null)
      // Simulate router sending swarm_changed when sibling process moved the slot to cfd
      activeWs!.send(JSON.stringify({ type: 'swarm_changed', swarm: 'cfd' }))
      await waitFor(() => registers.length === 2)
      expect(closeCount).toBe(0) // re-registered in place WITHOUT closing the socket!
    } finally {
      await client.close()
      mockRouter.stop(true)
    }
  }, 15_000)

  test('B1 & N1: non-agents session with saved alias reconnects under that alias with exact 1 extra register and no orphaned socket', async () => {
    const stateDir = tempDir()
    const registers: Array<Record<string, unknown>> = []
    let openSockets = 0
    let mode: 'no-config' | 'default-sessions' | 'cfd-swarm' = 'no-config'
    const mockRouter = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        open() { openSockets++ },
        close() { openSockets-- },
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg.type === 'register') {
            registers.push(msg)
            if (mode === 'no-config') {
              ws.send(JSON.stringify({ type: 'registered', name: msg.name, swarm: 'default', defaultSessions: ['agents'] }))
            } else if (mode === 'default-sessions') {
              ws.send(JSON.stringify({ type: 'registered', name: msg.name, swarm: 'default', defaultSessions: ['agents', 'work'], swarmConfigured: true }))
            } else {
              const name = msg.generated ? String(msg.name).replace(':', ':cfd/') : String(msg.name)
              ws.send(JSON.stringify({ type: 'registered', name, swarm: 'cfd', defaultSessions: ['agents'], swarmConfigured: true }))
            }
          } else if (msg.type === 'rename') {
            ws.send(JSON.stringify({ type: 'renamed', requestId: msg.requestId, oldName: 'old', newName: msg.name }))
          }
        },
      },
    })

    const spawnWork = async (instanceId: string, swarmId: string) => {
      const client = new Client({ name: `b1-${instanceId}`, version: '1' })
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, '..', 'plugin.ts')],
        stderr: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: stateDir,
          TMUX_TMPDIR: stateDir,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: instanceId,
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
          SWARM_ID: swarmId,
        },
      }))
      return client
    }

    try {
      // 1. No config: session "work" renames to "agy@mac:my-work-alias", restarts, reconnects under that alias!
      mode = 'no-config'
      const c1 = await spawnWork('work-1', 'work')
      await waitFor(() => registers.length === 1)
      const ren = await c1.callTool({ name: 'bus_rename', arguments: { name: 'agy@mac:my-work-alias' } })
      expect(ren.isError).toBeFalsy()
      // Housekeeping: no swarm-state written when unconfigured!
      expect(existsSync(join(stateDir, 'swarm-state'))).toBe(false)
      await c1.close()

      const c2 = await spawnWork('work-1', 'work')
      await waitFor(() => registers.length === 2)
      expect(registers[1]!.name).toBe('agy@mac:my-work-alias')
      await c2.close()

      // 2. Configured defaultSessions: ['agents', 'work']: reconnects under saved alias too!
      mode = 'default-sessions'
      const c3 = await spawnWork('work-1', 'work')
      await waitFor(() => registers.length === 3)
      expect(registers[2]!.name).toBe('agy@mac:my-work-alias')
      await c3.close()
      await waitFor(() => openSockets === 0)

      // 3. Cold start in configured swarm "cfd" with a pre-existing saved alias for "cfd:cfd-saved-1" and NO swarm-state file:
      //    first register guesses default, router returns swarm:'cfd', plugin immediately reconnects under saved alias
      //    with EXACTLY one extra register and 1 open socket (no orphaned/duplicate socket, N1)!
      mode = 'cfd-swarm'
      new BusAlias(stateDir, aliasKeyForSwarm('cfd', 'cfd-saved-1')).save('agy@mac:cfd-hero')
      const before = registers.length
      const c4 = await spawnWork('cfd-saved-1', 'cfd')
      await waitFor(() => registers.length >= before + 2)
      await new Promise(r => setTimeout(r, 300))
      expect(registers.length).toBe(before + 2)
      expect(registers[before + 1]!.name).toBe('agy@mac:cfd-hero')
      expect(openSockets).toBe(1)
      await c4.close()
    } finally {
      mockRouter.stop(true)
    }
  }, 15_000)

  test('N2, R2-M2, & swarm-state housekeeping: config removal returns seat to plain name, transient lookup failure does not reconnect, 0700/0600 & 30d prune', async () => {
    const stateDir = tempDir()
    const dirName = basename(process.cwd())

    // Housekeeping: 0700 dir, 0600 file, ignores configured !== true, prunes >30d files
    savePersistedSwarmState(stateDir, 'hk-1', { raw: 'cfd', swarm: 'cfd', defaultSessions: ['agents'], configured: true })
    const dirMode = statSync(join(stateDir, 'swarm-state')).mode & 0o777
    expect(dirMode).toBe(0o700)
    const hkHash = createHash('sha256').update('hk-1').digest('hex')
    const hkFile = join(stateDir, 'swarm-state', `${hkHash}.json`)
    expect(statSync(hkFile).mode & 0o777).toBe(0o600)
    expect(loadPersistedSwarmState(stateDir, 'hk-1')?.swarm).toBe('cfd')

    // Unconfigured state file is ignored on load and deleted on save
    const uncfgHash = createHash('sha256').update('hk-uncfg').digest('hex')
    const uncfgFile = join(stateDir, 'swarm-state', `${uncfgHash}.json`)
    writeFileSync(uncfgFile, JSON.stringify({ raw: 'cfd', swarm: 'cfd', defaultSessions: ['agents'], configured: false }))
    expect(loadPersistedSwarmState(stateDir, 'hk-uncfg')).toBeNull()
    savePersistedSwarmState(stateDir, 'hk-uncfg', { raw: 'cfd', swarm: 'default', defaultSessions: ['agents'], configured: false })
    expect(existsSync(uncfgFile)).toBe(false)

    // Prune entries older than 30 days while keeping fresh ones
    const oldTime = new Date(Date.now() - SWARM_STATE_TTL_MS - 60_000)
    savePersistedSwarmState(stateDir, 'hk-old', { raw: 'cfd', swarm: 'cfd', defaultSessions: ['agents'], configured: true })
    const oldHash = createHash('sha256').update('hk-old').digest('hex')
    const oldFile = join(stateDir, 'swarm-state', `${oldHash}.json`)
    utimesSync(oldFile, oldTime, oldTime)
    expect(pruneOldSwarmStates(stateDir)).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(hkFile)).toBe(true)

    // R2-M2 pure unit checks: transient tmux/ps/list-windows errors return ok:false preserving previous pane & rawSwarm
    const prevPane = { paneId: '%5', windowId: '@2' }
    const transientErr = Object.assign(new Error('Resource temporarily unavailable'), { stderr: 'EAGAIN' })
    expect(detectSwarmAndPaneSync({
      tmuxBin: 'tmux', startPid: '300', prevPane, prevRawSwarm: 'cfd', envSwarm: 'fallback',
      exec: () => { throw transientErr },
    })).toEqual({ ok: false, pane: prevPane, rawSwarm: 'cfd' })
    expect(detectSwarmAndPaneSync({
      tmuxBin: 'tmux', startPid: '300', prevPane, prevRawSwarm: 'cfd', envSwarm: 'fallback',
      exec: (cmd) => {
        if (cmd === 'tmux') return '100 %5 @2\n'
        throw transientErr
      },
    })).toEqual({ ok: false, pane: prevPane, rawSwarm: 'cfd' })
    expect(detectSwarmAndPaneSync({
      tmuxBin: 'tmux', startPid: '300', prevPane, prevRawSwarm: 'cfd', envSwarm: 'fallback',
      exec: (cmd, args) => {
        if (cmd === 'ps') return '100 1\n300 100\n'
        if (args[0] === 'list-panes') return '100 %5 @2\n'
        throw transientErr
      },
    })).toEqual({ ok: false, pane: prevPane, rawSwarm: 'cfd' })
    const noSrvErr = Object.assign(new Error('no server running'), { stderr: 'no server running on /tmp/tmux' })
    expect(detectSwarmAndPaneSync({
      tmuxBin: 'tmux', startPid: '300', prevPane: undefined, prevRawSwarm: undefined, envSwarm: 'cfd',
      exec: () => { throw noSrvErr },
    })).toEqual({ ok: true, pane: undefined, rawSwarm: 'cfd' })

    // N2 end-to-end: seat in configured cfd gets agy@mac:cfd/<dir>-2, then config is removed ->
    // seat returns to plain agy@mac:<dir>, does NOT save cfd/<dir>-2 in default assigned-aliases, and deletes swarm-state!
    const registers: Array<Record<string, unknown>> = []
    let openSockets = 0
    let configured = true
    const mockRouter = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        open() { openSockets++ },
        close() { openSockets-- },
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg.type === 'rename') {
            ws.send(JSON.stringify({ type: 'renamed', requestId: msg.requestId, oldName: 'old', newName: msg.name }))
            return
          }
          if (msg.type !== 'register') return
          registers.push(msg)
          if (configured) {
            const assignedName = `agy@mac:cfd/${dirName}-2`
            ws.send(JSON.stringify({ type: 'registered', name: assignedName, swarm: 'cfd', defaultSessions: ['agents'], swarmConfigured: true }))
          } else {
            ws.send(JSON.stringify({ type: 'registered', name: msg.name, swarm: 'default', defaultSessions: ['agents'] }))
          }
        },
      },
    })

    // R2-M2 end-to-end preload: accelerates 10s timer to 100ms AND makes execFileSync throw EAGAIN after initial call
    const flakyPreload = join(stateDir, 'flaky-tmux.js')
    writeFileSync(flakyPreload, `const cp = require('node:child_process');
const origExec = cp.execFileSync;
let calls = 0;
cp.execFileSync = function(cmd, args, opts) {
  if (String(cmd).includes('tmux') || cmd === 'ps') {
    calls++;
    if (calls > 2) {
      const e = new Error('transient EAGAIN');
      e.stderr = Buffer.from('transient EAGAIN');
      throw e;
    }
  }
  return origExec.call(this, cmd, args, opts);
};
const origSI = globalThis.setInterval;
globalThis.setInterval = (cb, ms, ...a) => origSI(cb, ms === 10000 ? 100 : ms, ...a);`)

    try {
      const spawnSeat = async (instanceId: string, preload?: string) => {
        const c = new Client({ name: `n2-${instanceId}`, version: '1' })
        await c.connect(new StdioClientTransport({
          command: process.execPath,
          args: [...(preload ? ['--preload', preload] : []), join(import.meta.dir, '..', 'plugin.ts')],
          stderr: 'ignore',
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: stateDir,
            TMUX_TMPDIR: stateDir,
            DISCORD_AGENT: 'agy',
            DISCORD_HOST_LABEL: 'mac',
            DISCORD_INSTANCE_ID: instanceId,
            DISCORD_PARENT_PID: String(process.pid),
            DISCORD_STATE_DIR: stateDir,
            DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
            SWARM_ID: 'cfd',
          },
        }))
        return c
      }

      // Phase 1: config present -> seat gets agy@mac:cfd/<dir>-2, persisted in cfd:n2-1 & swarm-state
      configured = true
      const c1 = await spawnSeat('n2-1')
      await waitFor(() => registers.length === 1)
      const n2StateFile = join(stateDir, 'swarm-state', `${createHash('sha256').update('n2-1').digest('hex')}.json`)
      await waitFor(() => existsSync(n2StateFile))
      await c1.close()
      await waitFor(() => openSockets === 0)

      // Phase 2: config removed -> first register asks for stale cfd/<dir>-2, router returns swarm:'default'
      // without swarmConfigured -> plugin immediately closes & reconnects with plain agy@mac:<dir>,
      // leaves default assigned-aliases clean, removes swarm-state, and holds exactly 1 socket!
      configured = false
      const before = registers.length
      const c2 = await spawnSeat('n2-1')
      await waitFor(() => registers.length >= before + 2)
      await new Promise(r => setTimeout(r, 250))
      expect(registers.length).toBe(before + 2)
      expect(registers[before + 1]!.name).toBe(`agy@mac:${dirName}`)
      expect(openSockets).toBe(1)
      expect(existsSync(n2StateFile)).toBe(false)
      const defAssignedFile = join(stateDir, 'assigned-aliases', createHash('sha256').update('n2-1').digest('hex'))
      expect(existsSync(defAssignedFile)).toBe(false)
      await c2.close()
      await waitFor(() => openSockets === 0)

      // R2-M2 end-to-end: transient tmux/ps lookup failure on 10s timer triggers ZERO reconnects!
      configured = true
      const beforeM2 = registers.length
      const cM2 = await spawnSeat('m2-flaky', flakyPreload)
      await waitFor(() => registers.length === beforeM2 + 1)
      await new Promise(r => setTimeout(r, 400))
      expect(registers.length).toBe(beforeM2 + 1)
      expect(openSockets).toBe(1)
      await cM2.close()
    } finally {
      mockRouter.stop(true)
    }
  }, 20_000)

  test('M1, M4, m5: pinned name not saved as assigned, failed in-place re-register reconnects, secret reject uses exponential backoff, batched ps helper', async () => {
    // Pure unit check for batched ps + ancestor walk (m5)
    const ppids = parsePsPpidTable('  100 1\n  200 100\n  300 200\n')
    const panes = parseTmuxPanes('100 %7 @3\n')
    expect(findAncestorTmuxPane('300', ppids, panes)).toEqual({ paneId: '%7', windowId: '@3' })
    expect(findAncestorTmuxPane('999', ppids, panes)).toBeUndefined()

    const stateDir = tempDir()
    const registers: Array<Record<string, unknown>> = []
    let scenario: 'pinned' | 'rereg-fail' | 'bad-secret' = 'pinned'
    let activeWs: { send(m: string): void } | null = null
    let reregCalls = 0
    const mockRouter = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg.type === 'rename') {
            ws.send(JSON.stringify({ type: 'renamed', requestId: msg.requestId, oldName: 'old', newName: msg.name }))
            return
          }
          if (msg.type !== 'register') return
          registers.push(msg)
          activeWs = ws
          if (scenario === 'pinned') {
            ws.send(JSON.stringify({ type: 'registered', name: msg.name, swarm: 'cfd', defaultSessions: ['agents'], swarmConfigured: true }))
          } else if (scenario === 'rereg-fail') {
            reregCalls++
            if (reregCalls === 1) {
              ws.send(JSON.stringify({ type: 'registered', name: msg.name, swarm: 'default', defaultSessions: ['agents'], swarmConfigured: true }))
            } else if (reregCalls === 2) {
              // Fail the in-place re-register after swarm_changed (M4)
              ws.send(JSON.stringify({ type: 'error', message: 'register rejected: unknown_swarm' }))
            } else {
              ws.send(JSON.stringify({ type: 'registered', name: msg.name, swarm: 'cfd', defaultSessions: ['agents'], swarmConfigured: true }))
            }
          } else {
            // m5: bad router secret must use exponential backoff (~1s), NOT 60s
            ws.send(JSON.stringify({ type: 'error', message: 'register rejected: bad or missing router secret' }))
          }
        },
      },
    })

    const fastClock = join(stateDir, 'fast-clock.js')
    writeFileSync(fastClock, `const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (cb, ms, ...a) => origSetTimeout(cb, ms === 60000 ? 150 : ms, ...a);`)

    try {
      // M1: Pinned DISCORD_SESSION_NAME is never saved as assignedAlias and keeps takeover:true on reconnect
      scenario = 'pinned'
      const spawnPinned = async () => {
        const c = new Client({ name: 'pinned', version: '1' })
        await c.connect(new StdioClientTransport({
          command: process.execPath,
          args: [join(import.meta.dir, '..', 'plugin.ts')],
          stderr: 'ignore',
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: stateDir,
            TMUX_TMPDIR: stateDir,
            DISCORD_AGENT: 'claude',
            DISCORD_HOST_LABEL: 'mac',
            DISCORD_SESSION_NAME: 'claude@mac:cfd-master',
            DISCORD_INSTANCE_ID: 'pin-1',
            DISCORD_PARENT_PID: String(process.pid),
            DISCORD_STATE_DIR: stateDir,
            DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
            SWARM_ID: 'cfd',
          },
        }))
        return c
      }
      const p1 = await spawnPinned()
      await waitFor(() => registers.length === 1)
      const assignedHash = createHash('sha256').update('cfd:pin-1').digest('hex')
      expect(existsSync(join(stateDir, 'assigned-aliases', assignedHash))).toBe(false)
      await p1.close()

      const p2 = await spawnPinned()
      await waitFor(() => registers.length === 2)
      expect(registers[1]!.name).toBe('claude@mac:cfd-master')
      expect(registers[1]!.takeover).toBe(true)
      await p2.close()

      // M4: Failed in-place re-register after swarm_changed closes socket and reconnects
      scenario = 'rereg-fail'
      const cM4 = new Client({ name: 'm4', version: '1' })
      await cM4.connect(new StdioClientTransport({
        command: process.execPath,
        args: ['--preload', fastClock, join(import.meta.dir, '..', 'plugin.ts')],
        stderr: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: stateDir,
          TMUX_TMPDIR: stateDir,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'm4-1',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
          SWARM_ID: 'agents',
        },
      }))
      await waitFor(() => reregCalls === 1 && activeWs !== null)
      activeWs!.send(JSON.stringify({ type: 'swarm_changed', swarm: 'cfd' }))
      // Call 2 fails in-place -> plugin closes & reconnects -> call 3 succeeds!
      await waitFor(() => reregCalls >= 3)
      await cM4.close()

      // m5: Bad router secret retries with exponential backoff (~1s), NOT 60s (NO fastClock!)
      scenario = 'bad-secret'
      const beforeSecret = registers.length
      const cSec = new Client({ name: 'sec', version: '1' })
      await cSec.connect(new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, '..', 'plugin.ts')],
        stderr: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: stateDir,
          TMUX_TMPDIR: stateDir,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'sec-1',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
          SWARM_ID: 'agents',
        },
      }))
      // Without fastClock, a 60s timer would time out here; exponential backoff (~1s) retries well within 4s!
      await waitFor(() => registers.length >= beforeSecret + 2, 4_000)
      await cSec.close()
    } finally {
      mockRouter.stop(true)
    }
  }, 20_000)

  test('B3 & §8 wake tests: agents wakes, DISCORD_WAKE_PANE precedence & own/foreign daemon filtering, move-window re-registers, grouped session uses session_group', async () => {
    const tmuxBin = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(p => existsSync(p))
    if (!tmuxBin) return // skip only on hosts without tmux

    const stateDir = tempDir()
    const tmuxTmp = mkdtempSync(join(tmpdir(), 'mcd-tmux-'))
    dirs.push(tmuxTmp)
    const tmuxEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: stateDir,
      TMUX_TMPDIR: tmuxTmp,
    }
    const tmux = (...args: string[]) =>
      execFileSync(tmuxBin, args, { env: tmuxEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

    // Fast timers preload: wake debounce 2000ms -> 50ms, 10s re-check -> 150ms
    const fastTimers = join(stateDir, 'fast-timers.js')
    writeFileSync(fastTimers, `const origST = globalThis.setTimeout;
const origSI = globalThis.setInterval;
globalThis.setTimeout = (cb, ms, ...a) => origST(cb, ms === 2000 ? 50 : ms, ...a);
globalThis.setInterval = (cb, ms, ...a) => origSI(cb, ms === 10000 ? 150 : ms, ...a);`)

    const registers: Array<{ msg: Record<string, unknown>; ws: { send(m: string): void } }> = []
    let swarmConfiguredFlag = true
    const mockRouter = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg.type === 'register') {
            registers.push({ msg, ws })
            const rawSwarm = typeof msg.swarm === 'string' ? msg.swarm : 'default'
            const swarm = !swarmConfiguredFlag || rawSwarm === 'agents' || rawSwarm === 'default' ? 'default' : rawSwarm
            const name = swarm === 'default' ? String(msg.name) : String(msg.name).replace(':', `:${swarm}/`)
            ws.send(JSON.stringify({
              type: 'registered',
              name,
              swarm,
              defaultSessions: ['agents'],
              ...(swarmConfiguredFlag && { swarmConfigured: true }),
            }))
          }
        },
      },
    })

    const pluginPath = join(import.meta.dir, '..', 'plugin.ts')
    try {
      // Create isolated tmux sessions: "agents" and "cfd" + grouped session "cfd-view" -> group "cfd"
      tmux('new-session', '-d', '-s', 'agents', '-x', '120', '-y', '30', 'sh')
      tmux('new-session', '-d', '-s', 'cfd', '-x', '120', '-y', '30', 'sh')
      const agentsPane = tmux('display-message', '-p', '-t', 'agents:0.0', '#{pane_id}')
      const cfdPane = tmux('display-message', '-p', '-t', 'cfd:0.0', '#{pane_id}')

      // §8.2a: Daemon (no own pane, SWARM_ID=cfd) with own-swarm DISCORD_WAKE_PANE wakes cfd pane!
      swarmConfiguredFlag = true
      const dOwn = new Client({ name: 'daemon-own', version: '1' })
      await dOwn.connect(new StdioClientTransport({
        command: process.execPath,
        args: ['--preload', fastTimers, pluginPath],
        stderr: 'ignore',
        env: {
          ...tmuxEnv,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'd-own',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
          DISCORD_WAKE: 'tmux',
          DISCORD_WAKE_PANE: cfdPane,
          DISCORD_WAKE_TEXT: 'WAKE_CFD_OWN_OK',
          SWARM_ID: 'cfd',
        },
      }))
      await waitFor(() => registers.length === 1)
      registers[0]!.ws.send(JSON.stringify({ type: 'message', content: 'ping', meta: { chat_id: '1', message_id: 'm1', user: 'mick', ts: '' } }))
      await waitFor(() => tmux('capture-pane', '-p', '-t', cfdPane).includes('WAKE_CFD_OWN_OK'))
      await dOwn.close()

      // §8.2b: Daemon (no own pane, SWARM_ID=cfd) with FOREIGN-swarm DISCORD_WAKE_PANE (agentsPane) ignores it & warns!
      let foreignStderr = ''
      const foreignTransport = new StdioClientTransport({
        command: process.execPath,
        args: ['--preload', fastTimers, pluginPath],
        stderr: 'pipe',
        env: {
          ...tmuxEnv,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'd-foreign',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
          DISCORD_WAKE: 'tmux',
          DISCORD_WAKE_PANE: agentsPane,
          DISCORD_WAKE_TEXT: 'WAKE_FOREIGN_FORBIDDEN',
          SWARM_ID: 'cfd',
        },
      })
      foreignTransport.stderr?.on('data', (chunk: Buffer) => { foreignStderr += chunk.toString('utf8') })
      const dForeign = new Client({ name: 'daemon-foreign', version: '1' })
      await dForeign.connect(foreignTransport)
      await waitFor(() => registers.length === 2)
      registers[1]!.ws.send(JSON.stringify({ type: 'message', content: 'ping', meta: { chat_id: '1', message_id: 'm2', user: 'mick', ts: '' } }))
      await new Promise(r => setTimeout(r, 250))
      expect(tmux('capture-pane', '-p', '-t', agentsPane)).not.toContain('WAKE_FOREIGN_FORBIDDEN')
      expect(foreignStderr).toContain('ignoring DISCORD_WAKE_PANE')
      await dForeign.close()

      // B3 no-config precedence: with NO swarms-config.json, DISCORD_WAKE_PANE wins even when own pane exists
      // AND §8.1 agents still wakes + §8.3 move-window re-registers + §8.4 grouped session uses session_group!
      // Spawn plugin inside a new window in "agents" so it has a real own pane!
      const moveWinPane = tmux(
        'new-window', '-P', '-F', '#{pane_id}', '-t', 'agents',
        `sh -c 'tail -f /dev/null | TMUX_TMPDIR=${tmuxTmp} DISCORD_AGENT=agy DISCORD_HOST_LABEL=mac DISCORD_INSTANCE_ID=in-tmux-1 DISCORD_STATE_DIR=${stateDir} DISCORD_ROUTER_URL=ws://127.0.0.1:${mockRouter.port} DISCORD_WAKE=tmux DISCORD_WAKE_PANE=${agentsPane} DISCORD_WAKE_TEXT=WAKE_AGENTS_OWN ${process.execPath} --preload ${fastTimers} ${pluginPath} 2>${stateDir}/in-tmux.err'`,
      )
      await waitFor(() => registers.length === 3)
      expect(registers[2]!.msg.swarm).toBe('agents')
      // Configured router: own pane (moveWinPane) wins over DISCORD_WAKE_PANE (agentsPane) and logs warning!
      await waitFor(() => existsSync(`${stateDir}/in-tmux.err`) && Bun.file(`${stateDir}/in-tmux.err`).size > 0)
      registers[2]!.ws.send(JSON.stringify({ type: 'message', content: 'wake-own', meta: { chat_id: '1', message_id: 'm3', user: 'mick', ts: '' } }))
      await waitFor(() => tmux('capture-pane', '-p', '-t', moveWinPane).includes('WAKE_AGENTS_OWN'))
      expect(await Bun.file(`${stateDir}/in-tmux.err`).text()).toContain('differs from own pane')

      // §8.3: move-window from "agents" to "cfd" -> plugin re-registers with swarm='cfd'!
      const moveWinId = tmux('display-message', '-p', '-t', moveWinPane, '#{window_id}')
      tmux('move-window', '-s', moveWinId, '-t', 'cfd:')
      await waitFor(() => registers.length >= 4)
      expect(registers[3]!.msg.swarm).toBe('cfd')

      // §8.4: grouped session "cfd-view" grouped with "cfd" reports session_group "cfd" (not "cfd-view")!
      tmux('new-session', '-d', '-t', 'cfd', '-s', 'cfd-view', '-x', '120', '-y', '30')
      const groupPane = tmux(
        'new-window', '-P', '-F', '#{pane_id}', '-t', 'cfd-view',
        `sh -c 'tail -f /dev/null | TMUX_TMPDIR=${tmuxTmp} DISCORD_AGENT=agy DISCORD_HOST_LABEL=mac DISCORD_INSTANCE_ID=grp-1 DISCORD_STATE_DIR=${stateDir} DISCORD_ROUTER_URL=ws://127.0.0.1:${mockRouter.port} ${process.execPath} ${pluginPath} 2>/dev/null'`,
      )
      await waitFor(() => registers.some(r => r.msg.instanceId === 'grp-1'))
      const grpReg = registers.find(r => r.msg.instanceId === 'grp-1')!
      expect(grpReg.msg.swarm).toBe('cfd')

      // B3 no-config: with swarmConfigured unset, DISCORD_WAKE_PANE wins over own pane!
      swarmConfiguredFlag = false
      const noCfgPane = tmux(
        'new-window', '-P', '-F', '#{pane_id}', '-t', 'agents',
        `sh -c 'tail -f /dev/null | TMUX_TMPDIR=${tmuxTmp} DISCORD_AGENT=agy DISCORD_HOST_LABEL=mac DISCORD_INSTANCE_ID=nocfg-wake DISCORD_STATE_DIR=${stateDir} DISCORD_ROUTER_URL=ws://127.0.0.1:${mockRouter.port} DISCORD_WAKE=tmux DISCORD_WAKE_PANE=${agentsPane} DISCORD_WAKE_TEXT=WAKE_NOCFG_ENV_WINS ${process.execPath} --preload ${fastTimers} ${pluginPath} 2>/dev/null'`,
      )
      await waitFor(() => registers.some(r => r.msg.instanceId === 'nocfg-wake'))
      const noCfgReg = registers.find(r => r.msg.instanceId === 'nocfg-wake')!
      noCfgReg.ws.send(JSON.stringify({ type: 'message', content: 'wake-env', meta: { chat_id: '1', message_id: 'm4', user: 'mick', ts: '' } }))
      await waitFor(() => tmux('capture-pane', '-p', '-t', agentsPane).includes('WAKE_NOCFG_ENV_WINS'))
      expect(tmux('capture-pane', '-p', '-t', noCfgPane)).not.toContain('WAKE_NOCFG_ENV_WINS')

      // N3: with NO config, move-window does NOT trigger a reconnect!
      const noCfgWinId = tmux('display-message', '-p', '-t', noCfgPane, '#{window_id}')
      tmux('move-window', '-s', noCfgWinId, '-t', 'cfd:')
      await new Promise(r => setTimeout(r, 400))
      expect(registers.filter(r => r.msg.instanceId === 'nocfg-wake')).toHaveLength(1)

      // N5: with NO config, no own pane, and no DISCORD_WAKE_PANE, falls back to TMUX_PANE!
      const dTmuxPane = new Client({ name: 'nocfg-tmux-pane', version: '1' })
      await dTmuxPane.connect(new StdioClientTransport({
        command: process.execPath,
        args: ['--preload', fastTimers, pluginPath],
        stderr: 'ignore',
        env: {
          ...tmuxEnv,
          TMUX_PANE: agentsPane,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'nocfg-tp',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${mockRouter.port}`,
          DISCORD_WAKE: 'tmux',
          DISCORD_WAKE_TEXT: 'WAKE_TMUX_PANE_FALLBACK',
        },
      }))
      await waitFor(() => registers.some(r => r.msg.instanceId === 'nocfg-tp'))
      const tpReg = registers.find(r => r.msg.instanceId === 'nocfg-tp')!
      tpReg.ws.send(JSON.stringify({ type: 'message', content: 'wake-tp', meta: { chat_id: '1', message_id: 'm5', user: 'mick', ts: '' } }))
      await waitFor(() => tmux('capture-pane', '-p', '-t', agentsPane).includes('WAKE_TMUX_PANE_FALLBACK'))
      await dTmuxPane.close()
      void groupPane
    } finally {
      try { tmux('kill-server') } catch {}
      mockRouter.stop(true)
    }
  }, 25_000)

  test('impl-plan-v2 #32-1, #32-2, #32-3: reRegisterInPlace aborts on detection failure, rollback hint keeps :cfd/ on pre-swarm router, killed latch stays alive under supervisor without respawn', async () => {
    const stateDir = tempDir()
    const dirName = basename(process.cwd())
    const pluginPath = join(import.meta.dir, '..', 'plugin.ts')
    const supervisorPath = join(import.meta.dir, '..', 'supervisor.ts')
    const repoRoot = join(import.meta.dir, '..', '..')

    // --- #32-1: reRegisterInPlace aborts and reconnects when detectSwarmAndPane fails ---
    const reregFrames: Array<{ connId: number; msg: Record<string, unknown> }> = []
    let nextConnId = 0
    let closeCount321 = 0
    let activeWs321: { send(m: string): void } | null = null
    const server321 = Bun.serve<{ connId: number }>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req, { data: { connId: ++nextConnId } })) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg.type === 'rename') {
            ws.send(JSON.stringify({ type: 'renamed', requestId: msg.requestId, oldName: 'old', newName: msg.name }))
            return
          }
          if (msg.type !== 'register') return
          activeWs321 = ws
          reregFrames.push({ connId: ws.data.connId, msg })
          ws.send(JSON.stringify({
            type: 'registered',
            name: String(msg.name),
            swarm: 'default',
            defaultSessions: ['agents'],
            swarmConfigured: true,
          }))
        },
        close() { closeCount321++ },
      },
    })
    // Preload: fail execFileSync(tmux/ps) ONLY on the 3rd invocation (which is detectSwarmAndPane inside reRegisterInPlace)
    const failOnReregPreload = join(stateDir, 'fail-rereg.js')
    writeFileSync(failOnReregPreload, `const cp = require('node:child_process');
const origExec = cp.execFileSync;
let tmuxCalls = 0;
cp.execFileSync = function(cmd, args, opts) {
  if (String(cmd).includes('tmux')) {
    tmuxCalls++;
    if (tmuxCalls === 3) {
      const e = new Error('transient EAGAIN');
      e.stderr = Buffer.from('transient EAGAIN');
      throw e;
    }
  }
  return origExec.call(this, cmd, args, opts);
};
const origST = globalThis.setTimeout;
globalThis.setTimeout = (cb, ms, ...a) => origST(cb, ms >= 500 && ms <= 5000 ? 80 : ms, ...a);`)

    // --- #32-2: Rollback hint across multi-swarm -> pre-swarm -> multi-swarm (cfg) -> multi-swarm (no cfg) ---
    let rbMode: 'multi-cfg' | 'pre-swarm' | 'multi-nocfg' = 'multi-cfg'
    const rbRegisters: Array<Record<string, unknown>> = []
    let rbOpenSockets = 0
    let rbActiveWs: { close(): void } | null = null
    const server322 = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        open() { rbOpenSockets++ },
        close() { rbOpenSockets-- },
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg.type === 'rename') {
            ws.send(JSON.stringify({ type: 'renamed', requestId: msg.requestId, oldName: 'old', newName: msg.name }))
            return
          }
          if (msg.type !== 'register') return
          rbActiveWs = ws
          rbRegisters.push(msg)
          if (rbMode === 'pre-swarm') {
            // Pre-swarm router: no swarm, no defaultSessions, no swarmConfigured; echoes msg.name verbatim!
            ws.send(JSON.stringify({ type: 'registered', name: String(msg.name) }))
          } else if (rbMode === 'multi-cfg') {
            // Idempotent rewrite like PR1a rewriteGeneratedSwarmName
            const rawName = String(msg.name)
            const name = msg.generated && !rawName.includes(':cfd/') ? rawName.replace(':', ':cfd/') : rawName
            ws.send(JSON.stringify({ type: 'registered', name, swarm: 'cfd', defaultSessions: ['agents'], swarmConfigured: true }))
          } else {
            // Multi-swarm router with config removed
            ws.send(JSON.stringify({ type: 'registered', name: String(msg.name), swarm: 'default', defaultSessions: ['agents'] }))
          }
        },
      },
    })

    // --- #32-3: killed latch under supervisor.ts ---
    const killRegisters: Array<Record<string, unknown>> = []
    let killOpenSockets = 0
    let killActiveWs: { send(m: string): void; close(): void } | null = null
    const server323 = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return
        return new Response(null, { status: 400 })
      },
      websocket: {
        open() { killOpenSockets++ },
        close() { killOpenSockets-- },
        message(ws, raw) {
          const msg = JSON.parse(String(raw)) as Record<string, unknown>
          if (msg.type === 'register') {
            killActiveWs = ws
            killRegisters.push(msg)
            ws.send(JSON.stringify({
              type: 'registered',
              name: String(msg.name),
              swarm: 'cfd',
              defaultSessions: ['agents'],
              swarmConfigured: true,
            }))
          }
        },
      },
    })

    try {
      // Run #32-1
      const c321 = new Client({ name: 'test-321', version: '1' })
      await c321.connect(new StdioClientTransport({
        command: process.execPath,
        args: ['--preload', failOnReregPreload, pluginPath],
        stderr: 'ignore',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: stateDir,
          TMUX_TMPDIR: stateDir,
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'rereg-fail-det',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${server321.port}`,
          SWARM_ID: 'agents',
        },
      }))
      await waitFor(() => reregFrames.length === 1 && activeWs321 !== null)
      activeWs321!.send(JSON.stringify({ type: 'swarm_changed', swarm: 'cfd' }))
      // Detection failed -> must abort in-place re-register (NO second frame on connId 1), close socket, reconnect on connId 2!
      await waitFor(() => reregFrames.length >= 2)
      expect(closeCount321).toBeGreaterThanOrEqual(1)
      expect(reregFrames.filter(f => f.connId === 1)).toHaveLength(1)
      expect(reregFrames[1]!.connId).toBe(2)
      await c321.close()

      // Run #32-2
      const spawnRb = async () => {
        const c = new Client({ name: 'test-322', version: '1' })
        await c.connect(new StdioClientTransport({
          command: process.execPath,
          args: [pluginPath],
          stderr: 'ignore',
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: stateDir,
            TMUX_TMPDIR: stateDir,
            DISCORD_AGENT: 'agy',
            DISCORD_HOST_LABEL: 'mac',
            DISCORD_INSTANCE_ID: 'rb-seat-1',
            DISCORD_PARENT_PID: String(process.pid),
            DISCORD_STATE_DIR: stateDir,
            DISCORD_ROUTER_URL: `ws://127.0.0.1:${server322.port}`,
            SWARM_ID: 'cfd',
          },
        }))
        return c
      }
      const cfdGenName = `agy@mac:cfd/${dirName}`
      const plainName = `agy@mac:${dirName}`

      // Phase 1: multi-swarm configured router approves agy@mac:cfd/<dir> and caches rollback hint
      rbMode = 'multi-cfg'
      const rb1 = await spawnRb()
      await waitFor(() => rbRegisters.length === 1)
      await waitFor(() => loadPersistedSwarmState(stateDir, 'rb-seat-1')?.lastApprovedGeneratedName === cfdGenName)
      await rb1.close()
      await waitFor(() => rbOpenSockets === 0)

      // Phase 2: reconnect to PRE-SWARM router -> sends name: agy@mac:cfd/<dir> + generated: true, keeps :cfd/ without reconnecting!
      rbMode = 'pre-swarm'
      const rb2 = await spawnRb()
      await waitFor(() => rbRegisters.length === 2)
      await new Promise(r => setTimeout(r, 250))
      expect(rbRegisters).toHaveLength(2)
      expect(rbRegisters[1]!.name).toBe(cfdGenName)
      expect(rbRegisters[1]!.generated).toBe(true)
      expect(rbOpenSockets).toBe(1)
      // Default assigned-aliases stays clean and swarm-state is preserved across rollback!
      const defAssignedHash = createHash('sha256').update('rb-seat-1').digest('hex')
      expect(existsSync(join(stateDir, 'assigned-aliases', defAssignedHash))).toBe(false)
      expect(loadPersistedSwarmState(stateDir, 'rb-seat-1')?.lastApprovedGeneratedName).toBe(cfdGenName)

      // Phase 2b (Carbon Round-3): force a SECOND in-process WS reconnect to the same rolled-back pre-swarm router ->
      // STILL keeps :cfd/ AND STILL does NOT write into default's assigned-aliases!
      rbActiveWs!.close()
      await waitFor(() => rbRegisters.length === 3, 5_000)
      await new Promise(r => setTimeout(r, 200))
      expect(rbRegisters).toHaveLength(3)
      expect(rbRegisters[2]!.name).toBe(cfdGenName)
      expect(rbRegisters[2]!.generated).toBe(true)
      expect(existsSync(join(stateDir, 'assigned-aliases', defAssignedHash))).toBe(false)
      expect(loadPersistedSwarmState(stateDir, 'rb-seat-1')?.lastApprovedGeneratedName).toBe(cfdGenName)
      await rb2.close()
      await waitFor(() => rbOpenSockets === 0)

      // Phase 3: multi-swarm router back with config -> keeps agy@mac:cfd/<dir> (no cfd/cfd/ doubling)
      rbMode = 'multi-cfg'
      const rb3 = await spawnRb()
      await waitFor(() => rbRegisters.length === 4)
      await new Promise(r => setTimeout(r, 150))
      expect(rbRegisters).toHaveLength(4)
      expect(rbRegisters[3]!.name).toBe(cfdGenName)
      expect(rbRegisters[3]!.generated).toBe(true)
      await rb3.close()
      await waitFor(() => rbOpenSockets === 0)

      // Phase 4: multi-swarm router with config removed -> N2 returns seat to plain agy@mac:<dir> and clears swarm-state!
      rbMode = 'multi-nocfg'
      const rb4 = await spawnRb()
      await waitFor(() => rbRegisters.length >= 6)
      await new Promise(r => setTimeout(r, 200))
      expect(rbRegisters).toHaveLength(6)
      expect(rbRegisters[5]!.name).toBe(plainName)
      expect(loadPersistedSwarmState(stateDir, 'rb-seat-1')).toBeNull()
      await rb4.close()
      await waitFor(() => rbOpenSockets === 0)

      // Carbon re-review #32-2: explicit non-default bus_rename alias on pre-swarm rollback must NOT pollute default assigned-aliases!
      const spawnRbExplicit = async () => {
        const c = new Client({ name: 'test-322-exp', version: '1' })
        await c.connect(new StdioClientTransport({
          command: process.execPath,
          args: [pluginPath],
          stderr: 'ignore',
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: stateDir,
            TMUX_TMPDIR: stateDir,
            DISCORD_AGENT: 'agy',
            DISCORD_HOST_LABEL: 'mac',
            DISCORD_INSTANCE_ID: 'rb-exp-1',
            DISCORD_PARENT_PID: String(process.pid),
            DISCORD_STATE_DIR: stateDir,
            DISCORD_ROUTER_URL: `ws://127.0.0.1:${server322.port}`,
            SWARM_ID: 'cfd',
          },
        }))
        return c
      }
      rbMode = 'multi-cfg'
      const expBefore = rbRegisters.length
      const exp1 = await spawnRbExplicit()
      await waitFor(() => rbRegisters.length === expBefore + 1)
      const expRen = await exp1.callTool({ name: 'bus_rename', arguments: { name: 'agy@mac:cfd-lead' } })
      expect(expRen.isError).toBeFalsy()
      await exp1.close()
      await waitFor(() => rbOpenSockets === 0)

      // Reconnect to rolled-back pre-swarm router: keeps agy@mac:cfd-lead and leaves default assigned-aliases clean!
      rbMode = 'pre-swarm'
      const exp2 = await spawnRbExplicit()
      await waitFor(() => rbRegisters.length === expBefore + 2)
      await new Promise(r => setTimeout(r, 200))
      expect(rbRegisters[expBefore + 1]!.name).toBe('agy@mac:cfd-lead')
      const expDefAssignedHash = createHash('sha256').update('rb-exp-1').digest('hex')
      expect(existsSync(join(stateDir, 'assigned-aliases', expDefAssignedHash))).toBe(false)
      await exp2.close()
      await waitFor(() => rbOpenSockets === 0)

      // Later config removal on multi-swarm router (N2) returns cleanly to plain agy@mac:<dir>!
      rbMode = 'multi-nocfg'
      const exp3 = await spawnRbExplicit()
      await waitFor(() => rbRegisters.length >= expBefore + 4)
      await new Promise(r => setTimeout(r, 200))
      expect(rbRegisters[expBefore + 3]!.name).toBe(plainName)
      expect(existsSync(join(stateDir, 'assigned-aliases', expDefAssignedHash))).toBe(false)
      await exp3.close()
      await waitFor(() => rbOpenSockets === 0)

      // Run #32-3: Spawn plugin via supervisor.ts, send { type: 'killed', reconnect: false }, verify NO respawn & MCP error
      let supStderr = ''
      const supTransport = new StdioClientTransport({
        command: process.execPath,
        args: [supervisorPath],
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: stateDir,
          TMUX_TMPDIR: stateDir,
          DISCORD_CLIENT_DIR: repoRoot,
          DISCORD_UPDATE_INTERVAL: '0',
          DISCORD_AGENT: 'agy',
          DISCORD_HOST_LABEL: 'mac',
          DISCORD_INSTANCE_ID: 'sup-kill-1',
          DISCORD_PARENT_PID: String(process.pid),
          DISCORD_STATE_DIR: stateDir,
          DISCORD_ROUTER_URL: `ws://127.0.0.1:${server323.port}`,
          SWARM_ID: 'cfd',
        },
      })
      supTransport.stderr?.on('data', (chunk: Buffer) => { supStderr += chunk.toString('utf8') })
      const supClient = new Client({ name: 'test-323-sup', version: '1' })
      await supClient.connect(supTransport)
      await waitFor(() => killRegisters.length === 1 && killActiveWs !== null)
      expect(killOpenSockets).toBe(1)

      // Router sends killed frame and closes socket (just like /kill)
      killActiveWs!.send(JSON.stringify({ type: 'killed', reconnect: false, reason: 'killed_by_operator' }))
      killActiveWs!.close()
      await waitFor(() => killOpenSockets === 0)

      // Wait 1.5s (> supervisor's 1000ms restart timer & plugin's 1000ms first backoff): zero reconnects, zero respawns!
      await new Promise(r => setTimeout(r, 1_500))
      expect(killRegisters).toHaveLength(1)
      expect(killOpenSockets).toBe(0)
      expect(supStderr).not.toContain('client exited')
      expect(supStderr).not.toContain('restarting')

      // MCP tool calls still respond cleanly (process alive!) with "session killed by operator"
      const toolAfterKill = await supClient.callTool({ name: 'bus_sessions', arguments: {} })
      expect(toolAfterKill.isError).toBe(true)
      expect(JSON.stringify(toolAfterKill.content)).toContain('session killed by operator')
      await supClient.close()
    } finally {
      server321.stop(true)
      server322.stop(true)
      server323.stop(true)
    }
  }, 25_000)
})
