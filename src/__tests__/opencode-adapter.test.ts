import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpencodeAdapter, opencodeSessionId } from '../gateway/adapters/opencode.js'
import { buildNudge, type Target } from '../types.js'

const target: Target = { host: 'mac', user: 'tester', kind: 'opencode', conv: 'ses_target', alias: 'target' }

test('session identity comes only from the namespaced metadata', () => {
  expect(opencodeSessionId({ 'ai.opencode/sessionID': 'ses_target' })).toBe('ses_target')
  expect(opencodeSessionId({ 'ai.opencode/sessionID': 'ses_neighbor' })).toBe('ses_neighbor')
  expect(opencodeSessionId({ sessionID: 'ses_target' })).toBeUndefined()
  expect(opencodeSessionId({ 'ai.opencode/sessionID': 'ses_target/../shell' })).toBeUndefined()
})

test('queued wake and reconciliation use the same ID across adapter restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-adapter-'))
  const path = join(dir, 'service.json')
  const nudge = buildNudge('opencode', target.conv, 'bus-message', 7)
  const submissions = new Map<string, string>()
  const requests: string[] = []
  let delivered = false
  let status = 200
  const queued = (id: string) => ({
    id, sessionID: target.conv, delivery: 'queue', payload: { text: submissions.get(id) },
  })
  const fetchRequest = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      const endpoint = new URL(request.url).pathname
      requests.push(request.method + ' ' + endpoint)
      if (request.headers.get('authorization') !== 'Basic ' + Buffer.from('opencode:fixture').toString('base64')) {
        return new Response(null, { status: 401 })
      }
      if (endpoint === '/api/session/active') return Response.json({ data: { [target.conv]: { type: 'running' } } })
      if (endpoint === '/api/session/ses_target') return Response.json({ data: { id: target.conv } })
      if (endpoint === '/api/session/ses_target/prompt' && request.method === 'POST') {
        if (status !== 200) return new Response(null, { status })
        const body = await request.json()
        expect(body).toEqual({ text: nudge.text, id: nudge.clientId, delivery: 'queue' })
        if (!submissions.has(body.id)) submissions.set(body.id, body.text)
        return Response.json({ data: queued(body.id) })
      }
      if (endpoint === '/api/session/ses_target/inbox') {
        return Response.json({ data: delivered ? [] : [...submissions.keys()].map(queued) })
      }
      if (endpoint === '/api/session/ses_target/message/' + nudge.clientId && delivered) {
        return Response.json({ data: { id: nudge.clientId, type: 'user', text: nudge.text } })
      }
      return new Response(null, { status: 404 })
  }, { preconnect: fetch.preconnect })
  try {
    await writeFile(path, JSON.stringify({ url: 'http://127.0.0.1:43210', password: 'fixture' }), { mode: 0o600 })
    const adapter = createOpencodeAdapter(path, fetchRequest)
    expect(adapter).toMatchObject({ kind: 'opencode', transport: 'opencode-queue' })
    for (const forged of [{ ...nudge, text: nudge.text + '\n' }, { ...nudge, clientId: '..' }]) {
      expect(await adapter.wake(target, forged)).toEqual({ s: 'refused' })
      expect(await adapter.reconcile(target, forged)).toEqual({ s: 'refused' })
    }
    expect(requests).toHaveLength(0)
    const accepted = { s: 'woken', nativeId: nudge.clientId } as const
    expect(await adapter.probe(target)).toEqual({ ok: true })
    expect(await adapter.reconcile(target, nudge)).toEqual({ s: 'uncertain' })
    expect(await adapter.wake(target, nudge)).toEqual(accepted)
    expect(await adapter.reconcile(target, nudge)).toEqual(accepted)
    delivered = true
    const restarted = createOpencodeAdapter(path, fetchRequest)
    expect(await restarted.reconcile(target, nudge)).toEqual(accepted)
    expect(await restarted.wake(target, nudge)).toEqual(accepted)
    expect(submissions.size).toBe(1)
    for (const [code, result] of [[401, 'unavailable'], [404, 'unavailable'], [410, 'unavailable'],
      [403, 'refused'], [409, 'refused'], [429, 'uncertain'], [500, 'uncertain']] as const) {
      status = code
      expect(await adapter.wake(target, nudge)).toEqual({ s: result })
    }
    await chmod(path, 0o644)
    const before = requests.length
    expect(await adapter.wake(target, nudge)).toEqual({ s: 'unavailable' })
    expect(requests).toHaveLength(before)
    expect(requests.filter(request => request.startsWith('POST ')).every(request =>
      request === 'POST /api/session/ses_target/prompt')).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
