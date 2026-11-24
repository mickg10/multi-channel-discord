import { describe, test, expect, beforeEach } from 'bun:test'
import { McpRegistry, Grants, McpAudit, PendingMcpCalls, McpChild, resolveEnv, writeJsonAtomic } from '../mcp.js'
import { createWsHandlers } from '../ws.js'
import type { WsData, WsDeps } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { NodeRegistry } from '../nodes.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-test-'))
})

function mockWs() {
  const sent: string[] = []
  const data: WsData = { sessionName: null, sendCallback: null }
  return { data, sent, send: (m: string) => sent.push(m) }
}

function registryFile(servers: unknown): string {
  const f = join(dir, 'mcp-registry.json')
  writeJsonAtomic(f, { servers })
  return f
}

const READ_ONLY = { name: 'inventory', node: 'nas642', command: 'bun', args: ['run', 'inventory'], class: 'read-only', methods: ['lookup', 'list'], description: 'infra inventory' }
const WRITER = { name: 'unifi', node: 'nas642', command: 'bun', args: ['run', 'unifi'], class: 'side-effecting' }

describe('McpRegistry', () => {
  test('loads and lists servers', () => {
    const reg = McpRegistry.fromFile(registryFile([READ_ONLY, WRITER]))
    const list = reg.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'inventory', node: 'nas642', class: 'read-only', methods: 2 })
    expect(reg.get('inventory')?.command).toBe('bun')
  })

  test('rejects a bad class (fail closed)', () => {
    const f = registryFile([{ name: 'x', node: 'n', command: 'c', class: 'writey' }])
    expect(() => McpRegistry.fromFile(f)).toThrow(/class/)
  })

  test('fromFileOrNull returns null for a missing file', () => {
    expect(McpRegistry.fromFileOrNull(join(dir, 'nope.json'))).toBeNull()
  })
})

describe('admission (checkCall)', () => {
  test('read-only allowlisted method is allowed', () => {
    const reg = McpRegistry.fromFile(registryFile([READ_ONLY]))
    const d = reg.checkCall('inventory', 'lookup', new Grants(), 'agent@x')
    expect(d.ok).toBe(true)
  })

  test('undeclared server rejected', () => {
    const reg = McpRegistry.fromFile(registryFile([READ_ONLY]))
    const d = reg.checkCall('ghost', 'lookup', new Grants(), 'agent@x')
    if (d.ok) throw new Error('expected rejection')
    expect(d.reason).toContain('not declared')
  })

  test('method outside allowlist rejected', () => {
    const reg = McpRegistry.fromFile(registryFile([READ_ONLY]))
    const d = reg.checkCall('inventory', 'reboot', new Grants(), 'agent@x')
    if (d.ok) throw new Error('expected rejection')
    expect(d.reason).toContain('not allowlisted')
  })

  test('side-effecting without grant rejected (round-one default-deny)', () => {
    const reg = McpRegistry.fromFile(registryFile([WRITER]))
    const d = reg.checkCall('unifi', 'setFirewall', new Grants(), 'agent@x')
    if (d.ok) throw new Error('expected rejection')
    expect(d.reason).toContain('grant')
  })

  test('side-effecting with a valid grant allowed; wrong session / expired / revoked rejected', () => {
    const reg = McpRegistry.fromFile(registryFile([WRITER]))
    const grants = new Grants()
    const g = grants.issue('unifi', { session: 'agent@x', ttlHours: 1 })
    expect(reg.checkCall('unifi', 'setFirewall', grants, 'agent@x', g.id).ok).toBe(true)
    expect(reg.checkCall('unifi', 'setFirewall', grants, 'other@y', g.id).ok).toBe(false)
    const exp = grants.issue('unifi', { ttlHours: -1 })
    expect(reg.checkCall('unifi', 'setFirewall', grants, 'agent@x', exp.id).ok).toBe(false)
    grants.revoke(g.id)
    expect(reg.checkCall('unifi', 'setFirewall', grants, 'agent@x', g.id).ok).toBe(false)
  })

  test('grant for another server does not apply', () => {
    const reg = McpRegistry.fromFile(registryFile([WRITER]))
    const grants = new Grants()
    const g = grants.issue('inventory', {})
    expect(reg.checkCall('unifi', 'setFirewall', grants, 'agent@x', g.id).ok).toBe(false)
  })
})

describe('Grants persistence', () => {
  test('issued grants survive to a new instance', () => {
    const file = join(dir, 'g.json')
    const g = new Grants(file).issue('unifi', { session: 'a@b' })
    const again = new Grants(file)
    expect(again.check(g.id, 'unifi', 'a@b')).toBe(true)
  })
})

describe('McpAudit', () => {
  test('records one JSON line per decision', async () => {
    const file = join(dir, 'mcp-audit.jsonl')
    const audit = McpAudit.inStateDir(dir)
    audit.record('a@b', 'inventory', 'lookup', { host: 'x' }, 'allow:read-only')
    const lines = (await Bun.file(file).text()).trim().split('\n')
    expect(lines).toHaveLength(1)
    const e = JSON.parse(lines[0]!)
    expect(e).toMatchObject({ session: 'a@b', server: 'inventory', method: 'lookup', decision: 'allow:read-only' })
    expect(e.argsHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('PendingMcpCalls', () => {
  test('resolve sends toolResult to the target', () => {
    const ws = mockWs()
    const p = new PendingMcpCalls(1000)
    p.register('r1', ws)
    expect(p.resolve('r1', true, '"ok"')).toBe(true)
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'toolResult', requestId: 'r1', success: true, data: '"ok"' })
  })

  test('timeout sends a failure toolResult', async () => {
    const ws = mockWs()
    const p = new PendingMcpCalls(15)
    p.register('r2', ws)
    await new Promise(r => setTimeout(r, 40))
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'toolResult', requestId: 'r2', success: false })
  })
})

describe('ws handlers: mcp ops', () => {
  function makeDeps(over: Partial<WsDeps> = {}): WsDeps {
    return {
      sessions: new SessionManager(),
      history: new ProjectHistory(dir),
      client: { channels: { fetch: async () => null } } as any,
      chatId: () => '123',
      chunkLimit: 2000,
      chunkMode: 'length',
      replyToMode: 'first',
      nodes: new NodeRegistry(),
      ...over,
    }
  }

  test('mcp ops without registry configured report disabled', () => {
    const h = createWsHandlers(makeDeps())
    const ws = mockWs()
    ws.data.sessionName = 'a@b'
    h.message(ws as any, JSON.stringify({ type: 'mcpList', requestId: 'r' }))
    const r = JSON.parse(ws.sent[0]!)
    expect(r).toMatchObject({ type: 'toolResult', success: false, data: 'remote MCP disabled on this router' })
  })

  test('mcpList returns the declaration summary', () => {
    const deps = makeDeps({
      mcp: McpRegistry.fromFile(registryFile([READ_ONLY])),
      mcpGrants: new Grants(), mcpAudit: McpAudit.inStateDir(dir), mcpPending: new PendingMcpCalls(100),
    })
    const ws = mockWs()
    ws.data.sessionName = 'a@b'
    createWsHandlers(deps).message(ws as any, JSON.stringify({ type: 'mcpList', requestId: 'r' }))
    const r = JSON.parse(ws.sent[0]!)
    expect(r.success).toBe(true)
    expect(JSON.parse(r.data)[0]).toMatchObject({ name: 'inventory', class: 'read-only', methods: 2 })
  })

  test('mcpCall read-only forwards mcpExec to the hosting node; mcpResult answers the caller', () => {
    const nodes = new NodeRegistry()
    const toNode: string[] = []
    nodes.register('nas642', (m) => toNode.push(m), [{ name: 'headless@nas642', kind: 'opencode' }])
    const deps = makeDeps({
      nodes,
      mcp: McpRegistry.fromFile(registryFile([READ_ONLY])),
      mcpGrants: new Grants(), mcpAudit: McpAudit.inStateDir(dir), mcpPending: new PendingMcpCalls(500),
    })
    const caller = mockWs()
    caller.data.sessionName = 'a@mac'
    const h = createWsHandlers(deps)
    h.message(caller as any, JSON.stringify({ type: 'mcpCall', requestId: 'req1', server: 'inventory', method: 'lookup', params: { host: 'vm3' } }))
    // Caller has no answer yet (the node holds it):
    expect(caller.sent).toHaveLength(0)
    const exec = JSON.parse(toNode[0]!)
    expect(exec).toMatchObject({ type: 'mcpExec', requestId: 'req1', server: 'inventory', command: 'bun', method: 'lookup' })
    expect(exec.params).toEqual({ host: 'vm3' })
    // The node's daemon answers on its own connection (nodeName set):
    const nodeWs = mockWs()
    nodeWs.data.nodeName = 'nas642'
    h.message(nodeWs as any, JSON.stringify({ type: 'mcpResult', requestId: 'req1', success: true, data: '{"found":true}' }))
    expect(JSON.parse(caller.sent[0]!)).toMatchObject({ type: 'toolResult', requestId: 'req1', success: true, data: '{"found":true}' })
  })

  test('mcpCall on a side-effecting server is rejected at the router and audited', () => {
    const deps = makeDeps({
      mcp: McpRegistry.fromFile(registryFile([WRITER])),
      mcpGrants: new Grants(), mcpAudit: McpAudit.inStateDir(dir), mcpPending: new PendingMcpCalls(100),
    })
    const ws = mockWs()
    ws.data.sessionName = 'a@mac'
    createWsHandlers(deps).message(ws as any, JSON.stringify({ type: 'mcpCall', requestId: 'r', server: 'unifi', method: 'setFirewall' }))
    const r = JSON.parse(ws.sent[0]!)
    expect(r.success).toBe(false)
    expect(r.data).toContain('grant')
    const audit = JSON.parse(readFileSync(join(dir, 'mcp-audit.jsonl'), 'utf8').trim())
    expect(audit).toMatchObject({ session: 'a@mac', server: 'unifi', method: 'setFirewall' })
    expect(audit.decision).toContain('reject')
  })

  test('mcpDescribe on a disconnected node fails with the declaration as context', () => {
    const deps = makeDeps({
      mcp: McpRegistry.fromFile(registryFile([READ_ONLY])),
      mcpGrants: new Grants(), mcpAudit: McpAudit.inStateDir(dir), mcpPending: new PendingMcpCalls(100),
    })
    const ws = mockWs()
    ws.data.sessionName = 'a@b'
    createWsHandlers(deps).message(ws as any, JSON.stringify({ type: 'mcpDescribe', requestId: 'r', server: 'inventory' }))
    const r = JSON.parse(ws.sent[0]!)
    expect(r.success).toBe(false)
    expect(r.data).toContain('nas642')
  })
})

describe('McpChild (node side, stdio JSON-RPC)', () => {
  // Fake stdio MCP server: initialize -> tools/list -> tools/call echo.
  const FAKE_SERVER = `
let buf = ''
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n')
    } else if (m.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } }) + '\\n')
    } else if (m.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params.name }] } }) + '\\n')
    }
  }
})
`

  test('initialize + tools/list + tools/call round trip', async () => {
    const child = new McpChild()
    const spec = { server: 'fake', command: process.execPath, args: ['-e', FAKE_SERVER], method: 'tools/list' }
    const list = await child.call(spec)
    expect(list.ok).toBe(true)
    expect(JSON.parse(list.data).tools[0]).toMatchObject({ name: 'lookup' })
    const call = await child.call({ ...spec, method: 'lookup', params: { host: 'vm3' } })
    expect(call.ok).toBe(true)
    expect(JSON.parse(call.data).content[0].text).toBe('echo:lookup')
    child.close()
  })

  test('spawn failure surfaces as a clean error', async () => {
    const child = new McpChild()
    const r = await child.call({ server: 'nope', command: '/nonexistent/binary', method: 'tools/list' })
    expect(r.ok).toBe(false)
    expect(r.data).toContain('spawn failed')
  })

  test('resolveEnv maps file: refs to file contents', async () => {
    const secret = join(dir, 'key')
    await writeFile(secret, '  tok123\n')
    expect(resolveEnv({ A: 'literal', B: `file:${secret}` })).toEqual({ A: 'literal', B: 'tok123' })
  })
})
