import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FakeAdapter, Gateway, WakeStore, buildNudge, makeNudge, nudgeNumber, nudgeText, redactFrame,
  type GatewayToRouterMessage, type LeaseResult, type PeerInfo,
} from '../gateway/index.js'

const parent = { host: 'nas642', user: 'mickg', kind: 'codex' as const, conv: 'parent-conv', alias: 'codex@nas642:parent', pid: 10, cwd: '/work/src', transport: 'native' as const }
const child = { host: 'nas642', user: 'mickg', kind: 'codex' as const, conv: 'child-conv', alias: 'codex@nas642:child', pid: 11, cwd: '/work/src', transport: 'native' as const }

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
  let allowAck = (_frame: Extract<GatewayToRouterMessage, { type: 'ack' }>) => true
  let gw!: Gateway
  const send = (frame: GatewayToRouterMessage) => {
    frames.push(frame)
    if (frame.type !== 'lease' && frame.type !== 'ack') return
    const requestId = frame.requestId
    if (frame.type === 'lease') {
      const data = mail.get(frame.as) ?? { messages: [], unread: 0 }
      gw.router.receive({ type: 'toolResult', requestId, success: true, data: JSON.stringify(data) })
      return
    }
    const ok = allowAck(frame)
    gw.router.receive({ type: 'toolResult', requestId, success: ok, data: ok ? '{}' : 'invalid_receipt' })
  }
  gw = new Gateway({
    host: 'nas642', user: 'mickg', secret: 'node-secret',
    storePath: join(dir, 'wakes.json'),
    send, audit: frame => audit.push(frame), readPeer: () => peer,
  })
  for (const agent of agents) gw.registerAgent(agent)
  const sock = join(dir, 'gw.sock')
  await gw.listen(sock)
  return {
    gw, dir, sock, frames, audit, mail,
    setPeer: (next: PeerInfo | undefined) => { peer = next },
    setAllowAck: (next: typeof allowAck) => { allowAck = next },
  }
}

function rpc(sock: string, setPeer: (peer: PeerInfo | undefined) => void, who: PeerInfo | undefined, line: unknown): Promise<Record<string, unknown>> {
  setPeer(who)
  return new Promise((resolve, reject) => {
    const socket = connect(sock)
    let buf = ''
    socket.on('error', reject)
    socket.on('data', data => {
      buf += data.toString()
      const nl = buf.indexOf('\n')
      if (nl >= 0) { socket.end(); resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>) }
    })
    socket.write(JSON.stringify(line) + '\n')
  })
}

const pipe = (ppid: number): PeerInfo => ({ pid: 100 + ppid, exe: '/usr/lib/agent-bus-pipe', ppid })

describe('gateway skeleton', () => {
  test('registerGateway requires a node secret and does not log it', () => {
    expect(() => new Gateway({ host: 'h', user: 'u', secret: '', storePath: '/tmp/unused-gw.json' })).toThrow('node secret required')
    const frame = redactFrame({ type: 'registerGateway', host: 'h', user: 'u', proto: 1, secret: 's3cret' })
    expect(JSON.stringify(frame)).not.toContain('s3cret')
    if (frame.type === 'registerGateway') expect(frame.secret).toBe('[redacted]')
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
      g.setAllowAck(frame => frame.as === child.alias && frame.id === '11')
      const stolen = await rpc(g.sock, g.setPeer, childPipe, { op: 'ack', conv: child.conv, receipt: 'rcpt-10', leaseId: 'lease-10', id: '10' })
      expect(stolen.ok).toBe(false)
      expect(g.frames.filter(frame => frame.type === 'ack').every(frame => frame.as === child.alias)).toBe(true)

      const stranger = await rpc(g.sock, g.setPeer, { pid: 9, exe: '/bin/bash', ppid: child.pid }, { op: 'check_inbox', conv: child.conv })
      expect(stranger.ok).toBe(false)
      expect(JSON.stringify(stranger)).not.toContain('SECRET')
      const mode = (await stat(g.sock)).mode & 0o777
      expect(mode).toBe(0o600)
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
      expect(missing).toMatchObject({ ok: false, error: 'conv required' })
      const alpha = await rpc(g.sock, g.setPeer, who, { op: 'check_inbox', conv: 'alpha', cwd: '/other' })
      expect(JSON.stringify(alpha)).toContain('ALPHA')
      expect(JSON.stringify(alpha)).not.toContain('BETA')
      expect(g.frames.some(frame => frame.type === 'lease' && frame.as === sharedA.alias)).toBe(true)
      const beta = await rpc(g.sock, g.setPeer, who, { op: 'check_inbox', conv: 'beta' })
      expect(JSON.stringify(beta)).toContain('BETA')
      expect(JSON.stringify(beta)).not.toContain('ALPHA')
      const foreign = await rpc(g.sock, g.setPeer, who, { op: 'check_inbox', conv: parent.conv })
      expect(foreign).toMatchObject({ ok: false, error: 'conv not registered' })
    } finally { await g.gw.close() }
  })

  test('held or refused does not fall through and starts no model turn', async () => {
    const g = await gateway()
    try {
      for (const [s, target, id] of [['held', parent, '11'], ['refused', child, '12']] as const) {
        const primary = new FakeAdapter('codex', { s })
        const fallback = new FakeAdapter('agy')
        g.gw.setAdapters([primary, fallback])
        const result = await g.gw.deliver(target, id)
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
      const primary = new FakeAdapter('codex', { s: 'unavailable' })
      const fallback = new FakeAdapter('codex', { s: 'woken', nativeId: 'q' })
      g.gw.setAdapters([primary, fallback])
      const fall = { ...parent, conv: 'fall-conv', alias: 'codex@nas642:fall' }
      const woken = await g.gw.deliver(fall, '13')
      expect(woken).toEqual({ s: 'woken', nativeId: 'q' })
      expect(primary.wakeCalls).toBe(1)
      expect(primary.turns).toBe(0)
      expect(fallback.turns).toBe(1)
      const mode = (await stat(join(g.dir, 'wakes.json'))).mode & 0o777
      expect(mode).toBe(0o600)
    } finally { await g.gw.close() }
  })

  test('no adapter does not finish a wake row or tell the router', async () => {
    const g = await gateway()
    try {
      g.gw.setAdapters([])
      const result = await g.gw.deliver(parent, '99')
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
      await expect(g.gw.deliver(parent, '21')).rejects.toThrow('crash')
      expect(fake.wakeCalls).toBe(1)
      expect(fake.turns).toBe(0)
      const again = await g.gw.deliver(parent, '21')
      expect(again).toEqual({ s: 'woken', nativeId: 'reconciled' })
      expect(fake.wakeCalls).toBe(1)
      expect(fake.reconcileCalls).toBe(1)
      expect(fake.seen[0]).toEqual(makeNudge('codex', parent.conv, '21'))
    } finally { await g.gw.close() }
  })

  test('a second message does not wake while the first nudge is unacked', async () => {
    const g = await gateway()
    try {
      const fake = new FakeAdapter('codex')
      g.gw.setAdapters([fake])
      await g.gw.deliver(parent, '31')
      const second = await g.gw.deliver(parent, '32')
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
      expect(g.frames.some(frame => frame.type === 'wakeResult' && frame.id === '78' && frame.result.s === 'woken')).toBe(true)
      expect(g.frames.some(frame => frame.type === 'mark' && frame.id === '78')).toBe(false)
    } finally { await g.gw.close() }
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
    expect(() => WakeStore.load(dir)).toThrow()
  })
})
