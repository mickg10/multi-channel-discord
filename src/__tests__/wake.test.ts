import { describe, test, expect } from 'bun:test'
import { createWakeLatch, resolveRecipients, askerFromBotPost, PassiveLog } from '../wake.js'

describe('resolveRecipients', () => {
  const names = ['codex@nas642:src', 'codex-photos@nas642:src', 'grok@nas642:src']
  test('exact name and a unique prefix resolve to one session', () => {
    expect(resolveRecipients('grok@nas642:src', names)).toEqual({ ok: true, names: ['grok@nas642:src'] })
    expect(resolveRecipients('codex-photos', names)).toEqual({ ok: true, names: ['codex-photos@nas642:src'] })
  })
  test('an ambiguous prefix does not fan out', () => {
    const r = resolveRecipients('codex', names)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Name one exact session')
  })
})

describe('askerFromBotPost', () => {
  test('binds an approval to the question author', () => {
    expect(askerFromBotPost('**[claude@nas642:src → human]** may I reboot?')).toBe('claude@nas642:src')
    expect(askerFromBotPost('a plain human message')).toBeNull()
  })
})

describe('wake latch', () => {
  const flush = () => new Promise(r => setTimeout(r, 20))
  test('a burst emits one nudge, and mail left after ack emits one more', async () => {
    let n = 0
    const latch = createWakeLatch(() => { n++ }, { coalesceMs: 0, maxInFlightMs: 60_000 })
    latch.arrive(); latch.arrive(); latch.arrive()
    await flush()
    expect(n).toBe(1)
    latch.ack(1)
    await flush()
    expect(n).toBe(2)
    latch.ack(0)
    await flush()
    expect(n).toBe(2)
  })
  test('a missed ack does not stick while mail is still queued', async () => {
    let n = 0
    let queued = 1
    const latch = createWakeLatch(() => { n++ }, { coalesceMs: 0, maxInFlightMs: 30, pending: () => queued })
    latch.arrive()
    await flush()
    expect(n).toBe(1)
    await new Promise(r => setTimeout(r, 25))
    expect(n).toBe(2)
    queued = 0
    await new Promise(r => setTimeout(r, 40))
    expect(n).toBe(2)
  })
  test('an empty ack does not nudge', async () => {
    let n = 0
    const latch = createWakeLatch(() => { n++ }, { coalesceMs: 0 })
    latch.ack(0)
    await flush()
    expect(n).toBe(0)
  })
})

describe('passive log', () => {
  test('summary is bounded and is not repeated', () => {
    const log = new PassiveLog(100)
    for (let i = 0; i < 30; i++) log.add({ channelId: 'bus', from: 'a', text: 'm' + i })
    const first = log.summary('grok', () => true, 20)
    expect(first).toContain('30 passive')
    expect(first).toContain('… and 10 more')
    expect(log.summary('grok', () => true)).toBe('')
  })
})
