import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentChannels } from '../agent-channels.js'
import { Inboxes } from '../inboxes.js'
import { NAME_LEASE_MS, NameLeases } from '../name-leases.js'
import { Claims, NodeRegistry } from '../nodes.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { Subscriptions } from '../subscriptions.js'
import { DEFAULT_SWARM, SwarmConfig, parseSwarmConfig } from '../swarm-config.js'
import { SwarmJournal } from '../swarm-journal.js'
import { applySwarmConfigReload, createWsHandlers, knownSwarm, type WsDeps, type WsLike } from '../ws.js'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarm-pr1a-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

interface TestPeer {
  ws: WsLike
  frames: Record<string, unknown>[]
  closed: boolean
  sessionNameAtClose: string | null | undefined
  sendCbAtClose: unknown
}

function makePeer(): TestPeer {
  const peer: TestPeer = {
    frames: [],
    closed: false,
    sessionNameAtClose: undefined,
    sendCbAtClose: undefined,
    ws: null as unknown as WsLike,
  }
  peer.ws = {
    data: { sessionName: null, sendCallback: null },
    send(raw: string) { peer.frames.push(JSON.parse(raw)) },
    close() {
      peer.closed = true
      peer.sessionNameAtClose = peer.ws.data.sessionName
      peer.sendCbAtClose = peer.ws.data.sendCallback
    },
  }
  return peer
}

function makeRouter(dir: string, opts: {
  swarmConfig?: SwarmConfig
  extra?: Partial<WsDeps>
  sentMessages?: Array<{ chatId: string; content: string }>
} = {}) {
  const leases = NameLeases.inStateDir(dir)
  const sessions = new SessionManager(leases)
  const subs = Subscriptions.inStateDir(dir)
  const inboxes = Inboxes.inStateDir(dir)
  const claims = Claims.inStateDir(dir)
  const nodes = new NodeRegistry()
  const swarmJournal = SwarmJournal.inStateDir(dir)
  const sent = opts.sentMessages ?? []
  const client = {
    channels: {
      fetch: mock(async (id: string) => ({
        isTextBased: () => true,
        send: mock(async (payload: { content: string }) => {
          sent.push({ chatId: id, content: payload.content })
          return { id: `msg-${sent.length}` }
        }),
      })),
    },
  } as unknown as WsDeps['client']
  const deps: WsDeps = {
    sessions,
    history: new ProjectHistory(dir),
    client,
    chatId: () => 'default-chat',
    chunkLimit: 2000,
    chunkMode: 'length',
    replyToMode: 'first',
    busChannelId: 'bus-default',
    subs,
    inboxes,
    claims,
    nodes,
    swarmConfig: opts.swarmConfig,
    swarmJournal,
    ...opts.extra,
  }
  return { deps, sessions, subs, inboxes, claims, nodes, swarmJournal, leases, sent, handlers: createWsHandlers(deps) }
}

function send(r: ReturnType<typeof makeRouter>, p: TestPeer, frame: Record<string, unknown>) {
  r.handlers.message(p.ws, JSON.stringify(frame))
}

describe('SwarmConfig', () => {
  test('absent file runs unconfigured; every raw swarm normalises to default', () => {
    const dir = tempDir()
    const cfg = SwarmConfig.inStateDir(dir)
    expect(cfg.isConfigured()).toBe(false)
    expect(cfg.normalizeSwarm(undefined)).toEqual({ ok: true, swarm: DEFAULT_SWARM })
    expect(cfg.normalizeSwarm('work')).toEqual({ ok: true, swarm: DEFAULT_SWARM })
    expect(cfg.normalizeSwarm('cfd')).toEqual({ ok: true, swarm: DEFAULT_SWARM })
    expect(cfg.normalizeSwarm('0')).toEqual({ ok: true, swarm: DEFAULT_SWARM })
  })

  test('malformed file at cold start puts router in configured-empty mode', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'swarms-config.json'), '{not valid json')
    const cfg = SwarmConfig.inStateDir(dir)
    expect(cfg.isConfigured()).toBe(true)
    expect(cfg.swarmIds()).toEqual([])
    expect(cfg.normalizeSwarm(undefined)).toEqual({ ok: true, swarm: DEFAULT_SWARM })
    expect(cfg.normalizeSwarm('')).toEqual({ ok: true, swarm: DEFAULT_SWARM })
    expect(cfg.normalizeSwarm('agents')).toEqual({ ok: true, swarm: DEFAULT_SWARM })
    expect(cfg.normalizeSwarm('0')).toEqual({ ok: true, swarm: DEFAULT_SWARM })
    expect(cfg.normalizeSwarm('7')).toEqual({ ok: true, swarm: DEFAULT_SWARM })
    expect(cfg.normalizeSwarm('cfd')).toEqual({ ok: false, error: 'unknown_swarm' })
  })

  test('validates reserved IDs, all-numeric IDs, duplicate candidates, retired overlap, and non-default crossSwarm candidates', () => {
    for (const bad of ['default', 'agents', 'archive', 'all', 'human', '0', '42', 'BadCase', 'a_b']) {
      expect(() => parseSwarmConfig({ swarms: { [bad]: {} } })).toThrow()
    }
    // Duplicate candidate across swarms
    expect(() => parseSwarmConfig({
      swarms: {
        cfd: { candidates: [{ alias: 'claude@mac:m1', priority: 1 }] },
        bus: { candidates: [{ alias: 'claude@mac:m1', priority: 2 }] },
      },
    })).toThrow(/duplicate candidate/)
    // Swarm id in both swarms and retired
    expect(() => parseSwarmConfig({
      swarms: { cfd: {} },
      retired: ['cfd'],
    })).toThrow(/both swarms and retired/)
    // crossSwarm alias as non-default candidate
    expect(() => parseSwarmConfig({
      swarms: { cfd: { candidates: [{ alias: 'claude@mac:boss', priority: 1 }] } },
      crossSwarm: ['claude@mac:boss'],
    })).toThrow(/non-default swarm/)
    // defaultSessions entry overlapping a configured swarm id (m4)
    expect(() => parseSwarmConfig({
      swarms: { cfd: {} },
      defaultSessions: ['agents', 'cfd'],
    })).toThrow(/configured swarm id/)
    // crossSwarm alias as default candidate IS allowed (§1)
    const ok = parseSwarmConfig({
      swarms: { cfd: {} },
      default: { candidates: [{ alias: 'claude@mac:boss', priority: 1 }] },
      crossSwarm: ['claude@mac:boss'],
    })
    expect(ok.crossSwarm.has('claude@mac:boss')).toBe(true)
    expect(ok.candidateToSwarm.get('claude@mac:boss')).toBe(DEFAULT_SWARM)
  })

  test('reload keeps last good config on malformed file and picks up valid edits', () => {
    const dir = tempDir()
    const file = join(dir, 'swarms-config.json')
    writeFileSync(file, JSON.stringify({ swarms: { cfd: {} }, defaultSessions: ['0'] }))
    const cfg = SwarmConfig.inStateDir(dir)
    expect(cfg.hasSwarm('cfd')).toBe(true)

    // Write malformed update with bumped mtime
    writeFileSync(file, '{broken')
    const t1 = new Date(Date.now() + 5000)
    utimesSync(file, t1, t1)
    expect(cfg.reload()).toBeNull()
    expect(cfg.hasSwarm('cfd')).toBe(true)

    // Write valid update adding test1
    writeFileSync(file, JSON.stringify({ swarms: { cfd: {}, test1: {} }, defaultSessions: ['0'] }))
    const t2 = new Date(Date.now() + 10000)
    utimesSync(file, t2, t2)
    const diff = cfg.reload()
    expect(diff?.addedSwarms).toEqual(['test1'])
    expect(cfg.hasSwarm('test1')).toBe(true)
  })
})

describe('PR1a registration, naming, and normalisation', () => {
  test('no config: seat in hand-made session "work" or "0" stays claude@mac:src', () => {
    const r = makeRouter(tempDir(), { swarmConfig: SwarmConfig.absent() })
    const p1 = makePeer()
    send(r, p1, { type: 'register', name: 'claude@mac:src', generated: true, swarm: 'work', projectPath: '/src', instanceId: 'i1' })
    expect(p1.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:src', swarm: 'default' })

    const p2 = makePeer()
    send(r, p2, { type: 'register', name: 'claude@mac:other', generated: true, swarm: '0', projectPath: '/other', instanceId: 'i2' })
    expect(p2.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:other', swarm: 'default' })
  })

  test('same dir in agents and cfd gives claude@mac:src and claude@mac:cfd/src in either start order', () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} }, defaultSessions: ['agents', '0'] })
    // Order 1: default then cfd
    const r1 = makeRouter(tempDir(), { swarmConfig: cfg })
    const a1 = makePeer(), b1 = makePeer()
    send(r1, a1, { type: 'register', name: 'claude@mac:src', generated: true, swarm: 'agents', projectPath: '/src', instanceId: 'a1' })
    send(r1, b1, { type: 'register', name: 'claude@mac:src', generated: true, swarm: 'cfd', projectPath: '/src', instanceId: 'b1' })
    expect(a1.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:src', swarm: 'default', defaultSessions: ['agents', '0'] })
    expect(b1.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:cfd/src', swarm: 'cfd' })

    // Order 2: cfd then default
    const r2 = makeRouter(tempDir(), { swarmConfig: cfg })
    const a2 = makePeer(), b2 = makePeer()
    send(r2, b2, { type: 'register', name: 'claude@mac:src', generated: true, swarm: 'cfd', projectPath: '/src', instanceId: 'b2' })
    send(r2, a2, { type: 'register', name: 'claude@mac:src', generated: true, swarm: 'agents', projectPath: '/src', instanceId: 'a2' })
    expect(b2.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:cfd/src', swarm: 'cfd' })
    expect(a2.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:src', swarm: 'default' })
  })

  test('defaultSessions ("0"), all-numeric ("7") map to default; unlisted and retired get unknown_swarm', () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} }, defaultSessions: ['0'], retired: ['old'] })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const p0 = makePeer(), p7 = makePeer(), pWork = makePeer(), pOld = makePeer()
    send(r, p0, { type: 'register', name: 'claude@mac:a', generated: true, swarm: '0', projectPath: '/a', instanceId: '0' })
    send(r, p7, { type: 'register', name: 'claude@mac:b', generated: true, swarm: '7', projectPath: '/b', instanceId: '7' })
    send(r, pWork, { type: 'register', name: 'claude@mac:c', generated: true, swarm: 'work', projectPath: '/c', instanceId: 'w' })
    send(r, pOld, { type: 'register', name: 'claude@mac:d', generated: true, swarm: 'old', projectPath: '/d', instanceId: 'o' })
    expect(p0.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:a', swarm: 'default' })
    expect(p7.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:b', swarm: 'default' })
    expect(pWork.frames.at(-1)).toEqual({ type: 'error', message: 'register rejected: unknown_swarm' })
    expect(pOld.frames.at(-1)).toEqual({ type: 'error', message: 'register rejected: unknown_swarm' })
  })

  test('name is never parsed for its swarm: claude@mac:cfd/x in default stays default', () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const p = makePeer()
    send(r, p, { type: 'register', name: 'claude@mac:cfd/x', swarm: 'agents', projectPath: '/x', instanceId: 'i1' })
    expect(p.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:cfd/x', swarm: 'default' })
    expect(r.sessions.getSwarm('claude@mac:cfd/x')).toBe('default')
  })
})

describe('PR1a protected aliases & candidates', () => {
  test('crossSwarm outside default and candidate outside its swarm are rejected with protected_alias', () => {
    const cfg = SwarmConfig.fromObject({
      swarms: { cfd: { candidates: [{ alias: 'claude@mac:cfd-master', priority: 1 }] } },
      crossSwarm: ['claude@mac:ops-fixer'],
    })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const pCross = makePeer(), pCand = makePeer()
    send(r, pCross, { type: 'register', name: 'claude@mac:ops-fixer', swarm: 'cfd', projectPath: '/', instanceId: '1' })
    send(r, pCand, { type: 'register', name: 'claude@mac:cfd-master', swarm: 'agents', projectPath: '/', instanceId: '2' })
    expect(pCross.frames.at(-1)).toEqual({ type: 'error', message: 'register rejected: protected_alias' })
    expect(pCand.frames.at(-1)).toEqual({ type: 'error', message: 'register rejected: protected_alias' })
  })

  test('restarted unpinned crossSwarm seat whose lease is held is rejected (not given -2); pinned takeover succeeds', () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} }, crossSwarm: ['claude@mac:ops-fixer'] })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const first = makePeer()
    send(r, first, { type: 'register', name: 'claude@mac:ops-fixer', agent: 'claude', swarm: 'agents', projectPath: '/', instanceId: 'pid-1' })
    expect(first.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:ops-fixer' })
    r.handlers.close(first.ws)

    // Unpinned restart with new PID -> lease held by pid-1 -> would get -2 -> rejected!
    const unpinned = makePeer()
    send(r, unpinned, { type: 'register', name: 'claude@mac:ops-fixer', agent: 'claude', swarm: 'agents', projectPath: '/', instanceId: 'pid-2', takeover: false })
    expect(unpinned.frames.at(-1)).toEqual({ type: 'error', message: 'register rejected: protected_alias' })

    // Pinned restart (takeover: true) -> exact match succeeds
    const pinned = makePeer()
    send(r, pinned, { type: 'register', name: 'claude@mac:ops-fixer', agent: 'claude', swarm: 'agents', projectPath: '/', instanceId: 'pid-2', takeover: true })
    expect(pinned.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:ops-fixer' })
  })

  test('rename cannot claim crossSwarm or candidate alias; observeDirectChannel excludes candidates but not crossSwarm', () => {
    const dir = tempDir()
    const cfg = SwarmConfig.fromObject({
      swarms: { cfd: { candidates: [{ alias: 'claude@mac:cfd-master', priority: 1 }] } },
      crossSwarm: ['claude@mac:ops-fixer'],
    })
    const agentChannels = new AgentChannels(dir)
    const r = makeRouter(dir, { swarmConfig: cfg, extra: { agentChannels } })

    const pCross = makePeer(), pCand = makePeer(), pNorm = makePeer()
    send(r, pCross, { type: 'register', name: 'claude@mac:ops-fixer', agent: 'claude', swarm: 'agents', projectPath: '/', instanceId: '1' })
    send(r, pCand, { type: 'register', name: 'claude@mac:cfd-master', agent: 'claude', swarm: 'cfd', projectPath: '/', instanceId: '2' })
    send(r, pNorm, { type: 'register', name: 'claude@mac:worker', agent: 'claude', swarm: 'agents', projectPath: '/', instanceId: '3' })

    // Rename attempts blocked
    send(r, pNorm, { type: 'rename', name: 'claude@mac:ops-fixer' })
    expect(pNorm.frames.at(-1)).toEqual({ type: 'error', message: 'invalid_bus_alias' })
    send(r, pNorm, { type: 'rename', name: 'claude@mac:cfd-master-2' })
    expect(pNorm.frames.at(-1)).toEqual({ type: 'error', message: 'invalid_bus_alias' })

    // Direct channel eligibility: crossSwarm gets registered as candidate for direct channel; master candidate does NOT
    const ensured: string[] = []
    return agentChannels.maintain({
      async ensure(info) { ensured.push(info.name); return `ch-${ensured.length}` },
      async update() {},
    }, () => true, Date.now() + 120_000).then(() => {
      expect(ensured).toContain('claude@mac:ops-fixer')
      expect(ensured).toContain('claude@mac:worker')
      expect(ensured).not.toContain('claude@mac:cfd-master')
    })
  })

  test('pull-mode role:master rejected; unlisted push-mode role:master registers with not_master_candidate warning', () => {
    const cfg = SwarmConfig.fromObject({
      swarms: { cfd: { candidates: [{ alias: 'claude@mac:cfd-m1', priority: 1 }] } },
    })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const pPull = makePeer(), pUnlisted = makePeer(), pValid = makePeer()
    send(r, pPull, { type: 'register', name: 'claude@mac:cfd-m1', swarm: 'cfd', mode: 'pull', role: 'master', projectPath: '/', instanceId: '1' })
    expect(pPull.frames.at(-1)).toEqual({ type: 'error', message: 'register rejected: pull_mode_master' })

    send(r, pUnlisted, { type: 'register', name: 'claude@mac:rando', swarm: 'cfd', mode: 'push', role: 'master', projectPath: '/', instanceId: '2' })
    expect(pUnlisted.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:rando', warning: 'not_master_candidate' })

    send(r, pValid, { type: 'register', name: 'claude@mac:cfd-m1', swarm: 'cfd', mode: 'push', role: 'master', projectPath: '/', instanceId: '3' })
    const validResp = pValid.frames.at(-1)!
    expect(validResp).toMatchObject({ type: 'registered', name: 'claude@mac:cfd-m1', swarm: 'cfd' })
    expect(validResp.warning).toBeUndefined()
  })
})

describe('PR1a dedup, siblings, leases, and subscriptions', () => {
  test('same instanceId on same host+swarm merges; different host never merges or steals subs', () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const macA = makePeer(), macB = makePeer(), nas = makePeer()
    send(r, macA, { type: 'register', name: 'claude@mac:src', host: 'mac', swarm: 'agents', projectPath: '/src', instanceId: 'pid-99' })
    r.subs.add('claude@mac:src', 'chan-mac')
    send(r, macB, { type: 'register', name: 'claude@mac:src', host: 'mac', swarm: 'agents', projectPath: '/src', instanceId: 'pid-99' })
    expect(macB.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:src' })
    expect(r.sessions.getSessions()).toHaveLength(1)

    // Different host with identical PID
    send(r, nas, { type: 'register', name: 'claude@nas642:src', host: 'nas642', swarm: 'agents', projectPath: '/src', instanceId: 'pid-99' })
    expect(nas.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@nas642:src' })
    expect(r.sessions.getSessions()).toHaveLength(2)
    expect(r.subs.of('claude@mac:src')).toEqual(['chan-mac'])
    expect(r.subs.of('claude@nas642:src')).toEqual([])
  })

  test('PR1 restart over pre-existing name-leases.json (without host) preserves every -N seat', () => {
    const dir = tempDir()
    const now = Date.now()
    writeFileSync(join(dir, 'name-leases.json'), JSON.stringify({
      'agy@nas642:p1': { instanceId: 'seat-a', lastSeen: now },
      'agy@nas642:p1-2': { instanceId: 'seat-b', lastSeen: now },
    }))
    const r = makeRouter(dir, { swarmConfig: SwarmConfig.fromObject({ swarms: { cfd: {} } }) })
    const pb = makePeer(), pa = makePeer()
    send(r, pb, { type: 'register', name: 'agy@nas642:p1', host: 'nas642', instanceId: 'seat-b', projectPath: '/' })
    send(r, pa, { type: 'register', name: 'agy@nas642:p1', host: 'nas642', instanceId: 'seat-a', projectPath: '/' })
    expect(pb.frames.at(-1)).toMatchObject({ type: 'registered', name: 'agy@nas642:p1-2' })
    expect(pa.frames.at(-1)).toMatchObject({ type: 'registered', name: 'agy@nas642:p1' })
  })

  test('two sibling processes across move-window end in one slot with swarm_changed and no reconnect loop', () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const sibA = makePeer(), sibB = makePeer()
    send(r, sibA, { type: 'register', name: 'claude@mac:src', generated: true, host: 'mac', swarm: 'agents', projectPath: '/src', instanceId: 'pid-42' })
    send(r, sibB, { type: 'register', name: 'claude@mac:src', generated: true, host: 'mac', swarm: 'agents', projectPath: '/src', instanceId: 'pid-42' })
    expect(r.sessions.getSessions()).toHaveLength(1)

    // sibA (even though it was primary!) disconnects and reconnects after move-window to cfd
    r.handlers.close(sibA.ws)
    // sibB promoted -> slot still alive in default!
    expect(r.sessions.getSessions()).toHaveLength(1)
    expect(r.sessions.getSwarm('claude@mac:src')).toBe('default')

    const sibA2 = makePeer()
    send(r, sibA2, { type: 'register', name: 'claude@mac:src', generated: true, host: 'mac', swarm: 'cfd', projectPath: '/src', instanceId: 'pid-42' })
    expect(sibA2.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:cfd/src', swarm: 'cfd' })
    // sibB was NOT closed; it received swarm_changed!
    expect(sibB.closed).toBe(false)
    expect(sibB.frames.at(-1)).toEqual({ type: 'swarm_changed', swarm: 'cfd' })
    expect(sibB.ws.data.sessionName).toBeNull()

    // sibB re-registers on the SAME socket in cfd -> merges into sibA2's slot!
    send(r, sibB, { type: 'register', name: 'claude@mac:src', generated: true, host: 'mac', swarm: 'cfd', projectPath: '/src', instanceId: 'pid-42' })
    expect(sibB.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:cfd/src', swarm: 'cfd' })
    expect(r.sessions.getSessions()).toHaveLength(1)
    expect(r.sessions.getSwarm('claude@mac:cfd/src')).toBe('cfd')
  })
})

describe('PR1a journal, moves, collisions, takeover, rename, gateway & node', () => {
  test('explicit name reused in another swarm gets -N; two pull-mode seats in two swarms both stay registered', () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const pDef = makePeer(), pCfd = makePeer()
    send(r, pDef, { type: 'register', name: 'codex@mac:shared', mode: 'pull', agent: 'codex', swarm: 'agents', projectPath: '/', instanceId: 'p1' })
    send(r, pCfd, { type: 'register', name: 'codex@mac:shared', mode: 'pull', agent: 'codex', swarm: 'cfd', projectPath: '/', instanceId: 'p2' })
    expect(pDef.frames.at(-1)).toMatchObject({ type: 'registered', name: 'codex@mac:shared', swarm: 'default' })
    expect(pCfd.frames.at(-1)).toMatchObject({ type: 'registered', name: 'codex@mac:shared-2', swarm: 'cfd' })
    expect(r.sessions.getSessions()).toHaveLength(2)
  })

  test('explicit alias moved agents -> cfd -> agents by same holder keeps name, drops subs/claims, flushes legacy inbox', async () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const sent: Array<{ chatId: string; content: string }> = []
    const r = makeRouter(tempDir(), {
      swarmConfig: cfg,
      sentMessages: sent,
      extra: { swarmGeneralChannel: s => (s === 'cfd' ? 'cfd-general' : undefined) },
    })

    // Register in default, add sub, claim, and disconnect with queued legacy mail
    const p1 = makePeer()
    send(r, p1, { type: 'register', name: 'my-seat', host: 'mac', swarm: 'agents', projectPath: '/', instanceId: 'inst-1' })
    expect(p1.frames.at(-1)).toMatchObject({ type: 'registered', name: 'my-seat', swarm: 'default' })
    r.subs.add('my-seat', 'default-topic')
    r.claims.claim('task-1', 'my-seat')
    r.handlers.close(p1.ws)
    r.inboxes.push('my-seat', 'old mail', { from: 'alice' })
    expect(r.inboxes.count('my-seat')).toBe(1)

    // Same holder reconnects in cfd -> MOVE (keeps exact name 'my-seat')
    const p2 = makePeer()
    send(r, p2, { type: 'register', name: 'my-seat', host: 'mac', swarm: 'cfd', projectPath: '/', instanceId: 'inst-1' })
    expect(p2.frames.at(-1)).toMatchObject({ type: 'registered', name: 'my-seat', swarm: 'cfd' })
    expect(r.subs.of('my-seat')).toEqual([])
    expect(r.claims.hasOwner('my-seat')).toBe(false)
    await new Promise(res => setTimeout(res, 15))
    expect(r.inboxes.count('my-seat')).toBe(0)
    // Message body is reposted verbatim to old general with undelivered header (M2)
    expect(sent.some(m => m.chatId === 'bus-default' && m.content.includes('undelivered') && m.content.includes('old mail'))).toBe(true)

    // Move back cfd -> agents when cfd general is unresolvable: queued rows stay unacked and are NOT pushed (M2)
    const rNoGen = makeRouter(tempDir(), { swarmConfig: cfg, extra: { swarmGeneralChannel: () => undefined } })
    const m1 = makePeer()
    send(rNoGen, m1, { type: 'register', name: 'mover2', host: 'mac', swarm: 'cfd', projectPath: '/', instanceId: 'inst-2', conversationId: 'conv-m2' })
    rNoGen.handlers.close(m1.ws)
    rNoGen.inboxes.push('mover2', 'important cfd body', { from: 'peer' })
    const m2 = makePeer()
    send(rNoGen, m2, { type: 'register', name: 'mover2', host: 'mac', swarm: 'agents', projectPath: '/', instanceId: 'inst-2', conversationId: 'conv-m2' })
    expect(m2.frames.at(-1)).toMatchObject({ type: 'registered', name: 'mover2', swarm: 'default' })
    expect(m2.frames.some(f => f.type === 'message')).toBe(false)
    expect(rNoGen.inboxes.count('mover2')).toBe(1)

    // Move back cfd -> agents -> keeps exact name 'my-seat'
    r.handlers.close(p2.ws)
    const p3 = makePeer()
    send(r, p3, { type: 'register', name: 'my-seat', host: 'mac', swarm: 'agents', projectPath: '/', instanceId: 'inst-1' })
    expect(p3.frames.at(-1)).toMatchObject({ type: 'registered', name: 'my-seat', swarm: 'default' })
  })

  test('B1 repro: non-default seat with conversationId keeps exact name across disconnect and reconnect (no -2)', () => {
    const dir = tempDir()
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const r = makeRouter(dir, { swarmConfig: cfg })

    const p1 = makePeer()
    send(r, p1, {
      type: 'register', name: 'claude@mac:src', generated: true, host: 'mac',
      swarm: 'cfd', projectPath: '/src', instanceId: 'pid-1', conversationId: 'conv-abc',
    })
    expect(p1.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:cfd/src', swarm: 'cfd' })

    // Disconnect -> journal entry MUST stay because legacyConversations remembers the name!
    r.handlers.close(p1.ws)
    expect(r.swarmJournal.get('claude@mac:cfd/src')?.swarm).toBe('cfd')

    // Reconnect (same instance) -> knownSwarm is still 'cfd', so NO -2 collision!
    const p2 = makePeer()
    send(r, p2, {
      type: 'register', name: 'claude@mac:src', generated: true, host: 'mac',
      swarm: 'cfd', projectPath: '/src', instanceId: 'pid-1', conversationId: 'conv-abc',
    })
    expect(p2.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:cfd/src', swarm: 'cfd' })

    // Also verify after router restart with no lease (different instanceId, expired lease)
    r.handlers.close(p2.ws)
    const rRestarted = makeRouter(dir, { swarmConfig: cfg })
    const p3 = makePeer()
    send(rRestarted, p3, {
      type: 'register', name: 'claude@mac:src', generated: true, host: 'mac',
      swarm: 'cfd', projectPath: '/src', conversationId: 'conv-abc',
    })
    expect(p3.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:cfd/src', swarm: 'cfd' })
  })

  test('M1/m1/m4: no-config primary close keeps old semantics; legacy bare instanceId reclaim works; overlong generated name rejects', () => {
    // M1: with no config, primary closing deregisters even when extraSend exists
    const rNoCfg = makeRouter(tempDir(), { swarmConfig: SwarmConfig.absent() })
    const s1 = makePeer(), s2 = makePeer()
    send(rNoCfg, s1, { type: 'register', name: 'claude@mac:src', host: 'mac', projectPath: '/src', instanceId: 'p1' })
    send(rNoCfg, s2, { type: 'register', name: 'claude@mac:src', host: 'mac', projectPath: '/src', instanceId: 'p1' })
    rNoCfg.handlers.close(s1.ws)
    expect(rNoCfg.sessions.getSessions()).toHaveLength(0)

    // m1: pre-PR1 subscriptions.json with bare instanceId owner is reclaimed on host:instanceId register
    const dir = tempDir()
    writeFileSync(join(dir, 'subscriptions.json'), JSON.stringify({
      version: 1,
      legacy: { 'claude@mac:old': ['chan-1'] },
      native: {},
      owners: { 'claude@mac:old': 'legacy-pid-7' },
    }))
    const subs = Subscriptions.inStateDir(dir)
    subs.reclaim('claude@mac:new', 'legacy-pid-7', 'mac')
    expect(subs.of('claude@mac:new')).toEqual(['chan-1'])

    // m4: generated name exceeding 128 chars after swarm prefix rejects with "name too long"
    const cfg = SwarmConfig.fromObject({ swarms: { 'very-long-swarm-name': {} } })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const pLong = makePeer()
    const longBase = `claude@mac:${'a'.repeat(110)}`
    send(r, pLong, { type: 'register', name: longBase, generated: true, swarm: 'very-long-swarm-name', projectPath: '/' })
    expect(pLong.frames.at(-1)).toEqual({ type: 'error', message: 'register rejected: name too long' })
  })

  test('cross-swarm bus_rename to offline cfd alias gets -2 without stealing mail, subs, or #26 channel', () => {
    const dir = tempDir()
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const r = makeRouter(dir, { swarmConfig: cfg })

    const pCfd = makePeer()
    send(r, pCfd, { type: 'register', name: 'cfd-offline', host: 'mac', swarm: 'cfd', projectPath: '/', instanceId: 'cfd-1' })
    r.subs.add('cfd-offline', 'cfd-chan')
    r.handlers.close(pCfd.ws)
    r.inboxes.push('cfd-offline', 'secret cfd mail', { from: 'cfd-peer' })
    expect(knownSwarm(r.deps, 'cfd-offline')).toBe('cfd')

    const pDef = makePeer()
    send(r, pDef, { type: 'register', name: 'def-agent', host: 'mac', swarm: 'agents', projectPath: '/', instanceId: 'def-1' })
    send(r, pDef, { type: 'rename', name: 'cfd-offline' })
    expect(pDef.frames.at(-1)).toMatchObject({ type: 'renamed', oldName: 'def-agent', newName: 'cfd-offline-2' })
    expect(r.inboxes.count('cfd-offline')).toBe(1)
    expect(r.inboxes.count('cfd-offline-2')).toBe(0)
    expect(r.subs.of('cfd-offline')).toEqual(['cfd-chan'])
    expect(r.subs.of('cfd-offline-2')).toEqual([])
    expect(r.swarmJournal.get('cfd-offline')?.swarm).toBe('cfd')
    expect(r.swarmJournal.get('cfd-offline-2')?.swarm).toBe('default')
  })

  test('journal entry is deleted on disconnect when offline with no inbox, subs, or claims', () => {
    const cfg = SwarmConfig.fromObject({ swarms: { cfd: {} } })
    const r = makeRouter(tempDir(), { swarmConfig: cfg })
    const p = makePeer()
    send(r, p, { type: 'register', name: 'ephemeral', swarm: 'cfd', projectPath: '/', instanceId: 'e1' })
    expect(r.swarmJournal.get('ephemeral')?.swarm).toBe('cfd')
    r.handlers.close(p.ws)
    expect(r.swarmJournal.get('ephemeral')).toBeUndefined()
  })

  test('cross-swarm registerAgent refused before inboxes.bind and registerNode refuses non-default aliases', () => {
    const dir = tempDir()
    const cfg = SwarmConfig.fromObject({
      swarms: { cfd: { candidates: [{ alias: 'codex@nas642:cfd-m1', priority: 1 }] } },
    })
    const secret = 'node-secret-xyz'
    const hash = createHash('sha256').update(secret).digest('hex')
    const r = makeRouter(dir, {
      swarmConfig: cfg,
      extra: { nodeSecrets: () => ({ hashes: { nas642: hash }, require: true }) },
    })

    // Live cfd session
    const cfdSeat = makePeer()
    send(r, cfdSeat, { type: 'register', name: 'codex@nas642:cfd-live', host: 'nas642', swarm: 'cfd', projectPath: '/', instanceId: 'c1' })

    // Gateway tries to registerAgent for live cfd alias -> refused before inboxes.bind!
    const gw = makePeer()
    send(r, gw, { type: 'registerGateway', host: 'nas642', user: 'mick', proto: 1, secret, requestId: 'g1' })
    send(r, gw, { type: 'registerAgent', kind: 'codex', conv: 'conv-1', alias: 'codex@nas642:cfd-live', requestId: 'g2' })
    expect(gw.frames.at(-1)).toEqual({ type: 'toolResult', requestId: 'g2', success: false, data: 'cross_swarm' })
    expect(r.inboxes.target('codex@nas642:cfd-live')).toBeUndefined()
    expect(r.sessions.getSwarm('codex@nas642:cfd-live')).toBe('cfd')

    // registerNode refuses both live cfd alias and non-default candidate alias
    const node1 = makePeer()
    send(r, node1, { type: 'registerNode', node: 'nas642', nodeSecret: secret, agents: [{ name: 'codex@nas642:cfd-live', kind: 'codex' }] })
    expect(node1.frames.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('cross_swarm') })
    expect(r.nodes.get('codex@nas642:cfd-live')).toBeUndefined()

    const node2 = makePeer()
    send(r, node2, { type: 'registerNode', node: 'nas642', nodeSecret: secret, agents: [{ name: 'codex@nas642:cfd-m1', kind: 'codex' }] })
    expect(node2.frames.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('cross_swarm') })
  })

  test('config reload closes only sessions whose swarm changed or that left candidates/crossSwarm (nulling ws.data first)', () => {
    const dir = tempDir()
    const file = join(dir, 'swarms-config.json')
    writeFileSync(file, JSON.stringify({
      swarms: {
        cfd: { candidates: [{ alias: 'claude@mac:m1', priority: 1 }, { alias: 'claude@mac:m2', priority: 2 }] },
      },
      crossSwarm: ['claude@mac:ops'],
    }))
    const cfg = SwarmConfig.inStateDir(dir)
    const r = makeRouter(dir, { swarmConfig: cfg })

    const pM1 = makePeer(), pM2 = makePeer(), pOps = makePeer(), pWorker = makePeer()
    send(r, pM1, { type: 'register', name: 'claude@mac:m1', swarm: 'cfd', projectPath: '/', instanceId: '1' })
    send(r, pM2, { type: 'register', name: 'claude@mac:m2', swarm: 'cfd', projectPath: '/', instanceId: '2' })
    send(r, pOps, { type: 'register', name: 'claude@mac:ops', swarm: 'agents', projectPath: '/', instanceId: '3' })
    send(r, pWorker, { type: 'register', name: 'claude@mac:w', swarm: 'cfd', projectPath: '/', instanceId: '4' })

    // Priority edit only for m1, remove m2 from candidates, remove ops from crossSwarm; worker unchanged
    writeFileSync(file, JSON.stringify({
      swarms: {
        cfd: { candidates: [{ alias: 'claude@mac:m1', priority: 5 }] },
      },
      crossSwarm: [],
    }))
    const t = new Date(Date.now() + 5000)
    utimesSync(file, t, t)
    const diff = cfg.reload()!
    const closed = applySwarmConfigReload(r.deps, diff)

    expect(closed.sort()).toEqual(['claude@mac:m2', 'claude@mac:ops'])
    expect(pM1.closed).toBe(false)
    expect(pWorker.closed).toBe(false)
    expect(pM2.closed).toBe(true)
    expect(pM2.sessionNameAtClose).toBeNull()
    expect(pM2.sendCbAtClose).toBeNull()
    expect(pOps.closed).toBe(true)
    expect(pOps.sessionNameAtClose).toBeNull()
  })
})
