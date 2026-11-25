# Agent bus v4: native IPC, one gateway per host

Owner/leader: claude@mac:ops-tmux-fixer (Opus 5.5). Baseline: v3 + critique log in `bus-v3-critique-log-ops-upgrader.md`.
Status: **v4.0 draft**, entering 10 critique rounds (#bus-v3). Nothing built.
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
Invariant **N2 (queue unless idle)**: never inject into a busy turn; never `turn/steer`. Busy → queue, nudge on idle.
Invariant **N3 (exact identity)**: delivery target = native conversation id, never cwd/display name.

## 2. Adapters — evidence

| Kind | Identity | Inject into live session | Busy/idle | Evidence |
|---|---|---|---|---|
| **Claude Code 2.1.33x** | `~/.claude/sessions/<pid>.json`: sessionId, name, cwd, status, tmux, messagingSocketPath; re-read per call (handles /clear, /resume) | **Inbox socket** (documented, cross-session-messaging). NDJSON: `{"type":"auth","token":T}` then `{"type":"user","message":{"content":…},"from":"uds:…","priority":"next"}` | session file `status` | **Tested 16:15–16:19 Mac**: (1) ask-mode receiver: unauthenticated external post delivered, started turn. (2) bypass receiver, no token: **held** in approval dialog. (3) bypass receiver, orphaned process **with that session's `CLAUDE_CODE_MESSAGING_TOKEN`**: **delivered**, no dialog. |
| **Codex 0.170+** | MCP `tools/call` carries `_meta.threadId`+`sessionId` (codex-rs mcp_tool_call.rs) | app-server control socket `~/.codex/app-server-control/*.sock`: `turn/start` only when `thread/read` says idle; `turn/steer` forbidden (N2) | `thread/status/changed`, `turn/completed` | codex_nas (0.172 TUI daemon, read-only), codex_mac (0.132 schema). **Unproven:** TUI renders an external turn; human-typing race. Until proven: queue + tmux nudge for TUI-owned threads. |
| **opencode 2.3** | session id `ses_…` | `opencode serve --service` HTTP (TUI attaches), post message to session | session status API | process tree on Mac. **Owes R3**: endpoint, auth, who spawns MCP. |
| **grok 1.0.92** | ACP session id | `grok agent serve` (WS 127.0.0.1, `--secret`) / `agent stdio`; live TUI not on leader → tmux | ACP events | grok docs 15-agent-mode.md |
| **agy 1.5** | conversation id | `agy acp` / stream-json only for gateway-owned sessions; live TUI → tmux | `ConversationService.runState` | agy_mac |

### Claude registration (no setting change, no per-agent process)
A `SessionStart` hook (user settings, all sessions) runs `agent-bus register` once. It inherits
`CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN` and `CLAUDE_SESSION_ID`/pid, and hands them to the gateway over its
0600 unix socket, then exits. Gateway stores token in memory + 0600 state file, keyed by sessionId, refreshes on
every hook fire (SessionStart fires on resume/clear too — **verify**). Bypass sessions then accept the gateway's
nudges (test 3). Fallbacks in order: hook missing → tmux nudge; token rejected → re-register on next hook.

## 3. Tools

Agents keep an MCP entry, but it points at the **gateway**, not the router:
- Claude: logic-free stdio pipe `agent-bus-pipe` → gateway socket (channels need stdio; tools only — wake is the inbox socket).
- Codex: same pipe, or gateway loopback HTTP; identity from `_meta.threadId`, reject missing/mismatched.
- opencode/grok/agy: pipe; identity from gateway's launch record (gateway-owned) or bus-launch token.
Gateway stamps `(host,user,kind,conv-id)` on every call to the router; router rejects node-secret-only calls.

## 4. Durability (fixes live router bugs found by codex_nas)
Commit-before-ack on enqueue; lease by msg id on drain; ack only after recipient accepted; overflow is an
error to the sender, never silent oldest-drop; uncertain inject → "unresolved", reconciled, never replayed blindly.

## 5. Controller
The gateway is the never-down controller (KeepAlive/systemd --user). It (a) restarts dead agents in tmux session 0
with their own conversation id, (b) never restarts itself or the shared Codex daemon to fix its own state,
(c) applies upgrades by draining, then exec. Migration operator (an agent): ops-upgrader, restarts last.

## 6. Migration (per kind, old client stopped in the same step its adapter goes live)
M0 gateway + durability, no adapters. M1 Claude (hook + inbox socket). M2 opencode. M3 Codex (queue+nudge first,
native after the disposable race test). M4 grok/agy (ACP for gateway-owned, tmux for TUIs). M5 retire plugin.ts ws client.
Each step: disposable session test → one real agent → fleet; revert = restore old MCP entry.

## 7. Open questions for Mick
Q1 SessionStart hook in user settings for all Claude sessions (needed for M1) — OK?
Q2 Relaunch grok/agy gateway-owned (ACP) instead of TUI, where no human uses that pane?
Q3 nas642 node moves from root system unit to `systemd --user` (lingering) — OK?

## Critique log (v4)
- **claude_nas (native-ipc: claude row, nas642 2.1.332, outside rota):** a persistent node-owned headless Claude (`-p --input-format stream-json`) can `SendMessage` to any idle TUI, including plain `claude`, with a 2 s wake. But it costs one model turn per wake (~$0.006 Haiku), and delivery is gated by permission-mode class (bypass→auto was held). `claude agents --json` (supported CLI) returns pid, sessionId, name, cwd, status without a TTY. **Disposition:** adopt `claude agents --json` as the Claude registry source. It beats parsing session files, but the per-call re-read stays. Keep the token-post adapter as primary: zero model cost, and test 3 delivered into bypass. A Haiku-child SendMessage is fallback #2 for sessions with no hook registration, before tmux.
