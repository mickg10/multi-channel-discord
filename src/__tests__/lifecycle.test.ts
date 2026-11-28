import { test, expect } from 'bun:test'
import { lifecycleLine } from '../lifecycle.js'
import { createWsHandlers, type WsLike } from '../ws.js'
import { SessionManager, ProjectHistory } from '../sessions.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('lifecycle uses one JSON line and never includes unlisted credentials', () => {
  const line = lifecycleLine('register', { name: 'line\nbreak', reason: 'registered', secret: 'DO_NOT_LOG' } as any)
  expect(line.trim().split('\n')).toHaveLength(1)
  expect(line).not.toContain('DO_NOT_LOG')
  expect(JSON.parse(line).remoteAddress).toBeNull()
})

test('register, refused takeover, takeover, rename and close are logged with identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'))
  try {
    const lines: any[] = []
    const h = createWsHandlers({ sessions: new SessionManager(), history: new ProjectHistory(dir), client: {} as any,
      chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first', lifecycleLog: l => lines.push(JSON.parse(l)) })
    const socket = (): WsLike => ({ data: { sessionName: null, sendCallback: null, remoteAddress: '127.0.0.1' }, send: () => {} })
    const a = socket(), b = socket()
    const reg = (ws: WsLike, instanceId: string, agent: string) => h.message(ws, JSON.stringify({ type: 'register', name: 'claude@mac:x', projectPath: '/tmp', instanceId, agent, takeover: true, secret: 'DO_NOT_LOG' }))
    reg(a, 'first', 'claude'); reg(b, 'wrong', 'agy'); reg(b, 'second', 'claude')
    h.message(b, '{"type":"rename","name":"claude@mac:y"}')
    h.close(b)
    expect(lines.map(l => l.event)).toEqual(['register', 'takeover_refused', 'takeover', 'register', 'rename', 'deregister'])
    expect(lines[0]).toMatchObject({ name: 'claude@mac:x', instanceId: 'first', host: 'mac', agent: 'claude', remoteAddress: '127.0.0.1' })
    expect(JSON.stringify(lines)).not.toContain('DO_NOT_LOG')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
