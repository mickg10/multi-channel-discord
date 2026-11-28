import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NAME_LEASE_MS, NameLeases } from '../name-leases.js'

function clock(start = 1_700_000_000_000) {
  const time = { now: start }
  return { now: () => time.now, advance(ms: number) { time.now += ms } }
}

describe('NameLeases', () => {
  test('keeps a name from another instance, but not from the holder itself', () => {
    const { now } = clock()
    const leases = new NameLeases(undefined, NAME_LEASE_MS, now)
    leases.touch('agy@nas642:p1-2', 'seat-b')
    expect(leases.heldByAnother('agy@nas642:p1-2', 'seat-a')).toBe(true)
    expect(leases.heldByAnother('agy@nas642:p1-2', 'seat-b')).toBe(false)
    // a client without an instance id takes no part
    expect(leases.heldByAnother('agy@nas642:p1-2', undefined)).toBe(false)
    expect(leases.heldByAnother('agy@nas642:p1-3', 'seat-a')).toBe(false)
  })

  test('an instance holds one name: a new one ends the old lease', () => {
    const leases = new NameLeases(undefined, NAME_LEASE_MS, clock().now)
    leases.touch('agy@nas642:p1-2', 'seat-b')
    leases.touch('cfd-injection-fast', 'seat-b')
    expect(leases.get('agy@nas642:p1-2')).toBeUndefined()
    expect(leases.get('cfd-injection-fast')?.instanceId).toBe('seat-b')
  })

  test('a lease ends ten minutes after its holder was last seen', () => {
    const { now, advance } = clock()
    const leases = new NameLeases(undefined, NAME_LEASE_MS, now)
    leases.touch('p1-2', 'seat-b')
    advance(NAME_LEASE_MS - 1)
    expect(leases.heldByAnother('p1-2', 'seat-a')).toBe(true)
    advance(1)
    expect(leases.heldByAnother('p1-2', 'seat-a')).toBe(false)
    expect(leases.expire()).toBe(1)
    expect(leases.size).toBe(0)
  })

  test('a holder seen again keeps its lease: touchAll marks several at once', () => {
    const { now, advance } = clock()
    const leases = new NameLeases(undefined, NAME_LEASE_MS, now)
    leases.touch('p1', 'seat-a')
    leases.touch('p1-2', 'seat-b')
    advance(9 * 60_000)
    leases.touchAll([['p1', 'seat-a'], ['p1-2', 'seat-b']])
    advance(9 * 60_000)
    // eighteen minutes after the first touch, nine after the refresh
    expect(leases.heldByAnother('p1', 'seat-c')).toBe(true)
    expect(leases.heldByAnother('p1-2', 'seat-c')).toBe(true)
  })

  test('the leases are {name: {instanceId, lastSeen}} in name-leases.json, and a new router reads them', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'name-leases-'))
    const { now } = clock()
    try {
      NameLeases.inStateDir(stateDir, NAME_LEASE_MS, now).touch('agy@nas642:p1-2', 'seat-b')
      expect(JSON.parse(readFileSync(join(stateDir, 'name-leases.json'), 'utf8'))).toEqual({
        'agy@nas642:p1-2': { instanceId: 'seat-b', lastSeen: now() },
      })
      const restarted = NameLeases.inStateDir(stateDir, NAME_LEASE_MS, now)
      expect(restarted.heldByAnother('agy@nas642:p1-2', 'seat-a')).toBe(true)
      expect(restarted.heldByAnother('agy@nas642:p1-2', 'seat-b')).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a damaged file costs only its damaged entries, and leases that have ended are dropped', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'name-leases-'))
    const { now } = clock()
    try {
      writeFileSync(join(stateDir, 'name-leases.json'), JSON.stringify({
        'p1-2': { instanceId: 'seat-b', lastSeen: now() - 5 * 60_000 },
        'p1-3': 'nonsense',
        'has spaces': { instanceId: 'seat-x', lastSeen: now() },
        'p1-4': { instanceId: 'seat-gone', lastSeen: now() - NAME_LEASE_MS },
        'p1-5': { instanceId: 7, lastSeen: now() },
      }))
      const leases = NameLeases.inStateDir(stateDir, NAME_LEASE_MS, now)
      expect(leases.size).toBe(1)
      expect(leases.get('p1-2')?.instanceId).toBe('seat-b')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('a lease that has ended is not written back', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'name-leases-'))
    const { now, advance } = clock()
    try {
      const leases = NameLeases.inStateDir(stateDir, NAME_LEASE_MS, now)
      leases.touch('p1-2', 'seat-b')
      advance(NAME_LEASE_MS + 1)
      leases.touch('p1-3', 'seat-c')
      expect(Object.keys(JSON.parse(readFileSync(join(stateDir, 'name-leases.json'), 'utf8')))).toEqual(['p1-3'])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
