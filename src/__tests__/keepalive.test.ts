import { test, expect } from 'bun:test'
import { clientKeepalive, SILENCE_MS } from '../keepalive.js'
import { createWsHandlers, type WsDeps, type WsLike } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('client closes after two unanswered probes, pong resets, and close cancels timer', () => {
  class Fake extends EventTarget {
    sent: string[] = []; closed = 0
    send(s: string) { this.sent.push(s) }
    close() { this.closed++; this.dispatchEvent(new Event('close')) }
  }
  const ws = new Fake()
  let tick = () => {}; let cancelled = 0
  clientKeepalive(ws, ((fn: () => void) => { tick = fn; return 1 }) as any, (() => { cancelled++ }) as any)
  expect(ws.sent).toHaveLength(1)
  tick()
  ws.dispatchEvent(new MessageEvent('message', { data: '{"type":"pong"}' }))
  tick(); tick()
  expect(ws.closed).toBe(0)
  tick()
  expect(ws.closed).toBe(1)
  expect(cancelled).toBe(1)
  tick()
  expect(ws.closed).toBe(1)
})

test('router answers ping and expires silent connections via normal deregistration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepalive-'))
  try {
    let clock = 100_000
    const sessions = new SessionManager()
    const h = createWsHandlers({ now: () => clock, sessions, history: new ProjectHistory(dir), client: {} as any,
      chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first' } satisfies WsDeps)
    const sent: any[] = []; let closed = 0
    const ws: WsLike = { data: { sessionName: null, sendCallback: null }, send: s => sent.push(JSON.parse(s)), close: () => { closed++ } }
    h.open(ws)
    h.message(ws, JSON.stringify({ type: 'register', name: 'codex@mac:test', projectPath: '/tmp' }))
    h.message(ws, '{"type":"ping"}')
    h.message(ws, '{"type":"pong"}')
    expect(sent).toContainEqual({ type: 'pong' })
    expect(ws.data.lastPongAt).toBeGreaterThan(0)
    clock += SILENCE_MS + 1
    h.sweep()
    expect(sessions.getSessions()).toEqual([])
    expect(closed).toBe(1)
    const legacy: WsLike = { data: { sessionName: null, sendCallback: null }, send: () => {}, close: () => { throw new Error('legacy must stay connected') } }
    h.open(legacy)
    h.message(legacy, JSON.stringify({ type: 'register', name: 'codex@mac:test', projectPath: '/tmp' }))
    h.close(ws) // late close for expired connection must not remove its replacement
    expect(sessions.getSessions()).toHaveLength(1)
    clock += 600_000
    h.sweep()
    expect(sessions.getSessions()).toHaveLength(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('stuck close is forcibly terminated and reconnect is notified within five seconds', () => {
  class Fake extends EventTarget {
    terminated = 0; closes = 0
    send() {}
    close() {} // simulate a half-open connection that never emits close
    terminate() { this.terminated++ }
  }
  const ws = new Fake()
  let tick = () => {}, force = () => {}, delay = 0
  ws.addEventListener('close', () => ws.closes++)
  clientKeepalive(ws, ((f: () => void) => { tick = f; return 1 }) as any, (() => {}) as any,
    ((f: () => void, ms: number) => { force = f; delay = ms; return 2 }) as any, (() => {}) as any)
  tick(); tick()
  expect(delay).toBe(5000)
  expect(ws.closes).toBe(0)
  force()
  expect(ws.terminated).toBe(1)
  expect(ws.closes).toBe(1)
})
