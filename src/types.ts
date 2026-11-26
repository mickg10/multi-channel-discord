import { createHash } from 'node:crypto'

// ============================================================
// WebSocket Protocol — messages between MCP plugin and router
// ============================================================

/** Metadata attached to routed messages (Discord context). */
export type ChannelMeta = Readonly<Record<string, string | undefined>> & {
  readonly chat_id?: string
  readonly message_id?: string
  readonly user?: string
  readonly user_id?: string
  readonly ts?: string
  readonly attachment_count?: string
  readonly attachments?: string
  readonly type?: string
}

/** Plugin → Router: register this session */
export interface WsRegister {
  readonly type: 'register'
  readonly name: string
  /** Declared local host label, pinned for renames in this legacy connection. */
  readonly host?: string
  readonly projectPath: string
  /** Parent PID of the Claude Code process. Used to dedup multiple MCP spawns
   *  from the same instance while keeping separate instances as separate sessions. */
  readonly instanceId?: string
  /** Shared secret; required when the router sets DISCORD_ROUTER_SECRET. */
  readonly secret?: string
  /** 'pull' = cannot receive pushes; messages are queued for check_inbox. Default 'push'. */
  readonly mode?: 'push' | 'pull'
  /** Replace an existing session with this name instead of getting a "-2" suffix. */
  readonly takeover?: boolean
  /** cheap | standard | premium. Omitted = standard. Used to order and budget cold wakes. */
  readonly costClass?: 'cheap' | 'standard' | 'premium'
  /** Stable id of this conversation. A reused display name with a different id does not inherit held approvals. */
  readonly conversationId?: string
}

/** Plugin → Router: rename this session */
export interface WsRename {
  readonly type: 'rename'
  readonly requestId?: string
  readonly name: string
}

/** Plugin → Router: send a reply to Discord */
export interface WsReply {
  readonly type: 'reply'
  readonly requestId?: string
  readonly text: string
  /** Target channel. If it is the agent-bus channel the reply is treated as a busPost. */
  readonly chatId?: string
  readonly replyTo?: string
  /** Inline files {name, data: base64}. Bare paths are rejected by remote routers. */
  readonly files?: ReadonlyArray<string | { readonly name: string; readonly data: string }>
}

/** Plugin → Router: react to a Discord message */
export interface WsReact {
  readonly type: 'react'
  readonly chatId: string
  readonly messageId: string
  readonly emoji: string
}

/** Plugin → Router: edit a previously sent message */
export interface WsEditMessage {
  readonly type: 'editMessage'
  readonly requestId: string
  readonly chatId: string
  readonly messageId: string
  readonly text: string
}

/** Plugin → Router: download attachments from a message */
export interface WsDownloadAttachment {
  readonly type: 'downloadAttachment'
  readonly requestId: string
  readonly chatId: string
  readonly messageId: string
}

/** Plugin → Router: fetch recent messages from a channel */
export interface WsFetchMessages {
  readonly type: 'fetchMessages'
  readonly requestId: string
  readonly channel: string
  readonly limit?: number
}

/** Plugin → Router: send an interactive question with select menu or buttons */
export interface WsAskUser {
  readonly type: 'askUser'
  readonly requestId: string
  readonly chatId: string
  readonly question: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string; readonly value: string }>
}

/** Plugin → Router: deregister this session */
export interface WsDeregister {
  readonly type: 'deregister'
}

/** Plugin → Router: register discovered skills as slash commands */
export interface WsRegisterSkills {
  readonly type: 'registerSkills'
  readonly skills: ReadonlyArray<{ readonly name: string; readonly description: string }>
}

/** Plugin → Router: forward a permission prompt from Claude Code */
export interface WsPermissionRequest {
  readonly type: 'permissionRequest'
  readonly requestId: string  // 5 lowercase letter ID from Claude Code
  readonly toolName: string
  readonly description: string
  readonly inputPreview: string
}

/** Union of all messages a plugin can send to the router */
/** Post to the shared agent bus channel and fan out to other sessions. */
export interface WsBusPost {
  readonly type: 'busPost'
  readonly requestId?: string
  readonly publish_id?: string
  readonly text: string
  /** Exact session, "human", or "all". Omitted mirrors the post and wakes nobody. */
  readonly to?: string
}

/** Dispatcher only: re-deliver a stored human message to these exact sessions. */
export interface WsDispatch {
  readonly type: 'dispatch'
  readonly requestId: string
  readonly messageId: string
  readonly to: readonly string[]
}

/** Request the list of connected sessions (answered with a toolResult). */
export interface WsListSessions {
  readonly type: 'listSessions'
  readonly requestId: string
}

/** Post to a specific Discord channel (id or name); delivered to its subscribers. */
export interface WsChannelPost {
  readonly type: 'channelPost'
  readonly requestId?: string
  readonly publish_id?: string
  readonly files?: WsReply['files']
  readonly channel: string
  readonly text: string
  readonly to?: string
}

export const CHANNEL_TOPIC_MAX = 1024

/** Channel management, answered with a toolResult. */
export interface WsChannelOp {
  readonly type: 'channelList' | 'channelCreate' | 'channelSubscribe' | 'channelUnsubscribe' | 'channelArchive' | 'channelSetTopic'
  readonly requestId: string
  readonly channel?: string
  readonly name?: string
  readonly topic?: string
  /** channelArchive: where the conversation continues. */
  readonly replacement?: string
  /** Admin only: act on behalf of this session (subscribe/unsubscribe). */
  readonly session?: string
}

/** A per-machine node daemon announcing the headless agents it runs. */
export interface WsRegisterNode {
  readonly type: 'registerNode'
  readonly node: string
  readonly secret?: string
  readonly agents: ReadonlyArray<{ readonly name: string; readonly kind: string; readonly cwd?: string }>
}

/** Pull (and clear) this session's durable inbox, or (node) count another agent's. */
export interface WsInboxOp {
  readonly type: 'inboxPull' | 'inboxCount' | 'agentStatus'
  readonly requestId: string
  readonly agent?: string
  /** New clients: return { messages, unread } instead of a bare array. */
  readonly withUnread?: boolean
}

/** Atomic task claims. */
export interface WsClaimOp {
  readonly type: 'claim' | 'releaseClaim' | 'listClaims'
  readonly requestId: string
  readonly task?: string
  readonly note?: string
  readonly to?: string
}

/** Remote MCP access over the bus (option 4: tunnelled, no new ports).
 *  Round one is read-only: side-effecting servers require a grant ID and none are issued. */
export interface WsMcpOp {
  readonly type: 'mcpList' | 'mcpDescribe' | 'mcpCall'
  readonly requestId: string
  readonly server?: string
  /** Tool name for mcpCall. */
  readonly method?: string
  /** Tool arguments (JSON) for mcpCall. */
  readonly params?: unknown
  /** Mick-issued grant ID; required for side-effecting servers. */
  readonly grant?: string
}

/** Node → Router: result of an mcpExec the router forwarded to that node.
 *  callId is router-minted; results are accepted only from the node the call was sent to. */
export interface WsNodeMcpResult {
  readonly type: 'mcpResult'
  readonly callId: string
  readonly success: boolean
  readonly data: string
}

export type PluginToRouterMessage =
  | WsMcpOp
  | WsNodeMcpResult
  | WsClaimOp
  | WsRegisterNode
  | WsInboxOp
  | WsChannelPost
  | WsChannelOp
  | WsBusPost
  | WsDispatch
  | WsListSessions
  | WsRegister
  | WsRename
  | WsReply
  | WsReact
  | WsEditMessage
  | WsDownloadAttachment
  | WsFetchMessages
  | WsAskUser
  | WsDeregister
  | WsPermissionRequest
  | WsRegisterSkills

// ============================================================
// Router → Plugin messages
// ============================================================

/** Router → Plugin: inbound Discord message for this session */
export interface WsMessage {
  readonly type: 'message'
  readonly content: string
  readonly meta: ChannelMeta
}

/** Router → Plugin: confirms registration */
export interface WsRegistered {
  readonly type: 'registered'
  readonly name: string
}

/** Router → Plugin: confirms rename */
export interface WsRenamed {
  readonly type: 'renamed'
  readonly requestId?: string
  readonly oldName: string
  readonly newName: string
}

/** Router → Plugin: error response */
export interface WsError {
  readonly type: 'error'
  readonly message: string
}

/** Router → Plugin: result of a tool call (edit, download, fetch) */
export interface WsToolResult {
  readonly type: 'toolResult'
  readonly requestId: string
  readonly success: boolean
  readonly data: string
}

/** Router → Plugin: user clicked a permission button */
export interface WsPermissionVerdict {
  readonly type: 'permissionVerdict'
  readonly requestId: string
  readonly behavior: 'allow' | 'deny'
}

/** Union of all messages the router can send to a plugin */
/** Router → plugin: another connection took over this session name; retire. */
export interface WsReplaced {
  readonly type: 'replaced'
  readonly name: string
}

export type RouterToPluginMessage =
  | WsReplaced
  | WsMessage
  | WsRegistered
  | WsRenamed
  | WsError
  | WsToolResult
  | WsPermissionVerdict
  | ({ type: 'published' } & PublishResult)

// ============================================================
// Session management
// ============================================================

/** A connected Claude Code instance in the routing table */
export interface SessionEntry {
  readonly name: string
  readonly projectPath: string
  readonly connectedAt: number
  readonly messageCount: number
}

/** A buffered message waiting to be flushed */
export interface BufferedMessage {
  readonly text: string
  readonly timestamp: number
  readonly sessionName: string
  readonly meta: ChannelMeta
}

/** A project that has been used with Claude Code */
export interface ProjectHistoryEntry {
  readonly path: string
  readonly lastUsed: number
  readonly name: string
}

// Native gateway protocol (v1).
export type Kind = 'claude' | 'codex' | 'opencode' | 'grok' | 'agy'
export function nudgeText(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Invalid nudge id')
  return `[agent-bus] mail waiting (id ${n}) — call check_inbox`
}

export interface Target {
  readonly host: string
  readonly user: string
  readonly kind: Kind
  readonly conv: string
  readonly alias: string
}

export type Nudge = { msgId: string; text: string; clientId: string }

export function buildNudge(kind: Kind, conv: string, msgId: string, n: number): Nudge {
  if (typeof msgId !== 'string' || !msgId) throw new TypeError('Invalid bus message id')
  const hash = createHash('sha256').update(`${conv}:${msgId}`).digest('hex')
  const clientId = kind === 'codex' ? 'bus-' + hash.slice(0, 32)
    : kind === 'opencode' ? 'msg_bus' + hash.slice(0, 24)
    : hash.slice(0, 32)
  return { msgId, text: nudgeText(n), clientId }
}
export type WakeResult =
  | { s: 'woken'; nativeId: string }
  | { s: 'held' | 'refused' | 'uncertain' | 'unavailable' }

export interface Adapter {
  kind: Kind
  probe(t: Target): Promise<{ ok: boolean }>
  wake(t: Target, n: Nudge): Promise<WakeResult>
  reconcile(t: Target, n: Nudge): Promise<WakeResult>
}

export type WakeState = 'committed' | 'leased' | WakeResult['s']

export interface LeasedMessage {
  readonly id: string
  readonly leaseId: string
  readonly body: string
  readonly from: string
  readonly from_human: boolean
  readonly state: WakeState
  readonly meta: ChannelMeta
}

export interface LeaseResult {
  readonly messages: readonly LeasedMessage[]
  readonly receipt?: string
  readonly receipt_status?: 'stale'
  readonly unread: number
}

export interface PublishResult {
  readonly publish_id: string
  readonly committed: readonly string[]
  readonly mirror?: 'failed'
  readonly copy?: 'failed'
}

type ForwardedGatewayCall =
  | (Omit<WsChannelPost, 'type'> & { op: 'channelPost' })
  | (Omit<WsReply, 'type'> & { op: 'reply' })
  | (Omit<WsFetchMessages, 'type'> & { op: 'fetchMessages' })
  | { op: 'busSessions' }
  | (Omit<WsClaimOp, 'type'> & { op: WsClaimOp['type'] })
  | (Omit<WsMcpOp, 'type'> & { op: WsMcpOp['type'] })
  | { op: 'channelList' | 'channelSubscribe'; channel?: string; session?: string }
  | { op: 'channelSetTopic'; channel: string; topic: string }

export type GatewayToolCall = ForwardedGatewayCall & {
  type: 'gatewayOp'
  as: string
  requestId: string
}

export type GatewayToRouterMessage =
  | GatewayToolCall
  | { type: 'registerGateway'; host: string; user: string; proto: 1; secret: string; requestId?: string }
  | { type: 'registerAgent'; kind: Kind; conv: string; alias: string; host?: string; requestId?: string }
  | { type: 'releaseAgent'; alias: string; requestId?: string }
  | { type: 'agentStatus'; as: string; requestId: string }
  | { type: 'lease'; as: string; requestId: string; receipt?: string }
  | { type: 'ack'; as: string; requestId: string; leaseId: string; id: string; receipt: string }
  | { type: 'mark'; as: string; requestId: string; id: string; state: 'uncertain' }
  | { type: 'wakeResult'; as: string; requestId: string; id: string; result: WakeResult }
  | (WsBusPost & { as: string; requestId: string })

export type RouterToGatewayMessage =
  | { type: 'gatewayRegistered'; host: string; user: string; proto: 1 }
  | { type: 'agentRegistered'; as: string; target: Target }
  | { type: 'agentReleased'; alias: string }
  | { type: 'replaced'; name: string }
  | { type: 'wake'; as: string; msgId: string; n: number; reconcile?: true }
  | WsToolResult | WsError
