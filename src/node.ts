#!/usr/bin/env bun
/**
 * agent-bus node — runs a machine's agents headless and wakes them when bus messages arrive.
 *
 * No tmux, no terminal: each wake runs ONE non-interactive turn that resumes the agent's own
 * conversation (claude -p --resume / codex exec resume / agy -p --conversation). During the
 * turn the agent's discord MCP client registers in pull mode, the agent calls check_inbox,
 * answers with bus_post / channel_post, and the turn ends. Context persists across turns.
 *
 * Config: $AGENT_BUS_NODE_CONFIG or ~/.config/agent-bus/node.json
 *   { "node": "nas642",
 *     "maxTurnsPerHour": 20, "turnTimeoutSec": 1800,
 *     "agents": [
 *       { "name": "codex@nas642:photos", "kind": "codex", "cwd": "~/src/sync_photo_and_files",
 *         "env": { "CODEX_HOME": "~/.codex-photos" },
 *         "args": ["--dangerously-bypass-approvals-and-sandbox"],
 *         "resume": "<optional existing session/thread/conversation id to adopt>" } ] }
 * State (session ids): ~/.config/agent-bus/node-state.json. Router URL/secret:
 * ~/.claude/channels/discord/.env (re-read on every reconnect).
 * "mcpServers" in node.json is the local allowlist of shared MCP servers this node hosts
 * (name → command/args/env). The router only ever sends {callId, server, method, params}.
 *
 * Runs under systemd (Linux) or launchd (macOS) with restart-always; see bin/agent-bus-install-node.
 * Self-update: every 5 min fast-forwards the checkout to origin/release (CI-gated); when HEAD
 * changes and no turn is running it exits 0 and the service manager restarts it.
 */

import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { McpChild, validateLocalMcp, resolveLocalMcp, type LocalMcpConfig, type McpExecRequest } from './mcp.js'

const HOME = homedir()
const expand = (p: string) => p.replace(/^~(?=$|\/)/, HOME)
const log = (m: string) => process.stderr.write(`${new Date().toISOString()} agent-bus node: ${m}\n`)

export type Kind = 'claude' | 'codex' | 'agy' | 'opencode'
export interface AgentConfig {
  name: string
  kind: Kind
  cwd?: string
  env?: Record<string, string>
  args?: string[]
  resume?: string
  /** Extra instructions added to the first (bootstrap) prompt. */
  role?: string
  maxTurnsPerHour?: number
}
export interface NodeConfig {
  node?: string
  agents: AgentConfig[]
  maxTurnsPerHour?: number
  turnTimeoutSec?: number
  /** MCP servers this node is willing to host: name → {command, args?, env?, methods?, initTimeoutMs?}.
   *  The router never sends commands — it only names a server; the local allowlist decides
   *  what may actually be spawned here. env values may be "file:/path" (resolved at spawn). */
  mcpServers?: LocalMcpConfig
}

const CODE_DIR = resolve(import.meta.dir, '..')
const MCP_LAUNCHER = join(CODE_DIR, 'bin', 'agent-bus-mcp')
const CONFIG_FILE = expand(process.env.AGENT_BUS_NODE_CONFIG ?? '~/.config/agent-bus/node.json')
const STATE_FILE = join(dirname(CONFIG_FILE), 'node-state.json')
const ENV_FILE = expand(process.env.DISCORD_STATE_DIR ? `${process.env.DISCORD_STATE_DIR}/.env` : '~/.claude/channels/discord/.env')
/**
 * bin dir of nvm's current default node, resolved on every turn so a node upgrade never leaves a
 * stale pinned PATH (codex/opencode often live only there; service units don't load nvm).
 */
export function nvmBinDir(nvmDir = process.env.NVM_DIR || join(HOME, '.nvm')): string | undefined {
  const versions = join(nvmDir, 'versions/node')
  if (!existsSync(versions)) return undefined
  let alias = ''
  try { alias = readFileSync(join(nvmDir, 'alias/default'), 'utf8').trim() } catch {}
  const all = readdirSync(versions).filter(v => /^v\d+\.\d+\.\d+$/.test(v))
  const byVer = (a: string, b: string) => {
    const pa = a.slice(1).split('.').map(Number), pb = b.slice(1).split('.').map(Number)
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
  }
  const want = alias.replace(/^v?/, 'v')
  const pick = all.includes(want) ? want
    : all.filter(v => /^\d+$/.test(alias) ? v.startsWith(`v${alias}.`) : true).sort(byVer).pop()
  return pick ? join(versions, pick, 'bin') : undefined
}

/**
 * Is some local process already running this conversation (an interactive TUI resumed by id, or a
 * Claude session whose session file names it)? The name-only router check misses a live process
 * whose bus client is briefly down; running a headless turn then would fork the conversation.
 */
export function conversationHeldLocally(session: string | undefined, ps: () => string = defaultPs, claudeSessions = join(HOME, '.claude/sessions')): string | undefined {
  if (!session || session === LAST) return undefined
  for (const line of ps().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (m && Number(m[1]) !== process.pid && m[2].includes(session)) return `pid ${m[1]}`
  }
  try {
    for (const f of readdirSync(claudeSessions)) {
      if (!f.endsWith('.json')) continue
      try {
        const d = JSON.parse(readFileSync(join(claudeSessions, f), 'utf8')) as { pid?: number; sessionId?: string }
        if (d.sessionId === session && d.pid) { try { process.kill(d.pid, 0); return `claude pid ${d.pid}` } catch {} }
      } catch {}
    }
  } catch {}
  return undefined
}
const defaultPs = (): string => { try { return execFileSync('ps', ['-eo', 'pid=,args=']).toString() } catch { return '' } }

/** Sentinel session: continue the most recent conversation in the agent's cwd (adopt an existing one). */
export const LAST = 'last'
const DISCORD_TOOLS = ['bus_post', 'dispatch', 'bus_sessions', 'check_inbox', 'reply', 'react', 'edit_message', 'fetch_messages',
  'download_attachment', 'ask_user', 'channel_post', 'channel_list', 'channel_create', 'channel_subscribe',
  'channel_unsubscribe', 'channel_archive', 'claim', 'release_claim', 'list_claims',
  'mcp_list', 'mcp_describe', 'mcp_call']

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m) out[m[1]] = m[2]
    }
  } catch {}
  return out
}

function loadConfig(): NodeConfig {
  const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as NodeConfig
  if (!Array.isArray(c.agents)) throw new Error(`${CONFIG_FILE}: "agents" must be an array`)
  for (const a of c.agents) {
    if (!a.name || !['claude', 'codex', 'agy', 'opencode'].includes(a.kind)) throw new Error(`bad agent entry: ${JSON.stringify(a)}`)
  }
  return c
}

type State = Record<string, { session?: string; lastTurn?: string; turns?: number }>
function loadState(): State {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State } catch { return {} }
}
function saveState(s: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(s, null, 2))
  renameSync(`${STATE_FILE}.tmp`, STATE_FILE)
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export function bootstrapPrompt(a: AgentConfig, node: string): string {
  return [
    `You are "${a.name}", a ${a.kind} agent running headless on node "${node}" as part of the agent bus`,
    `(several AI agents on different machines + the human, talking through Discord).`,
    `You are woken for one turn whenever messages arrive for you. Each turn:`,
    `1. Call the discord tool check_inbox and read every message.`,
    `2. Act on what is addressed to you (or to everyone) and reply with bus_post / channel_post`,
    `   (to=<sender> for agents, to="human" for the human). Follow the bus rules the router sends.`,
    `3. When done, end your turn with a one-line summary. Do not wait or poll — you will be woken again.`,
    `There is no terminal user: never ask for interactive input; ask the human via to="human" instead.`,
    a.role ? `Your role: ${a.role}` : '',
  ].filter(Boolean).join('\n')
}

export const WAKE_PROMPT = 'New agent-bus messages are waiting. Call the discord check_inbox tool, handle them (reply with bus_post / channel_post), then end your turn with a one-line summary.'

// ---------------------------------------------------------------------------
// Per-kind command lines
// ---------------------------------------------------------------------------

function claudeHasPlugin(): boolean {
  try {
    const j = readFileSync(join(HOME, '.claude/plugins/installed_plugins.json'), 'utf8')
    return j.includes('discord@multi-channel-discord')
  } catch { return false }
}

export function buildCommand(a: AgentConfig, session: string | undefined, prompt: string, opts: { claudePlugin: boolean }): { cmd: string; args: string[]; env?: Record<string, string> } {
  const extra = a.args ?? []
  const mcpEnv: Record<string, string> = { DISCORD_SESSION_NAME: a.name, DISCORD_AGENT: a.kind, DISCORD_MODE: 'pull', DISCORD_WAKE: '' }
  switch (a.kind) {
    case 'claude': {
      const args = ['-p', prompt, '--output-format', 'json', ...(session === LAST ? ['--continue'] : session ? ['--resume', session] : [])]
      if (!opts.claudePlugin) {
        args.push('--mcp-config', JSON.stringify({ mcpServers: { discord: { command: MCP_LAUNCHER, env: mcpEnv } } }))
      }
      args.push('--allowedTools', DISCORD_TOOLS.map(t => opts.claudePlugin ? `mcp__plugin_discord_discord__${t}` : `mcp__discord__${t}`).join(','))
      return { cmd: 'claude', args: [...args, ...extra] }
    }
    case 'codex': {
      const c: string[] = []
      const set = (k: string, v: string) => c.push('-c', `${k}=${JSON.stringify(v)}`)
      set('mcp_servers.discord.command', MCP_LAUNCHER)
      for (const [k, v] of Object.entries(mcpEnv)) set(`mcp_servers.discord.env.${k}`, v)
      for (const t of DISCORD_TOOLS) set(`mcp_servers.discord.tools.${t}.approval_mode`, 'approve')
      // `codex exec [opts] resume <id> <prompt>` | `codex exec [opts] <prompt>`
      return { cmd: 'codex', args: ['exec', '--json', '--skip-git-repo-check', ...c, ...extra, ...(session === LAST ? ['resume', '--last'] : session ? ['resume', session] : []), prompt] }
    }
    case 'agy':
      return { cmd: 'agy', args: ['-p', prompt, '--output-format', 'json', ...(session === LAST ? ['--continue'] : session ? ['--conversation', session] : []), ...extra] }
    case 'opencode':
      // OPENCODE_CONFIG_CONTENT is merged over the user's config: adds/overrides the discord MCP.
      return {
        cmd: 'opencode',
        args: ['run', '--format', 'json', ...(session === LAST ? ['--continue'] : session ? ['--session', session] : []), ...extra, prompt],
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { discord: { type: 'local', command: [MCP_LAUNCHER], environment: mcpEnv, enabled: true } } }) },
      }
  }
}

/** Pull the session/thread/conversation id and a short result out of a turn's stdout. */
export function parseTurnOutput(kind: Kind, out: string): { session?: string; summary?: string; error?: string } {
  if (kind === 'opencode') {
    let session: string | undefined, summary: string | undefined, error: string | undefined
    for (const line of out.split('\n')) {
      try {
        const e = JSON.parse(line)
        session ??= e.sessionID
        if (e.type === 'text' && e.part?.text) summary = e.part.text
        if (e.type === 'error') error = JSON.stringify(e).slice(0, 300)
      } catch {}
    }
    return { session, summary, error }
  }
  if (kind === 'codex') {
    let session: string | undefined, summary: string | undefined, error: string | undefined
    for (const line of out.split('\n')) {
      try {
        const e = JSON.parse(line)
        if (e.type === 'thread.started') session = e.thread_id
        if (e.type === 'item.completed' && e.item?.type === 'agent_message') summary = e.item.text
        if (e.type === 'turn.failed' || e.type === 'error') error = JSON.stringify(e).slice(0, 300)
      } catch {}
    }
    return { session, summary, error }
  }
  try {
    const start = out.indexOf('{')
    const d = JSON.parse(out.slice(start))
    if (kind === 'claude') return { session: d.session_id, summary: d.result, ...(d.is_error && { error: String(d.result).slice(0, 300) }) }
    return { session: d.conversation_id, summary: d.response, ...(d.status && d.status !== 'SUCCESS' && { error: String(d.status) }) }
  } catch {
    return { error: `unparseable output: ${out.slice(0, 200)}` }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig()
  const node = cfg.node ?? hostname().split('.')[0].toLowerCase()
  const state = loadState()
  const localMcp = validateLocalMcp(cfg.mcpServers)
  const timeoutMs = (cfg.turnTimeoutSec ?? 1800) * 1000
  const claudePlugin = claudeHasPlugin()
  const running = new Set<string>()
  const again = new Set<string>()
  const turnTimes = new Map<string, number[]>()
  let ws: WebSocket | null = null
  let attempt = 0
  let reqId = 0
  const pending = new Map<string, (data: string) => void>()
  // stdio MCP servers this node hosts for the bus; what may run comes from localMcp only.
  const mcpChild = new McpChild(undefined, log)
  process.on('exit', () => mcpChild.close())

  for (const a of cfg.agents) {
    if (a.resume && a.resume !== 'last' && !state[a.name]?.session) state[a.name] = { ...state[a.name], session: a.resume }
  }
  saveState(state)

  function request(type: string, extra: Record<string, unknown>): Promise<string> {
    return new Promise(res => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return res('0')
      const requestId = `n${++reqId}`
      pending.set(requestId, res)
      ws.send(JSON.stringify({ type, requestId, ...extra }))
      setTimeout(() => { if (pending.delete(requestId)) res('0') }, 10_000)
    })
  }

  function budgetOk(a: AgentConfig): boolean {
    const limit = a.maxTurnsPerHour ?? cfg.maxTurnsPerHour ?? 20
    const now = Date.now()
    const t = (turnTimes.get(a.name) ?? []).filter(x => now - x < 3_600_000)
    turnTimes.set(a.name, t)
    return t.length < limit
  }

  async function runTurn(a: AgentConfig): Promise<void> {
    if (running.has(a.name)) { again.add(a.name); return }
    // Never run headless on a conversation an interactive session (tmux etc.) holds right now.
    // Wait out short reconnect gaps (router restarts) before deciding.
    running.add(a.name)
    await new Promise(r => setTimeout(r, Number(process.env.AGENT_BUS_WAKE_DELAY_MS ?? 8000)))
    running.delete(a.name)
    try {
      const st = JSON.parse(await request('agentStatus', { agent: a.name })) as { live: boolean; mode: string | null }
      if (st.live && st.mode === 'push') { log(`${a.name}: interactive session is live; mail handed to it, no headless turn`); return }
      const holder = conversationHeldLocally(state[a.name]?.session ?? (a.resume !== LAST ? a.resume : undefined))
      if (holder) { log(`${a.name}: conversation is open in ${holder} (its bus client is down); mail stays queued, no headless turn`); return }
    } catch {}
    if (!budgetOk(a)) { log(`${a.name}: turn budget exhausted, messages stay queued`); return }
    running.add(a.name)
    turnTimes.get(a.name)!.push(Date.now())
    const st = state[a.name] ?? {}
    const session = st.session ?? (a.resume === LAST ? LAST : undefined)
    // An adopted conversation already has context; still tell it how headless turns work.
    const prompt = st.session ? WAKE_PROMPT : `${bootstrapPrompt(a, node)}\n\n${WAKE_PROMPT}`
    const { cmd, args, env: cmdEnv } = buildCommand(a, session, prompt, { claudePlugin })
    const nvm = nvmBinDir()
    const basePath = nvm && !(process.env.PATH ?? '').split(':').includes(nvm) ? `${nvm}:${process.env.PATH ?? ''}` : process.env.PATH
    const env = { ...process.env, PATH: basePath, ...cmdEnv, ...Object.fromEntries(Object.entries(a.env ?? {}).map(([k, v]) => [k, expand(v)])),
      DISCORD_SESSION_NAME: a.name, DISCORD_AGENT: a.kind, DISCORD_MODE: 'pull', DISCORD_WAKE: '' }
    const cwd = expand(a.cwd ?? '~')
    log(`${a.name}: turn start (${st.session ? `resume ${st.session.slice(0, 8)}` : session === LAST ? 'adopt last conversation' : 'new session'}) in ${cwd}`)
    const t0 = Date.now()
    const out = await new Promise<string>(res => {
      let buf = ''
      const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      p.stdout.on('data', d => { buf += d })
      p.stderr.on('data', d => { const l = String(d).trim(); if (l) log(`${a.name} stderr: ${l.slice(0, 300)}`) })
      const kill = setTimeout(() => { log(`${a.name}: turn timeout, killing`); p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 5000) }, timeoutMs)
      p.on('close', code => { clearTimeout(kill); if (code) log(`${a.name}: exit ${code}`); res(buf) })
      p.on('error', err => { clearTimeout(kill); log(`${a.name}: spawn failed: ${err.message}`); res('') })
    })
    const r = parseTurnOutput(a.kind, out)
    if (r.session) state[a.name] = { ...state[a.name], session: r.session }
    state[a.name] = { ...state[a.name], lastTurn: new Date().toISOString(), turns: (state[a.name]?.turns ?? 0) + 1 }
    saveState(state)
    log(`${a.name}: turn done in ${Math.round((Date.now() - t0) / 1000)}s${r.error ? ` ERROR ${r.error}` : ''} — ${(r.summary ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)
    running.delete(a.name)
    // More mail arrived during the turn?
    const left = Number(await request('inboxCount', { agent: a.name })) || 0
    if (again.delete(a.name) || left > 0) setTimeout(() => void runTurn(a), 2000)
    maybeExitForUpdate()
  }

  function connect(): void {
    const env = readEnvFile()
    const url = env.DISCORD_ROUTER_URL
    if (!url) { log(`no DISCORD_ROUTER_URL in ${ENV_FILE}; retrying in 30s`); setTimeout(connect, 30_000); return }
    ws = new WebSocket(url)
    ws.onopen = () => {
      attempt = 0
      ws!.send(JSON.stringify({ type: 'registerNode', node, secret: env.DISCORD_ROUTER_SECRET,
        ...(env.DISCORD_NODE_SECRET && { nodeSecret: env.DISCORD_NODE_SECRET }),
        agents: cfg.agents.map(a => ({ name: a.name, kind: a.kind, cwd: expand(a.cwd ?? '~') })) }))
    }
    ws.onmessage = e => {
      const m = JSON.parse(String(e.data))
      if (m.type === 'nodeRegistered') log(`registered node "${node}" with ${m.agents.length} agent(s): ${m.agents.join(', ')}`)
      else if (m.type === 'wake') {
        const a = cfg.agents.find(x => x.name === m.agent)
        if (a) void runTurn(a)
      } else if (m.type === 'mcpExec' && typeof m.callId === 'string') {
        // The router names a server; only the local allowlist decides what may be spawned.
        const reply = (success: boolean, data: string) => {
          try { ws!.send(JSON.stringify({ type: 'mcpResult', callId: m.callId, success, data })) } catch {}
        }
        const r = resolveLocalMcp(localMcp, m as McpExecRequest)
        if (!r.ok) reply(false, r.reason)
        // call() never rejects; the catch is a backstop, since an unhandled rejection would exit the daemon.
        else void mcpChild.call(r.spec).then(out => reply(out.ok, out.data)).catch(err => {
          log(`mcpExec ${m.server} failed: ${err instanceof Error ? err.message : String(err)}`)
          reply(false, `${m.server}: internal error`)
        })
      } else if (m.type === 'toolResult') { pending.get(m.requestId)?.(m.data); pending.delete(m.requestId) }
      else if (m.type === 'error') log(`router error: ${m.message}`)
    }
    ws.onclose = () => {
      const delay = Math.min(30_000, 1000 * 2 ** attempt++)
      log(`router connection closed; reconnecting in ${delay}ms`)
      setTimeout(connect, delay)
    }
    ws.onerror = () => {}
  }

  // Self-update (CI-gated release branch); restart via the service manager when idle.
  let updateReady = false
  function maybeExitForUpdate(): void {
    if (updateReady && running.size === 0) { log('new release checked out; exiting for restart'); process.exit(0) }
  }
  const head = () => { try { return execFileSync('git', ['-C', CODE_DIR, 'rev-parse', 'HEAD']).toString().trim() } catch { return '' } }
  const startHead = head()
  if (existsSync(join(CODE_DIR, '.git')) && process.env.AGENT_BUS_NO_UPDATE !== '1') {
    setInterval(() => {
      try {
        execFileSync('git', ['-C', CODE_DIR, 'fetch', '-q', 'origin', 'release'], { stdio: 'ignore' })
        execFileSync('git', ['-C', CODE_DIR, 'merge', '--ff-only', '-q', 'origin/release'], { stdio: 'ignore' })
      } catch {}
      if (head() !== startHead) {
        try { execFileSync(process.execPath, ['install', '--no-summary'], { cwd: CODE_DIR, stdio: 'ignore' }) } catch {}
        updateReady = true
        maybeExitForUpdate()
      }
    }, 300_000).unref()
  }

  log(`node "${node}" code=${CODE_DIR}@${startHead.slice(0, 7)} config=${CONFIG_FILE} agents=${cfg.agents.map(a => a.name).join(', ')}`)
  connect()
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => { log(`${s}; exiting`); process.exit(0) })
}

if (import.meta.main) {
  main().catch(err => { log(`fatal: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) })
}
