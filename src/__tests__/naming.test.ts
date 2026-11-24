import { describe, test, expect } from 'bun:test'
import { findClaudeSession, sessionAlias, type ClaudeSession } from '../naming.js'

/** A process tree as child -> parent, and which pids are Claude Code sessions. */
function tree(parents: Record<string, string>, sessions: Record<string, ClaudeSession>) {
  return [(pid: string) => sessions[pid], (pid: string) => parents[pid]] as const
}

describe('findClaudeSession', () => {
  test('walks past the supervisor and the plugin runner to Claude', () => {
    // plugin(40) -> supervisor(30) -> runner(20) -> claude(10) -> shell(5)
    const [read, parentOf] = tree({ '30': '20', '20': '10', '10': '5', '5': '1' }, { '10': { cwd: '/home/u/src', name: 'src-9a', nameSource: 'derived' } })
    expect(findClaudeSession('30', read, parentOf)).toEqual({ pid: '10', cwd: '/home/u/src', name: 'src-9a', nameSource: 'derived' })
  })

  test('the starting pid counts, and the nearest session wins', () => {
    const [read, parentOf] = tree({ '30': '20', '20': '10' }, { '30': { cwd: '/inner' }, '10': { cwd: '/outer' } })
    expect(findClaudeSession('30', read, parentOf)?.cwd).toBe('/inner')
    expect(findClaudeSession('20', read, parentOf)?.cwd).toBe('/outer')
  })

  test('the session file cannot override the pid', () => {
    const [read, parentOf] = tree({}, { '10': { pid: 99 } as ClaudeSession })
    expect(findClaudeSession('10', read, parentOf)?.pid).toBe('10')
  })

  test('undefined when no ancestor is a Claude session', () => {
    const [read, parentOf] = tree({ '30': '20', '20': '1' }, { '1': { cwd: '/init' } })
    expect(findClaudeSession('30', read, parentOf)).toBeUndefined()
    expect(findClaudeSession('30', read, () => undefined)).toBeUndefined()
  })

  test('gives up on a parent chain that never ends', () => {
    let lookups = 0
    expect(findClaudeSession('30', () => { lookups++; return undefined }, pid => pid)).toBeUndefined()
    expect(lookups).toBeLessThanOrEqual(8)
  })
})

describe('sessionAlias', () => {
  test('a name the user set is the alias, spaces made dashes', () => {
    expect(sessionAlias({ name: ' tt cfd  fable ', nameSource: 'user' })).toBe('tt-cfd-fable')
    expect(sessionAlias({ name: 'ops' })).toBe('ops') // older Claude Code: no nameSource
  })

  test('generated names are not aliases', () => {
    for (const nameSource of ['auto', 'derived', 'collision']) {
      expect(sessionAlias({ name: 'src-9a', nameSource })).toBeUndefined()
    }
  })

  test('no session or no name gives no alias', () => {
    expect(sessionAlias(undefined)).toBeUndefined()
    expect(sessionAlias({ cwd: '/x' })).toBeUndefined()
    expect(sessionAlias({ name: '   ', nameSource: 'user' })).toBeUndefined()
  })
})
