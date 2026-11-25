import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import { computeBackoff } from '../reconnect.js'
import { Gateway } from './gateway.js'
import { disableCoreDumps, readPeer } from './peer-cred.js'
import { createCodexAdapter } from './adapters/codex.js'
import { createOpencodeAdapter } from './adapters/opencode.js'
import { assertNodeSecret, type Adapter, type GatewayToRouterMessage, type Kind, type RouterToGatewayMessage, type Transport } from './types.js'

const KINDS: readonly Kind[] = ['claude', 'codex', 'opencode', 'grok', 'agy']
const TRANSPORTS: readonly Transport[] = ['codex-queue', 'opencode-queue', 'claude-inbox', 'claude-channel', 'tmux']
const HOST = /^[a-z0-9][a-z0-9.-]*$/i
const USER = /^[a-z0-9_][a-z0-9_.-]*$/i

export type AdapterBinding = { kind: Kind; transport: Transport }

export type GatewayConfig = {
  host: string
  user: string
  routerUrl: string
  secretFile: string
  socketPath: string
  wakeStore: string
  /** Compiled agent-bus-pipe. Peer exe realpath must equal this path. */
  pipePath: string
  /** PR5b trusted alias file. Discovery is started only when this is set and NativeDiscovery is installed. */
  bindingsPath?: string
  adapters: AdapterBinding[]
}

export type DiscoveryControl = {
  start(): void
  refresh(): Promise<unknown>
  stop(): Promise<void>
}

const factories = new Map<string, () => Adapter>()

function bindingKey(binding: AdapterBinding): string {
  return `${binding.kind}\0${binding.transport}`
}

/** One factory for `(kind, transport)`. A configured pair with no factory refuses to start. */
export function registerAdapter(kind: Kind, transport: Transport, factory: () => Adapter): void {
  factories.set(bindingKey({ kind, transport }), factory)
}

const codexSockets = new Map<string, string>()

/** PR5b publishes the live Codex control socket here. The pid still comes from that socket's peer. */
export function setCodexControlSocket(conv: string, path: string | undefined): void {
  if (path) codexSockets.set(conv, path)
  else codexSockets.delete(conv)
}

/** Codecs the CLI can construct. Other transports stay unregistered until their adapter PR lands. */
export function builtinAdapters(bindings: readonly AdapterBinding[]): Adapter[] {
  registerAdapter('codex', 'codex-queue', () => createCodexAdapter({
    resolveControlSocket: target => codexSockets.get(target.conv),
  }))
  registerAdapter('opencode', 'opencode-queue', () => createOpencodeAdapter())
  return adaptersFor(bindings)
}

export function adaptersFor(bindings: readonly AdapterBinding[], table: ReadonlyMap<string, () => Adapter> = factories): Adapter[] {
  return bindings.map(binding => {
    const make = table.get(bindingKey(binding))
    if (!make) throw new Error(`no adapter for ${binding.kind}/${binding.transport}`)
    const adapter = make()
    if (adapter.kind !== binding.kind || adapter.transport !== binding.transport) {
      throw new Error(`adapter ${adapter.kind}/${adapter.transport} does not match ${binding.kind}/${binding.transport}`)
    }
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

/** `100.64.0.0/10`, or a name under `*.ts.net`. Plain `ws://` is allowed only for these. */
function tailnetHost(hostname: string): boolean {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  if (host.toLowerCase().endsWith('.ts.net') && host.length > '.ts.net'.length) return true
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const oct = parts.map(part => /^(?:0|[1-9]\d{0,2})$/.test(part) ? Number(part) : Number.NaN)
  if (oct.some(n => !Number.isInteger(n) || n > 255)) return false
  return oct[0] === 100 && oct[1]! >= 64 && oct[1]! <= 127
}

function assertRouterUrl(routerUrl: string): void {
  let url: URL
  try { url = new URL(routerUrl) } catch { throw new Error('routerUrl must be a websocket url') }
  if (url.protocol === 'wss:') return
  if (url.protocol !== 'ws:') throw new Error('routerUrl must be a websocket url')
  if (!tailnetHost(url.hostname)) throw new Error('routerUrl must be wss:// or a tailnet ws:// host')
}

/** Open the path itself. A symlink is refused before it is followed. */
function openNoFollow(path: string, label: string): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : ''
    if (code === 'ELOOP') throw new Error(`${label} is a symlink`)
    throw new Error(`${label} is unreadable`)
  }
}

function readOwnedFile(path: string, label: string, mode: 'secret' | 'config'): string {
  const fd = openNoFollow(path, label)
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(mode === 'secret' ? `${label} is not a regular file` : `${label} is unreadable`)
    if (process.getuid === undefined) throw new Error('no uid')
    if (st.uid !== process.getuid()) throw new Error(`${label} is owned by another user`)
    const bits = st.mode & 0o777
    if (mode === 'secret') {
      if (bits !== 0o600) throw new Error(`${label} must be mode 0600`)
    } else if ((bits & ~0o644) !== 0 || (bits & 0o400) === 0) {
      throw new Error(`${label} must be mode 0600 or 0644 at most`)
    }
    const buf = Buffer.alloc(st.size)
    const n = st.size === 0 ? 0 : readSync(fd, buf, 0, st.size, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function loadConfig(path: string): GatewayConfig {
  let parsed: unknown
  try { parsed = JSON.parse(readOwnedFile(path, 'gateway config', 'config')) } catch (err) {
    if (err instanceof Error && err.message.startsWith('gateway config')) throw err
    if (err instanceof Error && err.message === 'no uid') throw err
    throw new Error('gateway config is unreadable')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('gateway config is unreadable')
  const raw = parsed as Record<string, unknown>
  const host = str(raw.host, 'host')
  const user = str(raw.user, 'user')
  const routerUrl = str(raw.routerUrl, 'routerUrl')
  if (!HOST.test(host)) throw new Error('host is invalid')
  if (!USER.test(user)) throw new Error('user is invalid')
  assertRouterUrl(routerUrl)
  if (!Array.isArray(raw.adapters)) throw new Error('adapters must be a list of kind and transport')
  const adapters: AdapterBinding[] = []
  const seen = new Set<string>()
  for (const entry of raw.adapters) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('no adapter for binding')
    const row = entry as Record<string, unknown>
    const kind = row.kind
    const transport = row.transport
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) throw new Error(`no adapter for ${String(kind)}`)
    if (typeof transport !== 'string' || !(TRANSPORTS as readonly string[]).includes(transport)) throw new Error(`no adapter for ${String(kind)}/${String(transport)}`)
    const binding = { kind: kind as Kind, transport: transport as Transport }
    const key = bindingKey(binding)
    if (seen.has(key)) throw new Error(`adapter ${kind}/${transport} is listed twice`)
    seen.add(key)
    adapters.push(binding)
  }
  return {
    host, user, routerUrl, adapters,
    secretFile: abs(raw.secretFile, 'secretFile'),
    socketPath: abs(raw.socketPath, 'socketPath'),
    wakeStore: abs(raw.wakeStore, 'wakeStore'),
    pipePath: abs(raw.pipePath, 'pipePath'),
    ...(raw.bindingsPath !== undefined ? { bindingsPath: abs(raw.bindingsPath, 'bindingsPath') } : {}),
  }
}

/** Mode 0700. A directory owned by another user refuses startup and is not chmod'd. */
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.getuid === undefined) throw new Error('no uid')
  if (statSync(path).uid !== process.getuid()) throw new Error('directory is owned by another user')
  chmodSync(path, 0o700)
}

export function readNodeSecret(path: string): string {
  const secret = readOwnedFile(path, 'node secret file', 'secret').trim()
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
  discovery?: DiscoveryControl
  onVerifiedConnection?: (sock: import('node:net').Socket, agents: import('./registry.js').AgentRec[]) => void
  /** Gateway config file. Re-read when NativeDiscovery asks for its config. */
  configPath?: string
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
    pipePath: config.pipePath, onVerifiedConnection: opts.onVerifiedConnection,
  })
  gateway.setAdapters(opts.adapters)
  const discovery = opts.discovery ?? await loadNativeDiscovery(config, gateway, opts.configPath)
  let discoveryStarted = false

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
      let msg: RouterToGatewayMessage
      try { msg = JSON.parse(String(ev.data)) as RouterToGatewayMessage } catch {
        process.stderr.write('agent-bus-gateway: bad router frame\n')
        return
      }
      try {
        if (msg.type === 'gatewayRegistered') {
          gateway.loadFromDisk()
          for (const rec of gateway.registry.list()) gateway.router.registerAgent(rec)
          if (!discoveryStarted) {
            discovery?.start()
            discoveryStarted = true
          } else {
            void discovery?.refresh()
          }
        }
        if (msg.type === 'agentRegistered') gateway.replayUnreported(msg.as)
        gateway.router.receive(msg)
      } catch (err) {
        fatal(err instanceof Error ? err : new Error('router frame failed'))
      }
    })
    ws.addEventListener('close', () => {
      if (current === ws) current = undefined
      gateway.router.failPending(new Error('router link down'))
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
      const stopDiscovery = discovery?.stop() ?? Promise.resolve()
      return stopDiscovery.then(() => gateway.close())
    },
  }
}

async function loadNativeDiscovery(config: GatewayConfig, gateway: Gateway, configPath: string | undefined): Promise<DiscoveryControl | undefined> {
  if (!config.bindingsPath || !configPath) return undefined
  try {
    const load = new Function('spec', 'return import(spec)') as (spec: string) => Promise<{ NativeDiscovery?: new (opts: Record<string, unknown>) => DiscoveryControl }>
    const mod = await load('./discovery.js')
    if (!mod.NativeDiscovery) return undefined
    const NativeDiscovery = mod.NativeDiscovery
    return new NativeDiscovery({
      host: config.host,
      user: config.user,
      gateway,
      bindingsPath: config.bindingsPath,
      readConfig: () => {
        const parsed = JSON.parse(readOwnedFile(configPath, 'gateway config', 'config')) as { discoveries?: unknown; gatewayAliasHosts?: unknown }
        return {
          discoveries: Array.isArray(parsed.discoveries) ? parsed.discoveries : [],
          gatewayAliasHosts: parsed.gatewayAliasHosts && typeof parsed.gatewayAliasHosts === 'object' ? parsed.gatewayAliasHosts : {},
        }
      },
    })
  } catch {
    return undefined
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
    void startHost(config, { adapters: builtinAdapters(config.adapters), readPeer, configPath }).catch(err => {
      process.stderr.write(`agent-bus-gateway: ${err instanceof Error ? err.message : 'start failed'}\n`)
      process.exit(1)
    })
  } catch (err) {
    process.stderr.write(`agent-bus-gateway: ${err instanceof Error ? err.message : 'config failed'}\n`)
    process.exit(1)
  }
}
