import { chmodSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { selectAdapter, stepDelivery, type DeliverTarget } from './deliver.js'
import { serveGatewayMcp } from './mcp.js'
import { verifyPipePeer, type PeerInfo } from './peer.js'
import { type AgentRec, Registry } from './registry.js'
import { RouterLink } from './router-link.js'
import { WakeStore, type Attempt, type AttemptState } from './store.js'
import {
  assertAlias, buildNudge,
  type Adapter, type DeliveryResult, type GatewayToRouterMessage, type LeaseResult, type WakeResult,
} from './types.js'

export type GatewayOpts = {
  host: string
  user: string
  secret: string
  storePath: string
  send?: (frame: GatewayToRouterMessage) => void
  audit?: (frame: GatewayToRouterMessage) => void
  readPeer?: (sock: Socket) => PeerInfo | undefined
  verify?: typeof verifyPipePeer
  /** Compiled agent-bus-pipe. When set, the peer exe must realpath to this file. */
  pipePath?: string
  /** PR5c attaches MCP here. This gateway keeps the pipe byte protocol. */
  onVerifiedConnection?: (sock: Socket, agents: AgentRec[]) => void
}

export class Gateway {
  readonly registry = new Registry()
  readonly router: RouterLink
  store: WakeStore
  private adapters: Adapter[] = []
  private server?: Server
  private conns = new Set<Socket>()
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

  /** Load the wake file. Does not talk to the router. */
  loadFromDisk(): void {
    this.store = WakeStore.load(this.opts.storePath)
  }

  /** Replay finished results for one alias, or every alias, after that alias is registered. */
  replayUnreported(alias?: string): void {
    for (const row of this.store.unreported()) {
      if (alias !== undefined && row.alias !== alias) continue
      if (!this.registry.byAlias(row.alias)) continue
      this.router.wakeResult(row.alias, row.msgId, toWake(row))
    }
  }

  /** Restart path. Pending rows are already uncertain. Finished results the router never acked are sent again. */
  resumeFromDisk(): void {
    this.loadFromDisk()
    this.replayUnreported()
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
    const verdict = peer ? this.verify(peer, this.registry, this.opts.pipePath) : { ok: false as const, error: 'no peer credentials' }
    if (!verdict.ok) {
      sock.write(JSON.stringify({ ok: false, error: verdict.error }) + '\n')
      sock.end()
      return
    }
    if (this.opts.onVerifiedConnection) this.opts.onVerifiedConnection(sock, verdict.agents)
    else this.onVerifiedConnection(sock, verdict.agents)
  }

  private onVerifiedConnection(sock: Socket, agents: readonly AgentRec[]): void {
    void serveGatewayMcp(sock, sock, agents, agent => this.registry.matches(agent), async (agent, op, args) => {
      if (op !== 'lease') return this.router.tool(agent.alias, op, args)
      const leased = await this.router.lease(agent.alias, args.receipt as string | undefined)
      this.store.clearOpen(agent.conv)
      return JSON.stringify(leased)
    }).catch(() => sock.destroy())
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

/** Create the socket directory at 0700. A directory owned by another user refuses startup and is not chmod'd. */
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.getuid === undefined) throw new Error('no uid')
  if (statSync(path).uid !== process.getuid()) throw new Error('directory is owned by another user')
  chmodSync(path, 0o700)
}
export type { LeaseResult, WakeResult }
