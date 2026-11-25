import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { connectCodexUnix, supportedVersion } from './adapters/codex.js'
import { openOpencodeListing, type OpencodeListingFetch } from './adapters/opencode.js'
import type { Gateway } from './gateway.js'
import type { AgentRec } from './registry.js'
import { assertAlias, identityKey } from './types.js'

type DiscoveryKind = 'codex' | 'opencode'

export interface DiscoveryBinding {
  kind: DiscoveryKind
  conv: string
  pid?: number
}

/** One explicitly selected CODEX_HOME control endpoint or OpenCode service. */
export type DiscoverySource = {
  id: string
} & (
  | { kind: 'codex'; controlSocket: string; pid: number }
  | { kind: 'opencode'; servicePath: string }
)

/** Read anew on every pass from trusted owner configuration. */
export interface DiscoveryConfig {
  discoveries: readonly DiscoverySource[]
  gatewayAliasHosts: Readonly<Record<string, string>>
}

export interface DiscoveryOptions {
  host: string
  user: string
  gateway: Pick<Gateway, 'registry' | 'registerAgent'>
  bindingsPath: string
  readConfig(signal: AbortSignal): DiscoveryConfig | Promise<DiscoveryConfig>
  connectCodex?: typeof connectCodexUnix
  fetchOpencode?: OpencodeListingFetch
  intervalMs?: number
  deadlineMs?: number
  maxPages?: number
}

type Failure = 'unavailable' | 'protocol' | 'unsupported_version' | 'budget'
type SourceResult = {
  sourceId: string
  status: 'complete' | Failure
  unmapped: number
}
type BindingResult = {
  alias: string
  status: 'registered' | 'unchanged' | 'not_listed' | 'incomplete' | 'conflict' | 'blocked' | 'registration_failed'
}
export type DiscoveryResult =
  | { status: 'invalid_config' | 'invalid_bindings' | 'config_failed' | 'deadline' | 'cancelled' }
  | { status: 'finished'; sources: SourceResult[]; bindings: BindingResult[] }

const MAX_BINDINGS_BYTES = 1024 * 1024
const MAX_PAGE_BYTES = 1024 * 1024
const MAX_HTTP_BYTES = 8 * MAX_PAGE_BYTES
const HOST = /^[a-z0-9][a-z0-9.-]*$/i
const USER = /^[a-z0-9_][a-z0-9_.-]*$/i
const ID = /^[a-zA-Z0-9_-]{1,256}$/
const SESSION_ID = /^ses_[a-zA-Z0-9_-]{1,252}$/

class ListingFailure extends Error {
  constructor(readonly status: Failure) { super(status) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value
}

function validConv(kind: DiscoveryKind, value: unknown): value is string {
  return matches(value, kind === 'codex' ? ID : SESSION_ID)
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0')
}

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
}

function snapshot(value: unknown) {
  const config = record(value)
  const hosts = record(config?.gatewayAliasHosts)
  if (!hosts || !Array.isArray(config?.discoveries)) throw new Error()
  const ids = new Set<string>()
  const sources = Array.from(config.discoveries, (value: unknown): DiscoverySource => {
    const source = record(value)
    const kind = source?.kind
    const id = source?.id
    if (!matches(id, ID) || ids.has(id) || !source ||
        (kind !== 'codex' && kind !== 'opencode') || Object.hasOwn(source, 'bindings')) throw new Error()
    ids.add(id)
    if (kind === 'codex') {
      const { controlSocket, pid } = source
      if (!validPath(controlSocket) || !validPid(pid)) throw new Error()
      return { id, kind, controlSocket, pid }
    }
    if (!validPath(source.servicePath)) throw new Error()
    return { id, kind, servicePath: source.servicePath }
  })
  return { sources, hosts: { ...hosts } }
}

async function readBindings(path: string, host: string, hosts: Record<string, unknown>, signal: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let raw: string
  try {
    signal.throwIfAborted()
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() ||
        (info.mode & 0o7777) !== 0o600 || info.size > MAX_BINDINGS_BYTES) throw new Error()
    const bytes = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== info.size) throw new Error()
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset))
  } finally {
    await file.close()
  }
  signal.throwIfAborted()
  const root = record(JSON.parse(raw))
  if (!root) throw new Error()
  const identities = new Set<string>()
  let propertyCount = 0
  const bindings = Object.entries(root).map(([alias, value]): DiscoveryBinding & { alias: string } => {
    const binding = record(value)
    const kind = binding?.kind
    const conv = binding?.conv
    if (!binding || (kind !== 'codex' && kind !== 'opencode') || !validConv(kind, conv) ||
        /\s/.test(alias) || Object.keys(binding).some(key => !['kind', 'conv', 'pid'].includes(key))) throw new Error()
    const pid = validPid(binding.pid) ? binding.pid : undefined
    if (Object.hasOwn(binding, 'pid') && pid === undefined) throw new Error()
    assertAlias(kind, host, alias)
    const owned = Object.hasOwn(hosts, alias)
    const parts = alias.split('@')
    if (parts.length > 2 || (owned && hosts[alias] !== host) ||
        (parts.length === 1 ? !owned : parts[1].split(':')[0] !== host)) throw new Error()
    const identity = JSON.stringify([kind, conv])
    if (identities.has(identity)) throw new Error()
    identities.add(identity)
    propertyCount += 1 + Object.keys(binding).length
    return { alias, kind, conv, pid }
  })
  // JSON.parse collapses duplicate properties. In this validated flat schema,
  // each string token followed by a colon represents exactly one property.
  for (const token of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"([ \t\r\n]*:)?/g)) {
    if (token[1]) propertyCount--
  }
  if (propertyCount !== 0) throw new Error()
  return bindings
}

function validCursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 8192)
}

async function listPages(
  kind: DiscoveryKind,
  page: (cursor?: string) => Promise<unknown>,
  signal: AbortSignal,
  maxPages: number,
): Promise<Set<string>> {
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let index = 0; index < maxPages; index++) {
    signal.throwIfAborted()
    const result = record(await page(cursor))
    const cursorObject = record(result?.cursor)
    const next = kind === 'codex' ? result?.nextCursor : cursorObject?.next
    if (!Array.isArray(result?.data) || !validCursor(next) ||
        (kind === 'opencode' && !validCursor(cursorObject?.previous))) throw new ListingFailure('protocol')
    for (const item of result.data) {
      const id = kind === 'codex' ? item : record(item)?.id
      if (!validConv(kind, id) || ids.has(id)) throw new ListingFailure('protocol')
      ids.add(id)
    }
    if (kind === 'opencode' && (next === null
      ? result.data.length !== 0 || cursorObject?.previous !== null
      : result.data.length === 0)) throw new ListingFailure('protocol')
    if (next === null) return ids
    if (cursors.has(next)) throw new ListingFailure('protocol')
    cursors.add(next)
    cursor = next
  }
  throw new ListingFailure('budget')
}

async function readPage(response: Response, signal: AbortSignal, budget: { remaining: number }): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new ListingFailure(response.ok ? 'protocol' : 'unavailable')
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (!response.ok) throw new ListingFailure('unavailable')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      budget.remaining -= value.byteLength
      if (bytes > MAX_PAGE_BYTES || budget.remaining < 0) throw new ListingFailure('budget')
      if (value.byteLength) chunks.push(value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    } catch {
      throw new ListingFailure('protocol')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

/** Serial discovery with a fresh config and native connection on each pass. */
export class NativeDiscovery {
  private running = false
  private timer?: ReturnType<typeof setTimeout>
  private active?: { abort: AbortController; result: Promise<DiscoveryResult> }
  private readonly intervalMs: number
  private readonly deadlineMs: number
  private readonly maxPages: number

  constructor(private readonly options: DiscoveryOptions) {
    this.intervalMs = options.intervalMs ?? 30_000
    this.deadlineMs = options.deadlineMs ?? 5_000
    this.maxPages = options.maxPages ?? 128
    if (!matches(options.host, HOST) || !matches(options.user, USER) || !validPath(options.bindingsPath) ||
        [this.intervalMs, this.deadlineMs, this.maxPages].some(n => !Number.isSafeInteger(n) || n <= 0 || n > 2 ** 31 - 1)) {
      throw new Error('Invalid discovery options')
    }
  }

  /** Start an immediate pass, then poll after each pass finishes. */
  start(): void {
    if (this.running) return
    this.running = true
    if (!this.active || this.active.abort.signal.aborted) void this.refresh()
  }

  /** Cancel polling and fence off any in-flight results, including uncooperative I/O. */
  async stop(): Promise<void> {
    this.running = false
    clearTimeout(this.timer)
    const current = this.active
    current?.abort.abort('cancelled')
    await current?.result
  }

  /** Force a fresh pass. Any older pass is cancelled before this one starts. */
  refresh(): Promise<DiscoveryResult> {
    clearTimeout(this.timer)
    const previous = this.active
    previous?.abort.abort('cancelled')
    const abort = new AbortController()
    const result = Promise.resolve(previous?.result).then(() => this.run(abort))
    this.active = { abort, result }
    void result.then(() => {
      if (this.active?.abort !== abort) return
      this.active = undefined
      if (this.running) this.timer = setTimeout(() => { void this.refresh() }, this.intervalMs)
    })
    return result
  }

  private async run(abort: AbortController): Promise<DiscoveryResult> {
    const { signal } = abort
    const aborted = (): DiscoveryResult => ({ status: signal.reason === 'deadline' ? 'deadline' : 'cancelled' })
    if (signal.aborted) return aborted()
    const end = performance.now() + this.deadlineMs
    const timer = setTimeout(() => abort.abort('deadline'), this.deadlineMs)
    const interrupted = Promise.withResolvers<DiscoveryResult>()
    const onAbort = () => interrupted.resolve(aborted())
    signal.addEventListener('abort', onAbort, { once: true })
    const check = () => {
      if (performance.now() >= end) abort.abort('deadline')
      signal.throwIfAborted()
    }
    try {
      return await Promise.race([interrupted.promise, this.discover(signal, check)])
    } catch {
      return signal.aborted ? aborted() : { status: 'config_failed' }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async discover(signal: AbortSignal, check: () => void): Promise<DiscoveryResult> {
    const { host, user, gateway } = this.options
    const value = await this.options.readConfig(signal)
    check()
    let config: ReturnType<typeof snapshot>
    try { config = snapshot(value) } catch { return { status: 'invalid_config' } }
    let configuredBindings: Awaited<ReturnType<typeof readBindings>>
    try {
      configuredBindings = await readBindings(this.options.bindingsPath, host, config.hosts, signal)
    } catch {
      check()
      return { status: 'invalid_bindings' }
    }
    check()

    const sources: SourceResult[] = []
    const incomplete = new Set<DiscoveryKind>()
    const inventories = new Map<DiscoveryKind, Map<string, { pid: number; result: SourceResult } | null>>()
    const budget = { remaining: MAX_HTTP_BYTES }
    for (const source of config.sources) {
      check()
      try {
        const { ids, pid } = await this.list(source, signal, budget)
        check()
        const result: SourceResult = { sourceId: source.id, status: 'complete', unmapped: ids.size }
        sources.push(result)
        const inventory = inventories.get(source.kind) ?? new Map()
        inventories.set(source.kind, inventory)
        for (const conv of ids) {
          inventory.set(conv, inventory.has(conv) ? null : { pid, result })
        }
      } catch (error) {
        check()
        incomplete.add(source.kind)
        sources.push({ sourceId: source.id, status: error instanceof ListingFailure ? error.status : 'unavailable', unmapped: 0 })
      }
    }

    // Preflight the entire pass before mutating the registry. A retained alias
    // owns its identity even if its binding or source disappeared.
    const existing = new Map(gateway.registry.list().map(rec => [identityKey(rec), rec]))
    const plan = configuredBindings.map(({ alias, kind, conv, pid: explicitPid }): {
      outcome: BindingResult; registration?: AgentRec
    } => {
      const outcome = (status: BindingResult['status']) => ({ outcome: { alias, status } })
      const match = inventories.get(kind)?.get(conv)
      const current = gateway.registry.byAlias(alias)
      const identity = identityKey({ kind, host, user, alias, conv })
      const owner = existing.get(identity)
      if (match === null || (match && explicitPid !== undefined && explicitPid !== match.pid) ||
          (owner && owner.alias !== alias) ||
          (current && (current.kind !== kind || current.host !== host || current.user !== user))) {
        return outcome('conflict')
      }
      if (incomplete.has(kind)) return outcome('incomplete')
      if (!match) return outcome('not_listed')
      match.result.unmapped--
      if (current && identityKey(current) === identity && current.pid === match.pid && current.transport === 'native') {
        return outcome('unchanged')
      }
      return {
        ...outcome('blocked'),
        registration: { alias, conv, kind, host, user, pid: match.pid, transport: 'native' },
      }
    })
    check()
    const conflict = plan.some(({ outcome }) => outcome.status === 'conflict')
    const bindings = plan.map(({ outcome, registration }): BindingResult => {
      if (!registration || conflict) return outcome
      check()
      try {
        gateway.registerAgent(registration)
        return { alias: outcome.alias, status: 'registered' }
      } catch {
        return { alias: outcome.alias, status: 'registration_failed' }
      }
    })
    return { status: 'finished', sources, bindings }
  }

  private async list(source: DiscoverySource, signal: AbortSignal, budget: { remaining: number }) {
    if (source.kind === 'opencode') {
      const listing = await openOpencodeListing(source.servicePath, signal, this.options.fetchOpencode)
      if (!listing) throw new ListingFailure('unavailable')
      const ids = await listPages(source.kind, async cursor => readPage(await listing.page(cursor), signal, budget),
        signal, this.maxPages)
      return { ids, pid: listing.pid }
    }
    const connect = this.options.connectCodex ?? connectCodexUnix
    const rpc = await connect(source.controlSocket, signal)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      try { rpc.close() } catch { /* cleanup */ }
    }
    signal.addEventListener('abort', close, { once: true })
    try {
      signal.throwIfAborted()
      const initialized = record(await rpc.request('initialize', {
        clientInfo: { name: 'agent-bus', version: '1.0.0' }, capabilities: { experimentalApi: true },
      }))
      signal.throwIfAborted()
      if (!supportedVersion(initialized?.userAgent)) throw new ListingFailure('unsupported_version')
      rpc.notify('initialized')
      const ids = await listPages(source.kind, cursor => rpc.request('thread/loaded/list', {
        limit: 50, ...(cursor === undefined ? {} : { cursor }),
      }), signal, this.maxPages)
      return { ids, pid: source.pid }
    } finally {
      signal.removeEventListener('abort', close)
      close()
    }
  }
}
