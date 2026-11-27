import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const AGENT_CHANNEL_DELAY_MS = 60_000
export const AGENT_CHANNEL_IDLE_MS = 7 * 24 * 60 * 60_000
const SWEEP_MS = 24 * 60 * 60_000
const MAX_AGENT_CHANNELS = 100

export interface AgentChannelRegistration {
  name: string
  kind?: string
  host?: string
}

export interface AgentChannelOps {
  ensure(info: AgentChannelRegistration): Promise<string>
  update(id: string, info: AgentChannelRegistration, archived: boolean): Promise<void>
}

interface ChannelState extends AgentChannelRegistration {
  lastSeen: number
  archived: boolean
  appliedName: string
  appliedTopic?: string
}

interface Candidate {
  info: AgentChannelRegistration
  since: number
}

export function agentChannelSlug(owner: string, collision = false): string {
  const slug = owner.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const suffix = createHash('sha256').update(owner).digest('hex').slice(0, 12)
  if (collision || !slug) return `a-${slug ? slug.slice(0, 77) + '-' : ''}${suffix}`
  return 'a-' + slug.slice(0, 90)
}

export function agentChannelTopic(info: AgentChannelRegistration): string {
  const label = (value?: string) => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,62}$/i.test(value) ? value : 'unknown'
  return `Direct line to ${info.name} (${label(info.kind)}, ${label(info.host)})`
}

export class AgentChannels {
  private readonly bindings = new Map<string, string>()
  private readonly states = new Map<string, ChannelState>()
  private readonly candidates = new Map<string, Candidate>()
  private readonly ownersFile?: string
  private readonly stateFile?: string
  private nextSweep = 0
  private busy = false

  constructor(stateDir?: string, now = Date.now(), private readonly configuredOwners?: ReadonlyMap<string, string>) {
    if (!stateDir) return
    this.ownersFile = join(stateDir, 'agent-channels.json')
    this.stateFile = join(stateDir, 'agent-channel-activity.json')
    const states = this.read<ChannelState>(this.stateFile)
    for (const [id, owner] of Object.entries(this.read<string>(this.ownersFile))) {
      if (typeof owner !== 'string') continue
      this.bindings.set(id, owner)
      // An owner map without metadata should age from the time it was loaded.
      const saved: ChannelState | undefined = states[id]
      this.states.set(id, saved ? { ...saved, name: owner } : { name: owner, lastSeen: now, archived: false, appliedName: owner })
    }
  }

  private read<T>(file: string): Record<string, T> {
    try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, T> } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return {}
    }
  }

  private save(path: string | undefined, map: ReadonlyMap<string, unknown>): void {
    if (!path) return
    mkdirSync(dirname(path), { recursive: true })
    const temp = path + '.tmp'
    writeFileSync(temp, JSON.stringify(Object.fromEntries(map), null, 2), { mode: 0o600 })
    renameSync(temp, path)
  }

  owner(id: string): string | undefined { return this.bindings.get(id) }

  private channelFor(name: string): string | undefined {
    for (const [id, owner] of this.bindings) if (owner === name) return id
    return undefined
  }

  register(info: AgentChannelRegistration, now = Date.now()): void {
    const id = this.channelFor(info.name)
    if (id) {
      const state = this.states.get(id)!
      this.states.set(id, { ...state, kind: info.kind ?? state.kind, host: info.host ?? state.host, lastSeen: now })
      this.save(this.stateFile, this.states)
      return
    }
    const previous = this.candidates.get(info.name)
    if (previous) previous.info = info
    else this.candidates.set(info.name, { info, since: now })
  }

  disconnect(name: string, now = Date.now()): void {
    this.candidates.delete(name)
    const id = this.channelFor(name)
    if (id) {
      this.states.get(id)!.lastSeen = now
      this.save(this.stateFile, this.states)
    }
  }

  rename(oldName: string, newName: string, now = Date.now(), newCandidateEligible = true): void {
    if (oldName === newName) return
    const candidate = this.candidates.get(oldName)
    this.candidates.delete(oldName)
    if (candidate) {
      candidate.info = { ...candidate.info, name: newName }
      if (newCandidateEligible) this.candidates.set(newName, candidate)
    }
    const id = this.channelFor(oldName)
    if (!id) return
    if (this.channelFor(newName)) {
      process.stderr.write(`agent channels: kept ${id} for ${oldName}; ${newName} already has a direct channel\n`)
      return
    }
    const bindings = new Map(this.bindings).set(id, newName)
    this.save(this.ownersFile, bindings)
    this.bindings.set(id, newName)
    const state = this.states.get(id)!
    this.states.set(id, { ...state, name: newName, lastSeen: now })
    this.save(this.stateFile, this.states)
  }

  async maintain(ops: AgentChannelOps, isOnline: (name: string) => boolean, now = Date.now()): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const sweep = now >= this.nextSweep
      if (sweep) this.nextSweep = now + SWEEP_MS
      for (const [id, state] of this.states) {
        if (this.configuredOwners?.has(id)) continue
        const owner = this.bindings.get(id)!
        const online = isOnline(owner)
        if (online && sweep) {
          state.lastSeen = now
          this.save(this.stateFile, this.states)
        }
        const shouldArchive = sweep && !online && now - state.lastSeen >= AGENT_CHANNEL_IDLE_MS
        const archived = !online && (state.archived || shouldArchive)
        const info = { ...state, name: owner }
        const topic = agentChannelTopic(info)
        if (state.appliedName === owner && state.appliedTopic === topic && state.archived === archived) continue
        try {
          await ops.update(id, info, archived)
          const current = this.states.get(id)!
          this.states.set(id, { ...current, archived, appliedName: owner, appliedTopic: topic })
          this.save(this.stateFile, this.states)
        } catch {
          process.stderr.write(`agent channels: could not update channel ${id}\n`)
        }
      }
      for (const [name, candidate] of this.candidates) {
        if (!isOnline(name) || this.channelFor(name)) { this.candidates.delete(name); continue }
        if (now - candidate.since < AGENT_CHANNEL_DELAY_MS || this.bindings.size >= MAX_AGENT_CHANNELS) continue
        const info = candidate.info
        try {
          const id = await ops.ensure(info)
          if (this.bindings.has(id)) continue
          const currentName = candidate.info.name
          const owner = this.channelFor(currentName) ? info.name : currentName
          const bindings = new Map(this.bindings).set(id, owner)
          this.save(this.ownersFile, bindings)
          this.bindings.set(id, owner)
          this.states.set(id, { ...candidate.info, name: owner, lastSeen: now, archived: false, appliedName: info.name, appliedTopic: agentChannelTopic(info) })
          this.save(this.stateFile, this.states)
          this.candidates.delete(name)
          this.candidates.delete(currentName)
        } catch {
          process.stderr.write(`agent channels: could not provision direct channel for ${name}\n`)
        }
      }
    } finally {
      this.busy = false
    }
  }
}
