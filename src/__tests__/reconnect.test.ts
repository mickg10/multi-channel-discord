import { describe, test, expect } from 'bun:test'
import { computeBackoff, connectionClosed } from '../reconnect.js'

describe('computeBackoff', () => {
  test('starts at 1000ms', () => {
    expect(computeBackoff(0)).toBe(1000)
  })

  test('doubles each attempt', () => {
    expect(computeBackoff(1)).toBe(2000)
    expect(computeBackoff(2)).toBe(4000)
    expect(computeBackoff(3)).toBe(8000)
  })

  test('caps at 30000ms', () => {
    expect(computeBackoff(10)).toBe(30000)
    expect(computeBackoff(100)).toBe(30000)
  })

  test('follows sequence 1s, 2s, 4s, 8s, 16s, 30s', () => {
    expect(computeBackoff(0)).toBe(1000)
    expect(computeBackoff(1)).toBe(2000)
    expect(computeBackoff(2)).toBe(4000)
    expect(computeBackoff(3)).toBe(8000)
    expect(computeBackoff(4)).toBe(16000)
    expect(computeBackoff(5)).toBe(30000)
  })
})


test('late real close after synthetic close cannot clear a replacement connection', () => {
  const oldSocket = {}, newSocket = {}
  let current: object | null = oldSocket
  let reconnects = 0
  const oldClose = connectionClosed(() => current === oldSocket, () => { current = null }, () => { reconnects++ })
  oldClose() // forced heartbeat close
  expect(current).toBeNull()
  expect(reconnects).toBe(1)
  current = newSocket // reconnect succeeded
  oldClose() // delayed real close/error from old transport
  expect(current).toBe(newSocket)
  expect(reconnects).toBe(1)
  const staleClose = connectionClosed(() => current === oldSocket, () => { current = null }, () => { reconnects++ })
  staleClose() // also guard first callback from a superseded socket
  expect(current).toBe(newSocket)
  expect(reconnects).toBe(1)
})
