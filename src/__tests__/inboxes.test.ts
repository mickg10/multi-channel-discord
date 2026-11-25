import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INBOX_MAX, Inboxes, LEASE_MS, PUBLISH_TTL_MS } from '../inboxes.js'
import { NodeRegistry } from '../nodes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { buildNudge, type Kind, type LeaseResult } from '../types.js'
import { Conversations, WakeBudget } from '../wake.js'
import { createWsHandlers, deliver, resetBusRateLimit, type WsDeps, type WsLike } from '../ws.js'

const dirs: string[] = []
const alias = 'codex@mac:one'
const other = 'codex@mac:two'
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
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
    nodeSecrets: () => ({ hashes: { mac: digest, nas: digest, nas642: digest }, require: false }),
    gatewayAliasHosts: () => ({ opencode_nas642_glm53_abli: 'nas642' }),
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first', ...extra,
  }
  const handlers = createWsHandlers(deps)
  function connect() {
    const frames: Frame[] = []
    let fail: ((frame: Frame) => boolean) | undefined
    const closed = spyOn({ close: () => {} }, 'close')
    const ws: WsLike = { data: { sessionName: null, sendCallback: null }, send: parse, close: closed }
    function parse(raw: string) {
      const frame = JSON.parse(raw) as Frame
      if (fail?.(frame)) throw new Error('socket closed')
      frames.push(frame)
    }
    return {
      frames, closed, failWhen: (predicate: (frame: Frame) => boolean) => { fail = predicate },
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
function agent(ws: Connection, name: string, conv: string, kind: Kind = 'codex') {
  ws.send({ type: 'registerAgent', kind, conv, alias: name })
}
function legacy(ws: Connection, name: string, mode = 'push', conversationId?: string) {
  ws.send({ type: 'register', name, mode, projectPath: '/project', conversationId })
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
  await tick()
  expect(JSON.parse(retry.result('publish')!.data!)).toEqual({ publish_id: 'client-token', committed: [alias, other], mirror: 'failed' })
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
    const next = lease(reconnect, alias, pending.lease!.receipt)
    expect(next.receipt_status).toBe('stale')
    expect(next.messages).toMatchObject([{ id: pending.id, from: 'original', from_human: true, body: 'hello' }])
    expect(next.receipt).not.toBe(pending.lease!.receipt)
    reconnect.send({ type: 'lease', as: alias, receipt: pending.lease!.receipt, requestId: 'stale' })
    expect(JSON.parse(reconnect.result('stale')!.data!)).toMatchObject({ messages: [], receipt_status: 'stale' })
    expect(lease(reconnect, alias, next.receipt).messages).toEqual([])
    expect(b.inboxes.count(alias)).toBe(0)
    reconnect.send({ type: 'lease', as: other, receipt: next.receipt, requestId: 'consumed-foreign' })
    expect(reconnect.result('consumed-foreign')?.data).toBe('invalid_receipt')
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
  expect(gw.frames.at(-1)).toEqual({ type: 'replaced', name: 'mac' })
  expect(gw.closed).toHaveBeenCalledTimes(1)
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
  const msgId = sent[0]!.msgId as string
  expect(sent[0]).toEqual({ type: 'wake', as: alias, msgId, n: 1 })
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
  const pending = lease(next, alias)
  expect(pending.messages.map(message => message.state)).toEqual(['held', 'committed'])
  lease(next, alias, pending.receipt)
  const c = router(dir)
  const third = c.connect()
  gateway(third)
  agent(third, alias, 'A')
  deliver(c.deps, alias, 'new message', {})
  expect(third.frames.find(frame => frame.type === 'wake')).toMatchObject({ n: 2 })
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

test.each([
  ['claude', '252c7b9aaa481d9789fcd8fe9b6af065'],
  ['codex', 'bus-252c7b9aaa481d9789fcd8fe9b6af065'],
  ['opencode', 'msg_bus252c7b9aaa481d9789fcd8fe'],
  ['grok', '252c7b9aaa481d9789fcd8fe9b6af065'],
  ['agy', '252c7b9aaa481d9789fcd8fe9b6af065'],
] satisfies [Kind, string][])('buildNudge matches the fixed %s vector', (kind, clientId) => {
  expect(buildNudge(kind, 'conversation-42', 'bus-message-7', 12)).toEqual({
    msgId: 'bus-message-7', clientId, text: '[agent-bus] mail waiting (id 12) — call check_inbox',
  })
  expect(() => buildNudge(kind, 'conversation-42', '', 12)).toThrow('Invalid bus message id')
  expect(() => buildNudge(kind, 'conversation-42', 'bus-message-7', -1)).toThrow('Invalid nudge id')
})

test('unknown receipts leave current leases alone and do not block other mail', () => {
  const inboxes = new Inboxes()
  inboxes.push('recipient', 'first', {})
  const old = inboxes.lease('recipient')
  inboxes.push('recipient', 'second', {})
  const next = inboxes.lease('recipient', 'unknown')
  expect(next.receipt_status).toBe('stale')
  expect(next.messages.map(message => message.body)).toEqual(['second'])
  inboxes.lease('recipient', old.receipt)
  expect(inboxes.count('recipient')).toBe(1)
})

test.each([{ records: 3, bytes: Infinity }, { records: Infinity, bytes: 1 }])(
  'online compaction preserves live leases and removes expired publish dedup records',
  limits => {
    const dir = directory()
    const path = join(dir, 'inboxes.jsonl')
    const inboxes = Inboxes.inStateDir(dir, limits)
    const now = Date.now()
    inboxes.commit([{ name: 'recipient', content: 'pending', meta: {} }], {
      key: 'expired', at: now - PUBLISH_TTL_MS, result: { publish_id: 'expired', committed: ['recipient'] },
    })
    const old = inboxes.lease('recipient')
    inboxes.commit([], { key: 'fresh', at: now, result: { publish_id: 'fresh', committed: [] } })
    expect(readFileSync(path, 'utf8')).not.toContain('"publish_id":"expired"')
    const restarted = Inboxes.inStateDir(dir)
    expect(restarted.publish('fresh')?.result.publish_id).toBe('fresh')
    expect(restarted.lease('recipient', old.receipt).messages).toEqual([])
    expect(restarted.count('recipient')).toBe(0)
  },
)

test('startup reports the path and line of corrupt records and saves an intact copy', () => {
  const dir = directory()
  const path = join(dir, 'inboxes.jsonl')
  const source = '{"op":"commit","entries":[]}\n{"private":"corrupt"\n{"op":"commit","entries":[]}\n'
  writeFileSync(path, source, { mode: 0o600 })
  const output = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(() => Inboxes.inStateDir(dir)).toThrow('line 2')
    const copy = readdirSync(dir).find(name => name.startsWith('inboxes.jsonl.corrupt-'))
    expect(copy).toBeDefined()
    expect(readFileSync(join(dir, copy!), 'utf8')).toBe(source)
    expect(readFileSync(path, 'utf8')).toBe(source)
    const logged = output.mock.calls.map(call => String(call[0])).join('')
    expect(logged).toContain(path + ' line 2')
    expect(logged).not.toContain('"private"')
  } finally { output.mockRestore() }
})

test('a changed legacy conversation receives ordinary mail and only its own approvals', () => {
  const dir = directory()
  const a = router(dir)
  const before = a.connect()
  legacy(before, 'legacy', 'pull', 'old')
  deliver(a.deps, 'legacy', 'ordinary', {})
  deliver(a.deps, 'legacy', 'old approval', { from_human: 'true', question_id: 'q1' })
  const b = router(dir)
  const after = b.connect()
  legacy(after, 'legacy', 'pull', 'new')
  after.send({ type: 'inboxPull', requestId: 'pull' })
  expect(JSON.parse(after.result('pull')!.data!).map((entry: { content: string }) => entry.content)).toEqual(['ordinary'])
  expect(b.inboxes.count('legacy')).toBe(1)
})

test('native registration preserves each existing alias verbatim and rekeys its queued mail', () => {
  const a = router(directory())
  const mac = a.connect(), nas = a.connect()
  gateway(mac)
  gateway(nas, 'nas642')
  const fixtures = [
    [nas, 'codex@nas642', 'codex'],
    [mac, 'codex@mac', 'codex'],
    [nas, 'codex-photos@nas642', 'codex'],
    [nas, 'opencode_nas642_glm53_abli', 'opencode'],
  ] satisfies [Connection, string, Kind][]
  for (const [gw, name, kind] of fixtures) {
    a.inboxes.push(name, 'queued for ' + name, { from: 'original' })
    agent(gw, name, name, kind)
    expect(gw.frames.findLast(frame => frame.type === 'agentRegistered')?.as).toBe(name)
    expect(lease(gw, name).messages).toMatchObject([{ body: 'queued for ' + name, from: 'original' }])
  }
})

test('only the gateway owner can release an alias and old identity mail survives a rollback', () => {
  const dir = directory()
  const a = router(dir)
  const gw = a.connect(), foreign = a.connect()
  gateway(gw)
  gateway(foreign, 'nas')
  agent(gw, alias, 'A')
  deliver(a.deps, alias, 'old native mail', {})
  foreign.send({ type: 'releaseAgent', alias, requestId: 'foreign-release' })
  expect(foreign.result('foreign-release')?.data).toBe('invalid_as')
  const old = a.connect()
  legacy(old, alias)
  expect(old.frames.at(-1)?.type).toBe('replaced')
  gw.send({ type: 'releaseAgent', alias, requestId: 'release' })
  expect(gw.result('release')?.success).toBe(true)

  const b = router(dir)
  const rollback = b.connect()
  legacy(rollback, alias)
  expect(rollback.frames.at(-1)?.type).toBe('registered')
  const restarted = b.connect()
  gateway(restarted)
  agent(restarted, alias, 'B')
  expect(lease(restarted, alias).messages).toEqual([])
  agent(restarted, alias, 'A')
  expect(lease(restarted, alias).messages).toMatchObject([{ body: 'old native mail' }])
})

function discord(send: (content: string) => { id: string } | Promise<{ id: string }>): WsDeps['client'] {
  return { channels: { fetch: async () => ({
    isTextBased: () => true, send: async (message: { content: string }) => send(message.content),
  }) } } as unknown as WsDeps['client']
}

test('human-only Discord failure is retryable without reporting an empty success', async () => {
  const dir = directory()
  const a = router(dir)
  const sender = a.connect()
  legacy(sender, 'sender')
  const post = { type: 'busPost', to: 'human', text: 'hello human', publish_id: 'opaque', requestId: 'post' }
  sender.send(post)
  await tick()
  expect(sender.result('post')).toMatchObject({ success: false, data: 'discord_unavailable' })
  const sent: string[] = []
  const b = router(dir, { client: discord(content => { sent.push(content); return { id: 'discord-id' } }) })
  const retry = b.connect()
  legacy(retry, 'sender')
  retry.send(post)
  await tick()
  expect(retry.result('post')?.success).toBe(true)
  expect(sent).toEqual(['**[sender → human]** hello human'])
  retry.send(post)
  await tick()
  expect(sent).toHaveLength(1)
})

test('retrying a mixed publish repairs its mirror without committing or waking again', async () => {
  const dir = directory()
  const a = router(dir)
  legacy(a.connect(), 'recipient', 'pull')
  const sender = a.connect()
  legacy(sender, 'sender')
  const post = { type: 'busPost', to: 'recipient', text: 'mixed', publish_id: 'opaque', requestId: 'post' }
  sender.send(post)
  await tick()
  expect(JSON.parse(sender.result('post')!.data!)).toEqual({ publish_id: 'opaque', committed: ['recipient'], mirror: 'failed' })
  const id = a.inboxes.list('recipient')[0]?.id

  const sent: string[] = []
  const b = router(dir, { client: discord(content => { sent.push(content); return { id: 'discord-id' } }) })
  const retry = b.connect()
  legacy(retry, 'sender')
  retry.send(post)
  await tick()
  expect(JSON.parse(retry.result('post')!.data!)).toEqual({ publish_id: 'opaque', committed: ['recipient'] })
  expect(b.inboxes.list('recipient').map(entry => entry.id)).toEqual([id])
  retry.send(post)
  await tick()
  expect(sent).toEqual(['**[sender → recipient]** mixed'])
})

test('a directed bus post logs its committed id and path without the body', async () => {
  const a = router(directory())
  legacy(a.connect(), 'recipient', 'pull')
  const sender = a.connect()
  legacy(sender, 'sender')
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    const body = 'private-body-marker'
    sender.send({ type: 'busPost', to: 'recipient', text: body, requestId: 'post' })
    await tick()
    expect(JSON.parse(sender.result('post')!.data!).publish_id).toMatch(/^pub_\d+_[\da-f-]{36}$/)
    const id = a.inboxes.list('recipient')[0]!.id
    const output = stderr.mock.calls.map(call => String(call[0])).join('')
    expect(output).toBe(`deliver ${id} sender -> recipient state=committed path=inbox\n`)
    expect(output + stdout.mock.calls.map(call => String(call[0])).join('')).not.toContain(body)
  } finally { stderr.mockRestore(); stdout.mockRestore() }
})

test('a later directed message wakes a cold inbox after its budget refills', () => {
  const a = router(directory(), { budget: new WakeBudget({ cheap: 1, standard: 1, premium: 1 }, 50) })
  const node = a.connect()
  node.send({ type: 'registerNode', node: 'nas', nodeSecret: secret, agents: [{ name: 'cold', kind: 'codex' }] })
  const realNow = Date.now
  const now = realNow()
  Date.now = () => now
  try {
    deliver(a.deps, 'cold', 'uses the budget', {})
    deliver(a.deps, 'cold', 'waits for a wake', {})
    expect(node.frames.filter(frame => frame.type === 'wake')).toHaveLength(1)
    Date.now = () => now + 51
    deliver(a.deps, 'cold', 'wakes the backlog', {})
    expect(node.frames.filter(frame => frame.type === 'wake').at(-1)).toMatchObject({ pending: 3 })
    expect(a.inboxes.count('cold')).toBe(3)
  } finally { Date.now = realNow }
})

test.each(['woken', 'uncertain'] as const)('a first read of an %s wake reopens the latch without acknowledging mail', async state => {
  const dir = directory()
  const a = router(dir)
  const gw = a.connect()
  gateway(gw)
  agent(gw, alias, 'A')
  const sender = a.connect()
  legacy(sender, 'sender')
  sender.send({ type: 'busPost', to: alias, text: 'A', requestId: 'a' })
  await tick()
  const first = gw.frames.find(frame => frame.type === 'wake')!
  if (state === 'woken') gw.send({
    type: 'wakeResult', as: alias, id: first.msgId, result: { s: 'woken', nativeId: 'native-A' }, requestId: 'wake-a',
  })
  const leased = lease(gw, alias, 'unknown-previous-receipt')
  expect(leased.receipt_status).toBe('stale')
  expect(leased.messages).toMatchObject([{ id: first.msgId, state: 'leased' }])
  expect(a.inboxes.count(alias)).toBe(1)

  const b = router(dir)
  const next = b.connect()
  gateway(next)
  agent(next, alias, 'A')
  expect(next.frames.some(frame => frame.type === 'wake')).toBe(false)
  if (state === 'uncertain') next.send({
    type: 'wakeResult', as: alias, id: first.msgId, result: { s: 'woken', nativeId: 'native-A' }, requestId: 'late-wake-a',
  })
  const posting = b.connect()
  legacy(posting, 'sender')
  posting.send({ type: 'busPost', to: alias, text: 'B', requestId: 'b' })
  await tick()
  const second = next.frames.find(frame => frame.type === 'wake')
  expect(second).toMatchObject({ n: 2 })
  expect(second?.msgId).not.toBe(first.msgId)
  expect(b.inboxes.count(alias)).toBe(2)
  expect(lease(next, alias, leased.receipt).messages).toMatchObject([{ id: second!.msgId, body: 'B' }])
  expect(b.inboxes.count(alias)).toBe(1)
})

test('first gateway binding preserves ordinary mail for a different remembered legacy owner', () => {
  const dir = directory()
  const a = router(dir)
  legacy(a.connect(), alias, 'pull', 'old')
  deliver(a.deps, alias, 'prior unbound ordinary mail', {})
  const previous = a.inboxes.list(alias)[0]!

  const b = router(dir)
  expect(b.inboxes.conversation(alias)).toBe('old')
  const gw = b.connect()
  gateway(gw)
  agent(gw, alias, 'new')
  expect(lease(gw, alias).messages).toEqual([])
  expect(b.inboxes.list(alias).map(entry => entry.id)).toEqual([previous.id])

  const c = router(dir)
  const recovered = c.connect()
  gateway(recovered)
  agent(recovered, alias, 'old')
  expect(lease(recovered, alias).messages).toMatchObject([
    { id: previous.id, body: 'prior unbound ordinary mail' },
  ])
  expect(c.inboxes.list(alias)).toEqual([])
})

test('a foreign gateway cannot replace a bare legacy session or inherit its mail', () => {
  const a = router(directory())
  const mac = a.connect()
  gateway(mac)
  agent(mac, 'codex@nas642', 'foreign')
  expect(mac.frames.at(-1)?.message).toBe('invalid_agent_registration')
  const name = 'opencode_nas642_glm53_abli'
  const recipient = a.connect()
  legacy(recipient, name, 'pull')
  deliver(a.deps, name, 'for its assigned host', {})
  agent(mac, name, 'foreign', 'opencode')
  expect(mac.frames.at(-1)?.message).toBe('invalid_agent_registration')
  expect(a.inboxes.target(name)).toBeUndefined()
  expect(recipient.frames.some(frame => frame.type === 'replaced')).toBe(false)

  const nas = a.connect()
  gateway(nas, 'nas642')
  agent(nas, name, 'local', 'opencode')
  expect(lease(nas, name).messages).toMatchObject([{ body: 'for its assigned host' }])
})

test('an unqualified alias needs explicit router ownership', () => {
  const a = router(directory())
  const mac = a.connect()
  gateway(mac)
  agent(mac, 'unassigned', 'claimed', 'codex')
  expect(mac.frames.at(-1)?.message).toBe('invalid_agent_registration')
  expect(a.inboxes.target('unassigned')).toBeUndefined()
})

test('gateway alias registration rejects reserved names even if explicitly configured', () => {
  const names = ['human', 'admin', 'user', 'me', 'ALL', 'all:synthesis', 'router', '@all:independent']
  const a = router(directory(), { gatewayAliasHosts: () => Object.fromEntries(names.map(name => [name, 'mac'])) })
  const mac = a.connect()
  gateway(mac)
  for (const name of names) {
    agent(mac, name, 'claimed')
    expect(mac.frames.at(-1)?.message).toBe('invalid_agent_registration')
    expect(a.inboxes.target(name)).toBeUndefined()
  }
})

test.each(['woken', 'held', 'refused'] as const)('a lost %s result reply allows exact replay after restart', outcome => {
  const dir = directory()
  const a = router(dir)
  const gw = a.connect()
  gateway(gw)
  agent(gw, alias, 'A')
  deliver(a.deps, alias, 'wake once', {})
  const wake = gw.frames.find(frame => frame.type === 'wake')!
  const result = outcome === 'woken' ? { s: outcome, nativeId: 'native-original' } : { s: outcome }
  const post = { type: 'wakeResult', as: alias, id: wake.msgId, result, requestId: 'lost' }
  gw.failWhen(frame => frame.requestId === 'lost')
  gw.send(post)
  expect(gw.result('lost')).toBeUndefined()
  if (outcome === 'woken') expect(lease(gw, alias).messages[0]?.state).toBe('leased')

  const b = router(dir)
  const replay = b.connect()
  gateway(replay)
  agent(replay, alias, 'A')
  agent(replay, other, 'B')
  replay.send({ ...post, requestId: 'exact' })
  expect(replay.result('exact')?.success).toBe(true)
  replay.send({ ...post, requestId: 'conflict', result: outcome === 'woken' ? { s: 'woken', nativeId: 'different' } : { s: 'woken', nativeId: 'new' } })
  expect(replay.result('conflict')?.data).toBe('invalid_wake_transition')
  replay.send({ ...post, requestId: 'foreign', as: other })
  expect(replay.result('foreign')?.data).toBe('unknown_message')
  expect(replay.frames.some(frame => frame.type === 'wake')).toBe(false)
})
