import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Gateway, NativeDiscovery, verifyPipePeer, type DiscoveryConfig, type DiscoveryOptions, type GatewayToRouterMessage,
} from '../gateway/index.js'

const alias = 'codex@nas642'
const secondAlias = 'codex-photos@nas642'
const bare = 'opencode_nas642_glm53_abli'
const codex = {
  id: 'codex-main', kind: 'codex', controlSocket: '/fixture/control.sock',
} as const
const config: DiscoveryConfig = { discoveries: [codex], gatewayAliasHosts: {} }
const defaultBindings = {
  [alias]: { kind: 'codex', conv: 'thread-a' },
  [secondAlias]: { kind: 'codex', conv: 'thread-b' },
}
const identity = (pid: number, started = 'linux:1', exe = '/fixture/daemon') => ({ pid, exe, started })
const initialized = { userAgent: 'codex/0.172.0 (fixture)' }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(overrides: Partial<DiscoveryOptions> = {}, host = 'nas642') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'discovery-')))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const frames: GatewayToRouterMessage[] = []
  const gateway = new Gateway({ host, user: 'fixture', secret: 'fixture', storePath: join(dir, 'wakes'),
    send: frame => frames.push(frame) })
  const bindingsPath = join(dir, 'gateway-bindings.json')
  const writeBindings = (bindings: unknown) =>
    writeFile(bindingsPath, JSON.stringify(bindings), { mode: 0o600 })
  await writeBindings(defaultBindings)
  const discovery = new NativeDiscovery({
    host, user: 'fixture', gateway, bindingsPath, readConfig: () => config,
    processIdentity: identity,
    resolveCodexPeer: path => identity(path === '/fixture/other.sock' ? 456 : 123),
    publishCodexSocket: () => {},
    publishOpencodeServicePath: () => {},
    ...overrides,
  })
  cleanups.push(() => discovery.stop())
  return { gateway, discovery, frames, dir, bindingsPath, writeBindings }
}

function codexTransport(
  page: (params: Record<string, unknown>) => unknown,
  init: unknown = initialized,
  calls: unknown[] = [],
): NonNullable<DiscoveryOptions['connectCodex']> {
  return async () => ({
    async request(method, params) {
      calls.push([method, params])
      if (method === 'initialize') return init
      if (method === 'thread/loaded/list') return page(params as Record<string, unknown>)
      throw new Error('unexpected method')
    },
    notify(method) { calls.push(method) },
    close() {},
  })
}

test('Codex fully paginates, preserves shared daemon aliases and invalidates generations only on changes', async () => {
  let started = 'linux:1'
  const published: Array<[string, string | undefined]> = []
  let last = { data: ['thread-b'], nextCursor: null as string | null }
  const calls: unknown[] = []
  const { discovery, gateway, frames, writeBindings } = await setup({
    processIdentity: pid => identity(pid, started),
    resolveCodexPeer: () => identity(123, started),
    publishCodexSocket: (conv, path) => published.push([conv, path]),
    connectCodex: codexTransport(params => params.cursor === undefined
      ? { data: ['thread-a'], nextCursor: 'opaque cursor' } : last, initialized, calls),
  })
  expect(await discovery.refresh()).toMatchObject({ status: 'finished', bindings: [
    { alias, status: 'registered' }, { alias: secondAlias, status: 'registered' },
  ] })
  expect(calls).toEqual([
    ['initialize', { clientInfo: { name: 'agent-bus', version: '1.0.0' }, capabilities: { experimentalApi: true } }],
    'initialized', ['thread/loaded/list', { limit: 50 }], ['thread/loaded/list', { limit: 50, cursor: 'opaque cursor' }],
  ])
  const first = gateway.registry.byAlias(alias)!
  expect(gateway.registry.byPid(123)).toMatchObject([
    { conv: 'thread-a', started: 'linux:1', transport: 'codex-queue' },
    { conv: 'thread-b', started: 'linux:1', transport: 'codex-queue' },
  ])
  expect(await discovery.refresh()).toMatchObject({ bindings: [
    { alias, status: 'unchanged' }, { alias: secondAlias, status: 'unchanged' },
  ] })
  expect(gateway.registry.matches(first)).toBe(true)
  expect(frames).toHaveLength(2)

  expect(published).toEqual([
    ['thread-a', codex.controlSocket], ['thread-b', codex.controlSocket],
    ['thread-a', codex.controlSocket], ['thread-b', codex.controlSocket],
  ])
  const pipe = { pid: 300, exe: process.execPath, ppid: 123, started: 'linux:3', parentStarted: first.started }
  expect(verifyPipePeer(pipe, gateway.registry, process.execPath).ok).toBe(true)
  started = 'linux:2'
  await discovery.refresh()
  const restarted = gateway.registry.byAlias(alias)!
  expect(gateway.registry.matches(first)).toBe(false)
  expect(verifyPipePeer(pipe, gateway.registry, process.execPath).ok).toBe(false)
  expect(verifyPipePeer({ ...pipe, parentStarted: started }, gateway.registry, process.execPath).ok).toBe(true)
  expect(restarted).toMatchObject({ pid: 123, started, conv: 'thread-a', transport: 'codex-queue' })
  await discovery.refresh()
  expect(gateway.registry.matches(restarted)).toBe(true)
  expect(frames).toHaveLength(4)

  await writeBindings({ [alias]: { kind: 'codex', conv: 'thread-c' } })
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ alias, status: 'not_listed' }] })
  expect(gateway.registry.matches(restarted)).toBe(true)
  last = { data: ['thread-c'], nextCursor: 'opaque cursor' }
  expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'protocol' }], bindings: [{ alias, status: 'incomplete' }] })
  expect(gateway.registry.matches(restarted)).toBe(true)
  last.nextCursor = null
  expect(await discovery.refresh()).toMatchObject({
    sources: [{ status: 'complete', unmapped: 1 }], bindings: [{ alias, status: 'registered' }],
  })
  expect(gateway.registry.byAlias(alias)?.conv).toBe('thread-c')
  expect(gateway.registry.byAlias(secondAlias)?.conv).toBe('thread-b')
  expect(frames.every(frame => frame.type === 'registerAgent')).toBe(true)
})

for (const init of [{ userAgent: 'codex/0.169.9' }, { userAgent: 'codex/0.172.0-preview' }, {}]) {
  test('Codex rejects an unsupported initialize response ' + JSON.stringify(init), async () => {
    const calls: unknown[] = []
    const { discovery, frames } = await setup({ connectCodex: codexTransport(() => ({}), init, calls) })
    expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'unsupported_version' }] })
    expect(calls).toHaveLength(1)
    expect(frames).toEqual([])
  })
}

test('Codex rejects malformed ID envelopes, RPC errors and exhausted pagination', async () => {
  let page: unknown = { data: [{ id: 'thread-a' }], nextCursor: null }
  const { discovery, frames } = await setup({
    maxPages: 1,
    connectCodex: codexTransport(() => {
      if (page instanceof Error) throw page
      return page
    }),
  })
  expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'protocol' }] })
  page = { data: ['thread-a'], nextCursor: 'opaque' }
  expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'budget' }] })
  page = new Error('method not found: private native response')
  const result = await discovery.refresh()
  expect(result).toMatchObject({ sources: [{ status: 'unavailable' }] })
  expect(JSON.stringify(result)).not.toContain('private')
  expect(frames).toEqual([])
})

test('qualified and bare aliases require the correct host and preserve fleet spelling', async () => {
  let next: DiscoveryConfig = config
  const calls: unknown[] = []
  const { discovery, frames, writeBindings } = await setup({
    readConfig: () => next, connectCodex: codexTransport(() => ({ data: ['thread-a'], nextCursor: null }), initialized, calls),
  })
  next = { ...config, discoveries: [codex, codex] }
  expect(await discovery.refresh()).toEqual({ status: 'invalid_config' })
  next = { ...config, discoveries: [{ ...codex, controlSocket: 'relative.sock' }] }
  expect(await discovery.refresh()).toEqual({ status: 'invalid_config' })
  next = { ...config, gatewayAliasHosts: { [alias]: 'mac' } }
  expect(await discovery.refresh()).toEqual({ status: 'invalid_bindings' })
  next = config
  for (const invalid of ['codex@mac:infra', bare, 'codex@nas642@mac', alias + '\n']) {
    await writeBindings({ [invalid]: { kind: 'codex', conv: 'thread-a' } })
    expect(await discovery.refresh()).toEqual({ status: 'invalid_bindings' })
  }
  expect(calls).toEqual([])
  expect(frames).toEqual([])

  const mac = await setup({
    connectCodex: codexTransport(() => ({ data: ['thread-a'], nextCursor: null })),
  }, 'mac')
  await mac.writeBindings({ 'codex@mac:infra': { kind: 'codex', conv: 'thread-a' } })
  await mac.discovery.refresh()
  expect(mac.gateway.registry.byAlias('codex@mac:infra')?.conv).toBe('thread-a')
})

test('unsafe or malformed binding files fail before native reads and retain registrations', async () => {
  const calls: unknown[] = []
  const { discovery, frames, gateway, bindingsPath, writeBindings, dir } = await setup({
    connectCodex: codexTransport(() => ({ data: ['thread-a'], nextCursor: null }), initialized, calls),
  })
  await discovery.refresh()
  const old = gateway.registry.byAlias(alias)!
  const callCount = calls.length
  async function rejected() {
    expect(await discovery.refresh()).toEqual({ status: 'invalid_bindings' })
    expect(gateway.registry.matches(old)).toBe(true)
    expect(calls).toHaveLength(callCount)
    expect(frames).toHaveLength(1)
  }
  await chmod(bindingsPath, 0o644)
  await rejected()
  await chmod(bindingsPath, 0o4600)
  await rejected()
  await chmod(bindingsPath, 0o600)
  for (const invalid of [
    { private: { kind: 'claude', conv: 'private' } },
    { [alias]: { kind: 'codex', conv: 'private/id' } },
    { [alias]: { kind: 'opencode', conv: 'missing-prefix' } },
    { [alias]: { kind: 'codex', conv: 'thread-a', pid: 0 } },
    { ...defaultBindings, [secondAlias]: defaultBindings[alias] },
  ]) {
    await writeBindings(invalid)
    await rejected()
  }
  for (const invalid of [
    '{"codex@nas642":{"kind":"codex","conv":"thread-a"},"\\u0063odex@nas642":{"kind":"codex","conv":"thread-b"}}',
    '{"codex@nas642":{"kind":"claude","kind":"codex","conv":"thread-a"}}',
    '{',
    ' '.repeat(1024 * 1024 + 1),
  ]) {
    await writeFile(bindingsPath, invalid)
    await rejected()
  }
  await rm(bindingsPath)
  await rejected()
  const target = join(dir, 'target.json')
  await writeFile(target, JSON.stringify(defaultBindings), { mode: 0o600 })
  await symlink(target, bindingsPath)
  await rejected()
  await rm(bindingsPath)
  await mkdir(bindingsPath, { mode: 0o600 })
  await rejected()
})

test('retained native identities prevent a second owner after binding changes', async () => {
  const { discovery, gateway, frames, writeBindings } = await setup({
    connectCodex: codexTransport(() => ({ data: ['thread-a'], nextCursor: null })),
  })
  await discovery.refresh()
  const old = gateway.registry.byAlias(alias)!
  await writeBindings({ [secondAlias]: defaultBindings[alias] })
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ alias: secondAlias, status: 'conflict' }] })
  expect(gateway.registry.matches(old)).toBe(true)
  expect(frames).toHaveLength(1)
})

test('complete same-kind inventories prove matches and ambiguity blocks all writes', async () => {
  const other = { ...codex, id: 'codex-other', controlSocket: '/fixture/other.sock' }
  const published: string[] = []
  let secondPage: unknown = { data: ['thread-b'], nextCursor: null }
  const { discovery, gateway, frames, writeBindings } = await setup({
    maxPages: 1,
    publishCodexSocket: conv => published.push(conv),
    readConfig: () => ({ ...config, discoveries: [{ ...codex, pid: 999 }, other] }),
    connectCodex: (path, signal) => codexTransport(() => {
      if (path === codex.controlSocket) return { data: ['thread-a', 'unmapped'], nextCursor: null }
      if (secondPage instanceof Error) throw secondPage
      return secondPage
    })(path, signal),
  })
  await writeBindings({ ...defaultBindings, [secondAlias]: { ...defaultBindings[secondAlias], pid: 456 } })
  for (const incomplete of [new Error('private'), { data: ['thread-b'], nextCursor: 'more' }]) {
    secondPage = incomplete
    expect(await discovery.refresh()).toMatchObject({ bindings: [
      { alias, status: 'incomplete' }, { alias: secondAlias, status: 'incomplete' },
    ] })
    expect(frames).toHaveLength(0)
  }
  secondPage = { data: ['thread-a', 'thread-b'], nextCursor: null }
  expect(await discovery.refresh()).toMatchObject({ bindings: [
    { alias, status: 'conflict' }, { alias: secondAlias, status: 'blocked' },
  ] })
  expect(frames).toHaveLength(0)
  expect(published).toEqual([])
  secondPage = { data: ['thread-b'], nextCursor: null }
  expect(await discovery.refresh()).toMatchObject({ sources: [{ unmapped: 1 }, { unmapped: 0 }], bindings: [
    { alias, status: 'registered' }, { alias: secondAlias, status: 'registered' },
  ] })
  const first = gateway.registry.byAlias(alias)!
  const second = gateway.registry.byAlias(secondAlias)!
  expect(first.pid).toBe(123)
  expect(second.pid).toBe(456)
  expect(published).toEqual(['thread-a', 'thread-b'])
  await writeBindings({ ...defaultBindings, [secondAlias]: { ...defaultBindings[secondAlias], pid: 999 } })
  expect(await discovery.refresh()).toMatchObject({ bindings: [
    { alias, status: 'unchanged' }, { alias: secondAlias, status: 'conflict' },
  ] })
  expect(published).toEqual(['thread-a', 'thread-b'])
  secondPage = new Error('offline')
  expect(await discovery.refresh()).toMatchObject({ bindings: [
    { alias, status: 'incomplete' }, { alias: secondAlias, status: 'incomplete' },
  ] })
  expect(gateway.registry.matches(first)).toBe(true)
  expect(gateway.registry.matches(second)).toBe(true)
  expect(frames).toHaveLength(2)
})

async function opencodeSetup(fetchOpencode: NonNullable<DiscoveryOptions['fetchOpencode']>, extras: Partial<DiscoveryOptions> = {}) {
  let servicePath: string
  const result = await setup({
    readConfig: () => ({
      gatewayAliasHosts: { [bare]: 'nas642' },
      discoveries: [{
        id: 'opencode-main', kind: 'opencode', servicePath,
      }],
    }),
    fetchOpencode, ...extras,
  })
  servicePath = join(result.dir, 'service.json')
  const descriptor = (pid: number, url = 'http://127.0.0.1:12345') =>
    writeFile(servicePath, JSON.stringify({ url, pid, password: 'fixture-only-password' }), { mode: 0o600 })
  await descriptor(100)
  await result.writeBindings({
    [bare]: { kind: 'opencode', conv: 'ses_exampleA' },
    'opencode@nas642:other': { kind: 'opencode', conv: 'ses_exampleB' },
  })
  return { ...result, servicePath, descriptor }
}

test('OpenCode sends only authenticated GETs and follows cursor.next after the last nonempty page', async () => {
  const requests: Array<string | null> = []
  const { discovery, gateway, frames, descriptor, writeBindings } = await opencodeSetup(async (input, init) => {
    const url = new URL(String(input))
    const cursor = url.searchParams.get('cursor')
    requests.push(cursor)
    if (url.pathname !== '/api/session' || url.username || url.password || init?.method !== 'GET' ||
        init.redirect !== 'error' || init.body !== undefined ||
        new Headers(init.headers).get('authorization') !== 'Basic ' + Buffer.from('opencode:fixture-only-password').toString('base64')) {
      throw new Error('unexpected request')
    }
    const item = (id: string) => ({ id, title: 'same title', location: { directory: '/fixture/same-cwd' } })
    if (cursor === null) return Response.json({ data: [item('ses_exampleA')], cursor: { previous: 'prev1', next: 'opaque+/=' } })
    if (cursor === 'opaque+/=') return Response.json({ data: [item('ses_exampleB')], cursor: { previous: 'prev2', next: 'last' } })
    if (cursor === 'last') return Response.json({ data: [], cursor: { previous: null, next: null } })
    throw new Error('unexpected cursor')
  })
  expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'complete', unmapped: 0 }],
    bindings: [{ alias: bare, status: 'registered' }, { alias: 'opencode@nas642:other', status: 'registered' }] })
  expect(requests).toEqual([null, 'opaque+/=', 'last'])
  const first = gateway.registry.byAlias(bare)!
  expect(gateway.registry.byPid(100)).toMatchObject([
    { conv: 'ses_exampleA', transport: 'opencode-queue' },
    { conv: 'ses_exampleB', transport: 'opencode-queue' },
  ])
  expect(await discovery.refresh()).toMatchObject({ bindings: [
    { alias: bare, status: 'unchanged' }, { alias: 'opencode@nas642:other', status: 'unchanged' },
  ] })
  expect(gateway.registry.matches(first)).toBe(true)
  expect(frames).toHaveLength(2)
  await writeBindings({ [bare]: { kind: 'opencode', conv: 'ses_exampleA', pid: 100 },
    'opencode@nas642:other': { kind: 'opencode', conv: 'ses_exampleB' } })
  await descriptor(200)
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ alias: bare, status: 'conflict' },
    { alias: 'opencode@nas642:other', status: 'blocked' }] })
  expect(gateway.registry.matches(first)).toBe(true)
  await writeBindings({ [bare]: { kind: 'opencode', conv: 'ses_exampleA', pid: 200 },
    'opencode@nas642:other': { kind: 'opencode', conv: 'ses_exampleB' } })
  await discovery.refresh()
  expect(gateway.registry.matches(first)).toBe(false)
  const restarted = gateway.registry.byAlias(bare)!
  expect(restarted).toMatchObject({ pid: 200, transport: 'opencode-queue' })
  expect(await discovery.refresh()).toMatchObject({ bindings: [
    { alias: bare, status: 'unchanged' }, { alias: 'opencode@nas642:other', status: 'unchanged' },
  ] })
  expect(gateway.registry.matches(restarted)).toBe(true)
  expect(frames).toHaveLength(4)
})

test('OpenCode only publishes verified descriptor paths and can update one without registering again', async () => {
  let sources: DiscoveryConfig['discoveries'] = []
  let stale = false
  const publications: Array<[string, string | undefined]> = []
  const conv = 'ses_exampleA'
  const { dir, discovery, gateway, frames, writeBindings } = await setup({
    readConfig: () => ({ discoveries: sources, gatewayAliasHosts: { [bare]: 'nas642' } }),
    processIdentity: pid => identity(pid, stale ? 'linux:2' : 'linux:1'),
    fetchOpencode: async input => {
      if (new URL(input).searchParams.has('cursor')) {
        if (sources[0]?.id === 'stale') stale = true
        return Response.json({ data: [], cursor: { previous: null, next: null } })
      }
      return Response.json({ data: [{ id: conv }, { id: 'ses_unmapped' }], cursor: { previous: null, next: 'end' } })
    },
    publishOpencodeServicePath: (session, path) => publications.push([session, path]),
  })
  const oldPath = join(dir, 'old.json')
  const newPath = join(dir, 'new.json')
  const oldSource = { id: 'old', kind: 'opencode', servicePath: oldPath } as const
  const newSource = { id: 'new', kind: 'opencode', servicePath: newPath } as const
  for (const path of [oldPath, newPath]) {
    await writeFile(path, JSON.stringify({ pid: 100, url: 'http://127.0.0.1:12345', password: 'fixture' }), { mode: 0o600 })
  }
  await writeBindings({ [bare]: { kind: 'opencode', conv } })
  sources = [oldSource]
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ status: 'registered' }] })
  const registration = gateway.registry.byAlias(bare)!
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ status: 'unchanged' }] })
  expect(publications).toEqual([[conv, oldPath], [conv, oldPath]])

  sources = [oldSource, newSource]
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ status: 'conflict' }] })
  sources = [{ ...newSource, servicePath: join(dir, 'missing.json') }]
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ status: 'incomplete' }] })
  sources = [{ ...newSource, id: 'stale' }]
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ status: 'incomplete' }] })
  sources = []
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ status: 'not_listed' }] })
  expect(publications).toEqual([[conv, oldPath], [conv, oldPath]])

  stale = false
  sources = [newSource]
  expect(await discovery.refresh()).toMatchObject({ bindings: [{ status: 'unchanged' }] })
  expect(publications).toEqual([[conv, oldPath], [conv, oldPath], [conv, newPath]])
  expect(gateway.registry.matches(registration)).toBe(true)
  expect(frames).toHaveLength(1)
})

test('OpenCode refuses malformed cursor objects, IDs, loops and oversized responses without registering', async () => {
  let page: unknown
  const { discovery, frames, descriptor, servicePath } = await opencodeSetup(async () => Response.json(page))
  for (const invalid of [
    { data: [{ id: 'ses_exampleA' }], cursor: 'opaque' },
    { data: [{ id: 'ses_exampleA' }], cursor: { previous: null, next: { cursor: 'opaque' } } },
    { data: [{ id: 'other' }], cursor: { previous: null, next: null } },
    { data: [{ id: 'ses_exampleA' }], cursor: { previous: null, next: null } },
    { data: [], cursor: { previous: 'unexpected', next: null } },
    { data: [], cursor: { previous: null, next: 'loop' } },
    { data: {}, cursor: { previous: null, next: null } },
  ]) {
    page = invalid
    expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'protocol' }] })
  }
  page = { data: [{ id: 'ses_exampleA', title: 'x'.repeat(1024 * 1024) }], cursor: { previous: null, next: null } }
  expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'budget' }] })
  await chmod(servicePath, 0o644)
  expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'unavailable' }] })
  await chmod(servicePath, 0o600)
  await descriptor(100, 'http://192.0.2.1')
  expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'unavailable' }] })
  await rm(servicePath)
  await symlink('missing.json', servicePath)
  expect(await discovery.refresh()).toMatchObject({ sources: [{ status: 'unavailable' }] })
  expect(frames).toEqual([])
})

test('whole-pass deadline closes a hung Codex connection and leaves previous registrations intact', async () => {
  let hang = false
  let closes = 0
  const pending = Promise.withResolvers<unknown>()
  const { gateway, discovery, frames } = await setup({
    deadlineMs: 40,
    connectCodex: async () => ({
      async request(method) {
        if (method === 'initialize') return initialized
        return hang ? pending.promise : { data: ['thread-a'], nextCursor: null }
      },
      notify() {},
      close() { closes++ },
    }),
  })
  await discovery.refresh()
  const old = gateway.registry.byAlias(alias)!
  hang = true
  expect(await discovery.refresh()).toEqual({ status: 'deadline' })
  expect(closes).toBe(2)
  pending.resolve({ data: ['thread-b'], nextCursor: null })
  await Bun.sleep(0)
  expect(gateway.registry.matches(old)).toBe(true)
  expect(frames).toHaveLength(1)
})

test('an injected OpenCode fetch ignoring abort cannot hold refresh open or install a late result', async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const reply = Promise.withResolvers<Response>()
  const { discovery, frames } = await opencodeSetup(async (url, init) => {
    if (new URL(url).searchParams.has('cursor')) {
      return Response.json({ data: [], cursor: { next: null, previous: null } })
    }
    started.resolve(init?.signal as AbortSignal)
    return reply.promise
  }, { deadlineMs: 75 })
  const refresh = discovery.refresh()
  const signal = await started.promise
  expect(await refresh).toEqual({ status: 'deadline' })
  expect(signal.aborted).toBe(true)
  reply.resolve(Response.json({ data: [{ id: 'ses_exampleA' }], cursor: { next: 'last', previous: null } }))
  await Bun.sleep(0)
  expect(frames).toEqual([])
})

test('forced refresh and stop fence off late config reads and polling stays serial', async () => {
  const stale = Promise.withResolvers<DiscoveryConfig>()
  const began = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<DiscoveryConfig>()
  const thirdRead = Promise.withResolvers<void>()
  const current = { ...config, discoveries: [{ ...codex, controlSocket: '/fixture/other.sock' }] }
  let reads = 0
  const { discovery, gateway, frames, writeBindings } = await setup({
    intervalMs: 10, deadlineMs: 1000,
    readConfig() {
      if (++reads === 1) {
        began.resolve()
        return stale.promise
      }
      if (reads === 3) {
        thirdRead.resolve()
        return stopping.promise
      }
      return current
    },
    connectCodex: codexTransport(() => ({ data: ['thread-a', 'thread-b'], nextCursor: null })),
  })
  discovery.start()
  discovery.start()
  await began.promise
  await Bun.sleep(35)
  expect(reads).toBe(1)
  await writeBindings({ [alias]: { kind: 'codex', conv: 'thread-b' } })
  await discovery.refresh()
  expect(gateway.registry.byAlias(alias)).toMatchObject({ conv: 'thread-b', pid: 456 })
  await discovery.stop()
  stale.resolve(config)
  const stoppedReads = reads
  await Bun.sleep(25)
  expect(reads).toBe(stoppedReads)
  expect(frames).toHaveLength(1)

  const cancelled = discovery.refresh()
  await thirdRead.promise
  await writeBindings({ [alias]: { kind: 'codex', conv: 'thread-a' } })
  await discovery.stop()
  expect(await cancelled).toEqual({ status: 'cancelled' })
  stopping.resolve(config)
  await Bun.sleep(0)
  expect(gateway.registry.byAlias(alias)).toMatchObject({ conv: 'thread-b', pid: 456 })
  expect(frames).toHaveLength(1)
})

test('polling reopens config after each successful pass and stop ends polling', async () => {
  const twice = Promise.withResolvers<void>()
  let reads = 0
  const { discovery, frames } = await setup({
    intervalMs: 5,
    readConfig() {
      if (++reads === 2) twice.resolve()
      return config
    },
    connectCodex: codexTransport(() => ({ data: ['thread-a'], nextCursor: null })),
  })
  discovery.start()
  await twice.promise
  await discovery.stop()
  await Bun.sleep(20)
  expect(reads).toBe(2)
  expect(frames).toHaveLength(1)
})

test('Codex identity failures before listing, after listing and at admission retain aliases and socket mappings', async () => {
  let probes = 0
  let requests = 0
  let failAt = 0
  let peer: ReturnType<typeof identity> | undefined = identity(123)
  const published: string[] = []
  const { discovery, gateway, frames } = await setup({
    resolveCodexPeer: () => ++probes === failAt ? peer : identity(123),
    publishCodexSocket: conv => published.push(conv),
    connectCodex: codexTransport(() => {
      requests++
      return { data: ['thread-a', 'thread-b'], nextCursor: null }
    }),
  })
  await discovery.refresh()
  const retained = gateway.registry.list()
  for (const [when, badPeer] of [
    [1, undefined],
    [1, identity(123, 'linux:99')],
    [1, identity(123, 'linux:1', '/fixture/other-executable')],
    [2, identity(456)],
    [3, identity(456)],
  ] as const) {
    probes = 0
    requests = 0
    failAt = when
    peer = badPeer
    expect(await discovery.refresh()).toMatchObject({
      sources: [{ status: 'unavailable' }],
      bindings: [{ status: 'incomplete' }, { status: 'incomplete' }],
    })
    expect(requests).toBe(when === 1 ? 0 : 1)
    expect(retained.every(rec => gateway.registry.matches(rec))).toBe(true)
    expect(frames).toHaveLength(2)
    expect(published).toEqual(['thread-a', 'thread-b'])
  }
})

for (const mode of ['missing', 'started', 'exe', 'descriptor'] as const) {
  test('OpenCode retains its registry when the process check fails: ' + mode, async () => {
    let pidIdentity: ReturnType<typeof identity> | undefined = identity(100)
    let mutate: (() => void | Promise<void>) | undefined
    const { discovery, gateway, frames, descriptor } = await opencodeSetup(async input => {
      if (new URL(input).searchParams.has('cursor')) {
        return Response.json({ data: [], cursor: { next: null, previous: null } })
      }
      await mutate?.()
      return Response.json({ data: [{ id: 'ses_exampleA' }], cursor: { next: 'end', previous: null } })
    }, { processIdentity: pid => pid === 100 ? pidIdentity : identity(pid) })
    await discovery.refresh()
    const retained = gateway.registry.byAlias(bare)!
    expect(retained.started).toBe('linux:1')
    if (mode === 'missing') pidIdentity = undefined
    else if (mode === 'descriptor') mutate = () => descriptor(200)
    else mutate = () => {
      pidIdentity = mode === 'started' ? identity(100, 'linux:2') : identity(100, 'linux:1', '/fixture/new-exe')
    }
    expect(await discovery.refresh()).toMatchObject({
      sources: [{ status: 'unavailable' }],
      bindings: [{ status: 'incomplete' }, { status: 'incomplete' }],
    })
    expect(gateway.registry.matches(retained)).toBe(true)
    expect(frames).toHaveLength(1)
  })
}

test('refresh and stop abort injected peer I/O and fence late peers before opening native transport', async () => {
  const first = Promise.withResolvers<AbortSignal>()
  const second = Promise.withResolvers<AbortSignal>()
  const late = Promise.withResolvers<ReturnType<typeof identity>>()
  let probes = 0
  let closed = 0
  let connected = 0
  const { discovery, frames } = await setup({
    resolveCodexPeer: (_path, signal) => {
      signal.addEventListener('abort', () => { closed++ }, { once: true })
      const pending = ++probes === 1 ? first : second
      pending.resolve(signal)
      return late.promise
    },
    connectCodex: async () => {
      connected++
      throw new Error('unexpected connection')
    },
  })
  const oldest = discovery.refresh()
  const firstSignal = await first.promise
  const newest = discovery.refresh()
  expect(await oldest).toEqual({ status: 'cancelled' })
  expect(firstSignal.aborted).toBe(true)
  const secondSignal = await second.promise
  await discovery.stop()
  expect(await newest).toEqual({ status: 'cancelled' })
  expect(secondSignal.aborted).toBe(true)
  expect(closed).toBe(2)
  late.resolve(identity(123))
  await Bun.sleep(0)
  expect(connected).toBe(0)
  expect(frames).toEqual([])
})

test('a late replacement blocks the whole registration group', async () => {
  let servicePath: string
  let probes = 0
  const published: string[] = []
  const { discovery, gateway, frames, dir, writeBindings } = await setup({
    readConfig: () => ({
      discoveries: [codex, { kind: 'opencode', id: 'opencode-main', servicePath }],
      gatewayAliasHosts: { [bare]: 'nas642' },
    }),
    resolveCodexPeer: () => identity(++probes === 3 ? 456 : 123),
    connectCodex: codexTransport(() => ({ data: ['thread-a'], nextCursor: null })),
    fetchOpencode: async input => new URL(input).searchParams.has('cursor')
      ? Response.json({ data: [], cursor: { next: null, previous: null } })
      : Response.json({ data: [{ id: 'ses_exampleA' }], cursor: { next: 'end', previous: null } }),
    publishCodexSocket: conv => published.push(conv),
  })
  servicePath = join(dir, 'service.json')
  await writeFile(servicePath, JSON.stringify({ pid: 100, url: 'http://127.0.0.1:12345', password: 'fixture' }), { mode: 0o600 })
  await writeBindings({ [bare]: { kind: 'opencode', conv: 'ses_exampleA' }, [alias]: defaultBindings[alias] })
  expect(await discovery.refresh()).toMatchObject({
    bindings: [{ alias: bare, status: 'blocked' }, { alias, status: 'incomplete' }],
  })
  expect(gateway.registry.list()).toEqual([])
  expect(frames).toEqual([])
  expect(published).toEqual([])
})

test.skipIf(process.platform !== 'linux')('default Codex probes use and close a private Unix peer without sending data', async () => {
  let controlSocket: string
  const sockets = new Set<Socket>()
  const closed = Promise.withResolvers<void>()
  let accepted = 0
  let ended = 0
  let bytes = 0
  const server = createServer(socket => {
    accepted++
    sockets.add(socket)
    socket.on('data', chunk => { bytes += chunk.length })
    socket.on('close', () => {
      sockets.delete(socket)
      if (++ended === 3) closed.resolve()
    })
  })
  const { discovery, gateway, dir } = await setup({
    processIdentity: undefined,
    resolveCodexPeer: undefined,
    readConfig: () => ({ ...config, discoveries: [{ ...codex, controlSocket, pid: 999 }] }),
    connectCodex: codexTransport(() => ({ data: ['thread-a'], nextCursor: null })),
  })
  controlSocket = join(dir, 'codex.sock')
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(controlSocket, resolve)
    })
    await chmod(controlSocket, 0o600)
    expect(await discovery.refresh()).toMatchObject({
      bindings: [{ alias, status: 'registered' }, { alias: secondAlias, status: 'not_listed' }],
    })
    await closed.promise
    expect(gateway.registry.byAlias(alias)).toMatchObject({ pid: process.pid, started: expect.stringMatching(/^linux:/) })
    expect(accepted).toBe(3)
    expect(bytes).toBe(0)

    const cancelledSocketClosed = Promise.withResolvers<void>()
    server.once('connection', socket => {
      socket.once('close', () => cancelledSocketClosed.resolve())
      void discovery.stop()
    })
    expect(await discovery.refresh()).toEqual({ status: 'cancelled' })
    await cancelledSocketClosed.promise
    expect(bytes).toBe(0)
  } finally {
    for (const socket of sockets) socket.destroy()
    server.close()
  }
})
