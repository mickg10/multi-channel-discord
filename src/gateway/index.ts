export { stepDelivery } from './deliver.js'
export { FakeAdapter } from './fake-adapter.js'
export { Gateway, type GatewayOpts } from './gateway.js'
export { verifyPipePeer, type PeerInfo, type PeerVerdict } from './peer.js'
export {
  disableCoreDumps, peerFromDarwin, peerFromLinux, ppidFromStat, readPeer,
  LOCAL_PEERCRED, LOCAL_PEERPID, SO_PEERCRED, SOL_LOCAL, SOL_SOCKET,
  type DarwinSys,
} from './peer-cred.js'
export { splicePipe } from './pipe.js'
export {
  adaptersByKind, gatewayMain, loadConfig, readNodeSecret, registerAdapter, startHost,
  type GatewayConfig, type HostHandle,
} from './host.js'
export { Registry, type AgentRec } from './registry.js'
export { RouterLink } from './router-link.js'
export { WakeStore, type Attempt, type AttemptState } from './store.js'
export {
  assertAlias, assertNodeSecret, buildNudge, identityKey, makeNudge, nudgeNumber, nudgeText, redactFrame,
  type Adapter, type DeliveryResult, type GatewayToRouterMessage, type Kind, type LeaseResult, type Nudge,
  type RouterToGatewayMessage, type Target, type WakeResult,
} from './types.js'
