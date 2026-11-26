const DIAGNOSTIC_MS = 30_000
const DEFAULT_UNLATCH_MS = 5 * 60_000

export function tmuxWakeUnlatchMs(raw?: string): number {
  const value = Number(raw)
  return Number.isInteger(value) && value >= DIAGNOSTIC_MS && value <= 2_147_483_647 ? value : DEFAULT_UNLATCH_MS
}

interface TmuxWakeOptions {
  readonly pane: string
  readonly text: string
  readonly run: (args: string[]) => Promise<boolean>
  /** False once the agent drains the inbox or the wake is superseded. */
  readonly isCurrent: () => boolean
  readonly onUnconfirmed: () => void
  readonly onUnlatch: () => void
  readonly unlatchMs?: number
  readonly wait?: (ms: number) => Promise<void>
}

export async function wakeTmux({
  pane, text, run, isCurrent, onUnconfirmed, onUnlatch, unlatchMs = DEFAULT_UNLATCH_MS, wait = sleep,
}: TmuxWakeOptions): Promise<void> {
  if (!isCurrent()) return
  if (await run(['send-keys', '-t', pane, '-l', text])) {
    await wait(300)
    if (!isCurrent()) return
    await run(['send-keys', '-t', pane, 'Enter'])
  }
  if (!isCurrent()) return
  await wait(DIAGNOSTIC_MS)
  if (!isCurrent()) return
  onUnconfirmed()
  await wait(unlatchMs - DIAGNOSTIC_MS)
  // An inbox drain confirms delivery. The deadline only clears the old
  // latch for future mail and never submits another prompt.
  if (isCurrent()) onUnlatch()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
