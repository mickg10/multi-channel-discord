import { expect, test } from 'bun:test'
import { wakeTmux } from '../tmux-wake.js'

const text = 'Mail waiting. Check your inbox.'
const pane = '%123'

function fakeTmux(onWait?: (ms: number) => void) {
  const commands: string[][] = []
  const waits: number[] = []
  const run = async (args: string[]) => {
    commands.push(args)
    if (args[0] !== 'send-keys') throw new Error('The pane shows older wake lines; the screen must not be consulted')
    return true
  }
  const wait = async (ms: number) => { waits.push(ms); onWait?.(ms) }
  return { commands, waits, run, wait }
}

test('a swallowed tmux wake opens the latch with no automatic resend', async () => {
  let inFlight = true
  const tmux = fakeTmux()
  await wakeTmux({ pane, text, isCurrent: () => inFlight, onUnconfirmed: () => { inFlight = false }, ...tmux })
  expect(inFlight).toBe(false)
  expect(tmux.commands).toEqual([
    ['send-keys', '-t', pane, '-l', text],
    ['send-keys', '-t', pane, 'Enter'],
  ])
  expect(tmux.waits).toEqual([300, 30_000])
})

test('a busy agent with stale wake lines receives no extra input after the deadline', async () => {
  let deadline = 0
  const tmux = fakeTmux()
  await wakeTmux({ pane, text, isCurrent: () => true, onUnconfirmed: () => { deadline++ }, ...tmux })
  expect(deadline).toBe(1)
  expect(tmux.commands).toHaveLength(2)
})

test('an inbox drain confirms the wake and suppresses the timeout action', async () => {
  let current = true
  const tmux = fakeTmux(ms => { if (ms === 30_000) current = false })
  await wakeTmux({ pane, text, isCurrent: () => current, onUnconfirmed: () => { throw new Error('unexpected timeout') }, ...tmux })
  expect(tmux.commands).toHaveLength(2)
})

test('an inbox drain before Enter prevents an empty turn', async () => {
  let current = true
  const tmux = fakeTmux(() => { current = false })
  await wakeTmux({ pane, text, isCurrent: () => current, onUnconfirmed: () => { throw new Error('unexpected timeout') }, ...tmux })
  expect(tmux.commands).toEqual([['send-keys', '-t', pane, '-l', text]])
})
