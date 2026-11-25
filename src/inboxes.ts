import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  readonly lease?: { id: string; receipt: string; until: number }
}

type Record =
  | { op: 'commit'; entries: InboxEntry[]; publish?: { key: string; result: PublishResult } }
  | { op: 'lease'; ids: string[]; lease: NonNullable<InboxEntry['lease']> }
  | { op: 'ack'; ids: string[] }
  | { op: 'mark'; id: string; result: WakeResult }
  | { op: 'bind'; target: Target; ids: string[] }
  | { op: 'mirror'; ids: string[]; messageId: string; sender?: Target }
  | { op: 'remember'; name: string; conv: string }

export const INBOX_MAX = 5000
export const LEASE_MS = 10 * 60_000

export function identityKey(target: Target): string {
  return JSON.stringify([target.host, target.user, target.kind, target.conv])
}

export class Inboxes {
  private readonly entries = new Map<string, InboxEntry>()
  private readonly byKey = new Map<string, Set<string>>()
  private readonly publishes = new Map<string, PublishResult>()
  private readonly aliases = new Map<string, Target>()
  private readonly approvals = new Map<string, Target>()
  private readonly legacyConversations = new Map<string, string>()
  private failed = false

  constructor(private readonly file?: string, legacyFile?: string) {
    if (!file) return
    const journal = this.read(file)
    if (journal !== undefined) {
      // A crash can tear the final append. Complete records end in a newline.
      for (const line of journal.slice(0, journal.lastIndexOf('\n') + 1).split('\n')) {
        if (line) this.apply(JSON.parse(line) as Record)
      }
    } else {
      const legacy = this.read(legacyFile ?? file.replace(/\.jsonl$/, '.json'))
      if (legacy) {
        for (const [key, messages] of Object.entries(JSON.parse(legacy) as { [key: string]: QueuedMessage[] })) {
          for (const message of messages) this.put({ ...message, key, id: randomUUID(), state: 'committed' })
        }
      }
    }
    const records: Record[] = [
      ...[...this.aliases.values()].map((target): Record => ({ op: 'bind', target, ids: [] })),
      ...[...this.approvals].map(([messageId, sender]): Record => ({ op: 'mirror', ids: [], messageId, sender })),
      ...[...this.legacyConversations].map(([name, conv]): Record => ({ op: 'remember', name, conv })),
      { op: 'commit', entries: [...this.entries.values()] },
      ...[...this.publishes].map(([key, result]): Record => ({ op: 'commit', entries: [], publish: { key, result } })),
    ]
    mkdirSync(dirname(file), { recursive: true })
    const temp = file + '.tmp'
    this.write(temp, records.map(record => JSON.stringify(record) + '\n').join(''), 'w')
    renameSync(temp, file)
    const directory = openSync(dirname(file), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }

  static inStateDir(dir: string): Inboxes {
    return new Inboxes(join(dir, 'inboxes.jsonl'), join(dir, 'inboxes.json'))
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
    try {
      if (this.file) this.write(this.file, JSON.stringify(record) + '\n', 'a')
    } catch {
      // A partial append cannot safely be followed by another record.
      this.failed = true
      throw new Error('inbox_commit_failed')
    }
    this.apply(record)
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
        for (const entry of record.entries) this.put(entry)
        if (record.publish) this.publishes.set(record.publish.key, record.publish.result)
        break
      case 'ack':
        for (const id of record.ids) this.remove(id)
        break
      case 'lease':
        for (const id of record.ids) {
          const entry = this.entries.get(id)
          if (entry) this.put({ ...entry, lease: record.lease })
        }
        break
      case 'mark': {
        const entry = this.entries.get(record.id)
        if (entry) this.put({ ...entry, state: record.result.s, ...(record.result.s === 'woken' && { nativeId: record.result.nativeId }) })
        break
      }
      case 'bind':
        this.aliases.set(record.target.alias, record.target)
        for (const id of record.ids) {
          const entry = this.entries.get(id)
          if (entry) this.put({ ...entry, key: identityKey(record.target) })
        }
        break
      case 'remember':
        this.legacyConversations.set(record.name, record.conv)
        break
      case 'mirror':
        if (record.sender) this.approvals.set(record.messageId, record.sender)
        for (const id of record.ids) {
          const entry = this.entries.get(id)
          if (entry) this.put({ ...entry, meta: { ...entry.meta, message_id: record.messageId } })
        }
        break
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
  publish(key: string): PublishResult | undefined { return this.publishes.get(key) }

  bind(target: Target): void {
    const previous = this.target(target.alias)
    if (previous && identityKey(previous) === identityKey(target)) return
    // Only the first binding can inherit unbound mail. A different conversation
    // can recover its held mail by registering its identity again.
    const ids = this.list(target.alias).filter(entry =>
      entry.meta.conversation_id === target.conv || (!previous && !entry.meta.conversation_id),
    ).map(entry => entry.id)
    this.append({ op: 'bind', target, ids })
  }

  commit(messages: readonly { name: string; content: string; meta: ChannelMeta; target?: Target }[], publish?: { key: string; result: PublishResult }): InboxEntry[] {
    const counts = new Map<string, number>()
    const entries = messages.map(({ name, content, meta, target }): InboxEntry => {
      const key = target ? identityKey(target) : this.key(name)
      const count = (counts.get(key) ?? this.byKey.get(key)?.size ?? 0) + 1
      if (count > INBOX_MAX) throw new Error('inbox_full')
      counts.set(key, count)
      return { id: randomUUID(), key, content, meta, at: new Date().toISOString(), state: 'committed' }
    })
    if (entries.length || publish) this.append({ op: 'commit', entries, ...(publish && { publish }) })
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

  legacy(name: string, conversationId?: string | null): InboxEntry[] {
    if (this.target(name)) return []
    return this.list(name).filter(({ meta }) => conversationId === undefined ||
      !meta.conversation_id || meta.conversation_id === conversationId)
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
    if (receipt !== undefined) {
      const ids = pending.filter(entry => entry.lease?.receipt === receipt && entry.lease.until > now).map(entry => entry.id)
      if (!ids.length) throw new Error('invalid_receipt')
      this.accept(ids)
    }
    const available = pending.filter(entry => !entry.lease || entry.lease.until <= now)
    if (!available.length) return { messages: [] }
    const id = randomUUID()
    const nextReceipt = randomUUID()
    this.append({ op: 'lease', ids: available.map(entry => entry.id), lease: { id, receipt: nextReceipt, until: now + LEASE_MS } })
    return {
      receipt: nextReceipt,
      messages: available.map(entry => ({
        id: entry.id, leaseId: id, body: entry.content, state: entry.state, meta: entry.meta,
        from: entry.meta.from ?? entry.meta.user ?? 'unknown', from_human: entry.meta.from_human === 'true',
      })),
    }
  }

  ack(key: string, leaseId: string, id: string, receipt: string, now = Date.now()): void {
    const entry = this.get(id)
    if (entry?.key !== key || entry.lease?.id !== leaseId || entry.lease.receipt !== receipt || entry.lease.until <= now) throw new Error('invalid_receipt')
    this.accept([id])
  }

  mark(key: string, id: string, result: WakeResult): void {
    const entry = this.get(id)
    if (entry?.key !== key) throw new Error('unknown_message')
    if (entry.state === 'committed' && this.list(key).some(other => other.state === 'uncertain' || other.state === 'woken')) {
      throw new Error('wake_already_pending')
    }
    if (entry.state !== 'uncertain' && (entry.state !== 'committed' || result.s !== 'uncertain')) {
      throw new Error('invalid_wake_transition')
    }
    this.append({ op: 'mark', id, result })
  }
}
