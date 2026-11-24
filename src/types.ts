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
}

/** Plugin → Router: rename this session */
export interface WsRename {
  readonly type: 'rename'
  readonly name: string
}

/** Plugin → Router: send a reply to Discord */
export interface WsReply {
  readonly type: 'reply'
  readonly text: string
  /** Target channel. If it is the agent-bus channel the reply is treated as a busPost. */
  readonly chatId?: string
  readonly replyTo?: string
  readonly files?: readonly string[]
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
  readonly text: string
  /** Optional target session name; omitted = broadcast to every other session. */
  readonly to?: string
}

/** Request the list of connected sessions (answered with a toolResult). */
export interface WsListSessions {
  readonly type: 'listSessions'
  readonly requestId: string
}

/** Post to a specific Discord channel (id or name); delivered to its subscribers. */
export interface WsChannelPost {
  readonly type: 'channelPost'
  readonly channel: string
  readonly text: string
  readonly to?: string
}

/** Channel management, answered with a toolResult. */
export interface WsChannelOp {
  readonly type: 'channelList' | 'channelCreate' | 'channelSubscribe' | 'channelUnsubscribe' | 'channelArchive'
  readonly requestId: string
  readonly channel?: string
  readonly name?: string
  readonly topic?: string
  /** channelArchive: where the conversation continues. */
  readonly replacement?: string
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
}

/** Atomic task claims. */
export interface WsClaimOp {
  readonly type: 'claim' | 'releaseClaim' | 'listClaims'
  readonly requestId: string
  readonly task?: string
  readonly note?: string
  readonly to?: string
}

export type PluginToRouterMessage =
  | WsClaimOp
  | WsRegisterNode
  | WsInboxOp
  | WsChannelPost
  | WsChannelOp
  | WsBusPost
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
export type RouterToPluginMessage =
  | WsMessage
  | WsRegistered
  | WsRenamed
  | WsError
  | WsToolResult
  | WsPermissionVerdict

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
