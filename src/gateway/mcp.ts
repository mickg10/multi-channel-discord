import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Transform, type Readable, type Writable } from 'node:stream'
import type { AgentRec } from './registry.js'

const string = { type: 'string' }
const tools = {
  check_inbox: ['lease', 'Read messages addressed to this session. Echo the previous receipt to acknowledge those messages.', { receipt: string }, []],
  bus_post: ['busPost', 'Send a message to another AI agent (or all agents) over the shared Discord agent bus. The message is also shown in the bus channel for the human.', { text: string, to: string, publish_id: string }, ['text']],
  channel_post: ['channelPost', 'Post in a Discord channel of the agent-bus server (id, name or #name). Delivered to agents subscribed to it (or only to "to"; "human" = channel only). Shown in Discord.', { channel: string, text: string, to: string, publish_id: string }, ['channel', 'text']],
  reply: ['reply', 'Reply on Discord. For agent-to-agent messages use bus_post instead.', { text: string, chat_id: string, reply_to: string }, ['text']],
  fetch_messages: ['fetchMessages', 'Fetch recent messages from a Discord channel.', { channel: string, limit: { type: 'integer' } }, ['channel']],
  bus_sessions: ['busSessions', 'List the agent sessions connected to the Discord router (your own is marked).', {}, []],
  claim: ['claim', 'Atomically claim a task so other agents do not duplicate it. First claim wins.', { task: string, note: string }, ['task']],
  release_claim: ['releaseClaim', 'Release your claim on a task when done, or hand it to another agent with to=<name>.', { task: string, to: string }, ['task']],
  list_claims: ['listClaims', 'List current task claims (owner, since). Claims expire after 12h.', {}, []],
  mcp_list: ['mcpList', 'List remote MCP servers shared over the agent bus.', {}, []],
  mcp_describe: ['mcpDescribe', 'Get one shared MCP server’s declaration and live tool list with input schemas.', { server: string }, ['server']],
  mcp_call: ['mcpCall', 'Call a tool on a shared remote MCP server over the agent bus. Side-effecting servers require a Mick-issued grant ID. Every call is audited by the router.', { server: string, method: string, params: {}, grant: string }, ['server', 'method']],
} satisfies Record<string, [string, string, Record<string, { type?: string }>, string[]]>

const wireKeys: Record<string, string> = { chat_id: 'chatId', reply_to: 'replyTo' }
const readOnly = new Set(['fetch_messages', 'bus_sessions', 'list_claims', 'mcp_list', 'mcp_describe'])
const maxFrameBytes = 1024 * 1024

export function resolveMcpAgent(agents: readonly AgentRec[], meta: Record<string, unknown> | undefined): AgentRec | undefined {
  const candidates = agents.filter(agent => {
    if (agent.kind === 'codex') return meta?.threadId === agent.conv
    if (agent.kind === 'opencode') return meta?.['ai.opencode/sessionID'] === agent.conv
    return agents.length === 1 && meta?.threadId === undefined && meta?.['ai.opencode/sessionID'] === undefined
  })
  if (meta?.threadId !== undefined && meta?.['ai.opencode/sessionID'] !== undefined) return
  return candidates.length === 1 ? candidates[0] : undefined
}

export function serveGatewayMcp(
  input: Readable,
  output: Writable,
  agentsForCall: () => readonly AgentRec[],
  matches: (agent: AgentRec) => boolean,
  invoke: (agent: AgentRec, op: string, args: Record<string, unknown>) => Promise<string>,
): Promise<void> {
  const mcp = new Server({ name: 'agent-bus-gateway', version: '1.0.0' }, { capabilities: { tools: {} } })
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, [, description, properties, required]]) => ({
      name, description, inputSchema: { type: 'object' as const, properties, required, additionalProperties: false },
      ...(readOnly.has(name) && { annotations: { readOnlyHint: true } }),
    })),
  }))
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const agent = resolveMcpAgent(agentsForCall(), params._meta)
    const error = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })
    if (!agent || !matches(agent)) return error('Conversation identity is missing, mismatched, or stale')
    if (!Object.hasOwn(tools, params.name)) return error('Unknown gateway tool')
    const [op, , properties, required] = tools[params.name as keyof typeof tools]
    const args = params.arguments ?? {}
    const fields: Record<string, unknown> = {}
    if (required.some(key => !Object.hasOwn(args, key))) return error('Missing required tool argument')
    for (const [key, value] of Object.entries(args)) {
      const schema = (properties as Record<string, { type?: string }>)[key]
      if (!Object.hasOwn(properties, key) || (schema?.type === 'string' && typeof value !== 'string')
        || (schema?.type === 'integer' && !Number.isSafeInteger(value))) return error('Invalid tool argument')
      fields[wireKeys[key] ?? key] = value
    }
    try {
      const text = await invoke(agent, op, fields)
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      return error(err instanceof Error ? err.message : 'Router request failed')
    }
  })
  let frameBytes = 0
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        frameBytes += end - offset
        if (frameBytes > maxFrameBytes) {
          callback(new Error('MCP frame too large'))
          return
        }
        if (newline < 0) break
        frameBytes = 0
        offset = newline + 1
      }
      callback(null, chunk)
    },
  })
  bounded.once('error', () => { input.destroy(); output.destroy() })
  output.once('close', () => { bounded.destroy(); void mcp.close() })
  return mcp.connect(new StdioServerTransport(bounded, output)).then(() => { input.pipe(bounded) })
}
