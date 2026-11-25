import { realpathSync } from 'node:fs'
import type { AgentRec, Registry } from './registry.js'

/** OS identity from readPeer. Absent credentials fail closed. */
export type PeerInfo = {
  pid: number
  exe: string
  ppid: number
  /** Start time of the connecting process. */
  started: string
  /** Start time of its parent, compared with AgentRec.started. */
  parentStarted: string
}

export type PeerVerdict = { ok: true; agents: AgentRec[] } | { ok: false; error: string }

export function verifyPipePeer(peer: PeerInfo, reg: Registry, pipePath?: string): PeerVerdict {
  if (!pipePath) return { ok: false, error: 'peer is not agent-bus-pipe' }
  let resolved: string
  let expected: string
  try {
    resolved = realpathSync(peer.exe)
    expected = realpathSync(pipePath)
  } catch {
    return { ok: false, error: 'peer is not agent-bus-pipe' }
  }
  if (resolved !== expected) return { ok: false, error: 'peer is not agent-bus-pipe' }
  const agents = reg.byPid(peer.ppid).filter(agent => agent.started === peer.parentStarted)
  if (agents.length === 0) return { ok: false, error: 'parent is not a registered agent' }
  return { ok: true, agents }
}
