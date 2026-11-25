import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FakeAdapter, Gateway, RouterLink, WakeStore, buildNudge, makeNudge, nudgeNumber, nudgeText, redactFrame,
  type GatewayToRouterMessage, type LeaseResult, type PeerInfo,
} from '../gateway/index.js'

const parent = { host: 'nas642', user: 'mickg', kind: 'codex' as const, conv: 'parent-conv', alias: 'codex@nas642:parent', pid: 10, cwd: '/work/src', transport: 'codex-queue' as const, started: 'linux:1' }
const child = { host: 'nas642', user: 'mickg', kind: 'codex' as const, conv: 'child-conv', alias: 'codex@nas642:child', pid: 11, cwd: '/work/src', transport: 'codex-queue' as const, started: 'linux:1' }

const pipeRoot = join(tmpdir(), `agent-bus-pipe-bin-${process.pid}`)
mkdirSync(pipeRoot, { recursive: true })
const pipeBin = join(pipeRoot, 'agent-bus-pipe')
if (!existsSync(pipeBin)) {
  writeFileSync(pipeBin, '')
  chmodSync(pipeBin, 0o755)
}

function leased(body: string, id: string, extra: Partial<LeaseResult> = {}): LeaseResult {
  return {
    messages: [{ id, leaseId: `lease-${id}`, body, from: 'human', from_human: true, state: 'committed', meta: {} }],
    receipt: `rcpt-${id}`,
    unread: 1,
    ...extra,
  }
}

async function gateway(agents: Array<typeof parent> = [parent, child]) {
  const dir = await mkdtemp(join(tmpdir(), 'gw-'))
  const frames: GatewayToRouterMessage[] = []
  const audit: GatewayToRouterMessage[] = []
  const mail = new Map<string, LeaseResult>(agents.map(agent => [agent.alias, leased(agent.conv + '-SECRET', agent.pid.toString())]))
  let peer: PeerInfo | undefined
  let gw!: Gateway
  const send = (frame: GatewayToRouterMessage) => {
    frames.push(frame)
    if (frame.type === 'wakeResult') {
      gw.router.receive({ type: 'toolResult', requestId: frame.requestId, success: true, data: '{}' })
      return
    }
    if (frame.type === 'gatewayOp' || frame.type === 'busPost') {
      gw.router.receive({ type: 'toolResult', requestId: frame.requestId!, success: true, data: '{"publish_id":"pub-fixture","committed":[]}' })
      return
    }
    if (frame.type !== 'lease') return
    const requestId = frame.requestId
    if (frame.type === 'lease') {
      const data = mail.get(frame.as) ?? { messages: [], unread: 0 }
      gw.router.receive({ type: 'toolResult', requestId, success: true, data: JSON.stringify(data) })
      return
    }
  }
  gw = new Gateway({
    host: 'nas642', user: 'mickg', secret: 'node-secret',
    storePath: join(dir, 'wakes.json'), pipePath: pipeBin,
    send, audit: frame => audit.push(frame), readPeer: () => peer,
  })
  for (const agent of agents) gw.registerAgent(agent)
  const sock = join(dir, 'gw.sock')
  const previousUmask = process.umask(0)
  try { await gw.listen(sock) } finally { process.umask(previousUmask) }
  return {
    gw, dir, sock, frames, audit, mail,
    setPeer: (next: PeerInfo | undefined) => { peer = next },
  }
}

function mcpCall(line: { op: string; conv?: string; cwd?: string; [key: string]: unknown }) {
  const { op, conv, cwd: _cwd, ...args } = line
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: op, arguments: args, _meta: { threadId: conv } } }
}

function mcpResult(line: string): Record<string, unknown> {
  const response = JSON.parse(line)
  if (response.ok === false) return response
  const text = response.result?.content?.[0]?.text
  if (response.result?.isError) return { ok: false, error: text }
  return { ok: true, ...JSON.parse(text) }
}

function rpc(sock: string, setPeer: (peer: PeerInfo | undefined) => void, who: PeerInfo | undefined, line: Parameters<typeof mcpCall>[0]): Promise<Record<string, unknown>> {
  setPeer(who)
  return new Promise((resolve, reject) => {
    const socket = connect(sock)
    let buf = ''
    socket.on('error', reject)
    socket.on('data', data => {
      buf += data.toString()
      const nl = buf.indexOf('\n')
      if (nl >= 0) { socket.end(); resolve(mcpResult(buf.slice(0, nl))) }
    })
    socket.write(JSON.stringify(mcpCall(line)) + '\n')
  })
}

const pipe = (ppid: number): PeerInfo => ({ pid: 100 + ppid, exe: pipeBin, ppid, started: 'linux:2', parentStarted: 'linux:1' })

describe('gateway skeleton', () => {
  test('registerGateway requires a node secret and does not log it', () => {
    expect(() => new Gateway({ host: 'h', user: 'u', secret: '', storePath: '/tmp/unused-gw.json' })).toThrow('node secret required')
    const frame = redactFrame({ type: 'registerGateway', host: 'h', user: 'u', proto: 1, secret: 's3cret' })
    expect(JSON.stringify(frame)).not.toContain('s3cret')
    if (frame.type === 'registerGateway') expect(frame.secret).toBe('[redacted]')
  })

  test('fleet aliases the router accepts register here', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-alias-'))
    const frames: GatewayToRouterMessage[] = []
    const open = (host: string) => new Gateway({
      host, user: 'mickg', secret: 'node-secret', storePath: join(dir, `${host}.json`),
      send: frame => frames.push(frame),
    })
    const nas = open('nas642')
    const mac = open('mac')
    const cases = [
      { gw: nas, host: 'nas642', kind: 'codex' as const, alias: 'codex@nas642' },
      { gw: mac, host: 'mac', kind: 'codex' as const, alias: 'codex@mac' },
      { gw: nas, host: 'nas642', kind: 'codex' as const, alias: 'codex-photos@nas642' },
      { gw: nas, host: 'nas642', kind: 'opencode' as const, alias: 'opencode_nas642_glm53_abli' },
      { gw: mac, host: 'mac', kind: 'codex' as const, alias: 'codex@mac:infra' },
    ]
    try {
      for (const [i, row] of cases.entries()) {
        row.gw.registerAgent({
          host: row.host, user: 'mickg', kind: row.kind, conv: `conv-${i}`,
          alias: row.alias, pid: 200 + i, started: 'linux:1', transport: row.kind === 'opencode' ? 'opencode-queue' : 'codex-queue',
        })
        expect(row.gw.registry.byAlias(row.alias)?.conv).toBe(`conv-${i}`)
        expect(frames.some(frame =>
          frame.type === 'registerAgent' && frame.alias === row.alias &&
          frame.kind === row.kind && frame.host === row.host && frame.conv === `conv-${i}`,
        )).toBe(true)
      }
      // A foreign-looking name is not parsed. The record's host is the gateway's.
      nas.registerAgent({
        host: 'nas642', user: 'mickg', kind: 'codex', conv: 'foreign-shape',
        alias: 'codex@mac', pid: 299, started: 'linux:1', transport: 'codex-queue',
      })
      expect(nas.registry.byAlias('codex@mac')?.host).toBe('nas642')
      expect(frames.some(frame =>
        frame.type === 'registerAgent' && frame.alias === 'codex@mac' && frame.host === 'nas642',
      )).toBe(true)
      for (const alias of ['', 'codex@nas642:bad name', 'human', 'admin', 'user', 'me', 'all', 'all:synthesis', 'router', '@all', '@all:independent', 'Human']) {
        expect(() => nas.registerAgent({
          host: 'nas642', user: 'mickg', kind: 'codex', conv: 'nope',
          alias, pid: 300, started: 'linux:1', transport: 'codex-queue',
        })).toThrow('invalid alias')
      }
      expect(() => mac.registerAgent({
        host: 'nas642', user: 'mickg', kind: 'codex', conv: 'nope',
        alias: 'codex@mac:infra', pid: 301, started: 'linux:1', transport: 'codex-queue',
      })).toThrow('host mismatch')
    } finally {
      await nas.close()
      await mac.close()
    }
  })

  test('nudges use the shared builder', () => {
    const hash = createHash('sha256').update('thread:42').digest('hex')
    const n = nudgeNumber('thread', '42')
    expect(nudgeText(n)).toBe(`[agent-bus] mail waiting (id ${n}) — call check_inbox`)
    expect(makeNudge('codex', 'thread', '42')).toEqual(buildNudge('codex', 'thread', '42', n))
    expect(buildNudge('codex', 'thread', '42', n).clientId).toBe(`bus-${hash.slice(0, 32)}`)
    expect(buildNudge('opencode', 'thread', '42', n).clientId).toBe(`msg_bus${hash.slice(0, 24)}`)
    expect(buildNudge('grok', 'thread', '42', n).clientId).toBe(hash.slice(0, 32))
    expect(() => nudgeText(-1)).toThrow(RangeError)
  })

  test('same-cwd parent and child cannot read each other\'s mail', async () => {
    const g = await gateway()
    try {
      expect(parent.cwd).toBe(child.cwd)
      const childPipe = pipe(child.pid)
      const namedParent = await rpc(g.sock, g.setPeer, childPipe, { op: 'check_inbox', conv: parent.conv, cwd: parent.cwd })
      expect(namedParent.ok).toBe(false)
      expect(JSON.stringify(namedParent)).not.toContain('SECRET')
      expect(g.frames.some(frame => frame.type === 'lease' && frame.as === parent.alias)).toBe(false)

      const res = await rpc(g.sock, g.setPeer, childPipe, { op: 'check_inbox', conv: child.conv, cwd: parent.cwd, receipt: 'previous' })
      const text = JSON.stringify(res)
      expect(text).toContain('child-conv-SECRET')
      expect(text).not.toContain('parent-conv-SECRET')
      expect(res.receipt).toBe('rcpt-11')
      const lease = g.frames.find((frame): frame is Extract<GatewayToRouterMessage, { type: 'lease' }> =>
        frame.type === 'lease' && frame.as === child.alias)
      expect(lease?.receipt).toBe('previous')
      const messages = res.messages as Array<{ id: string; leaseId: string }>
      expect(messages.map(message => message.id)).toEqual(['11'])

      const beforeAck = g.frames.length
      const wrongConv = await rpc(g.sock, g.setPeer, childPipe, { op: 'ack', conv: parent.conv, receipt: 'rcpt-10', leaseId: 'lease-10', id: '10' })
      expect(wrongConv.ok).toBe(false)
      expect(g.frames.length).toBe(beforeAck)
      const stolen = await rpc(g.sock, g.setPeer, childPipe, { op: 'ack', conv: child.conv, receipt: 'rcpt-10', leaseId: 'lease-10', id: '10' })
      expect(stolen.ok).toBe(false)
      expect(g.frames.length).toBe(beforeAck)

      const stranger = await rpc(g.sock, g.setPeer, { pid: 9, exe: '/bin/bash', ppid: child.pid, started: 'linux:2', parentStarted: 'linux:1' }, { op: 'check_inbox', conv: child.conv })
      expect(stranger.ok).toBe(false)
      expect(JSON.stringify(stranger)).not.toContain('SECRET')
      const mode = (await stat(g.sock)).mode & 0o777
      expect(mode).toBe(0o600)
      expect((await stat(g.dir)).mode & 0o777).toBe(0o700)
      const link = join(g.dir, 'agent-bus-pipe')
      symlinkSync('/bin/bash', link)
      const viaLink = await rpc(g.sock, g.setPeer, { pid: 8, exe: link, ppid: child.pid, started: 'linux:2', parentStarted: 'linux:1' }, { op: 'check_inbox', conv: child.conv })
      expect(viaLink).toMatchObject({ ok: false, error: 'peer is not agent-bus-pipe' })
      const missingExe = await rpc(g.sock, g.setPeer, { pid: 7, exe: join(g.dir, 'missing-agent-bus-pipe'), ppid: child.pid, started: 'linux:2', parentStarted: 'linux:1' }, { op: 'check_inbox', conv: child.conv })
      const otherDir = join(g.dir, 'other-pipe')
      mkdirSync(otherDir)
      const otherPipe = join(otherDir, 'agent-bus-pipe')
      writeFileSync(otherPipe, '')
      const sameName = await rpc(g.sock, g.setPeer, { ...pipe(child.pid), exe: otherPipe }, { op: 'check_inbox', conv: child.conv })
      expect(sameName).toMatchObject({ ok: false, error: 'peer is not agent-bus-pipe' })
      const reused = await rpc(g.sock, g.setPeer, { ...pipe(child.pid), parentStarted: 'linux:999' }, { op: 'check_inbox', conv: child.conv })
      expect(reused).toMatchObject({ ok: false, error: 'parent is not a registered agent' })
      expect(missingExe).toMatchObject({ ok: false, error: 'peer is not agent-bus-pipe' })
      expect(g.frames.some(frame => frame.type === 'registerGateway' && frame.proto === 1 && frame.secret === 'node-secret')).toBe(true)
      expect(JSON.stringify(g.audit)).not.toContain('node-secret')
    } finally { await g.gw.close() }
  })

  test('one process selects the conversation named on the call', async () => {
    const sharedA = { ...parent, conv: 'alpha', alias: 'codex@nas642:alpha', pid: 42 }
    const sharedB = { ...parent, conv: 'beta', alias: 'codex@nas642:beta', pid: 42 }
    const g = await gateway([sharedA, sharedB])
    try {
      g.mail.set(sharedA.alias, leased('ALPHA', 'a'))
      g.mail.set(sharedB.alias, leased('BETA', 'b'))
      const who = pipe(42)
      const missing = await rpc(g.sock, g.setPeer, who, { op: 'check_inbox', cwd: '/work/src' })
      expect(missing).toMatchObject({ ok: false, error: 'Conversation identity is missing, mismatched, or stale' })
      const alpha = await rpc(g.sock, g.setPeer, who, { op: 'check_inbox', conv: 'alpha', cwd: '/other' })
      expect(JSON.stringify(alpha)).toContain('ALPHA')
      expect(JSON.stringify(alpha)).not.toContain('BETA')
      expect(g.frames.some(frame => frame.type === 'lease' && frame.as === sharedA.alias)).toBe(true)
      const beta = await rpc(g.sock, g.setPeer, who, { op: 'check_inbox', conv: 'beta' })
      expect(JSON.stringify(beta)).toContain('BETA')
      expect(JSON.stringify(beta)).not.toContain('ALPHA')
      const foreign = await rpc(g.sock, g.setPeer, who, { op: 'check_inbox', conv: parent.conv })
      expect(foreign).toMatchObject({ ok: false, error: 'Conversation identity is missing, mismatched, or stale' })
    } finally { await g.gw.close() }
  })

  test('MCP forwards allowlisted fields under the verified alias', async () => {
    const g = await gateway()
    try {
      const who = pipe(child.pid)
      const post = { op: 'bus_post', conv: child.conv, text: 'hello', to: 'human' }
      const count = g.frames.length
      expect((await rpc(g.sock, g.setPeer, who, { ...post, as: parent.alias })).ok).toBe(false)
      expect(g.frames).toHaveLength(count)
      expect(await rpc(g.sock, g.setPeer, who, post)).toMatchObject({ publish_id: 'pub-fixture', committed: [] })
      expect(g.frames.at(-1)).toMatchObject({ type: 'busPost', as: child.alias, text: 'hello', to: 'human' })
      await rpc(g.sock, g.setPeer, who, { op: 'reply', conv: child.conv, text: 'hello', chat_id: '1', reply_to: '2' })
      expect(g.frames.at(-1)).toMatchObject({ type: 'gatewayOp', op: 'reply', as: child.alias, chatId: '1', replyTo: '2' })
    } finally { await g.gw.close() }
  })

  test('held or refused does not fall through and starts no model turn', async () => {
    const g = await gateway()
    try {
      for (const [s, target, id] of [['held', parent, '11'], ['refused', child, '12']] as const) {
        const primary = new FakeAdapter('codex', { s })
        const fallback = new FakeAdapter('agy')
        g.gw.setAdapters([primary, fallback])
        const result = await g.gw.deliver(target, id, nudgeNumber(target.conv, id))
        expect(result).toEqual({ s })
        expect(primary.wakeCalls).toBe(1)
        expect(primary.turns).toBe(0)
        expect(fallback.wakeCalls).toBe(0)
        expect(fallback.reconcileCalls).toBe(0)
        const markAt = g.frames.findIndex(frame => frame.type === 'mark' && frame.id === id)
        const resultAt = g.frames.findIndex(frame => frame.type === 'wakeResult' && frame.id === id)
        expect(markAt).toBeGreaterThanOrEqual(0)
        expect(resultAt).toBeGreaterThan(markAt)
        const wake = g.frames[resultAt]
        if (wake?.type === 'wakeResult') expect(wake.result).toEqual({ s })
      }
      const native = new FakeAdapter('codex', { s: 'unavailable' })
      const tmux = new FakeAdapter('codex', { s: 'woken', nativeId: 'q' }, 'tmux')
      g.gw.setAdapters([native, tmux])
      const fall = { ...parent, conv: 'fall-conv', alias: 'codex@nas642:fall' }
      const blocked = await g.gw.deliver(fall, '13', nudgeNumber(fall.conv, '13'))
      expect(blocked).toEqual({ s: 'unavailable' })
      expect(native.wakeCalls).toBe(1)
      expect(native.turns).toBe(0)
      expect(tmux.wakeCalls).toBe(0)
      expect(tmux.turns).toBe(0)
      const again = await g.gw.deliver(fall, '13', nudgeNumber(fall.conv, '13'))
      expect(again).toEqual({ s: 'unavailable' })
      expect(native.wakeCalls).toBe(1)
      expect(tmux.wakeCalls).toBe(0)
      const dupA = new FakeAdapter('codex', { s: 'woken', nativeId: 'a' })
      const dupB = new FakeAdapter('codex', { s: 'woken', nativeId: 'b' })
      g.gw.setAdapters([dupA, dupB])
      const dup = { ...parent, conv: 'dup-conv', alias: 'codex@nas642:dup' }
      const ambiguous = await g.gw.deliver(dup, '14', nudgeNumber(dup.conv, '14'))
      expect(ambiguous).toEqual({ s: 'unavailable' })
      expect(dupA.wakeCalls).toBe(0)
      expect(dupB.wakeCalls).toBe(0)
      expect(g.gw.store.get('14')).toBeUndefined()
      const mode = (await stat(join(g.dir, 'wakes.json'))).mode & 0o777
      expect(mode).toBe(0o600)
    } finally { await g.gw.close() }
  })

  test('no adapter does not finish a wake row or tell the router', async () => {
    const g = await gateway()
    try {
      g.gw.setAdapters([])
      const result = await g.gw.deliver(parent, '99', nudgeNumber(parent.conv, '99'))
      expect(result).toEqual({ s: 'unavailable' })
      expect(g.frames.some(frame => frame.type === 'mark' || frame.type === 'wakeResult')).toBe(false)
      expect(existsSync(join(g.dir, 'wakes.json'))).toBe(false)
    } finally { await g.gw.close() }
  })

  test('a crash after the native send reconciles and does not wake again', async () => {
    const g = await gateway()
    try {
      const fake = new FakeAdapter('codex', async () => {
        g.gw.resumeFromDisk()
        throw new Error('crash before wakeResult')
      })
      g.gw.setAdapters([fake])
      const n = nudgeNumber(parent.conv, '21')
      await expect(g.gw.deliver(parent, '21', n)).rejects.toThrow('crash')
      expect(fake.wakeCalls).toBe(1)
      expect(fake.turns).toBe(0)
      expect(g.gw.store.get('21')?.n).toBe(n)
      expect(g.gw.store.get('21')).not.toHaveProperty('text')
      const again = await g.gw.deliver(parent, '21', n)
      expect(again).toEqual({ s: 'woken', nativeId: 'reconciled' })
      expect(fake.wakeCalls).toBe(1)
      expect(fake.reconcileCalls).toBe(1)
      expect(fake.seen[0]).toEqual(makeNudge('codex', parent.conv, '21'))
      expect(fake.seen[1]).toEqual(makeNudge('codex', parent.conv, '21'))
    } finally { await g.gw.close() }
  })

  test('a second message does not wake while the first nudge is unacked', async () => {
    const g = await gateway()
    try {
      const fake = new FakeAdapter('codex')
      g.gw.setAdapters([fake])
      await g.gw.deliver(parent, '31', nudgeNumber(parent.conv, '31'))
      const second = await g.gw.deliver(parent, '32', nudgeNumber(parent.conv, '32'))
      expect(second).toEqual({ s: 'queued' })
      expect(fake.wakeCalls).toBe(1)
      expect(g.frames.filter(frame => frame.type === 'mark' && frame.id === '32')).toHaveLength(0)
    } finally { await g.gw.close() }
  })

  test('a router wake frame uses the pinned msgId and n', async () => {
    const g = await gateway()
    try {
      const fake = new FakeAdapter('codex')
      g.gw.setAdapters([fake])
      const n = nudgeNumber(parent.conv, '77')
      g.gw.router.receive({ type: 'wake', as: parent.alias, msgId: '77', n })
      await g.gw.idle()
      expect(fake.wakeCalls).toBe(1)
      expect(fake.seen[0]).toEqual(buildNudge('codex', parent.conv, '77', n))
      g.gw.router.receive({ type: 'wake', as: parent.alias, msgId: '78', n: nudgeNumber(parent.conv, '78'), reconcile: true })
      await g.gw.idle()
      expect(fake.wakeCalls).toBe(1)
      expect(fake.reconcileCalls).toBe(1)
      expect(fake.seen[1]).toEqual(buildNudge('codex', parent.conv, '78', nudgeNumber(parent.conv, '78')))
      expect(g.frames.some(frame => frame.type === 'wakeResult' && frame.id === '78' && frame.result.s === 'woken')).toBe(true)
      expect(g.frames.some(frame => frame.type === 'mark' && frame.id === '78')).toBe(false)
    } finally { await g.gw.close() }
  })

  test('a successful check_inbox reopens the nudge, including a stale receipt', async () => {
    const g = await gateway()
    try {
      const fake = new FakeAdapter('codex')
      g.gw.setAdapters([fake])
      await g.gw.deliver(parent, '31', nudgeNumber(parent.conv, '31'))
      g.mail.set(parent.alias, { messages: [], unread: 0, receipt_status: 'stale' })
      const looked = await rpc(g.sock, g.setPeer, pipe(parent.pid), { op: 'check_inbox', conv: parent.conv, receipt: 'old' })
      expect(looked.ok).toBe(true)
      expect(g.gw.store.get('31')).toBeUndefined()
      expect(WakeStore.load(join(g.dir, 'wakes.json')).get('31')).toBeUndefined()
      await g.gw.deliver(parent, '32', nudgeNumber(parent.conv, '32'))
      expect(fake.seen.map(nudge => nudge.msgId)).toEqual(['31', '32'])
    } finally { await g.gw.close() }
  })

  test('only the target kind is woken, and a missing kind stays uncertain', async () => {
    const g = await gateway()
    try {
      const codex = new FakeAdapter('codex', { s: 'refused' })
      const opencode = new FakeAdapter('opencode', { s: 'woken', nativeId: 'oc' })
      g.gw.setAdapters([codex, opencode])
      const target = { ...parent, kind: 'opencode' as const, transport: 'opencode-queue' as const, conv: 'oc-conv', alias: 'opencode@nas642:shared' }
      const woken = await g.gw.deliver(target, '41', nudgeNumber(target.conv, '41'))
      expect(woken).toEqual({ s: 'woken', nativeId: 'oc' })
      expect(codex.wakeCalls).toBe(0)
      expect(opencode.wakeCalls).toBe(1)
      g.gw.registerAgent({ ...target, pid: 70, cwd: '/work/src' })
      g.gw.setAdapters([codex])
      const claude = { ...parent, kind: 'claude' as const, transport: 'claude-inbox' as const, conv: 'claude-conv', alias: 'claude@nas642:one' }
      const onlyCodex = await g.gw.deliver(claude, '55', nudgeNumber(claude.conv, '55'))
      expect(onlyCodex).toEqual({ s: 'unavailable' })
      expect(codex.wakeCalls).toBe(0)
      g.gw.router.receive({ type: 'wake', as: target.alias, msgId: '88', n: 1, reconcile: true })
      await g.gw.idle()
      expect(codex.reconcileCalls).toBe(0)
      expect(codex.wakeCalls).toBe(0)
      expect(g.frames.some(frame => frame.type === 'wakeResult' && frame.id === '88')).toBe(false)
    } finally { await g.gw.close() }
  })

  test('releaseAgent drops one alias and disconnect does not', async () => {
    const g = await gateway()
    try {
      g.gw.registerAgent({ ...parent, conv: 'moved' })
      expect(g.gw.registry.byAlias(parent.alias)?.conv).toBe('moved')
      expect(g.gw.registry.byPid(parent.pid).map(agent => agent.conv)).toEqual(['moved'])
      g.gw.release(parent.alias)
      expect(g.gw.registry.byAlias(parent.alias)).toBeUndefined()
      expect(g.gw.registry.byAlias(child.alias)?.conv).toBe(child.conv)
      expect(g.frames.some(frame => frame.type === 'releaseAgent' && frame.alias === parent.alias)).toBe(true)
      const sent = g.frames.length
      g.gw.router.receive({ type: 'agentReleased', alias: child.alias })
      expect(g.gw.registry.byAlias(child.alias)).toBeUndefined()
      await g.gw.close()
      expect(g.frames.length).toBe(sent)
    } finally { await g.gw.close() }
  })

  test('a dropped wakeResult is replayed from the finished row without another wake', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-replay-'))
    const path = join(dir, 'wakes.json')
    const frames: GatewayToRouterMessage[] = []
    const send = (frame: GatewayToRouterMessage) => { frames.push(frame) }
    const first = new Gateway({ host: 'nas642', user: 'mickg', secret: 'node-secret', storePath: path, send })
    const fake = new FakeAdapter('codex')
    first.setAdapters([fake])
    first.registerAgent(parent)
    try {
      await first.deliver(parent, '31', nudgeNumber(parent.conv, '31'))
      expect(fake.wakeCalls).toBe(1)
      expect(first.store.get('31')?.state).toBe('woken')
      expect(first.store.get('31')?.reported).toBeUndefined()
      const second = new Gateway({ host: 'nas642', user: 'mickg', secret: 'node-secret', storePath: path, send })
      const replay = new FakeAdapter('codex')
      second.setAdapters([replay])
      second.registerAgent(parent)
      second.resumeFromDisk()
      second.router.receive({ type: 'wake', as: parent.alias, msgId: '31', n: 1, reconcile: true })
      await second.idle()
      expect(replay.wakeCalls).toBe(0)
      expect(replay.reconcileCalls).toBe(0)
      const results = frames.filter(frame => frame.type === 'wakeResult' && frame.id === '31')
      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(results.every(frame => frame.type === 'wakeResult' && frame.result.s === 'woken')).toBe(true)
      await second.close()
    } finally { await first.close() }
  })

  test('a verified pipe resolves a rebound conversation on its next call', async () => {
    const g = await gateway()
    try {
      g.setPeer(pipe(parent.pid))
      const socket = connect(g.sock)
      await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject) })
      const read = () => new Promise<Record<string, unknown>>((resolve, reject) => {
        let buf = ''
        const onData = (data: Buffer) => {
          buf += data.toString()
          const nl = buf.indexOf('\n')
          if (nl < 0) return
          socket.off('data', onData)
          resolve(mcpResult(buf.slice(0, nl)))
        }
        socket.on('data', onData)
        socket.on('error', reject)
      })
      socket.write(JSON.stringify(mcpCall({ op: 'check_inbox', conv: parent.conv })) + '\n')
      expect((await read()).ok).toBe(true)
      const before = g.frames.filter(frame => frame.type === 'lease').length
      g.gw.registerAgent({ ...parent, conv: 'moved' })
      socket.write(JSON.stringify(mcpCall({ op: 'check_inbox', conv: parent.conv })) + '\n')
      expect(await read()).toMatchObject({ ok: false, error: 'Conversation identity is missing, mismatched, or stale' })
      expect(g.frames.filter(frame => frame.type === 'lease')).toHaveLength(before)
      socket.write(JSON.stringify(mcpCall({ op: 'check_inbox', conv: 'moved' })) + '\n')
      expect((await read()).ok).toBe(true)
      expect(g.frames.filter(frame => frame.type === 'lease')).toHaveLength(before + 1)
      socket.end()
    } finally { await g.gw.close() }
  })

  test('MCP permits multiple frames and disconnects on an oversized partial frame', async () => {
    const g = await gateway()
    try {
      g.setPeer(pipe(parent.pid))
      const socket = connect(g.sock)
      await once(socket, 'connect')
      const request = JSON.stringify(mcpCall({ op: 'check_inbox', conv: parent.conv }))
      const frames = new Promise<void>(resolve => {
        let replies = ''
        socket.on('data', chunk => {
          replies += chunk.toString()
          if (replies.split('\n').length >= 3) resolve()
        })
      })
      const padding = ' '.repeat(600 * 1024)
      socket.write(request + padding + '\n' + request + padding + '\n')
      await frames
      const before = g.frames.length
      const closed = new Promise<void>(resolve => { socket.once('close', () => resolve()) })
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET') throw error
      })
      socket.write(padding)
      socket.write(padding)
      await closed
      expect(g.frames).toHaveLength(before)
    } finally { await g.gw.close() }
  })

  test('a dropped router link rejects an outstanding lease', async () => {
    const link = new RouterLink('node-secret', () => {})
    const pending = link.lease('codex@nas642:parent')
    link.failPending(new Error('router link down'))
    await expect(pending).rejects.toThrow('router link down')
  })

  test('a verified pipe reports the connection before any line is read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-hook-'))
    const seen: string[] = []
    const gw = new Gateway({
      host: 'nas642', user: 'mickg', secret: 'node-secret', storePath: join(dir, 'wakes.json'),
      pipePath: pipeBin, send: () => {}, readPeer: () => pipe(parent.pid),
      onVerifiedConnection: (_sock, agents) => { seen.push(agents.map(agent => agent.alias).join(',')) },
    })
    gw.registerAgent(parent)
    const sock = join(dir, 'gw.sock')
    await gw.listen(sock)
    try {
      const socket = connect(sock)
      await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('error', reject) })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(seen).toEqual([parent.alias])
      socket.end()
    } finally { await gw.close() }
  })

  test('a socket directory owned by another user refuses to listen', async () => {
    const parentStat = await stat('/tmp')
    const getuid = process.getuid
    if (getuid === undefined) throw new Error('no uid')
    expect(parentStat.uid).not.toBe(getuid())
    const mode = parentStat.mode
    const gw = new Gateway({
      host: 'nas642', user: 'mickg', secret: 'node-secret',
      storePath: join(tmpdir(), 'gw-foreign-not-created.json'), send: () => {},
    })
    await expect(gw.listen('/tmp/agent-bus-foreign-owner.sock')).rejects.toThrow('owned by another user')
    expect((await stat('/tmp')).mode).toBe(mode)
    await gw.close()
  })

  test('a bad wake store is left untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-store-'))
    const missing = join(dir, 'missing.json')
    expect(WakeStore.load(missing).get('x')).toBeUndefined()
    expect(existsSync(missing)).toBe(false)
    const path = join(dir, 'wakes.json')
    writeFileSync(path, '{')
    expect(() => WakeStore.load(path)).toThrow('wake store malformed')
    expect(readFileSync(path, 'utf8')).toBe('{')
    expect(existsSync(path + '.tmp')).toBe(false)
    writeFileSync(path, '[{}]')
    expect(() => WakeStore.load(path)).toThrow('wake store malformed')
    expect(readFileSync(path, 'utf8')).toBe('[{}]')
    const legacy = JSON.stringify([{ msgId: '1', conv: 'c', kind: 'codex', host: 'h', user: 'u', alias: 'a', clientId: 'c', text: 'old', state: 'woken' }])
    writeFileSync(path, legacy)
    expect(() => WakeStore.load(path)).toThrow('wake store malformed')
    expect(readFileSync(path, 'utf8')).toBe(legacy)
    expect(() => WakeStore.load(dir)).toThrow()
  })
})
