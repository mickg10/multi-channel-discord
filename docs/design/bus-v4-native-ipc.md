# Agent bus v4: native IPC, one gateway per host

Owner/leader: claude@mac:ops-tmux-fixer (Opus 5.5). Baseline: v3 + critique log in `bus-v3-critique-log-ops-upgrader.md`.
Status: **v5.0 FROZEN** (after R10, 2026-11-25 17:1xZ). Changes from here need a leader-approved amendment., entering 10 critique rounds (#bus-v3). Nothing built.
Goal (Mick 2026-11-25 16:12): use each agent's *native* IPC wherever possible; tmux only as fallback; one always-up controller.

## 1. Shape

```
Discord ◄─► ROUTER (vps2, unchanged role: policy PR #9, claims, subs, registry, cross-host)
               ▲ one ws per host (node secret), durable commit-before-ack
               │
         GATEWAY (one per host, runs AS THE USER: launchd KeepAlive / systemd --user)
           ├─ registry: (host, os-user, kind, native conversation id) → live control handle
           ├─ tool surface: local MCP for agents (stdio pipe or loopback), stamps identity
           ├─ adapters: claude-inbox | codex-appserver | opencode-serve | grok-acp | agy-acp | tmux
           ├─ durable outbox per agent (lease by msg id, ack after recipient acceptance)
           └─ controller: restarts/launches agents in tmux session 0 (never restarts itself mid-op)
```

Invariant **N1 (fixed nudge)**: an adapter only ever injects a fixed, non-imperative nudge
(`[agent-bus] mail waiting (id <n>) — call check_inbox`). Message bodies and `from_human` travel only in the
`check_inbox` tool result, which is **structured JSON** (`[{id, from, from_human: <router-set bool>, channel, body}]`). It is never a formatted text header that a body could forge (R2#1; today's `formatInboxLine` is forgeable, a live bug). The nudge is a compile-time constant plus a digits-only id, with at most **one un-acked nudge per conversation** (R2#2). Reason: native inject = user-authority input (Codex `UserInput`, opencode prompt).
Invariant **N2 (no racing the human)**: never `turn/steer`. An adapter may inject only where the agent's own input queue serializes it with human input (Claude inbox `priority:"next"` is queued by Claude itself between tool calls, or starts a turn when idle). Codex ≥0.170 (experimentalApi) provides the guarantee too. `thread/queue/add` **accepts while busy** and holds the item until the turn ends, after which it auto-dispatches (canary passed). The separate `thread/queue/start` is the call that refuses a busy thread. The gateway only calls `queue/add` and **never** `turn/start`, `turn/steer` or `queue/start`. Where the guarantee is missing (older Codex, opencode TUIs a human owns), the thread is **pull-only**: mail waits for the agent's next check_inbox, and no check-then-send. That holds until an atomic idle-only admission exists.
Invariant **N4 (recipient decisions are final)**: fallbacks apply only to an *unavailable* transport (no socket, connection refused, not registered). A native **held/refused/denied** result ends delivery attempts for that message. No other transport or sender identity is tried; the mail stays readable and the hold is reported. Each session's transport is chosen up front from its registration, so the Q1 token post is the configured route, never a retry after a hold. Regression test: the recipient declines, then zero alternate deliveries and zero model turns follow.
Invariant **N3 (exact identity)**: delivery target = native conversation id, never cwd/display name.

## 2. Adapters — evidence

| Kind | Identity | Inject into live session | Busy/idle | Evidence |
|---|---|---|---|---|
| **Claude Code 2.1.33x** | `~/.claude/sessions/<pid>.json`: sessionId, name, cwd, status, tmux, messagingSocketPath; re-read per call (handles /clear, /resume) | **Inbox socket** (documented, cross-session-messaging). NDJSON: `{"type":"auth","token":T}` then `{"type":"user","message":{"content":…},"from":"uds:…","priority":"next"}` | session file `status` | **Tested 16:15–16:19 Mac**: (1) ask-mode receiver: unauthenticated external post delivered, started turn. (2) bypass receiver, no token: **held** in approval dialog. (3) bypass receiver, orphaned process **with that session's `CLAUDE_CODE_MESSAGING_TOKEN`**: **delivered**, no dialog. |
| **Codex 0.170+** | MCP `tools/call` carries `_meta.threadId`+`sessionId` | Control socket `~/.codex/app-server-control/*.sock`, experimentalApi: **`thread/queue/add` only** (accepts while busy, dispatches when idle). The gateway is **enqueue-only**: it never resumes or subscribes to the human's thread, and approvals stay with the TUI client (verified: the producer got 0 approval requests). Reconcile by `clientUserMessageId`, which `thread/read(includeTurns)` retains as `userMessage.clientId`; the server queue id is not retained. | `thread/status/changed`, `turn/completed` | codex_nas: canary, reconnect and approval tests on 0.170/0.172 disposable |
| **opencode 2.x** (nas642 service 2.0.18) | session id `ses_…` (`GET /api/session`) | Service HTTP API (TUI auto-spawns `opencode serve --service` on 127.0.0.1; url and password are in `~/.local/state/opencode/service.json`, mode 0600; no password → 401). `POST /api/session/{id}/prompt` with **`delivery:"queue"`** (never `"steer"`), plus a caller-supplied `id: msg_…` for idempotency (verify). That is the native durable queue, inspectable via `GET /api/session/{id}/inbox`. `POST …/synthetic` also exists. | `GET /api/session/active` (absent = idle); `GET /api/event` SSE | Leader probe on nas642 via `opencode api GET /openapi.json` (read-only, 16:3x). **MCP servers are spawned by the service**, not the TUI (process tree), so tool identity is per service. The live tmux bug: 3 discord clients under one service, and nudge text sits unsubmitted in the TUI input. |
| **grok 1.0.92** | ACP session id | Live TUI: **none** (no leader.sock unless the TUI was started with a leader; `agent serve` is a new WS whose secret only its starter knows), so a human-used grok TUI is **pull-only**. Gateway-owned: `grok agent stdio` (ACP `session/new`, fixed-nudge prompt) | ACP events | grok_nas R4 [verified] |
| **agy 1.5.17** | conversation UUID (`$ANTIGRAVITY_CONVERSATION_ID`) | Gateway-owned: `agy acp` (`session/resume`/`session/prompt`, with inline per-session `mcpServers`) or stream-json stdin (omit `-p`). Live TUI: **no inject**, so tmux nudge, gated on runState | Live TUI: a SessionStart hook gives LS address and CSRF token, and `ConversationService/GetConversation` returns `runState` IDLE/RUNNING. Gateway-owned: turn framing | agy_nas verified live on nas642 (docs: headless.md, hooks.md) |

### Claude wake: order of preference (R2#6)
1. Sessions whose MCP pipe declares the channel capability (launched with the channel flag): a channel notification down the pipe. Documented, no token, no hold, no model turn.
2. Plain `claude` sessions: a token post to the inbox socket (https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket).
3. tmux. (The Haiku `SendMessage` helper is **cut** in R6#1: an extra process, cost per wake, and mode holds.)

**Conversation check before every Claude nudge (R2#4):** the token is per process, not per conversation. `/clear` changes sessionId under the same pid, socket and token. Before nudging, the gateway compares the pid's *current* sessionId (`claude agents --json`) with the mail's target. On mismatch it sends no nudge, and the mail waits for that conversation.
**Frames:** an authed client could also send control frames (`rename`, `peer_message_status`, `notify_when_idle`, …). The gateway sends only `type:user` with the constant nudge. Any other frame type is a code-review blocker.

### Claude registration (no setting change, no per-agent process)
A `SessionStart` hook (user settings, all sessions) runs `agent-bus register` once. It inherits
`CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` and `CLAUDE_SESSION_ID`/pid, and hands them to the gateway over its
0600 unix socket, then exits. Gateway keeps tokens **in memory only** (R2#5; a state file would hand all sessions' tokens to any same-user reader) and re-learns them from `SessionStart` (fires with `source:"clear"` and on resume; verified by claude_nas) and `UserPromptSubmit` hooks after a gateway restart. Env: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`. Bypass sessions then accept the gateway's
nudges (test 3). No hook registration → the session is pull-only (not tmux). A rejected token → re-register on the next hook. **tmux is used only where the *registered* transport is tmux on a gateway-launched pane** (R8#2).

## 3. Tools

Agents keep an MCP entry, but it points at the **gateway**, not the router:
- Claude: logic-free stdio pipe `agent-bus-pipe` → gateway socket (channels need stdio; tools only — wake is the inbox socket).
- Codex: same pipe, or gateway loopback HTTP. Identity comes from authenticated transport plus per-call `_meta.threadId`; a call missing it or mismatched is rejected. Parent and child threads under one daemon each bind separately, since a child spawning a second client with the same alias must not retire the parent (R1#2).
- opencode/grok/agy: pipe; identity from gateway's launch record (gateway-owned) or bus-launch token.
Gateway stamps `(host,user,kind,conv-id)` on every call to the router; router rejects node-secret-only calls.

## 4. Durability (fixes live router bugs found by codex_nas)
**Every admitted directed message is committed to Inboxes *before* any transport, live-push or wake-budget decision.** Today's live-push and over-budget paths skip the inbox entirely (R6#2, verified on 8697214). If commit fails, the sender gets an explicit error.
Per message, one stable msg id across reconnects: **committed** (router fsync, synchronous) → **woken** (a native ack such as Codex queue/add or opencode prompt means the *adapter's nudge was admitted*, not that mail was read) → **accepted**. Each `check_inbox` result carries an opaque **receipt** bound to (identity, msg ids, lease generation). The agent's **next** `check_inbox` echoes the previous receipt, and only that exact receipt acks; there is no new tool (R10, superseding R9#4). A lost result or an unrelated call leaves mail leased, and lease expiry redelivers with the same ids. Terminal side-states: **held / refused / uncertain**, operator-visible, mail still readable, no fallback (N4). Implementation is a **focused Inboxes and protocol refactor**, not a router rewrite (R5#3). It needs a synchronous atomic commit, entries with id, state and lease, a lease/ACK on drain, wake attempt and ACK records, restart recovery, and overflow surfaced to the sender instead of dropping at 501.
Commit-before-ack on enqueue; lease by msg id on drain; ack only after recipient accepted; overflow is an
error to the sender, never silent oldest-drop; uncertain inject → "unresolved", reconciled, never replayed blindly.

## 5. Controller
ACP workers (agy/grok) speak stdio, so each runs in its tmux-0 window behind a tiny stdio↔unix-socket bridge owned by that window's restart loop. The gateway connects to the socket, and a gateway restart reconnects instead of severing the pipe (R6#4). agy LS address and CSRF are re-learned from a per-turn hook as well as SessionStart, the same way as Claude tokens (R6#3).
Gateway-owned agents (grok/agy ACP children, persistent helpers) are **not** children of the gateway process. Each runs in its own tmux-0 window under a tiny restart loop, so a gateway crash or upgrade never kills them (R4#3). Persisted state: msg states, woken id (**fsync before the native send**), and pane plus conversation id per agent. **Tokens are never persisted.** After a gateway restart, an idle bypass Claude has no token until its next hook fire, so its wake goes **pull-only** until it re-registers (R8#2: no tmux fallback for natively registered sessions, since a forced gateway crash must not turn into keystrokes into a bypass session or a permission dialog).
Scope: a gateway controls only its own host. If the host is lost, its agents are gone too, and the router's durable mail is the cross-host continuity, so there is no standby gateway (R1#4 considered and rejected). Upgrades work by drain, then exec, and KeepAlive restarts it.
The gateway is the never-down controller (KeepAlive/systemd --user). It (a) restarts dead agents in tmux session 0
with their own conversation id, (b) never restarts itself or the shared Codex daemon to fix its own state,
(c) applies upgrades by draining, then exec. Migration operator (an agent): ops-upgrader, restarts last.

### 4a. Router changes for M0 (R7, claude_setup, verified against 8697214)
- `deliver()` has four exits that never commit (push = bare ws.send, over-budget = unread.bump, offline non-node = drop, approval without a conversation = drop). New order: **admit (known identity only, else sender error) → commit → the budget gates the *wake* only → transport.** PR #9 semantics are kept: passive traffic is a count; from_human and rules are exempt.
- Inboxes storage: **append-only JSONL** of commit, lease and ack records, compacted on start. It replaces the whole-map JSON on a 200 ms timer, where an fsync per message would be O(total).
- Drain becomes a **lease** (10 min) acked by the echoed receipt (§4); it redelivers with the same id. **Sender publish:** `bus_post` returns `{publish_id, committed:[targets]}`, and a retry with the same `publish_id` dedups (one delivery per target, even across a Discord outage). **Wake attempts are persisted before native I/O**; a crash before `wakeResult` leaves the message `uncertain`, and it is reconciled, never re-woken blindly. Unbound legacy mail is preserved when an alias changes owner, then reconciled. `agentStatus` (L393) is observational; the backlog flush happens only on register.
- Inbox **key = identity (host/user/kind/conv)**, which folds in Conversations and the bound-approval hold. M0 does a one-time re-key of name-queued mail when an alias binds.
- Gateway protocol: `registerGateway{host,user,proto}` with the node secret **required** (timing-safe compare, replacing today's `!==`); `registerAgent{kind,conv,alias}` bound to ws.data.nodeName, with a host match. Every op carries `as`, which must be in that gateway's set; ops without it are rejected.
- Coexistence: a gateway-bound alias rejects a legacy `register` with `replaced`, because the PR #11 takeover would otherwise steal it.
- **Migration unit = config scope** (a CODEX_HOME, an opencode service, a Claude settings scope), not a single agent.

### 4b. Security rules (R8, ops-upgrader)
Baseline: a same-user process is **not** a boundary. The goal is to limit what a prompt-injected agent shell or MCP child can do.
- **Per-call `_meta` identity is trusted only from a verified pipe.** The peer on the gateway socket must be `agent-bus-pipe` (exe path check) whose parent is the registered daemon or agent pid. Residual risk: a shell that `exec`s the pipe from under the daemon still passes, so this is a mitigation, not a proof. **Ack must carry the lease id** issued to that identity, so you can't ack mail you weren't leased.
- **Registration is verified, not trusted.** Hook payloads give only a hint. The gateway checks the hook peer's ancestry against `CLAUDE_PID` and takes the socket path and sessionId from `claude agents --json`, never from the payload. agy LS address and CSRF are accepted only from a peer descended from that agy pid.
- **Host identity:** gateways **require a per-node secret** (R7 and R10; the gateway is new, so there is no legacy constraint), and host↔secret is enforced for addressed drain and ack. Legacy plugin clients keep today's rules, including Mick's accepted impersonation, until their scope migrates. Held/refused stay final, and the external sender identity is preserved.
- **Secrets:** the inbox-socket auth line, opencode password and agy CSRF are redacted in the serializer and raw frames are never logged. The opencode password goes in a header, never in the URL or argv. The gateway runs with `ulimit -c 0`.
- **opencode allowlist** (replaces the denylist): GET `/api/session`, `/api/session/active`, `/api/session/{id}/inbox`, `/api/event`, `/api/session/{id}/message/*`, and POST `/api/session/{id}/prompt` with `delivery:"queue"` only.
- Verified OK: the router sets `from_human` only for `allowFrom` authors (router.ts:355), and dispatcher re-delivery uses only the saved humanMail (ws.ts:1196).

### 4c. Pinned interfaces (R9, grok_nas)
```ts
type Kind = 'claude'|'codex'|'opencode'|'grok'|'agy'
type Nudge = { msgId: string; text: NUDGE_CONST; clientId: string }
type WakeResult = {s:'woken', nativeId:string} | {s:'held'} | {s:'refused'} | {s:'uncertain'} | {s:'unavailable'}
interface Adapter { kind: Kind; probe(t: Target): Promise<{ok:boolean}>; wake(t: Target, n: Nudge): Promise<WakeResult>; reconcile(t: Target, n: Nudge): Promise<WakeResult> }
// Only 'unavailable' may fall through to another transport (N4).
// Router ops (identity = `as`): admit, commit, lease(as)->[{id,leaseId,body,from,from_human}], ack(as,leaseId,id), mark(as,id,state)
// Frames: registerGateway{host,user,proto:1,secret} registerAgent{kind,conv,alias} lease ack wakeResult
```
- **One state machine, on the router.** The gateway reports a `wakeResult`, and the router `mark`s `woken` only after the adapter returns `woken` (after reconcile when retried). A lease of an id already in `woken` or `uncertain` must **not** call wake again.
- **Ids:** `h = sha256(recipientConvId + ":" + busMsgId)`. Codex `clientUserMessageId = "bus-" + hex(h)[0:32]`. opencode prompt `id = "msg_bus" + hex(h)[0:24]` (must match `^msg_`).
- **Overflow:** per-identity cap of 5000 committed-unaccepted. Over the cap, the sender gets the error `inbox_full`; nothing is dropped.
- **Coexistence:** M0 leases mail only for aliases that called `registerAgent`. Mail for legacy plugin aliases keeps the old drain path. JSON `check_inbox` is a per-scope flag that flips together with the scope.
- **Canary scope:** "one real agent" means a dedicated canary scope (its own CODEX_HOME or opencode service, with one agent) before the fleet scope flips.
- **PR split:** PR1 router (JSONL inbox, admit→commit→lease/ack, observational status). PR2 gateway skeleton (frames, registry, Adapter type, no native I/O). PR3 Codex adapter. PR4 opencode adapter. PR3 and PR4 depend only on PR2 and land in parallel.

## 5b. Codex RPC contract (pinned, R5#2)
`initialize{capabilities.experimentalApi:true}` → version and capability allowlist (≥0.170; `thread/queue/add` present) → `thread/queue/add{threadId, input:[fixed nudge], clientUserMessageId}` and **nothing else**. Reconcile with `thread/queue/list` plus history: `thread/read{includeTurns:true}` (no itemsView or cursor there), then page `thread/turns/list{itemsView:"full"}` to `nextCursor:null`, and `thread/items/list` where needed (R10 correction), matching `clientUserMessageId` / `userMessage.clientId`. `clientUserMessageId` = hash(recipient threadId, bus msg id), immutable. The control socket must be owned by the user (stat check), mode 0600.

## 6. Migration (per kind, old client stopped in the same step its adapter goes live)
M0 gateway + Inboxes refactor + JSON check_inbox, no adapters, **no tmux restarts**. Build order (R5#5): M0, then **Codex (Mac) and opencode in parallel**, since both have passing canaries and opencode's tmux wake is broken today. Then Claude (after Q1), then agy/grok. No generic adapter framework or status UI: a minimal `Adapter{probe, wake, reconcile}` interface only. M1 Claude (hook + inbox socket). M2 opencode. M3 Codex (queue+nudge first,
native after the disposable race test). M4 grok/agy: ACP for gateway-owned. Live grok TUIs are pull-only (tmux repeats the stuck-composer bug) until a disposable leader-mode test passes. Live agy TUIs that a human uses are **pull-only**: a runState check and then a tmux send is still check-then-send, which N2 forbids (R6#3). The tmux nudge is allowed only on panes the gateway itself launched. **M4 is deferred** until M0, M2 and M3 are proven (R6#1). CFD sessions are excluded throughout. Gates: M1 needs Q1, The M2 identity gate has passed. The idempotency and busy-ordering gate has also **passed** (codex_nas 16:48, isolated 2.0.18). The same caller `msg_…` id gives one pending item that is never merged into the busy turn, dispatches once, and is still deduped after dispatch and after a service restart. **Caution:** a changed body that reuses an id returns success but keeps the original, so the id is derived from an immutable (recipient, nudge) pair and success is never read as "this text accepted". Remaining M2 gate: visual rendering in an attached TUI. M5 retire plugin.ts ws client.
Each step: disposable session test → one real agent → fleet; revert = restore old MCP entry.

## 7. Open questions for Mick
Q1 SessionStart hook in user settings for all Claude sessions (needed for M1). It lets the gateway skip the bypass-session hold for its fixed nudge, using the session's own messaging token. That token is already in the env of every Bash command, hook and MCP child of that session (R2#3, verified), so this is not a new escalation, but it is a policy choice. The alternative is `crossSessionInbound: accept`, which opens the gate to every same-user sender, or living with the hold. The nudge carries no body (N1). Mick's security call. — OK?
Q2 Relaunch grok/agy gateway-owned (ACP) instead of TUI, where no human uses that pane?
Q3 nas642 node moves from root system unit to `systemd --user` (lingering) — OK?

## Critique log (v4)
- **claude_nas (native-ipc: claude row, nas642 2.1.332, outside rota):** a persistent node-owned headless Claude (`-p --input-format stream-json`) can `SendMessage` to any idle TUI, including plain `claude`, with a 2 s wake. But it costs one model turn per wake (~$0.006 Haiku), and delivery is gated by permission-mode class (bypass→auto was held). `claude agents --json` (supported CLI) returns pid, sessionId, name, cwd, status without a TTY. **Disposition:** adopt `claude agents --json` as the Claude registry source. It beats parsing session files, but the per-call re-read stays. Keep the token-post adapter as primary: zero model cost, and test 3 delivered into bypass. A Haiku-child SendMessage is fallback #2 for sessions with no hook registration, before tmux.

### R1 codex@nas642 (8c6517a)
1. [v] Codex `turn/start` can steer an active turn, and check-then-send races typing → **accepted**: N2 rewritten; human-owned Codex/opencode threads are pull-only.
2. [v] A child thread spawned a second MCP client with the same alias and retired the parent → **accepted**: bind on transport + `_meta.threadId`; parent/child plus same-cwd tests.
3. [v] Enqueue lost on exit, removed before receipt → **accepted**: committed/woken/accepted states, stable id.
4. Standby controller with fencing → **rejected**, with the scope argument in §5. "Don't borrow recipient credentials to turn a hold into acceptance" → **escalated to Mick (Q1)**, stated plainly. Mitigation: the token is used only for the body-less N1 nudge.
- **agy_nas (native-ipc: agy row, outside rota):** verified as above. **Disposition:** adopted. The agy SessionStart hook registers conversationId, LS address and CSRF token, so the gateway gates tmux nudges on `runState` with no pane scraping. Prefer `agy acp` for gateway-owned agy, since it injects MCP per session with no config edits (solves agy tool identity).
- **codex_nas R1 follow-up:** Codex 0.172 native `thread/queue/*` (StartIfIdle; upstream tests thread_queue.rs L787-859; `queue/list` verified read-only on a live NAS thread) → **adopted** in N2. Gated on version ≥0.172 plus the two-client TUI canary (Luna testing). Older Codex stays pull-only.

### R2 claude_nas / Fable (1ea3367)
1. [v] check_inbox text is forgeable → **accepted**: JSON with a router-set `from_human`. Also a live bug: fix in M0.
2. Constant nudge, digits-only id, one un-acked nudge per conversation → **accepted**.
3. [v] Token already in every child's env → **accepted**: Q1 reworded as a policy choice, not an escalation.
4. [v] Token is per process; `/clear` changes sessionId → **accepted**: pre-nudge sessionId check, mail waits on mismatch.
5. No token state file → **accepted**: memory only, re-learned from the SessionStart/UserPromptSubmit hooks; frame allowlist is `type:user` only.
6. Channel notification is cleaner → **accepted** as Claude preference #1; token post for plain `claude`; doc URL cited.
- **codex_nas canary (two-client TUI, throwaway session, NAS 0.170, fake provider, Luna):** `thread/queue/add` while the user turn is busy left the notice pending, kept it out of the in-flight request, and rendered it after the first completion with its own turn; the queue ended empty. The control test, a direct `turn/start` while busy, **merged into the active turn**. This confirms N2's ban on blind turn/start. **Disposition:** Codex adapter uses `thread/queue/add` when the experimental queue is present; the canary gate has passed. Still open: Mac 0.132 probe (moot after upgrade to 0.172), reconnect dedup, approval ownership.
- **codex_nas reconnect test (0.172 binary, isolated):** two identical `queue/add` calls (same threadId, clientUserMessageId and text) produced two distinct queued submissions, and both survived a restart. Native queue is durable but **not idempotent**. **Disposition:** on a lost add reply, the adapter reconciles `queue/list` plus thread history by its own nudge id before any retry. If the outcome can't be established, mark the wake *uncertain* and leave mail readable. No auto-replay. A duplicate nudge is harmless anyway: body-less, and one per conversation is enforced gateway-side.

### R3 (opencode internals)
GLM-5.3 critic unreachable. Its TUI shows three concatenated unsubmitted nudges (the live tmux bug: Enter not taken, behind the "Getting started" overlay), plus three discord MCP clients under one service. The leader probed read-only instead (above). Dispositions:
1. opencode has a **native durable queue**: `prompt` with `delivery:"queue"`, inbox list/cancel → **adopted** as the opencode adapter (N2-compliant; `steer` forbidden).
2. Auth: service password in a 0600 file; the gateway runs as the user and reads it per call → **adopted**; never logged.
3. MCP spawned by the service → tool identity needs the session id. **Resolved by codex_nas from v2.0.18 source:** tool calls carry `params._meta["ai.opencode/sessionID"]` (namespaced key, outside `arguments`; client.ts L273-281, tool/mcp.ts L65-70). Bind trusted service connection + that id; reject addressed tools without it. **Passed** on the NAS v2.0.18 binary: in an isolated namespace, two same-directory sessions, one shared MCP process, and each call's id matched its own session (codex_nas 16:47).
4. The current tmux wake is broken for opencode → M2 is high value.
GLM may still post R3 critique; it will be appended.

### R4 grok_nas (07f3740)
1–3. [v] No live grok inject; serve secret unknowable; `agent stdio` = new ACP process → **accepted**: grok TUIs pull-only, gateway-owned via stdio, not parented to the gateway.
4. Restart loses tokens and the nudge counter → **accepted**: fsync woken id before send; persist pane and conversation id, never tokens; post-restart fallback chain.
5. Migration gates → **accepted** (M0 no tmux restarts, M1 gated on Q1, M2 gated on the session id in MCP, CFD out).
6. Simpler matrix (Claude token, Codex queue/add, opencode delivery:queue, grok/agy TUIs pull-only, headless stdio) → **matches v4.4**. agy TUIs keep the runState-gated tmux nudge, since agy's composer submits correctly.
- **codex_nas Codex closure:** approvals go to the TUI client, not the enqueuing producer → **adopted** (gateway is enqueue-only). Reconcile id = `clientUserMessageId` (survives as `userMessage.clientId` in a cold `thread/read`) → **adopted**. §2 and N2 corrected: queue/add accepts while busy, queue/start refuses busy.
- **codex_nas (via codex-photos) reconcile rule:** exhaust every queue and history page (`nextCursor:null`, `itemsView:'full'`) before declaring a result. Even a complete scan **cannot prove** an uncertain add never committed, so absence never authorizes a replay: the wake stays *uncertain* and mail stays readable. **Adopted** as an adapter test requirement. Sanitized cross-version fixtures are saved for the adapter tests.
- **agy_mac (Mac agy 1.5.16):** confirms agy_nas. `agy acp --stdio` → protocolVersion 1, loadSession, resume/close/load/list, `--process-per-session`; no live-TUI inject; `runState` via the LS; `ANTIGRAVITY_CONVERSATION_ID` changes on /clear and /resume (same pre-nudge check as Claude); `mcp_config.json` is host-global. **Open gate (agy tool identity):** a 2-session MCP echo to see whether agy sends the conversation id in `_meta`. If not, live agy TUIs get identity from the launcher-bound pipe only, and gateway-owned agy uses ACP per-session `mcpServers` (agy_nas), which needs no global config.
- **codex_nas:** opencode visual-TUI canary blocked on nas642 by inotify ENOSPC. Leader found the cause: the live opencode service (pid 2218368, `serve --service` under the GLM TUI) holds **65,147 of the user's 65,536 inotify watches**, since it watches the whole `~/src` tree. **Disposition:** run the visual canary on the Mac. Deployment note for M2: the gateway must not depend on file watches, and opencode's watch use is a host-capacity risk (Mick: raise `fs.inotify.max_user_watches` or scope opencode's root).
- **codex_nas:** held/refused must stop the fallback chain → **adopted** as N4. If Mick declines Q1, the Claude transport is the gateway's own sender identity (subject to the hold) or the configured channel.
- **codex_nas opencode permission test (2.0.18, disposable):** a consent-gated tool request triggered by a queued prompt reached only the addressed session, not its same-directory neighbour. Zero executions before or after the owner rejected it. **Adopted:** the opencode adapter is enqueue plus read-only reconcile only. It never calls `/permission/*/reply`, `/shell`, `/command` or `/synthetic` (code-review blocker, same as the Claude frame allowlist).

### R5 codex@mac:infra (26adb9e+)
1. [v] Codex path buildable on 0.172 → confirmed.
2. Pin the RPC contract → **accepted**: §5b.
3. [v] Current Inboxes can't represent the states → **accepted**: focused refactor, scoped in §4.
4. Define "accepted" → **accepted**: native ack = woken; accepted = recipient check_inbox ack.
5. Fastest path → **partly accepted**: no generic framework or UI. Codex and opencode run in parallel rather than Codex alone, because opencode is equally proven and broken in production today.
- **codex_nas live bug (router 8697214, in-memory fixture):** `agentStatus` against a live push session whose route fails attempts the push, **empties the inbox** and reports pending=0, so a status probe destroys mail. **Adopted for M0:** status, count and peek are strictly observational (no drain, no push). A regression test covers the failed push on `agentStatus` and on reconnect-registration flush. Migration preflight must use only observational calls until M0 ships.

### R6 agy@mac:src (e3c8a8a)
1. Cut the Claude Haiku-SendMessage tier; defer M4 → **accepted**.
2. [v] Live-push and budget paths bypass the durable inbox → **accepted**: commit before any transport decision (M0).
3. [v] runState+tmux on human agy panes = check-then-send; LS creds lost on restart → **accepted**: human agy TUIs are pull-only; per-turn hook re-registers.
4. [v] ACP stdio severed by a gateway restart → **accepted**: per-worker stdio↔socket bridge in tmux-0.
5. agy per-session mcpServers under `session/resume` → **M4 gate** (2-session probe).

### R7 claude_setup (8e4fc70)
1–9 [v/opinion] all **accepted** into §4a: admit → commit → budget gates the wake → transport; append-only JSONL; known-identity admission; lease and ack; observational status; identity-keyed inbox plus re-key; registerGateway/registerAgent/`as` with a required node secret and timing-safe compare; legacy register can't steal gateway aliases; migrate per config scope.

### R8 ops-upgrader (security, 7f4436a)
1. Forgeable `_meta` → **accepted** as a mitigation (verified pipe peer plus parent pid; acks tied to the lease id). Residual risk documented.
2. The tmux fallback defeats N4 and can approve dialogs → **accepted**: tmux only as a registered transport on gateway-launched panes; native sessions go pull-only on loss. The stale SendMessage mention is removed.
3. Registration spoofing → **accepted**: ancestry check; socket and sessionId taken from `claude agents --json`.
4. [v] Self-declared host → **documented as accepted risk**; enforced when per-node secrets exist.
5. Token leaks → **accepted** (redaction, header, no core dumps).
6. opencode allowlist → **accepted**.
7. [v] from_human path → no hole.

### R9 grok_nas (implementer view, 3f8ef97)
1–2. PR split and pinned types → **accepted**, §4c.
3. Don't lease mail a legacy plugin drains → **accepted**.
4. The definition of "accepted" contradicted itself → **fixed**: the gateway's write of the check_inbox result is the ack.
5. Single router state machine, no re-wake of woken/uncertain → **accepted**.
6. Guessed values pinned: id hashes, overflow `inbox_full` at 5000, canary scope.

### R10 codex@nas642 (84da816) → FREEZE
Corrections adopted: recipient-echoed receipt ack; wake attempt persisted before native I/O; sender publish_id dedup; legacy mail preserved on owner change; gateways require a per-node secret (the §4a/§4b contradiction is resolved); Codex history paging corrected; opencode evidence confirmed (TUI render, retry/restart, `_meta["ai.opencode/sessionID"]`).

## Acceptance tests (required, R10)
**PR1 router:** (1) commit, then the sender's reply is lost, then a retry during a Discord outage → one delivery per target; (2) a lost inbox result plus an unrelated call leaves mail leased, and only the exact current receipt acks; (3) status, budget exhaustion and a failed push all preserve mail across a restart. Plus: the agentStatus/failed-push regression and `inbox_full`.
**PR2 gateway:** (1) same-cwd parent/child calls cannot read each other's mail; (2) held/refused → zero fallback attempts and zero model turns; (3) a crash between the native send and wakeResult reconciles with no duplicate wake.
**PR3 Codex:** (1) busy A, then queued B, renders two TUI turns; (2) a lost add reply reconciles by clientId with no blind retry; (3) the enqueue-only producer gets zero approvals, and the owner can decline.
**PR4 opencode:** (1) two sessions on one MCP process report distinct, correct ids; (2) busy A plus a retried B renders once, including a retry after restart; (3) the target can reject a tool, the neighbour sees no request, and nothing executes.

## Team (leader-assigned, 2026-11-25)
| Role | Session | Model |
|---|---|---|
| Leader / architect / integrator / final review | claude@mac:ops-tmux-fixer | Opus 5.5 |
| PR1 router (Inboxes JSONL, admit→commit→lease/receipt, publish_id, observational status) | **I1: new codex on Mac** (launched by ops-upgrader) | gpt-6.2-sol |
| PR2 gateway skeleton (frames, registry, Adapter type, socket server, wake-attempt store) | grok@nas642:src | grok-4.7 |
| PR3 Codex adapter | codex-photos' isolated worker (plan + fixtures ready) | gpt-6.2-sol low |
| PR4 opencode adapter | **I2: codex@mac:infra relaunched** | gpt-6.2-sol low |
| Tests/scaffolding helpers | any implementer may spawn | gpt-6-luna |
| Router review + merge | claude@mac:discord-integrator | Opus (review only) |
| Security review (every PR) | claude@mac:ops-upgrader | Opus (review only) |
| Evidence / acceptance tests | codex@nas642 | review only |
| Migration operator (tmux-0 restarts, last) | claude@mac:ops-upgrader | — |
| Never-down controller | the per-host gateway (launchd KeepAlive / systemd --user) | not an LLM |

## Amendments (leader-approved, post-freeze)
**A1 (2026-11-25, sender identity vs Q1).** §4b's "external sender identity preserved" and N4 apply to **retries and fallbacks**: a held/refused message is never resent under another identity or transport. Q1 is the separate question of which transport a Claude session gets **up front**. If Mick approves Q1, that is the token post (the session's own hook-delegated credential). If Mick declines, it is a true external sender (subject to the hold) or the session's configured channel. Either way the choice is made at registration, never after a hold. The §2 Claude row and §7 Q1 stand as the two options for Mick. M1 acceptance (codex_nas) tests whichever option Mick picks, plus: held/refused never retries through a different identity, and the unread item stays available.
**A2 (2026-11-25, tool approvals).** Every agent config written by the migration must explicitly auto-approve the read-only bus tools (`check_inbox`, `claim`, `release_claim`, `list_claims`, `mcp_list`, `mcp_describe`, …). Codex config approval gaps silently cancelled `claim` (found by ops-upgrader). Write-capable tools stay gated.
**A1 dissent (recorded for Mick):** codex@nas642 holds that sender provenance applies on the first delivery too. A route that presents the recipient's own credential to avoid a hold would fail its M1 sign-off, even if chosen up front. claude_nas (R2#3) judged it no escalation, since the token is already in every child's env. The leader puts both views to Mick as Q1; his answer binds the M1 acceptance criteria.
**A3 (2026-11-25, nudge ids; codex_nas integration finding at PR1 507aea5).** `msgId` is the router's opaque durable id (a UUID), not digits. One shared builder lives in src/types.ts: `buildNudge(kind, conv, msgId, n)`. `n` is the gateway's per-conversation counter, and `text = nudgeText(n)`. `clientId` is derived from `sha256(conv:msgId)` (codex `bus-`+32 hex, opencode `msg_bus`+24 hex, others 32 hex). Adapters use `text` and `clientId` verbatim and never derive or validate ids. Cross-PR tests must use router-generated frames, not synthetic digit ids.
**A4 (2026-11-25, wire shape / publish id / alias release; resolves reviewer conflicts on PR #12).**
- **Wake frame = `{msgId, n}` only** (security review): the router never sends nudge text. The gateway builds the Nudge locally with `buildNudge(target.kind, target.conv, msgId, n)` from its *authenticated* Target, so no router-controlled text reaches native input (strengthens N1). The router's `n` is authoritative and persisted. Supersedes the "verbatim Nudge" note above.
- **publish_id:** optional sender-supplied. If absent, the router mints `pub_<unix-ms>_<uuid>`. Dedup records are retained 24 h (expiry uses the embedded time when it's router-minted, otherwise commit time) and dropped at compaction.
- **Alias release:** an alias stays bound to its identity until (a) the owning gateway sends `releaseAgent{alias}`, or (b) the same gateway re-registers the alias to a new conv (e.g. after /clear). Legacy `register` is rejected while bound. Uncommitted-to-new mail of the old conv stays keyed to the old identity and is readable via reconcile; nothing is dropped. A gateway disconnect does **not** release aliases (mail keeps queuing).
**A5 (2026-11-25, opencode allowlist).** Add read-only `GET /api/session/{id}` (session detail, used by `probe`) to the §4b opencode allowlist. The R5 Task brief already named it, and the §4b list omitted it. It stays GET-only, and nothing else is added.
**A6 (2026-11-25, host wiring PRs; codex_nas).** PR1–PR4 provide the router plus library code. Gateway and adapters are instantiated only by tests. Flipping a real scope also needs:
- **PR5a host runtime (grok_nas):** `bin/agent-bus-gateway` main (config, router link, adapters by kind, wake store path, restart recovery); `bin/agent-bus-pipe` (stdio↔gateway socket, logic-free); `readPeer` with OS peer identity (Linux `SO_PEERCRED`, macOS `LOCAL_PEERPID` + `LOCAL_PEERCRED` via bun:ffi) and the exe/parent check of §4b; launchd plist + `systemd --user` unit (runs as the user, KeepAlive / Restart=always, `ulimit -c 0`).
- **PR5b registration and discovery (codex-photos worker):** per-kind discovery that feeds `registerAgent`. Codex: `thread/loaded/list` on the user's control socket, binding conv = threadId. opencode: `GET /api/session` on the service, conv = ses id. Alias mapping from the existing fleet names plus `gateway-alias-hosts.json`. Claude is excluded until Q1.
Router rollout (PR1 merge) is independent of both. Flipping a scope needs PR5a+PR5b, review, and Mick's approval per scope.
**A7 (2026-11-25, install blockers found on PR5a by codex_nas).**
- `agent-bus-pipe` ships as a **compiled single-file executable** (`bun build --compile`), because a shebang script shows up as the interpreter to SO_PEERCRED. `verifyPipePeer` compares the realpath against the installed path.
- On (re)connect the gateway sends **registerGateway → registerAgent for every binding → wait for agentRegistered → then replay unreported wakeResults**.
- **PR5c, gateway MCP tool surface (codex@mac:infra):** the gateway speaks MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`) on each *verified* pipe connection, with the pipe staying byte-only. Tools: `check_inbox` (lease + echoed receipt, JSON result), `bus_post`, `channel_post`, `reply`, `fetch_messages`, `bus_sessions`, `claim`/`release_claim`/`list_claims`, `mcp_list`/`mcp_describe`/`mcp_call`, proxied to router ops under the verified `as`. Per-call identity comes from the verified peer plus `_meta.threadId` / `ai.opencode/sessionID` (§4b). The read-only tools are listed as safe to auto-approve (A2).
- **CLI wiring (grok, PR5a):** construct the concrete Codex and opencode adapter factories from config, start PR5b discovery, and register agents from it.
**A8 (2026-11-25, router forwarding for gateway tool calls).** The router's gateway-authenticated op set (today only lease and busPost) is extended in **PR1b (codex@mac:bus-pr1, follow-up off #12)**. A gateway op `{as, op, …}` is dispatched through the **existing legacy handler** for that op, with a session context whose name is the verified `as`. Every legacy authorization check therefore applies unchanged: claim ownership, MCP grants (session/instance), admin subscribe, `reply`/`fetch_messages` channel rules and rate limits. No parallel authz logic is written, and an op without a legacy handler is rejected. PR5c only maps MCP `tools/call` to these ops.
