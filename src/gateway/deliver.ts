import type { WakeStore } from './store.js'
import { buildNudge, type Adapter, type DeliveryResult, type Kind, type Target, type Transport } from './types.js'

export type DeliverTarget = Target & { transport: Transport }

/** Exactly one adapter for this pair. Zero or several is fail-closed: the caller does not guess. */
export function selectAdapter(adapters: readonly Adapter[], kind: Kind, transport: Transport): Adapter | undefined {
  const matched = adapters.filter(adapter => adapter.kind === kind && adapter.transport === transport)
  return matched.length === 1 ? matched[0] : undefined
}

/**
 * One delivery step. The caller commits the result after this returns.
 * `onPending` runs only after the attempt is fsynced and before any native send.
 * A crash in that gap leaves the row `pending` on disk, which load() turns into `uncertain`.
 * The chosen adapter is `(kind, transport)`. `unavailable` is terminal: there is no next adapter.
 */
export async function stepDelivery(opts: {
  store: WakeStore
  adapters: readonly Adapter[]
  target: DeliverTarget
  msgId: string
  n: number
  onPending?: () => void
}): Promise<DeliveryResult> {
  const { store, adapters, target, msgId, n } = opts
  const prev = store.get(msgId)
  if (prev?.state === 'uncertain') {
    const adapter = selectAdapter(adapters, prev.kind, prev.transport)
    if (!adapter) return { s: 'uncertain' }
    return adapter.reconcile(target, buildNudge(prev.kind, prev.conv, msgId, prev.n))
  }
  if (prev && prev.state !== 'pending') {
    if (prev.state === 'woken') return { s: 'woken', nativeId: prev.nativeId ?? '' }
    return { s: prev.state }
  }
  const open = store.openFor(target.conv)
  if (open && open.msgId !== msgId) return { s: 'queued' }
  const adapter = selectAdapter(adapters, target.kind, target.transport)
  if (!adapter) return { s: 'unavailable' }
  store.begin({
    msgId, conv: target.conv, kind: target.kind, host: target.host, user: target.user, alias: target.alias,
    n, transport: target.transport,
  })
  opts.onPending?.()
  return adapter.wake(target, buildNudge(target.kind, target.conv, msgId, n))
}
