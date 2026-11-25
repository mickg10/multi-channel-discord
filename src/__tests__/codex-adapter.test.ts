import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { buildNudge, type Target } from "../types.js";
import { join } from "node:path";
import { createCodexAdapter, CodexRpcError, supportsCodexUnixWebSocket, type CodexRpc } from "../gateway/adapters/codex";
import fixtures from "./fixtures/codex-reconciliation.json";

const target: Target = { conv: fixtures.enqueue.params.threadId, host: "fixture", user: "fixture", kind: "codex", alias: "shared" };
const child = { ...target, conv: "01a21383-ceb4-7b63-b886-e915ba08c55b" };
const nudge = buildNudge("codex", target.conv, "88303d3d-400b-46a9-a54b-125f6254c9a2", 42);
const { clientId } = nudge;
const nativeBanner = "fixture_owner/0.172.0 (Ubuntu 22.4.0; x86_64) xterm-256color (fixture_producer; 0.1)";
const input = [{ type: "text", text: "[agent-bus] mail waiting (id 42) — call check_inbox" }];
const empty = { data: [], nextCursor: null };
type Method = Parameters<CodexRpc["request"]>[0];
type Params = Record<string, unknown>;

function harness(handle: (method: Method, params: Params) => unknown, userAgent = "codex_cli_rs/0.172.0") {
  const calls: { method: Method | "initialized"; params?: object }[] = [];
  const adapter = createCodexAdapter({
    resolveControlSocket: () => "/unused.sock",
    connect: async () => ({
      async request(method, params) {
        calls.push({ method, params });
        if (method === "initialize") return { userAgent };
        return handle(method, params as Params);
      },
      notify(method) { calls.push({ method }); },
      close() {},
    }),
  });
  return { adapter, calls };
}

test("gateway notice and client ID pass through unchanged, with only allowlisted RPC fields", async () => {
  const { adapter, calls } = harness((method, params) => {
    if (method === "thread/queue/list") return empty;
    expect(method).toBe("thread/queue/add");
    expect(params).toEqual({ threadId: target.conv, input, clientUserMessageId: clientId });
    return { queuedSubmission: { ...fixtures.enqueue.result.queuedSubmission, clientUserMessageId: clientId } };
  });
  expect(await adapter.wake(target, { ...nudge, body: "secret", from_human: true, from: "sender", approvalPolicy: "never" } as typeof nudge))
    .toEqual({ s: "woken", nativeId: fixtures.enqueue.result.queuedSubmission.id });
  expect(calls.map(call => call.method)).toEqual(["initialize", "initialized", "thread/queue/list", "thread/queue/add"]);
  expect(calls[0].params).toEqual({
    clientInfo: { name: "agent-bus", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  expect(nudge.text).toMatchInlineSnapshot(`"[agent-bus] mail waiting (id 42) — call check_inbox"`);
  for (const text of ["injected body", nudge.text + "\n", nudge.text.replace("42", "042"),
    nudge.text.replace("42", "-1"), nudge.text.replace("42", "9007199254740992")]) {
    expect(await adapter.wake(target, { ...nudge, text })).toEqual({ s: "refused" });
  }
  for (const clientId of ["spoofed", nudge.clientId + "\n"]) {
    expect(await adapter.wake(target, { ...nudge, clientId })).toEqual({ s: "refused" });
  }
  expect(calls).toHaveLength(4);
});

test("native Unix WebSocket requires a known Bun release at or above 1.3.13", () => {
  for (const version of [undefined, "", "unknown", "0.9.99", "1.2.99", "1.3.12", "1.3.13-canary.1", "1.3.13\n"]) {
    expect(supportsCodexUnixWebSocket(version)).toBe(false);
  }
  for (const version of ["1.3.13", "1.3.14", "1.4.5", "2.0.0"]) {
    expect(supportsCodexUnixWebSocket(version)).toBe(true);
  }
});

test("version and experimental queue capability gate", async () => {
  for (const agent of ["fixture_owner/0.169.9", "unknown (other/0.172.0)", "codex/0.172.0-beta.1"]) {
    const { adapter, calls } = harness(() => { throw new Error("unexpected"); }, agent);
    expect(await adapter.probe(target)).toEqual({ ok: false });
    expect(await adapter.wake(target, nudge)).toEqual({ s: "held" });
    expect(calls.map(call => call.method)).toEqual(["initialize", "initialize"]);
  }
  const { adapter, calls } = harness(() => { throw new CodexRpcError(-32601); }, "codex/0.170.0");
  expect(await adapter.probe(target)).toEqual({ ok: false });
  expect(await adapter.wake(target, nudge)).toEqual({ s: "held" });
  expect(calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
  for (const userAgent of [nativeBanner, "codex/0.170.0"]) {
    const { adapter, calls } = harness(() => empty, userAgent);
    expect(await adapter.probe(target)).toEqual({ ok: true });
    expect(calls.map(call => call.method)).toEqual(["initialize", "initialized", "thread/queue/list"]);
  }
  expect(await harness(() => ({ data: [] })).adapter.probe(target)).toEqual({ ok: false });
});

test("busy A serializes queued B in the fake native contract and shared socket targets stay distinct", async () => {
  const turns = new Map([[target.conv, ["A"]], [child.conv, ["child"]]]);
  const queued = new Map<string, Params[]>();
  const { adapter, calls } = harness((method, params) => {
    const threadId = params.threadId as string;
    if (method === "thread/queue/list") return { data: queued.get(threadId) ?? [], nextCursor: null };
    expect(method).toBe("thread/queue/add");
    const submission = { ...params, id: threadId };
    queued.set(threadId, [submission]);
    return { queuedSubmission: submission };
  });
  expect((await adapter.wake(target, nudge)).s).toBe("woken");
  expect(turns.get(target.conv)).toEqual(["A"]);
  expect(queued.has(child.conv)).toBe(false);
  expect((await adapter.wake(child, buildNudge("codex", child.conv, nudge.msgId, 42))).s).toBe("woken");
  const parentB = queued.get(target.conv)![0];
  expect(queued.get(child.conv)![0].clientUserMessageId).not.toBe(parentB.clientUserMessageId);
  // Simulate the native owner completing the busy turn and dispatching the entry.
  turns.get(target.conv)!.push((parentB.input as typeof input)[0].text);
  queued.delete(target.conv);
  expect(turns.get(target.conv)).toEqual(["A", input[0].text]);
  expect(turns.get(child.conv)).toEqual(["child"]);
  expect(calls.filter(call => call.method === "thread/queue/add").map(call => call.params))
    .toEqual([expect.objectContaining({ threadId: target.conv }), expect.objectContaining({ threadId: child.conv })]);
});

test("lost add reply reconciles pending on the next cursor without another add", async () => {
  let written = false;
  const { adapter, calls } = harness((method, params) => {
    if (method === "thread/queue/add") {
      written = true;
      throw Object.assign(new Error("lost reply"), { code: "ECONNREFUSED" });
    }
    expect(method).toBe("thread/queue/list");
    if (!written) return empty;
    if (!params.cursor) return fixtures.queue_page_1.result;
    expect(params.cursor).toBe(fixtures.queue_page_1.result.nextCursor);
    return {
      ...fixtures.queue_page_2.result,
      data: fixtures.queue_page_2.result.data.map(row => ({ ...row, clientUserMessageId: clientId })),
    };
  });
  expect(await adapter.wake(target, nudge)).toEqual({ s: "uncertain" });
  expect(await adapter.reconcile(target, nudge)).toEqual({ s: "woken", nativeId: fixtures.queue_page_2.result.data[0].id });
  expect(calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
});

test("lost add reply reconciles a cold completed userMessage even when the queue read fails", async () => {
  let written = false;
  const native = structuredClone(fixtures.cold_history_match.result);
  native.thread.turns[0].items[0].clientId = clientId;
  const { adapter, calls } = harness((method, params) => {
    if (method === "thread/queue/add") {
      written = true;
      throw new Error("disconnect");
    }
    if (method === "thread/queue/list") {
      if (written) throw new CodexRpcError(-32603);
      return empty;
    }
    expect(method).toBe("thread/read");
    expect(params).toEqual(fixtures.cold_history_match.params);
    return native;
  });
  expect((await adapter.wake(target, nudge)).s).toBe("uncertain");
  expect(await adapter.reconcile(target, nudge)).toEqual({ s: "woken", nativeId: native.thread.turns[0].items[0].id });
  expect(calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
});

test("reconcile pages full turns, pages unloaded items, and ignores incomplete or foreign evidence", async () => {
  for (const mode of ["match", "absent", "error", "cycle", "foreign"]) {
    const { adapter, calls } = harness((method, params) => {
      if (method === "thread/queue/list") return empty;
      if (method === "thread/read") {
        expect(params).toEqual(fixtures.cold_history_match.params);
        const summary = fixtures.turns_summary.result.data[0];
        return { thread: {
          id: mode === "foreign" ? child.conv : target.conv,
          turns: [{ ...summary, status: "inProgress", items: [{ ...summary.items[0], clientId }] }],
        } };
      }
      if (method === "thread/turns/list") {
        expect(params.itemsView).toBe("full");
        if (!params.cursor) return fixtures.turns_full.result;
        expect(params.cursor).toBe(fixtures.turns_full.result.nextCursor);
        return { data: [{ ...fixtures.turns_summary.result.data[0], itemsView: "notLoaded", items: [] }], nextCursor: null };
      }
      expect(method).toBe("thread/items/list");
      expect(params.turnId).toBe(fixtures.items.params.turnId);
      if (!params.cursor || mode === "cycle") return fixtures.items.result;
      expect(params.cursor).toBe(fixtures.items.result.nextCursor);
      if (mode === "error") throw new CodexRpcError(-32603);
      const row = fixtures.items.result.data[0];
      return { data: [{ ...row, item: { ...row.item, clientId: mode === "match" ? clientId : null } }], nextCursor: null };
    });
    expect(await adapter.reconcile(target, nudge)).toEqual(mode === "match"
      ? { s: "woken", nativeId: fixtures.items.result.data[0].item.id }
      : { s: "uncertain" });
    expect(calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
    expect(calls.filter(call => call.method === "thread/items/list")).toHaveLength(mode === "foreign" ? 0 : 2);
  }
});

test("reconciliation stops on explicit native decisions in queue or history results and RPC errors", async () => {
  for (const status of ["held", "refused", "denied"] as const) {
    for (const stage of ["queue", "queue cursor", "thread/read", "thread/turns/list", "thread/items/list"]) {
      for (const asError of [false, true]) {
        const decision = { status };
        const terminal = () => {
          if (asError) throw new CodexRpcError(-32000, decision);
          return decision;
        };
        const expected: Method[] = ["thread/queue/list"];
        if (stage === "queue cursor") expected.push("thread/queue/list");
        if (stage.startsWith("thread/")) expected.push("thread/read");
        if (stage === "thread/turns/list" || stage === "thread/items/list") expected.push("thread/turns/list");
        if (stage === "thread/items/list") expected.push("thread/items/list");
        const { adapter, calls } = harness((method, params) => {
          if (method === "thread/queue/list") {
            if (stage === "queue" || (stage === "queue cursor" && params.cursor)) return terminal();
            return stage === "queue cursor" ? { ...empty, nextCursor: "next" } : empty;
          }
          if (method === stage) return terminal();
          if (method === "thread/read") return { thread: { id: target.conv, turns: [] } };
          if (method === "thread/turns/list") {
            return { data: [{ id: "turn", status: "completed", itemsView: "notLoaded" }], nextCursor: "next" };
          }
          throw new Error("unexpected follow-up RPC");
        });
        expect(await adapter.reconcile(target, nudge)).toEqual({ s: status === "denied" ? "refused" : status });
        expect(calls.map(call => call.method)).toEqual(["initialize", "initialized", ...expected]);
      }
    }
  }
});

test("native dispositions are terminal and malformed ACKs or unknown RPC errors are uncertain", async () => {
  for (const [reply, status] of [
    [{ status: "held" }, "held"],
    [new CodexRpcError(-32000, { status: "denied" }), "refused"],
    [{ status: "refused" }, "refused"],
    [{ queuedSubmission: { id: "native", clientUserMessageId: "other" } }, "uncertain"],
    [{ queuedSubmission: { clientUserMessageId: clientId } }, "uncertain"],
    [new CodexRpcError(-32603), "uncertain"],
  ] as const) {
    const { adapter, calls } = harness(method => {
      if (method === "thread/queue/list") return empty;
      if (reply instanceof Error) throw reply;
      return reply;
    });
    expect(await adapter.wake(target, nudge)).toEqual({ s: status });
    expect(calls.map(call => call.method)).toEqual(["initialize", "initialized", "thread/queue/list", "thread/queue/add"]);
  }
});

test("deadline after possible add is uncertain and a late preflight cannot enqueue", async () => {
  for (const hangOn of ["thread/queue/list", "thread/queue/add"]) {
    let release!: (value: unknown) => void;
    const blocked = new Promise(resolve => { release = resolve; });
    let adds = 0;
    const adapter = createCodexAdapter({
      deadlineMs: 20,
      resolveControlSocket: () => "/unused.sock",
      connect: async () => ({
        async request(method) {
          if (method === "initialize") return { userAgent: "codex/0.172.0" };
          if (method === "thread/queue/add") adds++;
          return method === hangOn ? blocked : empty;
        },
        notify() {},
        close() {},
      }),
    });
    expect(await adapter.wake(target, nudge)).toEqual({ s: "uncertain" });
    release(empty);
    await Bun.sleep(0);
    expect(adds).toBe(hangOn === "thread/queue/add" ? 1 : 0);
  }
});

test("reject missing registration, nonsocket paths, and unsafe symlinks", async () => {
  const dir = await mkdtemp("/tmp/codex-adapter-");
  const file = join(dir, "file");
  const link = join(dir, "link.sock");
  try {
    await writeFile(file, "", { mode: 0o600 });
    await symlink(file, link);
    const publicParent = join(dir, "public");
    await mkdir(publicParent);
    await chmod(publicParent, 0o755);
    const publicLink = join(publicParent, "link.sock");
    await symlink(link, publicLink);
    const parentAlias = join(dir, "alias");
    await symlink(publicParent, parentAlias);
    for (const path of [undefined, file, link, publicLink, join(parentAlias, "link.sock"),
      join(dir, "missing.sock"), "relative.sock"]) {
      const adapter = createCodexAdapter({ resolveControlSocket: () => path });
      expect(await adapter.wake(target, nudge)).toEqual({ s: "unavailable" });
      expect(await adapter.reconcile(target, nudge)).toEqual({ s: "uncertain" });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function canListenOnUnix() {
  const dir = await mkdtemp("/tmp/codex-adapter-bind-");
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(join(dir, "rpc.sock"), resolve));
    return true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test.skipIf(!(await canListenOnUnix()))("disposable WebSocket supports managed links when socket realpath is unsupported", async () => {
  const dir = await fs.realpath(await mkdtemp("/tmp/codex-adapter-"));
  const path = join(dir, "rpc.sock");
  const registration = join(dir, "registration");
  const seen: string[] = [];
  let mode = "success";
  const server = Bun.serve({
    unix: path,
    fetch(request, server) {
      if (mode !== "reject-upgrade" && server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const frame = JSON.parse(data.toString());
        seen.push(frame.method ?? "<unexpected server-request response>");
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: frame.id, result }));
        switch (frame.method) {
          case "initialize":
            reply({ userAgent: nativeBanner });
            break;
          case "thread/queue/list":
            reply(empty);
            break;
          case "thread/queue/add":
            if (mode === "approval") {
              ws.send('{"id":"owner-approval","method":"item/commandExecution/requestApproval"}');
            } else if (mode === "malformed") {
              ws.send(JSON.stringify({ id: frame.id, result: {}, error: { code: -32603, message: "bad envelope" } }));
            } else if (mode === "rpc-error") {
              ws.send(JSON.stringify({ id: frame.id, error: { code: -32603, message: "fixture error" } }));
            } else if (mode === "disconnect") {
              ws.terminate();
            } else {
              reply({ queuedSubmission: { id: "queued", clientUserMessageId: frame.params.clientUserMessageId } });
            }
        }
      },
    },
  });
  try {
    const adapter = createCodexAdapter({ resolveControlSocket: () => path });
    await chmod(path, 0o660);
    expect(await adapter.wake(target, nudge)).toEqual({ s: "unavailable" });
    expect(seen).toEqual([]);
    await chmod(path, 0o600);
    await mkdir(registration, { mode: 0o700 });
    const link = join(registration, "managed.sock");
    await symlink(path, link);
    const chain = join(registration, "chain.sock");
    await symlink(link, chain);
    const linkAdapter = createCodexAdapter({ resolveControlSocket: () => link });
    expect(await createCodexAdapter({ resolveControlSocket: () => chain }).probe(target)).toEqual({ ok: false });
    await chmod(registration, 0o755);
    expect(await linkAdapter.probe(target)).toEqual({ ok: false });
    await chmod(registration, 0o700);
    await chmod(dir, 0o755);
    expect(await linkAdapter.probe(target)).toEqual({ ok: false });
    expect(seen).toEqual([]);
    await chmod(dir, 0o700);
    mode = "reject-upgrade";
    expect(await adapter.wake(target, nudge)).toEqual({ s: "unavailable" });
    expect(seen).toEqual([]);
    mode = "success";
    const filesystem: { realpath(path: string): Promise<string> } = fs;
    const originalRealpath = filesystem.realpath;
    const realpathSpy = spyOn(filesystem, "realpath").mockImplementation(async candidate => {
      if (candidate === path || candidate === link) {
        throw Object.assign(new Error("socket realpath is unsupported"), { code: "EOPNOTSUPP" });
      }
      return originalRealpath(candidate);
    });
    try {
      await expect(fs.realpath(path)).rejects.toMatchObject({ code: "EOPNOTSUPP" });
      realpathSpy.mockClear();
      expect(await linkAdapter.probe(target)).toEqual({ ok: true });
      const inspection = [registration, dir, dir];
      expect(realpathSpy.mock.calls.map(([candidate]) => candidate)).toEqual([...inspection, ...inspection]);
      expect(await linkAdapter.wake(target, nudge)).toEqual({ s: "woken", nativeId: "queued" });
      realpathSpy.mockClear();
      expect(await linkAdapter.wake(target, { ...nudge, text: "forged notice" })).toEqual({ s: "refused" });
      expect(realpathSpy).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
    expect(await adapter.wake(target, nudge)).toEqual({ s: "woken", nativeId: "queued" });
    mode = "malformed";
    expect(await adapter.wake(target, nudge)).toEqual({ s: "uncertain" });
    mode = "approval";
    expect(await adapter.wake(target, nudge)).toEqual({ s: "uncertain" });
    mode = "rpc-error";
    expect(await adapter.wake(target, nudge)).toEqual({ s: "uncertain" });
    mode = "disconnect";
    expect(await adapter.wake(target, nudge)).toEqual({ s: "uncertain" });
    const exchange = ["initialize", "initialized", "thread/queue/list", "thread/queue/add"];
    expect(seen).toEqual([...exchange.slice(0, 3), ...exchange, ...exchange, ...exchange, ...exchange, ...exchange, ...exchange]);
  } finally {
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
