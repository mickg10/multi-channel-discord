import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { createWsHandlers, deliver, resetBusRateLimit } from '../ws.js'
import type { WsData, WsDeps } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { Inboxes, NodeRegistry } from '../nodes.js'
import { Conversations, Unread, WakeBudget } from '../wake.js'
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
    client: { channels: { fetch: mock(async (id: string) => ({ isTextBased: () => true, send: mock(async (p: any) => { posted.push([id, typeof p === 'string' ? p : p.content]); return { id: 'mid' } }) })) } } as any,
    chatId: () => 'dm1', chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
    busChannelId: 'bus1', humanChannelId: 'hq1', subs: new Subscriptions(), ...extra,
  }
}
const reg = (h: any, name: string, mode?: string) => { const ws = makeWs(); h.message(ws, JSON.stringify({ type: 'register', name, projectPath: '/p', ...(mode && { mode }) })); return ws }
const regNode = (h: any, node: string, agents: string[]) => { const ws = makeWs(); h.message(ws, JSON.stringify({ type: 'registerNode', node, agents: agents.map(n => ({ name: n, kind: 'codex' })) })); return ws }

beforeEach(async () => {
  sessions = new SessionManager(); history = new ProjectHistory(await mkdtemp(join(tmpdir(), 'n-')))
  inboxes = new Inboxes(); nodes = new NodeRegistry(); posted = []
  resetBusRateLimit()
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

  test('untargeted busPost does not queue or wake a node agent', async () => {
    const unread = new Unread()
    const h = createWsHandlers(deps({ unread }))
    const nodeWs = regNode(h, 'n', ['codex@n:z'])
    const a = reg(h, 'claude@mac:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'all hands' }))
    await tick()
    expect(inboxes.count('codex@n:z')).toBe(0)
    expect(unread.count('codex@n:z')).toBe(1)
    expect(msgs(nodeWs).filter(m => m.type === 'wake')).toHaveLength(0)
    h.close(nodeWs as any)
    expect(nodes.list()).toHaveLength(0)
  })

  test('100 passive posts wake nobody, and a fresh router does not replay them', async () => {
    const unread = new Unread()
    const h = createWsHandlers(deps({ unread, busMaxPerMinute: 500 }))
    const nodeWs = regNode(h, 'n', ['codex@n:a', 'agy@n:b'])
    const sender = reg(h, 'claude@mac:src')
    for (let i = 0; i < 100; i++) h.message(sender as any, JSON.stringify({ type: 'busPost', text: 'chatter ' + i }))
    await tick()
    expect(inboxes.count('codex@n:a')).toBe(0)
    expect(inboxes.count('agy@n:b')).toBe(0)
    expect(msgs(nodeWs).filter(m => m.type === 'wake')).toHaveLength(0)
    expect(unread.count('codex@n:a')).toBe(100)
    expect(unread.count('agy@n:b')).toBe(100)
    const pull = reg(h, 'codex@n:a', 'pull')
    h.message(pull as any, JSON.stringify({ type: 'inboxPull', requestId: 'u', withUnread: true }))
    const pulled = JSON.parse(msgs(pull).find(m => m.requestId === 'u').data)
    expect(pulled.messages).toEqual([])
    expect(pulled.unread).toBe(100)
    expect(unread.count('codex@n:a')).toBe(0)

    sessions = new SessionManager()
    inboxes = new Inboxes()
    nodes = new NodeRegistry()
    const unread2 = new Unread()
    const h2 = createWsHandlers(deps({ unread: unread2, busMaxPerMinute: 500 }))
    const node2 = regNode(h2, 'n', ['codex@n:a', 'agy@n:b'])
    expect(inboxes.count('codex@n:a')).toBe(0)
    expect(msgs(node2).filter(m => m.type === 'wake')).toHaveLength(0)
    const s = reg(h2, 'claude@mac:src')
    h2.message(s as any, JSON.stringify({ type: 'busPost', text: 'do it', to: 'codex@n:a' }))
    await tick()
    expect(inboxes.count('codex@n:a')).toBe(1)
    expect(inboxes.count('agy@n:b')).toBe(0)
    const queued = inboxes.drain('codex@n:a')
    expect(queued[0].content).toBe('do it')
    expect(queued[0].meta.message_id).toBe('mid')
    expect(msgs(node2).filter(m => m.type === 'wake')).toHaveLength(1)
    expect(msgs(node2).filter(m => m.type === 'wake')[0].agent).toBe('codex@n:a')
  })

  test('an approval stays with the conversation that asked', () => {
    const conversations = new Conversations()
    const d = deps({ conversations })
    const h = createWsHandlers(d)
    const first = makeWs()
    h.message(first, JSON.stringify({ type: 'register', name: 'codex@n:a', projectPath: '/p', conversationId: 'conv-a' }))
    h.message(first, JSON.stringify({ type: 'deregister' }))
    expect(deliver(d, 'codex@n:a', 'yes', { from_human: 'true', question_id: 'q1', from: 'mick' })).toBe(true)
    expect(inboxes.count('codex@n:a')).toBe(1)
    const reuse = makeWs()
    h.message(reuse, JSON.stringify({ type: 'register', name: 'codex@n:a', projectPath: '/p', conversationId: 'conv-b' }))
    expect(msgs(reuse).some(m => m.type === 'message' && m.content === 'yes')).toBe(false)
    expect(inboxes.count('codex@n:a')).toBe(1)
    h.message(reuse, JSON.stringify({ type: 'deregister' }))
    const back = makeWs()
    h.message(back, JSON.stringify({ type: 'register', name: 'codex@n:a', projectPath: '/p', conversationId: 'conv-a' }))
    const got = msgs(back).find(m => m.type === 'message' && m.content === 'yes')
    expect(got.meta.question_id).toBe('q1')
    expect(got.meta.conversation_id).toBe('conv-a')
    expect(got.meta.from_human).toBe('true')
    expect(inboxes.count('codex@n:a')).toBe(0)
  })

  test('an approval with no conversation id is not left on a bare name', () => {
    const d = deps({ conversations: new Conversations() })
    expect(deliver(d, 'gone@x', 'yes', { from_human: 'true', question_id: 'q1' })).toBe(false)
    expect(inboxes.count('gone@x')).toBe(0)
  })

  test('a node agent still receives an approval between turns', () => {
    const d = deps({ conversations: new Conversations() })
    const h = createWsHandlers(d)
    const nodeWs = regNode(h, 'nas', ['headless@nas'])
    expect(deliver(d, 'headless@nas', 'yes', { from_human: 'true', question_id: 'q1' })).toBe(true)
    expect(inboxes.count('headless@nas')).toBe(1)
    expect(msgs(nodeWs).some(m => m.type === 'wake')).toBe(true)
  })

  test('a cold wake over budget preserves directed mail and does not wake', async () => {
    const unread = new Unread()
    const budget = new WakeBudget({ cheap: 100, standard: 1, premium: 1 })
    const h = createWsHandlers(deps({ unread, budget, busMaxPerMinute: 50 }))
    const nodeWs = regNode(h, 'n', ['codex@n:a'])
    const a = reg(h, 'claude@mac:src')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'one', to: 'codex@n:a' }))
    await tick()
    expect(inboxes.count('codex@n:a')).toBe(1)
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'two', to: 'codex@n:a' }))
    await tick()
    expect(inboxes.count('codex@n:a')).toBe(2)
    expect(unread.count('codex@n:a')).toBe(0)
    expect(msgs(nodeWs).filter(m => m.type === 'wake')).toHaveLength(1)
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

  test('topic posts to human send both copies while general and channel-free posts send once', async () => {
    const channels = [{ id: 'bbq-topic', name: 'bbq' }, { id: 'bus1', name: 'general' }, { id: 'hq1', name: 'human-questions' }]
    const h = createWsHandlers(deps({ channelOps: {
      resolve: async name => channels.find(channel => channel.name === name) ?? null,
      list: async () => channels,
      create: async name => ({ id: name, name }),
    } }))
    const a = reg(h, 'claude@mac:bbq')
    h.message(a, JSON.stringify({ type: 'channelPost', channel: 'bbq', text: 'answer', to: 'human' }))
    await tick()
    h.message(a, JSON.stringify({ type: 'channelPost', channel: 'general', text: 'new question', to: 'human' }))
    await tick()
    h.message(a, JSON.stringify({ type: 'busPost', text: 'channel-free question', to: 'human' }))
    await tick()
    h.message(a, JSON.stringify({ type: 'channelPost', channel: 'human-questions', text: 'already in human questions', to: 'human' }))
    await tick()
    expect(posted).toEqual([
      ['bbq-topic', '**[claude@mac:bbq → human]** answer'],
      ['hq1', '**[claude@mac:bbq → human]** (from #bbq) answer'],
      ['hq1', '**[claude@mac:bbq → human]** (from #general) new question'],
      ['hq1', '**[claude@mac:bbq → human]** (from #general) channel-free question'],
      ['hq1', '**[claude@mac:bbq → human]** already in human questions'],
    ])
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

describe('node auth', () => {
  test('registerNode works with the router secret and is rejected without it', () => {
    const h = createWsHandlers(deps({ secret: 's' }))
    const bad = makeWs(); h.message(bad as any, JSON.stringify({ type: 'registerNode', node: 'n', agents: [] }))
    expect(msgs(bad)[0].message).toContain('register rejected')
    const ok = makeWs(); h.message(ok as any, JSON.stringify({ type: 'registerNode', node: 'n', secret: 's', agents: [{ name: 'a@n:x', kind: 'agy' }] }))
    expect(msgs(ok)[0].type).toBe('nodeRegistered')
    h.message(ok as any, JSON.stringify({ type: 'inboxCount', requestId: 'c', agent: 'a@n:x' }))
    expect(msgs(ok).find(m => m.requestId === 'c').data).toBe('0')
  })
})

describe('takeover + claims', () => {
  test('pull-mode re-register replaces the stale slot (no -2 suffix)', () => {
    const h = createWsHandlers(deps())
    reg(h, 'claude@m:x', 'pull')
    const s2 = makeWs(); h.message(s2 as any, JSON.stringify({ type: 'register', name: 'claude@m:x', projectPath: '/p', instanceId: 'other', mode: 'pull' }))
    expect(msgs(s2)[0].name).toBe('claude@m:x')
    expect(sessions.getSessions().map(s => s.name)).toEqual(['claude@m:x'])
  })
  test('first claim wins; handover works', () => {
    const { Claims } = require('../nodes.js')
    const h = createWsHandlers(deps({ claims: new Claims() }))
    const a = reg(h, 'a@m:x'), b = reg(h, 'b@m:x')
    const res = (ws: any, id: string) => JSON.parse(msgs(ws).find((m: any) => m.requestId === id).data)
    h.message(a as any, JSON.stringify({ type: 'claim', requestId: '1', task: 'Opencode on NAS' }))
    h.message(b as any, JSON.stringify({ type: 'claim', requestId: '2', task: 'opencode  on nas' }))
    expect(res(a, '1').won).toBe(true)
    expect(res(b, '2')).toMatchObject({ won: false, claim: { owner: 'a@m:x' } })
    h.message(a as any, JSON.stringify({ type: 'releaseClaim', requestId: '3', task: 'opencode on nas', to: 'b@m:x' }))
    h.message(b as any, JSON.stringify({ type: 'claim', requestId: '4', task: 'opencode on nas' }))
    expect(res(b, '4').won).toBe(true)
  })
})

describe('opencode kind', () => {
  test('command + parse', () => {
    const { args, env } = buildCommand({ name: 'opencode@nas642:glm', kind: 'opencode', args: ['--auto'] }, 'ses_1', 'P', { claudePlugin: false })
    expect(args).toEqual(['run', '--format', 'json', '--session', 'ses_1', '--auto', 'P'])
    expect(JSON.parse(env!.OPENCODE_CONFIG_CONTENT).mcp.discord.environment.DISCORD_SESSION_NAME).toBe('opencode@nas642:glm')
    expect(parseTurnOutput('opencode', '{"type":"step_start","sessionID":"ses_9"}\n{"type":"text","sessionID":"ses_9","part":{"text":"hi"}}')).toMatchObject({ session: 'ses_9', summary: 'hi' })
  })
})

describe('agentStatus + resume last', () => {
  test('agentStatus reports live push and only observes pending mail', () => {
    const h = createWsHandlers(deps())
    const nodeWs = regNode(h, 'n', ['codex@n:q'])
    const live = reg(h, 'codex@n:q')            // interactive session holds the name
    inboxes.push('codex@n:q', 'queued during a gap', {})
    h.message(nodeWs as any, JSON.stringify({ type: 'agentStatus', requestId: 's', agent: 'codex@n:q' }))
    expect(JSON.parse(msgs(nodeWs).find(m => m.requestId === 's').data)).toMatchObject({ live: true, mode: 'push', pending: 1 })
    expect(msgs(live).find(m => m.type === 'message' && m.content === 'queued during a gap')).toBeUndefined()
  })
  test('resume "last" maps to continue flags', () => {
    expect(buildCommand({ name: 'c', kind: 'claude' }, 'last', 'P', { claudePlugin: true }).args).toContain('--continue')
    expect(buildCommand({ name: 'c', kind: 'codex' }, 'last', 'P', { claudePlugin: false }).args.slice(-3)).toEqual(['resume', '--last', 'P'])
    expect(buildCommand({ name: 'c', kind: 'agy' }, 'last', 'P', { claudePlugin: false }).args).toContain('--continue')
  })
})

describe('admin subscribe', () => {
  test('admin can subscribe another session; others cannot', async () => {
    const subs = new Subscriptions()
    const ops = { resolve: async (r: string) => ({ id: 'cfd', name: 'cfd' }), list: async () => [], create: async () => ({ id: 'x', name: 'x' }) }
    const h = createWsHandlers(deps({ subs, channelOps: ops, admins: new Set(['claude@mac:setup']) }))
    const admin = reg(h, 'claude@mac:setup'), other = reg(h, 'codex@mac')
    h.message(other as any, JSON.stringify({ type: 'channelSubscribe', requestId: 'a', channel: 'cfd', session: 'agy@n:p1' }))
    h.message(admin as any, JSON.stringify({ type: 'channelSubscribe', requestId: 'b', channel: 'cfd', session: 'agy@n:p1' }))
    await tick()
    expect(msgs(other).find(m => m.requestId === 'a').success).toBe(false)
    expect(subs.has('agy@n:p1', 'cfd')).toBe(true)
  })
})

describe('inline attachments', () => {
  test('files are decoded and attached on the first chunk; bare paths are refused', async () => {
    const sent: any[] = []
    const d = deps()
    ;(d.client as any).channels.fetch = mock(async () => ({ isTextBased: () => true, send: mock(async (p: any) => { sent.push(p); return { id: 'm' } }) }))
    const h = createWsHandlers(d)
    const a = reg(h, 'claude@nas642:src'); reg(h, 'x@m:y')
    const data = Buffer.from('%PDF-1.4 hello').toString('base64')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'report', to: 'human', files: [{ name: 'tt-hfd.pdf', data }, '/etc/passwd'] }))
    await tick()
    expect(sent[0].files[0].name).toBe('tt-hfd.pdf')
    expect(sent[0].files[0].attachment.toString()).toBe('%PDF-1.4 hello')
    expect(sent[0].files).toHaveLength(1)
    expect(msgs(a).some(m => m.type === 'error' && m.message.includes('/etc/passwd'))).toBe(true)
  })
})

describe('download + file message ids', () => {
  test('agent-to-agent file post delivers message_id so the recipient can download', async () => {
    const d = deps()
    ;(d.client as any).channels.fetch = mock(async () => ({ isTextBased: () => true, send: mock(async () => ({ id: 'MSG42' })) }))
    const h = createWsHandlers(d)
    const a = reg(h, 'claude@nas642:src'), b = reg(h, 'codex@mac')
    h.message(a as any, JSON.stringify({ type: 'busPost', text: 'see file', to: 'codex@mac', files: [{ name: 'r.txt', data: Buffer.from('x').toString('base64') }] }))
    await tick()
    const m = msgs(b).find(x => x.type === 'message')
    expect(m.meta).toMatchObject({ message_id: 'MSG42', attachments: 'r.txt', attachment_count: '1' })
  })
  test('downloadAttachment returns bytes, not router paths', async () => {
    const d = deps()
    const atts = new Map([['1', { id: '1', name: 'in.pdf', size: 3, url: 'data:application/pdf;base64,' + Buffer.from('PDF').toString('base64') }]])
    ;(d.client as any).channels.fetch = mock(async () => ({ isTextBased: () => true, messages: { fetch: async () => ({ attachments: atts }) } }))
    const h = createWsHandlers(d)
    const a = reg(h, 'codex@mac')
    h.message(a as any, JSON.stringify({ type: 'downloadAttachment', requestId: 'd', chatId: 'c', messageId: 'm' }))
    await new Promise(r => setTimeout(r, 60))
    const res = JSON.parse(msgs(a).find(m => m.requestId === 'd').data)
    expect(res[0]).toMatchObject({ name: '1_in.pdf', size: 3 })
    expect(Buffer.from(res[0].data, 'base64').toString()).toBe('PDF')
  })
})

describe('per-node secrets', () => {
  const { createHash } = require('node:crypto')
  const h = (s: string) => createHash('sha256').update(s).digest('hex')
  const regN = (hd: any, node: string, nodeSecret?: string) => { const ws = makeWs(); hd.message(ws as any, JSON.stringify({ type: 'registerNode', node, agents: [], ...(nodeSecret && { nodeSecret }) })); return msgs(ws)[0] }
  test('listed node needs its own secret', () => {
    const hd = createWsHandlers(deps({ nodeSecrets: () => ({ hashes: { nas642: h('n-s') }, require: false }) }))
    expect(regN(hd, 'nas642').message).toContain('bad or missing node secret')
    expect(regN(hd, 'nas642', 'wrong').message).toContain('bad or missing node secret')
    expect(regN(hd, 'nas642', 'n-s').type).toBe('nodeRegistered')
  })
  test('unlisted node: allowed (warn) unless require is set', () => {
    expect(regN(createWsHandlers(deps({ nodeSecrets: () => ({ hashes: {}, require: false }) })), 'newbox').type).toBe('nodeRegistered')
    expect(regN(createWsHandlers(deps({ nodeSecrets: () => ({ hashes: {}, require: true }) })), 'newbox').message).toContain('has no node secret')
  })
})

describe('node: nvm PATH + local conversation guard', () => {
  const { nvmBinDir, conversationHeldLocally } = require('../node.js')
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os')
  test('nvmBinDir follows alias/default and picks the newest for "node"', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nvm-'))
    for (const v of ['v24.10.0', 'v26.5.0', 'v26.12.1']) fs.mkdirSync(path.join(d, 'versions/node', v, 'bin'), { recursive: true })
    fs.mkdirSync(path.join(d, 'alias'))
    fs.writeFileSync(path.join(d, 'alias/default'), 'v26.5.0\n'); expect(nvmBinDir(d)).toBe(path.join(d, 'versions/node/v26.5.0/bin'))
    fs.writeFileSync(path.join(d, 'alias/default'), 'node'); expect(nvmBinDir(d)).toBe(path.join(d, 'versions/node/v26.12.1/bin'))
    fs.writeFileSync(path.join(d, 'alias/default'), '24'); expect(nvmBinDir(d)).toBe(path.join(d, 'versions/node/v24.10.0/bin'))
    expect(nvmBinDir(path.join(d, 'nope'))).toBeUndefined()
  })
  test('conversationHeldLocally sees a TUI resumed by id and a live Claude session file', () => {
    const ps = () => '  111 codex -s danger-full-access resume 01a20df8-a08f\n  222 bash\n'
    expect(conversationHeldLocally('01a20df8-a08f', ps, '/nonexistent')).toBe('pid 111')
    expect(conversationHeldLocally('other-id', ps, '/nonexistent')).toBeUndefined()
    expect(conversationHeldLocally('last', ps, '/nonexistent')).toBeUndefined()
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'))
    fs.writeFileSync(path.join(sd, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'S-live' }))
    fs.writeFileSync(path.join(sd, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'S-dead' }))
    expect(conversationHeldLocally('S-live', () => '', sd)).toBe(`claude pid ${process.pid}`)
    expect(conversationHeldLocally('S-dead', () => '', sd)).toBeUndefined()
  })
})

describe('explicit-name takeover retires the stale holder', () => {
  test('newer client with takeover gets the exact name; old one is told "replaced"', () => {
    const h = createWsHandlers(deps())
    const stale = makeWs(); h.message(stale as any, JSON.stringify({ type: 'register', name: 'codex@mac', projectPath: '/', instanceId: 'old-thread' }))
    const live = makeWs(); h.message(live as any, JSON.stringify({ type: 'register', name: 'codex@mac', projectPath: '/', instanceId: 'new-thread', takeover: true }))
    expect(msgs(stale).some(m => m.type === 'replaced' && m.name === 'codex@mac')).toBe(true)
    expect(msgs(live).find(m => m.type === 'registered').name).toBe('codex@mac')
    expect(sessions.getSessions().map(s => s.name)).toEqual(['codex@mac'])
    deliver(deps(), 'codex@mac', 'for the live thread', {})
    expect(msgs(live).some(m => m.type === 'message' && m.content === 'for the live thread')).toBe(true)
    expect(msgs(stale).some(m => m.type === 'message' && m.content === 'for the live thread')).toBe(false)
  })
})
