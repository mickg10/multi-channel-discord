/**
 * Self-updating MCP stdio supervisor for the agent-bus client.
 *
 * The agent (Claude Code, Codex, agy, ...) talks MCP over our stdin/stdout. We run the real
 * client (src/plugin.ts) as a child and relay newline-delimited JSON-RPC both ways. Every
 * DISCORD_UPDATE_INTERVAL seconds we fast-forward the client git checkout to origin/release
 * (DISCORD_UPDATE_BRANCH; CI moves it only after tests pass); when its HEAD
 * changes (or the child dies) we restart the child *without* the agent noticing:
 * the cached `initialize` request + `initialized` notification are replayed to the new child,
 * the duplicate initialize response is swallowed, and `notifications/tools/list_changed` tells
 * the agent to refetch tools. Restarts wait until no request is in flight.
 *
 * Code dir: $DISCORD_CLIENT_DIR, else ~/src/multi-channel-discord if it is a git checkout,
 * else this package. So the Claude plugin cache, Codex and agy all run the same updatable clone.
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const log = (m: string) => process.stderr.write(`agent-bus supervisor: ${m}\n`)

/** Dedicated runtime checkout (release branch, never edited by hand or by agents). */
export const RUNTIME_DIR = join(homedir(), '.local/share/agent-bus/multi-channel-discord')

function pickCodeDir(): string {
  const env = process.env.DISCORD_CLIENT_DIR
  if (env && existsSync(join(env, 'src/plugin.ts'))) return env
  // Prefer the runtime checkout: ~/src/multi-channel-discord is a *development* clone that agents
  // edit — live clients must never execute someone's uncommitted work.
  for (const dir of [RUNTIME_DIR, join(homedir(), 'src/multi-channel-discord')]) {
    if (existsSync(join(dir, '.git')) && existsSync(join(dir, 'src/plugin.ts'))) return dir
  }
  return resolve(import.meta.dir, '..')
}

const codeDir = pickCodeDir()
const isGit = existsSync(join(codeDir, '.git'))
const intervalSec = parseInt(process.env.DISCORD_UPDATE_INTERVAL ?? '300', 10)
const bun = process.execPath
// The agent process, for the client's naming / instance id / tmux lookup.
process.env.DISCORD_PARENT_PID ??= String(process.ppid)

// A supervisor survives child updates and identifies a single non-Claude MCP instance.
process.env.DISCORD_SUPERVISOR_PID = String(process.pid)

const git = (...args: string[]) => execFileSync('git', ['-C', codeDir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
const head = () => { try { return isGit ? git('rev-parse', 'HEAD') : '' } catch { return '' } }
let runningHead = head()

let child: ChildProcess | null = null
let childBuf = ''
let initRequest: string | null = null
let initializedNote: string | null = null
let swallowId: string | number | null = null
const inflight = new Set<string | number>()
let restartWanted = false
let restarting = false
let shuttingDown = false

function start(replay: boolean): void {
  child = spawn(bun, [join(codeDir, 'src/plugin.ts')], { cwd: codeDir, stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
  childBuf = ''
  child.stdout!.on('data', (d: Buffer) => {
    childBuf += d.toString()
    let i: number
    while ((i = childBuf.indexOf('\n')) >= 0) {
      const line = childBuf.slice(0, i); childBuf = childBuf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && msg.method === undefined) {
          if (swallowId !== null && msg.id === swallowId) { swallowId = null; continue }
          inflight.delete(msg.id)
        }
      } catch {}
      process.stdout.write(line + '\n')
    }
    maybeRestart()
  })
  child.on('exit', (code, sig) => {
    if (shuttingDown) return
    log(`client exited (${code ?? sig}); restarting`)
    child = null
    inflight.clear()
    setTimeout(() => start(true), 1000)
  })
  if (replay && initRequest) {
    swallowId = JSON.parse(initRequest).id
    child.stdin!.write(initRequest + '\n')
    if (initializedNote) child.stdin!.write(initializedNote + '\n')
    // Tools may have changed with the new code.
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n')
  }
}

function restart(reason: string): void {
  if (!child || restarting) return
  restarting = true
  log(`restarting client: ${reason}`)
  const old = child
  old.removeAllListeners('exit')
  old.once('exit', () => { restarting = false; start(true) })
  old.kill('SIGTERM')
  setTimeout(() => { try { old.kill('SIGKILL') } catch {} }, 3000)
}

function maybeRestart(): void {
  if (restartWanted && inflight.size === 0) { restartWanted = false; restart(`code updated to ${runningHead.slice(0, 7)}`) }
}

// agent -> child
let inBuf = ''
process.stdin.on('data', (d: Buffer) => {
  inBuf += d.toString()
  let i: number
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i); inBuf = inBuf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') initRequest = line
      else if (msg.method === 'notifications/initialized') initializedNote = line
      if (msg.id !== undefined && msg.method !== undefined) inflight.add(msg.id)
    } catch {}
    child?.stdin?.write(line + '\n')
  }
})
// Never leave the client behind: it would keep reconnecting as an orphan.
process.on('exit', () => { try { child?.kill('SIGTERM') } catch {} })
process.stdin.on('end', () => { shuttingDown = true; child?.stdin?.end(); setTimeout(() => { try { child?.kill('SIGTERM') } catch {}; process.exit(0) }, 1500) })
// Agent died without closing our stdin (SIGKILL etc.): notice via reparenting.
setInterval(() => { if (process.ppid === 1) { shuttingDown = true; try { child?.kill('SIGTERM') } catch {}; process.exit(0) } }, 10_000).unref()
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => { shuttingDown = true; child?.kill('SIGTERM'); setTimeout(() => process.exit(0), 1500) })

// Periodic self-update (git fast-forward only; never touches local changes).
function checkUpdate(): void {
  if (!isGit || intervalSec <= 0) return
  // Follow origin/release (moved by CI only after tests pass), not main: a bad push must not
  // reach live agents. Fast-forward only, so a dev checkout that is ahead is left alone.
  const branch = process.env.DISCORD_UPDATE_BRANCH ?? 'release'
  try {
    git('fetch', '-q', 'origin', branch)
    git('merge', '--ff-only', '-q', `origin/${branch}`)
  } catch {}
  const now = head()
  if (now && now !== runningHead) {
    try { execFileSync(bun, ['install', '--no-summary'], { cwd: codeDir, stdio: ['ignore', 'ignore', 'ignore'] }) } catch {}
    log(`update ${runningHead.slice(0, 7)} -> ${now.slice(0, 7)}`)
    runningHead = now
    restartWanted = true
    maybeRestart()
  }
}

log(`code=${codeDir}${isGit ? ` @${runningHead.slice(0, 7)}` : ''} update=${isGit && intervalSec > 0 ? `${intervalSec}s` : 'off'}`)
start(false)
if (isGit && intervalSec > 0) setInterval(checkUpdate, intervalSec * 1000).unref()
