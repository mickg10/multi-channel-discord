/** A retired MCP remains callable, but must fail every tool before any side effect. */
export class BusOwnership {
  private held?: { name: string; since: string; reclaim: boolean }
  constructor(private readonly log: (line: string) => void = line => { process.stderr.write(line) }) {}
  retire(name: string, now = new Date(), reclaim = true): void {
    if (this.held) return
    this.held = { name, since: now.toISOString(), reclaim }
    this.log(JSON.stringify({ event: 'bus_name_held', name, since: this.held.since }) + '\n')
  }
  clear(): void { this.held = undefined }
  error(): string | undefined {
    if (this.held && !this.held.reclaim) return `a newer conversation superseded bus name ${this.held.name} at ${this.held.since}; this thread is offline`
    return this.held && `bus name ${this.held.name} is held by another instance since ${this.held.since}; reconnect this MCP (/mcp) to reclaim`
  }
  assertAvailable(): void { const error = this.error(); if (error) throw new Error(error) }
}
