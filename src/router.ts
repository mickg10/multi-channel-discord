#!/usr/bin/env bun
/**
 * Router — Discord bot + WS server + multi-session coordinator.
 *
 * The Discord bot receives messages and routes them to the active Claude Code
 * session via WebSocket. Claude replies flow back through the WS protocol
 * and are sent to Discord by the router.
 */

import { loadEnvFile, gate, checkApprovals, loadAccess, getStateDir } from './access.js'
import { createDiscordClient, safeAttName, TypingManager } from './discord.js'
import { SessionManager, ProjectHistory } from './sessions.js'
import { createWsHandlers, handlePermissionButton, routeHumanBusMessage, deliver as deliverFn } from './ws.js'
import type { WsData, WsLike } from './ws.js'
import { PidManager } from './pid.js'
import { registerSlashCommands, handleSlashCommand, handleAutocomplete, updateSkillCommands, isSkillCommand } from './slash-commands.js'
import type { SlashCommandDeps, SkillEntry } from './slash-commands.js'
import type { ChannelMeta } from './types.js'
import { ActivityType, ChannelType, type Message, type Guild } from 'discord.js'
import { Subscriptions } from './subscriptions.js'
import { Inboxes, NodeRegistry, Claims } from './nodes.js'
import { PassiveLog, askerFromBotPost } from './wake.js'
import { McpRegistry, Grants, McpAudit, PendingMcpCalls } from './mcp.js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join as pjoin } from 'node:path'
import type { ChannelOps } from './ws.js'

// Load token from ~/.claude/channels/discord/.env
loadEnvFile()

const TOKEN = process.env.DISCORD_BOT_TOKEN
const WS_PORT = parseInt(process.env.DISCORD_WS_PORT ?? '8789', 10)
// Interface to bind. Default localhost; set to a Tailscale IP (or 0.0.0.0) for remote sessions.
const WS_HOST = process.env.DISCORD_WS_HOST ?? '127.0.0.1'
// Shared secret plugins must send on register. Strongly recommended when WS_HOST is not localhost.
const ROUTER_SECRET = process.env.DISCORD_ROUTER_SECRET || undefined
// Discord channel used as the agent bus (agent <-> agent messages). Unset = bus disabled.
const BUS_CHANNEL = process.env.DISCORD_BUS_CHANNEL || undefined
const BUS_MAX_PER_MIN = parseInt(process.env.DISCORD_BUS_MAX_PER_MIN ?? '12', 10)
// Channel where agents' to="human" posts land (questions / approvals for the human).
const HUMAN_CHANNEL = process.env.DISCORD_HUMAN_CHANNEL || undefined
// Per-node secrets: ${STATE_DIR}/node-secrets.json = { "<node>": "<sha256 hex of its secret>" },
// re-read on every node registration (no restart needed to add or rotate one).
const REQUIRE_NODE_SECRET = process.env.DISCORD_REQUIRE_NODE_SECRET === '1'
function nodeSecretsProvider() {
  let hashes: Record<string, string> = {}
  try { hashes = JSON.parse(readFileSync(pjoin(STATE_DIR, 'node-secrets.json'), 'utf8')) } catch {}
  return { hashes, require: REQUIRE_NODE_SECRET }
}
const ADMINS = new Set((process.env.DISCORD_ADMIN_SESSIONS ?? '').split(',').map(s => s.trim()).filter(Boolean))
if (WS_HOST !== '127.0.0.1' && WS_HOST !== 'localhost' && !ROUTER_SECRET) {
  process.stderr.write('discord channel: refusing to bind non-localhost without DISCORD_ROUTER_SECRET\n')
  process.exit(1)
}
const STATE_DIR = getStateDir()

if (!TOKEN) {
  const envFile = `${STATE_DIR}/.env`
  process.stderr.write(
    `discord channel: DISCORD_BOT_TOKEN required\n` +
    `  set in ${envFile}\n` +
    `  format: DISCORD_BOT_TOKEN=MTIz...\n`,
  )
  process.exit(1)
}

// ============================================================
// Discord client
// ============================================================

const client = createDiscordClient()

// Safety nets
process.on('unhandledRejection', (err: unknown) => {
  process.stderr.write(`discord channel: unhandled rejection: ${err instanceof Error ? err.message : String(err)}\n`)
})
process.on('uncaughtException', (err: unknown) => {
  process.stderr.write(`discord channel: uncaught exception: ${err instanceof Error ? err.message : String(err)}\n`)
})

// ============================================================
// Session management
// ============================================================

const sessions = new SessionManager()
const history = new ProjectHistory()
const startedAt = Date.now()

let activeChatId: string | null = null

// ============================================================
// Persistent typing indicator (Feature 2)
// ============================================================

const typingManager = new TypingManager(client)

// ============================================================
// Bot presence status (Feature 4)
// ============================================================

function updatePresence(): void {
  if (!client.user) return
  const sessionList = sessions.getSessions()
  const count = sessionList.length
  const active = sessions.getActive()

  if (count === 0) {
    client.user.setPresence({
      activities: [{ name: 'No sessions', type: ActivityType.Custom }],
      status: 'idle',
    })
  } else if (active) {
    client.user.setPresence({
      activities: [{ name: `Working on: ${active} (${count} session${count === 1 ? '' : 's'})`, type: ActivityType.Custom }],
      status: 'online',
    })
  } else {
    client.user.setPresence({
      activities: [{ name: `${count} session${count === 1 ? '' : 's'} connected`, type: ActivityType.Custom }],
      status: 'online',
    })
  }
}

// ============================================================
// WebSocket server for Claude Code plugins
// ============================================================

const access = loadAccess()

// ============================================================
// Agent-bus channels (guild = the bus channel's server)
// ============================================================

const subs = Subscriptions.inStateDir(STATE_DIR)
const inboxes = Inboxes.inStateDir(STATE_DIR)
const nodes = new NodeRegistry()
const claims = Claims.inStateDir(STATE_DIR)

// Remote MCP over the bus: git-declared registry (MCP_REGISTRY or state dir), runtime in state dir.
// A missing registry file = feature present but empty (mcp_list returns []); a malformed file
// fails startup closed — a broken declaration must not silently widen admission.
const MCP_REGISTRY_FILE = process.env.MCP_REGISTRY ?? pjoin(STATE_DIR, 'mcp-registry.json')
const mcpRegistry = McpRegistry.fromFileOrNull(MCP_REGISTRY_FILE)
const mcp = mcpRegistry && {
  registry: mcpRegistry,
  grants: Grants.inStateDir(STATE_DIR),
  audit: McpAudit.inStateDir(STATE_DIR),
  pending: new PendingMcpCalls(Number(process.env.MCP_CALL_TIMEOUT_MS ?? 30_000)),
}

// Rules of comms: ${STATE_DIR}/rules.md, delivered once per session name per rules version.
const RULES_FILE = pjoin(STATE_DIR, 'rules.md')
const RULES_SEEN = pjoin(STATE_DIR, 'rules-seen.json')
function rulesProvider() {
  if (!existsSync(RULES_FILE)) return null
  let text = ''
  try { text = readFileSync(RULES_FILE, 'utf8').trim() } catch { return null }
  if (!text) return null
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12)
  let seen: Record<string, string> = {}
  try { seen = JSON.parse(readFileSync(RULES_SEEN, 'utf8')) } catch {}
  return {
    text: `${text}\n\n(rules v${hash} — sent once by the router; also in the #general topic)`,
    seen: (name: string) => seen[name] === hash,
    markSeen: (name: string) => { seen[name] = hash; try { writeFileSync(RULES_SEEN, JSON.stringify(seen, null, 2)) } catch {} },
  }
}

async function busGuild(): Promise<Guild> {
  if (!BUS_CHANNEL) throw new Error('bus disabled')
  const ch = await client.channels.fetch(BUS_CHANNEL)
  if (!ch || !('guild' in ch) || !ch.guild) throw new Error('bus channel is not in a server')
  return ch.guild
}

// Guild channels come from discord.js's gateway-maintained cache (Guilds intent keeps it current
// on create/update/delete). Hitting REST on every channel op exhausted Discord's per-route
// rate limit (10/window) once several agents used channels, so tool calls queued and timed out.
let lastChannelFetch = 0
type ChanInfo = { id: string; name: string; type: ChannelType; topic: string | null }
async function guildChannels(guild: Guild, forceRefresh = false): Promise<ChanInfo[]> {
  const fresh = guild.channels.cache.size === 0 || (forceRefresh && Date.now() - lastChannelFetch > 30_000)
  if (fresh) { lastChannelFetch = Date.now(); await guild.channels.fetch() }
  return [...guild.channels.cache.values()].map(c => ({
    id: c.id, name: c.name, type: c.type, topic: 'topic' in c ? (c as { topic: string | null }).topic : null,
  }))
}

const channelOps: ChannelOps = {
  async resolve(ref: string) {
    const guild = await busGuild()
    const want = ref.replace(/^<#(\d+)>$/, '$1').replace(/^#/, '').trim()
    const match = (all: ChanInfo[]) =>
      all.find(c => c.type === ChannelType.GuildText && (c.id === want || c.name === want.toLowerCase()))
    // Cache miss (e.g. a channel created seconds ago): one rate-limited refresh at most.
    const hit = match(await guildChannels(guild)) ?? match(await guildChannels(guild, true))
    return hit ? { id: hit.id, name: hit.name } : null
  },
  async list() {
    const guild = await busGuild()
    return (await guildChannels(guild))
      .filter(c => c.type === ChannelType.GuildText)
      .map(c => ({ id: c.id, name: c.name, topic: c.topic }))
  },
  async create(name: string, topic?: string) {
    const guild = await busGuild()
    const bus = await client.channels.fetch(BUS_CHANNEL!)
    const parent = bus && 'parentId' in bus ? bus.parentId ?? undefined : undefined
    const ch = await guild.channels.create({
      name: name.replace(/^#/, ''),
      type: ChannelType.GuildText,
      ...(topic && { topic }),
      ...(parent && { parent }),
      reason: 'agent-bus channel_create',
    })
    return { id: ch.id, name: ch.name }
  },
  async archive(id: string, topic: string) {
    const guild = await busGuild()
    const catInfo = (await guildChannels(guild)).find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'archive')
    const cat = catInfo ?? await guild.channels.create({ name: 'archive', type: ChannelType.GuildCategory, reason: 'agent-bus channel_archive' })
    const ch = guild.channels.cache.get(id) ?? await guild.channels.fetch(id)
    if (ch && ch.type === ChannelType.GuildText) {
      await ch.edit({ parent: cat!.id, topic: topic.slice(0, 1000), reason: 'agent-bus channel_archive' })
    }
  },
}

let wsDepsRef: Parameters<typeof createWsHandlers>[0]
function deliverTo(name: string, text: string, meta: ChannelMeta): void { deliverFn(wsDepsRef, name, text, meta) }
const wsHandlers = createWsHandlers(wsDepsRef = {
  sessions,
  history,
  client,
  chatId: () => activeChatId,
  chunkLimit: Math.min(access.textChunkLimit ?? 2000, 2000),
  chunkMode: access.chunkMode ?? 'length',
  replyToMode: access.replyToMode ?? 'first',
  onReply: (chatId: string) => typingManager.stop(chatId),
  onSessionChange: () => updatePresence(),
  busChannelId: BUS_CHANNEL,
  secret: ROUTER_SECRET,
  busMaxPerMinute: BUS_MAX_PER_MIN,
  subs: BUS_CHANNEL ? subs : undefined,
  channelOps: BUS_CHANNEL ? channelOps : undefined,
  inboxes,
  nodes,
  claims,
  passive: new PassiveLog(),
  dispatcher: process.env.DISCORD_DISPATCHER || undefined,
  mcp: mcp ?? undefined,
  admins: ADMINS,
  nodeSecrets: nodeSecretsProvider,
  humanChannelId: HUMAN_CHANNEL,
  rules: rulesProvider,
  onSkillsRegistered: (skills: readonly SkillEntry[]) => {
    updateSkillCommands(client, skills).catch((err: unknown) => {
      process.stderr.write(`discord channel: skill command registration failed: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  },
})

/** Adapter to bridge Bun's ServerWebSocket to the WsLike interface used by handlers. */
interface BunServerWebSocket {
  data: WsData
  send(msg: string | ArrayBufferLike | Uint8Array): number
}

function toBunWsLike(ws: BunServerWebSocket): WsLike {
  return {
    data: ws.data,
    send(msg: string) { ws.send(msg) },
  }
}

const wsServer = Bun.serve<WsData>({
  port: WS_PORT,
  hostname: WS_HOST,
  fetch(req, server) {
    const upgraded = server.upgrade(req, {
      data: { sessionName: null, sendCallback: null, authed: false },
    })
    if (!upgraded) {
      return new Response('WebSocket upgrade required', { status: 426 })
    }
    return undefined as unknown as Response
  },
  websocket: {
    // Inline attachments (base64) can be several MB.
    maxPayloadLength: 64 * 1024 * 1024,
    open(ws) {
      wsHandlers.open(toBunWsLike(ws))
    },
    message(ws, msg) {
      wsHandlers.message(toBunWsLike(ws), msg as string | Buffer)
    },
    close(ws) {
      wsHandlers.close(toBunWsLike(ws))
    },
  },
})

process.stderr.write(`discord channel: WS server listening on ${WS_HOST}:${WS_PORT} (auth=${ROUTER_SECRET ? 'secret' : 'none'}, bus=${BUS_CHANNEL ?? 'off'}, human=${HUMAN_CHANNEL ?? 'off'})\n`)

// ============================================================
// PID management
// ============================================================

const pidManager = new PidManager()
await pidManager.write()

// ============================================================
// Slash command dependencies
// ============================================================

const slashDeps: SlashCommandDeps = {
  sessions,
  history,
  startedAt,
}

// ============================================================
// Inbound message handler
// ============================================================

async function handleBusInbound(msg: Message): Promise<void> {
  // Only allowlisted humans may address agents on the bus.
  const acc = loadAccess()
  if (!acc.allowFrom.includes(msg.author.id)) {
    process.stderr.write(`discord: bus message from non-allowlisted ${msg.author.username} dropped\n`)
    return
  }
  const atts = [...msg.attachments.values()].map(a => `${safeAttName(a.name ?? a.id, a.id)} (${a.contentType ?? 'unknown'}, ${(a.size / 1024).toFixed(0)}KB)`)
  const content = msg.content.replace(/<@!?\d+>\s*/g, '').trim() || (atts.length ? '(attachment — use download_attachment)' : '')
  if (!content) return
  const meta: ChannelMeta = {
    ...(atts.length && { attachments: atts.join('; '), attachment_count: String(atts.length) }),
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    source: 'agent-bus',
    from: msg.author.username,
    from_human: 'true',
    ts: msg.createdAt.toISOString(),
  }
  let channelName: string | undefined
  try { channelName = 'name' in msg.channel ? (msg.channel as { name: string }).name : undefined } catch {}
  const fullMeta: ChannelMeta = { ...meta, ...(channelName && { channel: channelName }) }
  // A Discord reply is an approval of that question only. It wakes the asker, or nobody.
  let delivered: string[] = []
  if (msg.reference?.messageId) {
    const questionId = msg.reference.messageId
    try {
      const ref = await msg.channel.messages.fetch(questionId)
      const asker = ref.author.id === client.user?.id ? askerFromBotPost(ref.content) : null
      const known = asker !== null && (sessions.getSessions().some(s => s.name === asker) || nodes.get(asker))
      if (asker && known) {
        deliverTo(asker, content, { ...fullMeta, to: asker, in_reply_to: questionId, question_id: questionId, wake: '1' })
        delivered = [asker]
      } else {
        await msg.reply(`Reply ${questionId} is not bound to one connected session. Not sent.`).catch(() => {})
        return
      }
    } catch {
      await msg.reply(`Could not bind reply to question ${questionId}. Not sent.`).catch(() => {})
      return
    }
  }
  if (delivered.length === 0) {
    const everyone = msg.channelId === BUS_CHANNEL || msg.channelId === HUMAN_CHANNEL
    delivered = routeHumanBusMessage(content, fullMeta, sessions, everyone ? undefined : subs.subscribers(msg.channelId), wsDepsRef)
  }
  process.stderr.write(`discord: bus message from ${msg.author.username} -> ${delivered.join(',') || '(no wake)'}\n`)
  const anySession = sessions.getSessions().length > 0 || nodes.list().length > 0
  if (delivered.length === 0 && !anySession) {
    await msg.reply('No agent sessions are connected.').catch(() => {})
  } else {
    void msg.react('📨').catch(() => {})
  }
}

async function handleInbound(msg: Message): Promise<void> {
  if (BUS_CHANNEL && (msg.channelId === BUS_CHANNEL || msg.channelId === HUMAN_CHANNEL || subs.channels().has(msg.channelId))) return handleBusInbound(msg)
  process.stderr.write(`discord: inbound from ${msg.author.username}: "${msg.content.slice(0, 50)}" action=`)
  const result = await gate(msg)
  process.stderr.write(`${result.action}\n`)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      await msg.reply(`${lead} — run in Claude Code:\n\n/discord:access pair ${result.code}`)
    } catch (err: unknown) {
      process.stderr.write(`discord channel: failed to send pairing code: ${err instanceof Error ? err.message : String(err)}\n`)
    }
    return
  }

  const accessConfig = result.access

  // Track the active chat
  activeChatId = msg.channelId

  // Start persistent typing indicator (refreshes every 8s until reply)
  typingManager.start(msg.channelId)

  // Ack reaction
  if (accessConfig.ackReaction) {
    void msg.react(accessConfig.ackReaction).catch(() => {})
  }

  // Build attachment metadata
  const atts: string[] = []
  for (const att of msg.attachments.values()) {
    const kb = (att.size / 1024).toFixed(0)
    atts.push(`${safeAttName(att.name ?? att.id, att.id)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
  }

  const content = msg.content || (atts.length > 0 ? '(attachment)' : '')

  // Route to active session
  const meta: ChannelMeta = {
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: msg.author.id,
    ts: msg.createdAt.toISOString(),
    ...(atts.length > 0 ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
  }

  const activeSession = sessions.getActive()
  process.stderr.write(`discord: routing to active="${activeSession}" sessions=${sessions.getSessions().map(s=>s.name).join(',')}\n`)
  const routed = sessions.routeToActive(content, meta)
  process.stderr.write(`discord: routed=${routed}\n`)
  if (!routed) {
    try {
      await msg.reply('No active session. Connect Claude Code with this plugin, or use `/switch` to activate a session.')
    } catch {}
  }
}

// ============================================================
// Event handlers
// ============================================================

client.on('error', (err: Error) => {
  process.stderr.write(`discord channel: client error: ${err.message}\n`)
})

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  handleInbound(msg).catch((e: unknown) => process.stderr.write(`discord: handleInbound failed: ${e instanceof Error ? e.message : String(e)}\n`))
})

client.on('interactionCreate', interaction => {
  if (interaction.isAutocomplete()) {
    handleAutocomplete(interaction, slashDeps)
    return
  }
  if (interaction.isChatInputCommand()) {
    handleSlashCommand(interaction, slashDeps).then(() => {
      // Update presence after slash commands that may change sessions
      if (['switch', 'kill'].includes(interaction.commandName)) {
        updatePresence()
      }
    }).catch((e: unknown) =>
      process.stderr.write(`discord: slash command failed: ${e instanceof Error ? e.message : String(e)}\n`),
    )
    return
  }
  // Handle permission button clicks
  if (interaction.isButton()) {
    const customId = interaction.customId
    if (customId.startsWith('perm_yes_') || customId.startsWith('perm_no_')) {
      const isAllow = customId.startsWith('perm_yes_')
      const requestId = customId.replace(/^perm_(yes|no)_/, '')
      handlePermissionButton(customId)
      interaction.update({
        content: interaction.message.content + `\n\n> **${isAllow ? 'Allowed' : 'Denied'}**`,
        components: [],
      }).catch((e: unknown) => process.stderr.write(`discord: permission button update failed: ${e instanceof Error ? e.message : String(e)}\n`))
    }
  }
})

client.once('clientReady', c => {
  process.stderr.write(`discord channel: gateway connected as ${c.user.tag}\n`)
  registerSlashCommands(c).catch((e: unknown) =>
    process.stderr.write(`discord: registerSlashCommands failed: ${e instanceof Error ? e.message : String(e)}\n`),
  )
  updatePresence()
})

// Poll for pairing approvals
setInterval(() => checkApprovals(client), 5000).unref()

// Periodic buffer persistence
const bufferInterval = setInterval(() => {
  sessions.saveBuffers().catch(() => {})
}, 30_000)

// ============================================================
// Shutdown
// ============================================================

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('discord channel: shutting down\n')
  clearInterval(bufferInterval)
  // Clear all typing intervals
  typingManager.stopAll()
  try {
    await history.save()
    await sessions.saveBuffers()
    await pidManager.remove()
  } catch {}
  wsServer.stop()
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000)
}

process.on('SIGTERM', () => { shutdown() })
process.on('SIGINT', () => { shutdown() })

// Load persisted state
await history.load()
await sessions.loadBuffers()

// ============================================================
// Start
// ============================================================

client.login(TOKEN).catch((err: unknown) => {
  process.stderr.write(`discord channel: login failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
