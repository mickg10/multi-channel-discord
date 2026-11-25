import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, Nudge, Target, WakeResult } from '../../types.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

export function opencodeSessionId(trustedCallMeta: unknown): string | undefined {
  const id = record(trustedCallMeta)?.['ai.opencode/sessionID']
  return typeof id === 'string' && /^ses_[a-zA-Z0-9_-]+$/.test(id) ? id : undefined
}

async function serviceRequest(path: string, fetchRequest: typeof globalThis.fetch) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.() || info.size > 16384) return
      const descriptor = record(JSON.parse(await file.readFile('utf8')))
      if (typeof descriptor?.url !== 'string' || typeof descriptor.password !== 'string' || !descriptor.password) return
      const url = new URL(descriptor.url)
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return
      const authorization = 'Basic ' + Buffer.from('opencode:' + descriptor.password).toString('base64')
      return (endpoint: string, body?: object) => fetchRequest(url.origin + endpoint, {
        method: body ? 'POST' : 'GET',
        headers: body ? { authorization, 'content-type': 'application/json' } : { authorization },
        body: body && JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}

async function data(response: Response): Promise<unknown> {
  return record(await response.json())?.data
}

function sessionPath(target: Target): string | undefined {
  const id = opencodeSessionId({ 'ai.opencode/sessionID': target.conv })
  return target.kind === 'opencode' && id ? '/api/session/' + id : undefined
}

function woken(nudge: Nudge): WakeResult {
  return { s: 'woken', nativeId: nudge.clientId }
}

function validNudge(nudge: Nudge): boolean {
  return /^\[agent-bus\] mail waiting \(id (0|[1-9][0-9]*)\) — call check_inbox(?![\s\S])/.test(nudge.text)
    && /^msg_bus[0-9a-f]{24}(?![\s\S])/.test(nudge.clientId)
}

function matchesQueued(value: unknown, target: Target, nudge: Nudge): boolean {
  const item = record(value)
  return item?.id === nudge.clientId && item.sessionID === target.conv && item.delivery === 'queue'
    && record(item.payload)?.text === nudge.text
}

export function createOpencodeAdapter(
  servicePath = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'opencode', 'service.json'),
  fetchRequest: typeof globalThis.fetch = globalThis.fetch,
): Adapter {
  return {
    kind: 'opencode',
    async probe(target) {
      const endpoint = sessionPath(target)
      const request = endpoint && await serviceRequest(servicePath, fetchRequest)
      if (!request) return { ok: false }
      try {
        const active = await request('/api/session/active')
        if (!active.ok || !record(await data(active))) return { ok: false }
        const session = await request(endpoint)
        return { ok: session.ok && record(await data(session))?.id === target.conv }
      } catch {
        return { ok: false }
      }
    },
    async wake(target, nudge) {
      if (!validNudge(nudge)) return { s: 'refused' }
      const endpoint = sessionPath(target)
      const request = endpoint && await serviceRequest(servicePath, fetchRequest)
      if (!request) return { s: 'unavailable' }
      try {
        const response = await request(endpoint + '/prompt', { text: nudge.text, id: nudge.clientId, delivery: 'queue' })
        if ([401, 404, 410].includes(response.status)) return { s: 'unavailable' }
        if (response.status === 429) return { s: 'uncertain' }
        if (response.status >= 400 && response.status < 500) return { s: 'refused' }
        if (response.ok && matchesQueued(await data(response), target, nudge)) return woken(nudge)
      } catch (error) {
        if (record(error)?.code === 'ECONNREFUSED' || record(record(error)?.cause)?.code === 'ECONNREFUSED') {
          return { s: 'unavailable' }
        }
        return { s: 'uncertain' }
      }
      return { s: 'uncertain' }
    },
    async reconcile(target, nudge) {
      if (!validNudge(nudge)) return { s: 'refused' }
      const endpoint = sessionPath(target)
      const request = endpoint && await serviceRequest(servicePath, fetchRequest)
      if (!request) return { s: 'unavailable' }
      try {
        const inbox = await request(endpoint + '/inbox')
        if ([401, 404, 410].includes(inbox.status)) return { s: 'unavailable' }
        if (inbox.ok) {
          const pending = await data(inbox)
          if (Array.isArray(pending) && pending.some(item => matchesQueued(item, target, nudge))) return woken(nudge)
        }
        const message = await request(endpoint + '/message/' + encodeURIComponent(nudge.clientId))
        if (message.status === 401 || message.status === 410) return { s: 'unavailable' }
        if (message.ok) {
          const item = record(await data(message))
          if (item?.id === nudge.clientId && item.type === 'user' && item.text === nudge.text) return woken(nudge)
        }
      } catch {
        return { s: 'uncertain' }
      }
      return { s: 'uncertain' }
    },
  }
}
