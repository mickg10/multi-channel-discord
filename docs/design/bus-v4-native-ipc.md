# Agent bus v4: native IPC, one gateway per host

Owner/leader: claude@mac:ops-tmux-fixer (Opus 5.5). Baseline: v3 + critique log in `bus-v3-critique-log-ops-upgrader.md`.
Status: **v4.5** (after R5), entering 10 critique rounds (#bus-v3). Nothing built.
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
3. A cheap node-owned Claude `SendMessage` (claude_nas).
4. tmux.

**Conversation check before every Claude nudge (R2#4):** the token is per process, not per conversation. `/clear` changes sessionId under the same pid, socket and token. Before nudging, the gateway compares the pid's *current* sessionId (`claude agents --json`) with the mail's target. On mismatch it sends no nudge, and the mail waits for that conversation.
**Frames:** an authed client could also send control frames (`rename`, `peer_message_status`, `notify_when_idle`, …). The gateway sends only `type:user` with the constant nudge. Any other frame type is a code-review blocker.

### Claude registration (no setting change, no per-agent process)
A `SessionStart` hook (user settings, all sessions) runs `agent-bus register` once. It inherits
`CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` and `CLAUDE_SESSION_ID`/pid, and hands them to the gateway over its
0600 unix socket, then exits. Gateway keeps tokens **in memory only** (R2#5; a state file would hand all sessions' tokens to any same-user reader) and re-learns them from `SessionStart` (fires with `source:"clear"` and on resume; verified by claude_nas) and `UserPromptSubmit` hooks after a gateway restart. Env: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`. Bypass sessions then accept the gateway's
nudges (test 3). Fallbacks in order: hook missing → tmux nudge; token rejected → re-register on next hook.

## 3. Tools

Agents keep an MCP entry, but it points at the **gateway**, not the router:
- Claude: logic-free stdio pipe `agent-bus-pipe` → gateway socket (channels need stdio; tools only — wake is the inbox socket).
- Codex: same pipe, or gateway loopback HTTP. Identity comes from authenticated transport plus per-call `_meta.threadId`; a call missing it or mismatched is rejected. Parent and child threads under one daemon each bind separately, since a child spawning a second client with the same alias must not retire the parent (R1#2).
- opencode/grok/agy: pipe; identity from gateway's launch record (gateway-owned) or bus-launch token.
Gateway stamps `(host,user,kind,conv-id)` on every call to the router; router rejects node-secret-only calls.

## 4. Durability (fixes live router bugs found by codex_nas)
Per message, one stable msg id across reconnects: **committed** (router fsync, synchronous) → **woken** (a native ack such as Codex queue/add or opencode prompt means the *adapter's nudge was admitted*, not that mail was read) → **accepted** (the recipient's `check_inbox` returned it and acked). Terminal side-states: **held / refused / uncertain**, operator-visible, mail still readable, no fallback (N4). Implementation is a **focused Inboxes and protocol refactor**, not a router rewrite (R5#3). It needs a synchronous atomic commit, entries with id, state and lease, a lease/ACK on drain, wake attempt and ACK records, restart recovery, and overflow surfaced to the sender instead of dropping at 501.
Commit-before-ack on enqueue; lease by msg id on drain; ack only after recipient accepted; overflow is an
error to the sender, never silent oldest-drop; uncertain inject → "unresolved", reconciled, never replayed blindly.

## 5. Controller
Gateway-owned agents (grok/agy ACP children, persistent helpers) are **not** children of the gateway process. Each runs in its own tmux-0 window under a tiny restart loop, so a gateway crash or upgrade never kills them (R4#3). Persisted state: msg states, woken id (**fsync before the native send**), and pane plus conversation id per agent. **Tokens are never persisted.** After a gateway restart, an idle bypass Claude has no token until its next hook fire, so its wake falls back to channel, then SendMessage helper, then tmux (R4#4).
Scope: a gateway controls only its own host. If the host is lost, its agents are gone too, and the router's durable mail is the cross-host continuity, so there is no standby gateway (R1#4 considered and rejected). Upgrades work by drain, then exec, and KeepAlive restarts it.
The gateway is the never-down controller (KeepAlive/systemd --user). It (a) restarts dead agents in tmux session 0
with their own conversation id, (b) never restarts itself or the shared Codex daemon to fix its own state,
(c) applies upgrades by draining, then exec. Migration operator (an agent): ops-upgrader, restarts last.

## 5b. Codex RPC contract (pinned, R5#2)
`initialize{capabilities.experimentalApi:true}` → version and capability allowlist (≥0.170; `thread/queue/add` present) → `thread/queue/add{threadId, input:[fixed nudge], clientUserMessageId}` and **nothing else**. Reconcile with `thread/queue/list` plus `thread/read{includeTurns:true, itemsView:"full"}`, paged to `nextCursor:null`, matching `clientUserMessageId` / `userMessage.clientId`. `clientUserMessageId` = hash(recipient threadId, bus msg id), immutable. The control socket must be owned by the user (stat check), mode 0600.

## 6. Migration (per kind, old client stopped in the same step its adapter goes live)
M0 gateway + Inboxes refactor + JSON check_inbox, no adapters, **no tmux restarts**. Build order (R5#5): M0, then **Codex (Mac) and opencode in parallel**, since both have passing canaries and opencode's tmux wake is broken today. Then Claude (after Q1), then agy/grok. No generic adapter framework or status UI: a minimal `Adapter{probe, wake, reconcile}` interface only. M1 Claude (hook + inbox socket). M2 opencode. M3 Codex (queue+nudge first,
native after the disposable race test). M4 grok/agy: ACP for gateway-owned. Live grok TUIs are pull-only (tmux repeats the stuck-composer bug) until a disposable leader-mode test passes. Live agy TUIs use the tmux nudge gated on runState. CFD sessions are excluded throughout. Gates: M1 needs Q1, The M2 identity gate has passed. The idempotency and busy-ordering gate has also **passed** (codex_nas 16:48, isolated 2.0.18). The same caller `msg_…` id gives one pending item that is never merged into the busy turn, dispatches once, and is still deduped after dispatch and after a service restart. **Caution:** a changed body that reuses an id returns success but keeps the original, so the id is derived from an immutable (recipient, nudge) pair and success is never read as "this text accepted". Remaining M2 gate: visual rendering in an attached TUI. M5 retire plugin.ts ws client.
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
