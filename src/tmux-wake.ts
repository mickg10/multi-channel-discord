interface TmuxWakeOptions {
  readonly pane: string
  readonly text: string
  readonly run: (args: string[]) => Promise<boolean>
  /** False once the agent drains the inbox or the wake is superseded. */
  readonly isCurrent: () => boolean
  readonly onUnconfirmed: () => void
  readonly wait?: (ms: number) => Promise<void>
}

export async function wakeTmux({ pane, text, run, isCurrent, onUnconfirmed, wait = sleep }: TmuxWakeOptions): Promise<void> {
  if (!isCurrent()) return
  const typed = await run(['send-keys', '-t', pane, '-l', text])
  if (typed) {
    await wait(300)
    if (!isCurrent()) return
    const entered = await run(['send-keys', '-t', pane, 'Enter'])
    if (entered && isCurrent()) await wait(30_000)
  }
  // Only a real inbox drain can confirm delivery. A timeout opens the
  // latch for future mail and never submits another prompt on its own.
  if (isCurrent()) onUnconfirmed()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
