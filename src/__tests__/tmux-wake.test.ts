import { expect, test } from 'bun:test'
import { tmuxWakeUnlatchMs, wakeTmux } from '../tmux-wake.js'

const text = 'Mail waiting. Check your inbox.'
const pane = '%123'

function fakeTmux(drainAfter = Infinity) {
  const commands: string[][] = []
  const diagnostics: number[] = []
  const releases: number[] = []
  let elapsed = 0
  let enteredAt = 0
  let inFlight = true
  const run = async (args: string[]) => {
    commands.push(args)
    if (args[0] !== 'send-keys') throw new Error('The pane shows older wake lines; the screen must not be consulted')
    if (args.at(-1) === 'Enter') enteredAt = elapsed
    return true
  }
  const wait = async (ms: number) => {
    elapsed += ms
    if (elapsed - enteredAt >= drainAfter) inFlight = false
  }
  return {
    commands, diagnostics, releases, run, wait,
    isCurrent: () => inFlight,
    onUnconfirmed: () => { diagnostics.push(elapsed - enteredAt) },
    onUnlatch: () => { releases.push(elapsed - enteredAt); inFlight = false },
  }
}

test('a swallowed wake logs at 30 seconds and opens the latch at five minutes without sending again', async () => {
  const tmux = fakeTmux()
  await wakeTmux({ pane, text, ...tmux })
  expect(tmux.diagnostics).toEqual([30_000])
  expect(tmux.releases).toEqual([300_000])
  expect(tmux.commands).toEqual([
    ['send-keys', '-t', pane, '-l', text],
    ['send-keys', '-t', pane, 'Enter'],
  ])
})

test('a busy agent draining at four minutes keeps its latch and receives one send', async () => {
  const tmux = fakeTmux(4 * 60_000)
  await wakeTmux({ pane, text, ...tmux })
  expect(tmux.diagnostics).toEqual([30_000])
  expect(tmux.releases).toEqual([])
  expect(tmux.commands.filter(args => args.at(-1) === 'Enter')).toHaveLength(1)
})

test('a drain before the diagnostic suppresses both timeout actions', async () => {
  const tmux = fakeTmux(15_000)
  await wakeTmux({ pane, text, ...tmux })
  expect(tmux.diagnostics).toEqual([])
  expect(tmux.releases).toEqual([])
  expect(tmux.commands).toHaveLength(2)
})

test('a drain before Enter prevents an empty turn', async () => {
  const tmux = fakeTmux(200)
  await wakeTmux({ pane, text, ...tmux })
  expect(tmux.commands).toEqual([['send-keys', '-t', pane, '-l', text]])
})

test('the unlatch interval is configurable with a safe default', async () => {
  for (const invalid of [undefined, 'not a number', '1000', '100000.5', '99999999999']) {
    expect(tmuxWakeUnlatchMs(invalid)).toBe(300_000)
  }
  const tmux = fakeTmux()
  await wakeTmux({ pane, text, unlatchMs: tmuxWakeUnlatchMs('360000'), ...tmux })
  expect(tmux.releases).toEqual([360_000])
})
