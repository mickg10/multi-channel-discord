/**
 * Session manager — routing table, active session, message buffers.
 * Ported from the WhatsApp project.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionEntry, BufferedMessage, WsMessage, ProjectHistoryEntry, ChannelMeta } from './types.js'
import { SessionNotFoundError } from './errors.js'
import { getStateDir } from './access.js'
import { BUS_ALIAS_MAX } from './bus-alias.js'
import type { NameLeases } from './name-leases.js'
import type { WsLike } from './ws.js'

interface SessionSlot {
  readonly name: string
  readonly projectPath: string
  readonly instanceId: string
  readonly host?: string
  readonly swarm: string
  readonly requestedSwarm?: string
  /** The client presented `instanceId` itself. One was made up otherwise, and such a
   *  client takes no part in name leases: it is named exactly as before. */
  readonly identified: boolean
  readonly agent?: string
  readonly conversationId?: string
  readonly connectedAt: number
  messageCount: number
  send: (msg: string) => void
  readonly extraSends: Array<(msg: string) => void>
  readonly sockets: Set<WsLike>
}

export interface SessionIdentity {
  readonly agent?: string
  readonly conversationId?: string
  readonly host?: string
  readonly swarm?: string
  readonly requestedSwarm?: string
  readonly ws?: WsLike
}

export interface SessionSlotInfo {
  readonly name: string
  readonly swarm: string
  readonly requestedSwarm?: string
  readonly host?: string
  readonly instanceId: string
  readonly identified: boolean
}

/** Manages the routing table, active session, message buffers, and unrouted inbox. */
export class SessionManager {
  private sessions = new Map<string, SessionSlot>()
  private active: string | null = null
  private unrouted: BufferedMessage[] = []
  private buffers = new Map<string, BufferedMessage[]>()

  /** With `leases`, a `-N` name follows the instance the router gave it to (see name-leases.ts). */
  constructor(private readonly leases?: NameLeases) {}

  /** Register a session. Returns the actual name (may differ due to collision suffix).
   *  If a session with the same instanceId already exists, adds this send callback
   *  to extraSends (dedup for multiple MCP spawns from the same Claude Code process).
   *  Different Claude Code instances on the same project get separate sessions with collision suffixes.
   *
   *  A plain registration is kept off names leased to other instances. An `exact` one
   *  (a takeover, or reclaiming a name the client was moved off) asks for that name and
   *  is held by nothing but a live session. */
  registerSession(send: (msg: string) => void, name: string, projectPath: string, instanceId?: string, reserved?: (name: string) => boolean, identity?: SessionIdentity, exact = false): string {
    const swarm = identity?.swarm ?? 'default'
    const host = identity?.host
    // Deduplicate: if same (host, instanceId, swarm) is already registered, add send callback to existing.
    // This handles Claude Code spawning multiple MCP plugin processes for one session.
    // Different hosts never share an instance (§2).
    if (instanceId) {
      for (const [existingName, slot] of this.sessions) {
        if (slot.identified && slot.instanceId === instanceId && slot.host === host && slot.swarm === swarm) {
          slot.extraSends.push(send)
          if (identity?.ws) slot.sockets.add(identity.ws)
          this.leases?.touch(existingName, instanceId, host)
          return existingName
        }
      }
    }

    const actualName = this.resolveCollision(name, reserved, undefined, exact ? undefined : instanceId, host)
    const sockets = new Set<WsLike>()
    if (identity?.ws) sockets.add(identity.ws)
    this.sessions.set(actualName, {
      name: actualName,
      projectPath,
      instanceId: instanceId ?? `anon-${Date.now()}`,
      host,
      swarm,
      requestedSwarm: identity?.requestedSwarm,
      identified: !!instanceId,
      agent: identity?.agent,
      conversationId: identity?.conversationId,
      connectedAt: Date.now(),
      messageCount: 0,
      send,
      extraSends: [],
      sockets,
    })
    if (instanceId) this.leases?.touch(actualName, instanceId, host)
    return actualName
  }

  /** Find a live slot by `(host, instanceId)` regardless of swarm. */
  findByInstance(instanceId: string, host?: string): SessionSlotInfo | undefined {
    for (const slot of this.sessions.values()) {
      if (slot.identified && slot.instanceId === instanceId && slot.host === host) {
        return {
          name: slot.name, swarm: slot.swarm, requestedSwarm: slot.requestedSwarm,
          host: slot.host, instanceId: slot.instanceId, identified: slot.identified,
        }
      }
    }
    return undefined
  }

  getSwarm(name: string): string | undefined {
    return this.sessions.get(name)?.swarm
  }

  getAllSlotInfos(): SessionSlotInfo[] {
    return Array.from(this.sessions.values()).map(slot => ({
      name: slot.name, swarm: slot.swarm, requestedSwarm: slot.requestedSwarm,
      host: slot.host, instanceId: slot.instanceId, identified: slot.identified,
    }))
  }

  /** Check whether registering `name` (without takeover) would collide and receive `-N`. */
  wouldCollide(name: string, reserved?: (name: string) => boolean, claimant?: string, host?: string, ignoreLiveName?: string): boolean {
    return (name !== ignoreLiveName && this.sessions.has(name)) ||
      reserved?.(name) === true ||
      this.leases?.heldByAnother(name, claimant, host) === true
  }

  /** Remove a session from the routing table. Also cleans up any extraSends references to this session's send callback. */
  deregisterSession(name: string): void {
    const slot = this.sessions.get(name)
    if (!slot) {
      throw new SessionNotFoundError(name)
    }
    const deadSend = slot.send
    this.sessions.delete(name)
    this.buffers.delete(name)
    // The lease outlives the connection: a client that is coming back (or a router that is
    // restarting) finds its name held, until the lease expires.
    if (slot.identified) this.leases?.touch(name, slot.instanceId, slot.host)
    if (this.active === name) {
      this.active = null
    }
    // Clean up extraSends in other sessions that might reference this session's send callback
    for (const [, otherSlot] of this.sessions) {
      const idx = otherSlot.extraSends.indexOf(deadSend)
      if (idx !== -1) otherSlot.extraSends.splice(idx, 1)
    }
  }

  /** Detach a slot for a same-instance swarm move (§10.3): nulls ws.data on every socket
   *  without closing them, removes the slot, and returns the sibling sockets (excluding `except`). */
  detachSockets(name: string, except?: WsLike): WsLike[] {
    const slot = this.sessions.get(name)
    if (!slot) return []
    const others: WsLike[] = []
    for (const sock of slot.sockets) {
      sock.data.sessionName = null
      sock.data.sendCallback = null
      if (sock !== except) others.push(sock)
    }
    slot.sockets.clear()
    this.sessions.delete(name)
    this.buffers.delete(name)
    if (this.active === name) this.active = null
    return others
  }

  /** Close every socket belonging to `name`, nulling `sessionName` and `sendCallback` first (§10.2),
   *  and deregister the slot. */
  closeSessionSockets(name: string): boolean {
    const slot = this.sessions.get(name)
    if (!slot) return false
    const sockets = [...slot.sockets]
    slot.sockets.clear()
    for (const sock of sockets) {
      sock.data.sessionName = null
      sock.data.sendCallback = null
      try { sock.close?.() } catch {}
    }
    try { this.deregisterSession(name) } catch {}
    return true
  }

  /** Check if a send callback is the primary sender for a session (not an extraSend). */
  isPrimarySender(sessionName: string, send: (msg: string) => void): boolean {
    const slot = this.sessions.get(sessionName)
    return slot?.send === send
  }

  /** Remove a specific send callback (and its socket) from a session. Promotes an extraSend if
   *  the primary disconnected while sibling sockets remain; deregisters only when no sender remains.
   *  Returns true if the session was deregistered. */
  removeSocket(sessionName: string, send: (msg: string) => void, ws?: WsLike): boolean {
    const slot = this.sessions.get(sessionName)
    if (!slot) return false
    if (ws) slot.sockets.delete(ws)
    if (slot.send === send) {
      if (slot.extraSends.length > 0) {
        slot.send = slot.extraSends.shift()!
        return false
      }
      this.deregisterSession(sessionName)
      return true
    }
    const idx = slot.extraSends.indexOf(send)
    if (idx !== -1) slot.extraSends.splice(idx, 1)
    return false
  }

  /** Remove a specific send callback from all sessions' extraSends lists without deregistering the session. */
  cleanupSender(send: (msg: string) => void, ws?: WsLike): void {
    for (const [, slot] of this.sessions) {
      const idx = slot.extraSends.indexOf(send)
      if (idx !== -1) slot.extraSends.splice(idx, 1)
      if (ws) slot.sockets.delete(ws)
    }
  }

  registeredIdentity(name: string): Pick<SessionSlot, 'instanceId' | 'agent' | 'conversationId' | 'host' | 'swarm'> | undefined {
    const slot = this.sessions.get(name)
    return slot && { instanceId: slot.instanceId, agent: slot.agent, conversationId: slot.conversationId, host: slot.host, swarm: slot.swarm }
  }

  isSameInstance(name: string, instanceId?: string, host?: string): boolean {
    const slot = this.sessions.get(name)
    return !!instanceId && !!slot && slot.identified && slot.instanceId === instanceId && (host === undefined || slot.host === host)
  }

  ownsSender(name: string, send: (msg: string) => void): boolean {
    const slot = this.sessions.get(name)
    return !!slot && (slot.send === send || slot.extraSends.includes(send))
  }

  /** Rename a session. Returns the actual new name. */
  renameSession(oldName: string, newName: string, reserved?: (name: string) => boolean, beforeRename?: (actualName: string) => void): string {
    const slot = this.sessions.get(oldName)
    if (!slot) throw new SessionNotFoundError(oldName)

    const actualName = this.resolveCollision(newName, reserved, oldName, undefined, slot.host)
    beforeRename?.(actualName)
    this.sessions.delete(oldName)
    const moved: SessionSlot = { ...slot, name: actualName }
    this.sessions.set(actualName, moved)
    for (const sock of moved.sockets) sock.data.sessionName = actualName
    // the lease follows the session, and leaves the old name with it
    if (moved.identified) this.leases?.touch(actualName, moved.instanceId, moved.host)

    const buf = this.buffers.get(oldName)
    if (buf) {
      this.buffers.delete(oldName)
      this.buffers.set(actualName, buf)
    }

    if (this.active === oldName) {
      this.active = actualName
    }
    return actualName
  }

  /** Set the active session by name. */
  setActive(name: string): void {
    if (!this.sessions.has(name)) throw new SessionNotFoundError(name)
    this.active = name
  }

  getActive(): string | null {
    return this.active
  }

  /** Route a message to the active session. Returns false if queued to unrouted. */
  routeToActive(text: string, meta: ChannelMeta): boolean {
    if (!this.active) {
      this.unrouted.push({ text, timestamp: Date.now(), sessionName: '', meta })
      return false
    }
    const slot = this.sessions.get(this.active)
    if (!slot) {
      this.unrouted.push({ text, timestamp: Date.now(), sessionName: '', meta })
      return false
    }
    const msg: WsMessage = { type: 'message', content: text, meta }
    const json = JSON.stringify(msg)
    // Broadcast to ALL callbacks — Claude Code spawns multiple plugin instances
    // and we don't know which one is the channel handler.
    slot.send(json)
    for (const extra of slot.extraSends) { try { extra(json) } catch {} }
    slot.messageCount++
    return true
  }

  /** Send a raw protocol message (not a channel message) to every connection of a session. */
  notifySession(name: string, json: string): boolean {
    const slot = this.sessions.get(name)
    if (!slot) return false
    try { slot.send(json) } catch {}
    for (const extra of slot.extraSends) { try { extra(json) } catch {} }
    return true
  }

  /** Send a message to a specific session by name. */
  routeToSession(name: string, text: string, meta: ChannelMeta): boolean {
    const slot = this.sessions.get(name)
    if (!slot) return false
    const msg: WsMessage = { type: 'message', content: text, meta }
    const json = JSON.stringify(msg)
    slot.send(json)
    for (const extra of slot.extraSends) { try { extra(json) } catch {} }
    slot.messageCount++
    return true
  }

  getSessions(): readonly SessionEntry[] {
    return Array.from(this.sessions.values()).map((slot) => ({
      name: slot.name,
      projectPath: slot.projectPath,
      connectedAt: slot.connectedAt,
      messageCount: slot.messageCount,
      swarm: slot.swarm,
    }))
  }

  getUnrouted(): readonly BufferedMessage[] {
    return this.unrouted
  }

  drainUnrouted(): BufferedMessage[] {
    const drained = this.unrouted
    this.unrouted = []
    return drained
  }

  /** Buffer a reply from a non-active session. Returns the new buffer count, or 0 if session doesn't exist. */
  bufferReply(sessionName: string, text: string): number {
    if (!this.sessions.has(sessionName)) return 0
    const buf = this.buffers.get(sessionName) ?? []
    buf.push({ text, timestamp: Date.now(), sessionName, meta: {} as ChannelMeta })
    while (buf.length > 500) buf.shift()
    this.buffers.set(sessionName, buf)
    return buf.length
  }

  flushBuffer(sessionName: string): BufferedMessage[] {
    const buf = this.buffers.get(sessionName) ?? []
    this.buffers.delete(sessionName)
    return buf
  }

  getBufferedCount(sessionName: string): number {
    return this.buffers.get(sessionName)?.length ?? 0
  }

  getAllBuffers(): ReadonlyMap<string, readonly BufferedMessage[]> {
    return this.buffers
  }

  setAllBuffers(buffers: Map<string, BufferedMessage[]>): void {
    this.buffers = buffers
  }

  async saveBuffers(stateDir?: string): Promise<void> {
    const dir = getStateDir(stateDir)
    await mkdir(dir, { recursive: true })
    const data = { buffers: Object.fromEntries(this.buffers), unrouted: this.unrouted }
    await writeFile(join(dir, 'buffers.json'), JSON.stringify(data, null, 2))
  }

  async loadBuffers(stateDir?: string): Promise<void> {
    const dir = getStateDir(stateDir)
    try {
      const content = await readFile(join(dir, 'buffers.json'), 'utf-8')
      const data = JSON.parse(content) as { buffers?: Record<string, BufferedMessage[]>; unrouted?: BufferedMessage[] }
      if (data.buffers) this.buffers = new Map(Object.entries(data.buffers))
      if (Array.isArray(data.unrouted)) this.unrouted = data.unrouted
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
  }

  /** Mark every connected instance as seen, so that its lease lasts as long as it stays connected. */
  refreshLeases(): void {
    this.leases?.touchAll(
      [...this.sessions].flatMap(([name, slot]) => slot.identified ? [[name, slot.instanceId, slot.host] as const] : []),
    )
  }

  private resolveCollision(name: string, reserved?: (name: string) => boolean, previous?: string, claimant?: string, host?: string): string {
    const inUse = (candidate: string) =>
      (candidate !== previous && this.sessions.has(candidate)) || reserved?.(candidate) ||
      this.leases?.heldByAnother(candidate, claimant, host) === true
    if (!inUse(name)) return name
    let suffix = 2
    let candidate: string
    do {
      const ending = `-${suffix++}`
      candidate = name.slice(0, BUS_ALIAS_MAX - ending.length) + ending
    } while (inUse(candidate))
    return candidate
  }
}

const PROJECTS_FILE = 'projects.json'
const MAX_HISTORY_ENTRIES = 100

/** Tracks which projects have connected, persisted to disk. */
export class ProjectHistory {
  private entries: ProjectHistoryEntry[] = []
  private readonly dir: string
  private readonly maxEntries: number

  constructor(stateDir?: string, maxEntries = MAX_HISTORY_ENTRIES) {
    this.dir = getStateDir(stateDir)
    this.maxEntries = maxEntries
  }

  record(name: string, path: string): void {
    const idx = this.entries.findIndex((e) => e.path === path)
    if (idx !== -1) this.entries.splice(idx, 1)
    this.entries.push({ name, path, lastUsed: Date.now() })
    while (this.entries.length > this.maxEntries) this.entries.shift()
  }

  getRecent(limit?: number): readonly ProjectHistoryEntry[] {
    const sorted = [...this.entries].reverse().sort((a, b) => b.lastUsed - a.lastUsed)
    return limit !== undefined ? sorted.slice(0, limit) : sorted
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(join(this.dir, PROJECTS_FILE), 'utf-8')
      this.entries = JSON.parse(content) as ProjectHistoryEntry[]
    } catch {}
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, PROJECTS_FILE), JSON.stringify(this.entries, null, 2))
  }
}

/** Format buffered messages for consolidated flush delivery. */
export function formatFlush(sessionName: string, messages: readonly BufferedMessage[]): string {
  if (messages.length === 0) return ''
  const lines = messages.map((m) => {
    const time = new Date(m.timestamp)
    const hh = String(time.getHours()).padStart(2, '0')
    const mm = String(time.getMinutes()).padStart(2, '0')
    return `${hh}:${mm} — ${m.text}`
  })
  return `[${sessionName}] 📬 Buffered messages:\n\n${lines.join('\n')}`
}
