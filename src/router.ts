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
import { createWsHandlers, handlePermissionButton, routeHumanBusMessage, channelSubscribers, directChannelOwner, onlineBusAgent, inboxError, deliver as deliverFn, applySwarmConfigReload, knownSwarm, sendRulesForSwarm } from './ws.js'
import { SwarmConfig } from './swarm-config.js'
import { SwarmJournal } from './swarm-journal.js'
import { SwarmChannels, type ChannelClientLike, type GuildLike } from './swarm-channels.js'
import { identityKey } from './inboxes.js'
import { Activity, Conversations, CostClasses, HumanMail, Unread, WakeBudget } from './wake.js'
import { AgentChannels } from './agent-channels.js'
import type { WsData, WsLike } from './ws.js'
import { PidManager } from './pid.js'
import { registerSlashCommands, handleSlashCommand, handleAutocomplete, updateSkillCommands, isSkillCommand } from './slash-commands.js'
import type { SlashCommandDeps, SkillEntry } from './slash-commands.js'
import type { ChannelMeta } from './types.js'
import { ActivityType, type Message, type Guild } from 'discord.js'
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

const agentChannels = new AgentChannels(STATE_DIR, Date.now(), channelOwners)

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
  if (BUS_CHANNEL) {
    const ch = await client.channels.fetch(BUS_CHANNEL)
    if (!ch || !('guild' in ch) || !ch.guild) throw new Error('bus channel is not in a server')
    return ch.guild
  }
  if (swarmConfig.isConfigured()) {
    const first = client.guilds.cache.first()
    if (first) return first
  }
  throw new Error('bus disabled')
}

let wsDepsRef: Parameters<typeof createWsHandlers>[0]
let routeError: string | undefined
let routeNote: string | undefined
const humanMail = new HumanMail()
const conversations = new Conversations()
const swarmConfig = SwarmConfig.inStateDir(STATE_DIR)
const swarmJournal = SwarmJournal.inStateDir(STATE_DIR)
const isBusOrSwarmActive = () => Boolean(BUS_CHANNEL || swarmConfig.isConfigured())

const swarmChannels = new SwarmChannels({
  config: swarmConfig,
  client: client as unknown as ChannelClientLike,
  busChannelId: BUS_CHANNEL,
  humanChannelId: HUMAN_CHANNEL,
  subs,
  channelOwners,
  agentChannels,
  knownSwarm: name => knownSwarm(wsDepsRef, name),
  nativeAlias: identity => {
    for (const name of inboxes.names()) {
      const target = inboxes.target(name)
      if (target && identityKey(target) === identity) return name
    }
    return undefined
  },
  onSwarmReady: (swarm) => sendRulesForSwarm(wsDepsRef, swarm),
})

const getGuildLike = async () => (await busGuild()) as unknown as GuildLike
const getStartupGuildLike = async (): Promise<GuildLike | null> => {
  if (BUS_CHANNEL) return getGuildLike()
  const first = client.guilds.cache.first()
  return first ? (first as unknown as GuildLike) : null
}
const channelOps: ChannelOps = swarmChannels.createChannelOps(getGuildLike)
const agentChannelOps = swarmChannels.createAgentChannelOps(getGuildLike)

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
  get subs() { return isBusOrSwarmActive() ? subs : undefined },
  get channelOps() { return isBusOrSwarmActive() ? channelOps : undefined },
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
  get agentChannels() { return isBusOrSwarmActive() ? agentChannels : undefined },
  staggerMs: parseInt(process.env.DISCORD_ALL_STAGGER_MS ?? '0', 10),
  onRoutingError: (message: string) => { routeError = message },
  onRouteNote: (message: string) => { routeNote = message },
  humanMail,
  conversations,
  swarmConfig,
  swarmJournal,
  swarmGeneralChannel: swarm => swarmChannels.generalChannelId(swarm),
  onRegisterPruneSubs: (name, swarm) => { swarmChannels.pruneSessionSubscriptions(name, swarm) },
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
  const route = await swarmChannels.classifyInbound(
    msg.channelId,
    id => {
      if (!isBusOrSwarmActive()) return false
      if (id === BUS_CHANNEL || id === HUMAN_CHANNEL || subs.channels().has(id)) return true
      const owner = directChannelOwner(wsDepsRef, id)
      if (!owner) return false
      if (!swarmConfig.isConfigured()) return true
      const ownerSwarm = knownSwarm(wsDepsRef, owner)
      return !ownerSwarm || ownerSwarm === 'default'
    },
    msg.channel.isDMBased(),
  )
  if (route === 'bus') return handleBusInbound(msg)
  if (route === 'drop') return
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

client.on('channelUpdate', () => {
  if (swarmConfig.isConfigured() && swarmChannels.isInitialFetchDone()) {
    swarmChannels.sweep()
  }
})

client.once('clientReady', c => {
  process.stderr.write(`discord channel: gateway connected as ${c.user.tag}\n`)
  registerSlashCommands(c).catch((e: unknown) =>
    process.stderr.write(`discord: registerSlashCommands failed: ${e instanceof Error ? e.message : String(e)}\n`),
  )
  // Synchronously seed room->swarm state from GUILD_CREATE cache before any inbound event runs (impl-plan-v2 #30-2).
  const readyGuild = (BUS_CHANNEL
    ? (c.channels.cache.get(BUS_CHANNEL) as { guild?: GuildLike } | undefined)?.guild
    : undefined) ?? (c.guilds.cache.first() as unknown as GuildLike | undefined) ?? null
  swarmChannels.seedFromGuildCache(readyGuild)
  void swarmChannels.startClientReady(getStartupGuildLike)
  updatePresence()
})

// Poll for pairing approvals
setInterval(() => checkApprovals(client), 5000).unref()

// Periodic buffer persistence
const agentChannelInterval = setInterval(() => {
  if (client.isReady() && isBusOrSwarmActive()) void agentChannels.maintain(agentChannelOps, name => onlineBusAgent(wsDepsRef, name))
    .catch(() => process.stderr.write('agent channels: maintenance failed\n'))
}, 5_000)
agentChannelInterval.unref()

const bufferInterval = setInterval(() => {
  sessions.saveBuffers().catch(() => {})
}, 30_000)

// A name lease lasts as long as its holder stays connected (name-leases.ts)
const leaseInterval = setInterval(() => sessions.refreshLeases(), 60_000)

// Poll swarms-config.json every 5 s on mtime+size (§1, §10.4, §10.5)
const stopSwarmWatch = swarmConfig.startWatching(diff => {
  applySwarmConfigReload(wsDepsRef, diff)
  if (isBusOrSwarmActive() && client.isReady()) {
    void swarmChannels.onConfigReload(getGuildLike, diff).catch((e: unknown) => {
      process.stderr.write(`discord: swarm channel reload failed: ${e instanceof Error ? e.message : String(e)}\n`)
    })
  }
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
  swarmChannels.stop()
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
