export interface LifecycleFields {
  name?: string | null
  instanceId?: string
  host?: string
  agent?: string
  remoteAddress?: string
  reason: string
}
export function lifecycleLine(event: string, fields: LifecycleFields): string {
  // Deliberate allowlist: never serialize a registration frame or its credentials.
  return JSON.stringify({ event, name: fields.name ?? null, instanceId: fields.instanceId ?? null,
    host: fields.host ?? null, agent: fields.agent ?? null, remoteAddress: fields.remoteAddress ?? null,
    reason: fields.reason }) + '\n'
}
