import { expect, test } from 'bun:test'
import { wakeTmux } from '../tmux-wake.js'

const text = 'Mail waiting. Check your inbox.'
const pane = '%123'

function fakeTmux(captures: string[], onWait?: (ms: number) => void) {
  const commands: string[][] = []
  const waits: number[] = []
  const run = async (args: string[]) => {
    commands.push(args)
    return args[0] === 'capture-pane' ? captures.shift() : ''
  }
  const wait = async (ms: number) => { waits.push(ms); onWait?.(ms) }
  return { commands, waits, run, wait }
}

test('tmux wake confirms a fresh entry in the prompt history without retrying', async () => {
  const tmux = fakeTmux(['previous turn', `previous turn\n${text}`])
  expect(await wakeTmux({ pane, text, isCurrent: () => true, ...tmux })).toBe('confirmed')
  expect(tmux.commands.map(command => command[0])).toEqual(['capture-pane', 'send-keys', 'send-keys', 'capture-pane'])
  expect(tmux.waits).toEqual([300, 3_000])
})

test('tmux wake retries a swallowed Enter once and ignores an older identical wake', async () => {
  const banner = `${text}\nPress Esc to dismiss`
  const tmux = fakeTmux([banner, banner, banner, `${banner}\n${text}`])
  expect(await wakeTmux({ pane, text, isCurrent: () => true, ...tmux })).toBe('confirmed')
  expect(tmux.waits).toEqual([300, 3_000, 30_000, 300, 3_000])
  const sends = tmux.commands.filter(command => command[0] === 'send-keys')
  expect(sends).toEqual([
    ['send-keys', '-t', pane, '-l', text], ['send-keys', '-t', pane, 'Enter'],
    ['send-keys', '-t', pane, '-l', text], ['send-keys', '-t', pane, 'Enter'],
  ])
})

test('tmux wake reports failure after a second miss', async () => {
  const tmux = fakeTmux(['banner', 'banner', 'banner', 'banner'])
  expect(await wakeTmux({ pane, text, isCurrent: () => true, ...tmux })).toBe('failed')
  expect(tmux.commands.filter(command => command.at(-1) === 'Enter')).toHaveLength(2)
})

test('draining the inbox during the retry delay prevents a second send', async () => {
  let current = true
  const tmux = fakeTmux(['banner', 'banner'], ms => { if (ms === 30_000) current = false })
  expect(await wakeTmux({ pane, text, isCurrent: () => current, ...tmux })).toBe('cancelled')
  expect(tmux.commands.filter(command => command.at(-1) === 'Enter')).toHaveLength(1)
})
