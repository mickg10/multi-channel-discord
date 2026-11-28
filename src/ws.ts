/**
 * WebSocket message handlers for the router's plugin-facing WS server.
 *
 * Message types handled by dispatchMessage():
 *   register           → handleRegister       — register a new session
 *   deregister         → handleDeregister      — remove a session
 *   rename             → handleRename          — rename a session
 *   reply              → handleReply           — send a message to Discord
 *   react              → handleReact           — add emoji reaction
 *   editMessage        → handleEditMessage     — edit a previously sent message
 *   downloadAttachment → handleDownloadAttachment — download attachments from a message
 *   fetchMessages      → handleFetchMessages   — fetch recent channel messages
 *   askUser            → handleAskUser         — interactive question with buttons/select
 *   permissionRequest  → handlePermissionRequest — forward permission prompt to Discord
 *   registerSkills     → (inline)              — register discovered skills as slash commands
 */

import type { WsMcpOp, PluginToRouterMessage, WsRegistered, WsRenamed, WsError, WsToolResult, WsPermissionVerdict, WsAskUser, WsRegisterSkills, ChannelMeta } from './types.js'
import type { SessionManager, ProjectHistory } from './sessions.js'
import type { Subscriptions } from './subscriptions.js'
import type { NodeRegistry, Claims } from './nodes.js'
import { isBusAlias } from './bus-alias.js'
import { identityKey, type Inboxes, type InboxEntry, type PublishMirror } from './inboxes.js'
import type { GatewayToRouterMessage, GatewayToolCall, Kind, PublishResult, Target, WakeResult, WsChannelPost } from './types.js'
import type { McpRouterDeps, McpServerDecl } from './mcp.js'
import { newCallId } from './mcp.js'
import { orderByCost, resolveExact, type Activity, type Conversations, type CostClasses, type HumanMail, type Unread, type WakeBudget, type WakeLog } from './wake.js'

/** Guild channel operations the router provides (mockable in tests). */
export interface ChannelOps {
  /** Resolve a channel id, "name" or "#name" to a text channel in the bus guild. */
  resolve(ref: string): Promise<{ id: string; name: string } | null>
  list(): Promise<Array<{ id: string; name: string; topic?: string | null }>>
  create(name: string, topic?: string): Promise<{ id: string; name: string }>
  /** Move to the "archive" category and set its topic (optional: not all routers support it). */
  archive?(id: string, topic: string): Promise<void>
}
import { chunk } from './discord.js'
import { noteSent, getStateDir } from './access.js'
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Client,
  type TextBasedChannel,
} from 'discord.js'
import { writeFile, mkdir } from 'node:fs/promises'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { join, basename } from 'node:path'

export interface WsData {
  sessionName: string | null
  /** The send callback registered with SessionManager, kept for cleanup on close. */
  sendCallback: ((msg: string) => void) | null
  /** True once the plugin has registered with the correct shared secret. */
  authed?: boolean
  /** Set when this connection is a node daemon. */
  nodeName?: string
  legacyHost?: string
  renamed?: boolean
  gateway?: { user: string; agents: Map<string, Target> }
  /** Register-time instance id of the client connection (grant binding). */
  instanceId?: string
  /** Last keepalive ping. Unset until the client opts in by pinging. */
  lastPing?: number
}

export interface WsDeps {
  readonly sessions: SessionManager
  readonly history: ProjectHistory
  readonly client: Client
  readonly chatId: () => string | null
  readonly chunkLimit: number
  readonly chunkMode: 'length' | 'newline'
  readonly replyToMode: 'off' | 'first' | 'all'
  readonly stateDir?: string
  readonly onReply?: (chatId: string) => void
  readonly onSessionChange?: () => void
  readonly onSkillsRegistered?: (skills: ReadonlyArray<{ name: string; description: string }>) => void
  /** Discord channel ID used as the shared agent bus (agent <-> agent traffic). */
  readonly busChannelId?: string
  /** Shared secret plugins must present on register. Unset = no auth (localhost-only use). */
  readonly secret?: string
  /** Max bus posts per session per minute (loop guard). Default 12. */
  readonly busMaxPerMinute?: number
  /** Channel subscriptions (agent bus beyond the default channel). */
  readonly subs?: Subscriptions
  readonly channelOps?: ChannelOps
  /** Durable per-agent inboxes and node-owned (headless) agents. */
  readonly inboxes?: Inboxes
  readonly nodes?: NodeRegistry
  readonly claims?: Claims
  /** Remote MCP over the bus (declaration, admission, audit, pending call map). */
  readonly mcp?: McpRouterDeps
  /**
   * Per-node secrets: node name -> sha256(secret) hex. A listed node must present its own
   * secret; unlisted nodes are rejected when `require` is set (else accepted with a warning).
   */
  readonly nodeSecrets?: () => { readonly hashes: Readonly<Record<string, string>>; readonly require: boolean }
  /** Router-controlled ownership of legacy gateway aliases without a host suffix. */
  readonly gatewayAliasHosts?: () => Readonly<Record<string, string>>
  /** Sessions allowed to manage other sessions' subscriptions (DISCORD_ADMIN_SESSIONS). */
  readonly admins?: ReadonlySet<string>
  /** Channel where every to="human" post lands; everyone receives the human's posts there. */
  readonly humanChannelId?: string
  /** Bus rules sent once to every session on (first) register. */
  readonly rules?: () => { text: string; seen(name: string): boolean; markSeen(name: string): void } | null
  /** Passive chatter. Not the durable inbox, and not saved across a router restart. */
  readonly unread?: Unread
  readonly costs?: CostClasses
  readonly activity?: Activity
  readonly wakeLog?: WakeLog
  /** Cold-wake cap for non-human mail. Unset = no cap. */
  readonly budget?: WakeBudget
  /** Session that receives untargeted human posts. Exact name. */
  readonly dispatcher?: string
  /** Channel id → owner session. Used when the dispatcher is offline. */
  readonly channelOwners?: ReadonlyMap<string, string>
  /** Delay before premium/standard sessions are woken on an explicit @all. 0 = same turn, cheap first. */
  readonly staggerMs?: number
  /** Clarification for the human when a name was ambiguous or not exact. */
  onRoutingError?: (message: string) => void
  /** Who an untargeted human post woke, or why it woke nobody. */
  onRouteNote?: (message: string) => void
  /** Original human posts, so the dispatcher can re-deliver one by message id. */
  readonly humanMail?: HumanMail
  /** conversationId from register. Survives disconnect so a held approval keeps its owner. */
  readonly conversations?: Conversations
}

/** A file sent inline by a client (the router is remote: it must never open client-named paths). */
export interface InlineFile { readonly name: string; readonly data: string }
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES = 4
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
export const MAX_DOWNLOAD_TOTAL = 45 * 1024 * 1024
type DiscordFile = { attachment: Buffer; name: string }

/** Decode inline files; bare paths are rejected (they would be read on the router host). */
export function decodeFiles(files: unknown): { files: DiscordFile[]; errors: string[] } {
  const out: DiscordFile[] = [], errors: string[] = []
  if (!Array.isArray(files)) return { files: out, errors }
  for (const f of files.slice(0, MAX_FILES)) {
    if (typeof f === 'string') { errors.push(`file path "${f}" ignored: send file contents (update the client)`); continue }
    const g = f as Partial<InlineFile>
    if (typeof g?.name !== 'string' || typeof g.data !== 'string') { errors.push('malformed file entry'); continue }
    const buf = Buffer.from(g.data, 'base64')
    if (buf.length > MAX_FILE_BYTES) { errors.push(`${g.name}: larger than ${MAX_FILE_BYTES / 1048576} MB`); continue }
    out.push({ attachment: buf, name: g.name.replace(/[\/\\]/g, '_').slice(0, 100) || 'file' })
  }
  if (files.length > MAX_FILES) errors.push(`only the first ${MAX_FILES} files were attached`)
  return { files: out, errors }
}

/** Sessions with mode 'pull' (no channel push): their traffic is queued, not pushed. */
const pullSessions = new Set<string>()

/** Every addressable agent name: live sessions plus node agents that are between turns. */
function allNames(deps: Readonly<WsDeps>): string[] {
  const out = new Set(deps.sessions.getSessions().map(s => s.name))
  for (const a of deps.nodes?.list() ?? []) out.add(a.name)
  for (const name of deps.inboxes?.names() ?? []) out.add(name)
  return [...out]
}

const gateways = new WeakMap<Inboxes, Map<string, WsLike>>()

function liveSession(deps: Readonly<WsDeps>, name: string): boolean {
  return deps.sessions.getSessions().some(session => session.name === name)
}

function admission(deps: Readonly<WsDeps>, name: string, meta: ChannelMeta): ChannelMeta | undefined {
  const target = deps.inboxes?.target(name)
  const live = liveSession(deps, name)
  const node = deps.nodes?.get(name)
  const conv = target?.conv ?? deps.conversations?.get(name) ?? (!live ? deps.inboxes?.conversation(name) : undefined)
  if (!target && !live && !node && !conv) return undefined
  if (meta.conversation_id && target && meta.conversation_id !== target.conv) return undefined
  return conv && (target || (meta.from_human === 'true' && meta.question_id)) ? { ...meta, conversation_id: conv } : meta
}

// Legacy push has no recipient receipt. A successful transport send is its acceptance point.
function pushLegacy(deps: Readonly<WsDeps>, name: string, entry: InboxEntry): void {
  try {
    if (!deps.sessions.routeToSession(name, entry.content, { ...entry.meta, queued_at: entry.at, bus_msg_id: entry.id })) return
  } catch { return }
  deps.inboxes?.accept([entry.id])
}

function nativeConnection(inboxes: Inboxes, target: Target): WsLike | undefined {
  const ws = gateways.get(inboxes)?.get(target.host)
  const registered = ws?.data.gateway?.agents.get(target.alias)
  return registered && identityKey(registered) === identityKey(target) ? ws : undefined
}

function wakeNative(deps: Readonly<WsDeps>, target: Target, entry: InboxEntry, reconcile = false): void {
  const inboxes = deps.inboxes!
  const ws = nativeConnection(inboxes, target)
  if (!ws || identityKey(target) !== entry.key) return
  if (reconcile ? entry.state !== 'uncertain' : entry.state !== 'committed') return
  const attempt = entry.nudgeNumber === undefined
    ? inboxes.mark(entry.key, entry.id, { s: 'uncertain' }) : entry
  try {
    ws.send(JSON.stringify({
      type: 'wake', as: target.alias, msgId: entry.id, n: attempt.nudgeNumber,
      ...(reconcile && { reconcile: true }),
    }))
  } catch {
    // The attempt is durable and will be reconciled on register.
  }
}

function allowsWake(deps: Readonly<WsDeps>, name: string, meta: ChannelMeta): boolean {
  return meta.from_human === 'true' || meta.from === 'router' ||
    (deps.budget?.allow(name, deps.costs?.get(name) ?? 'standard') ?? true)
}

function transport(deps: Readonly<WsDeps>, name: string, entry: InboxEntry): void {
  const target = deps.inboxes?.target(name)
  if (target ? identityKey(target) !== entry.key : entry.key !== name) return
  const live = liveSession(deps, name)
  const cold = !!target || !live
  if (target) {
    if (!nativeConnection(deps.inboxes!, target) || entry.state !== 'committed' ||
        deps.inboxes!.wakePending(entry.key)) return
  } else if (!live && !deps.nodes?.get(name)) return
  if (cold && !allowsWake(deps, name, entry.meta)) return
  const pending = deps.inboxes?.count(name) ?? 0
  if (target) wakeNative(deps, target, entry)
  else if (live && !pullSessions.has(name)) {
    if (entry.meta.from_human === 'true' && entry.meta.question_id && entry.meta.conversation_id &&
        entry.meta.conversation_id !== deps.conversations?.get(name)) return
    pushLegacy(deps, name, entry)
  } else if (!live) deps.nodes?.wake(name, pending)
  deps.wakeLog?.record({ name, messageId: entry.meta.message_id, pending, cold, at: Date.now() })
}

export function deliver(deps: Readonly<WsDeps>, name: string, text: string, meta: ChannelMeta, target?: Target): boolean {
  const stamped = target ? { ...meta, conversation_id: target.conv } : admission(deps, name, meta)
  if (!stamped) return false
  if (!deps.inboxes) return deps.sessions.routeToSession(name, text, stamped)
  const [entry] = deps.inboxes.commit([{ name, content: text, meta: stamped, ...(target && { target }) }])
  logCommit(deps, name, entry!)
  transport(deps, name, entry!)
  return true
}

function logCommit(deps: Readonly<WsDeps>, name: string, entry: InboxEntry): void {
  const target = deps.inboxes?.target(name)
  let path = 'inbox'
  if (target) {
    if (identityKey(target) === entry.key && nativeConnection(deps.inboxes!, target)) path = 'node'
  } else if (liveSession(deps, name)) {
    if (!pullSessions.has(name)) path = 'push'
  } else if (deps.nodes?.get(name)) path = 'node'
  const safe = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')
  const from = entry.meta.from ?? entry.meta.user ?? 'unknown'
  process.stderr.write(`deliver ${entry.id} ${safe(from)} -> ${safe(entry.key)} state=${entry.state} path=${path}\n`)
}

function sendRulesOnce(deps: Readonly<WsDeps>, name: string): void {
  const r = deps.rules?.()
  if (!r || r.seen(name)) return
  if (deliver(deps, name, r.text, { source: 'agent-bus', from: 'router', user: 'router', to: name, channel: 'rules', chat_id: deps.busChannelId })) {
    r.markSeen(name)
  }
}

/** Remote MCP over the bus: mcp_list / mcp_describe / mcp_call (see src/mcp.ts). */
function handleMcpOp(ws: WsLike, parsed: WsMcpOp, deps: Readonly<WsDeps>): void {
  const me = ws.data.sessionName
  const { mcp, nodes } = deps
  const reply = (ok: boolean, data: string) => sendToolResult(ws, parsed.requestId, ok, data)
  if (!me || !mcp || !nodes) { reply(false, me ? 'remote MCP disabled on this router' : 'not registered'); return }
  if (parsed.type === 'mcpList') { reply(true, JSON.stringify(mcp.registry.list())); return }
  if (!parsed.server) { reply(false, 'server required'); return }
  const decl = mcp.registry.get(parsed.server)
  if (!decl) {
    mcp.audit.record(me, parsed.server, parsed.method ?? '', parsed.params, 'reject:undeclared')
    reply(false, `server "${parsed.server}" is not declared in the registry`)
    return
  }
  if (parsed.type === 'mcpDescribe') {
    // Declaration plus live tools/list from the hosting node: schemas load lazily, only on describe.
    if (!forwardMcpExec(ws, parsed.requestId, decl, 'tools/list', undefined, mcp, nodes)) {
      reply(false, `hosting node "${decl.node}" is not connected (declaration: ${decl.class}, methods: ${decl.methods.join(', ')})`)
    }
    return
  }
  if (!parsed.method) { reply(false, 'method required'); return }
  const decision = mcp.registry.checkCall(parsed.server, parsed.method, mcp.grants, { session: me, instance: ws.data.instanceId }, parsed.grant)
  if (!decision.ok) {
    mcp.audit.record(me, parsed.server, parsed.method, parsed.params, `reject:${decision.reason}`)
    reply(false, decision.reason)
    return
  }
  mcp.audit.record(me, parsed.server, parsed.method, parsed.params, parsed.grant ? `allow:grant:${parsed.grant}` : 'allow:read-only')
  if (!forwardMcpExec(ws, parsed.requestId, decl, parsed.method, parsed.params, mcp, nodes)) {
    reply(false, `hosting node "${decl.node}" is not connected`)
  }
}

/** Forward one method to the hosting node under a router-minted call id.
 *  The node receives only {callId, server, method, params, timeoutMs} — never command/env. */
function forwardMcpExec(ws: WsLike, clientRequestId: string, decl: McpServerDecl, method: string, params: unknown, mcp: McpRouterDeps, nodes: NodeRegistry): boolean {
  if (!nodes.nodeConnected(decl.node)) return false
  const callId = newCallId()
  mcp.pending.register(callId, ws, clientRequestId, decl.node)
  return nodes.sendToNode(decl.node, {
    type: 'mcpExec', callId, server: decl.name, method,
    ...(params !== undefined && { params }), ...(decl.timeoutMs && { timeoutMs: decl.timeoutMs }),
  })
}

export interface WsLike {
  data: WsData
  send(msg: string): void
  close?(): void
}

export interface WsHandlers {
  open(ws: WsLike): void
  message(ws: WsLike, msg: string | Buffer): void
  close(ws: WsLike): void
}

/** Fetch a text-based channel from Discord, returning null if not found or not text-based. */
async function fetchTextChannelOrNull(client: Client, channelId: string): Promise<TextBasedChannel | null> {
  const ch = await client.channels.fetch(channelId)
  if (!ch || !ch.isTextBased()) return null
  return ch as TextBasedChannel
}

export function inboxError(err: unknown): string {
  return err instanceof Error && /^(inbox_full|inbox_commit_failed|invalid_receipt|unknown_message|invalid_wake_transition|wake_already_pending|publish_payload_mismatch)$/.test(err.message)
    ? err.message : 'request_failed'
}

export function createWsHandlers(deps: Readonly<WsDeps>): WsHandlers {
  deps.subs?.upgradeNativeAliases((deps.inboxes?.names() ?? []).flatMap<[string, string]>(name => {
    const target = deps.inboxes?.target(name)
    return target ? [[name, identityKey(target)]] : []
  }))
  return {
    open(_ws: WsLike): void {},

    message(ws: WsLike, raw: string | Buffer): void {
      const text = typeof raw === 'string' ? raw : raw.toString()

      let parsed: PluginToRouterMessage
      try {
        parsed = JSON.parse(text) as PluginToRouterMessage
      } catch {
        sendError(ws, 'Invalid JSON')
        return
      }

      if (!parsed || typeof parsed !== 'object') { sendError(ws, 'Invalid frame'); return }
      try {
        dispatchMessage(ws, parsed, deps)
      } catch (err) {
        const code = inboxError(err)
        const requestId = (parsed as { requestId?: unknown }).requestId
        try {
          if (typeof requestId === 'string') sendToolResult(ws, requestId, false, code)
          else sendError(ws, code)
        } catch { /* The connection may have closed while sending a result. */ }
      }
    },

    close(ws: WsLike): void {
      if (ws.data.gateway && ws.data.nodeName && deps.inboxes) {
        const hosts = gateways.get(deps.inboxes)
        if (hosts?.get(ws.data.nodeName)?.data === ws.data) hosts.delete(ws.data.nodeName)
        ws.data.gateway = undefined
        ws.data.nodeName = undefined
        ws.data.authed = false
        return
      }
      if (ws.data.nodeName && ws.data.sendCallback) {
        deps.nodes?.unregister(ws.data.nodeName, ws.data.sendCallback)
        deps.onSessionChange?.()
        return
      }
      if (ws.data.sessionName) pullSessions.delete(ws.data.sessionName)
      // Clean up any pending permission requests associated with this WS
      for (const [reqId, reqWs] of permissionSessions) {
        if (reqWs === ws) {
          permissionSessions.delete(reqId)
          const t = permissionTimeouts.get(reqId)
          if (t) { clearTimeout(t); permissionTimeouts.delete(reqId) }
        }
      }

      if (ws.data.sessionName) {
        const isPrimary = ws.data.sendCallback
          ? deps.sessions.isPrimarySender(ws.data.sessionName, ws.data.sendCallback)
          : true

        if (ws.data.sendCallback) {
          deps.sessions.cleanupSender(ws.data.sendCallback)
        }

        // Only deregister the session if this WS is the primary sender.
        // Duplicate connections (extraSends) just remove their callback.
        if (isPrimary) {
          try {
            deps.sessions.deregisterSession(ws.data.sessionName)
          } catch {}
        }
        ws.data.sessionName = null
        ws.data.sendCallback = null
        deps.onSessionChange?.()
      }
    },
  }
}

const GATEWAY_KINDS: ReadonlySet<Kind> = new Set(['claude', 'codex', 'opencode', 'grok', 'agy'])

function matchesSecret(secret: unknown, hash: string | undefined): boolean {
  return typeof secret === 'string' && secret.length > 0 && typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash) &&
    timingSafeEqual(createHash('sha256').update(secret).digest(), Buffer.from(hash, 'hex'))
}

function qualifiedAliasHost(alias: string): string | undefined {
  return /^[-\w./]+@([a-z0-9.-]+)(?::[^@]+)?$/i.exec(alias)?.[1]
}

function aliasAllowedOnHost(alias: string, host?: string): boolean {
  const lower = alias.toLowerCase()
  if (!alias || HUMAN_TARGETS.has(lower) || lower === 'router' ||
      /^all(?::(?:synthesis|independent))?$/.test(lower) || lower.startsWith('@all')) return false
  return !alias.includes('@') || (!!host && qualifiedAliasHost(alias) === host)
}

function takeoverKindMatches(name: string, agent: string, incumbent?: string): boolean {
  const kindAndProfile = name.toLowerCase().split('@', 1)[0]
  if (!name.includes('@')) return incumbent === agent
  return kindAndProfile === agent || kindAndProfile.startsWith(agent + '-')
}

function protectedRenameAlias(deps: Readonly<WsDeps>, name: string): boolean {
  const lower = name.toLowerCase()
  const names = [
    ...(deps.admins ?? []), ...(deps.channelOwners?.values() ?? []), ...(deps.subs?.channelOwnerAliases() ?? []),
  ]
  return names.some(alias => {
    const protectedName = alias.toLowerCase()
    return lower === protectedName || (lower.startsWith(protectedName) && /^(?:-\d+)+$/.test(lower.slice(protectedName.length)))
  })
}

function gatewayAliasAllowed(deps: Readonly<WsDeps>, alias: string, host: string): boolean {
  if (!/^[-\w.@:/]+$/.test(alias) || !aliasAllowedOnHost(alias, host)) return false
  if (qualifiedAliasHost(alias)) return true
  const owners = deps.gatewayAliasHosts?.()
  return !!owners && Object.hasOwn(owners, alias) && owners[alias] === host
}

const GATEWAY_TOOL_HANDLERS = {
  channelPost: 'channelPost',
  reply: 'reply',
  fetchMessages: 'fetchMessages',
  busSessions: 'listSessions',
  claim: 'claim',
  releaseClaim: 'releaseClaim',
  listClaims: 'listClaims',
  mcpList: 'mcpList',
  mcpDescribe: 'mcpDescribe',
  mcpCall: 'mcpCall',
  channelList: 'channelList',
  channelSubscribe: 'channelSubscribe',
} as const satisfies Record<GatewayToolCall['op'], PluginToRouterMessage['type']>

function handleGateway(ws: WsLike, frame: GatewayToRouterMessage, deps: Readonly<WsDeps>): void {
  const inboxes = deps.inboxes
  const reply = (ok: boolean, data: string) => {
    if (typeof frame.requestId === 'string') sendToolResult(ws, frame.requestId, ok, data)
    else if (!ok) sendError(ws, data)
  }
  if (!inboxes) { reply(false, 'gateway_disabled'); return }
  let hosts = gateways.get(inboxes)
  if (!hosts) { hosts = new Map(); gateways.set(inboxes, hosts) }
  if (frame.type === 'registerGateway') {
    if (ws.data.nodeName || ws.data.sessionName || frame.proto !== 1 ||
        typeof frame.host !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/i.test(frame.host) ||
        typeof frame.user !== 'string' || !/^[a-z0-9_][a-z0-9_.-]*$/i.test(frame.user)) {
      reply(false, 'invalid_gateway_registration')
      return
    }
    const hashes = deps.nodeSecrets?.().hashes
    if (!hashes || !Object.hasOwn(hashes, frame.host) || !matchesSecret(frame.secret, hashes[frame.host])) {
      reply(false, 'invalid_gateway_secret')
      return
    }
    ws.data.nodeName = frame.host
    ws.data.gateway = { user: frame.user, agents: new Map() }
    const previous = hosts.get(frame.host)
    hosts.set(frame.host, ws)
    if (previous) {
      try { previous.send(JSON.stringify({ type: 'replaced', name: frame.host })) } catch {}
      try { previous.close?.() } catch {}
      process.stderr.write(`Replaced gateway connection for ${frame.host}\n`)
    }
    ws.send(JSON.stringify({ type: 'gatewayRegistered', host: frame.host, user: frame.user, proto: 1 }))
    reply(true, '{}')
    return
  }
  const host = ws.data.nodeName
  const gateway = ws.data.gateway
  if (!host || !gateway || hosts.get(host)?.data !== ws.data) { reply(false, 'gateway_not_registered'); return }
  if (frame.type === 'registerAgent') {
    if (!GATEWAY_KINDS.has(frame.kind) || typeof frame.conv !== 'string' || !frame.conv.trim() ||
        typeof frame.alias !== 'string' || (frame.host !== undefined && frame.host !== host) ||
        !gatewayAliasAllowed(deps, frame.alias, host) ||
        (deps.nodes?.get(frame.alias) && deps.nodes.get(frame.alias)?.node !== host)) {
      reply(false, 'invalid_agent_registration')
      return
    }
    const existing = inboxes.target(frame.alias)
    if (existing && (existing.host !== host || existing.user !== gateway.user || existing.kind !== frame.kind)) {
      reply(false, 'alias_already_registered')
      return
    }
    const target: Target = { host, user: gateway.user, kind: frame.kind, conv: frame.conv, alias: frame.alias }
    const alreadyRegistered = [...gateway.agents.values()].some(agent => identityKey(agent) === identityKey(target))
    const inheritSubscriptions = inboxes.canInheritLegacy(target)
    inboxes.bind(target)
    if (inheritSubscriptions) deps.subs?.migrateToNative(target.alias, identityKey(target))
    gateway.agents.set(frame.alias, target)
    deps.conversations?.set(frame.alias, frame.conv)
    if (liveSession(deps, frame.alias)) {
      deps.sessions.notifySession(frame.alias, JSON.stringify({ type: 'replaced', name: frame.alias }))
      deps.sessions.deregisterSession(frame.alias)
      pullSessions.delete(frame.alias)
    }
    ws.send(JSON.stringify({ type: 'agentRegistered', as: frame.alias, target }))
    reply(true, JSON.stringify({ as: frame.alias, target }))
    if (alreadyRegistered) return
    for (const entry of inboxes.list(identityKey(target))) {
      if (entry.state === 'uncertain') wakeNative(deps, target, entry, true)
      else if (entry.state === 'committed' && (!entry.lease || entry.lease.until <= Date.now())) transport(deps, frame.alias, entry)
    }
    sendRulesOnce(deps, frame.alias)
    deps.onSessionChange?.()
    return
  }
  if (frame.type === 'releaseAgent') {
    const target = typeof frame.alias === 'string' ? inboxes.target(frame.alias) : undefined
    if (target?.host !== host || target.user !== gateway.user) { reply(false, 'invalid_as'); return }
    inboxes.release(frame.alias)
    gateway.agents.delete(frame.alias)
    deps.conversations?.set(frame.alias, '')
    ws.send(JSON.stringify({ type: 'agentReleased', alias: frame.alias }))
    reply(true, '{}')
    deps.onSessionChange?.()
    return
  }
  const target = 'as' in frame && typeof frame.as === 'string' ? gateway.agents.get(frame.as) : undefined
  const bound = target && inboxes.target(target.alias)
  if (!target || !bound || identityKey(target) !== identityKey(bound)) { reply(false, 'invalid_as'); return }
  if (typeof frame.requestId !== 'string' || !frame.requestId) { sendError(ws, 'requestId required'); return }
  const key = identityKey(target)
  switch (frame.type) {
    case 'agentStatus':
      reply(true, JSON.stringify(agentStatus(deps, target.alias)))
      break
    case 'lease': {
      if (frame.receipt !== undefined && typeof frame.receipt !== 'string') { reply(false, 'invalid_receipt'); return }
      const result = inboxes.lease(key, frame.receipt)
      reply(true, JSON.stringify({ ...result, unread: deps.unread?.take(target.alias) ?? 0 }))
      break
    }
    case 'ack':
      if (typeof frame.leaseId !== 'string' || typeof frame.id !== 'string' || typeof frame.receipt !== 'string') {
        reply(false, 'invalid_receipt'); return
      }
      inboxes.ack(key, frame.leaseId, frame.id, frame.receipt)
      reply(true, '{}')
      break
    case 'mark':
      if (typeof frame.id !== 'string' || frame.state !== 'uncertain') { reply(false, 'invalid_wake_transition'); return }
      inboxes.mark(key, frame.id, { s: 'uncertain' })
      reply(true, '{}')
      break
    case 'wakeResult': {
      const result = frame.result
      if (typeof frame.id !== 'string' || !result || !['woken', 'held', 'refused', 'uncertain', 'unavailable'].includes(result.s) ||
          (result.s === 'woken' && (typeof result.nativeId !== 'string' || !result.nativeId))) {
        reply(false, 'invalid_wake_transition')
        return
      }
      // Persist only the typed fields, never the rest of the incoming frame.
      inboxes.mark(key, frame.id, result.s === 'woken' ? { s: 'woken', nativeId: result.nativeId } : { s: result.s })
      reply(true, '{}')
      break
    }
    case 'gatewayOp': {
      if (typeof frame.op !== 'string' || !Object.hasOwn(GATEWAY_TOOL_HANDLERS, frame.op)) {
        reply(false, 'unsupported_gateway_operation')
        return
      }
      const type = GATEWAY_TOOL_HANDLERS[frame.op]
      const context: WsLike = {
        data: { sessionName: target.alias, instanceId: `native:${identityKey(target)}`, sendCallback: null },
        send(message) {
          if (nativeConnection(inboxes, target)?.data !== ws.data) return
          try { ws.send(message) } catch { /* The gateway may have disconnected during the operation. */ }
        },
      }
      dispatchLegacyMessage(context, { ...frame, type } as PluginToRouterMessage, deps, target)
      break
    }
    case 'busPost': {
      if (typeof frame.text !== 'string') { reply(false, 'busPost requires text'); return }
      const sender: WsLike = { data: { sessionName: target.alias, sendCallback: null }, send: message => ws.send(message) }
      handleBusPost(sender, frame.text, frame.to, deps, [], frame, target)
      break
    }
    default:
      reply(false, 'unsupported_gateway_operation')
  }
}

function agentStatus(deps: Readonly<WsDeps>, name: string) {
  const target = deps.inboxes?.target(name)
  const live = target && deps.inboxes
    ? !!nativeConnection(deps.inboxes, target)
    : liveSession(deps, name)
  const states: Partial<Record<InboxEntry['state'], number>> = {}
  if (target) for (const entry of deps.inboxes!.list(identityKey(target))) {
    states[entry.state] = (states[entry.state] ?? 0) + 1
  }
  return {
    live, mode: live ? (target || pullSessions.has(name) ? 'pull' : 'push') : null,
    pending: deps.inboxes?.count(name) ?? 0, ...(target && { states }),
  }
}

function dispatchMessage(ws: WsLike, parsed: PluginToRouterMessage, deps: Readonly<WsDeps>): void {
  if (ws.data.gateway || ['registerGateway', 'registerAgent', 'releaseAgent', 'lease', 'ack', 'mark', 'wakeResult', 'gatewayOp'].includes(parsed.type)) {
    handleGateway(ws, parsed as GatewayToRouterMessage, deps)
    return
  }
  if (ws.data.sessionName && deps.inboxes?.target(ws.data.sessionName)) {
    ws.send(JSON.stringify({ type: 'replaced', name: ws.data.sessionName }))
    return
  }
  if (deps.secret && parsed.type !== 'register' && parsed.type !== 'registerNode' && !ws.data.authed) {
    sendError(ws, 'Not authenticated: register with the router secret first')
    return
  }
  dispatchLegacyMessage(ws, parsed, deps)
}

function dispatchLegacyMessage(ws: WsLike, parsed: PluginToRouterMessage, deps: Readonly<WsDeps>, sender?: Target): void {
  switch (parsed.type) {
    case 'registerNode': {
      if (deps.secret && !matchesSecret(parsed.secret, createHash('sha256').update(deps.secret).digest('hex'))) { sendError(ws, 'register rejected: bad or missing router secret'); return }
      if (!deps.nodes || !hasString(parsed, 'node') || !Array.isArray(parsed.agents)) { sendError(ws, 'registerNode requires node and agents (and a router with nodes enabled)'); return }
      {
        // The shared router secret only proves "some client of this bus". Node names own wakes
        // and MCP execution, so each node proves its identity with its own secret.
        const ns = deps.nodeSecrets?.()
        const want = ns?.hashes && Object.hasOwn(ns.hashes, parsed.node) ? ns.hashes[parsed.node] : undefined
        const got = (parsed as { nodeSecret?: string }).nodeSecret
        if (want) {
          if (!matchesSecret(got, want)) { sendError(ws, `register rejected: bad or missing node secret for "${parsed.node}"`); return }
        } else if (ns?.require) {
          sendError(ws, `register rejected: node "${parsed.node}" has no node secret on the router`); return
        } else if (ns) {
          process.stderr.write(`discord channel: node "${parsed.node}" registered WITHOUT a node secret (set one; DISCORD_REQUIRE_NODE_SECRET=1 will reject this)\n`)
        }
      }
      ws.data.authed = true
      ws.data.nodeName = parsed.node
      const send = (m: string) => ws.send(m)
      ws.data.sendCallback = send
      deps.nodes.register(parsed.node, send, parsed.agents)
      ws.send(JSON.stringify({ type: 'nodeRegistered', node: parsed.node, agents: parsed.agents.map(a => a.name) }))
      for (const a of parsed.agents) {
        sendRulesOnce(deps, a.name)
        // Wake agents that have mail waiting from while the node was away.
        const n = deps.inboxes?.count(a.name) ?? 0
        if (n > 0 && !deps.sessions.getSessions().some(s => s.name === a.name)) deps.nodes.wake(a.name, n)
      }
      deps.onSessionChange?.()
      break
    }
    case 'claim':
    case 'releaseClaim':
    case 'listClaims': {
      if (!hasString(parsed, 'requestId')) { sendError(ws, 'claim op requires requestId'); return }
      const me = ws.data.sessionName
      if (!me || !deps.claims) { sendToolResult(ws, parsed.requestId, false, me ? 'claims disabled' : 'not registered'); return }
      if (parsed.type === 'listClaims') { sendToolResult(ws, parsed.requestId, true, JSON.stringify(deps.claims.list())); return }
      if (!parsed.task) { sendToolResult(ws, parsed.requestId, false, 'task required'); return }
      const r = parsed.type === 'claim' ? deps.claims.claim(parsed.task, me, parsed.note) : deps.claims.release(parsed.task, me, parsed.to)
      sendToolResult(ws, parsed.requestId, true, JSON.stringify(r))
      break
    }
    case 'mcpList':
    case 'mcpDescribe':
    case 'mcpCall': {
      if (!hasString(parsed, 'requestId')) { sendError(ws, 'mcp op requires requestId'); return }
      handleMcpOp(ws, parsed, deps)
      break
    }
    case 'mcpResult': {
      // Answer from a node daemon — accepted only from the node the call was forwarded to.
      if (!hasString(parsed, 'callId') || typeof parsed.success !== 'boolean' || !hasString(parsed, 'data')) return
      deps.mcp?.pending.resolve(parsed.callId, ws.data.nodeName, parsed.success, parsed.data)
      break
    }
    case 'agentStatus': {
      // For nodes: is an interactive (push) session holding this name? Then the node must not run
      // a headless turn on the same conversation.
      const p = parsed as { requestId?: string; agent?: string }
      if (!p.requestId || !p.agent) { sendError(ws, 'agentStatus requires requestId and agent'); return }
      sendToolResult(ws, p.requestId, true, JSON.stringify(agentStatus(deps, p.agent)))
      break
    }
    case 'inboxPull':
    case 'inboxCount': {
      if (!hasString(parsed, 'requestId')) { sendError(ws, 'inbox op requires requestId'); return }
      const who = parsed.type === 'inboxCount' ? parsed.agent : ws.data.sessionName
      if (!who) { sendToolResult(ws, parsed.requestId, false, 'not registered'); return }
      if (parsed.type === 'inboxCount') sendToolResult(ws, parsed.requestId, true, String(deps.inboxes?.count(who) ?? 0))
      else {
        // Legacy check_inbox keeps its bare array or {messages, unread} format and
        // accepts mail on a successful push or pull result. Gateway aliases use
        // structured leases and an echoed receipt instead.
        const bound = deps.conversations ? (deps.conversations.get(who) ?? null) : undefined
        const entries = deps.inboxes?.legacy(who, bound) ?? []
        const messages = entries.map(({ content, meta, at }) => ({ content, meta, at }))
        const withUnread = (parsed as { withUnread?: boolean }).withUnread === true
        const unread = withUnread ? (deps.unread?.take(who) ?? 0) : 0
        sendToolResult(ws, parsed.requestId, true, JSON.stringify(withUnread ? { messages, unread } : messages))
        deps.inboxes?.accept(entries.map(entry => entry.id))
      }
      break
    }
    case 'dispatch':
      handleDispatch(ws, parsed, deps)
      break
    case 'busPost':
      if (!hasString(parsed, 'text')) {
        sendError(ws, 'busPost requires text')
        return
      }
      {
        const { files, errors } = decodeFiles((parsed as { files?: unknown }).files)
        for (const e of errors) sendError(ws, e)
        handleBusPost(ws, parsed.text, parsed.to, deps, files, parsed)
      }
      break
    case 'channelPost': {
      const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : undefined
      if (!hasString(parsed, 'channel') || !hasString(parsed, 'text')) {
        sendOperationError(ws, requestId, 'channelPost requires channel and text')
        return
      }
      const { files, errors } = decodeFiles(parsed.files)
      if (errors.length && requestId) { sendOperationError(ws, requestId, errors.join(', ')); return }
      for (const error of errors) sendError(ws, error)
      void handleChannelPost(ws, parsed, deps, files, sender).catch(err => sendOperationError(ws, requestId, inboxError(err)))
      break
    }
    case 'channelList':
    case 'channelCreate':
    case 'channelSubscribe':
    case 'channelUnsubscribe':
    case 'channelArchive':
      if (!hasString(parsed, 'requestId')) {
        sendError(ws, 'channel operation requires requestId')
        return
      }
      void handleChannelOp(ws, parsed, deps, sender)
      break
    case 'listSessions':
      if (!hasString(parsed, 'requestId')) {
        sendError(ws, 'listSessions requires requestId')
        return
      }
      {
        const row = (name: string) => ({
          costClass: deps.costs?.get(name) ?? 'standard',
          pending: deps.inboxes?.count(name) ?? 0,
          unread: deps.unread?.count(name) ?? 0,
          ...(deps.activity?.lastPost(name) && { lastPost: deps.activity.lastPost(name) }),
        })
        const live = deps.sessions.getSessions().map(s => ({
          name: s.name, projectPath: s.projectPath, connectedAt: new Date(s.connectedAt).toISOString(),
          state: deps.nodes?.get(s.name) ? 'running' : 'live',
          ...(deps.nodes?.get(s.name) && { node: deps.nodes.get(s.name)!.node }),
          ...row(s.name),
        }))
        const native = []
        const inboxes = deps.inboxes
        if (inboxes) for (const name of inboxes.names()) {
          const target = inboxes.target(name)
          if (!target) continue
          native.push({
            name, projectPath: '', connectedAt: '', node: target.host,
            state: nativeConnection(inboxes, target) ? 'live' : 'idle',
            ...row(name),
          })
        }
        const liveNames = new Set([...live, ...native].map(s => s.name))
        const asleep = (deps.nodes?.list() ?? []).filter(a => !liveNames.has(a.name)).map(a => ({
          name: a.name, projectPath: a.cwd ?? '', connectedAt: '', state: 'idle', node: a.node,
          ...row(a.name),
        }))
        sendToolResult(ws, parsed.requestId, true, JSON.stringify([...live, ...native, ...asleep]))
      }
      break
    case 'register':
      if (!hasString(parsed, 'name') || !hasString(parsed, 'projectPath')) {
        sendError(ws, 'register requires name and projectPath')
        return
      }
      if (deps.secret && (parsed as { secret?: string }).secret !== deps.secret) {
        sendError(ws, 'register rejected: bad or missing router secret')
        return
      }
      const normalized = parsed.name.trim()
      const host = ws.data.legacyHost ?? parsed.host ?? qualifiedAliasHost(normalized)
      if ((parsed.host !== undefined && (typeof parsed.host !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/i.test(parsed.host) || parsed.host !== host)) ||
          !isBusAlias(normalized) || !aliasAllowedOnHost(normalized, host)) {
        sendError(ws, 'register rejected: invalid_bus_alias')
        return
      }
      if (deps.inboxes?.target(normalized)) {
        ws.send(JSON.stringify({ type: 'replaced', name: normalized }))
        return
      }
      const agent = typeof parsed.agent === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(parsed.agent)
        ? parsed.agent.toLowerCase() : undefined
      const conversationId = typeof parsed.conversationId === 'string' ? parsed.conversationId : ''
      const parent = typeof parsed.parent === 'string' && parsed.parent ? parsed.parent : undefined
      const incumbent = deps.sessions.registeredIdentity(normalized)
      if (incumbent && parsed.reclaimOnly === true) { sendError(ws, 'name_occupied'); return }
      const takeover = parsed.takeover === true || (parsed.takeover === undefined && parsed.mode === 'pull')
      if (incumbent && takeover) {
        const sameInstance = incumbent.instanceId === parsed.instanceId
        const sameParent = !!parent && parent === incumbent.parent
        const valid = !!agent && takeoverKindMatches(normalized, agent, incumbent.agent)
        // Older clients can prove continuity by the instance already in the slot.
        if (!valid && !(sameInstance && parsed.agent === undefined)) {
          sendError(ws, 'takeover_refused')
          return
        }
        // A holder that has pinged recently is live. Only the same instance or parent may take it.
        // A client that never pings stays replaceable, so a resumed thread can still retire a stale socket.
        const seen = incumbent.lastPing
        const live = seen !== undefined && Date.now() - seen <= 45_000
        if (live && !sameInstance && !sameParent) {
          sendError(ws, 'takeover_refused')
          return
        }
        const sameConversation = !!conversationId && conversationId === incumbent.conversationId
        const differentConversation = !!conversationId && !!incumbent.conversationId && !sameConversation
        const kind = agent ?? incumbent.agent ?? normalized.toLowerCase().split('@', 1)[0]!
        const codex = kind === 'codex' || kind.startsWith('codex-') || kind === 'chatgpt-codex'
        const reclaimable = !differentConversation && (!codex || sameInstance || sameConversation)
        deps.sessions.notifySession(normalized, JSON.stringify({
          type: 'replaced', name: normalized, ...(!reclaimable && { reclaim: false }),
        }))
        deps.sessions.deregisterSession(normalized)
      }
      ws.data.authed = true
      ws.data.legacyHost = host
      handleRegister(ws, normalized, parsed.projectPath, parsed.instanceId, deps, { agent, conversationId, parent })
      if (ws.data.sessionName) {
        deps.conversations?.set(ws.data.sessionName, conversationId)
        if (conversationId) deps.inboxes?.remember(ws.data.sessionName, conversationId)
        const cid = deps.conversations ? (deps.conversations.get(ws.data.sessionName) ?? null) : undefined
        if ((parsed as { mode?: string }).mode === 'pull') pullSessions.add(ws.data.sessionName)
        else {
          pullSessions.delete(ws.data.sessionName)
          // Messages queued while this agent was offline. Approvals for another conversation stay queued.
          for (const entry of deps.inboxes?.legacy(ws.data.sessionName, cid) ?? []) pushLegacy(deps, ws.data.sessionName, entry)
        }
        sendRulesOnce(deps, ws.data.sessionName)
        deps.costs?.set(ws.data.sessionName, (parsed as { costClass?: unknown }).costClass)
      }
      break
    case 'ping': {
      const now = Date.now()
      ws.data.lastPing = now
      if (ws.data.sessionName) deps.sessions.notePing(ws.data.sessionName, now)
      ws.send(JSON.stringify({ type: 'pong' }))
      break
    }
    case 'deregister':
      handleDeregister(ws, deps)
      break
    case 'rename': {
      const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : undefined
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : undefined
      if (!isBusAlias(name) || !aliasAllowedOnHost(name, ws.data.legacyHost) || protectedRenameAlias(deps, name)) {
        sendOperationError(ws, requestId, 'invalid_bus_alias')
        return
      }
      if (deps.inboxes?.target(name)) { sendOperationError(ws, requestId, 'alias already registered'); return }
      handleRename(ws, name, deps, requestId)
      break
    }
    case 'reply': {
      const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : undefined
      if (!hasString(parsed, 'text') || (parsed.chatId !== undefined && typeof parsed.chatId !== 'string') ||
          (parsed.replyTo !== undefined && typeof parsed.replyTo !== 'string')) {
        sendOperationError(ws, requestId, 'reply requires text and valid channel and message IDs')
        return
      }
      const { files, errors } = decodeFiles(parsed.files)
      if (errors.length && requestId) { sendOperationError(ws, requestId, errors.join(', ')); return }
      for (const error of errors) sendError(ws, error)
      if (deps.busChannelId && parsed.chatId === deps.busChannelId) {
        handleBusPost(ws, parsed.text, undefined, deps, files, requestId ? { requestId } : undefined, sender)
        break
      }
      void handleReply(ws, parsed.text, parsed.replyTo, files, deps, parsed.chatId, requestId)
      break
    }
    case 'react':
      if (!hasString(parsed, 'chatId') || !hasString(parsed, 'messageId') || !hasString(parsed, 'emoji')) {
        sendError(ws, 'react requires chatId, messageId, and emoji')
        return
      }
      handleReact(parsed.chatId, parsed.messageId, parsed.emoji, deps)
      break
    case 'editMessage':
      if (!hasString(parsed, 'requestId') || !hasString(parsed, 'chatId') || !hasString(parsed, 'messageId') || !hasString(parsed, 'text')) {
        sendError(ws, 'editMessage requires requestId, chatId, messageId, and text')
        return
      }
      handleEditMessage(ws, parsed.requestId, parsed.chatId, parsed.messageId, parsed.text, deps)
      break
    case 'downloadAttachment':
      if (!hasString(parsed, 'requestId') || !hasString(parsed, 'chatId') || !hasString(parsed, 'messageId')) {
        sendError(ws, 'downloadAttachment requires requestId, chatId, and messageId')
        return
      }
      handleDownloadAttachment(ws, parsed.requestId, parsed.chatId, parsed.messageId, deps)
      break
    case 'fetchMessages':
      if (!hasString(parsed, 'requestId') || !hasString(parsed, 'channel')) {
        sendError(ws, 'fetchMessages requires requestId and channel')
        return
      }
      handleFetchMessages(ws, parsed.requestId, parsed.channel, parsed.limit, deps)
      break
    case 'askUser':
      if (!hasString(parsed, 'requestId') || !hasString(parsed, 'chatId') || !hasString(parsed, 'question')) {
        sendError(ws, 'askUser requires requestId, chatId, and question')
        return
      }
      handleAskUser(ws, parsed.requestId, parsed.chatId, parsed.question, parsed.options ?? [], deps)
      break
    case 'permissionRequest':
      if (!hasString(parsed, 'requestId') || !hasString(parsed, 'toolName') || !hasString(parsed, 'description') || !hasString(parsed, 'inputPreview')) {
        sendError(ws, 'permissionRequest requires requestId, toolName, description, and inputPreview')
        return
      }
      handlePermissionRequest(ws, parsed.requestId, parsed.toolName, parsed.description, parsed.inputPreview, deps)
      break
    case 'registerSkills':
      if (!Array.isArray(parsed.skills)) {
        sendError(ws, 'registerSkills requires skills array')
        return
      }
      deps.onSkillsRegistered?.(parsed.skills)
      break
    default:
      sendError(ws, `Unknown message type: ${(parsed as { type: string }).type}`)
  }
}

function handleRegister(ws: WsLike, name: string, projectPath: string, instanceId: string | undefined, deps: Readonly<WsDeps>, identity: { agent?: string; conversationId?: string; parent?: string }): void {
  const sendCb = (msg: string) => ws.send(msg)
  ws.data.instanceId = instanceId
  const actualName = deps.sessions.registerSession(
    sendCb,
    name,
    projectPath,
    instanceId,
    name => !!deps.inboxes?.target(name),
    identity,
  )
  ws.data.sessionName = actualName
  deps.subs?.reclaim(actualName, instanceId)
  ws.data.sendCallback = sendCb
  deps.history.record(actualName, projectPath)

  const response: WsRegistered = { type: 'registered', name: actualName, reclaimOnly: true }
  ws.send(JSON.stringify(response))
  deps.onSessionChange?.()
}

function handleDeregister(ws: WsLike, deps: Readonly<WsDeps>): void {
  if (ws.data.sessionName) {
    try {
      deps.sessions.deregisterSession(ws.data.sessionName)
    } catch {}
    ws.data.sessionName = null
    deps.onSessionChange?.()
  }
}

function handleRename(ws: WsLike, newName: string, deps: Readonly<WsDeps>, requestId?: string): void {
  const oldName = ws.data.sessionName
  if (!oldName || !ws.data.sendCallback || !deps.sessions.ownsSender(oldName, ws.data.sendCallback)) {
    sendOperationError(ws, requestId, 'Cannot rename: not registered')
    return
  }
  const conv = deps.conversations?.get(oldName) ?? null
  const actualName = deps.sessions.renameSession(oldName, newName, name => !!deps.inboxes?.target(name) || protectedRenameAlias(deps, name),
    name => deps.inboxes?.renameLegacy(oldName, name, conv))
  deps.subs?.rename(oldName, actualName)
  if (pullSessions.delete(oldName)) pullSessions.add(actualName)
  if (conv) deps.conversations?.set(actualName, conv)
  ws.data.sessionName = actualName
  if (actualName !== oldName) ws.data.renamed = true

  const response: WsRenamed = { type: 'renamed', oldName, newName: actualName, ...(requestId && { requestId }) }
  ws.send(JSON.stringify(response))
}

async function handleReply(ws: WsLike, text: string, replyTo: string | undefined, files: DiscordFile[], deps: Readonly<WsDeps>, explicitChatId?: string, requestId?: string): Promise<void> {
  const sessionName = ws.data.sessionName
  if (!sessionName) {
    sendOperationError(ws, requestId, 'Cannot reply: not registered')
    return
  }
  const chatId = explicitChatId || deps.chatId()
  if (!chatId) {
    if (requestId) sendOperationError(ws, requestId, 'No active Discord chat')
    return
  }

  const activeChat = chatId === deps.chatId()
  const sends: Promise<boolean>[] = []
  if (activeChat && deps.sessions.getActive() !== sessionName) {
    const count = deps.sessions.bufferReply(sessionName, text)
    sends.push(sendToDiscord(deps.client, chatId, `[${sessionName} 📪] ${count} new message${count === 1 ? '' : 's'}`))
  } else {
    const chunks = chunk(`[${sessionName}] ${text}`, deps.chunkLimit, deps.chunkMode)
    for (const [index, content] of chunks.entries()) {
      const shouldReplyTo = activeChat
        ? deps.replyToMode === 'all' || (deps.replyToMode === 'first' && index === 0)
        : index === 0
      sends.push(sendToDiscord(deps.client, chatId, content, shouldReplyTo ? replyTo : undefined, index === 0 ? files : undefined))
    }
    if (activeChat) deps.onReply?.(chatId)
  }
  if (!requestId) return
  const sent = (await Promise.all(sends)).every(Boolean)
  sendToolResult(ws, requestId, sent, sent ? '{}' : 'discord_unavailable')
}

function handleReact(chatId: string, messageId: string, emoji: string, deps: Readonly<WsDeps>): void {
  // Fire-and-forget: react asynchronously without blocking the WS message handler
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch) return
      const msg = await ch.messages.fetch(messageId)
      await msg.react(emoji)
    } catch (err: unknown) {
      process.stderr.write(`discord: react failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  })()
}

async function sendToDiscordAwait(client: Client, chatId: string, text: string, files?: readonly DiscordFile[], nonce?: string): Promise<string | undefined> {
  try {
    const ch = await fetchTextChannelOrNull(client, chatId)
    if (!ch || !('send' in ch)) return undefined
    const sent = await ch.send({ content: text, ...(files?.length && { files: [...files] }), ...(nonce && { nonce, enforceNonce: true }) })
    noteSent(sent.id)
    return sent.id
  } catch {
    process.stderr.write('discord: bus mirror unavailable\n')
    return undefined
  }
}

async function sendToDiscord(client: Client, chatId: string, text: string, replyTo?: string, files?: readonly DiscordFile[]): Promise<boolean> {
  try {
    const ch = await fetchTextChannelOrNull(client, chatId)
    if (!ch || !('send' in ch)) return false
    const sent = await ch.send({
      content: text,
      ...(files?.length && { files: [...files] }),
      ...(replyTo && { reply: { messageReference: replyTo, failIfNotExists: false } }),
    })
    noteSent(sent.id)
    return true
  } catch (err: unknown) {
    process.stderr.write(`discord: send failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return false
  }
}

function handleEditMessage(ws: WsLike, requestId: string, chatId: string, messageId: string, text: string, deps: Readonly<WsDeps>): void {
  // Fire-and-forget: edit message asynchronously and report result via WS tool result
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const msg = await ch.messages.fetch(messageId)
      if (msg.author.id !== deps.client.user?.id) {
        sendToolResult(ws, requestId, false, 'Cannot edit messages from other users')
        return
      }
      await msg.edit(text)
      sendToolResult(ws, requestId, true, 'Message edited')
    } catch (err: unknown) {
      sendToolResult(ws, requestId, false, `Edit failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

function handleDownloadAttachment(ws: WsLike, requestId: string, chatId: string, messageId: string, deps: Readonly<WsDeps>): void {
  // Fire-and-forget: download attachments asynchronously and report result via WS tool result
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const msg = await ch.messages.fetch(messageId)
      if (msg.attachments.size === 0) {
        sendToolResult(ws, requestId, false, 'No attachments on this message')
        return
      }

      // The router is remote: return the bytes; the client writes them to ITS local inbox.
      const files: Array<{ name: string; size: number; data?: string; error?: string }> = []
      let total = 0
      for (const att of msg.attachments.values()) {
        const safeName = `${att.id}_${(att.name ?? att.id).replace(/[^a-zA-Z0-9._-]/g, '_')}`
        if (att.size > MAX_DOWNLOAD_BYTES || total + att.size > MAX_DOWNLOAD_TOTAL) {
          files.push({ name: safeName, size: att.size, error: `too large to relay (${Math.round(att.size / 1048576)} MB); open in Discord: ${att.url}` })
          continue
        }
        const resp = await fetch(att.url)
        if (!resp.ok) { files.push({ name: safeName, size: att.size, error: `HTTP ${resp.status}` }); continue }
        const buf = Buffer.from(await resp.arrayBuffer())
        total += buf.length
        files.push({ name: safeName, size: buf.length, data: buf.toString('base64') })
      }
      sendToolResult(ws, requestId, true, JSON.stringify(files))
    } catch (err: unknown) {
      sendToolResult(ws, requestId, false, `Download failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

function handleFetchMessages(ws: WsLike, requestId: string, channelId: string, limit: number | undefined, deps: Readonly<WsDeps>): void {
  // Fire-and-forget: fetch messages asynchronously and report result via WS tool result
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, channelId)
      if (!ch) {
        sendToolResult(ws, requestId, false, 'Channel not found or not text-based')
        return
      }
      const messages = await ch.messages.fetch({ limit: Math.min(limit ?? 20, 100) })
      const result = messages.map(m => ({
        id: m.id,
        author: m.author.username,
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        attachments: m.attachments.map(a => ({ name: a.name, url: a.url, size: a.size })),
      }))
      sendToolResult(ws, requestId, true, JSON.stringify(result))
    } catch (err: unknown) {
      sendToolResult(ws, requestId, false, `Fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

function handleAskUser(
  ws: WsLike,
  requestId: string,
  chatId: string,
  question: string,
  options: WsAskUser['options'],
  deps: Readonly<WsDeps>,
): void {
  // Fire-and-forget: ask user asynchronously via Discord components and report result via WS tool result
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch || !('send' in ch)) {
        sendToolResult(ws, requestId, false, 'Channel not found or not sendable')
        return
      }

      const sessionName = ws.data.sessionName ?? 'unknown'

      if (options.length <= 5) {
        await askWithButtons(ch, ws, requestId, sessionName, question, options)
      } else {
        await askWithSelectMenu(ch, ws, requestId, sessionName, question, options)
      }
    } catch (err: unknown) {
      sendToolResult(ws, requestId, false, `Ask failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

async function askWithButtons(
  ch: { send: Function },
  ws: WsLike,
  requestId: string,
  sessionName: string,
  question: string,
  options: WsAskUser['options'],
): Promise<void> {
  const row = new ActionRowBuilder<ButtonBuilder>()
  for (const opt of options) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`ask_${requestId}_${opt.value}`)
        .setLabel(opt.label.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    )
  }

  const sent = await (ch as unknown as { send(opts: unknown): Promise<{ id: string; awaitMessageComponent(opts: unknown): Promise<{ customId: string; update(opts: unknown): Promise<void> }>; edit(opts: unknown): Promise<void> }> }).send({
    content: `**[${sessionName}]** ${question}`,
    components: [row],
  })
  noteSent(sent.id)

  try {
    const interaction = await sent.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 300_000,
    })

    const selectedValue = interaction.customId.replace(`ask_${requestId}_`, '')
    const selectedOption = options.find(o => o.value === selectedValue)

    await interaction.update({
      content: `**[${sessionName}]** ${question}\n\n> Selected: **${selectedOption?.label ?? selectedValue}**`,
      components: [],
    })

    sendToolResult(ws, requestId, true, JSON.stringify({
      value: selectedValue,
      label: selectedOption?.label ?? selectedValue,
    }))
  } catch {
    // Timeout -- disable buttons
    await sent.edit({ content: `**[${sessionName}]** ${question}\n\n> *(timed out)*`, components: [] }).catch(() => {})
    sendToolResult(ws, requestId, false, 'Selection timed out (5 min)')
  }
}

async function askWithSelectMenu(
  ch: { send: Function },
  ws: WsLike,
  requestId: string,
  sessionName: string,
  question: string,
  options: WsAskUser['options'],
): Promise<void> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`ask_${requestId}`)
    .setPlaceholder('Choose an option...')

  for (const opt of options.slice(0, 25)) {
    select.addOptions({
      label: opt.label.slice(0, 100),
      description: opt.description?.slice(0, 100),
      value: opt.value.slice(0, 100),
    })
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)

  const sent = await (ch as unknown as { send(opts: unknown): Promise<{ id: string; awaitMessageComponent(opts: unknown): Promise<{ values: string[]; update(opts: unknown): Promise<void> }>; edit(opts: unknown): Promise<void> }> }).send({
    content: `**[${sessionName}]** ${question}`,
    components: [row],
  })
  noteSent(sent.id)

  try {
    const interaction = await sent.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: 300_000,
    })

    const selectedValue = interaction.values[0]
    const selectedOption = options.find(o => o.value === selectedValue)

    await interaction.update({
      content: `**[${sessionName}]** ${question}\n\n> Selected: **${selectedOption?.label ?? selectedValue}**`,
      components: [],
    })

    sendToolResult(ws, requestId, true, JSON.stringify({
      value: selectedValue,
      label: selectedOption?.label ?? selectedValue,
    }))
  } catch {
    await sent.edit({ content: `**[${sessionName}]** ${question}\n\n> *(timed out)*`, components: [] }).catch(() => {})
    sendToolResult(ws, requestId, false, 'Selection timed out (5 min)')
  }
}

/** Map of permission request ID → WS connection that sent it, so we can route verdicts back. */
const permissionSessions = new Map<string, WsLike>()

/** Map of permission request ID → cleanup timer, auto-removes stale entries after 5 minutes. */
const permissionTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

function handlePermissionRequest(
  ws: WsLike,
  requestId: string,
  toolName: string,
  description: string,
  inputPreview: string,
  deps: Readonly<WsDeps>,
): void {
  const chatId = deps.chatId()
  if (!chatId) return

  const sessionName = ws.data.sessionName ?? 'unknown'

  // Store the WS so we can route the verdict back
  permissionSessions.set(requestId, ws)

  // Auto-cleanup after 5 minutes if no verdict is received
  const timeout = setTimeout(() => {
    permissionSessions.delete(requestId)
    permissionTimeouts.delete(requestId)
  }, 300_000)
  permissionTimeouts.set(requestId, timeout)

  // Fire-and-forget: send permission prompt to Discord asynchronously
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(deps.client, chatId)
      if (!ch || !('send' in ch)) return

      // Truncate input preview for Discord
      const preview = inputPreview.length > 800 ? inputPreview.slice(0, 800) + '...' : inputPreview

      const row = new ActionRowBuilder<ButtonBuilder>()
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`perm_yes_${requestId}`)
          .setLabel(`yes ${requestId}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm_no_${requestId}`)
          .setLabel(`no ${requestId}`)
          .setStyle(ButtonStyle.Danger),
      )

      const content = [
        `**[${sessionName}] Permission Request**`,
        `**Tool:** \`${toolName}\``,
        `**Description:** ${description}`,
        `\`\`\`\n${preview}\n\`\`\``,
      ].join('\n')

      const sent = await ch.send({ content, components: [row] })
      noteSent(sent.id)
    } catch (err: unknown) {
      process.stderr.write(`discord: permission request send failed: ${err instanceof Error ? err.message : String(err)}\n`)
      permissionSessions.delete(requestId)
      const t = permissionTimeouts.get(requestId)
      if (t) { clearTimeout(t); permissionTimeouts.delete(requestId) }
    }
  })()
}

/** Handle a button click for a permission request. Called from the router's interactionCreate handler. */
export function handlePermissionButton(customId: string): void {
  const yesMatch = customId.match(/^perm_yes_(.+)$/)
  const noMatch = customId.match(/^perm_no_(.+)$/)

  const requestId = yesMatch?.[1] ?? noMatch?.[1]
  if (!requestId) return

  const behavior: 'allow' | 'deny' = yesMatch ? 'allow' : 'deny'
  const ws = permissionSessions.get(requestId)
  if (!ws) return

  const verdict: WsPermissionVerdict = { type: 'permissionVerdict', requestId, behavior }
  ws.send(JSON.stringify(verdict))
  permissionSessions.delete(requestId)
  const t = permissionTimeouts.get(requestId)
  if (t) { clearTimeout(t); permissionTimeouts.delete(requestId) }
}

function sendToolResult(ws: WsLike, requestId: string, success: boolean, data: string): void {
  const response: WsToolResult = { type: 'toolResult', requestId, success, data }
  ws.send(JSON.stringify(response))
}

/** Type guard: checks that `obj[key]` exists and is a string. */
function hasString<K extends string>(obj: unknown, key: K): obj is Record<K, string> {
  return typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>)[key] === 'string'
}

function sendOperationError(ws: WsLike, requestId: string | undefined, message: string): void {
  if (requestId) sendToolResult(ws, requestId, false, message)
  else sendError(ws, message)
}

function sendError(ws: WsLike, message: string): void {
  const response: WsError = { type: 'error', message }
  ws.send(JSON.stringify(response))
}

// ============================================================
// Agent bus — agent <-> agent messaging through one Discord channel
// ============================================================

const busPostTimes = new Map<string, number[]>()
/** Tests share one process. Production never calls this. */
export function resetBusRateLimit(): void { busPostTimes.clear() }
const HUMAN_TARGETS = new Set(['human', 'admin', 'user', 'me'])

/**
 * Post `[from → to] text` to the bus channel (so humans see the conversation).
 * `to` must be an exact session name. Omitting it mirrors the message and wakes nobody.
 * `to=all` or `to=@all:synthesis` is an explicit fan-out.
 */
export function handleBusPost(ws: WsLike, text: string, to: string | undefined, deps: Readonly<WsDeps>, files?: DiscordFile[], publish?: { requestId?: string; publish_id?: string }, sender?: Target): void {
  if (!ws.data.sessionName) {
    sendError(ws, 'Cannot post to bus: not registered')
    return
  }
  if (!deps.busChannelId) {
    sendOperationError(ws, publish?.requestId, 'Agent bus disabled: router has no DISCORD_BUS_CHANNEL')
    return
  }
  postToChannel(ws, deps.busChannelId, undefined, text, to, deps, files, publish, sender)
}

export function channelSubscribers(deps: Readonly<WsDeps>, channelId: string): string[] {
  const subs = deps.subs
  if (!subs) return []
  const inboxes = deps.inboxes
  const names = subs.subscribers(channelId).filter(name => !inboxes?.target(name))
  if (!inboxes) return names
  const keys = new Set(subs.nativeSubscribers(channelId))
  if (!keys.size) return names
  const aliases = new Map<string, { name: string; live: boolean }>()
  for (const name of inboxes.names()) {
    const target = inboxes.target(name)
    if (!target) continue
    const key = identityKey(target)
    if (!keys.has(key)) continue
    const previous = aliases.get(key)
    if (previous?.live) continue
    const live = !!nativeConnection(inboxes, target)
    if (!previous || live) aliases.set(key, { name, live })
  }
  return [...names, ...[...aliases.values()].map(alias => alias.name)]
}

/** Sessions that receive untargeted traffic in a channel: everyone for the default bus, else subscribers. */
function audience(channelId: string, deps: Readonly<WsDeps>): string[] {
  const live = allNames(deps)
  if (channelId === deps.busChannelId || channelId === deps.humanChannelId) return live
  const subs = new Set(channelSubscribers(deps, channelId))
  return live.filter(n => subs.has(n))
}

async function handleChannelPost(ws: WsLike, msg: WsChannelPost, deps: Readonly<WsDeps>, files: DiscordFile[], sender?: Target): Promise<void> {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined
  if (!ws.data.sessionName) { sendOperationError(ws, requestId, 'Cannot post: not registered'); return }
  const ch = deps.channelOps ? await deps.channelOps.resolve(msg.channel).catch(() => null) : null
  if (!ch) { sendOperationError(ws, requestId, `Unknown channel "${msg.channel}" (use channel_list)`); return }
  postToChannel(ws, ch.id, ch.name, msg.text, msg.to, deps, files, requestId ? { requestId, publish_id: msg.publish_id } : undefined, sender)
}

interface MirrorDelivery {
  messageId?: string
  copyId?: string
}

const mirrorAttempts = new WeakMap<Inboxes, Map<string, {
  fingerprint: string
  result: Promise<MirrorDelivery>
}>>()

function mirrorFingerprint(text: string, files?: readonly DiscordFile[]): string {
  const hash = createHash('sha256').update(JSON.stringify([text, (files ?? []).map(file => [file.name, file.attachment.length])]))
  for (const file of files ?? []) hash.update(file.attachment)
  return hash.digest('hex')
}

function tryPublishMirror(deps: Readonly<WsDeps>, plan: PublishMirror, text: string, files: DiscordFile[] | undefined, attemptKey: string): Promise<MirrorDelivery> {
  const inboxes = deps.inboxes
  let attempts = inboxes ? mirrorAttempts.get(inboxes) : undefined
  if (inboxes && !attempts) { attempts = new Map(); mirrorAttempts.set(inboxes, attempts) }
  const inFlight = attempts?.get(attemptKey)
  if (inFlight) {
    if (inFlight.fingerprint !== plan.fingerprint) return Promise.reject(new Error('publish_payload_mismatch'))
    return inFlight.result
  }
  let expired = false
  let deadline: number | ReturnType<typeof setTimeout>
  const delivered: MirrorDelivery = {}
  const timeout = new Promise<MirrorDelivery>(resolve => {
    deadline = setTimeout(() => { expired = true; resolve({ ...delivered }) }, 2_000)
  })
  const send = async (destination: { where: string; origin: string }, field: keyof MirrorDelivery) => {
    const chunks = chunk(`**[${plan.from} → ${plan.label}]**${destination.origin} ${text}`, deps.chunkLimit, deps.chunkMode)
    let first: string | undefined
    for (const [index, content] of chunks.entries()) {
      if (expired) return
      const nonceParts = field === 'copyId' ? [attemptKey, index, 'copy'] : [attemptKey, index]
      const nonce = createHash('sha256').update(JSON.stringify(nonceParts)).digest('hex').slice(0, 25)
      const messageId = await sendToDiscordAwait(deps.client, destination.where, content, index === 0 ? files : undefined, nonce)
      if (!messageId) return
      first ??= messageId
    }
    delivered[field] = first
  }
  const sends = plan.copyOnly ? [] : [send(plan, 'messageId')]
  if (plan.copy) sends.push(send(plan.copy, 'copyId'))
  const attempt = Promise.race([Promise.all(sends).then(() => delivered), timeout]).finally(() => {
    clearTimeout(deadline)
    attempts?.delete(attemptKey)
  })
  attempts?.set(attemptKey, { fingerprint: plan.fingerprint, result: attempt })
  return attempt
}

function postToChannel(ws: WsLike, channelId: string, channelName: string | undefined, text: string, to: string | undefined, deps: Readonly<WsDeps>, files?: DiscordFile[], publish?: { requestId?: string; publish_id?: string }, sender?: Target): void {
  const from = ws.data.sessionName!
  const requestId = typeof publish?.requestId === 'string' ? publish.requestId : undefined
  const reply = (ok: boolean, data: string) => {
    try {
      if (requestId) sendToolResult(ws, requestId, ok, data)
      else if (!ok) sendError(ws, data)
      else if (publish) ws.send(JSON.stringify({ type: 'published', ...JSON.parse(data) }))
    } catch { /* A caller can retry with the same publish id. */ }
  }
  if (to !== undefined && typeof to !== 'string') { reply(false, 'invalid_target'); return }
  const now = Date.now()
  const id = publish?.publish_id === undefined ? `pub_${now}_${randomUUID()}` : publish.publish_id
  if (typeof id !== 'string' || !id || id.length > 256) { reply(false, 'invalid_publish_id'); return }
  const key = JSON.stringify([sender ? identityKey(sender) : [from, deps.conversations?.get(from)], id])
  const inboxes = deps.inboxes
  const retry = inboxes?.publish(key, now)
  if (retry) {
    if (!retry.mirror) { reply(true, JSON.stringify(retry.result)); return }
    if (retry.mirror.fingerprint !== mirrorFingerprint(text, files)) {
      reply(false, 'publish_payload_mismatch')
      return
    }
    const copyOnly = retry.mirror.copyOnly
    const attemptKey = JSON.stringify([key, copyOnly ? 'uncommitted' : retry.at])
    void tryPublishMirror(deps, retry.mirror, text, files, attemptKey).then(({ messageId, copyId }) => {
      const delivered = copyOnly ? copyId : messageId
      if (delivered) inboxes!.publishMirrored(key, retry.at, delivered)
      const result: PublishResult = delivered ? retry.result : copyOnly
        ? { ...retry.result, copy: 'failed' }
        : { ...retry.result, mirror: 'failed' }
      reply(true, JSON.stringify(result))
    }).catch(err => reply(false, inboxError(err)))
    return
  }

  // Loop guard: cap posts per session per minute.
  const limit = deps.busMaxPerMinute ?? 12
  const times = (busPostTimes.get(from) ?? []).filter(t => now - t < 60_000)
  if (times.length >= limit) {
    reply(false, `Agent bus rate limit: max ${limit} posts/minute. Wait before posting again.`)
    return
  }
  times.push(now)
  busPostTimes.set(from, times)

  const names = allNames(deps).filter(n => n !== from)
  const heard = audience(channelId, deps).filter(n => n !== from)
  const defaultLabel = channelId === deps.busChannelId || channelId === deps.humanChannelId ? 'all' : 'subscribers'
  const routed = routeAgentTarget(to, names, heard, defaultLabel, deps)
  if (!routed.ok) {
    reply(false, routed.error)
    return
  }
  const targets = routed.targets
  const toLabel = routed.label
  const allMode = routed.allMode
  if (routed.passive) deps.unread?.bump(heard)
  deps.activity?.markPost(from)

  const humanChannel = toLabel === 'human' && deps.humanChannelId !== channelId ? deps.humanChannelId : undefined
  const redirect = humanChannel && (!channelName || channelId === deps.busChannelId)
  const source = channelName ? `#${channelName}` : '#general'
  const where = redirect ? humanChannel : channelId
  const origin = redirect ? ` (from ${source})` : ''
  const copy = humanChannel && !redirect ? { where: humanChannel, origin: ` (from ${source})` } : undefined
  const meta: ChannelMeta = {
    ...(files?.length && { attachments: files.map(f => f.name).join('; '), attachment_count: String(files.length) }),
    chat_id: channelId,
    ...(channelName && { channel: channelName }),
    user: from,
    source: 'agent-bus',
    from,
    to: toLabel,
    ...(allMode && { all_mode: allMode }),
    ts: new Date(now).toISOString(),
  }

  const body = allMode === 'synthesis' ? `${text}\n\n(synthesis: read this channel for earlier replies before adding anything)` : text
  const result: PublishResult = { publish_id: id, committed: targets }
  const mirror: PublishMirror = { where, label: toLabel, origin, copy, from, fingerprint: mirrorFingerprint(text, files), sender }
  const messages = targets.map(name => {
    const stamped = admission(deps, name, meta)
    if (!stamped) throw new Error('unknown_target')
    return { name, content: body, meta: stamped }
  })
  const record = publish && targets.length ? { key, result, at: now, mirror } : undefined
  const entries = inboxes?.commit(messages, record) ?? []
  entries.forEach((entry, index) => logCommit(deps, targets[index]!, entry))
  // Prefer a Discord message reference when available, with bounded waiting
  // before delivery to agents. A mirror retry never replays agent transport.
  const attemptKey = JSON.stringify([key, record ? now : 'uncommitted'])
  void tryPublishMirror(deps, mirror, text, files, attemptKey).then(({ messageId, copyId }) => {
    const copyFailed = !!copy && !copyId
    if (copyId) inboxes?.setMirror([], copyId, sender)
    if (messageId) {
      if (record) inboxes?.publishMirrored(key, now, messageId)
      else {
        inboxes?.setMirror(entries.map(entry => entry.id), messageId, sender)
        if (publish && (publish.publish_id !== undefined || requestId) && !inboxes?.publish(key)) {
          const pendingCopy = copyFailed ? { ...mirror, copyOnly: true as const } : undefined
          inboxes?.commit([], { key, result, at: now, mirror: pendingCopy })
        }
      }
    }
    if (!inboxes) {
      deliverNamed(targets, body, { ...meta, ...(messageId && { message_id: messageId }) }, deps)
    } else {
      entries.forEach((entry, index) => {
        const pending = inboxes.get(entry.id)
        if (pending) scheduleTransport(deps, targets[index]!, pending)
      })
    }
    if (!messageId && (toLabel === 'human' || (requestId && !targets.length))) { reply(false, 'discord_unavailable'); return }
    if (!messageId && targets.length) reply(true, JSON.stringify({ ...result, mirror: 'failed' }))
    else reply(true, JSON.stringify(copyFailed ? { ...result, copy: 'failed' } : result))
  }).catch(err => reply(false, inboxError(err)))

}

type AgentRoute = { ok: true; targets: string[]; label: string; passive: boolean; allMode?: 'independent' | 'synthesis' } | { ok: false; error: string }

/** `to` omitted or `subscribers` = mirror only. `all` = explicit fan-out. Anything else must be exact. */
function routeAgentTarget(to: string | undefined, names: readonly string[], heard: readonly string[], defaultLabel: string, deps: Readonly<WsDeps>): AgentRoute {
  if (!to) return { ok: true, targets: [], label: defaultLabel, passive: true }
  const low = to.toLowerCase()
  if (HUMAN_TARGETS.has(low)) return { ok: true, targets: [], label: 'human', passive: false }
  if (low === 'subscribers') return { ok: true, targets: [], label: 'subscribers', passive: true }
  const all = /^(?:@)?all(?::(synthesis|independent))?$/.exec(low)
  if (all) {
    const mode = all[1] === 'synthesis' ? 'synthesis' : 'independent'
    return { ok: true, targets: orderByCost(heard, n => deps.costs?.get(n) ?? 'standard'), label: 'all', passive: false, allMode: mode }
  }
  const resolved = resolveExact(to, names)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  return { ok: true, targets: [resolved.name], label: resolved.name, passive: false }
}

function deliverNamed(names: readonly string[], text: string, meta: ChannelMeta, deps: Readonly<WsDeps>): void {
  const inboxes = deps.inboxes
  if (!inboxes) {
    for (const name of names) {
      const delay = transportDelay(deps, name, meta)
      if (delay) setTimeout(() => deliver(deps, name, text, meta), delay)
      else deliver(deps, name, text, meta)
    }
    return
  }
  const messages = names.flatMap(name => {
    const stamped = admission(deps, name, meta.routed === 'dispatch' ? { ...meta, to: name } : meta)
    return stamped ? [{ name, content: text, meta: stamped }] : []
  })
  const entries = inboxes.commit(messages)
  entries.forEach((entry, index) => {
    const name = messages[index]!.name
    logCommit(deps, name, entry)
    scheduleTransport(deps, name, entry)
  })
}

function transportDelay(deps: Readonly<WsDeps>, name: string, meta: ChannelMeta): number {
  return meta.all_mode && deps.costs?.get(name) !== 'cheap' ? deps.staggerMs ?? 0 : 0
}

function scheduleTransport(deps: Readonly<WsDeps>, name: string, entry: InboxEntry): void {
  const delay = transportDelay(deps, name, entry.meta)
  if (!delay) { transport(deps, name, entry); return }
  setTimeout(() => {
    const current = deps.inboxes?.get(entry.id)
    if (!current) return
    try { transport(deps, name, current) } catch { /* Mail remains committed. */ }
  }, delay)
}

function oneHumanTarget(deps: Readonly<WsDeps> | undefined, meta: ChannelMeta, names: readonly string[]): string | undefined {
  const dispatcher = deps?.dispatcher
  if (dispatcher && names.includes(dispatcher)) return dispatcher
  const owner = meta.chat_id ? deps?.channelOwners?.get(meta.chat_id) : undefined
  if (owner && names.includes(owner)) return owner
  return undefined
}

/** Live push sessions. Pull-mode and node-only headless agents are not interactive. */
function interactiveNames(deps: Readonly<WsDeps> | undefined, sessions: SessionManager, pool: readonly string[]): string[] {
  const live = new Set((deps ? deps.sessions : sessions).getSessions().map(s => s.name))
  return pool.filter(n => live.has(n) && !pullSessions.has(n))
}

/** Dispatcher re-delivers a stored human post. Anyone else is refused. */
function handleDispatch(ws: WsLike, parsed: { requestId?: string; messageId?: string; to?: readonly unknown[] }, deps: Readonly<WsDeps>): void {
  const requestId = parsed.requestId
  const messageId = parsed.messageId
  const to = parsed.to
  if (typeof requestId !== 'string' || typeof messageId !== 'string' || !Array.isArray(to)) {
    sendError(ws, 'dispatch requires requestId, messageId, and to')
    return
  }
  const me = ws.data.sessionName
  if (!me) { sendToolResult(ws, requestId, false, 'not registered'); return }
  if (!deps.dispatcher || me !== deps.dispatcher) {
    sendToolResult(ws, requestId, false, 'only the dispatcher can re-deliver a human message')
    return
  }
  const saved = deps.humanMail?.get(messageId)
  if (!saved) { sendToolResult(ws, requestId, false, `no human message ${messageId}`); return }
  const names = allNames(deps)
  const targets: string[] = []
  for (const raw of to) {
    if (typeof raw !== 'string' || !raw) { sendToolResult(ws, requestId, false, 'to must be exact session names'); return }
    const resolved = resolveExact(raw, names)
    if (!resolved.ok) { sendToolResult(ws, requestId, false, resolved.error); return }
    if (!targets.includes(resolved.name)) targets.push(resolved.name)
  }
  if (targets.length === 0) { sendToolResult(ws, requestId, false, 'to must name at least one session'); return }
  deliverNamed(targets, saved.content, {
    ...saved.meta,
    from_human: 'true',
    question_id: messageId,
    message_id: messageId,
    routed: 'dispatch',
  }, deps)
  const note = `routed to ${targets.join(', ')}`
  if (saved.meta.chat_id) sendToDiscord(deps.client, saved.meta.chat_id, note)
  sendToolResult(ws, requestId, true, JSON.stringify({ delivered: targets, question_id: messageId }))
}

/**
 * Deliver a human-authored message. An exact `@name` wakes that session.
 * A prefix or a typo wakes nobody and asks the sender. Untargeted text wakes
 * the dispatcher, or the channel owner if the dispatcher is offline.
 * With neither, it wakes live interactive sessions and skips headless agents.
 * `@all` is the explicit fan-out and must be the whole token. `@all:synthesis`
 * tells later sessions to read earlier replies; it does not attach them.
 * A Discord reply that also names a session follows the name, not the dispatcher.
 */
export function routeHumanBusMessage(content: string, meta: ChannelMeta, sessions: SessionManager, audienceNames?: readonly string[], deps?: Readonly<WsDeps>): string[] {
  const names = deps ? allNames(deps) : sessions.getSessions().map(s => s.name)
  const send = (n: string, t: string, m: ChannelMeta) => {
    if (deps) deliver(deps, n, t, m)
    else sessions.routeToSession(n, t, m)
  }
  const pool = audienceNames ? names.filter(n => audienceNames.includes(n)) : names
  deps?.humanMail?.remember(content, meta)
  const replyMeta: ChannelMeta = meta.unbound_reply
    ? { in_reply_to: meta.unbound_reply, question_id: meta.question_id ?? meta.unbound_reply }
    : {}
  // The mode, when present, must be the whole word. `@all-team` and `@all:synthesiz` are not broadcasts.
  const all = content.match(/^\s*@all(?::(synthesis|independent))?(?:\s+|$)([\s\S]*)$/i)
  if (all) {
    const mode = all[1]?.toLowerCase() === 'synthesis' ? 'synthesis' : 'independent'
    const body = all[2]?.trim() ? all[2] : content
    const ordered = orderByCost(pool, n => deps?.costs?.get(n) ?? 'standard')
    const text = mode === 'synthesis' ? `${body}\n\n(synthesis: read this channel for earlier replies before adding anything)` : body
    if (deps) deliverNamed(ordered, text, { ...meta, ...replyMeta, to: 'all', all_mode: mode }, deps)
    else for (const n of ordered) send(n, text, { ...meta, ...replyMeta, to: 'all', all_mode: mode })
    return ordered
  }
  // A bare first word is not an address. `@name` or `name:` is. "11: no" has a colon
  // but matches nobody, so it falls through instead of becoming an error.
  const m = content.match(/^\s*(@)?([\w.@:/-]+?)(:)?\s+([\s\S]*)$/)
  if (m && (m[1] || m[3])) {
    const token = m[2]
    const resolved = resolveExact(token, names)
    if (resolved.ok) {
      send(resolved.name, m[4], { ...meta, ...replyMeta, to: resolved.name })
      return [resolved.name]
    }
    const prefix = names.some(n => n.startsWith(token))
    if (m[1] || prefix) {
      deps?.onRoutingError?.(resolved.error)
      return []
    }
  }
  const one = oneHumanTarget(deps, meta, names)
  if (one) {
    send(one, content, { ...meta, ...replyMeta, to: one, routed: 'dispatcher' })
    deps?.unread?.bump(pool.filter(n => n !== one))
    deps?.onRouteNote?.(`routed to ${one}`)
    return [one]
  }
  const interactive = orderByCost(interactiveNames(deps, sessions, pool), n => deps?.costs?.get(n) ?? 'standard')
  if (interactive.length > 0) {
    for (const n of interactive) send(n, content, { ...meta, ...replyMeta, to: n, routed: 'interactive' })
    deps?.onRouteNote?.(`routed to ${interactive.join(', ')} (no dispatcher; live interactive only)`)
    return interactive
  }
  deps?.onRouteNote?.(names.length
    ? 'not routed: no live interactive session is connected. Headless agents were not woken.'
    : 'not routed: no agent sessions are connected.')
  return []
}

async function handleChannelOp(ws: WsLike, msg: { type: string; requestId: string; channel?: string; name?: string; topic?: string; replacement?: string; session?: string }, deps: Readonly<WsDeps>, sender?: Target): Promise<void> {
  // A legacy alias change cannot confer or carry administrative privileges.
  const caller = ws.data.sessionName
  const admin = caller && !ws.data.renamed && deps.admins?.has(caller)
  if (msg.session && caller && msg.session !== caller && !admin) {
    sendToolResult(ws, msg.requestId, false, 'only admin sessions may act for another session')
    return
  }
  const me = (admin && msg.session) || caller
  const ops = deps.channelOps
  const subs = deps.subs
  if (!me) { sendToolResult(ws, msg.requestId, false, 'not registered'); return }
  if (!ops || !subs) { sendToolResult(ws, msg.requestId, false, 'channels disabled: router has no DISCORD_BUS_CHANNEL'); return }
  const target = sender?.alias === me ? sender : deps.inboxes?.target(me)
  const identity = target && identityKey(target)
  try {
    if (msg.type === 'channelList') {
      const list = await ops.list()
      const out = list.map(c => ({
        id: c.id, name: c.name, topic: c.topic ?? undefined,
        default: c.id === deps.busChannelId,
        human: c.id === deps.humanChannelId,
        subscribed: c.id === deps.busChannelId || c.id === deps.humanChannelId || subs.has(me, c.id, identity),
        subscribers: c.id === deps.busChannelId || c.id === deps.humanChannelId ? ['(everyone)'] : channelSubscribers(deps, c.id),
      }))
      sendToolResult(ws, msg.requestId, true, JSON.stringify(out))
      return
    }
    if (msg.type === 'channelCreate') {
      if (!msg.name) { sendToolResult(ws, msg.requestId, false, 'channel_create requires name'); return }
      const existing = await ops.resolve(msg.name)
      const ch = existing ?? await ops.create(msg.name, msg.topic)
      subs.add(me, ch.id, identity)
      sendToolResult(ws, msg.requestId, true, JSON.stringify({ ...ch, created: !existing, subscribed: true }))
      return
    }
    const ch = msg.channel ? await ops.resolve(msg.channel) : null
    if (!ch) { sendToolResult(ws, msg.requestId, false, `Unknown channel "${msg.channel ?? ''}" (use channel_list)`); return }
    if (ch.id === deps.busChannelId) {
      sendToolResult(ws, msg.requestId, true, JSON.stringify({ ...ch, note: 'default bus channel: every session always receives it' }))
      return
    }
    if (msg.type === 'channelArchive') {
      if (ch.id === deps.humanChannelId) { sendToolResult(ws, msg.requestId, false, 'cannot archive the human channel'); return }
      const repl = msg.replacement ? await ops.resolve(msg.replacement) : null
      if (msg.replacement && !repl) { sendToolResult(ws, msg.requestId, false, `Unknown replacement channel "${msg.replacement}"`); return }
      if (repl?.id === ch.id) { sendToolResult(ws, msg.requestId, false, 'replacement is the same channel'); return }
      const note = `ARCHIVED by ${me}${repl ? ` — continue in #${repl.name} (${repl.id})` : ''}`
      if (ops.archive) await ops.archive(ch.id, note)
      const moved = channelSubscribers(deps, ch.id)
      subs.moveChannel(ch.id, repl?.id)
      sendToDiscord(deps.client, ch.id, `**${note}**`)
      sendToolResult(ws, msg.requestId, true, JSON.stringify({ ...ch, archived: true, movedSubscribers: moved, ...(repl && { replacement: repl }) }))
      return
    }
    const changed = msg.type === 'channelSubscribe' ? subs.add(me, ch.id, identity) : subs.remove(me, ch.id, identity)
    sendToolResult(ws, msg.requestId, true, JSON.stringify({ ...ch, subscribed: msg.type === 'channelSubscribe', changed }))
  } catch (err: unknown) {
    sendToolResult(ws, msg.requestId, false, `${msg.type} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
