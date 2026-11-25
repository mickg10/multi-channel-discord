import { randomBytes } from 'node:crypto'
import {
  assertNodeSecret, redactFrame,
  type GatewayToRouterMessage, type LeaseResult, type RouterToGatewayMessage, type Target, type WakeResult,
} from './types.js'

type Waiter = { resolve: (value: unknown) => void; reject: (err: Error) => void }

export class RouterLink {
  private pending = new Map<string, Waiter>()
  onWake?: (frame: Extract<RouterToGatewayMessage, { type: 'wake' }>) => Promise<unknown>

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
    this.emit({ type: 'wakeResult', as: alias, requestId: this.nextId(), id, result })
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

  receive(msg: RouterToGatewayMessage): void {
    if (msg.type === 'toolResult') {
      const waiter = this.pending.get(msg.requestId)
      if (!waiter) return
      this.pending.delete(msg.requestId)
      if (!msg.success) { waiter.reject(new Error(msg.data)); return }
      try { waiter.resolve(msg.data ? JSON.parse(msg.data) : {}) }
      catch { waiter.reject(new Error('bad router payload')) }
      return
    }
    if (msg.type === 'wake') void this.onWake?.(msg)
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
