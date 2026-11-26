import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const BUS_ALIAS_MAX = 128
const BUS_ALIAS_PATTERN = /^[-\w.@:/]+$/

export function isBusAlias(name: unknown): name is string {
  return typeof name === 'string' && name.length <= BUS_ALIAS_MAX && BUS_ALIAS_PATTERN.test(name)
}

/** A local override belongs to one MCP instance, independently of its display name. */
export class BusAlias {
  private readonly path: string
  name?: string

  constructor(stateDir: string, instanceId: string) {
    const key = createHash('sha256').update(instanceId).digest('hex')
    this.path = join(stateDir, 'bus-aliases', key)
    this.restore()
  }

  restore(): void {
    if (this.name) return
    try {
      const saved = readFileSync(this.path, 'utf8')
      if (isBusAlias(saved)) this.name = saved
    } catch {}
  }

  save(name: string): void {
    this.name = name
    const tmp = this.path + '.' + randomUUID()
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      writeFileSync(tmp, name, { mode: 0o600, flag: 'wx' })
      renameSync(tmp, this.path)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }
}
