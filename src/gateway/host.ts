import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import { computeBackoff } from '../reconnect.js'
import { Gateway } from './gateway.js'
import { disableCoreDumps, readPeer } from './peer-cred.js'
import { assertNodeSecret, type Adapter, type GatewayToRouterMessage, type Kind } from './types.js'

const KINDS: readonly Kind[] = ['claude', 'codex', 'opencode', 'grok', 'agy']
const HOST = /^[a-z0-9][a-z0-9.-]*$/i
const USER = /^[a-z0-9_][a-z0-9_.-]*$/i

export type GatewayConfig = {
  host: string
  user: string
  routerUrl: string
  secretFile: string
  socketPath: string
  wakeStore: string
  adapters: Kind[]
}

const factories = new Map<Kind, () => Adapter>()

/** Later adapter PRs register a factory. A configured kind with no factory refuses to start. */
export function registerAdapter(kind: Kind, factory: () => Adapter): void {
  factories.set(kind, factory)
}

export function adaptersByKind(kinds: readonly Kind[], table: ReadonlyMap<Kind, () => Adapter> = factories): Adapter[] {
  return kinds.map(kind => {
    const make = table.get(kind)
    if (!make) throw new Error(`no adapter for ${kind}`)
    const adapter = make()
    if (adapter.kind !== kind) throw new Error(`adapter kind ${adapter.kind} does not match ${kind}`)
    return adapter
  })
}

function str(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`)
  return value
}

function abs(value: unknown, label: string): string {
  const path = str(value, label)
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`)
  return path
}

export function loadConfig(path: string): GatewayConfig {
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('gateway config is unreadable') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('gateway config is unreadable')
  const raw = parsed as Record<string, unknown>
  const host = str(raw.host, 'host')
  const user = str(raw.user, 'user')
  const routerUrl = str(raw.routerUrl, 'routerUrl')
  if (!HOST.test(host)) throw new Error('host is invalid')
  if (!USER.test(user)) throw new Error('user is invalid')
  if (!/^wss?:\/\//.test(routerUrl)) throw new Error('routerUrl must be a websocket url')
  if (!Array.isArray(raw.adapters)) throw new Error('adapters must be a list of kinds')
  const adapters: Kind[] = []
  for (const kind of raw.adapters) {
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) throw new Error(`no adapter for ${String(kind)}`)
    if (adapters.includes(kind as Kind)) throw new Error(`adapter ${kind} is listed twice`)
    adapters.push(kind as Kind)
  }
  return {
    host, user, routerUrl, adapters,
    secretFile: abs(raw.secretFile, 'secretFile'),
    socketPath: abs(raw.socketPath, 'socketPath'),
    wakeStore: abs(raw.wakeStore, 'wakeStore'),
  }
}

/** Mode 0600. The contents are never included in an error. */
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

export function readNodeSecret(path: string): string {
  const st = statSync(path)
  if (!st.isFile()) throw new Error('node secret file is not a regular file')
  if ((st.mode & 0o077) !== 0) throw new Error('node secret file is readable by the group or others')
  const secret = readFileSync(path, 'utf8').trim()
  assertNodeSecret(secret)
  return secret
}

export type HostHandle = {
  gateway: Gateway
  close: () => Promise<void>
}

/**
 * One gateway process. The router link reconnects. The local socket stays up.
 * Restart recovery runs when the router accepts `registerGateway`.
 */
export async function startHost(config: GatewayConfig, opts: {
  adapters: Adapter[]
  readPeer?: typeof readPeer
  onFatal?: (err: Error) => void
}): Promise<HostHandle> {
  disableCoreDumps()
  const secret = readNodeSecret(config.secretFile)
  privateDir(dirname(config.wakeStore))
  privateDir(dirname(config.socketPath))
  const fatal = opts.onFatal ?? (err => {
    process.stderr.write(`agent-bus-gateway: ${err.message}\n`)
    process.exit(1)
  })
  let current: WebSocket | undefined
  let listening = false
  let stopped = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let ready: (() => void) | undefined
  let failed: ((err: Error) => void) | undefined
  const send = (frame: GatewayToRouterMessage) => {
    if (!current || current.readyState !== WebSocket.OPEN) throw new Error('router link down')
    current.send(JSON.stringify(frame))
  }
  const gateway = new Gateway({
    host: config.host, user: config.user, secret,
    storePath: config.wakeStore, send, readPeer: opts.readPeer ?? readPeer,
  })
  gateway.setAdapters(opts.adapters)

  const connect = () => {
    if (stopped) return
    const ws = new WebSocket(config.routerUrl)
    const giveUp = (err: Error) => {
      if (failed) { failed(err); return }
      if (!stopped) fatal(err)
    }
    ws.addEventListener('error', () => {
      if (ws.readyState !== WebSocket.OPEN && !listening) giveUp(new Error('router link failed'))
    })
    ws.addEventListener('open', () => {
      if (stopped) { ws.close(); return }
      current = ws
      attempt = 0
      const up = listening
        ? Promise.resolve().then(() => { if (current === ws) gateway.router.registerGateway(config.host, config.user) })
        : gateway.listen(config.socketPath).then(() => { listening = true })
      up.then(() => { ready?.(); ready = undefined }, err => giveUp(err instanceof Error ? err : new Error('socket failed')))
    })
    ws.addEventListener('message', ev => {
      let msg: { type?: string }
      try { msg = JSON.parse(String(ev.data)) as { type?: string } } catch {
        process.stderr.write('agent-bus-gateway: bad router frame\n')
        return
      }
      try {
        if (msg.type === 'gatewayRegistered') gateway.resumeFromDisk()
        gateway.router.receive(msg as Parameters<typeof gateway.router.receive>[0])
      } catch (err) {
        fatal(err instanceof Error ? err : new Error('router frame failed'))
      }
    })
    ws.addEventListener('close', () => {
      if (current === ws) current = undefined
      if (stopped) return
      if (!listening) { giveUp(new Error('router link failed')); return }
      retry = setTimeout(connect, computeBackoff(attempt))
      attempt += 1
    })
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('router link timed out')), 10_000)
    let done = false
    function finish(err?: Error) {
      if (done) return
      done = true
      clearTimeout(timeout)
      ready = undefined
      failed = undefined
      if (err) {
        stopped = true
        current?.close()
        reject(err)
      } else resolve()
    }
    ready = () => finish()
    failed = finish
    connect()
  })
  return {
    gateway,
    close: () => {
      stopped = true
      if (retry) clearTimeout(retry)
      current?.close()
      current = undefined
      return gateway.close()
    },
  }
}

export function gatewayMain(argv: string[]): void {
  const at = argv.indexOf('--config')
  const configPath = at >= 0 ? argv[at + 1] : undefined
  if (!configPath) {
    process.stderr.write('agent-bus-gateway: --config <file> is required\n')
    process.exit(2)
  }
  try {
    disableCoreDumps()
    const config = loadConfig(configPath)
    void startHost(config, { adapters: adaptersByKind(config.adapters), readPeer }).catch(err => {
      process.stderr.write(`agent-bus-gateway: ${err instanceof Error ? err.message : 'start failed'}\n`)
      process.exit(1)
    })
  } catch (err) {
    process.stderr.write(`agent-bus-gateway: ${err instanceof Error ? err.message : 'config failed'}\n`)
    process.exit(1)
  }
}
