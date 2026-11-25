import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INBOX_MAX, Inboxes, LEASE_MS } from '../inboxes.js'
import { NodeRegistry } from '../nodes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { nudgeText, type LeaseResult } from '../types.js'
import { Conversations, WakeBudget } from '../wake.js'
import { createWsHandlers, deliver, resetBusRateLimit, type WsDeps, type WsLike } from '../ws.js'

const dirs: string[] = []
const alias = 'codex@mac:one'
const other = 'codex@mac:two'
const secret = 'test-node-secret'
const digest = createHash('sha256').update(secret).digest('hex')
type Frame = { type: string; requestId?: string; success?: boolean; data?: string; [key: string]: unknown }

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  resetBusRateLimit()
})

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'bus-v4-'))
  dirs.push(dir)
  return dir
}

function router(dir: string, extra: Partial<WsDeps> = {}) {
  const deps: WsDeps = {
    sessions: new SessionManager(), history: new ProjectHistory(dir), inboxes: Inboxes.inStateDir(dir),
    nodes: new NodeRegistry(), conversations: new Conversations(), busChannelId: 'bus',
    client: { channels: { fetch: async () => null } } as unknown as WsDeps['client'],
    nodeSecrets: () => ({ hashes: { mac: digest, nas: digest }, require: false }),
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first', ...extra,
  }
  const handlers = createWsHandlers(deps)
  function connect() {
    const frames: Frame[] = []
    let fail: ((frame: Frame) => boolean) | undefined
    const ws: WsLike = { data: { sessionName: null, sendCallback: null }, send: parse }
    function parse(raw: string) {
      const frame = JSON.parse(raw) as Frame
      if (fail?.(frame)) throw new Error('socket closed')
      frames.push(frame)
    }
    return {
      frames, failWhen: (predicate: (frame: Frame) => boolean) => { fail = predicate },
      close: () => handlers.close({ ...ws }),
      send: (frame: object) => handlers.message({ ...ws }, JSON.stringify(frame)),
      result: (requestId: string) => frames.findLast(frame => frame.requestId === requestId),
    }
  }
  return { deps, connect, inboxes: deps.inboxes! }
}

type Connection = ReturnType<ReturnType<typeof router>['connect']>
function gateway(ws: Connection, host = 'mac') {
  ws.send({ type: 'registerGateway', host, user: 'mick', proto: 1, secret })
  expect(ws.frames.at(-1)?.type).toBe('gatewayRegistered')
}
function agent(ws: Connection, name: string, conv: string) {
  ws.send({ type: 'registerAgent', kind: 'codex', conv, alias: name })
}
function legacy(ws: Connection, name: string, mode = 'push') {
  ws.send({ type: 'register', name, mode, projectPath: '/project' })
}
function lease(ws: Connection, name: string, receipt?: string): LeaseResult {
  ws.send({ type: 'lease', as: name, requestId: 'lease', ...(receipt && { receipt }) })
  const result = ws.result('lease')
  expect(result?.success).toBe(true)
  return JSON.parse(result!.data!)
}

test('a lost publish reply deduplicates every target across restart and Discord outage', async () => {
  const dir = directory()
  const a = router(dir)
  const gw = a.connect()
  gateway(gw)
  agent(gw, alias, 'A')
  agent(gw, other, 'B')
  const sender = a.connect()
  legacy(sender, 'sender')
  const post = { type: 'busPost', text: 'hello', to: 'all', requestId: 'publish', publish_id: 'client-token' }
  sender.failWhen(frame => frame.requestId === 'publish')
  sender.send(post)
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(sender.result('publish')).toBeUndefined()
  const firstIds = [alias, other].map(name => a.inboxes.list(a.inboxes.key(name))[0]?.id)

  const b = router(dir, {
    client: { channels: { fetch: async () => { throw new Error('Discord unavailable') } } } as unknown as WsDeps['client'],
  })
  const retry = b.connect()
  legacy(retry, 'sender')
  retry.send(post)
  expect(JSON.parse(retry.result('publish')!.data!)).toEqual({ publish_id: 'client-token', committed: [alias, other] })
  expect([alias, other].map(name => b.inboxes.list(b.inboxes.key(name)).map(entry => entry.id))).toEqual(firstIds.map(id => [id]))
})

test('a lost lease survives restart and only the current receipt acknowledges that identity', () => {
  const dir = directory()
  const a = router(dir)
  const gw = a.connect()
  gateway(gw)
  agent(gw, alias, 'A')
  agent(gw, other, 'B')
  deliver(a.deps, alias, 'hello', { from: 'original', from_human: 'true' })
  gw.failWhen(frame => frame.requestId === 'lost')
  gw.send({ type: 'lease', as: alias, requestId: 'lost' })
  const pending = a.inboxes.list(a.inboxes.key(alias))[0]!
  expect(pending.lease).toBeDefined()
  const b = router(dir)
  const reconnect = b.connect()
  gateway(reconnect)
  agent(reconnect, alias, 'A')
  agent(reconnect, other, 'B')
  reconnect.send({ type: 'agentStatus', as: alias, requestId: 'status' })
  expect(JSON.parse(reconnect.result('status')!.data!).pending).toBe(1)
  expect(lease(reconnect, alias).messages).toEqual([])
  reconnect.send({ type: 'ack', as: alias, id: pending.id, leaseId: pending.lease!.id, requestId: 'missing' })
  expect(reconnect.result('missing')?.data).toBe('invalid_receipt')
  reconnect.send({ type: 'lease', as: other, receipt: pending.lease!.receipt, requestId: 'wrong' })
  expect(reconnect.result('wrong')?.data).toBe('invalid_receipt')

  const realNow = Date.now
  Date.now = () => pending.lease!.until + 1
  try {
    const next = lease(reconnect, alias)
    expect(next.messages).toMatchObject([{ id: pending.id, from: 'original', from_human: true, body: 'hello' }])
    expect(next.receipt).not.toBe(pending.lease!.receipt)
    reconnect.send({ type: 'lease', as: alias, receipt: pending.lease!.receipt, requestId: 'stale' })
    expect(reconnect.result('stale')?.data).toBe('invalid_receipt')
    expect(lease(reconnect, alias, next.receipt).messages).toEqual([])
    expect(b.inboxes.count(alias)).toBe(0)
  } finally { Date.now = realNow }
})

test('status, exhausted budget and failed live push preserve mail across restart', () => {
  const dir = directory()
  const a = router(dir, { budget: new WakeBudget({ cheap: 1, standard: 1, premium: 1 }) })
  const node = a.connect()
  node.send({ type: 'registerNode', node: 'nas', nodeSecret: secret, agents: [{ name: 'cold', kind: 'codex' }] })
  const live = a.connect()
  legacy(live, 'live')
  live.failWhen(frame => frame.type === 'message')
  expect(deliver(a.deps, 'live', 'push fails', {})).toBe(true)
  expect(deliver(a.deps, 'cold', 'one', {})).toBe(true)
  expect(deliver(a.deps, 'cold', 'two', {})).toBe(true)
  expect(node.frames.filter(frame => frame.type === 'wake')).toHaveLength(1)
  node.send({ type: 'agentStatus', agent: 'live', requestId: 'status' })
  expect(JSON.parse(node.result('status')!.data!)).toMatchObject({ live: true, pending: 1 })

  const b = router(dir)
  expect(b.inboxes.count('cold')).toBe(2)
  const retry = b.connect()
  legacy(retry, 'live')
  expect(retry.frames.find(frame => frame.type === 'message')?.content).toBe('push fails')
  expect(b.inboxes.count('live')).toBe(0)
})

test('overflow rejects the publisher and leaves every older entry intact', () => {
  const inboxes = new Inboxes()
  inboxes.commit(Array.from({ length: INBOX_MAX }, () => ({ name: 'full', content: 'already committed', meta: {} })))
  const a = router(directory(), { inboxes })
  const recipient = a.connect()
  legacy(recipient, 'full', 'pull')
  const sender = a.connect()
  legacy(sender, 'sender')
  sender.send({ type: 'busPost', text: 'overflow', to: 'full', requestId: 'publish', publish_id: 'overflow' })
  expect(sender.result('publish')).toMatchObject({ success: false, data: 'inbox_full' })
  expect(inboxes.count('full')).toBe(INBOX_MAX)
  expect(inboxes.list('full').every(entry => entry.content === 'already committed')).toBe(true)
})

test('gateway host authentication and ownership apply across socket wrappers and replacements', () => {
  const a = router(directory())
  const gw = a.connect()
  gw.send({ type: 'registerGateway', host: 'mac', user: 'mick', proto: 1 })
  expect(gw.frames.at(-1)?.type).toBe('error')
  gw.send({ type: 'registerGateway', host: 'unknown', user: 'mick', proto: 1, secret })
  expect(gw.frames.at(-1)?.type).toBe('error')
  gateway(gw)
  agent(gw, 'codex@nas:one', 'A')
  expect(gw.frames.at(-1)?.type).toBe('error')
  agent(gw, alias, 'A')
  const nas = a.connect()
  gateway(nas, 'nas')
  nas.send({ type: 'lease', as: alias, requestId: 'foreign' })
  expect(nas.result('foreign')?.data).toBe('invalid_as')
  gw.send({ type: 'lease', requestId: 'missing' })
  expect(gw.result('missing')?.data).toBe('invalid_as')
  const old = a.connect()
  legacy(old, alias)
  expect(old.frames.at(-1)?.type).toBe('replaced')
  const replacement = a.connect()
  gateway(replacement)
  agent(replacement, alias, 'A')
  gw.send({ type: 'lease', as: alias, requestId: 'stale' })
  expect(gw.result('stale')?.data).toBe('gateway_not_registered')
  gw.close()
  expect(lease(replacement, alias).messages).toEqual([])
})

test('restart reconciles one durable wake and held remains final', () => {
  const dir = directory()
  const a = router(dir)
  const gw = a.connect()
  gateway(gw)
  agent(gw, alias, 'A')
  deliver(a.deps, alias, 'first', {})
  deliver(a.deps, alias, 'second', {})
  const sent = gw.frames.filter(frame => frame.type === 'wake')
  expect(sent).toHaveLength(1)
  const { msgId, text, clientId } = sent[0]!.nudge as { msgId: string; text: string; clientId: string }
  const hash = createHash('sha256').update('A:' + msgId).digest('hex')
  expect(text).toBe(nudgeText(parseInt(hash.slice(0, 13), 16)))
  expect(clientId).toBe('bus-' + hash.slice(0, 32))
  expect(a.inboxes.get(msgId)?.state).toBe('uncertain')

  const b = router(dir)
  const next = b.connect()
  gateway(next)
  agent(next, alias, 'A')
  expect(next.frames.filter(frame => frame.type === 'wake')).toEqual([{ ...sent[0], reconcile: true }])
  next.send({ type: 'wakeResult', as: alias, id: msgId, result: { s: 'held' }, requestId: 'held' })
  expect(next.result('held')?.success).toBe(true)
  next.send({ type: 'mark', as: alias, id: msgId, state: 'uncertain', requestId: 'retry' })
  expect(next.result('retry')?.data).toBe('invalid_wake_transition')
  expect(lease(next, alias).messages.map(message => message.state)).toEqual(['held', 'committed'])
})

test('startup migrates legacy mail and ignores an incomplete final append', () => {
  const dir = directory()
  writeFileSync(join(dir, 'inboxes.json'), JSON.stringify({
    [alias]: [
      { content: 'old mail', meta: {}, at: 'yesterday' },
      { content: 'approval for B', meta: { from_human: 'true', question_id: 'question', conversation_id: 'B' }, at: 'yesterday' },
    ],
  }))
  const a = router(dir)
  const gw = a.connect()
  gateway(gw)
  agent(gw, alias, 'A')
  const first = lease(gw, alias)
  expect(first.messages.map(message => message.body)).toEqual(['old mail'])
  agent(gw, alias, 'B')
  expect(lease(gw, alias).messages.map(message => message.body)).toEqual(['approval for B'])
  agent(gw, alias, 'A')
  appendFileSync(join(dir, 'inboxes.jsonl'), '{"op":')
  const b = router(dir).inboxes
  const key = b.key(alias)
  expect(b.lease(key, undefined, Date.now() + LEASE_MS + 1).messages[0]?.id).toBe(first.messages[0]?.id)
})
