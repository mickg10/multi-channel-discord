/**
 * Session naming — derive a name from git branch, package.json, or directory.
 * Ported from the WhatsApp project.
 */

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

export interface NamingContext {
  readonly gitBranch?: string
  readonly packageName?: string
  readonly dirName: string
}

const GENERIC_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD'])

/** Read naming context from the project directory. */
export async function readNamingContext(cwd: string): Promise<NamingContext> {
  const ctx: { gitBranch?: string; packageName?: string; dirName: string } = { dirName: basename(cwd) }

  // Try git branch
  try {
    const branch = await new Promise<string>((resolve, reject) => {
      const proc = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
      let out = ''
      proc.stdout.on('data', (d: Buffer) => { out += d })
      proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject())
      proc.on('error', reject)
    })
    if (branch && !GENERIC_BRANCHES.has(branch)) {
      ctx.gitBranch = branch
    }
  } catch {}

  // Try package.json name
  try {
    const pkg = JSON.parse(await readFile(`${cwd}/package.json`, 'utf-8')) as { name?: string }
    if (typeof pkg.name === 'string' && pkg.name) {
      ctx.packageName = pkg.name
    }
  } catch {}

  return ctx
}

/** Pick the best session name from the context. */
export function pickSessionName(ctx: Readonly<NamingContext>): string {
  if (ctx.gitBranch) return ctx.gitBranch
  if (ctx.packageName) return ctx.packageName
  return ctx.dirName
}

/** What naming needs from a Claude Code session file (~/.claude/sessions/<pid>.json). */
export interface ClaudeSession {
  readonly cwd?: string
  readonly name?: string
  readonly nameSource?: string
}

/** The session file of the Claude Code process `pid`; undefined if `pid` is not one. */
export function readClaudeSession(pid: string): ClaudeSession | undefined {
  try {
    return JSON.parse(readFileSync(`${process.env.HOME}/.claude/sessions/${pid}.json`, 'utf8')) as ClaudeSession
  } catch { return undefined }
}

function parentPid(pid: string): string | undefined {
  try { return execFileSync('ps', ['-o', 'ppid=', '-p', pid]).toString().trim() || undefined } catch { return undefined }
}

/**
 * The Claude Code session a process runs under: the nearest ancestor of `pid` (inclusive) that
 * has a session file. Claude starts the plugin through a runner, and that starts the supervisor,
 * so neither our parent nor DISCORD_PARENT_PID is Claude itself.
 */
export function findClaudeSession(
  pid: string,
  read: (pid: string) => ClaudeSession | undefined = readClaudeSession,
  parentOf: (pid: string) => string | undefined = parentPid,
): (ClaudeSession & { readonly pid: string }) | undefined {
  for (let i = 0; i < 8 && pid && pid !== '0' && pid !== '1'; i++) {
    const session = read(pid)
    if (session) return { ...session, pid }
    pid = parentOf(pid) ?? ''
  }
  return undefined
}

/** Names Claude Code generates itself. A derived name (e.g. "src-9a") changes on every start. */
const GENERATED_NAME_SOURCES = new Set(['auto', 'derived', 'collision'])

/** The name the user gave a session with /name, spaces made dashes; undefined for a generated name. */
export function sessionAlias(session: ClaudeSession | undefined): string | undefined {
  const name = session?.name?.trim()
  return name && !GENERATED_NAME_SOURCES.has(session?.nameSource ?? '') ? name.replace(/\s+/g, '-') : undefined
}
