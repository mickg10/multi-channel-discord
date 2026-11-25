import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import type { Adapter, Target, Nudge, WakeResult } from "../../types.js";

// The gateway/router owns durable single-flight and attempt persistence.
// wake makes one admission attempt. Recover uncertain attempts via reconcile.

type Method =
  | "initialize"
  | "thread/queue/add"
  | "thread/queue/list"
  | "thread/read"
  | "thread/turns/list"
  | "thread/items/list";

export interface CodexRpc {
  request(method: Method, params: object): Promise<unknown>;
  notify(method: "initialized"): void;
  close(): void;
}

type Connect = (path: string, signal: AbortSignal) => Promise<CodexRpc>;

export class CodexRpcError extends Error {
  constructor(readonly code: number, readonly data?: unknown) {
    super("Codex RPC rejected request");
  }
}

class Unavailable extends Error {}
class ProtocolError extends Error {}

const DEADLINE_MS = 5_000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
// Exceeding these read budgets leaves recovery uncertain; the gateway retains mail.
const MAX_SESSION_BYTES = 4 * MAX_MESSAGE_BYTES;
const MAX_PAGES = 128;
const PAGE_SIZE = 50;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError();
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new ProtocolError();
  return value;
}

function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function inspectPrivateParent(path: string, uid: number) {
  const parent = dirname(path);
  const info = await lstat(parent, { bigint: true });
  if (!info.isDirectory() || info.uid !== BigInt(uid) || (info.mode & 0o7777n) !== 0o700n ||
      await realpath(parent) !== parent) {
    throw new Unavailable();
  }
  return info;
}

async function inspectSocket(registeredPath: string) {
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(registeredPath) || normalize(registeredPath) !== registeredPath ||
      registeredPath.includes("\0")) throw new Unavailable();

  const registrationParent = await inspectPrivateParent(registeredPath, uid);
  const entry = await lstat(registeredPath, { bigint: true });
  if (entry.uid !== BigInt(uid)) throw new Unavailable();

  let path = registeredPath;
  let socketParent = registrationParent;
  let socket = entry;
  if (entry.isSymbolicLink()) {
    path = resolve(dirname(registeredPath), await readlink(registeredPath));
    socketParent = await inspectPrivateParent(path, uid);
    socket = await lstat(path, { bigint: true });
  }

  // Prevent address truncation and reject any further symlink in the resolved path.
  const pathLimit = process.platform === "linux" ? 107 : 103;
  if (Buffer.byteLength(path) > pathLimit || !socket.isSocket() || socket.uid !== BigInt(uid) ||
      (socket.mode & 0o7777n) !== 0o600n || await realpath(path) !== path) {
    throw new Unavailable();
  }
  return { path, identities: [registrationParent, entry, socketParent, socket] };
}

export function supportsCodexUnixWebSocket(version: string | undefined): boolean {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version ?? "");
  if (!match || match[0] !== version) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) &&
    (major > 1 || (major === 1 && (minor > 3 || (minor === 3 && patch >= 13))));
}

const connectUnix: Connect = async (registeredPath, signal) => {
  // The control endpoint uses WebSocket-over-Unix, which requires Bun >=1.3.13.
  if (!supportsCodexUnixWebSocket(process.versions.bun) || typeof WebSocket !== "function") {
    throw new Unavailable();
  }
  let before;
  try {
    before = await inspectSocket(registeredPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw new Unavailable();
    throw error;
  }
  signal.throwIfAborted();
  const { path } = before;
  // Restrict the resolved address to path characters Bun can use verbatim in the URL.
  if (/[^a-zA-Z0-9/._~-]/.test(path)) throw new Unavailable();
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws+unix://${path}`);
  } catch {
    throw new Unavailable();
  }
  const opened = Promise.withResolvers<void>();
  let connected = false;
  let terminal: Error | undefined;
  let nextId = 0;
  let inputBytes = 0;
  let pending: { id: number; resolve(value: unknown): void; reject(error: unknown): void } | undefined;

  function close(error = new Error("Codex connection closed")) {
    if (terminal) return;
    terminal = error;
    opened.reject(error);
    pending?.reject(error);
    pending = undefined;
    signal.removeEventListener("abort", abort);
    if ("terminate" in ws && typeof ws.terminate === "function") ws.terminate();
    else ws.close();
  }

  const abort = () => close();
  signal.addEventListener("abort", abort, { once: true });
  ws.addEventListener("open", () => {
    connected = true;
    opened.resolve();
  }, { once: true });
  const disconnected = () => close(connected ? undefined : new Unavailable());
  ws.addEventListener("error", disconnected);
  ws.addEventListener("close", disconnected, { once: true });
  ws.addEventListener("message", ({ data }) => {
    if (terminal) return;
    try {
      if (typeof data !== "string") throw new ProtocolError();
      const bytes = Buffer.byteLength(data);
      inputBytes += bytes;
      if (bytes > MAX_MESSAGE_BYTES || inputBytes > MAX_SESSION_BYTES) throw new ProtocolError();
      receive(data);
    } catch {
      close(new ProtocolError());
    }
  });

  function receive(line: string) {
    const message = record(JSON.parse(line));
    if ("jsonrpc" in message && message.jsonrpc !== "2.0") throw new ProtocolError();
    if ("method" in message) {
      if (typeof message.method !== "string" || "result" in message || "error" in message) {
        throw new ProtocolError();
      }
      // Ignore notifications. Close on a server request without answering it.
      if ("id" in message) throw new ProtocolError();
      return;
    }

    const request = pending;
    if (!request || message.id !== request.id || ("result" in message) === ("error" in message)) {
      throw new ProtocolError();
    }
    if ("error" in message) {
      const error = record(message.error);
      if (typeof error.code !== "number" || !Number.isSafeInteger(error.code) ||
          typeof error.message !== "string") throw new ProtocolError();
      request.reject(new CodexRpcError(error.code, error.data));
    } else {
      request.resolve(message.result);
    }
    pending = undefined;
  }

  try {
    await opened.promise;
    const after = await inspectSocket(registeredPath);
    if (after.path !== path || after.identities.some((info, index) => {
      const previous = before.identities[index];
      return info.dev !== previous.dev || info.ino !== previous.ino;
    })) throw new Unavailable();
    signal.throwIfAborted();
    if (terminal) throw terminal;

  } catch (error) {
    close();
    if (["ENOENT", "ENOTDIR", "ECONNREFUSED"].includes(String(errorCode(error)))) {
      throw new Unavailable();
    }
    throw error;
  }

  function write(message: object) {
    signal.throwIfAborted();
    if (terminal) throw terminal;
    if (ws.readyState !== WebSocket.OPEN) throw new ProtocolError();
    const frame = JSON.stringify(message);
    if (Buffer.byteLength(frame) > MAX_MESSAGE_BYTES) throw new ProtocolError();
    ws.send(frame);
  }

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        if (pending) throw new ProtocolError();
        const id = ++nextId;
        pending = { id, resolve, reject };
        try {
          write({ id, method, params });
        } catch (error) {
          close();
          reject(error);
        }
      });
    },
    notify(method) {
      write({ method, params: {} });
    },
    close,
  };
}

function supportedVersion(userAgent: unknown): boolean {
  if (typeof userAgent !== "string") return false;
  const match = /^[^/\r\n]+\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?: |$)/.exec(userAgent);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) && (major > 0 || minor >= 170);
}

function page(value: unknown) {
  const result = record(value);
  return {
    data: array(result.data),
    nextCursor: result.nextCursor === null ? null : identifier(result.nextCursor),
  };
}

function queueId(value: unknown, clientId: string): string | undefined {
  const entry = record(value);
  const id = identifier(entry.id);
  if (entry.clientUserMessageId !== null && entry.clientUserMessageId !== undefined) {
    identifier(entry.clientUserMessageId);
  }
  if (entry.clientUserMessageId === clientId) return id;
}

function userMessageId(value: unknown, clientId: string): string | undefined {
  const item = record(value);
  if (item.type === "userMessage" && item.clientId === clientId) return identifier(item.id);
}

async function scanPages(
  first: unknown,
  next: (cursor: string) => Promise<unknown>,
  match: (value: unknown) => string | undefined | Promise<string | undefined>,
): Promise<string | undefined> {
  const seen = new Set<string>();
  let current = first;
  for (let count = 0; count < MAX_PAGES; count++) {
    const { data, nextCursor } = page(current);
    for (const row of data) {
      const id = await match(row);
      if (id) return id;
    }
    if (nextCursor === null) return;
    if (seen.has(nextCursor) || count + 1 === MAX_PAGES) throw new ProtocolError();
    seen.add(nextCursor);
    current = await next(nextCursor);
  }
}

function inlineMatch(turn: Record<string, unknown>, clientId: string): string | undefined {
  if (turn.status !== "completed" || turn.itemsView === "notLoaded" ||
      (turn.itemsView === "summary" && turn.items === undefined)) return;
  for (const item of array(turn.items)) {
    const id = userMessageId(item, clientId);
    if (id) return id;
  }
}

async function historyMatch(request: CodexRpc["request"], threadId: string, clientId: string) {
  const read = record(await request("thread/read", { threadId, includeTurns: true }));
  const thread = record(read.thread);
  if (thread.id !== threadId) throw new ProtocolError();
  for (const turn of array(thread.turns)) {
    const id = inlineMatch(record(turn), clientId);
    if (id) return id;
  }

  const params = { threadId, itemsView: "full", limit: PAGE_SIZE };
  return scanPages(
    await request("thread/turns/list", params),
    cursor => request("thread/turns/list", { ...params, cursor }),
    async value => {
      const turn = record(value);
      if (turn.status !== "completed") return;
      const inline = inlineMatch(turn, clientId);
      if (inline || turn.itemsView === "full") return inline;
      const turnId = identifier(turn.id);
      const itemParams = { threadId, turnId, limit: PAGE_SIZE, sortDirection: "asc" };
      return scanPages(
        await request("thread/items/list", itemParams),
        cursor => request("thread/items/list", { ...itemParams, cursor }),
        value => {
          const row = record(value);
          if (row.turnId !== turnId) throw new ProtocolError();
          return userMessageId(row.item, clientId);
        },
      );
    },
  );
}

type NativeDecision = { s: "held" | "refused" };

function nativeDecision(value: unknown): NativeDecision | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const status = (value as Record<string, unknown>).status;
  if (status === "held") return { s: "held" };
  if (status === "denied" || status === "refused") return { s: "refused" };
}

class RecoveryDecision extends Error {
  constructor(readonly result: NativeDecision) {
    super("Codex declined recovery read");
  }
}

function explicitDecision(error: unknown): NativeDecision | undefined {
  if (error instanceof RecoveryDecision) return error.result;
  if (error instanceof CodexRpcError) return nativeDecision(error.data);
}

function notice(nudge: Nudge) {
  const { text, clientId } = nudge;
  if (typeof text !== "string" || typeof clientId !== "string" ||
      clientId.length !== 36 || !/^bus-[a-f0-9]{32}$/.test(clientId)) return;
  const counter = /^\[agent-bus\] mail waiting \(id (0|[1-9][0-9]{0,15})\) — call check_inbox$/.exec(text);
  if (counter?.[0] !== text || !Number.isSafeInteger(Number(counter[1]))) return;
  return { clientId, text };
}

export interface CodexAdapterOptions {
  // Resolve from verified registration. No socket path is accepted from bus mail.
  resolveControlSocket(target: Target, signal: AbortSignal): string | undefined | Promise<string | undefined>;
  connect?: Connect;
  deadlineMs?: number;
}

export function createCodexAdapter({
  resolveControlSocket,
  connect = connectUnix,
  deadlineMs = DEADLINE_MS,
}: CodexAdapterOptions): Adapter {
  async function run(
    target: Target,
    operation: (rpc: CodexRpc, threadId: string) => Promise<WakeResult>,
    recovery = false,
  ): Promise<WakeResult> {
    const { conv: threadId } = target;
    if (target.kind !== "codex" || typeof threadId !== "string" || threadId.length === 0) return { s: "refused" };
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rpc: CodexRpc | undefined;

    async function execute(): Promise<WakeResult> {
      const controlSocket = await resolveControlSocket(target, abort.signal);
      abort.signal.throwIfAborted();
      if (!controlSocket) throw new Unavailable();
      const connection = await connect(controlSocket, abort.signal);
      if (abort.signal.aborted) {
        connection.close();
        return { s: "uncertain" };
      }
      rpc = connection;
      // Guard every write, including when an injected RPC ignores AbortSignal.
      const bounded: CodexRpc = {
        request(method, params) {
          abort.signal.throwIfAborted();
          return connection.request(method, params);
        },
        notify(method) {
          abort.signal.throwIfAborted();
          connection.notify(method);
        },
        close: () => connection.close(),
      };

      const initialized = record(await bounded.request("initialize", {
        clientInfo: { name: "agent-bus", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      }));
      if (!supportedVersion(initialized.userAgent)) return { s: recovery ? "uncertain" : "held" };
      bounded.notify("initialized");
      return operation(bounded, threadId);
    }

    const deadline = new Promise<WakeResult>(resolve => {
      timer = setTimeout(() => {
        abort.abort();
        resolve({ s: "uncertain" });
      }, deadlineMs);
    });

    try {
      return await Promise.race([execute(), deadline]);
    } catch (error) {
      const decision = explicitDecision(error);
      if (decision) return decision;
      if (recovery || error instanceof CodexRpcError) return { s: "uncertain" };
      if (error instanceof Unavailable && !rpc) return { s: "unavailable" };
      // Also support connection errors from an injected connector.
      if (!rpc && ["ENOENT", "ENOTDIR", "ECONNREFUSED"].includes(String(errorCode(error)))) {
        return { s: "unavailable" };
      }
      return { s: "uncertain" };
    } finally {
      clearTimeout(timer);
      abort.abort();
      rpc?.close();
    }
  }

  const queueParams = (threadId: string) => ({ threadId, limit: PAGE_SIZE });
  async function checkQueue(rpc: CodexRpc, threadId: string): Promise<WakeResult | undefined> {
    // On supported versions a valid experimental queue/list response establishes
    // the queue contract without a test enqueue or a thread subscription.
    try {
      const result = await rpc.request("thread/queue/list", queueParams(threadId));
      const decision = nativeDecision(result);
      if (decision) return decision;
      for (const row of page(result).data) queueId(row, "");
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === -32601) {
        return nativeDecision(error.data) ?? { s: "held" };
      }
      throw error;
    }
  }

  return {
    kind: "codex",
    async probe(target) {
      let ok = false;
      await run(target, async (rpc, threadId) => {
        ok = !(await checkQueue(rpc, threadId));
        return { s: "held" };
      });
      return { ok };
    },
    async wake(target, nudge) {
      const message = notice(nudge);
      if (!message) return { s: "refused" };
      return run(target, async (rpc, threadId) => {
        const gate = await checkQueue(rpc, threadId);
        if (gate) return gate;
        const result = await rpc.request("thread/queue/add", {
          threadId,
          input: [{ type: "text", text: message.text }],
          clientUserMessageId: message.clientId,
        });
        const decision = nativeDecision(result);
        if (decision) return decision;
        const nativeId = queueId(record(result).queuedSubmission, message.clientId);
        return nativeId ? { s: "woken", nativeId } : { s: "uncertain" };
      });
    },
    async reconcile(target, nudge) {
      const message = notice(nudge);
      if (!message) return { s: "refused" };
      return run(target, async (rpc, threadId) => {
        const request: CodexRpc["request"] = async (method, params) => {
          const result = await rpc.request(method, params);
          const decision = nativeDecision(result);
          if (decision) throw new RecoveryDecision(decision);
          return result;
        };
        const params = queueParams(threadId);
        let pending: string | undefined;
        try {
          pending = await scanPages(
            await request("thread/queue/list", params),
            cursor => request("thread/queue/list", { ...params, cursor }),
            row => queueId(row, message.clientId),
          );
        } catch (error) {
          const decision = explicitDecision(error);
          if (decision) return decision;
          // History can still establish a positive match when queue reads fail.
        }
        const nativeId = pending ?? await historyMatch(request, threadId, message.clientId);
        return nativeId ? { s: "woken", nativeId } : { s: "uncertain" };
      }, true);
    },
  };
}
