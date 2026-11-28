import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { NameLeases } from '../name-leases.js'
import { ProjectHistory, SessionManager } from '../sessions.js'
import { createWsHandlers, type WsData, type WsDeps, type WsLike } from '../ws.js'

/** The plugin's own name for a seat of this project: `<agent>@<host>:<directory>`. */
const BASE = `agy@nas642:${basename(process.cwd())}`

/** A router: the session table over the leases in `stateDir`, on a WebSocket fixture. A second
 *  one on the same port and directory is that router after a restart. */
function harness(stateDir: string, port = 0) {
  const sessions = new SessionManager(NameLeases.inStateDir(stateDir))
  const deps: WsDeps = {
    sessions, history: new ProjectHistory(stateDir), client: {} as WsDeps['client'], busChannelId: 'bus',
    chatId: () => null, chunkLimit: 2000, chunkMode: 'length', replyToMode: 'first',
  }
  const handlers = createWsHandlers(deps)
  const registrations: Array<{ name: string; instanceId?: string; takeover?: boolean }> = []
  const fixture = Bun.serve<WsData>({
    hostname: '127.0.0.1', port,
    fetch(request, server) {
      if (server.upgrade(request, { data: { sessionName: null, sendCallback: null } })) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        handlers.message(ws, raw)
        const frame = JSON.parse(String(raw))
        if (frame.type === 'register') registrations.push({ name: frame.name, instanceId: frame.instanceId, takeover: frame.takeover })
      },
      close(ws) { handlers.close(ws) },
    },
  })
  const listening = fixture.port
  if (listening === undefined) {
    fixture.stop(true)
    throw new Error('the router fixture did not get a port')
  }
  return { sessions, handlers, registrations, port: listening, stop: () => fixture.stop(true) }
}
type Harness = ReturnType<typeof harness>

/** One seat of the project: the real plugin, spawned over stdio with this instance id.
 *  A generated name and push mode, as seats sharing a directory have: a collision name is
 *  only ever given to a plain registration. In pull mode, or with a configured name, a
 *  second seat takes the name over instead (#25). */
async function seat(stateDir: string, instanceId: string, port: number, clients: Client[]): Promise<Client> {
  const client = new Client({ name: 'assigned-name-fixture', version: '1' })
  clients.push(client)
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, '..', 'plugin.ts')],
    stderr: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: stateDir,
      DISCORD_AGENT: 'agy',
      DISCORD_HOST_LABEL: 'nas642',
      DISCORD_INSTANCE_ID: instanceId,
      DISCORD_PARENT_PID: String(process.pid),
      DISCORD_STATE_DIR: stateDir,
      DISCORD_ROUTER_URL: `ws://127.0.0.1:${port}`,
    },
  }))
  return client
}

const key = (instanceId: string) => createHash('sha256').update(instanceId).digest('hex')
const assigned = (stateDir: string, instanceId: string) => join(stateDir, 'assigned-aliases', key(instanceId))
const explicit = (stateDir: string, instanceId: string) => join(stateDir, 'bus-aliases', key(instanceId))

/** The instance registered under `name`, once the router has it. */
async function settles(r: Harness, instanceId: string): Promise<string> {
  await waitFor(() => r.sessions.getSessions().some(s => r.sessions.registeredIdentity(s.name)?.instanceId === instanceId))
  return r.sessions.getSessions().find(s => r.sessions.registeredIdentity(s.name)?.instanceId === instanceId)!.name
}

test('the plugin asks again for the -N name the router assigned it, and bus_rename replaces it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'assigned-name-'))
  const r = harness(stateDir)
  const clients: Client[] = []
  const holds = (name: string, instanceId: string) => r.sessions.registeredIdentity(name)?.instanceId === instanceId
  const last = () => r.registrations.at(-1)!
  const newest = () => clients.at(-1)!
  const gone = (name: string) => waitFor(() => !r.sessions.registeredIdentity(name))

  try {
    await seat(stateDir, 'seat-a', r.port, clients)
    expect(await settles(r, 'seat-a')).toBe(BASE)
    expect(last()).toMatchObject({ name: BASE, instanceId: 'seat-a' })
    expect(existsSync(assigned(stateDir, 'seat-a'))).toBe(false)              // named as it asked: nothing to remember

    await seat(stateDir, 'seat-b', r.port, clients)
    expect(await settles(r, 'seat-b')).toBe(`${BASE}-2`)
    expect(last()).toMatchObject({ name: BASE, instanceId: 'seat-b' })         // the same request as seat a
    expect(readFileSync(assigned(stateDir, 'seat-b'), 'utf8')).toBe(`${BASE}-2`)  // the collision name is kept for this instance
    expect(existsSync(explicit(stateDir, 'seat-b'))).toBe(false)               // and is not an explicit alias

    await newest().close()
    await gone(`${BASE}-2`)
    await seat(stateDir, 'seat-b', r.port, clients)                            // the plugin restarts, the same instance
    expect(await settles(r, 'seat-b')).toBe(`${BASE}-2`)
    expect(last()).toMatchObject({ name: `${BASE}-2`, instanceId: 'seat-b', takeover: false })  // asks for it by name

    // somebody else has that name when the seat returns: the router gives another, and that is kept instead
    await newest().close()
    await gone(`${BASE}-2`)
    const squatter: WsLike = { data: { sessionName: null, sendCallback: null }, send() {} }
    r.handlers.message(squatter, JSON.stringify({
      type: 'register', name: `${BASE}-2`, projectPath: '/', agent: 'agy', instanceId: 'squatter', takeover: true,
    }))
    expect(r.sessions.isSameInstance(`${BASE}-2`, 'squatter')).toBe(true)
    await seat(stateDir, 'seat-b', r.port, clients)
    expect(await settles(r, 'seat-b')).toBe(`${BASE}-2-2`)
    expect(last()).toMatchObject({ name: `${BASE}-2`, takeover: false })       // it asked for what it had saved
    expect(readFileSync(assigned(stateDir, 'seat-b'), 'utf8')).toBe(`${BASE}-2-2`)  // and keeps what it was given
    r.handlers.close(squatter)

    // (c) bus_rename overrides the assigned name
    const renamed = await newest().callTool({ name: 'bus_rename', arguments: { name: 'cfd-injection-fast' } })
    expect(renamed.content).toEqual([{ type: 'text', text: 'cfd-injection-fast' }])
    expect(existsSync(assigned(stateDir, 'seat-b'))).toBe(false)
    expect(readFileSync(explicit(stateDir, 'seat-b'), 'utf8')).toBe('cfd-injection-fast')
    await newest().close()
    await gone('cfd-injection-fast')
    await seat(stateDir, 'seat-b', r.port, clients)
    expect(await settles(r, 'seat-b')).toBe('cfd-injection-fast')
    expect(last()).toMatchObject({ name: 'cfd-injection-fast', instanceId: 'seat-b', takeover: false })
    expect(holds('cfd-injection-fast', 'seat-b')).toBe(true)

    // an explicit alias wins over an assigned name saved for the same instance
    writeFileSync(explicit(stateDir, 'seat-c'), 'explicit-name')
    writeFileSync(assigned(stateDir, 'seat-c'), `${BASE}-9`)
    await seat(stateDir, 'seat-c', r.port, clients)
    expect(await settles(r, 'seat-c')).toBe('explicit-name')
    expect(last()).toMatchObject({ name: 'explicit-name', instanceId: 'seat-c', takeover: false })
    expect(existsSync(assigned(stateDir, 'seat-c'))).toBe(false)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await r.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
}, 30_000)

test('(a) end to end: three seats of one project, the router restarts, they return in reverse: each keeps its name', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'assigned-name-'))
  let r = harness(stateDir)
  const clients: Client[] = []
  const held: Record<string, string> = {}
  const start = async (instanceId: string) => { held[instanceId] = await settles(r, instanceId) }

  try {
    for (const instanceId of ['seat-a', 'seat-b', 'seat-c']) {
      await seat(stateDir, instanceId, r.port, clients)
      await start(instanceId)
    }
    expect(Object.values(held)).toEqual([BASE, `${BASE}-2`, `${BASE}-3`])

    for (const wiped of [false, true]) {
      // every seat goes away first, so that the order they return in is this test's to choose
      for (const client of clients.splice(0)) await client.close()
      await waitFor(() => r.sessions.getSessions().length === 0)
      await r.stop()
      // the second time round the plugins remember nothing: only the router's leases are left
      if (wiped) rmSync(join(stateDir, 'assigned-aliases'), { recursive: true, force: true })
      r = harness(stateDir, r.port)                                            // same port, an empty table, the leases on disk
      for (const instanceId of ['seat-c', 'seat-b', 'seat-a']) {
        await seat(stateDir, instanceId, r.port, clients)
        await start(instanceId)
      }
      expect(held).toEqual({ 'seat-a': BASE, 'seat-b': `${BASE}-2`, 'seat-c': `${BASE}-3` })   // whatever came back first
    }
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await r.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
}, 40_000)

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the plugin')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
