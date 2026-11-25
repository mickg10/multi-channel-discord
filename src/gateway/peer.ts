import type { AgentRec, Registry } from './registry.js'

/** Platform hook. TODO(PR5): SO_PEERCRED / LOCAL_PEERPID. Absent credentials fail closed. */
export type PeerInfo = { pid: number; exe: string; ppid: number }

export type PeerVerdict = { ok: true; agents: AgentRec[] } | { ok: false; error: string }

export function verifyPipePeer(peer: PeerInfo, reg: Registry): PeerVerdict {
  const base = peer.exe.split('/').pop()
  if (base !== 'agent-bus-pipe') return { ok: false, error: 'peer is not agent-bus-pipe' }
  const agents = reg.byPid(peer.ppid)
  if (agents.length === 0) return { ok: false, error: 'parent is not a registered agent' }
  return { ok: true, agents }
}
