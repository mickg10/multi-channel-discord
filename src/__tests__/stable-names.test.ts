import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NAME_LEASE_MS, NameLeases } from '../name-leases.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { createWsHandlers, type WsDeps, type WsLike } from '../ws.js'

const BASE = 'agy@nas642:p1'
const dirs: string[] = []

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stable-names-'))
  dirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** One router: a session table over the leases in `dir`. A second one on the same
 *  directory is the router after a restart: its table is gone, the leases are on disk. */
function router(dir: string, now?: () => number, extra: Partial<WsDeps> = {}) {
  const sessions = new SessionManager(new NameLeases(join(dir, 'name-leases.json'), NAME_LEASE_MS, now))
  const deps: WsDeps = {
    sessions, history: new ProjectHistory(dir), client: {} as WsDeps['client'],
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first', ...extra,
  }
  return { sessions, handlers: createWsHandlers(deps) }
}
type Router = ReturnType<typeof router>

function peer() {
  const frames: Record<string, unknown>[] = []
  const ws: WsLike = {
    data: { sessionName: null, sendCallback: null },
    send(raw) { frames.push(JSON.parse(String(raw))) },
  }
  return { ws, frames }
}

/** Register `p` for the base name (unless the frame names another); returns the name the router gave. */
function register(r: Router, frame: Record<string, unknown>, p = peer()): string {
  r.handlers.message(p.ws, JSON.stringify({ type: 'register', name: BASE, projectPath: '/', ...frame }))
  const last = p.frames.at(-1)
  if (last?.type !== 'registered') throw new Error(`not registered: ${JSON.stringify(last)}`)
  return last.name as string
}

function leases(dir: string): Record<string, { instanceId: string; lastSeen: number }> {
  return JSON.parse(readFileSync(join(dir, 'name-leases.json'), 'utf8'))
}

function clock(start = 1_700_000_000_000) {
  const time = { now: start }
  return { now: () => time.now, advance(ms: number) { time.now += ms } }
}

describe('stable -N names across a router restart', () => {
  test('(a) three instances on one base name each get their own name back, whatever order they return in', () => {
    const dir = stateDir()
    const names: Record<string, string> = { 'seat-a': BASE, 'seat-b': `${BASE}-2`, 'seat-c': `${BASE}-3` }
    const before = router(dir)
    for (const seat of ['seat-a', 'seat-b', 'seat-c']) expect(register(before, { instanceId: seat })).toBe(names[seat])
    expect(Object.keys(leases(dir)).sort()).toEqual([BASE, `${BASE}-2`, `${BASE}-3`].sort())

    for (const order of [['seat-c', 'seat-b', 'seat-a'], ['seat-a', 'seat-c', 'seat-b'], ['seat-b', 'seat-a', 'seat-c']]) {
      const after = router(dir)                                         // the router restarted before this round
      for (const seat of order) expect(register(after, { instanceId: seat })).toBe(names[seat])
    }
  })

  test('a newcomer is kept off the names leased to seats that have not come back yet', () => {
    const dir = stateDir()
    for (const seat of ['seat-a', 'seat-b', 'seat-c']) register(router(dir), { instanceId: seat })
    const after = router(dir)
    expect(register(after, { instanceId: 'newcomer' })).toBe(`${BASE}-4`)
    expect(register(after, { instanceId: 'seat-b' })).toBe(`${BASE}-2`)
    expect(register(after, { instanceId: 'seat-a' })).toBe(BASE)
    expect(register(after, { instanceId: 'seat-c' })).toBe(`${BASE}-3`)
  })

  test('(b) a lease ends ten minutes after its holder was last seen', () => {
    const time = clock()
    const r = router(stateDir(), time.now)
    expect(register(r, { instanceId: 'seat-a' })).toBe(BASE)
    const b = peer()
    expect(register(r, { instanceId: 'seat-b' }, b)).toBe(`${BASE}-2`)

    time.advance(8 * 60_000)
    r.handlers.close(b.ws)                                              // seat b leaves: its lease is kept, dated now
    time.advance(3 * 60_000)
    expect(register(r, { instanceId: 'newcomer' })).toBe(`${BASE}-3`)   // three minutes on, `-2` is still seat b's

    const back = peer()
    expect(register(r, { instanceId: 'seat-b' }, back)).toBe(`${BASE}-2`)  // the same instance gets its own name back
    r.handlers.close(back.ws)                                           // and leaves again, dating the lease afresh

    time.advance(10 * 60_000 - 1)
    expect(register(r, { instanceId: 'another' })).toBe(`${BASE}-4`)    // a second short of ten minutes
    time.advance(2)
    expect(register(r, { instanceId: 'latecomer' })).toBe(`${BASE}-2`)  // ten minutes after seat b left: ended
  })

  test('(d) a client without an instance id is named as before: it holds no lease and is steered by none', () => {
    const dir = stateDir()
    const before = router(dir)
    expect(register(before, { instanceId: 'seat-a' })).toBe(BASE)
    expect(register(before, {})).toBe(`${BASE}-2`)
    expect(register(before, {})).toBe(`${BASE}-3`)
    expect(Object.keys(leases(dir))).toEqual([BASE])                    // only the seat with an instance id has a lease

    const after = router(dir)                                           // a restart; seat a has not come back
    expect(register(after, {})).toBe(BASE)                               // the first one back takes the base name, as before
    expect(register(after, {})).toBe(`${BASE}-2`)
    expect(register(after, { instanceId: 'seat-a' })).toBe(`${BASE}-3`)  // and seat a is moved along, as before
  })

  test('a connected instance is marked seen as time passes, so its lease outlasts the lease time', () => {
    const time = clock()
    const dir = stateDir()
    const r = router(dir, time.now)
    expect(register(r, { instanceId: 'seat-a' })).toBe(BASE)
    for (let minute = 0; minute < 30; minute++) {                       // the router's periodic refresh
      time.advance(60_000)
      r.sessions.refreshLeases()
    }
    const after = router(dir, time.now)                                 // half an hour later
    expect(register(after, { instanceId: 'newcomer' })).toBe(`${BASE}-2`)
    expect(register(after, { instanceId: 'seat-a' })).toBe(BASE)
  })

  test('an instance asking by name for the -N name it was given gets it', () => {
    const dir = stateDir()
    const before = router(dir)
    expect(register(before, { instanceId: 'seat-a' })).toBe(BASE)
    expect(register(before, { instanceId: 'seat-b' })).toBe(`${BASE}-2`)
    // what the plugin does on reconnect after a restart: the saved name, takeover off
    expect(register(router(dir), { name: `${BASE}-2`, instanceId: 'seat-b', takeover: false })).toBe(`${BASE}-2`)
  })

  test('only an admin\'s or a channel owner\'s -N name is reserved: a free -N name can be taken by name', () => {
    const r = router(stateDir(), undefined, { admins: new Set(['boss']) })
    const p = peer()
    expect(register(r, { instanceId: 'seat-a' }, p)).toBe(BASE)
    r.handlers.message(p.ws, JSON.stringify({ type: 'rename', name: `${BASE}-2` }))
    expect(p.frames.at(-1)).toMatchObject({ type: 'renamed', newName: `${BASE}-2` })
    r.handlers.message(p.ws, JSON.stringify({ type: 'rename', name: 'boss-2' }))
    expect(p.frames.at(-1)).toEqual({ type: 'error', message: 'invalid_bus_alias' })
  })

  test('a takeover is an exact claim: it gets the name though it is leased, and the lease passes to the taker', () => {
    const dir = stateDir()
    const r = router(dir)
    const holder = peer()
    expect(register(r, { instanceId: 'holder', agent: 'agy' }, holder)).toBe(BASE)
    expect(register(r, { instanceId: 'taker', agent: 'agy', takeover: true })).toBe(BASE)
    expect(holder.frames.at(-1)).toMatchObject({ type: 'replaced', name: BASE })
    expect(r.sessions.isSameInstance(BASE, 'taker')).toBe(true)
    expect(leases(dir)[BASE]).toMatchObject({ instanceId: 'taker' })
  })

  test('a displaced holder reclaims its name once the taker leaves, though the lease is the taker\'s', () => {
    const dir = stateDir()
    const r = router(dir)
    expect(register(r, { instanceId: 'holder', agent: 'agy' })).toBe(BASE)
    const taker = peer()
    expect(register(r, { instanceId: 'taker', agent: 'agy', takeover: true }, taker)).toBe(BASE)
    r.handlers.close(taker.ws)                                          // the taker leaves; its lease is kept, dated now
    expect(register(r, { instanceId: 'holder', agent: 'agy', takeover: false, reclaimOnly: true })).toBe(BASE)
    expect(r.sessions.isSameInstance(BASE, 'holder')).toBe(true)
  })

  test('a rename takes the lease along and leaves the old name free', () => {
    const dir = stateDir()
    const r = router(dir)
    expect(register(r, { instanceId: 'seat-a' })).toBe(BASE)
    const b = peer()
    expect(register(r, { instanceId: 'seat-b' }, b)).toBe(`${BASE}-2`)
    r.handlers.message(b.ws, JSON.stringify({ type: 'rename', name: 'cfd-injection-fast' }))
    expect(b.frames.at(-1)).toMatchObject({ type: 'renamed', newName: 'cfd-injection-fast' })
    expect(Object.entries(leases(dir)).map(([name, lease]) => [name, lease.instanceId])).toEqual([
      [BASE, 'seat-a'], ['cfd-injection-fast', 'seat-b'],
    ])
    const after = router(dir)
    expect(register(after, { instanceId: 'newcomer' })).toBe(`${BASE}-2`)   // `-2` is nobody's now
    expect(register(after, { name: 'cfd-injection-fast', instanceId: 'seat-b' })).toBe('cfd-injection-fast')
  })
})
