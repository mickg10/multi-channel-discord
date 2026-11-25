import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAdapter, Registry, adaptersFor, builtinAdapters, darwinStartTime, loadConfig, peerFromDarwin, peerFromLinux, ppidFromStat, processIdentity, readNodeSecret, startHost, startTimeFromStat, verifyPipePeer, type AdapterBinding, type DarwinSys, type GatewayToRouterMessage } from '../gateway/index.js'
import { LOCAL_PEERCRED, LOCAL_PEERPID, SOL_LOCAL } from '../gateway/peer-cred.js'

const root = join(import.meta.dir, '../..')

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gw-host-'))
}

test('ppid is the field after a command that contains parentheses', () => {
  expect(ppidFromStat('123 (bun (x) y) S 456 7\n')).toBe(456)
  expect(ppidFromStat('no paren')).toBeUndefined()
  const fields = ['S', '456', ...Array.from({ length: 17 }, () => '0'), '999']
  expect(startTimeFromStat(`123 (bun (x) y) ${fields.join(' ')}\n`)).toBe('linux:999')
  const info = new Uint8Array(136)
  new DataView(info.buffer).setBigUint64(120, 10n, true)
  new DataView(info.buffer).setBigUint64(128, 4n, true)
  expect(darwinStartTime(info)).toBe('darwin:10.4')
  const self = processIdentity(process.pid)
  expect(self?.pid).toBe(process.pid)
  expect(self?.started.startsWith('linux:')).toBe(true)
})

test('a gateway config names absolute paths and kind/transport pairs', async () => {
  const dir = await tempDir()
  const file = join(dir, 'gateway.json')
  const pipePath = join(dir, 'agent-bus-pipe')
  const bindings: AdapterBinding[] = [
    { kind: 'opencode', transport: 'opencode-queue' },
    { kind: 'codex', transport: 'codex-queue' },
  ]
  writeFileSync(file, JSON.stringify({
    host: 'nas642', user: 'mickg', routerUrl: 'ws://127.0.0.1/bus',
    secretFile: join(dir, 'secret'), socketPath: join(dir, 'gw.sock'), wakeStore: join(dir, 'wakes.json'),
    pipePath, adapters: bindings,
  }))
  expect(loadConfig(file).adapters).toEqual(bindings)
  expect(loadConfig(join(root, 'contrib/gateway.example.json')).adapters).toEqual([])
  expect(loadConfig(join(root, 'contrib/gateway.example.json')).pipePath).toBe('/usr/local/bin/agent-bus-pipe')
  writeFileSync(file, JSON.stringify({ host: 'nas642', user: 'mickg', routerUrl: 'http://nope', secretFile: '/s', socketPath: '/g', wakeStore: '/w', pipePath: '/p', adapters: [] }))
  expect(() => loadConfig(file)).toThrow('websocket')
  writeFileSync(file, JSON.stringify({ host: 'nas642', user: 'mickg', routerUrl: 'ws://127.0.0.1', secretFile: 'secret', socketPath: '/g', wakeStore: '/w', pipePath: '/p', adapters: [] }))
  expect(() => loadConfig(file)).toThrow('absolute')
  writeFileSync(file, JSON.stringify({ host: 'nas642', user: 'mickg', routerUrl: 'ws://127.0.0.1', secretFile: '/s', socketPath: '/g', wakeStore: '/w', pipePath: '/p', adapters: [{ kind: 'codex', transport: 'codex-queue' }, { kind: 'codex', transport: 'codex-queue' }] }))
  expect(() => loadConfig(file)).toThrow('twice')
  expect(() => adaptersFor([{ kind: 'codex', transport: 'codex-queue' }])).toThrow('no adapter for codex/codex-queue')
  const made: string[] = []
  const table = new Map([
    ['opencode\0opencode-queue', () => { made.push('opencode'); return new FakeAdapter('opencode') }],
    ['codex\0codex-queue', () => { made.push('codex'); return new FakeAdapter('codex') }],
  ])
  expect(adaptersFor(bindings, table).map(adapter => adapter.transport)).toEqual(['opencode-queue', 'codex-queue'])
  expect(made).toEqual(['opencode', 'codex'])
})

test('the cli builds the codex and opencode adapters from their transports', () => {
  const adapters = builtinAdapters([
    { kind: 'codex', transport: 'codex-queue' },
    { kind: 'opencode', transport: 'opencode-queue' },
  ])
  expect(adapters.map(adapter => `${adapter.kind}/${adapter.transport}`)).toEqual([
    'codex/codex-queue',
    'opencode/opencode-queue',
  ])
})

test('a group-readable node secret is refused', async () => {
  const dir = await tempDir()
  const file = join(dir, 'secret')
  writeFileSync(file, 'sekrit\n', { mode: 0o600 })
  chmodSync(file, 0o640)
  expect(() => readNodeSecret(file)).toThrow('group or others')
  chmodSync(file, 0o600)
  expect(readNodeSecret(file)).toBe('sekrit')
})

test('the gateway main requires a config path', async () => {
  const proc = Bun.spawn(['bun', join(root, 'bin/agent-bus-gateway.ts')], { stdout: 'pipe', stderr: 'pipe' })
  expect(await proc.exited).toBe(2)
  expect(await new Response(proc.stderr).text()).toContain('--config')
})

describe('host runtime', () => {
  test('startup registers adapters, then replays an unacked wake', async () => {
    const dir = await tempDir()
    const secret = 'super-secret-value'
    const secretFile = join(dir, 'secret')
    writeFileSync(secretFile, secret + '\n', { mode: 0o600 })
    chmodSync(secretFile, 0o600)
    const store = join(dir, 'state', 'wakes.json')
    mkdirSync(join(dir, 'state'), { mode: 0o700 })
    writeFileSync(store, JSON.stringify([{
      msgId: 'm1', conv: 'c1', kind: 'codex', host: 'nas642', user: 'mickg', alias: 'codex@nas642',
      n: 1, transport: 'codex-queue', state: 'woken', nativeId: 'native-1',
    }]), { mode: 0o600 })
    const frames: GatewayToRouterMessage[] = []
    let link: { send: (data: string) => void } | undefined
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined
        return new Response('no', { status: 426 })
      },
      websocket: {
        open(ws) { link = ws },
        message(_ws, message) {
          const text = typeof message === 'string' ? message : Buffer.from(message).toString()
          const frame = JSON.parse(text) as GatewayToRouterMessage
          frames.push(frame)
          if (frame.type === 'registerGateway') {
            _ws.send(JSON.stringify({ type: 'gatewayRegistered', host: frame.host, user: frame.user, proto: 1 }))
          }
          if (frame.type === 'registerAgent') {
            _ws.send(JSON.stringify({
              type: 'agentRegistered', as: frame.alias,
              target: { host: frame.host, user: 'mickg', kind: frame.kind, conv: frame.conv, alias: frame.alias },
            }))
          }
        },
      },
    })
    const logged: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    }) as typeof process.stderr.write
    const codex = new FakeAdapter('codex')
    const opencode = new FakeAdapter('opencode')
    const pipePath = join(dir, 'agent-bus-pipe')
    writeFileSync(pipePath, '')
    const refreshed: string[] = []
    const host = await startHost({
      host: 'nas642', user: 'mickg', routerUrl: `ws://127.0.0.1:${server.port}`,
      secretFile, socketPath: join(dir, 'gw.sock'), wakeStore: store, pipePath,
      adapters: [{ kind: 'codex', transport: 'codex-queue' }, { kind: 'opencode', transport: 'opencode-queue' }],
    }, {
      adapters: [codex, opencode],
      discovery: { start() { refreshed.push('start') }, async refresh() { refreshed.push('refresh') }, async stop() {} },
    })
    try {
      await waitFor(() => frames.some(frame => frame.type === 'registerGateway'))
      expect(frames.some(frame => frame.type === 'wakeResult')).toBe(false)
      expect(refreshed).toEqual(['start'])
      expect(frames[0]).toMatchObject({ type: 'registerGateway', host: 'nas642', user: 'mickg', proto: 1, secret })
      expect(frames.filter(frame => frame.type === 'registerGateway')).toHaveLength(1)
      expect(logged.join('')).not.toContain(secret)
      expect(readFileSync('/proc/self/limits', 'utf8')).toContain('Max core file size        0')
      host.gateway.registerAgent({
        host: 'nas642', user: 'mickg', kind: 'codex', conv: 'c2', alias: 'codex@nas642', pid: 50, transport: 'codex-queue', started: 'linux:1',
      })
      await waitFor(() => frames.some(frame => frame.type === 'wakeResult' && frame.id === 'm1'))
      const registeredAt = frames.findIndex(frame => frame.type === 'registerAgent' && frame.alias === 'codex@nas642')
      const replay = frames.find(frame => frame.type === 'wakeResult' && frame.id === 'm1')
      expect(replay).toMatchObject({ result: { s: 'woken', nativeId: 'native-1' } })
      expect(frames.indexOf(replay!)).toBeGreaterThan(registeredAt)
      link!.send(JSON.stringify({ type: 'wake', as: 'codex@nas642', msgId: '99', n: 3 }))
      await waitFor(() => codex.wakeCalls === 1)
      expect(codex.wakeCalls).toBe(1)
      expect(opencode.wakeCalls).toBe(0)
    } finally {
      process.stderr.write = write
      await host.close()
      server.stop(true)
    }
  })
})

function waitFor(ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (ready()) { resolve(); return }
      if (Date.now() - start > 2000) { reject(new Error('timed out')); return }
      setTimeout(tick, 10)
    }
    tick()
  })
}

test('a compiled pipe realpath matches the installed path', async () => {
  if (process.platform !== 'linux') return
  const dir = await tempDir()
  const compiled = join(dir, 'agent-bus-pipe')
  const build = Bun.spawn(['bun', 'build', '--compile', join(root, 'bin/agent-bus-pipe.ts'), '--outfile', compiled], { stdout: 'pipe', stderr: 'pipe' })
  expect(await build.exited).toBe(0)
  const sock = join(dir, 'gw.sock')
  const server = createServer()
  const accepted = new Promise<import('node:net').Socket>(resolve => server.on('connection', resolve))
  await new Promise<void>(resolve => server.listen(sock, () => resolve()))
  const child = Bun.spawn([compiled, sock], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' })
  const socket = await accepted
  try {
    const info = peerFromLinux((socket as unknown as { _handle: { fd: number } })._handle.fd)
    const parent = info ? processIdentity(info.ppid) : undefined
    expect(parent?.started).toBe(info?.parentStarted)
    const reg = new Registry()
    reg.add({
      host: 'nas642', user: 'mickg', kind: 'codex', conv: 'c', alias: 'codex@nas642',
      pid: info!.ppid, transport: 'codex-queue', started: parent!.started,
    })
    expect(verifyPipePeer(info!, reg, compiled).ok).toBe(true)
    expect(verifyPipePeer(info!, reg, '/bin/bash')).toEqual({ ok: false, error: 'peer is not agent-bus-pipe' })
  } finally {
    socket.end()
    child.kill()
    server.close()
    await child.exited
  }
})

test('the pipe copies bytes and does not parse them', async () => {
  const dir = await tempDir()
  const sock = join(dir, 'gw.sock')
  const payload = Buffer.from([0x00, 0x7b, 0xff, 0x01, 0x0a])
  const reply = Buffer.from([0x02, 0x7d, 0x00])
  let accept: (socket: import('node:net').Socket) => void = () => {}
  const connected = new Promise<import('node:net').Socket>(resolve => { accept = resolve })
  const server = createServer(socket => accept(socket))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sock, () => resolve())
  })
  const proc = Bun.spawn(['bun', join(root, 'bin/agent-bus-pipe.ts'), sock], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const socket = await connected
  const received = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    socket.on('data', chunk => {
      chunks.push(Buffer.from(chunk))
      if (Buffer.concat(chunks).length >= payload.length) resolve(Buffer.concat(chunks).subarray(0, payload.length))
    })
    socket.on('error', reject)
  })
  proc.stdin.write(payload)
  expect(await received).toEqual(payload)
  socket.write(reply)
  socket.end()
  const reader = proc.stdout.getReader()
  const out: Uint8Array[] = []
  let got = 0
  while (got < reply.length) {
    const next = await reader.read()
    if (next.done || !next.value) break
    out.push(next.value)
    got += next.value.length
  }
  expect(Buffer.concat(out.map(chunk => Buffer.from(chunk)))).toEqual(reply)
  proc.stdin.end()
  expect(await proc.exited).toBe(0)
  server.close()
})

describe('peer credentials', () => {
  test('linux SO_PEERCRED matches the connecting process', async () => {
    if (process.platform !== 'linux') return
    const dir = await tempDir()
    const sock = join(dir, 's')
    const server = createServer()
    const accepted = new Promise<import('node:net').Socket>(resolve => server.on('connection', resolve))
    await new Promise<void>(resolve => server.listen(sock, () => resolve()))
    const child = Bun.spawn(['bun', '-e', 'import{connect}from"node:net";const s=connect(process.env.SOCK);s.on("data",()=>{})'], {
      env: { ...process.env, SOCK: sock }, stdout: 'ignore', stderr: 'pipe',
    })
    const socket = await accepted
    const info = peerFromLinux((socket as unknown as { _handle: { fd: number } })._handle.fd)
    try {
      expect(info?.pid).toBe(child.pid)
      expect(info?.ppid).toBe(ppidFromStat(readFileSync(`/proc/${child.pid}/stat`, 'utf8')))
      expect(info?.exe).toBe(readlinkSync(`/proc/${child.pid}/exe`))
      expect(verifyPipePeer(info!, new Registry())).toEqual({ ok: false, error: 'peer is not agent-bus-pipe' })
      expect(peerFromLinux(-1)).toBeUndefined()
    } finally {
      socket.end()
      server.close()
      child.kill()
      await child.exited
    }
  })

  test('a mocked macOS peer requires both socket options and the pipe parent', () => {
    const pipeDir = join(tmpdir(), `pipe-darwin-${process.pid}`)
    mkdirSync(pipeDir, { recursive: true })
    const pipeBin = join(pipeDir, 'agent-bus-pipe')
    writeFileSync(pipeBin, '')
    const calls: string[] = []
    const sys = (fail?: 'pid' | 'cred'): DarwinSys => ({
      getsockopt(_fd, level, name, buf) {
        calls.push(`${level}:${name}`)
        if (fail === 'pid' && name === LOCAL_PEERPID) return -1
        if (fail === 'cred' && name === LOCAL_PEERCRED) return -1
        const view = new DataView(buf.buffer, buf.byteOffset, buf.length)
        if (name === LOCAL_PEERPID) view.setUint32(0, 40, true)
        if (name === LOCAL_PEERCRED) view.setUint32(4, 7, true)
        return 0
      },
      pidpath(_pid, buf) {
        const text = new TextEncoder().encode(pipeBin)
        buf.set(text)
        return text.length
      },
      pidinfo(_pid, flavor, buf) {
        expect(flavor).toBe(3)
        const view = new DataView(buf.buffer, buf.byteOffset, buf.length)
        view.setUint32(16, 9, true)
        view.setBigUint64(120, 10n, true)
        view.setBigUint64(128, 4n, true)
        return buf.length
      },
    })
    const peer = peerFromDarwin(3, 7, sys())
    expect(calls).toEqual([`${SOL_LOCAL}:${LOCAL_PEERPID}`, `${SOL_LOCAL}:${LOCAL_PEERCRED}`])
    expect(peer).toEqual({ pid: 40, exe: pipeBin, ppid: 9, started: 'darwin:10.4', parentStarted: 'darwin:10.4' })
    const reg = new Registry()
    reg.add({ host: 'nas642', user: 'mickg', kind: 'codex', conv: 'c', alias: 'codex@nas642', pid: 9, transport: 'codex-queue', started: 'darwin:10.4' })
    expect(verifyPipePeer(peer!, reg).ok).toBe(true)
    if (verifyPipePeer(peer!, reg).ok) expect(verifyPipePeer(peer!, reg)).toMatchObject({ agents: [{ alias: 'codex@nas642', pid: 9 }] })
    reg.add({ host: 'nas642', user: 'mickg', kind: 'codex', conv: 'c', alias: 'codex@nas642', pid: 9, transport: 'codex-queue', started: 'darwin:1.0' })
    expect(verifyPipePeer(peer!, reg)).toEqual({ ok: false, error: 'parent is not a registered agent' })
    expect(peerFromDarwin(3, 8, sys())).toBeUndefined()
    expect(peerFromDarwin(3, 7, sys('pid'))).toBeUndefined()
    expect(peerFromDarwin(3, 7, sys('cred'))).toBeUndefined()
  })
})
