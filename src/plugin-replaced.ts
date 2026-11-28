/** Text for every tool call after this client is told `replaced`. */
export function replacedToolText(name: string, reclaimAllowed: boolean, routerSupportsReclaim: boolean): string {
  if (!reclaimAllowed) return `replaced: a newer conversation superseded the bus name "${name}".`
  if (routerSupportsReclaim) return `replaced: waiting to reclaim the bus name "${name}". Discord tools are unavailable until the active holder disconnects.`
  return `replaced: a newer session took over the bus name "${name}". This router does not support automatic reclaim.`
}
