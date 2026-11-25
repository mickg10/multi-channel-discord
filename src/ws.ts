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
import type { Inboxes, NodeRegistry, Claims } from './nodes.js'
import type { McpRouterDeps, McpServerDecl } from './mcp.js'
import { newCallId } from './mcp.js'
import { orderByCost, resolveExact, type Activity, type CostClasses, type Unread, type WakeBudget, type WakeLog } from './wake.js'

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
import { createHash, timingSafeEqual } from 'node:crypto'
import { join, basename } from 'node:path'

export interface WsData {
  sessionName: string | null
  /** The send callback registered with SessionManager, kept for cleanup on close. */
  sendCallback: ((msg: string) => void) | null
  /** True once the plugin has registered with the correct shared secret. */
  authed?: boolean
  /** Set when this connection is a node daemon. */
  nodeName?: string
  /** Register-time instance id of the client connection (grant binding). */
  instanceId?: string
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
  return [...out]
}

/**
 * Deliver one message to one agent: push to a live push-mode session; otherwise queue it in the
 * durable inbox and, if a node owns the agent, ask the node to run a turn.
 */
export function deliver(deps: Readonly<WsDeps>, name: string, text: string, meta: ChannelMeta): boolean {
  const live = deps.sessions.getSessions().some(s => s.name === name)
  const cold = !live
  // Human mail and the router's own rules always wake. Other cold wakes are budgeted.
  const exempt = meta.from_human === 'true' || meta.from === 'router'
  if (cold && !exempt && deps.budget && !deps.budget.allow(name, deps.costs?.get(name) ?? 'standard')) {
    deps.unread?.bump([name])
    return false
  }
  let ok = false
  let pending = deps.inboxes?.count(name) ?? 0
  if (live && !pullSessions.has(name)) ok = deps.sessions.routeToSession(name, text, meta)
  else if (!deps.inboxes) ok = live ? deps.sessions.routeToSession(name, text, meta) : false
  else if (!live && !deps.nodes?.get(name)) ok = false
  else {
    pending = deps.inboxes.push(name, text, meta)
    // A live pull session is mid-turn and will check_inbox; the node re-checks after the turn.
    if (!live) deps.nodes?.wake(name, pending)
    ok = true
  }
  if (ok) deps.wakeLog?.record({ name, messageId: meta.message_id, pending, cold, at: Date.now() })
  return ok
}

function sendRulesOnce(deps: Readonly<WsDeps>, name: string): void {
  const r = deps.rules?.()
  if (!r || r.seen(name)) return
  r.markSeen(name)
  deliver(deps, name, r.text, { source: 'agent-bus', from: 'router', user: 'router', to: name, channel: 'rules', chat_id: deps.busChannelId })
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

export function createWsHandlers(deps: Readonly<WsDeps>): WsHandlers {
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

      dispatchMessage(ws, parsed, deps)
    },

    close(ws: WsLike): void {
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

function dispatchMessage(ws: WsLike, parsed: PluginToRouterMessage, deps: Readonly<WsDeps>): void {
  if (deps.secret && parsed.type !== 'register' && parsed.type !== 'registerNode' && !ws.data.authed) {
    sendError(ws, 'Not authenticated: register with the router secret first')
    return
  }
  switch (parsed.type) {
    case 'registerNode': {
      if (deps.secret && parsed.secret !== deps.secret) { sendError(ws, 'register rejected: bad or missing router secret'); return }
      if (!deps.nodes || !hasString(parsed, 'node') || !Array.isArray(parsed.agents)) { sendError(ws, 'registerNode requires node and agents (and a router with nodes enabled)'); return }
      {
        // The shared router secret only proves "some client of this bus". Node names own wakes
        // and MCP execution, so each node proves its identity with its own secret.
        const ns = deps.nodeSecrets?.()
        const want = ns?.hashes[parsed.node]
        const got = (parsed as { nodeSecret?: string }).nodeSecret
        if (want) {
          const h = got ? createHash('sha256').update(got).digest('hex') : ''
          if (!h || !timingSafeEqual(Buffer.from(h), Buffer.from(want))) { sendError(ws, `register rejected: bad or missing node secret for "${parsed.node}"`); return }
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
      // a headless turn on the same conversation; any queued mail is handed to the live session.
      const p = parsed as { requestId?: string; agent?: string }
      if (!p.requestId || !p.agent) { sendError(ws, 'agentStatus requires requestId and agent'); return }
      const live = deps.sessions.getSessions().some(s => s.name === p.agent)
      const push = live && !pullSessions.has(p.agent)
      if (push) for (const q of deps.inboxes?.drain(p.agent) ?? []) deps.sessions.routeToSession(p.agent, q.content, { ...q.meta, queued_at: q.at })
      sendToolResult(ws, p.requestId, true, JSON.stringify({ live, mode: live ? (push ? 'push' : 'pull') : null, pending: deps.inboxes?.count(p.agent) ?? 0 }))
      break
    }
    case 'inboxPull':
    case 'inboxCount': {
      if (!hasString(parsed, 'requestId')) { sendError(ws, 'inbox op requires requestId'); return }
      const who = parsed.type === 'inboxCount' ? parsed.agent : ws.data.sessionName
      if (!who) { sendToolResult(ws, parsed.requestId, false, 'not registered'); return }
      if (parsed.type === 'inboxCount') sendToolResult(ws, parsed.requestId, true, String(deps.inboxes?.count(who) ?? 0))
      else {
        // Directed mail only. Old clients get a bare array. withUnread adds a count of
        // passive chatter and never the bodies.
        const messages = deps.inboxes?.drain(who) ?? []
        const withUnread = (parsed as { withUnread?: boolean }).withUnread === true
        const unread = withUnread ? (deps.unread?.take(who) ?? 0) : 0
        sendToolResult(ws, parsed.requestId, true, JSON.stringify(withUnread ? { messages, unread } : messages))
      }
      break
    }
    case 'busPost':
      if (!hasString(parsed, 'text')) {
        sendError(ws, 'busPost requires text')
        return
      }
      {
        const { files, errors } = decodeFiles((parsed as { files?: unknown }).files)
        for (const e of errors) sendError(ws, e)
        handleBusPost(ws, parsed.text, parsed.to, deps, files)
      }
      break
    case 'channelPost':
      if (!hasString(parsed, 'channel') || !hasString(parsed, 'text')) {
        sendError(ws, 'channelPost requires channel and text')
        return
      }
      {
        const { files, errors } = decodeFiles((parsed as { files?: unknown }).files)
        for (const e of errors) sendError(ws, e)
        void handleChannelPost(ws, parsed.channel, parsed.text, parsed.to, deps, files)
      }
      break
    case 'channelList':
    case 'channelCreate':
    case 'channelSubscribe':
    case 'channelUnsubscribe':
    case 'channelArchive':
      if (!hasString(parsed, 'requestId')) {
        sendError(ws, 'channel operation requires requestId')
        return
      }
      void handleChannelOp(ws, parsed, deps)
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
        const liveNames = new Set(live.map(s => s.name))
        const asleep = (deps.nodes?.list() ?? []).filter(a => !liveNames.has(a.name)).map(a => ({
          name: a.name, projectPath: a.cwd ?? '', connectedAt: '', state: 'idle', node: a.node,
          ...row(a.name),
        }))
        sendToolResult(ws, parsed.requestId, true, JSON.stringify([...live, ...asleep]))
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
      ws.data.authed = true
      {
        // Headless turns (pull mode) re-register the same name each turn; replace the stale
        // slot instead of creating "name-2" that nobody reads.
        const p = parsed as { mode?: string; takeover?: boolean; instanceId?: string }
        const stale = deps.sessions.getSessions().find(s => s.name === parsed.name)
        if (stale && (p.takeover || p.mode === 'pull')) {
          try { deps.sessions.deregisterSession(parsed.name) } catch {}
        }
      }
      handleRegister(ws, parsed.name, parsed.projectPath, (parsed as { instanceId?: string }).instanceId, deps)
      if (ws.data.sessionName) {
        if ((parsed as { mode?: string }).mode === 'pull') pullSessions.add(ws.data.sessionName)
        else {
          pullSessions.delete(ws.data.sessionName)
          // Messages queued while this agent was offline: push them now.
          for (const q of deps.inboxes?.drain(ws.data.sessionName) ?? []) deps.sessions.routeToSession(ws.data.sessionName, q.content, { ...q.meta, queued_at: q.at })
        }
        sendRulesOnce(deps, ws.data.sessionName)
        deps.costs?.set(ws.data.sessionName, (parsed as { costClass?: unknown }).costClass)
      }
      break
    case 'deregister':
      handleDeregister(ws, deps)
      break
    case 'rename':
      if (!hasString(parsed, 'name')) {
        sendError(ws, 'rename requires name')
        return
      }
      handleRename(ws, parsed.name, deps)
      break
    case 'reply':
      if (!hasString(parsed, 'text')) {
        sendError(ws, 'reply requires text')
        return
      }
      if (deps.busChannelId && parsed.chatId === deps.busChannelId) {
        const { files, errors } = decodeFiles(parsed.files)
        for (const e of errors) sendError(ws, e)
        handleBusPost(ws, parsed.text, undefined, deps, files)
        return
      }
      {
        const { files, errors } = decodeFiles(parsed.files)
        for (const e of errors) sendError(ws, e)
        handleReply(ws, parsed.text, parsed.replyTo, files.length ? files : undefined, deps, parsed.chatId)
      }
      break
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

function handleRegister(ws: WsLike, name: string, projectPath: string, instanceId: string | undefined, deps: Readonly<WsDeps>): void {
  const sendCb = (msg: string) => ws.send(msg)
  ws.data.instanceId = instanceId
  const actualName = deps.sessions.registerSession(
    sendCb,
    name,
    projectPath,
    instanceId,
  )
  ws.data.sessionName = actualName
  ws.data.sendCallback = sendCb
  deps.history.record(actualName, projectPath)

  const response: WsRegistered = { type: 'registered', name: actualName }
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

function handleRename(ws: WsLike, newName: string, deps: Readonly<WsDeps>): void {
  const oldName = ws.data.sessionName
  if (!oldName) {
    sendError(ws, 'Cannot rename: not registered')
    return
  }
  const actualName = deps.sessions.renameSession(oldName, newName)
  ws.data.sessionName = actualName

  const response: WsRenamed = { type: 'renamed', oldName, newName: actualName }
  ws.send(JSON.stringify(response))
}

function handleReply(ws: WsLike, text: string, replyTo: string | undefined, files: DiscordFile[] | undefined, deps: Readonly<WsDeps>, explicitChatId?: string): void {
  const sessionName = ws.data.sessionName
  if (!sessionName) {
    sendError(ws, 'Cannot reply: not registered')
    return
  }

  // An explicit chat_id (e.g. a group channel the agent was addressed in) is honoured
  // directly; otherwise fall back to the human's most recent chat.
  if (explicitChatId && explicitChatId !== deps.chatId()) {
    const cs = chunk(`[${sessionName}] ${text}`, deps.chunkLimit, deps.chunkMode)
    cs.forEach((c, i) => sendToDiscord(deps.client, explicitChatId, c, i === 0 ? replyTo : undefined, i === 0 ? files : undefined))
    return
  }

  const chatId = deps.chatId()
  if (!chatId) return

  const isActive = deps.sessions.getActive() === sessionName

  if (!isActive) {
    const count = deps.sessions.bufferReply(sessionName, text)
    sendToDiscord(deps.client, chatId, `[${sessionName} 📪] ${count} new message${count === 1 ? '' : 's'}`)
    return
  }

  // Active session — prefix with [session-name], chunk, and send
  const prefixed = `[${sessionName}] ${text}`
  const chunks = chunk(prefixed, deps.chunkLimit, deps.chunkMode)

  for (let i = 0; i < chunks.length; i++) {
    const shouldReplyTo = replyTo != null && deps.replyToMode !== 'off' && (deps.replyToMode === 'all' || i === 0)
    sendToDiscord(deps.client, chatId, chunks[i], shouldReplyTo ? replyTo : undefined, i === 0 ? files : undefined)
  }

  // Stop typing indicator when a reply is sent
  deps.onReply?.(chatId)
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

async function sendToDiscordAwait(client: Client, chatId: string, text: string, files?: readonly DiscordFile[]): Promise<string | undefined> {
  try {
    const ch = await fetchTextChannelOrNull(client, chatId)
    if (!ch || !('send' in ch)) return undefined
    const sent = await ch.send({ content: text, ...(files?.length ? { files: [...files] } : {}) })
    noteSent(sent.id)
    return sent.id
  } catch (err: unknown) {
    process.stderr.write(`discord: send failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return undefined
  }
}

function sendToDiscord(client: Client, chatId: string, text: string, replyTo?: string, files?: readonly DiscordFile[]): void {
  // Fire-and-forget: send to Discord asynchronously without blocking the caller
  void (async () => {
    try {
      const ch = await fetchTextChannelOrNull(client, chatId)
      if (!ch || !('send' in ch)) return

      const validFiles = files ?? []
      const sent = await ch.send({
        content: text,
        ...(validFiles.length > 0 ? { files: validFiles } : {}),
        ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
      })
      noteSent(sent.id)
    } catch (err: unknown) {
      process.stderr.write(`discord: send failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  })()
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
export function handleBusPost(ws: WsLike, text: string, to: string | undefined, deps: Readonly<WsDeps>, files?: DiscordFile[]): void {
  if (!ws.data.sessionName) {
    sendError(ws, 'Cannot post to bus: not registered')
    return
  }
  if (!deps.busChannelId) {
    sendError(ws, 'Agent bus disabled: router has no DISCORD_BUS_CHANNEL')
    return
  }
  postToChannel(ws, deps.busChannelId, undefined, text, to, deps, files)
}

/** Sessions that receive untargeted traffic in a channel: everyone for the default bus, else subscribers. */
function audience(channelId: string, deps: Readonly<WsDeps>): string[] {
  const live = allNames(deps)
  if (channelId === deps.busChannelId || channelId === deps.humanChannelId) return live
  const subs = new Set(deps.subs?.subscribers(channelId) ?? [])
  return live.filter(n => subs.has(n))
}

async function handleChannelPost(ws: WsLike, ref: string, text: string, to: string | undefined, deps: Readonly<WsDeps>, files?: DiscordFile[]): Promise<void> {
  if (!ws.data.sessionName) { sendError(ws, 'Cannot post: not registered'); return }
  const ch = deps.channelOps ? await deps.channelOps.resolve(ref).catch(() => null) : null
  if (!ch) { sendError(ws, `Unknown channel "${ref}" (use channel_list)`); return }
  postToChannel(ws, ch.id, ch.name, text, to, deps, files)
}

function postToChannel(ws: WsLike, channelId: string, channelName: string | undefined, text: string, to: string | undefined, deps: Readonly<WsDeps>, files?: DiscordFile[]): void {
  const from = ws.data.sessionName!

  // Loop guard: cap posts per session per minute.
  const now = Date.now()
  const limit = deps.busMaxPerMinute ?? 12
  const times = (busPostTimes.get(from) ?? []).filter(t => now - t < 60_000)
  if (times.length >= limit) {
    sendError(ws, `Agent bus rate limit: max ${limit} posts/minute. Wait before posting again.`)
    return
  }
  times.push(now)
  busPostTimes.set(from, times)

  const names = allNames(deps).filter(n => n !== from)
  const heard = audience(channelId, deps).filter(n => n !== from)
  const defaultLabel = channelId === deps.busChannelId || channelId === deps.humanChannelId ? 'all' : 'subscribers'
  const routed = routeAgentTarget(to, names, heard, defaultLabel, deps)
  if (!routed.ok) {
    sendError(ws, routed.error)
    return
  }
  let targets = routed.targets
  const toLabel = routed.label
  const allMode = routed.allMode
  if (routed.passive) deps.unread?.bump(heard)
  deps.activity?.markPost(from)

  const toHuman = toLabel === 'human' && deps.humanChannelId && deps.humanChannelId !== channelId
  const where = toHuman ? deps.humanChannelId! : channelId
  const origin = toHuman ? ` (from ${channelName ? `#${channelName}` : channelId === deps.busChannelId ? '#general' : channelId})` : ''
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

  const chunks = chunk(`**[${from} → ${toLabel}]**${origin} ${text}`, deps.chunkLimit, deps.chunkMode)
  // Deliver only after Discord accepts the mirror, so the recipient gets that message id.
  void sendToDiscordAwait(deps.client, where, chunks[0], files?.length ? files : undefined).then(id => {
    chunks.slice(1).forEach(c => sendToDiscord(deps.client, where, c))
    finish(id)
  })

  function finish(messageId: string | undefined): void {
    const m: ChannelMeta = { ...meta, ...(messageId && { message_id: messageId, chat_id: where }) }
    const body = allMode === 'synthesis' ? `${text}\n\n(synthesis: read this channel for earlier replies before adding anything)` : text
    deliverNamed(targets, body, m, deps)
  }

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
  const delay = meta.all_mode && (deps.staggerMs ?? 0) > 0 ? deps.staggerMs! : 0
  if (delay <= 0) {
    for (const name of names) deliver(deps, name, text, meta)
    return
  }
  const cheap = names.filter(n => (deps.costs?.get(n) ?? 'standard') === 'cheap')
  const rest = names.filter(n => !cheap.includes(n))
  for (const name of cheap) deliver(deps, name, text, meta)
  if (rest.length) setTimeout(() => { for (const name of rest) deliver(deps, name, text, meta) }, delay)
}

function oneHumanTarget(deps: Readonly<WsDeps> | undefined, meta: ChannelMeta, names: readonly string[]): string | undefined {
  const dispatcher = deps?.dispatcher
  if (dispatcher && names.includes(dispatcher)) return dispatcher
  const owner = meta.chat_id ? deps?.channelOwners?.get(meta.chat_id) : undefined
  if (owner && names.includes(owner)) return owner
  return undefined
}

/**
 * Deliver a human-authored message. An exact `@name` wakes that session.
 * A prefix or a typo wakes nobody and asks the sender. Untargeted text wakes
 * the dispatcher, or the channel owner if the dispatcher is offline. Never the fleet.
 * `@all` is the explicit fan-out. `@all:synthesis` tells later sessions to read
 * earlier replies; `@all` and `@all:independent` do not attach them.
 */
export function routeHumanBusMessage(content: string, meta: ChannelMeta, sessions: SessionManager, audienceNames?: readonly string[], deps?: Readonly<WsDeps>): string[] {
  const names = deps ? allNames(deps) : sessions.getSessions().map(s => s.name)
  const send = (n: string, t: string, m: ChannelMeta) => {
    if (deps) deliver(deps, n, t, m)
    else sessions.routeToSession(n, t, m)
  }
  const pool = audienceNames ? names.filter(n => audienceNames.includes(n)) : names
  if (meta.unbound_reply) {
    const one = oneHumanTarget(deps, meta, names)
    if (!one) return []
    send(one, content, { ...meta, to: one, routed: 'dispatcher' })
    return [one]
  }
  const all = content.match(/^\s*@all(?::(synthesis|independent))?\b\s*([\s\S]*)$/i)
  if (all) {
    const mode = all[1]?.toLowerCase() === 'synthesis' ? 'synthesis' : 'independent'
    const body = all[2]?.trim() ? all[2] : content
    const ordered = orderByCost(pool, n => deps?.costs?.get(n) ?? 'standard')
    const text = mode === 'synthesis' ? `${body}\n\n(synthesis: read this channel for earlier replies before adding anything)` : body
    if (deps) deliverNamed(ordered, text, { ...meta, to: 'all', all_mode: mode }, deps)
    else for (const n of ordered) send(n, text, { ...meta, to: 'all', all_mode: mode })
    return ordered
  }
  const m = content.match(/^\s*@?([\w.@:/-]+?)[:,]?\s+([\s\S]*)$/)
  if (m) {
    const resolved = resolveExact(m[1], names)
    if (resolved.ok) {
      send(resolved.name, m[2], { ...meta, to: resolved.name })
      return [resolved.name]
    }
    const addressed = content.trim().startsWith('@') || names.some(n => n.startsWith(m[1]))
    if (addressed) {
      deps?.onRoutingError?.(resolved.error)
      return []
    }
  }
  const one = oneHumanTarget(deps, meta, names)
  if (!one) return []
  send(one, content, { ...meta, to: one, routed: 'dispatcher' })
  deps?.unread?.bump(pool.filter(n => n !== one))
  return [one]
}

async function handleChannelOp(ws: WsLike, msg: { type: string; requestId: string; channel?: string; name?: string; topic?: string; replacement?: string; session?: string }, deps: Readonly<WsDeps>): Promise<void> {
  // Admin sessions may (un)subscribe someone else (e.g. agents that lack the channel tools).
  if (msg.session && ws.data.sessionName && msg.session !== ws.data.sessionName) {
    if (!deps.admins?.has(ws.data.sessionName)) { sendToolResult(ws, msg.requestId, false, 'only admin sessions may act for another session'); return }
  }
  const me = (msg.session && deps.admins?.has(ws.data.sessionName ?? '') ? msg.session : null) ?? ws.data.sessionName
  const ops = deps.channelOps
  const subs = deps.subs
  if (!me) { sendToolResult(ws, msg.requestId, false, 'not registered'); return }
  if (!ops || !subs) { sendToolResult(ws, msg.requestId, false, 'channels disabled: router has no DISCORD_BUS_CHANNEL'); return }
  try {
    if (msg.type === 'channelList') {
      const list = await ops.list()
      const out = list.map(c => ({
        id: c.id, name: c.name, topic: c.topic ?? undefined,
        default: c.id === deps.busChannelId,
        human: c.id === deps.humanChannelId,
        subscribed: c.id === deps.busChannelId || c.id === deps.humanChannelId || subs.has(me, c.id),
        subscribers: c.id === deps.busChannelId || c.id === deps.humanChannelId ? ['(everyone)'] : subs.subscribers(c.id),
      }))
      sendToolResult(ws, msg.requestId, true, JSON.stringify(out))
      return
    }
    if (msg.type === 'channelCreate') {
      if (!msg.name) { sendToolResult(ws, msg.requestId, false, 'channel_create requires name'); return }
      const existing = await ops.resolve(msg.name)
      const ch = existing ?? await ops.create(msg.name, msg.topic)
      subs.add(me, ch.id)
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
      const moved = subs.subscribers(ch.id)
      for (const n of moved) { subs.remove(n, ch.id); if (repl) subs.add(n, repl.id) }
      sendToDiscord(deps.client, ch.id, `**${note}**`)
      sendToolResult(ws, msg.requestId, true, JSON.stringify({ ...ch, archived: true, movedSubscribers: moved, ...(repl && { replacement: repl }) }))
      return
    }
    const changed = msg.type === 'channelSubscribe' ? subs.add(me, ch.id) : subs.remove(me, ch.id)
    sendToolResult(ws, msg.requestId, true, JSON.stringify({ ...ch, subscribed: msg.type === 'channelSubscribe', changed }))
  } catch (err: unknown) {
    sendToolResult(ws, msg.requestId, false, `${msg.type} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
