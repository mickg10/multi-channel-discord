/**
 * Discord slash command registration and handling.
 * Defines /switch, /list, /status, /kill, /broadcast, /spawn.
 * All responses are ephemeral.
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  REST,
  Routes,
  type Client,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js'
import type { SessionManager, ProjectHistory } from './sessions.js'
import { formatFlush } from './sessions.js'
import type { ChannelMeta } from './types.js'

// ============================================================
// Command definitions
// ============================================================

const switchCommand = new SlashCommandBuilder()
  .setName('switch')
  .setDescription('Switch the active Claude Code session')
  .addStringOption(opt =>
    opt.setName('session')
      .setDescription('Session name to switch to')
      .setRequired(true)
      .setAutocomplete(true),
  )

const listCommand = new SlashCommandBuilder()
  .setName('list')
  .setDescription('List all connected Claude Code sessions')

const statusCommand = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Show router uptime, instance count, and queued messages')

const killCommand = new SlashCommandBuilder()
  .setName('kill')
  .setDescription('Terminate a Claude Code session')
  .addStringOption(opt =>
    opt.setName('session')
      .setDescription('Session name to kill, or "all"')
      .setRequired(true)
      .setAutocomplete(true),
  )

const broadcastCommand = new SlashCommandBuilder()
  .setName('broadcast')
  .setDescription('Send a message to all connected sessions')
  .addStringOption(opt =>
    opt.setName('message')
      .setDescription('Message text to broadcast')
      .setRequired(true),
  )

const spawnCommand = new SlashCommandBuilder()
  .setName('spawn')
  .setDescription('Spawn a new Claude Code session from recent projects')
  .addStringOption(opt =>
    opt.setName('project')
      .setDescription('Project to spawn in')
      .setRequired(false)
      .setAutocomplete(true),
  )

const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show all available commands and their descriptions')

export const BUILTIN_COMMANDS = [
  switchCommand,
  listCommand,
  statusCommand,
  killCommand,
  broadcastCommand,
  spawnCommand,
  helpCommand,
] as const

/** @deprecated Use BUILTIN_COMMANDS instead */
export const ALL_COMMANDS = BUILTIN_COMMANDS

// ============================================================
// Skill command tracking
// ============================================================

/** Names of built-in commands that cannot be overridden by skills. */
const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map(c => c.name))

/** Max skill commands (Discord allows 100 global commands, reserve room for builtins). */
const MAX_SKILL_COMMANDS = 90

/** Currently registered skill names (for diffing on re-registration). */
let registeredSkillNames: readonly string[] = []

export interface SkillEntry {
  readonly name: string
  readonly description: string
}

/** Build a slash command JSON payload for a skill. */
function buildSkillCommand(skill: Readonly<SkillEntry>): { toJSON(): unknown } {
  const cmd = new SlashCommandBuilder()
    .setName(skill.name)
    .setDescription(skill.description.slice(0, 100) || skill.name)
    .addStringOption(opt =>
      opt.setName('args')
        .setDescription('Arguments to pass to the skill')
        .setRequired(false),
    )
  return cmd
}

// ============================================================
// Registration
// ============================================================

export async function registerSlashCommands(client: Client, skills: readonly SkillEntry[] = []): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN
  if (!token || !client.user) return

  // Filter out skills that collide with built-in command names
  const validSkills = skills
    .filter(s => !BUILTIN_NAMES.has(s.name))
    .slice(0, MAX_SKILL_COMMANDS)

  const allCommands = [
    ...BUILTIN_COMMANDS,
    ...validSkills.map(buildSkillCommand),
  ]

  const rest = new REST({ version: '10' }).setToken(token)
  try {
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: allCommands.map(c => c.toJSON()) },
    )
    registeredSkillNames = validSkills.map(s => s.name)
    process.stderr.write(`discord channel: registered ${allCommands.length} slash commands (${validSkills.length} skills)\n`)
  } catch (err: unknown) {
    process.stderr.write(`discord channel: failed to register slash commands: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

/** Re-register commands with updated skills. Only calls Discord API if skills actually changed. */
export async function updateSkillCommands(client: Client, skills: readonly SkillEntry[]): Promise<void> {
  const validSkills = skills
    .filter(s => !BUILTIN_NAMES.has(s.name))
    .slice(0, MAX_SKILL_COMMANDS)

  const newNames = validSkills.map(s => s.name).sort().join(',')
  const oldNames = [...registeredSkillNames].sort().join(',')

  if (newNames === oldNames) return

  await registerSlashCommands(client, validSkills)
}

/** Check if a command name is a registered skill. */
export function isSkillCommand(name: string): boolean {
  return registeredSkillNames.includes(name)
}

/** Get currently registered skill names. */
export function getRegisteredSkills(): readonly string[] {
  return registeredSkillNames
}

/** Set registered skill names directly (for testing). */
export function _setRegisteredSkillsForTest(names: readonly string[]): void {
  registeredSkillNames = names
}

// ============================================================
// Interaction context
// ============================================================

export interface SlashCommandDeps {
  readonly sessions: SessionManager
  readonly history: ProjectHistory
  readonly startedAt: number
  /** Classify a Discord channel id into `'default' | '<swarm>' | 'dm' | 'retired' | 'unknown'`. */
  readonly channelSwarm?: (channelId: string) => string
  /** Whether multi-swarm config is active. */
  readonly isSwarmConfigured?: () => boolean
}

function interactionSwarm(channelId: string | undefined, deps: Readonly<SlashCommandDeps>): { ok: true; swarm: string; isDefaultOrDm: boolean } | { ok: false; error: string } {
  if (!deps.isSwarmConfigured?.() || !deps.channelSwarm || !channelId) {
    return { ok: true, swarm: 'default', isDefaultOrDm: true }
  }
  const cls = deps.channelSwarm(channelId)
  if (cls === 'retired' || cls === 'unknown') {
    return { ok: false, error: cls === 'retired' ? 'This channel belongs to a retired swarm.' : 'Swarm channels are not ready yet.' }
  }
  if (cls === 'dm' || cls === 'default') {
    return { ok: true, swarm: 'default', isDefaultOrDm: true }
  }
  return { ok: true, swarm: cls, isDefaultOrDm: false }
}

function scopedSessions(deps: Readonly<SlashCommandDeps>, swarm: string) {
  const all = deps.sessions.getSessions()
  if (!deps.isSwarmConfigured?.()) return all
  return all.filter(s => (s.swarm ?? 'default') === swarm)
}

// ============================================================
// Autocomplete handlers
// ============================================================

export function handleAutocomplete(interaction: AutocompleteInteraction, deps: Readonly<SlashCommandDeps>): void {
  const focused = interaction.options.getFocused(true)
  const commandName = interaction.commandName
  const ctx = interactionSwarm(interaction.channelId, deps)
  if (!ctx.ok) {
    void interaction.respond([]).catch(() => {})
    return
  }

  if (commandName === 'switch' && focused.name === 'session') {
    if (!ctx.isDefaultOrDm) { void interaction.respond([]).catch(() => {}); return }
    const names = scopedSessions(deps, 'default').map(s => s.name)
    const filtered = names.filter(n => n.toLowerCase().startsWith(focused.value.toLowerCase()))
    void interaction.respond(
      filtered.slice(0, 25).map(n => ({ name: n, value: n })),
    ).catch(() => {})
    return
  }

  if (commandName === 'kill' && focused.name === 'session') {
    const names = ['all', ...scopedSessions(deps, ctx.swarm).map(s => s.name)]
    const filtered = names.filter(n => n.toLowerCase().startsWith(focused.value.toLowerCase()))
    void interaction.respond(
      filtered.slice(0, 25).map(n => ({ name: n, value: n })),
    ).catch(() => {})
    return
  }

  if (commandName === 'spawn' && focused.name === 'project') {
    if (!ctx.isDefaultOrDm) { void interaction.respond([]).catch(() => {}); return }
    const projects = deps.history.getRecent(25)
    const filtered = projects.filter(p =>
      p.name.toLowerCase().startsWith(focused.value.toLowerCase()) ||
      p.path.toLowerCase().includes(focused.value.toLowerCase()),
    )
    void interaction.respond(
      filtered.slice(0, 25).map(p => ({ name: `${p.name} — ${p.path}`, value: p.path })),
    ).catch(() => {})
    return
  }

  void interaction.respond([]).catch(() => {})
}

// ============================================================
// Command handlers
// ============================================================

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  deps: Readonly<SlashCommandDeps>,
): Promise<void> {
  if (interaction.commandName === 'help') return handleHelp(interaction)
  const ctx = interactionSwarm(interaction.channelId, deps)
  if (!ctx.ok) {
    await interaction.reply({ content: ctx.error, ephemeral: true })
    return
  }
  switch (interaction.commandName) {
    case 'switch':
      if (!ctx.isDefaultOrDm) {
        await interaction.reply({ content: '`/switch` is only available in default channels and DMs.', ephemeral: true })
        return
      }
      return handleSwitch(interaction, deps)
    case 'list': return handleList(interaction, deps, ctx.swarm)
    case 'status': return handleStatus(interaction, deps, ctx.swarm)
    case 'kill': return handleKill(interaction, deps, ctx.swarm)
    case 'broadcast': return handleBroadcast(interaction, deps, ctx.swarm)
    case 'spawn':
      if (!ctx.isDefaultOrDm) {
        await interaction.reply({ content: '`/spawn` is only available in default channels and DMs.', ephemeral: true })
        return
      }
      return handleSpawn(interaction, deps)
    default:
      // Check if it's a skill command
      if (isSkillCommand(interaction.commandName)) {
        if (!ctx.isDefaultOrDm) {
          await interaction.reply({ content: 'Skill commands are only available in default channels and DMs.', ephemeral: true })
          return
        }
        return handleSkillInvocation(interaction, deps)
      }
      await interaction.reply({ content: `Unknown command: /${interaction.commandName}`, ephemeral: true })
  }
}

async function handleSwitch(
  interaction: ChatInputCommandInteraction,
  deps: Readonly<SlashCommandDeps>,
): Promise<void> {
  const sessionName = interaction.options.getString('session', true)
  const sessions = scopedSessions(deps, 'default')
  const target = sessions.find(s => s.name === sessionName)

  if (!target) {
    const names = sessions.map(s => s.name)
    const available = names.length > 0 ? `Available: ${names.join(', ')}` : 'No sessions connected.'
    await interaction.reply({ content: `Session '${sessionName}' not found. ${available}`, ephemeral: true })
    return
  }

  deps.sessions.setActive(sessionName)
  const parts: string[] = [`Switched to **${sessionName}**`]

  // Flush per-session buffer
  const buffered = deps.sessions.flushBuffer(sessionName)
  if (buffered.length > 0) {
    parts.push(formatFlush(sessionName, buffered))
  }

  // Drain unrouted inbox
  const unrouted = deps.sessions.drainUnrouted()
  if (unrouted.length > 0) {
    for (const msg of unrouted) {
      deps.sessions.routeToActive(msg.text, msg.meta)
    }
    parts.push(`[router] ${unrouted.length} unrouted message${unrouted.length === 1 ? '' : 's'} delivered`)
  }

  await interaction.reply({ content: parts.join('\n\n'), ephemeral: true })
}

async function handleList(
  interaction: ChatInputCommandInteraction,
  deps: Readonly<SlashCommandDeps>,
  swarm: string,
): Promise<void> {
  const sessions = scopedSessions(deps, swarm)
  if (sessions.length === 0) {
    await interaction.reply({ content: 'No sessions connected.', ephemeral: true })
    return
  }

  const active = deps.sessions.getActive()
  const lines = sessions.map(s => {
    const bufCount = deps.sessions.getBufferedCount(s.name)
    const status = s.name === active
      ? '(active)'
      : bufCount > 0
        ? `${bufCount} buffered`
        : 'idle'
    return `- **${s.name}** — ${s.projectPath} [${status}]`
  })

  await interaction.reply({ content: lines.join('\n'), ephemeral: true })
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  deps: Readonly<SlashCommandDeps>,
  swarm: string,
): Promise<void> {
  const sessions = scopedSessions(deps, swarm)
  const uptime = formatUptime(Date.now() - deps.startedAt)
  const unroutedCount = swarm === 'default' ? deps.sessions.getUnrouted().length : 0
  const totalBuffered = sessions.reduce((sum, s) => sum + deps.sessions.getBufferedCount(s.name), 0)

  const lines = [
    `**Uptime**: ${uptime}`,
    `**Instances**: ${sessions.length}`,
    `**Queued messages**: ${totalBuffered + unroutedCount}`,
  ]

  await interaction.reply({ content: lines.join('\n'), ephemeral: true })
}

async function handleKill(
  interaction: ChatInputCommandInteraction,
  deps: Readonly<SlashCommandDeps>,
  swarm: string,
): Promise<void> {
  const sessionName = interaction.options.getString('session', true)
  const sessions = scopedSessions(deps, swarm)
  // Without config, keep today's deregisterSession semantics; with config, close sockets per §4 (M3).
  const terminate = (name: string) => {
    if (deps.isSwarmConfigured?.()) deps.sessions.closeSessionSockets(name)
    else deps.sessions.deregisterSession(name)
  }

  if (sessionName === 'all') {
    if (sessions.length === 0) {
      await interaction.reply({ content: 'No sessions to terminate.', ephemeral: true })
      return
    }
    const count = sessions.length
    for (const s of sessions) {
      terminate(s.name)
    }
    await interaction.reply({
      content: `${count} session${count === 1 ? '' : 's'} terminated.`,
      ephemeral: true,
    })
    return
  }

  if (!sessions.find(s => s.name === sessionName)) {
    const names = sessions.map(s => s.name)
    const available = names.length > 0 ? `Available: ${names.join(', ')}` : 'No sessions connected.'
    await interaction.reply({ content: `Session '${sessionName}' not found. ${available}`, ephemeral: true })
    return
  }

  terminate(sessionName)
  const remaining = scopedSessions(deps, swarm).map(s => s.name)
  const activeInfo = remaining.length > 0 ? `Active: ${remaining.join(', ')}` : 'No sessions remaining.'
  await interaction.reply({
    content: `Session "${sessionName}" terminated. ${activeInfo}`,
    ephemeral: true,
  })
}

async function handleBroadcast(
  interaction: ChatInputCommandInteraction,
  deps: Readonly<SlashCommandDeps>,
  swarm: string,
): Promise<void> {
  const message = interaction.options.getString('message', true)
  const sessions = scopedSessions(deps, swarm)

  if (sessions.length === 0) {
    await interaction.reply({ content: 'No sessions connected.', ephemeral: true })
    return
  }

  for (const s of sessions) {
    deps.sessions.routeToSession(s.name, message, { type: 'broadcast' } as ChannelMeta)
  }

  await interaction.reply({
    content: `Broadcast sent to ${sessions.length} session${sessions.length === 1 ? '' : 's'}.`,
    ephemeral: true,
  })
}

async function handleSpawn(
  interaction: ChatInputCommandInteraction,
  deps: Readonly<SlashCommandDeps>,
): Promise<void> {
  const projectPath = interaction.options.getString('project')

  if (projectPath) {
    // Reply first, then spawn in background
    await interaction.reply({
      content: `Spawning Claude Code in \`${projectPath}\`...`,
      ephemeral: true,
    })
    spawnCad(projectPath)
    return
  }

  // No project specified — show recent projects
  const projects = deps.history.getRecent(10)
  if (projects.length === 0) {
    await interaction.reply({ content: 'No recent projects. Connect a Claude Code instance first.', ephemeral: true })
    return
  }

  const lines = projects.map((p, i) => `${i + 1}. **${p.name}** — \`${p.path}\``)
  await interaction.reply({
    content: `Recent projects:\n${lines.join('\n')}\n\nUse \`/spawn project:<path>\` to spawn.`,
    ephemeral: true,
  })
}

async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('Claude Code Discord Channel')
    .setDescription('Multi-session routing for Claude Code via Discord.')
    .addFields(
      { name: '/switch <session>', value: 'Switch the active Claude Code session. Messages you send will be routed to the active session.' },
      { name: '/list', value: 'List all connected Claude Code sessions with their status (active, idle, buffered messages).' },
      { name: '/status', value: 'Show router uptime, connected instance count, and queued message count.' },
      { name: '/kill <session|all>', value: 'Terminate a specific session or all sessions.' },
      { name: '/broadcast <message>', value: 'Send a message to all connected sessions simultaneously.' },
      { name: '/spawn [project]', value: 'Spawn a new Claude Code session. Shows recent projects if none specified.' },
      { name: '/help', value: 'Show this help message.' },
    )
    .addFields(
      { name: '\u200b', value: '**Claude Code Skills** (run in your terminal, not Discord)' },
      { name: '/discord:access', value: 'Manage pairing, allowlists, and DM/group policy.' },
      { name: '/discord:configure', value: 'Set up the bot token and review channel configuration.' },
    )
    .setFooter({ text: 'Messages sent in this DM are forwarded to the active Claude Code session.' })

  await interaction.reply({ embeds: [embed], ephemeral: true })
}

// ============================================================
// Skill invocation
// ============================================================

async function handleSkillInvocation(
  interaction: ChatInputCommandInteraction,
  deps: Readonly<SlashCommandDeps>,
): Promise<void> {
  const skillName = interaction.commandName
  const args = interaction.options.getString('args') ?? ''
  const content = args ? `/${skillName} ${args}` : `/${skillName}`

  const sessions = deps.sessions.getSessions()
  if (sessions.length === 0) {
    await interaction.reply({ content: 'No sessions connected. Connect Claude Code first.', ephemeral: true })
    return
  }

  const routed = deps.sessions.routeToActive(content, {
    type: 'skill',
    chat_id: interaction.channelId,
    user: interaction.user.username,
    user_id: interaction.user.id,
  } as ChannelMeta)

  if (routed) {
    await interaction.reply({ content: `Running \`/${skillName}${args ? ` ${args}` : ''}\`...`, ephemeral: true })
  } else {
    await interaction.reply({ content: 'No active session. Use `/switch` to activate a session first.', ephemeral: true })
  }
}

// ============================================================
// Spawn helper
// ============================================================

export function spawnCad(dir: string): void {
  try {
    const { spawn } = require('child_process') as typeof import('child_process')
    // cad is a shell alias for 'claude --dangerously-skip-permissions'
    // Use the actual binary path + the alias flags + channels
    const child = spawn('/Users/yassin/.local/bin/claude', [
      '--dangerously-skip-permissions',
      '--channels', 'plugin:discord@claude-plugins-official',
    ], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    process.stderr.write(`discord channel: spawned claude in ${dir}\n`)
  } catch (err: unknown) {
    process.stderr.write(`discord channel: failed to spawn claude: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

// ============================================================
// Utilities
// ============================================================

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}
