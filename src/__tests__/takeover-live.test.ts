import { test, expect } from 'bun:test'
import { createWsHandlers, type WsLike } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { SILENCE_MS } from '../keepalive.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('live holder refuses inherited takeover, stale holder replaced, same instance accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-takeover-'))
  try {
    const sessions = new SessionManager()
    const h = createWsHandlers({ sessions, history: new ProjectHistory(dir), client: {} as any,
      chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first' })
    const socket = () => {
      const frames: any[] = []
      const ws: WsLike = { data: { sessionName: null, sendCallback: null }, send: s => frames.push(JSON.parse(s)) }
      return { ws, frames }
    }
    const a = socket(), b = socket(), same = socket()
    const register = (ws: WsLike, instanceId: string) => h.message(ws, JSON.stringify({ type: 'register',
      name: 'claude@mac:live', projectPath: '/tmp', instanceId, agent: 'claude', takeover: true }))
    register(a.ws, 'one')
    h.message(a.ws, '{"type":"pong"}')
    register(b.ws, 'child')
    expect(b.frames.at(-1)).toEqual({ type: 'takeover_refused', name: 'claude@mac:live', reason: 'holder_live' })
    expect(sessions.registeredIdentity('claude@mac:live')?.instanceId).toBe('one')
    register(same.ws, 'one')
    expect(same.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:live' })
    same.ws.data.lastPongAt = Date.now() - SILENCE_MS - 1
    register(b.ws, 'child')
    expect(b.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:live' })
    expect(sessions.registeredIdentity('claude@mac:live')?.instanceId).toBe('child')
    h.close(b.ws)
    const fresh = socket()
    register(fresh.ws, 'restart')
    expect(fresh.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:live' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
