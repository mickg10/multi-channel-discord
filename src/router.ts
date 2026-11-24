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
import { createWsHandlers, handlePermissionButton, routeHumanBusMessage } from './ws.js'
import type { WsData, WsLike } from './ws.js'
import { PidManager } from './pid.js'
import { registerSlashCommands, handleSlashCommand, handleAutocomplete, updateSkillCommands, isSkillCommand } from './slash-commands.js'
import type { SlashCommandDeps, SkillEntry } from './slash-commands.js'
import type { ChannelMeta } from './types.js'
import { ActivityType, ChannelType, type Message, type Guild } from 'discord.js'
import { Subscriptions } from './subscriptions.js'
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

async function busGuild(): Promise<Guild> {
  if (!BUS_CHANNEL) throw new Error('bus disabled')
  const ch = await client.channels.fetch(BUS_CHANNEL)
  if (!ch || !('guild' in ch) || !ch.guild) throw new Error('bus channel is not in a server')
  return ch.guild
}

const channelOps: ChannelOps = {
  async resolve(ref: string) {
    const guild = await busGuild()
    const want = ref.replace(/^<#(\d+)>$/, '$1').replace(/^#/, '').trim()
    const all = await guild.channels.fetch()
    const hit = all.find(c => c != null && c.type === ChannelType.GuildText && (c.id === want || c.name === want.toLowerCase()))
    return hit ? { id: hit.id, name: hit.name } : null
  },
  async list() {
    const guild = await busGuild()
    const all = await guild.channels.fetch()
    return [...all.values()]
      .filter(c => c != null && c.type === ChannelType.GuildText)
      .map(c => ({ id: c!.id, name: c!.name, topic: 'topic' in c! ? (c as { topic: string | null }).topic : null }))
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
}

const wsHandlers = createWsHandlers({
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

process.stderr.write(`discord channel: WS server listening on ${WS_HOST}:${WS_PORT} (auth=${ROUTER_SECRET ? 'secret' : 'none'}, bus=${BUS_CHANNEL ?? 'off'})\n`)

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
  const content = msg.content.replace(/<@!?\d+>\s*/g, '').trim()
  if (!content) return
  const meta: ChannelMeta = {
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
  const audienceNames = msg.channelId === BUS_CHANNEL ? undefined : subs.subscribers(msg.channelId)
  const delivered = routeHumanBusMessage(content, { ...meta, ...(channelName && { channel: channelName }) }, sessions, audienceNames)
  process.stderr.write(`discord: bus message from ${msg.author.username} -> ${delivered.join(',') || '(no sessions)'}\n`)
  if (delivered.length === 0) {
    await msg.reply('No agent sessions are connected.').catch(() => {})
  } else {
    void msg.react('📨').catch(() => {})
  }
}

async function handleInbound(msg: Message): Promise<void> {
  if (BUS_CHANNEL && (msg.channelId === BUS_CHANNEL || subs.channels().has(msg.channelId))) return handleBusInbound(msg)
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
