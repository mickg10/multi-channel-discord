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
    const sessions = new SessionManager()
    const h = createWsHandlers({ sessions, history: new ProjectHistory(dir), client: {} as any,
      chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first' } satisfies WsDeps)
    const sent: any[] = []; let closed = 0
    const ws: WsLike = { data: { sessionName: null, sendCallback: null }, send: s => sent.push(JSON.parse(s)), close: () => { closed++ } }
    h.open(ws)
    h.message(ws, JSON.stringify({ type: 'register', name: 'codex@mac:test', projectPath: '/tmp' }))
    h.message(ws, '{"type":"ping"}')
    h.message(ws, '{"type":"pong"}')
    expect(sent).toContainEqual({ type: 'pong' })
    expect(ws.data.lastPongAt).toBeGreaterThan(0)
    h.sweep(Date.now() + SILENCE_MS + 1)
    expect(sessions.getSessions()).toEqual([])
    expect(closed).toBe(1)
    h.close(ws)
    expect(sessions.getSessions()).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
