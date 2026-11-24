/**
 * Remote MCP over the agent bus (consensus T20, draft v2.1).
 *
 * The registry *declaration* lives in a git-reviewed JSON file (deployed next to the
 * router state, e.g. mickg-containers/vps2/agent-bus/mcp-registry.json). It declares
 * each server: hosting node, spawn command, allowlisted methods and its class.
 * The *runtime* (grants, health, pending calls) lives in the router state dir.
 *
 * Enforcement model (the router is the only approval boundary most clients have):
 *  - undeclared server          → reject
 *  - method outside allowlist   → reject
 *  - class "side-effecting"     → reject unless the call carries a valid grant ID
 *    (round one issues zero grants, so side-effecting is default-deny)
 *  - every decision is appended to mcp-audit.jsonl (session, server, tool, args-hash).
 *
 * env values in the declaration may be literals or "file:/abs/path" — file refs are
 * resolved by the *hosting node* at spawn time, so secrets never transit the bus.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

export type McpClass = 'read-only' | 'side-effecting'

/** One declared MCP server (git-reviewed source of truth). */
export interface McpServerDecl {
  readonly name: string
  readonly description?: string
  /** Node name (as registered by its daemon) that hosts/spawns this server. */
  readonly node: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly owner?: string
  readonly class: McpClass
  /** Allowlisted tool names. Omit to allow every tool the server lists (class still gates). */
  readonly methods?: readonly string[]
  readonly timeoutMs?: number
}

export interface McpRegistryFile {
  readonly servers: readonly McpServerDecl[]
}

export type McpDecision =
  | { readonly ok: true; readonly decl: McpServerDecl }
  | { readonly ok: false; readonly reason: string }

/** Router-side: the git-declared server list + call admission. */
export class McpRegistry {
  private readonly servers = new Map<string, McpServerDecl>()
  private readonly loadedFrom?: string

  constructor(servers: readonly McpServerDecl[] = [], file?: string) {
    for (const s of servers) this.servers.set(s.name, s)
    this.loadedFrom = file
  }

  /** Load and validate a registry file. Throws on malformed entries (fail closed). */
  static fromFile(file: string): McpRegistry {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<McpRegistryFile>
    if (!raw || !Array.isArray(raw.servers)) throw new Error(`${file}: "servers" must be an array`)
    for (const s of raw.servers) {
      if (typeof s?.name !== 'string' || typeof s?.node !== 'string' || typeof s?.command !== 'string') {
        throw new Error(`${file}: server entries need name, node and command`)
      }
      if (s.class !== 'read-only' && s.class !== 'side-effecting') {
        throw new Error(`${file}: server "${s.name}": class must be "read-only" or "side-effecting"`)
      }
    }
    return new McpRegistry(raw.servers as readonly McpServerDecl[], file)
  }

  /** Convenience for the router: absent file = feature present but empty (mcp_list shows []). */
  static fromFileOrNull(file: string): McpRegistry | null {
    if (!existsSync(file)) return null
    return McpRegistry.fromFile(file)
  }

  get source(): string | undefined { return this.loadedFrom }

  list(): Array<{ name: string; description: string; node: string; class: McpClass; methods: string | number }> {
    return [...this.servers.values()].map(s => ({
      name: s.name,
      description: s.description ?? '',
      node: s.node,
      class: s.class,
      methods: s.methods ? s.methods.length : 'all',
    }))
  }

  get(name: string): McpServerDecl | undefined { return this.servers.get(name) }

  /** Admission check for one call. Side-effecting servers need a valid grant. */
  checkCall(name: string, method: string, grants: Grants, session: string, grantId?: string): McpDecision {
    const decl = this.servers.get(name)
    if (!decl) return { ok: false, reason: `server "${name}" is not declared in the registry` }
    if (decl.methods && !decl.methods.includes(method)) {
      return { ok: false, reason: `method "${method}" is not allowlisted for server "${name}"` }
    }
    if (decl.class === 'side-effecting') {
      if (!grantId) return { ok: false, reason: `server "${name}" is side-effecting: a Mick-issued grant ID is required (none are issued in round one)` }
      if (!grants.check(grantId, name, session)) {
        return { ok: false, reason: `grant rejected for server "${name}" (unknown, expired, session-mismatched or revoked)` }
      }
    }
    return { ok: true, decl }
  }
}

// ---------------------------------------------------------------------------
// Grants (router state). Round one issues none; issuance is CLI-only for Mick.
// ---------------------------------------------------------------------------

export interface McpGrant {
  readonly id: string
  readonly server: string
  /** Restrict to one session name; omit = any session may present it. */
  readonly session?: string
  readonly expires: string
  readonly note?: string
}

export class Grants {
  private readonly map = new Map<string, McpGrant>()
  constructor(private readonly file?: string) {
    if (!file) return
    try { for (const g of JSON.parse(readFileSync(file, 'utf8')) as McpGrant[]) this.map.set(g.id, g) } catch {}
  }
  static inStateDir(dir: string): Grants { return new Grants(join(dir, 'mcp-grants.json')) }

  issue(server: string, opts: { session?: string; ttlHours?: number; note?: string } = {}): McpGrant {
    const id = `mcpgr_${createHash('sha256').update(cryptoRandom()).digest('hex').slice(0, 24)}`
    const g: McpGrant = {
      id,
      server,
      ...(opts.session && { session: opts.session }),
      expires: new Date(Date.now() + (opts.ttlHours ?? 24) * 3600_000).toISOString(),
      ...(opts.note && { note: opts.note }),
    }
    this.map.set(id, g)
    this.save()
    return g
  }

  check(id: string, server: string, session: string): boolean {
    const g = this.map.get(id)
    if (!g || g.server !== server) return false
    if (g.session && g.session !== session) return false
    return Date.parse(g.expires) > Date.now()
  }

  revoke(id: string): boolean { const had = this.map.delete(id); if (had) this.save(); return had }
  list(): McpGrant[] { return [...this.map.values()] }
  private save(): void {
    if (!this.file) return
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(this.list(), null, 2)) } catch {}
  }
}

function cryptoRandom(): string {
  return randomBytes(16).toString('hex')
}

// ---------------------------------------------------------------------------
// Audit log: one JSON line per admission decision.
// ---------------------------------------------------------------------------

export interface McpAuditEntry {
  readonly at: string
  readonly session: string
  readonly server: string
  readonly method: string
  readonly argsHash: string
  readonly decision: string
}

export class McpAudit {
  constructor(private readonly file?: string) {}
  static inStateDir(dir: string): McpAudit { return new McpAudit(join(dir, 'mcp-audit.jsonl')) }

  record(session: string, server: string, method: string, params: unknown, decision: string): void {
    if (!this.file) return
    const entry: McpAuditEntry = {
      at: new Date().toISOString(),
      session,
      server,
      method,
      argsHash: createHash('sha256').update(JSON.stringify(params ?? null)).digest('hex'),
      decision,
    }
    try { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, `${JSON.stringify(entry)}\n`) } catch {}
  }
}

// ---------------------------------------------------------------------------
// Pending mcpCall accounting on the router: requestId → answering websocket.
// ---------------------------------------------------------------------------

export interface PendingTarget { send(msg: string): void }

export class PendingMcpCalls {
  private readonly map = new Map<string, { target: PendingTarget; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly timeoutMs = 30_000) {}

  register(requestId: string, target: PendingTarget): void {
    this.clear(requestId)
    const timer = setTimeout(() => {
      if (this.map.delete(requestId)) {
        target.send(JSON.stringify({ type: 'toolResult', requestId, success: false, data: `mcp call timed out after ${this.timeoutMs} ms` }))
      }
    }, this.timeoutMs)
    this.map.set(requestId, { target, timer })
  }

  resolve(requestId: string, success: boolean, data: string): boolean {
    const p = this.map.get(requestId)
    if (!p) return false
    clearTimeout(p.timer)
    this.map.delete(requestId)
    p.target.send(JSON.stringify({ type: 'toolResult', requestId, success, data }))
    return true
  }

  private clear(requestId: string): void {
    const p = this.map.get(requestId)
    if (p) { clearTimeout(p.timer); this.map.delete(requestId) }
  }
}

// ---------------------------------------------------------------------------
// Node side: stdio JSON-RPC child processes, one per server, respawned on exit.
// ---------------------------------------------------------------------------

export type SpawnFn = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams
const defaultSpawn: SpawnFn = (command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams

interface ChildState {
  proc: ChildProcessWithoutNullStreams
  nextId: number
  pending: Map<number, { resolve(v: { ok: boolean; data: string }): void; timer: ReturnType<typeof setTimeout> }>
  buffer: string
}

export interface McpExecSpec {
  readonly server: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly method: string
  readonly params?: unknown
  readonly timeoutMs?: number
}

/** Resolve "file:/path" env values on the hosting node; literals pass through. */
export function resolveEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = v.startsWith('file:') ? readFileSync(v.slice(5), 'utf8').trim() : v
  }
  return out
}

export class McpChild {
  private readonly children = new Map<string, ChildState>()

  constructor(private readonly spawnFn: SpawnFn = defaultSpawn, private readonly log: (m: string) => void = () => {}) {}

  /** Run one method ('tools/list' or a tool name via 'tools/call') on a (re)spawned child. */
  call(spec: McpExecSpec): Promise<{ ok: boolean; data: string }> {
    const timeoutMs = spec.timeoutMs ?? 20_000
    return this.withChild(spec, child => new Promise<{ ok: boolean; data: string }>(resolve => {
      const id = child.nextId++
      const timer = setTimeout(() => {
        child.pending.delete(id)
        resolve({ ok: false, data: `${spec.server}: ${spec.method} timed out after ${timeoutMs} ms` })
      }, timeoutMs)
      child.pending.set(id, { resolve, timer })
      const rpc = spec.method === 'tools/list'
        ? { jsonrpc: '2.0', id, method: 'tools/list' }
        : { jsonrpc: '2.0', id, method: 'tools/call', params: { name: spec.method, arguments: spec.params ?? {} } }
      try { child.proc.stdin.write(`${JSON.stringify(rpc)}\n`) } catch (err: unknown) {
        child.pending.delete(id); clearTimeout(timer)
        resolve({ ok: false, data: `${spec.server}: write failed: ${err instanceof Error ? err.message : String(err)}` })
      }
    }))
  }

  /** Kill every child (node shutdown). */
  close(): void {
    for (const [, c] of this.children) try { c.proc.kill('SIGTERM') } catch {}
    this.children.clear()
  }

  private withChild(spec: McpExecSpec, fn: (child: ChildState) => Promise<{ ok: boolean; data: string }>): Promise<{ ok: boolean; data: string }> {
    let child = this.children.get(spec.server)
    if (!child || child.proc.exitCode !== null || child.proc.killed) {
      let proc: ChildProcessWithoutNullStreams
      try {
        proc = this.spawnFn(spec.command, spec.args ?? [])
      } catch (err: unknown) {
        return Promise.resolve({ ok: false, data: `${spec.server}: spawn failed: ${err instanceof Error ? err.message : String(err)}` })
      }
      child = { proc, nextId: 1, pending: new Map(), buffer: '' }
      this.children.set(spec.server, child)
      proc.stdout.on('data', (d: Buffer) => this.onStdout(spec.server, d.toString()))
      proc.stderr.on('data', (d: Buffer) => this.log(`${spec.server} stderr: ${String(d).trim().slice(0, 200)}`))
      // Spawn errors (ENOENT etc.) arrive asynchronously as 'error', not from spawn() itself.
      proc.on('error', (err: Error) => {
        const c = this.children.get(spec.server)
        if (c === child) this.children.delete(spec.server)
        for (const [, p] of c?.pending ?? []) { clearTimeout(p.timer); p.resolve({ ok: false, data: `${spec.server}: spawn failed: ${err.message}` }) }
      })
      proc.on('exit', () => {
        const c = this.children.get(spec.server)
        if (c === child) this.children.delete(spec.server)
        for (const [, p] of c?.pending ?? []) { clearTimeout(p.timer); p.resolve({ ok: false, data: `${spec.server}: server process exited` }) }
      })
      return this.initialize(spec, child).then(init => {
        if (!init.ok) return init
        return fn(child!)
      })
    }
    return fn(child)
  }

  private initialize(spec: McpExecSpec, child: ChildState): Promise<{ ok: boolean; data: string }> {
    return new Promise(resolve => {
      const id = child.nextId++
      const timer = setTimeout(() => {
        child.pending.delete(id)
        resolve({ ok: false, data: `${spec.server}: initialize handshake timed out` })
      }, 10_000)
      child.pending.set(id, { resolve, timer })
      const rpc = {
        jsonrpc: '2.0', id, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-bus', version: '0.1' } },
      }
      try { child.proc.stdin.write(`${JSON.stringify(rpc)}\n`) } catch { clearTimeout(timer); resolve({ ok: false, data: `${spec.server}: server closed during initialize` }) }
    })
  }

  private onStdout(server: string, chunk: string): void {
    const child = this.children.get(server)
    if (!child) return
    child.buffer += chunk
    let idx: number
    while ((idx = child.buffer.indexOf('\n')) >= 0) {
      const line = child.buffer.slice(0, idx).trim()
      child.buffer = child.buffer.slice(idx + 1)
      if (!line) continue
      let msg: { id?: number; result?: unknown; error?: { message?: string } }
      try { msg = JSON.parse(line) } catch { this.log(`${server}: non-JSON stdout ignored`); continue }
      if (typeof msg.id !== 'number') continue // notification (e.g. initialized)
      const p = child.pending.get(msg.id)
      if (!p) continue
      child.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.resolve({ ok: false, data: `${server}: ${msg.error.message ?? 'server error'}` })
      else p.resolve({ ok: true, data: JSON.stringify(msg.result ?? null) })
    }
  }
}

/** Atomic write helper reused by deploy tooling. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}
