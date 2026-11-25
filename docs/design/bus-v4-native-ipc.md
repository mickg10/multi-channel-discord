# Agent bus v4: native IPC, one gateway per host

Owner/leader: claude@mac:ops-tmux-fixer (Opus 5.5). Baseline: v3 + critique log in `bus-v3-critique-log-ops-upgrader.md`.
Status: **v4.1** (after R1), entering 10 critique rounds (#bus-v3). Nothing built.
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
`check_inbox` tool result. Reason: native inject = user-authority input (Codex `UserInput`, opencode prompt).
Invariant **N2 (no racing the human)**: never `turn/steer`. An adapter may inject only where the agent's own input queue serializes it with human input (Claude inbox `priority:"next"` is queued by Claude itself between tool calls, or starts a turn when idle). Codex ≥0.172 provides the guarantee too: `thread/queue/add` and `thread/queue/start` (experimentalApi) run StartIfIdle and reject an active or pending turn. That is the native idle-only queue, version-gated, and it only goes live after the two-client TUI canary passes. Where the guarantee is missing (older Codex, opencode TUIs a human owns), the thread is **pull-only**: mail waits for the agent's next check_inbox, and no check-then-send. That holds until an atomic idle-only admission exists.
Invariant **N3 (exact identity)**: delivery target = native conversation id, never cwd/display name.

## 2. Adapters — evidence

| Kind | Identity | Inject into live session | Busy/idle | Evidence |
|---|---|---|---|---|
| **Claude Code 2.1.33x** | `~/.claude/sessions/<pid>.json`: sessionId, name, cwd, status, tmux, messagingSocketPath; re-read per call (handles /clear, /resume) | **Inbox socket** (documented, cross-session-messaging). NDJSON: `{"type":"auth","token":T}` then `{"type":"user","message":{"content":…},"from":"uds:…","priority":"next"}` | session file `status` | **Tested 16:15–16:19 Mac**: (1) ask-mode receiver: unauthenticated external post delivered, started turn. (2) bypass receiver, no token: **held** in approval dialog. (3) bypass receiver, orphaned process **with that session's `CLAUDE_CODE_MESSAGING_TOKEN`**: **delivered**, no dialog. |
| **Codex 0.170+** | MCP `tools/call` carries `_meta.threadId`+`sessionId` (codex-rs mcp_tool_call.rs) | app-server control socket `~/.codex/app-server-control/*.sock`: `turn/start` only when `thread/read` says idle; `turn/steer` forbidden (N2) | `thread/status/changed`, `turn/completed` | codex_nas (0.172 TUI daemon, read-only), codex_mac (0.132 schema). **Unproven:** TUI renders an external turn; human-typing race. Until proven: queue + tmux nudge for TUI-owned threads. |
| **opencode 2.3** | session id `ses_…` | `opencode serve --service` HTTP (TUI attaches), post message to session | session status API | process tree on Mac. **Owes R3**: endpoint, auth, who spawns MCP. |
| **grok 1.0.92** | ACP session id | `grok agent serve` (WS 127.0.0.1, `--secret`) / `agent stdio`; live TUI not on leader → tmux | ACP events | grok docs 15-agent-mode.md |
| **agy 1.5.17** | conversation UUID (`$ANTIGRAVITY_CONVERSATION_ID`) | Gateway-owned: `agy acp` (`session/resume`/`session/prompt`, with inline per-session `mcpServers`) or stream-json stdin (omit `-p`). Live TUI: **no inject**, so tmux nudge, gated on runState | Live TUI: a SessionStart hook gives LS address and CSRF token, and `ConversationService/GetConversation` returns `runState` IDLE/RUNNING. Gateway-owned: turn framing | agy_nas verified live on nas642 (docs: headless.md, hooks.md) |

### Claude registration (no setting change, no per-agent process)
A `SessionStart` hook (user settings, all sessions) runs `agent-bus register` once. It inherits
`CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` and `CLAUDE_SESSION_ID`/pid, and hands them to the gateway over its
0600 unix socket, then exits. Gateway stores token in memory + 0600 state file, keyed by sessionId, refreshes on
every hook fire (SessionStart fires on resume/clear too — **verify**). Bypass sessions then accept the gateway's
nudges (test 3). Fallbacks in order: hook missing → tmux nudge; token rejected → re-register on next hook.

## 3. Tools

Agents keep an MCP entry, but it points at the **gateway**, not the router:
- Claude: logic-free stdio pipe `agent-bus-pipe` → gateway socket (channels need stdio; tools only — wake is the inbox socket).
- Codex: same pipe, or gateway loopback HTTP. Identity comes from authenticated transport plus per-call `_meta.threadId`; a call missing it or mismatched is rejected. Parent and child threads under one daemon each bind separately, since a child spawning a second client with the same alias must not retire the parent (R1#2).
- opencode/grok/agy: pipe; identity from gateway's launch record (gateway-owned) or bus-launch token.
Gateway stamps `(host,user,kind,conv-id)` on every call to the router; router rejects node-secret-only calls.

## 4. Durability (fixes live router bugs found by codex_nas)
Three distinct states per message, one stable msg id across reconnects: **committed** (router fsync) → **woken** (gateway nudge sent; losing this ack only costs a nudge) → **accepted** (recipient's check_inbox returned it and acked). Mail stays readable until accepted.
Commit-before-ack on enqueue; lease by msg id on drain; ack only after recipient accepted; overflow is an
error to the sender, never silent oldest-drop; uncertain inject → "unresolved", reconciled, never replayed blindly.

## 5. Controller
Scope: a gateway controls only its own host. If the host is lost, its agents are gone too, and the router's durable mail is the cross-host continuity, so there is no standby gateway (R1#4 considered and rejected). Upgrades work by drain, then exec, and KeepAlive restarts it.
The gateway is the never-down controller (KeepAlive/systemd --user). It (a) restarts dead agents in tmux session 0
with their own conversation id, (b) never restarts itself or the shared Codex daemon to fix its own state,
(c) applies upgrades by draining, then exec. Migration operator (an agent): ops-upgrader, restarts last.

## 6. Migration (per kind, old client stopped in the same step its adapter goes live)
M0 gateway + durability, no adapters. M1 Claude (hook + inbox socket). M2 opencode. M3 Codex (queue+nudge first,
native after the disposable race test). M4 grok/agy (ACP for gateway-owned, tmux for TUIs). M5 retire plugin.ts ws client.
Each step: disposable session test → one real agent → fleet; revert = restore old MCP entry.

## 7. Open questions for Mick
Q1 SessionStart hook in user settings for all Claude sessions (needed for M1). **This deliberately lets the gateway skip the bypass-session hold for its fixed nudge**, using the session's own messaging token. The alternative is `crossSessionInbound: accept`, which opens the gate to every same-user sender, or living with the hold. The nudge carries no body (N1). Mick's security call. — OK?
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
