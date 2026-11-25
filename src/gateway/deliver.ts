import type { WakeStore } from './store.js'
import { type Adapter, type DeliveryResult, type Nudge, type Target, type WakeResult } from './types.js'

/**
 * One delivery step. The caller commits the result after this returns.
 * `onPending` runs only after the attempt is fsynced and before any native send.
 * A crash in that gap leaves the row `pending` on disk, which load() turns into `uncertain`.
 */
export async function stepDelivery(opts: {
  store: WakeStore
  adapters: readonly Adapter[]
  target: Target
  msgId: string
  nudge: Nudge
  onPending?: () => void
}): Promise<DeliveryResult> {
  const { store, adapters, target, msgId, nudge } = opts
  const prev = store.get(msgId)
  if (prev?.state === 'uncertain') {
    const adapter = adapters.find(adapter => adapter.kind === prev.kind) ?? adapters[0]
    if (!adapter) return { s: 'uncertain' }
    return adapter.reconcile(target, { msgId, text: prev.text, clientId: prev.clientId })
  }
  if (prev && prev.state !== 'pending') {
    if (prev.state === 'woken') return { s: 'woken', nativeId: prev.nativeId ?? '' }
    return { s: prev.state }
  }
  const open = store.openFor(target.conv)
  if (open && open.msgId !== msgId) return { s: 'queued' }
  if (adapters.length === 0) return { s: 'unavailable' }
  store.begin({
    msgId, conv: target.conv, kind: target.kind, host: target.host, user: target.user,
    clientId: nudge.clientId, text: nudge.text,
  })
  opts.onPending?.()
  let last: WakeResult = { s: 'unavailable' }
  for (const adapter of adapters) {
    last = await adapter.wake(target, nudge)
    if (last.s !== 'unavailable') break
  }
  return last
}
