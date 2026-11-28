export const PING_MS = 30_000
export const SILENCE_MS = 75_000

/** App-level heartbeats detect a deaf application even when TCP stays established. */
export function clientKeepalive(socket: Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'removeEventListener'>,
  schedule: typeof setInterval = setInterval, cancel: typeof clearInterval = clearInterval): () => void {
  let missed = 0
  let stopped = false
  const ping = () => {
    if (stopped) return
    if (missed >= 2) { stop(); socket.close(); return }
    missed++
    try { socket.send(JSON.stringify({ type: 'ping' })) } catch { stop(); socket.close() }
  }
  const message = (event: Event) => {
    try {
      const frame = JSON.parse(String((event as MessageEvent).data))
      if (frame.type === 'pong') missed = 0
      else if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }))
    } catch { /* Protocol handler reports malformed messages. */ }
  }
  const timer = schedule(ping, PING_MS)
  timer.unref?.()
  function stop() {
    if (stopped) return
    stopped = true
    cancel(timer)
    socket.removeEventListener('message', message)
    socket.removeEventListener('close', stop)
    socket.removeEventListener('error', stop)
  }
  socket.addEventListener('message', message)
  socket.addEventListener('close', stop)
  socket.addEventListener('error', stop)
  ping()
  return stop
}
