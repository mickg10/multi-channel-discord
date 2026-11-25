import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Kind, Transport, WakeResult } from './types.js'

export type AttemptState = 'pending' | 'uncertain' | 'woken' | 'held' | 'refused' | 'unavailable'

export type Attempt = {
  msgId: string
  conv: string
  kind: Kind
  host: string
  user: string
  alias: string
  /** Router wake `n`. The nudge text is rebuilt from this, never stored. */
  n: number
  transport: Transport
  state: AttemptState
  nativeId?: string
  /** Set only after the router acks wakeResult. Unset means the result must be sent again. */
  reported?: boolean
}

const OPEN: ReadonlySet<AttemptState> = new Set(['pending', 'uncertain', 'woken', 'held', 'refused'])
const STATES: ReadonlySet<string> = new Set(['pending', 'uncertain', 'woken', 'held', 'refused', 'unavailable'])
const KINDS: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode', 'grok', 'agy'])
const TRANSPORTS: ReadonlySet<string> = new Set(['codex-queue', 'opencode-queue', 'claude-inbox', 'claude-channel', 'tmux'])

function isAttempt(v: unknown): v is Attempt {
  if (!v || typeof v !== 'object') return false
  const row = v as Attempt
  return typeof row.msgId === 'string' && row.msgId.length > 0
    && typeof row.conv === 'string' && typeof row.host === 'string' && typeof row.user === 'string'
    && typeof row.alias === 'string' && typeof row.n === 'number' && Number.isSafeInteger(row.n) && row.n >= 0
    && KINDS.has(row.kind) && TRANSPORTS.has(row.transport) && STATES.has(row.state)
    && (row.nativeId === undefined || typeof row.nativeId === 'string')
    && (row.reported === undefined || typeof row.reported === 'boolean')
}

export class WakeStore {
  private constructor(readonly path: string, private rows: Attempt[]) {}

  static open(path: string): WakeStore {
    return new WakeStore(path, [])
  }

  /**
   * A missing file is an empty store and is not created.
   * Anything else unreadable or malformed is left on disk and thrown.
   * A `pending` row is a crash between the native send and wakeResult, so it becomes `uncertain`.
   */
  static load(path: string): WakeStore {
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new WakeStore(path, [])
      throw err
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('wake store malformed') }
    if (!Array.isArray(parsed) || !parsed.every(isAttempt)) throw new Error('wake store malformed')
    const crashed = parsed.some(row => row.state === 'pending')
    const store = new WakeStore(path, parsed.map(row => row.state === 'pending' ? { ...row, state: 'uncertain' } : row))
    if (crashed) store.flush()
    return store
  }

  get(msgId: string): Attempt | undefined {
    return this.rows.find(row => row.msgId === msgId)
  }

  openFor(conv: string): Attempt | undefined {
    return this.rows.find(row => row.conv === conv && OPEN.has(row.state))
  }

  begin(row: Omit<Attempt, 'state'>): void {
    if (this.get(row.msgId)) throw new Error(`wake attempt already exists for ${row.msgId}`)
    this.rows.push({ ...row, state: 'pending' })
    this.flush()
  }

  finish(msgId: string, result: WakeResult): void {
    const row = this.get(msgId)
    if (!row) throw new Error(`no wake attempt for ${msgId}`)
    row.state = result.s
    if (result.s === 'woken') row.nativeId = result.nativeId
    else delete row.nativeId
    this.flush()
  }

  ack(msgId: string): void {
    this.rows = this.rows.filter(row => row.msgId !== msgId)
    this.flush()
  }

  /** The agent called check_inbox, so this conversation may be nudged again. Pending sends stay. */
  clearOpen(conv: string): void {
    const next = this.rows.filter(row => row.conv !== conv || row.state === 'pending' || !OPEN.has(row.state))
    if (next.length === this.rows.length) return
    this.rows = next
    this.flush()
  }

  markReported(msgId: string): void {
    const row = this.get(msgId)
    if (!row || row.reported) return
    row.reported = true
    this.flush()
  }

  /** Finished results whose wakeResult the router has not acked. */
  unreported(): Attempt[] {
    return this.rows.filter(row => row.reported !== true && (row.state === 'woken' || row.state === 'held' || row.state === 'refused' || row.state === 'unavailable'))
  }

  private flush(): void {
    const tmp = this.path + '.tmp'
    const fd = openSync(tmp, 'w', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(this.rows))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, this.path)
    chmodSync(this.path, 0o600)
    const directory = openSync(dirname(this.path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}
