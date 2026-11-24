import { describe, test, expect, beforeEach } from 'bun:test'
import { McpRegistry, Grants, McpAudit, PendingMcpCalls, McpChild, resolveEnv, validateLocalMcp, resolveLocalMcp, newCallId, writeJsonAtomic } from '../mcp.js'
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

const READ_ONLY = { name: 'inventory', node: 'nas642', class: 'read-only', methods: ['lookup', 'list'], description: 'infra inventory' }
const WRITER = { name: 'unifi', node: 'nas642', class: 'side-effecting', methods: ['setFirewall'] }

describe('McpRegistry', () => {
  test('loads and lists servers (admission facts only)', () => {
    const reg = McpRegistry.fromFile(registryFile([READ_ONLY, WRITER]))
    const list = reg.list()
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'inventory', node: 'nas642', class: 'read-only', methods: 2 })
    expect(reg.get('inventory')?.node).toBe('nas642')
  })

  test('rejects a bad class (fail closed)', () => {
    const f = registryFile([{ name: 'x', node: 'n', class: 'writey' }])
    expect(() => McpRegistry.fromFile(f)).toThrow(/class/)
  })

  test('rejects command/args/env in the registry (spawn specs are node-local)', () => {
    const f = registryFile([{ name: 'x', node: 'n', class: 'read-only', methods: ['a'], command: 'bun' }])
    expect(() => McpRegistry.fromFile(f)).toThrow(/node's own config/)
    const f2 = registryFile([{ name: 'x', node: 'n', class: 'read-only', methods: ['a'], env: { A: 'b' } }])
    expect(() => McpRegistry.fromFile(f2)).toThrow(/node's own config/)
  })

  test('registry without a methods allowlist is rejected (allow-all is forbidden)', () => {
    const f = registryFile([{ name: 'x', node: 'n', class: 'read-only' }])
    expect(() => McpRegistry.fromFile(f)).toThrow(/methods.*required/)
    const f2 = registryFile([{ name: 'x', node: 'n', class: 'read-only', methods: [] }])
    expect(() => McpRegistry.fromFile(f2)).toThrow(/methods.*required/)
  })

  test('fromFileOrNull returns null for a missing file', () => {
    expect(McpRegistry.fromFileOrNull(join(dir, 'nope.json'))).toBeNull()
  })
})

describe('admission (checkCall)', () => {
  test('read-only allowlisted method is allowed', () => {
    const reg = McpRegistry.fromFile(registryFile([READ_ONLY]))
    const d = reg.checkCall('inventory', 'lookup', new Grants(), { session: 'agent@x' })
    expect(d.ok).toBe(true)
  })

  test('undeclared server rejected', () => {
    const reg = McpRegistry.fromFile(registryFile([READ_ONLY]))
    const d = reg.checkCall('ghost', 'lookup', new Grants(), { session: 'agent@x' })
    if (d.ok) throw new Error('expected rejection')
    expect(d.reason).toContain('not declared')
  })

  test('method outside allowlist rejected', () => {
    const reg = McpRegistry.fromFile(registryFile([READ_ONLY]))
    const d = reg.checkCall('inventory', 'reboot', new Grants(), { session: 'agent@x' })
    if (d.ok) throw new Error('expected rejection')
    expect(d.reason).toContain('not allowlisted')
  })

  test('side-effecting without grant rejected (round-one default-deny)', () => {
    const reg = McpRegistry.fromFile(registryFile([WRITER]))
    const d = reg.checkCall('unifi', 'setFirewall', new Grants(), { session: 'agent@x' })
    if (d.ok) throw new Error('expected rejection')
    expect(d.reason).toContain('grant')
  })

  test('side-effecting with a valid grant allowed; wrong session / expired / revoked rejected', () => {
    const reg = McpRegistry.fromFile(registryFile([WRITER]))
    const grants = new Grants()
    const g = grants.issue('unifi', { session: 'agent@x', ttlHours: 1 })
    expect(reg.checkCall('unifi', 'setFirewall', grants, { session: 'agent@x' }, g.id).ok).toBe(true)
    expect(reg.checkCall('unifi', 'setFirewall', grants, { session: 'other@y' }, g.id).ok).toBe(false)
    const exp = grants.issue('unifi', { ttlHours: -1 })
    expect(reg.checkCall('unifi', 'setFirewall', grants, { session: 'agent@x' }, exp.id).ok).toBe(false)
    grants.revoke(g.id)
    expect(reg.checkCall('unifi', 'setFirewall', grants, { session: 'agent@x' }, g.id).ok).toBe(false)
  })

  test('grant for another server does not apply', () => {
    const reg = McpRegistry.fromFile(registryFile([WRITER]))
    const grants = new Grants()
    const g = grants.issue('inventory', {})
    expect(reg.checkCall('unifi', 'setFirewall', grants, { session: 'agent@x' }, g.id).ok).toBe(false)
  })
})

describe('Grants persistence + live reload', () => {
  test('issued grants survive to a new instance', () => {
    const file = join(dir, 'g.json')
    const g = new Grants(file).issue('unifi', { session: 'a@b' })
    const again = new Grants(file)
    expect(again.check(g.id, 'unifi', { session: 'a@b' })).toBe(true)
  })

  test('CLI-issued grants apply to a running instance; CLI revocation applies live', async () => {
    const file = join(dir, 'g.json')
    writeJsonAtomic(file, [])
    const running = new Grants(file) // e.g. inside the router process
    // A separate instance (bin/agent-bus-grant) issues:
    const cli = new Grants(file)
    const g = cli.issue('unifi', { session: 'a@b', ttlHours: 1 })
    expect(running.check(g.id, 'unifi', { session: 'a@b' })).toBe(true)
    // And revokes:
    cli.revoke(g.id)
    expect(running.check(g.id, 'unifi', { session: 'a@b' })).toBe(false)
  })

  test('grants fail CLOSED when the file becomes unreadable or corrupt', async () => {
    const file = join(dir, 'g.json')
    const a = new Grants(file)
    const g = a.issue('unifi', { session: 'a@b', ttlHours: 1 })
    const running = new Grants(file)
    expect(running.check(g.id, 'unifi', { session: 'a@b' })).toBe(true)
    await writeFile(file, '{corrupt json') // stamp changes, parse fails
    expect(running.check(g.id, 'unifi', { session: 'a@b' })).toBe(false)
    await writeFile(file, JSON.stringify([])) // deleted-from-file = gone
    expect(running.check(g.id, 'unifi', { session: 'a@b' })).toBe(false)
  })

  test('grants can bind to a client instance id', () => {
    const grants = new Grants()
    const g = grants.issue('unifi', { session: 'a@b', instance: 'inst-1' })
    expect(grants.check(g.id, 'unifi', { session: 'a@b', instance: 'inst-1' })).toBe(true)
    expect(grants.check(g.id, 'unifi', { session: 'a@b', instance: 'inst-2' })).toBe(false)
    expect(grants.check(g.id, 'unifi', { session: 'a@b' })).toBe(false) // unknown instance cannot present it
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

describe('PendingMcpCalls (router-minted ids, node-bound)', () => {
  test('resolve sends toolResult with the CLIENT requestId to the target', () => {
    const ws = mockWs()
    const p = new PendingMcpCalls(1000)
    const callId = newCallId()
    p.register(callId, ws, 'req_client_1', 'nas642')
    expect(p.resolve(callId, 'nas642', true, '"ok"')).toBe(true)
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'toolResult', requestId: 'req_client_1', success: true, data: '"ok"' })
  })

  test('a result from a different node is ignored (call stays pending)', () => {
    const ws = mockWs()
    const p = new PendingMcpCalls(1000)
    const callId = newCallId()
    p.register(callId, ws, 'req_client_1', 'nas642')
    expect(p.resolve(callId, 'mac', true, '"spoof"')).toBe(false)
    expect(ws.sent).toHaveLength(0)
    expect(p.resolve(callId, 'nas642', true, '"ok"')).toBe(true)
  })

  test('two clients with the SAME requestId each get their own result', () => {
    const a = mockWs(), b = mockWs()
    const p = new PendingMcpCalls(1000)
    const c1 = newCallId(), c2 = newCallId()
    p.register(c1, a, 'req_dup', 'nas642')
    p.register(c2, b, 'req_dup', 'nas642')
    expect(p.resolve(c1, 'nas642', true, '"for-a"')).toBe(true)
    expect(p.resolve(c2, 'nas642', true, '"for-b"')).toBe(true)
    expect(JSON.parse(a.sent[0]!).data).toBe('"for-a"')
    expect(JSON.parse(b.sent[0]!).data).toBe('"for-b"')
  })

  test('unknown call ids are ignored; timeout sends a failure toolResult', async () => {
    const p = new PendingMcpCalls(15)
    expect(p.resolve('mcp_unknown', 'nas642', true, 'x')).toBe(false)
    const ws = mockWs()
    p.register(newCallId(), ws, 'req_t', 'nas642')
    await new Promise(r => setTimeout(r, 40))
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'toolResult', requestId: 'req_t', success: false })
  })
})

describe('node-local allowlist', () => {
  test('validateLocalMcp rejects entries without a command', () => {
    expect(() => validateLocalMcp({ bad: {} })).toThrow(/bad/)
    expect(() => validateLocalMcp([])).toThrow()
  })

  test('node refuses a server missing from its local config even if the router asks', () => {
    const local = validateLocalMcp({ inventory: { command: 'bun' } })
    const r = resolveLocalMcp(local, { callId: 'c', server: 'shell', method: 'run' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('refuses to host')
  })

  test('local method allowlist is enforced; happy path carries env to the spec', () => {
    const local = validateLocalMcp({ web: { command: 'bunx', args: ['-y', 'srv'], env: { K: 'file:/x' }, methods: ['search'] } })
    const denied = resolveLocalMcp(local, { callId: 'c', server: 'web', method: 'fetch' })
    expect(denied.ok).toBe(false)
    const ok = resolveLocalMcp(local, { callId: 'c', server: 'web', method: 'search', params: { q: 'x' } })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.spec).toMatchObject({ command: 'bunx', env: { K: 'file:/x' }, method: 'search' })
  })

  test('resolveEnv maps file: refs to file contents', async () => {
    const secret = join(dir, 'key')
    await writeFile(secret, '  tok123\n')
    expect(resolveEnv({ A: 'literal', B: `file:${secret}` })).toEqual({ A: 'literal', B: 'tok123' })
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

  function routerMcp(servers: unknown[], timeoutMs: number) {
    return { registry: McpRegistry.fromFile(registryFile(servers)), grants: new Grants(), audit: McpAudit.inStateDir(dir), pending: new PendingMcpCalls(timeoutMs) }
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
      mcp: routerMcp([READ_ONLY], 100),
    })
    const ws = mockWs()
    ws.data.sessionName = 'a@b'
    createWsHandlers(deps).message(ws as any, JSON.stringify({ type: 'mcpList', requestId: 'r' }))
    const r = JSON.parse(ws.sent[0]!)
    expect(r.success).toBe(true)
    expect(JSON.parse(r.data)[0]).toMatchObject({ name: 'inventory', class: 'read-only', methods: 2 })
  })

  test('mcpCall forwards ONLY {callId, server, method, params} to the hosting node; the right node answers; a wrong node cannot', () => {
    const nodes = new NodeRegistry()
    const toNode: string[] = []
    nodes.register('nas642', (m) => toNode.push(m), [{ name: 'headless@nas642', kind: 'opencode' }])
    nodes.register('mac', () => {}, [{ name: 'headless@mac', kind: 'opencode' }])
    const deps = makeDeps({
      nodes,
      mcp: routerMcp([READ_ONLY], 500),
    })
    const caller = mockWs()
    caller.data.sessionName = 'a@mac'
    const h = createWsHandlers(deps)
    h.message(caller as any, JSON.stringify({ type: 'mcpCall', requestId: 'req1', server: 'inventory', method: 'lookup', params: { host: 'vm3' } }))
    expect(caller.sent).toHaveLength(0) // the node holds the answer
    const exec = JSON.parse(toNode[0]!)
    expect(exec).toMatchObject({ type: 'mcpExec', server: 'inventory', method: 'lookup' })
    expect(exec.callId).toMatch(/^mcp_[0-9a-f]+$/)
    expect(exec.command).toBeUndefined() // spawn specs never transit the bus
    expect(exec.env).toBeUndefined()
    expect(exec.params).toEqual({ host: 'vm3' })
    // A different node tries to answer the call: ignored.
    const otherNode = mockWs()
    otherNode.data.nodeName = 'mac'
    h.message(otherNode as any, JSON.stringify({ type: 'mcpResult', callId: exec.callId, success: true, data: '"spoofed"' }))
    expect(caller.sent).toHaveLength(0)
    // The declared host answers; the caller gets its own requestId back.
    const hostWs = mockWs()
    hostWs.data.nodeName = 'nas642'
    h.message(hostWs as any, JSON.stringify({ type: 'mcpResult', callId: exec.callId, success: true, data: '{"found":true}' }))
    expect(JSON.parse(caller.sent[0]!)).toMatchObject({ type: 'toolResult', requestId: 'req1', success: true, data: '{"found":true}' })
  })

  test('mcpCall on a side-effecting server is rejected at the router and audited', () => {
    const deps = makeDeps({
      mcp: routerMcp([WRITER], 100),
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
      mcp: routerMcp([READ_ONLY], 100),
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
  // Fake server that enforces the MCP lifecycle: tools are rejected until
  // notifications/initialized arrives, and tools/call echoes an env var to prove
  // the resolved env actually reached the child process.
  const FAKE_SERVER = `
let buf = '', initialized = false
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n')
    } else if (m.method === 'notifications/initialized') {
      initialized = true
    } else if (m.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(initialized
        ? { result: { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } }
        : { error: { message: 'not initialized' } }) }) + '\\n')
    } else if (m.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(initialized
        ? { result: { content: [{ type: 'text', text: 'env:' + process.env.MCP_TEST_TOKEN }] } }
        : { error: { message: 'not initialized' } }) }) + '\\n')
    }
  }
})
`

  const DELAYED_SERVER = `
setTimeout(() => process.stdout.write(''), 50) // delayed start
let buf = ''
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') {
      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n'), 120)
    } else if (m.method === 'notifications/initialized') {
      // ok
    } else if (m.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'lookup' }] } }) + '\\n')
    } else if (m.method === 'tools/call') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'done:' + (m.params?.name ?? '?') }] } }) + '\\n')
    }
  }
})
`

  test('lifecycle: initialized notification sent before tool requests; env reaches the child', async () => {
    const child = new McpChild()
    const spec = { server: 'fake', command: process.execPath, args: ['-e', FAKE_SERVER], env: { MCP_TEST_TOKEN: 'tok-123' }, method: 'tools/list' }
    const list = await child.call(spec)
    expect(list.ok).toBe(true) // would fail if notifications/initialized were not sent first
    expect(JSON.parse(list.data).tools[0]).toMatchObject({ name: 'lookup' })
    const call = await child.call({ ...spec, method: 'lookup', params: {} })
    expect(call.ok).toBe(true)
    expect(JSON.parse(call.data).content[0].text).toBe('env:tok-123') // env was merged into the child
    child.close()
  })

  test('concurrent first calls await the same initialization (single spawn)', async () => {
    let spawns = 0
    const child = new McpChild((c, a, e) => { spawns++; return spawnStdio(c, a, e) })
    const spec = (method: string) => ({ server: 'slow', command: process.execPath, args: ['-e', DELAYED_SERVER], method })
    const [r1, r2] = await Promise.all([child.call(spec('tools/list')), child.call({ ...spec('lookup'), params: {} })])
    expect(spawns).toBe(1) // one child, one shared init
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    child.close()
  })

  test('spawn failure surfaces as a clean error', async () => {
    const child = new McpChild()
    const r = await child.call({ server: 'nope', command: '/nonexistent/binary', method: 'tools/list' })
    expect(r.ok).toBe(false)
    expect(r.data).toContain('spawn failed')
  })

  test('an unreadable file: env ref resolves {ok:false} instead of rejecting (node daemon must not crash)', async () => {
    const child = new McpChild()
    const r = await child.call({ server: 'badenv', command: process.execPath, args: ['-e', ''], env: { K: 'file:/nonexistent/secret' }, method: 'tools/list' })
    expect(r.ok).toBe(false)
    expect(r.data).toContain('cannot start')
  })

  test('a failed/slow initialize evicts the child: a later call respawns instead of reusing the dead entry', async () => {
    // Server whose initialize response takes 300 ms; init timeout 50 ms → first call fails fast.
    const child = new McpChild(undefined, () => {}, 50)
    const slow = { server: 'flaky', command: process.execPath, args: ['-e', DELAYED_SERVER], method: 'tools/list' }
    const r1 = await child.call(slow)
    expect(r1.ok).toBe(false)
    expect(r1.data).toContain('initialize handshake timed out')
    // Same server name, but an instantly-initializing server: must spawn fresh and succeed.
    const r2 = await child.call({ server: 'flaky', command: process.execPath, args: ['-e', FAKE_SERVER], env: {}, method: 'tools/list' })
    expect(r2.ok).toBe(true)
    expect(JSON.parse(r2.data).tools[0]).toMatchObject({ name: 'lookup' })
    child.close()
  })
})

import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
function spawnStdio(command: string, args: readonly string[], env: Record<string, string>): ChildProcessWithoutNullStreams {
  return nodeSpawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
}
