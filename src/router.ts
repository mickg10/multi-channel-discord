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
import { NameLeases } from './name-leases.js'
import { createWsHandlers, handlePermissionButton, routeHumanBusMessage, channelSubscribers, directChannelOwner, onlineBusAgent, inboxError, deliver as deliverFn, applySwarmConfigReload } from './ws.js'
import { SwarmConfig } from './swarm-config.js'
import { SwarmJournal } from './swarm-journal.js'
import { Activity, Conversations, CostClasses, HumanMail, Unread, WakeBudget } from './wake.js'
import { AgentChannels, agentChannelSlug, agentChannelTopic, type AgentChannelOps } from './agent-channels.js'
import type { WsData, WsLike } from './ws.js'
import { PidManager } from './pid.js'
import { registerSlashCommands, handleSlashCommand, handleAutocomplete, updateSkillCommands, isSkillCommand } from './slash-commands.js'
import type { SlashCommandDeps, SkillEntry } from './slash-commands.js'
import type { ChannelMeta } from './types.js'
import { ActivityType, ChannelType, type Message, type Guild } from 'discord.js'
import { Subscriptions } from './subscriptions.js'
import { Inboxes, NodeRegistry, Claims } from './nodes.js'
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
function gatewayAliasHostsProvider(): Readonly<Record<string, string>> {
  try {
    const owners: unknown = JSON.parse(readFileSync(pjoin(STATE_DIR, 'gateway-alias-hosts.json'), 'utf8'))
    if (owners && typeof owners === 'object' && !Array.isArray(owners)) return owners as Record<string, string>
  } catch { /* Bare gateway aliases fail closed without a configured owner. */ }
  return {}
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

const sessions = new SessionManager(NameLeases.inStateDir(STATE_DIR))
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
const unread = new Unread()
const costs = new CostClasses()
const activity = new Activity()
const wakeBudget = new WakeBudget({
  cheap: parseInt(process.env.DISCORD_WAKE_BUDGET_CHEAP ?? '1000', 10),
  standard: parseInt(process.env.DISCORD_WAKE_BUDGET_STANDARD ?? '120', 10),
  premium: parseInt(process.env.DISCORD_WAKE_BUDGET_PREMIUM ?? '30', 10),
})
// channelId=session,channelId=session. Owner receives untargeted human posts when the dispatcher is offline.
const channelOwners = new Map<string, string>()
for (const pair of (process.env.DISCORD_CHANNEL_OWNERS ?? '').split(',')) {
  const [id, owner] = pair.split('=').map(s => s.trim())
  if (id && owner) channelOwners.set(id, owner)
}

const agentChannels = BUS_CHANNEL ? new AgentChannels(STATE_DIR, Date.now(), channelOwners) : undefined

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
type ChanInfo = { id: string; name: string; type: ChannelType; topic: string | null; parentId: string | null }
async function guildChannels(guild: Guild, forceRefresh = false): Promise<ChanInfo[]> {
  const fresh = guild.channels.cache.size === 0 || (forceRefresh && Date.now() - lastChannelFetch > 30_000)
  if (fresh) { lastChannelFetch = Date.now(); await guild.channels.fetch() }
  return [...guild.channels.cache.values()].map(c => ({
    id: c.id, name: c.name, type: c.type, topic: 'topic' in c ? (c as { topic: string | null }).topic : null,
    parentId: 'parentId' in c ? c.parentId : null,
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

const ACTIVE_AGENT_CATEGORY = 'Agents'
const ARCHIVED_AGENT_CATEGORY = 'Agents (archived)'

function agentCategory(name: string, base: string): boolean {
  return name === base || (name.startsWith(base + ' ') && /^\d+$/.test(name.slice(base.length + 1)))
}

async function agentCategoryId(guild: Guild, categories: ChanInfo[], base: string, currentParent?: string | null): Promise<string> {
  // Discord limits each category to 50 channels.
  const matching = categories.filter(c => c.type === ChannelType.GuildCategory && agentCategory(c.name, base))
  const current = matching.find(c => c.id === currentParent)
  if (current) return current.id
  const available = matching.find(c => categories.filter(child => child.parentId === c.id).length < 50)
  if (available) return available.id
  let suffix = 1
  let name = base
  while (matching.some(c => c.name === name)) name = `${base} ${++suffix}`
  return (await guild.channels.create({ type: ChannelType.GuildCategory, name, reason: 'agent-bus direct channels' })).id
}

const agentChannelOps: AgentChannelOps = {
  async ensure(info) {
    const guild = await busGuild()
    const channels = await guildChannels(guild)
    const categoryIds = new Set(channels.filter(c => c.type === ChannelType.GuildCategory &&
      (agentCategory(c.name, ACTIVE_AGENT_CATEGORY) || agentCategory(c.name, ARCHIVED_AGENT_CATEGORY))).map(c => c.id))
    const existing = channels.find(c => c.type === ChannelType.GuildText && c.parentId && categoryIds.has(c.parentId) &&
      c.name.startsWith('a-') && c.topic?.startsWith(`Direct line to ${info.name} (`))
    if (existing) {
      await this.update(existing.id, info, false)
      return existing.id
    }
    const parent = await agentCategoryId(guild, channels, ACTIVE_AGENT_CATEGORY)
    const slug = agentChannelSlug(info.name)
    const name = channels.some(c => c.name === slug) ? agentChannelSlug(info.name, true) : slug
    const created = await guild.channels.create({
      name, type: ChannelType.GuildText, parent, topic: agentChannelTopic(info), reason: 'agent-bus direct channel provision',
    })
    return created.id
  },
  async update(id, info, archived) {
    const guild = await busGuild()
    const channel = guild.channels.cache.get(id) ?? await guild.channels.fetch(id)
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error('direct channel is unavailable')
    const channels = await guildChannels(guild)
    const parent = await agentCategoryId(guild, channels, archived ? ARCHIVED_AGENT_CATEGORY : ACTIVE_AGENT_CATEGORY, channel.parentId)
    const slug = agentChannelSlug(info.name)
    const name = channels.some(c => c.id !== id && c.name === slug) ? agentChannelSlug(info.name, true) : slug
    const updated = await channel.edit({
      name, parent, topic: agentChannelTopic(info),
      reason: archived ? 'agent-bus idle direct channel archive' : 'agent-bus direct channel registration',
    })
    guild.channels.cache.set(id, updated)
  },
}

let wsDepsRef: Parameters<typeof createWsHandlers>[0]
let routeError: string | undefined
let routeNote: string | undefined
const humanMail = new HumanMail()
const conversations = new Conversations()
const swarmConfig = SwarmConfig.inStateDir(STATE_DIR)
const swarmJournal = SwarmJournal.inStateDir(STATE_DIR)
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
  mcp: mcp ?? undefined,
  admins: ADMINS,
  nodeSecrets: nodeSecretsProvider,
  gatewayAliasHosts: gatewayAliasHostsProvider,
  humanChannelId: HUMAN_CHANNEL,
  rules: rulesProvider,
  unread,
  costs,
  activity,
  budget: wakeBudget,
  dispatcher: process.env.DISCORD_DISPATCHER || undefined,
  channelOwners,
  agentChannels,
  staggerMs: parseInt(process.env.DISCORD_ALL_STAGGER_MS ?? '0', 10),
  onRoutingError: (message: string) => { routeError = message },
  onRouteNote: (message: string) => { routeNote = message },
  humanMail,
  conversations,
  swarmConfig,
  swarmJournal,
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
  close(): void
}

function toBunWsLike(ws: BunServerWebSocket): WsLike {
  return {
    data: ws.data,
    send(msg: string) { if (ws.send(msg) === 0) throw new Error('WebSocket send failed') },
    close() { ws.close() },
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
  // A Discord reply to an agent's post goes to that agent only ("**[name → ...]**" prefix).
  let delivered: string[] = []
  let boundMiss: string | undefined
  if (msg.reference?.messageId && !directChannelOwner(wsDepsRef, msg.channelId)) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId)
      const m = ref.author.id === client.user?.id ? ref.content.match(/^\*\*\[([^\]\s]+) →/) : null
      if (m) {
        const asker = m[1]
        const target = inboxes.approvalTarget(ref.id)
        const held = deliverFn(wsDepsRef, asker, content, { ...fullMeta, to: asker, in_reply_to: ref.id, question_id: ref.id }, target)
        if (held) delivered = [asker]
        else boundMiss = asker
      }
    } catch (err) {
      const code = inboxError(err)
      if (code !== 'request_failed') { await msg.reply(code).catch(() => {}); return }
    }
  }
  routeError = undefined
  routeNote = undefined
  if (boundMiss) {
    routeNote = `not delivered to ${boundMiss}: that session is offline and has no conversation id. Reply again when they are back, or name a live session with @name.`
  } else if (delivered.length === 0) {
    const bound = msg.reference?.messageId
      ? { ...fullMeta, unbound_reply: msg.reference.messageId, in_reply_to: msg.reference.messageId }
      : fullMeta
    const everyone = msg.channelId === BUS_CHANNEL || msg.channelId === HUMAN_CHANNEL
    try {
      delivered = routeHumanBusMessage(content, bound, sessions, everyone ? undefined : channelSubscribers(wsDepsRef, msg.channelId), wsDepsRef)
    } catch (err) {
      await msg.reply(inboxError(err)).catch(() => {})
      return
    }
  }
  process.stderr.write(`discord: bus message from ${msg.author.username} -> ${delivered.join(',') || '(no sessions)'}\n`)
  if (delivered.length === 0) {
    const hint = routeError ?? routeNote ?? 'not routed: no agent sessions are connected.'
    await msg.reply(hint).catch(() => {})
  } else {
    void msg.react('📨').catch(() => {})
    if (!content.trim().startsWith('@')) await msg.reply(routeNote ?? `routed to ${delivered.join(', ')}`).catch(() => {})
  }
}

async function handleInbound(msg: Message): Promise<void> {
  if (BUS_CHANNEL && (msg.channelId === BUS_CHANNEL || msg.channelId === HUMAN_CHANNEL || directChannelOwner(wsDepsRef, msg.channelId) || subs.channels().has(msg.channelId))) return handleBusInbound(msg)
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
const agentChannelInterval = setInterval(() => {
  if (client.isReady()) void agentChannels?.maintain(agentChannelOps, name => onlineBusAgent(wsDepsRef, name))
    .catch(() => process.stderr.write('agent channels: maintenance failed\n'))
}, 5_000)
agentChannelInterval.unref()

const bufferInterval = setInterval(() => {
  sessions.saveBuffers().catch(() => {})
}, 30_000)

// A name lease lasts as long as its holder stays connected (name-leases.ts)
const leaseInterval = setInterval(() => sessions.refreshLeases(), 60_000)

// Poll swarms-config.json every 5 s on mtime+size (§1, §10.5)
const stopSwarmWatch = swarmConfig.startWatching(diff => {
  applySwarmConfigReload(wsDepsRef, diff)
}, 5_000)

// ============================================================
// Shutdown
// ============================================================

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('discord channel: shutting down\n')
  clearInterval(bufferInterval)
  clearInterval(agentChannelInterval)
  clearInterval(leaseInterval)
  stopSwarmWatch()
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
