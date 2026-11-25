import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import type { Socket } from 'node:net'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import type { PeerInfo } from './peer.js'

/** Linux `socket.h`. */
export const SOL_SOCKET = 1
export const SO_PEERCRED = 17
/** Darwin `<sys/un.h>`. Both options are required. */
export const SOL_LOCAL = 0
export const LOCAL_PEERCRED = 0x001
export const LOCAL_PEERPID = 0x002
/** `RLIMIT_CORE` on Linux and Darwin. */
const RLIMIT_CORE = 4
/** `struct xucred` up through `cr_groups[16]`. uid is the second 32-bit word. */
const XUCRED_SIZE = 76
/** `sizeof(struct proc_bsdinfo)`. `pbi_ppid` is the fifth 32-bit word. */
const PROC_BSDINFO_SIZE = 136
const PROC_PIDTBSDINFO = 3
const PPID_OFFSET = 16

type Libc = {
  symbols: {
    getsockopt: (fd: number, level: number, name: number, value: ReturnType<typeof ptr>, len: ReturnType<typeof ptr>) => number
    setrlimit: (resource: number, lim: ReturnType<typeof ptr>) => number
  }
}

export type DarwinSys = {
  getsockopt: (fd: number, level: number, name: number, buf: Uint8Array, len: Uint32Array) => number
  pidpath: (pid: number, buf: Uint8Array) => number
  pidinfo: (pid: number, flavor: number, buf: Uint8Array) => number
}

let linuxLib: Libc | undefined
let coreLimitSet = false

function libc(): Libc {
  if (!linuxLib) {
    linuxLib = dlopen('libc.so.6', {
      getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    }) as Libc
  }
  return linuxLib
}

/** §4b: no core file can contain a node secret or an inbox token. */
export function disableCoreDumps(): void {
  if (coreLimitSet) return
  const lim = new Uint8Array(16)
  const rc = process.platform === 'darwin'
    ? darwinLib().symbols.setrlimit(RLIMIT_CORE, ptr(lim))
    : libc().symbols.setrlimit(RLIMIT_CORE, ptr(lim))
  if (rc !== 0) throw new Error('could not disable core dumps')
  coreLimitSet = true
}

/** The field after the command word, which may itself contain spaces and parentheses. */
export function ppidFromStat(text: string): number | undefined {
  const end = text.lastIndexOf(')')
  if (end < 0) return undefined
  const ppid = Number(text.slice(end + 1).trim().split(/\s+/)[1])
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined
}

/** Field 22 of `/proc/<pid>/stat` (index 19 after the command word). */
export function startTimeFromStat(text: string): string | undefined {
  const end = text.lastIndexOf(')')
  if (end < 0) return undefined
  const ticks = text.slice(end + 1).trim().split(/\s+/)[19]
  if (!ticks || !/^\d+$/.test(ticks)) return undefined
  return `linux:${ticks}`
}

const DARWIN_START_SEC = 120
const DARWIN_START_USEC = 128

export function darwinStartTime(info: Uint8Array): string | undefined {
  if (info.byteLength < DARWIN_START_USEC + 8) return undefined
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength)
  const sec = view.getBigUint64(DARWIN_START_SEC, true)
  const usec = view.getBigUint64(DARWIN_START_USEC, true)
  return `darwin:${sec}.${usec}`
}

export type ProcessIdentity = { pid: number; exe: string; started: string }

/** Darwin `proc_pidpath` and `proc_bsdinfo` start time. Tests inject `sys` and do not dlopen. */
export function processIdentityFromDarwin(pid: number, sys: DarwinSys): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const path = new Uint8Array(4096)
  const n = sys.pidpath(pid, path)
  if (n <= 0) return undefined
  const linked = new TextDecoder().decode(path.subarray(0, n)).replace(/\0+$/, '')
  let exe: string
  try { exe = realpathSync(linked) } catch { return undefined }
  const info = new Uint8Array(PROC_BSDINFO_SIZE)
  if (sys.pidinfo(pid, PROC_PIDTBSDINFO, info) !== PROC_BSDINFO_SIZE) return undefined
  const started = darwinStartTime(info)
  if (!started) return undefined
  return { pid, exe, started }
}

/** Live pid, exe realpath, and start time. A reused pid has a different start time. */
export function processIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'darwin') return processIdentityFromDarwin(pid, darwinSys())
    if (process.platform !== 'linux') return undefined
    const started = startTimeFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    if (!started) return undefined
    return { pid, exe: realpathSync(readlinkSync(`/proc/${pid}/exe`)), started }
  } catch {
    return undefined
  }
}

function linuxStarted(pid: number): string | undefined {
  try { return startTimeFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return undefined }
}

function currentUid(): number {
  if (process.getuid === undefined) throw new Error('no uid')
  return process.getuid()
}

/**
 * Linux `SO_PEERCRED`, then `/proc/<pid>/exe` and `/proc/<pid>/stat`. A mismatch fails closed.
 * Accepted residual risk: the pid from getsockopt is not pinned to those `/proc` reads.
 * A hit needs an fd handoff, reuse of that pid by the configured pipe, and a parent whose pid
 * and start time are still a registered agent. That sits inside the same-user baseline.
 * Start time narrows reuse. It does not close the window. `SO_PEERPIDFD` is not used.
 */
export function peerFromLinux(fd: number, selfUid = currentUid()): PeerInfo | undefined {
  const buf = new Uint8Array(12)
  const len = new Uint32Array([12])
  if (libc().symbols.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(buf), ptr(len)) !== 0 || len[0] < 12) return undefined
  const view = new DataView(buf.buffer, buf.byteOffset, 12)
  const pid = view.getInt32(0, true)
  const uid = view.getUint32(4, true)
  let exe: string | undefined
  try { exe = readlinkSync(`/proc/${pid}/exe`) } catch { return undefined }
  let ppid: number | undefined
  try { ppid = ppidFromStat(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return undefined }
  const started = linuxStarted(pid)
  const parentStarted = ppid !== undefined && ppid > 0 ? linuxStarted(ppid) : undefined
  if (pid <= 0 || uid !== selfUid || !exe || ppid === undefined || ppid <= 0 || !started || !parentStarted) return undefined
  return { pid, exe, ppid, started, parentStarted }
}

/**
 * macOS `LOCAL_PEERPID` and `LOCAL_PEERCRED`, then `proc_pidpath` / `proc_pidinfo`.
 * Either socket option missing, or a uid other than this process, fails closed.
 * The same accepted pid-reuse window sits between those socket options and `proc_pidinfo`.
 */
export function peerFromDarwin(fd: number, selfUid: number, sys: DarwinSys): PeerInfo | undefined {
  const pidBuf = new Uint8Array(4)
  const pidLen = new Uint32Array([4])
  if (sys.getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, pidBuf, pidLen) !== 0) return undefined
  const cred = new Uint8Array(XUCRED_SIZE)
  const credLen = new Uint32Array([XUCRED_SIZE])
  if (sys.getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, cred, credLen) !== 0) return undefined
  const pid = new DataView(pidBuf.buffer, pidBuf.byteOffset, 4).getUint32(0, true)
  const uid = new DataView(cred.buffer, cred.byteOffset, cred.byteLength).getUint32(4, true)
  const path = new Uint8Array(4096)
  const n = sys.pidpath(pid, path)
  if (n <= 0) return undefined
  const exe = new TextDecoder().decode(path.subarray(0, n)).replace(/\0+$/, '')
  const info = new Uint8Array(PROC_BSDINFO_SIZE)
  if (sys.pidinfo(pid, PROC_PIDTBSDINFO, info) !== PROC_BSDINFO_SIZE) return undefined
  const view = new DataView(info.buffer, info.byteOffset, info.byteLength)
  const ppid = view.getUint32(PPID_OFFSET, true)
  const started = darwinStartTime(info)
  const parentInfo = new Uint8Array(PROC_BSDINFO_SIZE)
  if (sys.pidinfo(ppid, PROC_PIDTBSDINFO, parentInfo) !== PROC_BSDINFO_SIZE) return undefined
  const parentStarted = darwinStartTime(parentInfo)
  if (pid <= 0 || uid !== selfUid || !exe || ppid <= 0 || !started || !parentStarted) return undefined
  return { pid, exe, ppid, started, parentStarted }
}

type DarwinLib = {
  symbols: {
    getsockopt: (fd: number, level: number, name: number, value: ReturnType<typeof ptr>, len: ReturnType<typeof ptr>) => number
    setrlimit: (resource: number, lim: ReturnType<typeof ptr>) => number
    proc_pidpath: (pid: number, buf: ReturnType<typeof ptr>, size: number) => number
    proc_pidinfo: (pid: number, flavor: number, arg: number, buf: ReturnType<typeof ptr>, size: number) => number
  }
}

let darwin: DarwinLib | undefined

function darwinLib(): DarwinLib {
  if (!darwin) {
    darwin = dlopen('libSystem.B.dylib', {
      getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }) as DarwinLib
  }
  return darwin
}

function darwinSys(): DarwinSys {
  const lib = darwinLib()
  return {
    getsockopt: (fd, level, name, buf, len) => lib.symbols.getsockopt(fd, level, name, ptr(buf), ptr(len)),
    pidpath: (pid, buf) => lib.symbols.proc_pidpath(pid, ptr(buf), buf.length),
    pidinfo: (pid, flavor, buf) => lib.symbols.proc_pidinfo(pid, flavor, 0, ptr(buf), buf.length),
  }
}

function socketFd(sock: Socket): number | undefined {
  const fd = (sock as unknown as { _handle?: { fd?: number } })._handle?.fd
  return typeof fd === 'number' && fd >= 0 ? fd : undefined
}

/** Peer identity for a gateway socket. Missing credentials fail closed (`undefined`). */
export function readPeer(sock: Socket): PeerInfo | undefined {
  const fd = socketFd(sock)
  if (fd === undefined) return undefined
  try {
    if (process.platform === 'linux') return peerFromLinux(fd)
    if (process.platform === 'darwin') return peerFromDarwin(fd, currentUid(), darwinSys())
    return undefined
  } catch {
    return undefined
  }
}
