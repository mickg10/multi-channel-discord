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
    h.pong(a.ws) // legacy clients answer Bun's transport-level pings
    const collision = socket()
    h.message(collision.ws, JSON.stringify({ type: 'register', name: 'claude@mac:live', projectPath: '/tmp',
      instanceId: 'ordinary-collision', agent: 'claude', takeover: false }))
    expect(collision.frames.at(-1)).toMatchObject({ type: 'registered', name: 'claude@mac:live-2' })
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


test('plugin exits on stdin EOF rather than retaining its name as an orphan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-eof-'))
  const server = Bun.serve({ port: 0, fetch(req, server) {
    if (server.upgrade(req)) return
    return new Response('fixture')
  }, websocket: { message(ws, raw) {
    const message = JSON.parse(String(raw))
    if (message.type === 'ping') ws.send('{"type":"pong"}')
    if (message.type === 'register') ws.send(JSON.stringify({ type: 'registered', name: message.name, reclaimOnly: true }))
  } } })
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'plugin.ts')], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, DISCORD_STATE_DIR: dir,
      DISCORD_ROUTER_URL: `ws://127.0.0.1:${server.port}`, DISCORD_SESSION_NAME: 'claude@mac:eof-test',
      DISCORD_AGENT: 'claude', DISCORD_PARENT_PID: String(process.pid),
    },
  })
  const watchdog = setTimeout(() => child.kill(), 4000)
  try {
    child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toMatch(/stdin ended|stdio closed/)
  } finally {
    clearTimeout(watchdog)
    child.kill()
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 6000)
