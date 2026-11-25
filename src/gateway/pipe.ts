import { connect } from 'node:net'
import type { Readable, Writable } from 'node:stream'

/**
 * Byte copy between the agent stdio and the gateway socket.
 * No framing, no JSON, no identity. The gateway checks the peer.
 */
export function splicePipe(sockPath: string, input: Readable = process.stdin, output: Writable = process.stdout): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath)
    let settled = false
    const finish = (code: number) => {
      if (settled) return
      settled = true
      resolve(code)
    }
    sock.on('error', err => {
      if (settled) return
      settled = true
      reject(err)
    })
    sock.on('data', chunk => { output.write(chunk) })
    sock.on('end', () => { output.end(); finish(0) })
    input.on('data', chunk => { sock.write(chunk) })
    input.on('end', () => sock.end())
    input.resume()
  })
}
