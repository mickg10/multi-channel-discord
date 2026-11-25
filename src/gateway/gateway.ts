import { chmodSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { selectAdapter, stepDelivery, type DeliverTarget } from './deliver.js'
import { verifyPipePeer, type PeerInfo } from './peer.js'
import { type AgentRec, Registry } from './registry.js'
import { RouterLink } from './router-link.js'
import { WakeStore, type Attempt, type AttemptState } from './store.js'
import {
  assertAlias, buildNudge,
  type Adapter, type DeliveryResult, type GatewayToRouterMessage, type LeaseResult, type WakeResult,
} from './types.js'

const MAX_LINE = 1024 * 1024

type Line = { op?: string; conv?: string; cwd?: string; receipt?: string; leaseId?: string; id?: string }

export type GatewayOpts = {
  host: string
  user: string
  secret: string
  storePath: string
  send?: (frame: GatewayToRouterMessage) => void
  audit?: (frame: GatewayToRouterMessage) => void
  readPeer?: (sock: Socket) => PeerInfo | undefined
  verify?: typeof verifyPipePeer
}

export class Gateway {
  readonly registry = new Registry()
  readonly router: RouterLink
  store: WakeStore
  private adapters: Adapter[] = []
  private server?: Server
  private conns = new Set<Socket>()
  private queue = new WeakMap<Socket, Promise<void>>()
  private tail: Promise<unknown> = Promise.resolve()
  private verify: typeof verifyPipePeer

  constructor(private opts: GatewayOpts) {
    this.router = new RouterLink(opts.secret, opts.send ?? (() => {}), opts.audit)
    this.router.onWake = frame => this.onRouterWake(frame)
    this.router.onReleased = alias => this.registry.remove(alias)
    this.router.onReported = id => this.store.markReported(id)
    this.store = WakeStore.open(opts.storePath)
    this.verify = opts.verify ?? verifyPipePeer
  }

  setAdapters(adapters: Adapter[]): void {
    this.adapters = adapters
  }

  registerAgent(rec: AgentRec): void {
    if (rec.host !== this.opts.host || rec.user !== this.opts.user) throw new Error('host mismatch')
    assertAlias(rec.kind, rec.host, rec.alias)
    this.registry.add(rec)
    this.router.registerAgent(rec)
  }

  /** Owning gateway only. Disconnect does not release aliases. */
  release(alias: string): void {
    if (!this.registry.byAlias(alias)) return
    this.router.release(alias)
    this.registry.remove(alias)
  }

  /**
   * Wake at most once. Exactly one adapter matches `(kind, transport)`.
   * `unavailable` from that adapter is terminal: the session stays pull-only and no other adapter runs.
   * The wake row stores `n`, then the router is marked uncertain, then the adapter runs.
   * wakeResult is sent only after that I/O returns. No row means nothing was begun, so nothing is finished.
   */
  async deliver(target: DeliverTarget, msgId: string, n: number, opts?: { reconcile?: boolean }): Promise<DeliveryResult> {
    const before = this.store.get(msgId)
    if (before && isTerminal(before.state)) {
      const result = toWake(before)
      this.router.wakeResult(before.alias, msgId, result)
      return result
    }
    if (opts?.reconcile && !before) return this.reconcileMissing(target, msgId, n)
    const result = await stepDelivery({
      store: this.store, adapters: this.adapters, target, msgId, n,
      onPending: () => this.router.mark(target.alias, msgId),
    })
    if (result.s === 'queued') return result
    const row = this.store.get(msgId)
    if (!row) return result
    if (before && before.state !== 'pending' && before.state !== 'uncertain') return result
    this.store.finish(msgId, result)
    this.router.wakeResult(target.alias, msgId, result)
    return result
  }

  /** Restart path. Pending rows are already uncertain. Finished results the router never acked are sent again. */
  resumeFromDisk(): void {
    this.store = WakeStore.load(this.opts.storePath)
    for (const row of this.store.unreported()) this.router.wakeResult(row.alias, row.msgId, toWake(row))
  }

  /** Resolves when router-driven wakes started so far have settled. */
  idle(): Promise<void> {
    return this.tail.then(() => undefined)
  }

  async listen(sockPath: string): Promise<void> {
    privateDir(dirname(sockPath))
    try { unlinkSync(sockPath) } catch { /* absent */ }
    this.server = createServer(sock => this.onConn(sock))
    const previous = process.umask(0o077)
    let restored = false
    const restore = () => {
      if (restored) return
      restored = true
      process.umask(previous)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', err => { restore(); reject(err) })
        this.server!.listen(sockPath, () => {
          try { chmodSync(sockPath, 0o600) } finally { restore() }
          resolve()
        })
      })
    } catch (err) {
      restore()
      throw err
    }
    this.router.registerGateway(this.opts.host, this.opts.user)
  }

  close(): Promise<void> {
    for (const conn of this.conns) conn.destroy()
    return new Promise(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }

  private onRouterWake(frame: { as: string; msgId: string; n: number; reconcile?: true }): Promise<DeliveryResult> {
    const rec = this.registry.byAlias(frame.as)
    if (!rec) return Promise.resolve({ s: 'unavailable' })
    const run = this.deliver(rec, frame.msgId, frame.n, { reconcile: frame.reconcile === true })
    this.tail = this.tail.then(() => run.then(() => undefined, () => undefined))
    return run
  }

  private async reconcileMissing(target: DeliverTarget, msgId: string, n: number): Promise<WakeResult> {
    const adapter = selectAdapter(this.adapters, target.kind, target.transport)
    if (!adapter) return { s: 'uncertain' }
    const result = await adapter.reconcile(target, buildNudge(target.kind, target.conv, msgId, n))
    if (result.s !== 'unavailable') this.router.wakeResult(target.alias, msgId, result)
    return result
  }

  private onConn(sock: Socket): void {
    this.conns.add(sock)
    sock.on('close', () => this.conns.delete(sock))
    const peer = this.opts.readPeer?.(sock)
    const verdict = peer ? this.verify(peer, this.registry) : { ok: false as const, error: 'no peer credentials' }
    if (!verdict.ok) {
      sock.write(JSON.stringify({ ok: false, error: verdict.error }) + '\n')
      sock.end()
      return
    }
    const agents = verdict.agents
    let buf = ''
    sock.on('data', chunk => {
      buf += chunk.toString()
      if (buf.length > MAX_LINE) {
        buf = ''
        sock.destroy()
        return
      }
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        this.enqueue(sock, agents, line)
        nl = buf.indexOf('\n')
      }
    })
  }

  private enqueue(sock: Socket, agents: readonly AgentRec[], line: string): void {
    const prev = this.queue.get(sock) ?? Promise.resolve()
    const next = prev.then(() => this.handleLine(sock, agents, line)).catch(err => {
      sock.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) + '\n')
    })
    this.queue.set(sock, next)
  }

  private async handleLine(sock: Socket, agents: readonly AgentRec[], line: string): Promise<void> {
    let msg: Line
    try { msg = JSON.parse(line) as Line } catch {
      sock.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n')
      return
    }
    const picked = pickAgent(agents, msg.conv)
    if (picked.ok && !this.registry.matches(picked.agent)) {
      sock.write(JSON.stringify({ ok: false, error: 'alias rebound' }) + '\n')
      return
    }
    if (msg.op === 'check_inbox') {
      if (!picked.ok) { sock.write(JSON.stringify({ ok: false, error: picked.error }) + '\n'); return }
      try {
        const echoed = typeof msg.receipt === 'string' ? msg.receipt : undefined
        const leased = await this.router.lease(picked.agent.alias, echoed)
        this.store.clearOpen(picked.agent.conv)
        sock.write(JSON.stringify({ ok: true, ...leased }) + '\n')
      } catch (err) {
        sock.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'lease failed' }) + '\n')
      }
      return
    }
    if (msg.op === 'ack') {
      if (!picked.ok) { sock.write(JSON.stringify({ ok: false, error: picked.error }) + '\n'); return }
      if (typeof msg.receipt !== 'string' || typeof msg.leaseId !== 'string' || typeof msg.id !== 'string') {
        sock.write(JSON.stringify({ ok: false, error: 'invalid_receipt' }) + '\n')
        return
      }
      try {
        await this.router.ack(picked.agent.alias, msg.leaseId, msg.id, msg.receipt)
        this.store.ack(msg.id)
        sock.write(JSON.stringify({ ok: true }) + '\n')
      } catch (err) {
        sock.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'invalid_receipt' }) + '\n')
      }
      return
    }
    sock.write(JSON.stringify({ ok: false, error: 'unknown op' }) + '\n')
  }
}

function isTerminal(state: AttemptState): boolean {
  return state === 'woken' || state === 'held' || state === 'refused' || state === 'unavailable'
}

function toWake(row: Attempt): WakeResult {
  if (row.state === 'woken') return { s: 'woken', nativeId: row.nativeId ?? '' }
  if (row.state === 'held' || row.state === 'refused' || row.state === 'unavailable') return { s: row.state }
  return { s: 'uncertain' }
}

/** Create the socket directory at 0700 when this process owns it. Never chmod a directory owned by someone else. */
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.getuid === undefined) return
  if (statSync(path).uid !== process.getuid()) return
  chmodSync(path, 0o700)
}

/**
 * cwd in the payload is ignored. The verified parent may host several conversations,
 * so the runner names the conv on each call. One registered conv may be omitted.
 * That parent is one trust domain for every conv it registered.
 */
function pickAgent(agents: readonly AgentRec[], conv: string | undefined): { ok: true; agent: AgentRec } | { ok: false; error: string } {
  if (typeof conv === 'string' && conv.length > 0) {
    const agent = agents.find(item => item.conv === conv)
    return agent ? { ok: true, agent } : { ok: false, error: 'conv not registered' }
  }
  if (agents.length === 1) return { ok: true, agent: agents[0]! }
  return { ok: false, error: 'conv required' }
}

export type { LeaseResult, WakeResult }
