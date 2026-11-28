/**
 * Multi-swarm configuration: `${STATE_DIR}/swarms-config.json`.
 *
 * Modes:
 * - Absent (ENOENT): `configured = false`; everything normalises to `default` (byte-for-byte back-compat).
 * - Valid file: `configured = true`; configured swarms, candidates, crossSwarm, defaultSessions, retired.
 * - Malformed at cold start: configured-empty mode (`configured = true`, no swarms); non-default registers
 *   are rejected with `unknown_swarm`, default sessions continue to work.
 * - Malformed on reload: last good config is kept.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isBusAlias } from './bus-alias.js'

export const DEFAULT_SWARM = 'default'
export const RESERVED_SWARM_IDS: ReadonlySet<string> = new Set(['default', 'agents', 'archive', 'all', 'human'])
const SWARM_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
const ALL_NUMERIC_RE = /^\d+$/

export function isValidSwarmId(id: unknown): id is string {
  return typeof id === 'string' && SWARM_ID_RE.test(id) && !RESERVED_SWARM_IDS.has(id) && !ALL_NUMERIC_RE.test(id)
}

export interface SwarmCandidate {
  readonly alias: string
  readonly priority: number
}

export interface SwarmEntry {
  readonly candidates: readonly SwarmCandidate[]
}

export interface SwarmConfigData {
  readonly configured: boolean
  readonly swarms: ReadonlyMap<string, SwarmEntry>
  readonly defaultCandidates: readonly SwarmCandidate[]
  readonly crossSwarm: ReadonlySet<string>
  readonly defaultSessions: ReadonlySet<string>
  readonly retired: ReadonlySet<string>
  /** Exact alias -> candidate swarm ('default' or swarm id). */
  readonly candidateToSwarm: ReadonlyMap<string, string>
}

export interface SwarmConfigDiff {
  readonly prev: SwarmConfigData
  readonly next: SwarmConfigData
  readonly addedSwarms: readonly string[]
  readonly removedSwarms: readonly string[]
  readonly addedRetired: readonly string[]
  /** Aliases that were candidates in `prev` and either removed or moved to another swarm in `next`. */
  readonly leftCandidates: ReadonlySet<string>
  /** Aliases that were in `prev.crossSwarm` and are not in `next.crossSwarm`. */
  readonly leftCrossSwarm: ReadonlySet<string>
}

function emptyData(configured: boolean): SwarmConfigData {
  return {
    configured,
    swarms: new Map(),
    defaultCandidates: [],
    crossSwarm: new Set(),
    defaultSessions: new Set(['agents']),
    retired: new Set(),
    candidateToSwarm: new Map(),
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseCandidates(raw: unknown, label: string): SwarmCandidate[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error(`${label}.candidates must be an array`)
  const out: SwarmCandidate[] = []
  for (const item of raw) {
    if (!isPlainObject(item) || !isBusAlias(item.alias) || typeof item.priority !== 'number' || !Number.isFinite(item.priority)) {
      throw new Error(`invalid candidate in ${label}`)
    }
    out.push({ alias: item.alias, priority: item.priority })
  }
  return out
}

/** Parse and validate raw JSON object into SwarmConfigData. Throws on any validation violation. */
export function parseSwarmConfig(raw: unknown): SwarmConfigData {
  if (!isPlainObject(raw)) throw new Error('swarms-config must be a JSON object')

  const swarms = new Map<string, SwarmEntry>()
  const candidateToSwarm = new Map<string, string>()
  const seenCandidateLower = new Map<string, string>()

  const registerCandidates = (swarmId: string, list: readonly SwarmCandidate[]) => {
    for (const c of list) {
      const low = c.alias.toLowerCase()
      if (seenCandidateLower.has(low)) {
        throw new Error(`duplicate candidate alias "${c.alias}" across swarms`)
      }
      seenCandidateLower.set(low, swarmId)
      candidateToSwarm.set(c.alias, swarmId)
    }
  }

  // default section (candidates only)
  let defaultCandidates: SwarmCandidate[] = []
  if (raw.default !== undefined) {
    if (!isPlainObject(raw.default)) throw new Error('default must be an object')
    for (const key of Object.keys(raw.default)) {
      if (key !== 'candidates') throw new Error(`default may only contain "candidates", got "${key}"`)
    }
    defaultCandidates = parseCandidates(raw.default.candidates, 'default')
    registerCandidates(DEFAULT_SWARM, defaultCandidates)
  }

  // swarms section
  if (raw.swarms !== undefined) {
    if (!isPlainObject(raw.swarms)) throw new Error('swarms must be an object')
    for (const [id, entry] of Object.entries(raw.swarms)) {
      if (!isValidSwarmId(id)) throw new Error(`invalid or reserved swarm id "${id}"`)
      if (!isPlainObject(entry)) throw new Error(`swarms.${id} must be an object`)
      const candidates = parseCandidates(entry.candidates, `swarms.${id}`)
      registerCandidates(id, candidates)
      swarms.set(id, { candidates })
    }
  }

  // retired section
  const retired = new Set<string>()
  if (raw.retired !== undefined) {
    if (!Array.isArray(raw.retired)) throw new Error('retired must be an array')
    for (const id of raw.retired) {
      if (!isValidSwarmId(id)) throw new Error(`invalid retired swarm id "${String(id)}"`)
      if (swarms.has(id)) throw new Error(`swarm id "${id}" cannot be in both swarms and retired`)
      retired.add(id)
    }
  }

  // crossSwarm section
  const crossSwarm = new Set<string>()
  if (raw.crossSwarm !== undefined) {
    if (!Array.isArray(raw.crossSwarm)) throw new Error('crossSwarm must be an array')
    for (const alias of raw.crossSwarm) {
      if (!isBusAlias(alias)) throw new Error(`invalid crossSwarm alias "${String(alias)}"`)
      const candSwarm = seenCandidateLower.get(alias.toLowerCase())
      if (candSwarm !== undefined && candSwarm !== DEFAULT_SWARM) {
        throw new Error(`crossSwarm alias "${alias}" cannot be a candidate of non-default swarm "${candSwarm}"`)
      }
      crossSwarm.add(alias)
    }
  }

  // defaultSessions section (always includes 'agents')
  const defaultSessions = new Set<string>(['agents'])
  if (raw.defaultSessions !== undefined) {
    if (!Array.isArray(raw.defaultSessions)) throw new Error('defaultSessions must be an array')
    for (const s of raw.defaultSessions) {
      if (typeof s !== 'string' || !s.trim()) throw new Error('defaultSessions entries must be non-empty strings')
      const trimmed = s.trim()
      if (swarms.has(trimmed)) {
        throw new Error(`defaultSessions entry "${trimmed}" cannot also be a configured swarm id`)
      }
      defaultSessions.add(trimmed)
    }
  }

  return {
    configured: true,
    swarms,
    defaultCandidates,
    crossSwarm,
    defaultSessions,
    retired,
    candidateToSwarm,
  }
}

function diffConfigs(prev: SwarmConfigData, next: SwarmConfigData): SwarmConfigDiff {
  const addedSwarms = [...next.swarms.keys()].filter(id => !prev.swarms.has(id))
  const removedSwarms = [...prev.swarms.keys()].filter(id => !next.swarms.has(id))
  const addedRetired = [...next.retired].filter(id => !prev.retired.has(id))
  const leftCandidates = new Set<string>()
  for (const [alias, prevSwarm] of prev.candidateToSwarm) {
    if (next.candidateToSwarm.get(alias) !== prevSwarm) leftCandidates.add(alias)
  }
  const leftCrossSwarm = new Set<string>()
  for (const alias of prev.crossSwarm) {
    if (!next.crossSwarm.has(alias)) leftCrossSwarm.add(alias)
  }
  return { prev, next, addedSwarms, removedSwarms, addedRetired, leftCandidates, leftCrossSwarm }
}

function sameSnapshot(a: SwarmConfigData, b: SwarmConfigData): boolean {
  if (a.configured !== b.configured) return false
  if (a.swarms.size !== b.swarms.size || a.retired.size !== b.retired.size ||
      a.crossSwarm.size !== b.crossSwarm.size || a.defaultSessions.size !== b.defaultSessions.size ||
      a.candidateToSwarm.size !== b.candidateToSwarm.size) return false
  for (const id of a.swarms.keys()) {
    const ae = a.swarms.get(id)!
    const be = b.swarms.get(id)
    if (!be || ae.candidates.length !== be.candidates.length) return false
    for (let i = 0; i < ae.candidates.length; i++) {
      if (ae.candidates[i]!.alias !== be.candidates[i]!.alias || ae.candidates[i]!.priority !== be.candidates[i]!.priority) return false
    }
  }
  if (a.defaultCandidates.length !== b.defaultCandidates.length) return false
  for (let i = 0; i < a.defaultCandidates.length; i++) {
    if (a.defaultCandidates[i]!.alias !== b.defaultCandidates[i]!.alias || a.defaultCandidates[i]!.priority !== b.defaultCandidates[i]!.priority) return false
  }
  for (const x of a.retired) if (!b.retired.has(x)) return false
  for (const x of a.crossSwarm) if (!b.crossSwarm.has(x)) return false
  for (const x of a.defaultSessions) if (!b.defaultSessions.has(x)) return false
  return true
}

export class SwarmConfig {
  private data: SwarmConfigData
  private lastStat: { mtimeMs: number; size: number } | null = null

  constructor(private readonly file?: string, initial?: SwarmConfigData) {
    if (initial) {
      this.data = initial
      return
    }
    this.data = emptyData(false)
    if (file) this.loadColdStart(file)
  }

  static inStateDir(stateDir: string): SwarmConfig {
    return new SwarmConfig(join(stateDir, 'swarms-config.json'))
  }

  /** Construct an in-memory SwarmConfig from a raw JSON object (for tests). */
  static fromObject(raw: unknown): SwarmConfig {
    return new SwarmConfig(undefined, parseSwarmConfig(raw))
  }

  /** Construct an in-memory absent (no-config) SwarmConfig. */
  static absent(): SwarmConfig {
    return new SwarmConfig(undefined, emptyData(false))
  }

  /** Construct an in-memory configured-empty SwarmConfig (cold-start malformed mode). */
  static configuredEmpty(): SwarmConfig {
    return new SwarmConfig(undefined, emptyData(true))
  }

  private loadColdStart(file: string): void {
    try {
      const st = statSync(file)
      this.lastStat = { mtimeMs: st.mtimeMs, size: st.size }
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      this.data = parseSwarmConfig(raw)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.lastStat = null
        this.data = emptyData(false)
        return
      }
      // Malformed at cold start -> configured-empty mode (§1)
      process.stderr.write(`discord channel: swarms-config.json malformed at cold start, running in configured-empty mode: ${err instanceof Error ? err.message : String(err)}\n`)
      this.data = emptyData(true)
    }
  }

  /** Check file mtime+size and reload if changed. Keeps last good config on malformed file.
   *  Returns a diff if the effective config changed, otherwise null. */
  reload(): SwarmConfigDiff | null {
    if (!this.file) return null
    let st: { mtimeMs: number; size: number }
    try {
      const s = statSync(this.file)
      st = { mtimeMs: s.mtimeMs, size: s.size }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        if (this.lastStat === null && !this.data.configured) return null
        this.lastStat = null
        const prev = this.data
        const next = emptyData(false)
        this.data = next
        return sameSnapshot(prev, next) ? null : diffConfigs(prev, next)
      }
      return null
    }

    if (this.lastStat && this.lastStat.mtimeMs === st.mtimeMs && this.lastStat.size === st.size) {
      return null
    }
    this.lastStat = st

    let next: SwarmConfigData
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      next = parseSwarmConfig(raw)
    } catch (err: unknown) {
      // Malformed on reload -> keep last good config (§1)
      process.stderr.write(`discord channel: swarms-config.json malformed on reload, keeping last good config: ${err instanceof Error ? err.message : String(err)}\n`)
      return null
    }

    const prev = this.data
    this.data = next
    return sameSnapshot(prev, next) ? null : diffConfigs(prev, next)
  }

  /** Poll the config file every `intervalMs` (default 5000 ms) on mtime+size. Returns stop function. */
  startWatching(onChange: (diff: SwarmConfigDiff) => void, intervalMs = 5_000): () => void {
    const timer = setInterval(() => {
      const diff = this.reload()
      if (diff) onChange(diff)
    }, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }

  snapshot(): SwarmConfigData {
    return this.data
  }

  isConfigured(): boolean {
    return this.data.configured
  }

  swarmIds(): string[] {
    return [...this.data.swarms.keys()]
  }

  hasSwarm(id: string): boolean {
    return this.data.swarms.has(id)
  }

  isRetired(id: string): boolean {
    return this.data.retired.has(id)
  }

  retiredIds(): string[] {
    return [...this.data.retired]
  }

  getDefaultSessions(): string[] {
    return [...this.data.defaultSessions]
  }

  /** Exact-form crossSwarm check (§10.5: -N forms carry no rights). */
  isCrossSwarm(alias: string): boolean {
    return this.data.crossSwarm.has(alias)
  }

  /** Exact-form candidate swarm lookup ('default' or swarm id), or undefined. */
  candidateSwarm(alias: string): string | undefined {
    return this.data.candidateToSwarm.get(alias)
  }

  /** Exact-form candidate check, optionally restricted to a specific swarm. */
  isCandidate(alias: string, swarm?: string): boolean {
    const s = this.data.candidateToSwarm.get(alias)
    return s !== undefined && (swarm === undefined || s === swarm)
  }

  candidatesFor(swarm: string): readonly SwarmCandidate[] {
    if (swarm === DEFAULT_SWARM) return this.data.defaultCandidates
    return this.data.swarms.get(swarm)?.candidates ?? []
  }

  /** All crossSwarm + candidate aliases (for protectedRenameAlias). */
  allProtectedAliases(): string[] {
    return [...this.data.crossSwarm, ...this.data.candidateToSwarm.keys()]
  }

  /** All candidate aliases across default and all swarms (for observeDirectChannel exclusion). */
  allCandidateAliases(): string[] {
    return [...this.data.candidateToSwarm.keys()]
  }

  /** True if `alias` is an exact crossSwarm or candidate alias (§10.5). */
  isExactProtectedAlias(alias: string): boolean {
    return this.data.crossSwarm.has(alias) || this.data.candidateToSwarm.has(alias)
  }

  /** Normalise a raw swarm / tmux session name according to §1, §2, §10.1. */
  normalizeSwarm(raw?: string): { ok: true; swarm: string } | { ok: false; error: 'unknown_swarm' } {
    if (!this.data.configured) return { ok: true, swarm: DEFAULT_SWARM }
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (!trimmed || trimmed === DEFAULT_SWARM || this.data.defaultSessions.has(trimmed) || ALL_NUMERIC_RE.test(trimmed)) {
      return { ok: true, swarm: DEFAULT_SWARM }
    }
    if (this.data.swarms.has(trimmed)) {
      return { ok: true, swarm: trimmed }
    }
    return { ok: false, error: 'unknown_swarm' }
  }
}
