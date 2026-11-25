import { describe, test, expect } from 'bun:test'
import { afterDrain, latchDecision, resolveExact, WakeBudget } from '../wake.js'

describe('exact names', () => {
  const names = ['codex@mac', 'codex@nas642', 'agy@mac:src']
  test('accepts only an exact session name', () => {
    expect(resolveExact('codex@mac', names)).toEqual({ ok: true, name: 'codex@mac' })
  })
  test('a unique prefix is still a question, not a fan-out', () => {
    const r = resolveExact('agy', names)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('agy@mac:src')
  })
  test('an ambiguous prefix lists matches and does not pick one', () => {
    const r = resolveExact('codex', names)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('codex@mac')
      expect(r.error).toContain('codex@nas642')
    }
  })
})

describe('single-flight latch', () => {
  test('an empty inbox never nudges, and a message during an unacked nudge is held', () => {
    expect(latchDecision(false, 0)).toBe('skip')
    expect(latchDecision(false, 1)).toBe('send')
    expect(latchDecision(true, 1)).toBe('hold')
    expect(latchDecision(true, 3)).toBe('hold')
  })
  test('ack nudges again only for mail that arrived after the drain', () => {
    expect(afterDrain(0)).toEqual({ inFlight: false, nudge: false })
    expect(afterDrain(1)).toEqual({ inFlight: false, nudge: true })
  })
})

describe('cold wake budget', () => {
  test('the second cold wake in the window is refused', () => {
    const b = new WakeBudget({ cheap: 10, standard: 1, premium: 1 }, 1000)
    expect(b.allow('a', 'premium', 0)).toBe(true)
    expect(b.allow('a', 'premium', 10)).toBe(false)
    expect(b.allow('a', 'premium', 2000)).toBe(true)
  })
})
