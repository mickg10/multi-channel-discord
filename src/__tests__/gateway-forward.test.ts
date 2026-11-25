import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Inboxes } from '../inboxes.js'
import { Grants, McpAudit, McpRegistry, PendingMcpCalls } from '../mcp.js'
import { Claims, NodeRegistry } from '../nodes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { Subscriptions } from '../subscriptions.js'
import type { GatewayToolCall, WsToolResult } from '../types.js'
import { createWsHandlers, resetBusRateLimit, type WsDeps, type WsLike } from '../ws.js'

const alias = 'codex@mac:caller'
const foreignAlias = 'codex@nas:foreign'
const adminAlias = 'codex@mac:admin'
const instance = 'conversation-1'
const nodeSecret = 'fixture-node-secret'
const digest = createHash('sha256').update(nodeSecret).digest('hex')
const dirs: string[] = []

afterEach(() => {
  resetBusRateLimit()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-forward-'))
  dirs.push(dir)
  const outbound: { channel: string; content: string; reply?: unknown }[] = []
  const channel = { id: 'topic-id', name: 'topic' }
  const grants = new Grants()
  const nodes = new NodeRegistry()
  const claims = new Claims()
  claims.claim('already claimed', foreignAlias)
  const subs = new Subscriptions()
  const deps: WsDeps = {
    sessions: new SessionManager(), history: new ProjectHistory(dir), inboxes: new Inboxes(),
    nodeSecrets: () => ({ hashes: { mac: digest, nas: digest }, require: true }),
    client: { channels: { fetch: async (id: string) => id === 'missing' ? null : ({
      isTextBased: () => true,
      send: async (message: { content: string; reply?: unknown }) => {
        outbound.push({ channel: id, ...message })
        return { id: 'discord-message' }
      },
      messages: { fetch: async () => [{
        id: 'message-id', author: { username: 'author' }, content: 'test message',
        createdAt: new Date(0), attachments: [],
      }] },
    }) } } as unknown as WsDeps['client'],
    busChannelId: 'bus', chatId: () => 'active-chat', chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
    channelOps: {
      resolve: async ref => ref === 'topic' ? channel : null,
      list: async () => [channel],
      create: async () => channel,
    },
    admins: new Set([adminAlias]), subs, claims, nodes, busMaxPerMinute: 1,
    mcp: {
      grants, audit: McpAudit.inStateDir(dir), pending: new PendingMcpCalls(100),
      registry: new McpRegistry([
        { name: 'fixture', node: 'nas', class: 'read-only', methods: ['read'] },
        { name: 'writer', node: 'nas', class: 'side-effecting', methods: ['write'] },
      ]),
    },
  }
  const handlers = createWsHandlers(deps)
  function connect() {
    const frames: Record<string, unknown>[] = []
    const results = new Map<string, WsToolResult>()
    const ws: WsLike = {
      data: { sessionName: null, sendCallback: null },
      send(raw) {
        const frame = JSON.parse(raw)
        frames.push(frame)
        if (frame.type === 'toolResult') results.set(frame.requestId, frame)
      },
    }
    return {
      frames, results,
      send: (frame: object) => handlers.message(ws, JSON.stringify(frame)),
    }
  }
  const node = connect()
  node.send({ type: 'registerNode', node: 'nas', nodeSecret, agents: [] })
  nodes.register('nas', raw => {
    const frame = JSON.parse(raw)
    node.send({ type: 'mcpResult', callId: frame.callId, success: true, data: JSON.stringify({ method: frame.method }) })
  }, [])
  function register(name: string, gateway: boolean) {
    const ws = connect()
    if (gateway) {
      ws.send({ type: 'registerGateway', host: 'mac', user: 'fixture-user', proto: 1, secret: nodeSecret })
      ws.send({ type: 'registerAgent', alias: name, kind: 'codex', conv: instance })
      expect(ws.frames.at(-1)?.type).toBe('agentRegistered')
    } else {
      ws.send({ type: 'register', name, projectPath: '/', instanceId: instance })
      expect(ws.frames.at(-1)?.type).toBe('registered')
    }
    return ws
  }
  return { connect, register, outbound, grants, subs, claims }
}

async function response(socket: ReturnType<ReturnType<typeof setup>['connect']>, requestId: string): Promise<WsToolResult> {
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(socket.results.has(requestId)).toBe(true)
  return socket.results.get(requestId)!
}

test.each([false, true])('A8 shares legacy handling for every operation (gateway=%s)', async gateway => {
  const { register, outbound, grants, subs, claims } = setup()
  const ws = register(alias, gateway)
  let count = 0
  async function call(op: GatewayToolCall['op'], args: Record<string, unknown> = {}) {
    const requestId = `req-${++count}`
    ws.send(gateway
      ? { ...args, type: 'gatewayOp', as: alias, op, requestId }
      : { ...args, type: op === 'busSessions' ? 'listSessions' : op, requestId })
    return response(ws, requestId)
  }

  expect(await call('channelPost', { channel: 'missing', text: 'hello' })).toMatchObject({ success: false })
  expect(await call('channelPost', { channel: 'topic', text: 'hello', publish_id: 'test-publish' })).toMatchObject({
    success: true, data: '{"publish_id":"test-publish","committed":[]}',
  })
  expect(outbound.at(-1)).toMatchObject({ channel: 'topic-id', content: `**[${alias} → subscribers]** hello` })
  expect(await call('channelPost', { channel: 'topic', text: 'over limit' })).toMatchObject({ success: false, data: expect.stringContaining('rate limit') })

  expect(await call('reply', { chatId: 'topic-id', replyTo: 'message-id', text: 'reply' })).toMatchObject({ success: true, data: '{}' })
  expect(outbound.at(-1)).toMatchObject({ channel: 'topic-id', content: `[${alias}] reply`, reply: { messageReference: 'message-id' } })
  expect(await call('reply', { chatId: 'missing', text: 'reply' })).toMatchObject({ success: false, data: 'discord_unavailable' })
  expect(await call('fetchMessages', { channel: 'missing' })).toMatchObject({ success: false, data: 'Channel not found or not text-based' })
  const fetched = await call('fetchMessages', { channel: 'topic-id' })
  expect(fetched.success).toBe(true)
  expect(JSON.parse(fetched.data)).toMatchObject([{ id: 'message-id', content: 'test message' }])
  const sessions = await call('busSessions')
  expect(sessions.success).toBe(true)
  expect(Array.isArray(JSON.parse(sessions.data))).toBe(true)

  expect(JSON.parse((await call('claim', { task: 'already claimed' })).data)).toMatchObject({ won: false, claim: { owner: foreignAlias } })
  expect(JSON.parse((await call('claim', { task: 'mine' })).data)).toMatchObject({ won: true, claim: { owner: alias } })
  expect(JSON.parse((await call('listClaims')).data)).toMatchObject([{ owner: foreignAlias }, { owner: alias }])
  expect(JSON.parse((await call('releaseClaim', { task: 'already claimed' })).data)).toMatchObject({ ok: false, claim: { owner: foreignAlias } })
  expect(JSON.parse((await call('releaseClaim', { task: 'mine' })).data)).toEqual({ ok: true })
  expect(claims.list().map(claim => claim.owner)).toEqual([foreignAlias])

  const servers = await call('mcpList')
  expect(servers.success).toBe(true)
  expect(JSON.parse(servers.data).map((server: { name: string }) => server.name)).toEqual(['fixture', 'writer'])
  expect(await call('mcpDescribe', { server: 'missing' })).toMatchObject({ success: false, data: expect.stringContaining('not declared') })
  expect(await call('mcpDescribe', { server: 'fixture' })).toMatchObject({ success: true, data: '{"method":"tools/list"}' })
  expect(await call('mcpCall', { server: 'fixture', method: 'blocked' })).toMatchObject({ success: false, data: expect.stringContaining('not allowlisted') })
  expect(await call('mcpCall', { server: 'fixture', method: 'read' })).toMatchObject({ success: true, data: '{"method":"read"}' })
  const wrong = grants.issue('writer', { session: alias, instance: 'different-instance' })
  expect(await call('mcpCall', { server: 'writer', method: 'write', grant: wrong.id, instanceId: 'different-instance' })).toMatchObject({ success: false, data: expect.stringContaining('grant rejected') })
  const valid = grants.issue('writer', { session: alias, instance })
  expect(await call('mcpCall', { server: 'writer', method: 'write', grant: valid.id })).toMatchObject({ success: true, data: '{"method":"write"}' })

  expect(await call('channelSubscribe', { channel: 'topic', session: foreignAlias })).toMatchObject({ success: false, data: 'only admin sessions may act for another session' })
  expect(await call('channelSubscribe', { channel: 'missing' })).toMatchObject({ success: false })
  expect(await call('channelSubscribe', { channel: 'topic' })).toMatchObject({ success: true })
  expect(subs.has(alias, 'topic-id')).toBe(true)
  const channels = await call('channelList')
  expect(channels.success).toBe(true)
  expect(JSON.parse(channels.data)).toMatchObject([{ id: 'topic-id', subscribed: true }])
})

test.each([false, true])('A8 preserves delegated admin subscription (gateway=%s)', async gateway => {
  const { register, subs } = setup()
  const admin = register(adminAlias, gateway)
  admin.send({
    ...(gateway ? { type: 'gatewayOp', as: adminAlias, op: 'channelSubscribe' } : { type: 'channelSubscribe' }),
    requestId: 'admin', channel: 'topic', session: foreignAlias,
  })
  expect(await response(admin, 'admin')).toMatchObject({ success: true })
  expect(subs.has(foreignAlias, 'topic-id')).toBe(true)
})

test('A8 rejects unregistered, foreign, released, and unsupported gateway calls', async () => {
  const { register, connect, outbound } = setup()
  const ws = register(alias, true)
  const stranger = connect()
  stranger.send({ type: 'registerGateway', host: 'nas', user: 'fixture-user', proto: 1, secret: nodeSecret })
  stranger.send({ type: 'registerAgent', alias: foreignAlias, kind: 'codex', conv: 'foreign-instance' })
  const reply = { type: 'gatewayOp', op: 'reply', chatId: 'topic-id', text: 'should not send' }
  stranger.send({ ...reply, as: alias, requestId: 'foreign' })
  ws.send({ ...reply, requestId: 'unbound', as: 'unregistered' })
  const unregistered = connect()
  unregistered.send({ ...reply, requestId: 'unregistered', as: alias })
  ws.send({ type: 'gatewayOp', op: 'register', as: alias, requestId: 'unsupported', name: 'intruder', projectPath: '/' })
  ws.send({ type: 'gatewayOp', op: 'constructor', as: alias, requestId: 'prototype' })
  ws.send({ ...reply, op: ['reply'], as: alias, requestId: 'malformed' })
  ws.send({ type: 'releaseAgent', alias })
  ws.send({ ...reply, as: alias, requestId: 'released' })
  expect(await response(stranger, 'foreign')).toMatchObject({ success: false, data: 'invalid_as' })
  expect(await response(unregistered, 'unregistered')).toMatchObject({ success: false, data: 'gateway_not_registered' })
  for (const requestId of ['unsupported', 'prototype', 'malformed']) {
    expect(await response(ws, requestId)).toMatchObject({ success: false, data: 'unsupported_gateway_operation' })
  }
  for (const requestId of ['unbound', 'released']) {
    expect(await response(ws, requestId)).toMatchObject({ success: false, data: 'invalid_as' })
  }
  expect(outbound).toEqual([])
})
