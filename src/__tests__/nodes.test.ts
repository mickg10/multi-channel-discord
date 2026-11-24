import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { createWsHandlers, deliver } from '../ws.js'
import type { WsData, WsDeps } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { Inboxes, NodeRegistry } from '../nodes.js'
import { Subscriptions } from '../subscriptions.js'
import { buildCommand, parseTurnOutput, bootstrapPrompt } from '../node.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface MockWs { data: WsData; send: ReturnType<typeof mock> }
const makeWs = (): MockWs => ({ data: { sessionName: null, sendCallback: null }, send: mock((_m: string) => {}) })
const msgs = (ws: MockWs) => ws.send.mock.calls.map(c => JSON.parse(String(c[0])))
const tick = () => new Promise(r => setTimeout(r, 15))

let sessions: SessionManager, history: ProjectHistory, inboxes: Inboxes, nodes: NodeRegistry, posted: Array<[string, string]>
function deps(extra: Partial<WsDeps> = {}): WsDeps {
  return {
    sessions, history, inboxes, nodes,
    client: { channels: { fetch: mock(async (id: string) => ({ isTextBased: () => true, send: mock(async (p: any) => { posted.push([id, typeof p === 'string' ? p : p.content]); return {} }) })) } } as any,
    chatId: () => 'dm1', chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
    busChannelId: 'bus1', humanChannelId: 'hq1', subs: new Subscriptions(), ...extra,
  }
}
const reg = (h: any, name: string, mode?: string) => { const ws = makeWs(); h.message(ws, JSON.stringify({ type: 'register', name, projectPath: '/p', ...(mode && { mode }) })); return ws }
const regNode = (h: any, node: string, agents: string[]) => { const ws = makeWs(); h.message(ws, JSON.stringify({ type: 'registerNode', node, agents: agents.map(n => ({ name: n, kind: 'codex' })) })); return ws }

beforeEach(async () => {
  sessions = new SessionManager(); history = new ProjectHistory(await mkdtemp(join(tmpdir(), 'n-')))
  inboxes = new Inboxes(); nodes = new NodeRegistry(); posted = []
})

describe('node agents', () => {
  test('message to an idle node agent is queued and the node is woken', async () => {
    const h = createWsHandlers(deps())
    const nodeWs = regNode(h, 'nas642', ['codex@nas642:photos'])
    const a = reg(h, 'claude@mac:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'hi photos', to: 'codex@nas642:photos' }))
    await tick()
    expect(inboxes.count('codex@nas642:photos')).toBe(1)
    expect(msgs(nodeWs).find(m => m.type === 'wake')).toMatchObject({ agent: 'codex@nas642:photos', pending: 1 })
  })

  test('pull-mode session drains the queue with inboxPull; node can count', async () => {
    const h = createWsHandlers(deps())
    const nodeWs = regNode(h, 'n', ['agy@n:x'])
    deliver(deps(), 'agy@n:x', 'one', { from: 'h' })
    h.message(nodeWs as any, JSON.stringify({ type: 'inboxCount', requestId: 'c1', agent: 'agy@n:x' }))
    expect(msgs(nodeWs).find(m => m.requestId === 'c1').data).toBe('1')
    const s = reg(h, 'agy@n:x', 'pull')
    deliver(deps(), 'agy@n:x', 'two', { from: 'h' })   // live pull session: queued, not pushed
    expect(msgs(s).some(m => m.type === 'message')).toBe(false)
    h.message(s as any, JSON.stringify({ type: 'inboxPull', requestId: 'p1' }))
    expect(JSON.parse(msgs(s).find(m => m.requestId === 'p1').data).map((q: any) => q.content)).toEqual(['one', 'two'])
    expect(inboxes.count('agy@n:x')).toBe(0)
  })

  test('queued mail is pushed when a push-mode session connects', () => {
    const h = createWsHandlers(deps())
    regNode(h, 'n', ['claude@n:x'])
    deliver(deps(), 'claude@n:x', 'while you were away', { from: 'h' })
    const s = reg(h, 'claude@n:x')
    expect(msgs(s).find(m => m.type === 'message').content).toBe('while you were away')
  })

  test('node agents appear in listSessions as idle with pending count', () => {
    const h = createWsHandlers(deps())
    regNode(h, 'n', ['codex@n:y'])
    deliver(deps(), 'codex@n:y', 'x', {})
    const a = reg(h, 'claude@mac:src')
    h.message(a as any, JSON.stringify({ type: 'listSessions', requestId: 'l' }))
    const list = JSON.parse(msgs(a).find(m => m.requestId === 'l').data)
    expect(list.find((s: any) => s.name === 'codex@n:y')).toMatchObject({ state: 'idle', node: 'n', pending: 1 })
  })

  test('broadcast reaches node agents; node disconnect removes them', async () => {
    const h = createWsHandlers(deps())
    const nodeWs = regNode(h, 'n', ['codex@n:z'])
    const a = reg(h, 'claude@mac:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'all hands' }))
    expect(inboxes.count('codex@n:z')).toBe(1)
    h.close(nodeWs as any)
    expect(nodes.list()).toHaveLength(0)
  })
})

describe('human channel + rules + archive', () => {
  test('to=human lands in the human channel tagged with origin, no fan-out', async () => {
    const h = createWsHandlers(deps())
    const a = reg(h, 'claude@mac:src'); const b = reg(h, 'codex@mac')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'may I reboot?', to: 'human' }))
    await tick()
    expect(posted[0][0]).toBe('hq1')
    expect(posted[0][1]).toContain('[claude@mac:src → human]** (from #general) may I reboot?')
    expect(msgs(b).some(m => m.type === 'message')).toBe(false)
  })

  test('rules are delivered once per session name', () => {
    const seen = new Set<string>()
    const h = createWsHandlers(deps({ rules: () => ({ text: 'RULES', seen: n => seen.has(n), markSeen: n => { seen.add(n) } }) }))
    const s1 = reg(h, 'claude@mac:src')
    expect(msgs(s1).filter(m => m.type === 'message' && m.content === 'RULES')).toHaveLength(1)
    h.close(s1 as any)
    const s2 = reg(h, 'claude@mac:src')
    expect(msgs(s2).some(m => m.content === 'RULES')).toBe(false)
  })

  test('channel_archive moves subscribers to the replacement', async () => {
    const subs = new Subscriptions()
    const chans = [{ id: 'old', name: 'infra-security' }, { id: 'new', name: 'security-hardening' }]
    const archived: string[] = []
    const h = createWsHandlers(deps({ subs, channelOps: {
      resolve: async (r: string) => chans.find(c => c.id === r || c.name === r) ?? null,
      list: async () => chans, create: async () => chans[0], archive: async (id: string) => { archived.push(id) },
    } }))
    const a = reg(h, 'claude@mac:src')
    subs.add('x', 'new'); subs.add('y', 'new')
    h.message(a as any, JSON.stringify({ type: 'channelArchive', requestId: 'r', channel: 'security-hardening', replacement: 'infra-security' }))
    await tick()
    expect(archived).toEqual(['new'])
    expect(subs.subscribers('old').sort()).toEqual(['x', 'y'])
    expect(subs.subscribers('new')).toEqual([])
  })
})

describe('node daemon command lines', () => {
  const a = { name: 'codex@nas642:photos', kind: 'codex' as const, args: ['--dangerously-bypass-approvals-and-sandbox'] }
  test('codex resume puts options before "resume <id> <prompt>" and wires MCP env', () => {
    const { cmd, args } = buildCommand(a, 'T1', 'PROMPT', { claudePlugin: false })
    expect(cmd).toBe('codex')
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check'])
    expect(args.slice(-3)).toEqual(['resume', 'T1', 'PROMPT'])
    expect(args).toContain('mcp_servers.discord.env.DISCORD_SESSION_NAME="codex@nas642:photos"')
    expect(args).toContain('mcp_servers.discord.env.DISCORD_MODE="pull"')
  })
  test('claude uses --resume and allows the plugin tools', () => {
    const { args } = buildCommand({ name: 'claude@m:x', kind: 'claude' }, 'S1', 'P', { claudePlugin: true })
    expect(args).toEqual(expect.arrayContaining(['-p', 'P', '--output-format', 'json', '--resume', 'S1']))
    expect(args[args.indexOf('--allowedTools') + 1]).toContain('mcp__plugin_discord_discord__check_inbox')
  })
  test('agy uses --conversation', () => {
    const { args } = buildCommand({ name: 'agy@m:x', kind: 'agy' }, 'C1', 'P', { claudePlugin: false })
    expect(args).toEqual(['-p', 'P', '--output-format', 'json', '--conversation', 'C1'])
  })
  test('parse outputs', () => {
    expect(parseTurnOutput('codex', '{"type":"thread.started","thread_id":"T9"}\n{"type":"item.completed","item":{"type":"agent_message","text":"done"}}')).toEqual({ session: 'T9', summary: 'done', error: undefined })
    expect(parseTurnOutput('claude', '{"session_id":"S9","result":"ok","is_error":false}')).toMatchObject({ session: 'S9', summary: 'ok' })
    expect(parseTurnOutput('agy', '{"conversation_id":"C9","status":"SUCCESS","response":"hi"}')).toMatchObject({ session: 'C9', summary: 'hi' })
  })
  test('bootstrap prompt names the agent and forbids interactive input', () => {
    const p = bootstrapPrompt({ name: 'agy@m:x', kind: 'agy', role: 'photo QA' }, 'm')
    expect(p).toContain('"agy@m:x"'); expect(p).toContain('check_inbox'); expect(p).toContain('photo QA')
  })
})
