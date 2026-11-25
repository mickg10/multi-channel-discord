import type { Adapter, Kind, Nudge, Target, Transport, WakeResult } from './types.js'

type Next = WakeResult | ((n: Nudge) => WakeResult | Promise<WakeResult>)

function defaultTransport(kind: Kind): Transport {
  if (kind === 'codex') return 'codex-queue'
  if (kind === 'opencode') return 'opencode-queue'
  if (kind === 'claude') return 'claude-inbox'
  return 'tmux'
}

/** Test double. Not a native adapter. `turns` counts only a `woken` result. */
export class FakeAdapter implements Adapter {
  wakeCalls = 0
  reconcileCalls = 0
  turns = 0
  seen: Nudge[] = []
  readonly transport: Transport
  constructor(readonly kind: Kind, private next: Next = { s: 'woken', nativeId: 'n' }, transport?: Transport) {
    this.transport = transport ?? defaultTransport(kind)
  }

  async probe(_t: Target): Promise<{ ok: boolean }> {
    return { ok: true }
  }

  async wake(_t: Target, n: Nudge): Promise<WakeResult> {
    this.wakeCalls++
    this.seen.push(n)
    const result = typeof this.next === 'function' ? await this.next(n) : this.next
    if (result.s === 'woken') this.turns++
    return result
  }

  async reconcile(_t: Target, n: Nudge): Promise<WakeResult> {
    this.reconcileCalls++
    this.seen.push(n)
    return { s: 'woken', nativeId: 'reconciled' }
  }
}
