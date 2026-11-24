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
  /** Allowlisted tool names — REQUIRED. Omitted methods would mean allow-all, which
   *  draft v2 item 5 forbids: undeclared methods must be hard-rejected. */
  readonly methods: readonly string[]
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
  private readonly servers: ReadonlyMap<string, McpServerDecl>

  constructor(servers: readonly McpServerDecl[] = []) {
    this.servers = new Map(servers.map(s => [s.name, s]))
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
      if (!Array.isArray(s.methods) || s.methods.length === 0 || !s.methods.every(m => typeof m === 'string')) {
        throw new Error(`${file}: server "${s.name}": "methods" is required (a non-empty allowlist; allow-all is forbidden)`)
      }
      if (s.command !== undefined || s.env !== undefined || s.args !== undefined) {
        throw new Error(`${file}: server "${s.name}": command/args/env must live in the node's own config, not the registry (review blocker 1)`)
      }
    }
    return new McpRegistry(raw.servers as readonly McpServerDecl[])
  }

  /** Convenience for the router: absent file = feature present but empty (mcp_list shows []). */
  static fromFileOrNull(file: string): McpRegistry | null {
    if (!existsSync(file)) return null
    return McpRegistry.fromFile(file)
  }

  list(): Array<{ name: string; description: string; node: string; class: McpClass; methods: number }> {
    return [...this.servers.values()].map(s => ({
      name: s.name,
      description: s.description ?? '',
      node: s.node,
      class: s.class,
      methods: s.methods.length,
    }))
  }

  get(name: string): McpServerDecl | undefined { return this.servers.get(name) }

  /** Admission check for one call. Side-effecting servers need a valid grant. */
  checkCall(name: string, method: string, grants: Grants, caller: McpCaller, grantId?: string): McpDecision {
    const decl = this.servers.get(name)
    if (!decl) return { ok: false, reason: `server "${name}" is not declared in the registry` }
    if (!decl.methods.includes(method)) {
      return { ok: false, reason: `method "${method}" is not allowlisted for server "${name}"` }
    }
    if (decl.class === 'side-effecting') {
      if (!grantId) return { ok: false, reason: `server "${name}" is side-effecting: a Mick-issued grant ID is required (none are issued in round one)` }
      if (!grants.check(grantId, name, caller)) {
        return { ok: false, reason: `grant rejected for server "${name}" (unknown, expired, session/instance-mismatched or revoked)` }
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
  /** Restrict to one client instance id (the register-time instanceId); omit = any instance. */
  readonly instance?: string
  readonly expires: string
  readonly note?: string
}

/** Who is calling: display name plus the register-time instance id of the connection. */
export interface McpCaller {
  readonly session: string
  readonly instance?: string
}

export class Grants {
  private readonly map = new Map<string, McpGrant>()
  private fileStamp = ''
  constructor(private readonly file?: string) { this.reload(true) }
  static inStateDir(dir: string): Grants { return new Grants(join(dir, 'mcp-grants.json')) }

  private stamp(): string {
    if (!this.file) return ''
    try { const s = statSync(this.file); return `${s.mtimeMs}:${s.size}` } catch { return '' }
  }

  /** Reload the persisted grants if the file changed since the last load (live revocation).
   *  Fails CLOSED: if the file is missing or unparseable, the in-memory grants are dropped —
   *  a corrupted state must not keep authorizing side-effecting calls. */
  reload(force = false): void {
    if (!this.file) return
    const now = this.stamp()
    if (!force && now === this.fileStamp) return
    this.fileStamp = now
    let next: McpGrant[] = []
    try {
      next = JSON.parse(readFileSync(this.file, 'utf8')) as McpGrant[]
    } catch (err: unknown) {
      process.stderr.write(`discord channel: mcp grants file unreadable (${errText(err)}); failing closed\n`)
    }
    this.map.clear()
    for (const g of next) this.map.set(g.id, g)
  }

  issue(server: string, opts: { session?: string; instance?: string; ttlHours?: number; note?: string } = {}): McpGrant {
    const id = `mcpgr_${randomBytes(16).toString('hex').slice(0, 24)}`
    const g: McpGrant = {
      id,
      server,
      ...(opts.session && { session: opts.session }),
      ...(opts.instance && { instance: opts.instance }),
      expires: new Date(Date.now() + (opts.ttlHours ?? 24) * 3600_000).toISOString(),
      ...(opts.note && { note: opts.note }),
    }
    this.map.set(id, g)
    this.save()
    return g
  }

  check(id: string, server: string, caller: McpCaller): boolean {
    this.reload()
    const g = this.map.get(id)
    if (!g || g.server !== server) return false
    if (g.session && g.session !== caller.session) return false
    if (g.instance && g.instance !== caller.instance) return false
    return Date.parse(g.expires) > Date.now()
  }

  revoke(id: string): boolean {
    const had = this.map.delete(id)
    if (had) this.save()
    return had
  }

  list(): McpGrant[] { this.reload(); return [...this.map.values()] }

  /** Persist, then adopt the new stamp so our own write isn't mistaken for an external edit. */
  private save(): void {
    if (!this.file) return
    try { writeJsonAtomic(this.file, [...this.map.values()]) } catch {}
    this.fileStamp = this.stamp()
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
    this.take(callId)
    const timer = setTimeout(() => this.settle(callId, false, `mcp call timed out after ${this.timeoutMs} ms`), this.timeoutMs)
    this.map.set(callId, { target, clientRequestId, node, timer })
  }

  /** Resolve a call — only from the node it was forwarded to. Unknown ids and wrong nodes are ignored. */
  resolve(callId: string, fromNode: string | undefined, success: boolean, data: string): boolean {
    if (!fromNode || this.map.get(callId)?.node !== fromNode) return false
    this.settle(callId, success, data)
    return true
  }

  /** Remove a pending entry (and its timer); returns it if it existed. */
  private take(callId: string): PendingEntry | undefined {
    const p = this.map.get(callId)
    if (p) { clearTimeout(p.timer); this.map.delete(callId) }
    return p
  }

  private settle(callId: string, success: boolean, data: string): void {
    const p = this.take(callId)
    p?.target.send(JSON.stringify({ type: 'toolResult', requestId: p.clientRequestId, success, data }))
  }
}

/** Router-side remote-MCP wiring handed to the ws handlers (present only when a registry is loaded). */
export interface McpRouterDeps {
  readonly registry: McpRegistry
  readonly grants: Grants
  readonly audit: McpAudit
  readonly pending: PendingMcpCalls
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
  /** Initialize-handshake timeout for slow-starting servers (default 10 s). */
  readonly initTimeoutMs?: number
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
      ...(typeof v.initTimeoutMs === 'number' && v.initTimeoutMs > 0 && { initTimeoutMs: v.initTimeoutMs }),
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
      ...(entry.initTimeoutMs && { initTimeoutMs: entry.initTimeoutMs }),
      method: req.method, ...(req.params !== undefined && { params: req.params }),
      timeoutMs: req.timeoutMs,
    },
  }
}

export interface McpExecSpec {
  readonly server: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly method: string
  readonly params?: unknown
  readonly timeoutMs?: number
  /** Overrides the McpChild default initialize timeout for this server. */
  readonly initTimeoutMs?: number
}

/** Outcome of one node-side MCP operation. Failures are values, never rejections. */
export interface McpOutcome { readonly ok: boolean; readonly data: string }

/** Resolve "file:/path" env values on the hosting node; literals pass through. */
export function resolveEnv(env: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = v.startsWith('file:') ? readFileSync(v.slice(5), 'utf8').trim() : v
  }
  return out
}

export type SpawnFn = (command: string, args: readonly string[], env: Record<string, string>) => ChildProcessWithoutNullStreams
const defaultSpawn: SpawnFn = (command, args, env) => spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams

interface ChildState {
  readonly proc: ChildProcessWithoutNullStreams
  nextId: number
  readonly pending: Map<number, { resolve(v: McpOutcome): void; timer: ReturnType<typeof setTimeout> }>
  buffer: string
  /** Shared readiness: initialize handshake completed (notifications/initialized sent). */
  ready: Promise<McpOutcome>
}

export class McpChild {
  private readonly children = new Map<string, ChildState>()

  constructor(private readonly spawnFn: SpawnFn = defaultSpawn, private readonly log: (m: string) => void = () => {}, private readonly initTimeoutMs = 10_000) {}

  /** Run one method ('tools/list' or a tool name via 'tools/call') on a (re)spawned child.
   *  NEVER rejects: every failure path resolves {ok:false} (a rejecting call would crash
   *  node daemons whose handlers cannot catch mid-promise throws). */
  async call(spec: McpExecSpec): Promise<McpOutcome> {
    let child: ChildState
    try {
      child = this.ensureChild(spec)
    } catch (err: unknown) {
      // e.g. an unreadable "file:" env ref — configuration problem on this node.
      return { ok: false, data: `${spec.server}: cannot start: ${errText(err)}` }
    }
    const ready = await child.ready
    if (!ready.ok) {
      // A failed/slow initialize must not brick the server for later calls: evict and kill.
      this.dropChild(spec.server, child)
      return ready
    }
    const timeoutMs = spec.timeoutMs ?? 20_000
    return spec.method === 'tools/list'
      ? this.rpc(spec.server, child, 'tools/list', undefined, timeoutMs, 'tools/list')
      : this.rpc(spec.server, child, 'tools/call', { name: spec.method, arguments: spec.params ?? {} }, timeoutMs, spec.method)
  }

  /** Kill every child (node shutdown). */
  close(): void {
    for (const c of this.children.values()) try { c.proc.kill('SIGTERM') } catch {}
    this.children.clear()
  }

  /** Kill and forget a cached child, but only if it is still the cached one. */
  private dropChild(server: string, child: ChildState): void {
    if (this.children.get(server) !== child) return
    this.children.delete(server)
    try { child.proc.kill('SIGTERM') } catch {}
  }

  /** Get or spawn the child for a server; every concurrent caller shares one readiness promise. */
  private ensureChild(spec: McpExecSpec): ChildState {
    const existing = this.children.get(spec.server)
    if (existing && existing.proc.exitCode === null && !existing.proc.killed) return existing
    const { server } = spec
    const proc = this.spawnFn(spec.command, spec.args ?? [], { ...(process.env as Record<string, string>), ...resolveEnv(spec.env) })
    const child: ChildState = { proc, nextId: 1, pending: new Map(), buffer: '', ready: Promise.resolve({ ok: false, data: 'unreachable' }) }
    this.children.set(server, child)
    // Ownership guard: once this child is replaced, its events must not touch the successor.
    const isCurrent = () => this.children.get(server) === child
    // Decode as a stream: per-chunk toString() would split multi-byte UTF-8 characters into U+FFFD.
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (d: string) => { if (isCurrent()) this.onStdout(server, child, d) })
    proc.stderr.on('data', (d: string) => this.log(`${server} stderr: ${d.trim().slice(0, 200)}`))
    const failAll = (msg: string) => {
      if (isCurrent()) this.children.delete(server)
      for (const [id, p] of child.pending) { child.pending.delete(id); clearTimeout(p.timer); p.resolve({ ok: false, data: `${server}: ${msg}` }) }
    }
    // Spawn errors (ENOENT etc.) arrive asynchronously as 'error', not from spawn() itself.
    proc.on('error', (err: Error) => failAll(`spawn failed: ${err.message}`))
    proc.on('exit', () => failAll('server process exited'))
    child.ready = this.initialize(server, child, spec.initTimeoutMs ?? this.initTimeoutMs)
    return child
  }

  /** initialize → wait for the response → send notifications/initialized (MCP lifecycle). */
  private async initialize(server: string, child: ChildState, timeoutMs: number): Promise<McpOutcome> {
    const r = await this.rpc(server, child, 'initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-bus', version: '0.1' },
    }, timeoutMs, 'initialize handshake')
    if (!r.ok) return r
    try { write(child, { method: 'notifications/initialized' }) } catch { /* server already gone; the next write fails */ }
    return { ok: true, data: '' }
  }

  /** One JSON-RPC request with its own timeout; resolves (never rejects) on reply, timeout or write failure. */
  private rpc(server: string, child: ChildState, method: string, params: unknown, timeoutMs: number, label: string): Promise<McpOutcome> {
    return new Promise(resolve => {
      const id = child.nextId++
      const timer = setTimeout(() => {
        child.pending.delete(id)
        resolve({ ok: false, data: `${server}: ${label} timed out after ${timeoutMs} ms` })
      }, timeoutMs)
      child.pending.set(id, { resolve, timer })
      try { write(child, { id, method, ...(params !== undefined && { params }) }) } catch (err: unknown) {
        child.pending.delete(id); clearTimeout(timer)
        resolve({ ok: false, data: `${server}: ${label}: write failed: ${errText(err)}` })
      }
    })
  }

  private onStdout(server: string, child: ChildState, chunk: string): void {
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
      p.resolve(msg.error
        ? { ok: false, data: `${server}: ${msg.error.message ?? 'server error'}` }
        : { ok: true, data: JSON.stringify(msg.result ?? null) })
    }
  }
}

/** Write one newline-delimited JSON-RPC message to a child's stdin (throws if the pipe is gone). */
function write(child: ChildState, msg: Record<string, unknown>): void {
  child.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
}

function errText(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** Atomic JSON write (temp file + rename), used for the grants file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}
