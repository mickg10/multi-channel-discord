/**
 * Remote MCP over the agent bus (consensus T20, draft v2.1 + PR #2 review fixes).
 *
 * Trust model after review:
 *  - The router's git-declared registry (MCP_REGISTRY or state-dir mcp-registry.json) holds
 *    ONLY admission facts: name, hosting node, class, optional method allowlist. It never
 *    carries command/args/env, so nothing that reaches a node can select a program to run.
 *  - Each node daemon keeps its OWN allowlist in node.json ("mcpServers": {name → command,
 *    args, env}) and refuses servers that are not declared locally, even if the router asks.
 *    The router→node message is exactly {callId, server, method, params, timeoutMs}.
 *  - Pending calls are keyed by router-minted call ids (client requestIds can collide) and
 *    bound to the declared host node: an mcpResult from any other node connection is ignored.
 *  - class "side-effecting" requires a grant ID; grants live in mcp-grants.json and are
 *    reloaded when the file changes, so CLI revocations apply to the running router.
 *  - Every admission decision is appended to mcp-audit.jsonl (session, server, tool, args-hash).
 *
 * env values in a node's local config may be literals or "file:/abs/path" — resolved by the
 * hosting node at spawn time and merged into the child's environment, so secrets never
 * transit the bus and never enter client configs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

export type McpClass = 'read-only' | 'side-effecting'

/** One declared MCP server on the router (git-reviewed; admission facts only). */
export interface McpServerDecl {
  readonly name: string
  readonly description?: string
  /** Node name (as registered by its daemon) that hosts this server. */
  readonly node: string
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
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<McpRegistryFile> & { servers?: unknown }
    if (!raw || !Array.isArray(raw.servers)) throw new Error(`${file}: "servers" must be an array`)
    for (const s of raw.servers as Array<Partial<McpServerDecl> & Record<string, unknown>>) {
      if (typeof s?.name !== 'string' || typeof s?.node !== 'string') {
        throw new Error(`${file}: server entries need name and node`)
      }
      if (s.class !== 'read-only' && s.class !== 'side-effecting') {
        throw new Error(`${file}: server "${s.name}": class must be "read-only" or "side-effecting"`)
      }
      if (s.command !== undefined || s.env !== undefined || s.args !== undefined) {
        throw new Error(`${file}: server "${s.name}": command/args/env must live in the node's own config, not the registry (review blocker 1)`)
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
// The file is re-checked (mtime) before every admission so CLI revocations apply live.
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
  private fileStamp = ''
  constructor(private readonly file?: string) {
    if (!file) return
    this.reload()
    this.fileStamp = this.stamp()
  }
  static inStateDir(dir: string): Grants { return new Grants(join(dir, 'mcp-grants.json')) }

  private stamp(): string {
    if (!this.file) return ''
    try { const s = statSync(this.file); return `${s.mtimeMs}:${s.size}` } catch { return '' }
  }

  /** Reload the persisted grants if the file changed since the last load (live revocation). */
  reload(force = false): void {
    if (!this.file) return
    const now = this.stamp()
    if (!force && now === this.fileStamp) return
    this.fileStamp = now
    try {
      const next = new Map<string, McpGrant>()
      for (const g of JSON.parse(readFileSync(this.file, 'utf8')) as McpGrant[]) next.set(g.id, g)
      this.map.clear()
      for (const [k, v] of next) this.map.set(k, v)
    } catch {}
  }

  issue(server: string, opts: { session?: string; ttlHours?: number; note?: string } = {}): McpGrant {
    const id = `mcpgr_${randomBytes(16).toString('hex').slice(0, 24)}`
    const g: McpGrant = {
      id,
      server,
      ...(opts.session && { session: opts.session }),
      expires: new Date(Date.now() + (opts.ttlHours ?? 24) * 3600_000).toISOString(),
      ...(opts.note && { note: opts.note }),
    }
    this.map.set(id, g)
    this.save()
    this.fileStamp = this.stamp()
    return g
  }

  check(id: string, server: string, session: string): boolean {
    this.reload()
    const g = this.map.get(id)
    if (!g || g.server !== server) return false
    if (g.session && g.session !== session) return false
    return Date.parse(g.expires) > Date.now()
  }

  revoke(id: string): boolean { const had = this.map.delete(id); if (had) { this.save(); this.fileStamp = this.stamp() } return had }
  list(): McpGrant[] { this.reload(); return [...this.map.values()] }
  private save(): void {
    if (!this.file) return
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify([...this.map.values()], null, 2)) } catch {}
  }
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
// Pending mcpCall accounting on the router: router-minted call ids, bound to the
// declared host node and mapped back to (caller ws, client requestId).
// ---------------------------------------------------------------------------

export interface PendingTarget { send(msg: string): void }

interface PendingEntry {
  readonly target: PendingTarget
  readonly clientRequestId: string
  readonly node: string
  readonly timer: ReturnType<typeof setTimeout>
}

export function newCallId(): string { return `mcp_${randomBytes(12).toString('hex')}` }

export class PendingMcpCalls {
  private readonly map = new Map<string, PendingEntry>()
  constructor(private readonly timeoutMs = 30_000) {}

  /** Register a router-minted call id for (target, clientRequestId) on node `node`. */
  register(callId: string, target: PendingTarget, clientRequestId: string, node: string): void {
    this.clear(callId)
    const timer = setTimeout(() => {
      const p = this.map.get(callId)
      if (!p) return
      this.map.delete(callId)
      p.target.send(JSON.stringify({ type: 'toolResult', requestId: p.clientRequestId, success: false, data: `mcp call timed out after ${this.timeoutMs} ms` }))
    }, this.timeoutMs)
    this.map.set(callId, { target, clientRequestId, node, timer })
  }

  /** Resolve a call — only from the node it was forwarded to. Unknown ids are ignored. */
  resolve(callId: string, fromNode: string | undefined, success: boolean, data: string): boolean {
    const p = this.map.get(callId)
    if (!p) return false
    if (!fromNode || fromNode !== p.node) return false // answered by the wrong node: ignore
    clearTimeout(p.timer)
    this.map.delete(callId)
    p.target.send(JSON.stringify({ type: 'toolResult', requestId: p.clientRequestId, success, data }))
    return true
  }

  private clear(callId: string): void {
    const p = this.map.get(callId)
    if (p) { clearTimeout(p.timer); this.map.delete(callId) }
  }
}

// ---------------------------------------------------------------------------
// Node side: local server allowlist + stdio JSON-RPC children, one per server.
// ---------------------------------------------------------------------------

/** A server a node is willing to host, from its own node.json (never from the bus). */
export interface LocalMcpEntry {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** Optional local method allowlist (defense in depth on top of the router's). */
  readonly methods?: readonly string[]
}

export type LocalMcpConfig = Record<string, LocalMcpEntry>

/** Validate a node.json "mcpServers" section. Throws with the offending server name. */
export function validateLocalMcp(cfg: unknown): LocalMcpConfig {
  const out: Record<string, LocalMcpEntry> = {}
  if (cfg === undefined || cfg === null) return out
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('node.json: "mcpServers" must be an object')
  for (const [name, v] of Object.entries(cfg as Record<string, Partial<LocalMcpEntry>>)) {
    if (typeof v?.command !== 'string' || !v.command) throw new Error(`node.json: mcpServers.${name} needs a command`)
    out[name] = {
      command: v.command,
      ...(Array.isArray(v.args) && { args: v.args }),
      ...(v.env && typeof v.env === 'object' && { env: v.env as Record<string, string> }),
      ...(Array.isArray(v.methods) && { methods: v.methods }),
    }
  }
  return out
}

/** Router-requested exec, reduced to facts a node may act on (no command, no env). */
export interface McpExecRequest {
  readonly callId: string
  readonly server: string
  readonly method: string
  readonly params?: unknown
  readonly timeoutMs?: number
}

/** Look up a router request against the node's local allowlist. Fails closed. */
export function resolveLocalMcp(local: LocalMcpConfig, req: McpExecRequest): { ok: true; spec: McpExecSpec } | { ok: false; reason: string } {
  const entry = local[req.server]
  if (!entry) return { ok: false, reason: `node refuses to host "${req.server}": not in this node's mcpServers allowlist` }
  if (entry.methods && !entry.methods.includes(req.method)) {
    return { ok: false, reason: `node-local allowlist: method "${req.method}" not permitted for "${req.server}"` }
  }
  return {
    ok: true,
    spec: {
      server: req.server, command: entry.command,
      ...(entry.args && { args: entry.args }), ...(entry.env && { env: entry.env }),
      method: req.method, ...(req.params !== undefined && { params: req.params }),
      timeoutMs: req.timeoutMs,
    },
  }
}

export type SpawnFn = (command: string, args: readonly string[], env: Record<string, string>) => ChildProcessWithoutNullStreams
const defaultSpawn: SpawnFn = (command, args, env) => spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams

interface ChildState {
  proc: ChildProcessWithoutNullStreams
  nextId: number
  pending: Map<number, { resolve(v: { ok: boolean; data: string }): void; timer: ReturnType<typeof setTimeout> }>
  buffer: string
  /** Shared readiness: initialize handshake completed (notifications/initialized sent). */
  ready: Promise<{ ok: boolean; data: string }>
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
  async call(spec: McpExecSpec): Promise<{ ok: boolean; data: string }> {
    const child = this.ensureChild(spec)
    const ready = await child.ready
    if (!ready.ok) return ready
    return this.request(child, spec, spec.timeoutMs ?? 20_000)
  }

  /** Kill every child (node shutdown). */
  close(): void {
    for (const [, c] of this.children) try { c.proc.kill('SIGTERM') } catch {}
    this.children.clear()
  }

  /** Get or spawn the child for a server; every concurrent caller shares one readiness promise. */
  private ensureChild(spec: McpExecSpec): ChildState {
    const existing = this.children.get(spec.server)
    if (existing && existing.proc.exitCode === null && !existing.proc.killed) return existing
    const proc = this.spawnFn(spec.command, spec.args ?? [], { ...(process.env as Record<string, string>), ...resolveEnv(spec.env) })
    const child: ChildState = { proc, nextId: 1, pending: new Map(), buffer: '', ready: Promise.resolve({ ok: false, data: 'unreachable' }) }
    this.children.set(spec.server, child)
    proc.stdout.on('data', (d: Buffer) => this.onStdout(spec.server, d.toString()))
    proc.stderr.on('data', (d: Buffer) => this.log(`${spec.server} stderr: ${String(d).trim().slice(0, 200)}`))
    const failAll = (msg: string) => {
      const c = this.children.get(spec.server)
      if (c === child) this.children.delete(spec.server)
      for (const [, p] of c?.pending ?? []) { clearTimeout(p.timer); p.resolve({ ok: false, data: `${spec.server}: ${msg}` }) }
    }
    // Spawn errors (ENOENT etc.) arrive asynchronously as 'error', not from spawn() itself.
    proc.on('error', (err: Error) => failAll(`spawn failed: ${err.message}`))
    proc.on('exit', () => failAll('server process exited'))
    child.ready = this.initialize(spec, child)
    return child
  }

  /** initialize → wait for the response → send notifications/initialized (MCP lifecycle). */
  private initialize(spec: McpExecSpec, child: ChildState): Promise<{ ok: boolean; data: string }> {
    return new Promise(resolve => {
      const id = child.nextId++
      const timer = setTimeout(() => {
        child.pending.delete(id)
        resolve({ ok: false, data: `${spec.server}: initialize handshake timed out` })
      }, 10_000)
      child.pending.set(id, {
        resolve: v => {
          clearTimeout(timer)
          if (v.ok) {
            try { child.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`) } catch { /* server already gone; next write fails */ }
          }
          resolve(v.ok ? { ok: true, data: '' } : v)
        },
        timer,
      })
      const rpc = {
        jsonrpc: '2.0', id, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-bus', version: '0.1' } },
      }
      try { child.proc.stdin.write(`${JSON.stringify(rpc)}\n`) } catch { clearTimeout(timer); resolve({ ok: false, data: `${spec.server}: server closed during initialize` }) }
    })
  }

  private request(child: ChildState, spec: McpExecSpec, timeoutMs: number): Promise<{ ok: boolean; data: string }> {
    return new Promise(resolve => {
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
      if (typeof msg.id !== 'number') continue // notification
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
