type WakeOutcome = 'confirmed' | 'failed' | 'cancelled'

interface TmuxWakeOptions {
  readonly pane: string
  readonly text: string
  /** Return stdout, or undefined when the command fails. */
  readonly run: (args: string[]) => Promise<string | undefined>
  readonly isCurrent: () => boolean
  readonly wait?: (ms: number) => Promise<void>
}

export async function wakeTmux({ pane, text, run, isCurrent, wait = sleep }: TmuxWakeOptions): Promise<WakeOutcome> {
  const capture = () => run(['capture-pane', '-p', '-J', '-S', '-30', '-t', pane])
  const occurrences = (snapshot: string) => snapshot.split(text).length - 1
  const hasNewWake = (before?: string, after?: string) => before !== undefined && after !== undefined &&
    occurrences(after) > occurrences(before)

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isCurrent()) return 'cancelled'
    const before = await capture()
    if (!isCurrent()) return 'cancelled'
    const typed = await run(['send-keys', '-t', pane, '-l', text])
    if (typed !== undefined) {
      await wait(300)
      if (!isCurrent()) return 'cancelled'
      const entered = await run(['send-keys', '-t', pane, 'Enter'])
      if (entered !== undefined) {
        await wait(3_000)
        if (!isCurrent()) return 'cancelled'
        if (hasNewWake(before, await capture())) return isCurrent() ? 'confirmed' : 'cancelled'
      }
    }
    if (!isCurrent()) return 'cancelled'
    if (attempt === 0) await wait(30_000)
  }
  return 'failed'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
