import { test, expect } from 'bun:test'
import { BusOwnership } from '../bus-ownership.js'

test('retired tools fail before sending; repeated refusal keeps timestamp and logs once', () => {
  const logs: string[] = []
  const state = new BusOwnership(line => logs.push(line))
  state.retire('claude@mac:x', new Date('2026-11-28T00:00:00Z'))
  state.retire('claude@mac:x', new Date('2026-11-28T01:00:00Z'))
  const error = 'bus name claude@mac:x is held by another instance since 2026-11-28T00:00:00.000Z; reconnect this MCP (/mcp) to reclaim'
  expect(state.error()).toBe(error)
  let sent = 0
  for (const tool of ['bus_post', 'check_inbox', 'channel_post', 'reply']) {
    expect(() => { state.assertAvailable(); sent++ }).toThrow(error)
  }
  expect(sent).toBe(0)
  expect(logs).toHaveLength(1)
  state.clear() // only after a successful registration
  expect(state.error()).toBeUndefined()
  expect(() => state.assertAvailable()).not.toThrow()
  state.retire('claude@mac:x')
  expect(logs).toHaveLength(2)
})
