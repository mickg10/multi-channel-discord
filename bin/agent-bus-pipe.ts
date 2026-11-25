#!/usr/bin/env bun
import { splicePipe } from '../src/gateway/pipe.js'

const sock = process.argv[2] || process.env.AGENT_BUS_SOCK
if (!sock) {
  process.stderr.write('agent-bus-pipe: socket path required\n')
  process.exit(2)
}
splicePipe(sock).then(
  code => process.exit(code),
  err => {
    process.stderr.write(`agent-bus-pipe: ${err instanceof Error ? err.message : 'connect failed'}\n`)
    process.exit(1)
  },
)
