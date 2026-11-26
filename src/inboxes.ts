import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChannelMeta, LeaseResult, PublishResult, Target, WakeResult, WakeState } from './types.js'

export interface QueuedMessage {
  readonly content: string
  readonly meta: ChannelMeta
  readonly at: string
}

export interface InboxEntry extends QueuedMessage {
  readonly id: string
  readonly key: string
  readonly state: WakeState
  readonly nativeId?: string
  readonly nudgeNumber?: number
  readonly lease?: { id: string; receipt: string; until: number }
}

export interface PublishMirror {
  readonly where: string
  readonly label: string
  readonly origin: string
  readonly copy?: { readonly where: string; readonly origin: string }
  readonly copyOnly?: true
  readonly from: string
  readonly fingerprint: string
  readonly sender?: Target
  readonly entryIds?: string[]
}

interface PublishRecord {
  readonly key: string
  readonly result: PublishResult
  readonly at: number
  readonly mirror?: PublishMirror
}

interface CompactionLimits { records: number; bytes: number }
const DEFAULT_LIMITS: CompactionLimits = { records: 50_000, bytes: 64 * 1024 * 1024 }
export const PUBLISH_TTL_MS = 24 * 60 * 60_000

type Record =
  | { op: 'commit'; entries: InboxEntry[]; publish?: PublishRecord }
  | { op: 'lease'; ids: string[]; lease: NonNullable<InboxEntry['lease']> }
  | { op: 'ack'; ids: string[] }
  | { op: 'mark'; id: string; result: WakeResult; nudgeNumber?: number }
  | { op: 'bind'; target: Target; ids: string[] }
  | { op: 'mirror'; ids: string[]; messageId: string; sender?: Target }
  | { op: 'remember'; name: string; conv: string }
  | { op: 'release'; alias: string }
  | { op: 'renameLegacy'; name: string; ids: string[]; conv?: string }
  | { op: 'publishMirrored'; key: string; at: number; messageId: string }
  | { op: 'counter'; key: string; n: number }
  | { op: 'receiptKey'; key: string }

export const INBOX_MAX = 5000
export const LEASE_MS = 10 * 60_000

export function identityKey(target: Target): string {
  return JSON.stringify([target.host, target.user, target.kind, target.conv])
}

function holdsWake(entry: InboxEntry): boolean {
  return entry.state === 'uncertain' || entry.state === 'woken'
}

function isIds(ids: unknown): ids is string[] {
  return Array.isArray(ids) && ids.every(id => typeof id === 'string')
}

export class Inboxes {
  private readonly entries = new Map<string, InboxEntry>()
  private readonly byKey = new Map<string, Set<string>>()
  private readonly publishes = new Map<string, PublishRecord>()
  private readonly aliases = new Map<string, Target>()
  private readonly approvals = new Map<string, Target>()
  private readonly legacyConversations = new Map<string, string>()
  private readonly seenAliases = new Set<string>()
  private readonly counters = new Map<string, number>()
  private receiptKey = randomBytes(32)
  private appendedRecords = 0
  private appendedBytes = 0
  private failed = false

  constructor(private readonly file?: string, legacyFile?: string, private readonly limits = DEFAULT_LIMITS) {
    if (!file) return
    const journal = this.read(file)
    if (journal !== undefined) {
      // A crash can tear the final append. Complete records end in a newline.
      const lines = journal.slice(0, journal.lastIndexOf('\n') + 1).split('\n')
      for (let i = 0; i < lines.length - 1; i++) {
        try { this.apply(JSON.parse(lines[i]!) as Record) } catch {
          this.reportCorruption(file, i + 1)
        }
      }
    } else {
      const legacy = this.read(legacyFile ?? file.replace(/\.jsonl$/, '.json'))
      if (legacy) {
        for (const [key, messages] of Object.entries(JSON.parse(legacy) as { [key: string]: QueuedMessage[] })) {
          for (const message of messages) this.put({ ...message, key, id: randomUUID(), state: 'committed' })
        }
      }
    }
    this.compact(file)
  }

  private reportCorruption(file: string, line: number): never {
    const backup = `${file}.corrupt-${Date.now()}-${randomUUID()}`
    let recovery: string
    try {
      copyFileSync(file, backup, constants.COPYFILE_EXCL)
      recovery = `preserved copy at ${backup}`
    } catch { recovery = 'could not preserve a recovery copy' }
    const message = `Inbox journal corrupt at ${file} line ${line}; ${recovery}`
    process.stderr.write(message + '\n')
    throw new Error(message)
  }

  private compact(file: string): void {
    const now = Date.now()
    for (const [key, publish] of this.publishes) {
      if (now - publish.at >= PUBLISH_TTL_MS) this.publishes.delete(key)
    }
    const records: Record[] = [
      { op: 'receiptKey', key: this.receiptKey.toString('hex') },
      ...[...this.counters].map(([key, n]): Record => ({ op: 'counter', key, n })),
      ...[...this.seenAliases].filter(alias => !this.aliases.has(alias)).map((alias): Record => ({ op: 'release', alias })),
      ...[...this.aliases.values()].map((target): Record => ({ op: 'bind', target, ids: [] })),
      ...[...this.approvals].map(([messageId, sender]): Record => ({ op: 'mirror', ids: [], messageId, sender })),
      ...[...this.legacyConversations].map(([name, conv]): Record => ({ op: 'remember', name, conv })),
      { op: 'commit', entries: [...this.entries.values()] },
      ...[...this.publishes.values()].map((publish): Record => ({ op: 'commit', entries: [], publish })),
    ]
    mkdirSync(dirname(file), { recursive: true })
    const temp = file + '.tmp'
    this.write(temp, records.map(record => JSON.stringify(record) + '\n').join(''), 'w')
    renameSync(temp, file)
    const directory = openSync(dirname(file), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }

  static inStateDir(dir: string, limits?: CompactionLimits): Inboxes {
    return new Inboxes(join(dir, 'inboxes.jsonl'), join(dir, 'inboxes.json'), limits)
  }

  private read(file: string): string | undefined {
    try { return readFileSync(file, 'utf8') } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return undefined
    }
  }

  private write(path: string, data: string, flag: 'a' | 'w'): void {
    const fd = openSync(path, flag, 0o600)
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally { closeSync(fd) }
  }

  private append(record: Record): void {
    if (this.failed) throw new Error('inbox_commit_failed')
    const line = JSON.stringify(record) + '\n'
    try {
      if (this.file) this.write(this.file, line, 'a')
    } catch {
      // A partial append cannot safely be followed by another record.
      this.failed = true
      process.stderr.write(`Inbox journal append failed at ${this.file}; reopening the journal is required\n`)
      throw new Error('inbox_commit_failed')
    }
    this.apply(record)
    if (!this.file) return
    this.appendedRecords++
    this.appendedBytes += Buffer.byteLength(line)
    if (this.appendedRecords < this.limits.records && this.appendedBytes < this.limits.bytes) return
    this.appendedRecords = 0
    this.appendedBytes = 0
    try { this.compact(this.file) } catch {
      // The original append already completed and remains authoritative.
      process.stderr.write('Inbox journal compaction failed\n')
    }
  }

  private remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const bucket = this.byKey.get(entry.key)!
    bucket.delete(id)
    if (!bucket.size) this.byKey.delete(entry.key)
    this.entries.delete(id)
  }

  private put(entry: InboxEntry): void {
    if (this.entries.get(entry.id)?.key !== entry.key) this.remove(entry.id)
    const bucket = this.byKey.get(entry.key) ?? new Set<string>()
    bucket.add(entry.id)
    this.byKey.set(entry.key, bucket)
    this.entries.set(entry.id, entry)
  }

  private apply(record: Record): void {
    switch (record.op) {
      case 'commit':
        if (!Array.isArray(record.entries)) throw new Error('Invalid commit record')
        for (const entry of record.entries) {
          if (typeof entry.id !== 'string' || typeof entry.key !== 'string' || typeof entry.content !== 'string' ||
              typeof entry.at !== 'string' || !entry.meta || typeof entry.meta !== 'object') throw new Error('Invalid inbox entry')
          this.put(entry)
        }
        if (record.publish) {
          const { key, result, at = Date.now() } = record.publish
          if (typeof key !== 'string' || typeof result?.publish_id !== 'string' ||
              !Array.isArray(result.committed) || !Number.isFinite(at)) throw new Error('Invalid publish record')
          this.publishes.set(key, { ...record.publish, at })
        }
        break
      case 'ack':
        if (!isIds(record.ids)) throw new Error('Invalid ack record')
        for (const id of record.ids) this.remove(id)
        break
      case 'lease':
        if (!isIds(record.ids) || typeof record.lease?.id !== 'string' ||
            typeof record.lease.receipt !== 'string' || !Number.isFinite(record.lease.until)) throw new Error('Invalid lease record')
        for (const id of record.ids) {
          const entry = this.entries.get(id)
          if (entry) this.put({ ...entry, lease: record.lease, state: holdsWake(entry) ? 'leased' : entry.state })
        }
        break
      case 'mark': {
        const entry = this.entries.get(record.id)
        if (entry) {
          const n = record.nudgeNumber
          if (n !== undefined) this.counters.set(entry.key, n)
          this.put({
            ...entry, state: entry.state === 'leased' && (record.result.s === 'woken' || record.result.s === 'uncertain')
              ? 'leased' : record.result.s,
            ...(n !== undefined && { nudgeNumber: n }),
            ...(record.result.s === 'woken' && { nativeId: record.result.nativeId }),
          })
        }
        break
      }
      case 'bind':
        if (!isIds(record.ids) || typeof record.target?.alias !== 'string' || typeof record.target.host !== 'string' ||
            typeof record.target.kind !== 'string' || typeof record.target.user !== 'string' ||
            typeof record.target.conv !== 'string') throw new Error('Invalid binding record')
        this.aliases.set(record.target.alias, record.target)
        this.seenAliases.add(record.target.alias)
        for (const id of record.ids) {
          const entry = this.entries.get(id)
          if (entry) this.put({ ...entry, key: identityKey(record.target) })
        }
        break
      case 'renameLegacy':
        if (typeof record.name !== 'string' || !isIds(record.ids) || (record.conv !== undefined && typeof record.conv !== 'string')) {
          throw new Error('Invalid legacy rename record')
        }
        if (record.conv) this.legacyConversations.set(record.name, record.conv)
        for (const id of record.ids) {
          const entry = this.get(id)
          if (entry) this.put({ ...entry, key: record.name })
        }
        break
      case 'release':
        if (typeof record.alias !== 'string') throw new Error('Invalid release record')
        this.seenAliases.add(record.alias)
        this.aliases.delete(record.alias)
        break
      case 'counter':
        if (typeof record.key !== 'string' || !Number.isSafeInteger(record.n) || record.n < 0) throw new Error('Invalid counter record')
        this.counters.set(record.key, record.n)
        break
      case 'receiptKey':
        if (typeof record.key !== 'string' || !/^[a-f0-9]{64}$/.test(record.key)) throw new Error('Invalid receipt signing key')
        this.receiptKey = Buffer.from(record.key, 'hex')
        break
      case 'publishMirrored': {
        const publish = this.publishes.get(record.key)
        if (publish?.at !== record.at || !publish.mirror) break
        this.apply({ op: 'mirror', ids: publish.mirror.entryIds ?? [], messageId: record.messageId, sender: publish.mirror.sender })
        this.publishes.set(record.key, { ...publish, mirror: undefined })
        break
      }
      case 'remember':
        this.legacyConversations.set(record.name, record.conv)
        break
      case 'mirror':
        if (!isIds(record.ids) || typeof record.messageId !== 'string') throw new Error('Invalid mirror record')
        if (record.sender) this.approvals.set(record.messageId, record.sender)
        for (const id of record.ids) {
          const entry = this.entries.get(id)
          if (entry) this.put({ ...entry, meta: { ...entry.meta, message_id: record.messageId } })
        }
        break
      default:
        throw new Error('Unknown journal record')
    }
  }

  target(alias: string): Target | undefined { return this.aliases.get(alias) }
  names(): string[] { return [...new Set([...this.aliases.keys(), ...this.legacyConversations.keys()])] }
  conversation(name: string): string | undefined { return this.legacyConversations.get(name) }
  remember(name: string, conv: string): void {
    if (this.conversation(name) !== conv) this.append({ op: 'remember', name, conv })
  }
  approvalTarget(messageId: string): Target | undefined { return this.approvals.get(messageId) }
  key(alias: string): string { const target = this.target(alias); return target ? identityKey(target) : alias }
  publish(key: string, now = Date.now()): PublishRecord | undefined {
    const publish = this.publishes.get(key)
    if (!publish || now - publish.at >= PUBLISH_TTL_MS) return undefined
    return publish
  }

  publishMirrored(key: string, at: number, messageId: string): void {
    const publish = this.publishes.get(key)
    if (publish?.at === at && publish.mirror) this.append({ op: 'publishMirrored', key, at, messageId })
  }

  release(alias: string): void {
    if (this.aliases.has(alias)) this.append({ op: 'release', alias })
  }

  canInheritLegacy(target: Target): boolean {
    const legacyConversation = this.conversation(target.alias)
    return legacyConversation === undefined ? !this.seenAliases.has(target.alias) : legacyConversation === target.conv
  }

  bind(target: Target): void {
    const previous = this.target(target.alias)
    if (previous && identityKey(previous) === identityKey(target)) return
    // Legacy mail remains name-addressed until migration. If the legacy owner
    // is known, only its conversation can migrate that mail into a native inbox.
    const inherit = this.canInheritLegacy(target)
    const ids = this.list(target.alias).filter(({ meta }) => {
      const approval = meta.from_human === 'true' && meta.question_id && meta.conversation_id
      return approval ? meta.conversation_id === target.conv : inherit
    }).map(entry => entry.id)
    this.append({ op: 'bind', target, ids })
  }

  commit(messages: readonly { name: string; content: string; meta: ChannelMeta; target?: Target }[], publish?: PublishRecord): InboxEntry[] {
    const counts = new Map<string, number>()
    const entries = messages.map(({ name, content, meta, target }): InboxEntry => {
      const key = target ? identityKey(target) : this.key(name)
      const count = (counts.get(key) ?? this.byKey.get(key)?.size ?? 0) + 1
      if (count > INBOX_MAX) throw new Error('inbox_full')
      counts.set(key, count)
      return { id: randomUUID(), key, content, meta, at: new Date().toISOString(), state: 'committed' }
    })
    const publication = publish?.mirror
      ? { ...publish, mirror: { ...publish.mirror, entryIds: entries.map(entry => entry.id) } }
      : publish
    if (entries.length || publication) this.append({ op: 'commit', entries, publish: publication })
    return entries
  }

  setMirror(ids: string[], messageId: string, sender?: Target): void {
    if (ids.length || sender) this.append({ op: 'mirror', ids, messageId, ...(sender && { sender }) })
  }

  push(name: string, content: string, meta: ChannelMeta): number {
    this.commit([{ name, content, meta }])
    return this.count(name)
  }

  count(name: string): number { return this.byKey.get(this.key(name))?.size ?? 0 }
  list(key: string): InboxEntry[] { return [...(this.byKey.get(key) ?? [])].map(id => this.entries.get(id)!) }
  get(id: string): InboxEntry | undefined { return this.entries.get(id) }
  wakePending(key: string): boolean { return this.list(key).some(holdsWake) }

  legacy(name: string, conversationId?: string | null): InboxEntry[] {
    if (this.target(name)) return []
    return this.list(name).filter(({ meta }) => conversationId === undefined || meta.from_human !== 'true' || !meta.question_id ||
      !meta.conversation_id || meta.conversation_id === conversationId)
  }

  renameLegacy(oldName: string, name: string, conversationId: string | null): void {
    if (oldName === name) return
    const ids = this.legacy(oldName, conversationId).map(entry => entry.id)
    const conv = conversationId && this.conversation(name) !== conversationId ? conversationId : undefined
    if (!ids.length && !conv) return
    if (this.count(name) + ids.length > INBOX_MAX) throw new Error('inbox_full')
    this.append({ op: 'renameLegacy', name, ids, conv })
  }

  accept(ids: string[]): void {
    if (ids.length) this.append({ op: 'ack', ids })
  }

  drain(name: string, conversationId?: string | null): QueuedMessage[] {
    const messages = this.legacy(name, conversationId)
    this.accept(messages.map(entry => entry.id))
    return messages.map(({ content, meta, at }) => ({ content, meta, at }))
  }

  lease(key: string, receipt?: string, now = Date.now()): Omit<LeaseResult, 'unread'> {
    const pending = this.list(key)
    let receiptStatus: LeaseResult['receipt_status']
    if (receipt !== undefined) {
      const ids = pending.filter(entry => entry.lease?.receipt === receipt && entry.lease.until > now).map(entry => entry.id)
      if (this.foreignReceipt(key, receipt)) throw new Error('invalid_receipt')
      this.accept(ids)
      if (!ids.length) receiptStatus = 'stale'
    }
    const available = pending.filter(entry => !entry.lease || entry.lease.until <= now)
    const status = receiptStatus ? { receipt_status: receiptStatus } : {}
    if (!available.length) return { messages: [], ...status }
    const id = randomUUID()
    // The signed opaque token retains its owner after expiry and compaction,
    // without keeping a second unbounded table of consumed receipts.
    const payload = `${id}.${this.receiptMac('owner', key)}`
    const nextReceipt = `${payload}.${this.receiptMac('receipt', payload)}`
    this.append({ op: 'lease', ids: available.map(entry => entry.id), lease: { id, receipt: nextReceipt, until: now + LEASE_MS } })
    return {
      receipt: nextReceipt,
      ...status,
      messages: available.map(entry => ({
        id: entry.id, leaseId: id, body: entry.content, state: this.get(entry.id)!.state, meta: entry.meta,
        from: entry.meta.from ?? entry.meta.user ?? 'unknown', from_human: entry.meta.from_human === 'true',
      })),
    }
  }

  private receiptMac(domain: string, value: string): string {
    return createHmac('sha256', this.receiptKey).update(domain + ':' + value).digest('hex')
  }

  private foreignReceipt(key: string, receipt: string): boolean {
    const token = /^([a-f0-9-]{36})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(receipt)
    if (token) {
      const owner = token[2]!
      const signature = token[3]!
      const signed = this.receiptMac('receipt', `${token[1]}.${owner}`)
      return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signed, 'hex')) &&
        !timingSafeEqual(Buffer.from(owner, 'hex'), Buffer.from(this.receiptMac('owner', key), 'hex'))
    }
    // Journals from before signed receipts can still contain active UUID leases.
    if (!/^[a-f0-9-]{36}$/.test(receipt)) return false
    for (const entry of this.entries.values()) {
      if (entry.lease?.receipt === receipt) return entry.key !== key
    }
    return false
  }

  ack(key: string, leaseId: string, id: string, receipt: string, now = Date.now()): void {
    const entry = this.get(id)
    if (entry?.key !== key || entry.lease?.id !== leaseId || entry.lease.receipt !== receipt || entry.lease.until <= now) throw new Error('invalid_receipt')
    this.accept([id])
  }

  mark(key: string, id: string, result: WakeResult): InboxEntry {
    const entry = this.get(id)
    if (entry?.key !== key) throw new Error('unknown_message')
    const outcome = entry.state === 'leased' && entry.nativeId !== undefined ? 'woken' : entry.state
    if (outcome === 'woken' || outcome === 'held' || outcome === 'refused' || outcome === 'unavailable') {
      // The gateway may have lost our reply after the journal was synced.
      if (result.s === outcome && (result.s !== 'woken' || result.nativeId === entry.nativeId)) return entry
      throw new Error('invalid_wake_transition')
    }
    if (entry.state === 'committed' && this.wakePending(key)) {
      throw new Error('wake_already_pending')
    }
    const lateResult = entry.state === 'leased' && entry.nudgeNumber !== undefined
    if (!lateResult && entry.state !== 'uncertain' && (entry.state !== 'committed' || result.s !== 'uncertain')) {
      throw new Error('invalid_wake_transition')
    }
    const nudgeNumber = result.s === 'uncertain' && entry.nudgeNumber === undefined
      ? (this.counters.get(key) ?? 0) + 1 : undefined
    if (nudgeNumber !== undefined && !Number.isSafeInteger(nudgeNumber)) throw new Error('inbox_commit_failed')
    this.append({ op: 'mark', id, result, ...(nudgeNumber !== undefined && { nudgeNumber }) })
    return this.entries.get(id)!
  }
}
