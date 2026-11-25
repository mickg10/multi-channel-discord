import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Gateway, NativeDiscovery, type DiscoveryConfig, type DiscoveryOptions, type GatewayToRouterMessage,
} from '../gateway/index.js'

const alias = 'codex@nas642'
const secondAlias = 'codex-photos@nas642'
const bare = 'opencode_nas642_glm53_abli'
const codex = {
  id: 'codex-main', kind: 'codex', controlSocket: '/fixture/control.sock', pid: 123,
} as const
const config: DiscoveryConfig = { discoveries: [codex], gatewayAliasHosts: {} }
const defaultBindings = {
  [alias]: { kind: 'codex', conv: 'thread-a' },
  [secondAlias]: { kind: 'codex', conv: 'thread-b' },
}
const initialized = { userAgent: 'codex/0.172.0 (fixture)' }

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(overrides: Partial<DiscoveryOptions> = {}, host = 'nas642') {
  const dir = await mkdtemp(join(tmpdir(), 'discovery-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const frames: GatewayToRouterMessage[] = []
  const gateway = new Gateway({ host, user: 'fixture', secret: 'fixture', storePath: join(dir, 'wakes'),
    send: frame => frames.push(frame) })
  const bindingsPath = join(dir, 'gateway-bindings.json')
  const writeBindings = (bindings: unknown) =>
    writeFile(bindingsPath, JSON.stringify(bindings), { mode: 0o600 })
  await writeBindings(defaultBindings)
  const discovery = new NativeDiscovery({
    host, user: 'fixture', gateway, bindingsPath, readConfig: () => config, ...overrides,
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
  let current = codex as DiscoveryConfig['discoveries'][number]
  let last = { data: ['thread-b'], nextCursor: null as string | null }
  const calls: unknown[] = []
  const { discovery, gateway, frames, writeBindings } = await setup({
    readConfig: () => ({ ...config, discoveries: [current] }),
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
  expect(gateway.registry.byPid(123).map(x => x.conv)).toEqual(['thread-a', 'thread-b'])
  expect(await discovery.refresh()).toMatchObject({ bindings: [
    { alias, status: 'unchanged' }, { alias: secondAlias, status: 'unchanged' },
  ] })
  expect(gateway.registry.matches(first)).toBe(true)
  expect(frames).toHaveLength(2)

  current = { ...codex, pid: 456 }
  await discovery.refresh()
  const restarted = gateway.registry.byAlias(alias)!
  expect(gateway.registry.matches(first)).toBe(false)
  expect(restarted).toMatchObject({ pid: 456, conv: 'thread-a' })
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
  next = { ...config, discoveries: [{ ...codex, pid: 0 }] }
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
  const other = { ...codex, id: 'codex-other', controlSocket: '/fixture/other.sock', pid: 456 }
  let secondPage: unknown = { data: ['thread-b'], nextCursor: null }
  const { discovery, gateway, frames, writeBindings } = await setup({
    maxPages: 1,
    readConfig: () => ({ ...config, discoveries: [codex, other] }),
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
  secondPage = { data: ['thread-b'], nextCursor: null }
  expect(await discovery.refresh()).toMatchObject({ sources: [{ unmapped: 1 }, { unmapped: 0 }], bindings: [
    { alias, status: 'registered' }, { alias: secondAlias, status: 'registered' },
  ] })
  const first = gateway.registry.byAlias(alias)!
  const second = gateway.registry.byAlias(secondAlias)!
  expect(first.pid).toBe(123)
  expect(second.pid).toBe(456)
  await writeBindings({ ...defaultBindings, [secondAlias]: { ...defaultBindings[secondAlias], pid: 999 } })
  expect(await discovery.refresh()).toMatchObject({ bindings: [
    { alias, status: 'unchanged' }, { alias: secondAlias, status: 'conflict' },
  ] })
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
  expect(first.pid).toBe(100)
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
  expect(restarted.pid).toBe(200)
  await discovery.refresh()
  expect(gateway.registry.matches(restarted)).toBe(true)
  expect(frames).toHaveLength(4)
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
  const current = { ...config, discoveries: [{ ...codex, pid: 456 }] }
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
