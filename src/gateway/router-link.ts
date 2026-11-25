import { randomBytes } from 'node:crypto'
import {
  assertNodeSecret, redactFrame,
  type GatewayToRouterMessage, type LeaseResult, type RouterToGatewayMessage, type Target, type WakeResult,
} from './types.js'

type Waiter = { resolve: (value: unknown) => void; reject: (err: Error) => void }

export class RouterLink {
  private pending = new Map<string, Waiter>()
  onWake?: (frame: Extract<RouterToGatewayMessage, { type: 'wake' }>) => Promise<unknown>
  onReleased?: (alias: string) => void
  onReported?: (id: string) => void
  private wakeAcks = new Map<string, string>()

  constructor(
    private secret: string,
    private send: (frame: GatewayToRouterMessage) => void,
    private audit?: (frame: GatewayToRouterMessage) => void,
  ) {
    assertNodeSecret(secret)
  }

  registerGateway(host: string, user: string): void {
    this.emit({ type: 'registerGateway', host, user, proto: 1, secret: this.secret })
  }

  registerAgent(target: Target): void {
    this.emit({ type: 'registerAgent', kind: target.kind, conv: target.conv, alias: target.alias, host: target.host })
  }

  mark(alias: string, id: string): void {
    this.emit({ type: 'mark', as: alias, requestId: this.nextId(), id, state: 'uncertain' })
  }

  wakeResult(alias: string, id: string, result: WakeResult): void {
    const requestId = this.nextId()
    this.wakeAcks.set(requestId, id)
    this.emit({ type: 'wakeResult', as: alias, requestId, id, result })
  }

  release(alias: string): void {
    this.emit({ type: 'releaseAgent', alias, requestId: this.nextId() })
  }

  lease(alias: string, receipt?: string): Promise<LeaseResult> {
    const requestId = this.nextId()
    const frame: GatewayToRouterMessage = {
      type: 'lease', as: alias, requestId, ...(receipt !== undefined ? { receipt } : {}),
    }
    return this.call(requestId, frame)
  }

  ack(alias: string, leaseId: string, id: string, receipt: string): Promise<void> {
    const requestId = this.nextId()
    return this.call(requestId, { type: 'ack', as: alias, requestId, leaseId, id, receipt }).then(() => undefined)
  }

  /** The socket is gone. Callers retry; nothing here was acked. */
  failPending(err: Error): void {
    const waiters = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of waiters) waiter.reject(err)
  }

  receive(msg: RouterToGatewayMessage): void {
    if (msg.type === 'toolResult') {
      const reported = this.wakeAcks.get(msg.requestId)
      if (reported) {
        this.wakeAcks.delete(msg.requestId)
        if (msg.success) this.onReported?.(reported)
        return
      }
      const waiter = this.pending.get(msg.requestId)
      if (!waiter) return
      this.pending.delete(msg.requestId)
      if (!msg.success) { waiter.reject(new Error(msg.data)); return }
      try { waiter.resolve(msg.data ? JSON.parse(msg.data) : {}) }
      catch { waiter.reject(new Error('bad router payload')) }
      return
    }
    if (msg.type === 'wake') void this.onWake?.(msg)
    if (msg.type === 'agentReleased') this.onReleased?.(msg.alias)
  }

  private call<T>(requestId: string, frame: GatewayToRouterMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject })
      try { this.emit(frame) }
      catch (err) {
        this.pending.delete(requestId)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private emit(frame: GatewayToRouterMessage): void {
    this.audit?.(redactFrame(frame))
    this.send(frame)
  }

  private nextId(): string {
    return `gw-${randomBytes(4).toString('hex')}`
  }
}
