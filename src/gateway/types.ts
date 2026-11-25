import { createHash } from 'node:crypto'
import { identityKey } from '../inboxes.js'
import {
  buildNudge,
  nudgeText,
  type Adapter,
  type GatewayToRouterMessage,
  type Kind,
  type LeaseResult,
  type Nudge,
  type RouterToGatewayMessage,
  type Target,
  type WakeResult,
} from '../types.js'

export { buildNudge, identityKey, nudgeText }
export type {
  Adapter, GatewayToRouterMessage, Kind, LeaseResult, Nudge, RouterToGatewayMessage, Target, WakeResult,
}

/** Local only. A second message waits. It is not a router state and not a fallback. */
export type DeliveryResult = WakeResult | { s: 'queued' }

export function assertNodeSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('node secret required')
}

/**
 * The `n` a wake frame carries when the router has not sent one yet.
 * 52 bits of sha256(conv + ":" + msgId), matching the router.
 */
export function nudgeNumber(conv: string, msgId: string): number {
  return Number.parseInt(createHash('sha256').update(`${conv}:${msgId}`).digest('hex').slice(0, 13), 16)
}

export function makeNudge(kind: Kind, conv: string, msgId: string): Nudge {
  return buildNudge(kind, conv, msgId, nudgeNumber(conv, msgId))
}

export function redactFrame(frame: GatewayToRouterMessage): GatewayToRouterMessage {
  if (frame.type === 'registerGateway') return { ...frame, secret: '[redacted]' }
  return frame
}

/** Router `registerAgent` charset. `-` is literal at the start of the class. */
const ALIAS = /^[-\w.@:/]+$/

/**
 * Same alias predicate as router `registerAgent`.
 * Fleet names are kept verbatim: `codex@nas642` has no conv suffix, and
 * `opencode_nas642_glm53_abli` has no `@`. When `@` is present, the host
 * before `:` must be this gateway. `kind` is not encoded in those names.
 */
export function assertAlias(_kind: Kind, host: string, alias: string): void {
  if (!ALIAS.test(alias)) throw new Error('invalid alias')
  if (alias.includes('@') && alias.split('@')[1]?.split(':')[0] !== host) throw new Error('invalid alias')
}
