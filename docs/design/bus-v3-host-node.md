# Agent bus v3: one node per host, no per-agent client

Status: **draft r0** (ops-tmux-fixer). Under 10-round critique in #bus-v3. Nothing built or deployed.

## 1. Problem

Today every agent spawns its own bus client (`plugin.ts`, a stdio MCP server holding a websocket to the router):
~20 copies across two hosts, each with its own install, self-update, naming heuristics (PR #6), orphan handling (PR #3),
and wake path (tmux `send-keys` of a fixed string, PRs #8/#9). Most of the bus bugs this week lived in that per-agent layer.
Each host also runs a node daemon (`node.ts`) for headless turns. Mick asked: can the per-agent client go away, and
can the bus become the native inter-agent protocol for the agents on a box?

## 2. Proposal in one paragraph

Split the client's two jobs. **Tools** (bus_post, channel_post, check_inbox, claim, files, mcp_*) are served by the
**router as a remote MCP server** over the tailnet; agents configure a URL plus a per-session token, nothing installed.
**Delivery/wake** (getting a message into a running conversation) is inherently local, so it moves into the **one node
daemon per host**, which drives each agent kind through its native control interface instead of typing into tmux.
The router decides *who* is woken (PR #9 rules unchanged); the node decides *how*.

## 3. Verified native control surfaces (as of 2026-11-25)

| Kind | Tool surface (MCP by URL) | Wake/inject surface for a LIVE interactive session | Headless | Evidence |
|---|---|---|---|---|
| Claude Code | yes (http MCP, `headers`/`headersHelper`) | channel notification (`notifications/claude/channel`). Docs: a channel "runs on the same machine… spawned as a subprocess… over stdio"; `--dangerously-load-development-channels server:<name>` with an http entry is **undocumented** → assume a local stdio pipe is required | `claude -p --resume <id>` (node does this today; dev-channel flag is ignored with `-p`) | code.claude.com/docs/en/channels-reference.md |
| Codex 0.132 | yes | app-server JSON-RPC: `turn/start`, `turn/steer`, `thread/resume`, `thread/loaded/list`, `thread/queue/changed`; a shared daemon listens on `~/.codex/app-server-control/app-server-control.sock` | `codex exec resume` | `codex app-server generate-json-schema`; live pids on Mac |
| opencode 2.3 | yes | TUI attaches to a background `opencode serve --service` (127.0.0.1, ephemeral port); its HTTP API can post a message into a session by id | `opencode run` | live process tree on Mac |
| agy 1.5 | yes | **no** API to inject into an open TUI (`ConversationService` exposes `runState` read only) → tmux remains; full control only if node owns it via `agy acp` / `--input-format stream-json` | `agy --resume <id> -p` | agy_mac, `agy --help` |
| grok 1.0 | unverified | none known → tmux | unverified | — |

## 4. Architecture

```
            Discord  ◄──►  ROUTER (vps2)
                            ├─ wake policy (PR #9: exact to/@name, reply-to-asker, @all, dispatcher/owner)
                            ├─ durable inboxes, claims, subs, MCP registry+grants  (unchanged)
                            ├─ NEW: /mcp  streamable-HTTP MCP endpoint (bus tools), auth = session token
                            └─ ws: nodes only (no per-agent sockets)
                                   ▲
                  ws (node secret) │
      ┌────────────────────────────┴─────────────┐
  NODE mac                                    NODE nas642
   ├─ agent table: name, kind, conversation id, control handle, cost class
   ├─ adapters: claude-channel | claude-headless | codex-appserver | opencode-http | tmux | acp
   ├─ busy/idle probe per adapter (runState, turn/started|completed, session status)
   └─ local MCP servers for the shared-MCP feature (unchanged)
```

**Identity.** Each agent gets a session token minted by the router when the node enrolls the agent
(`agent-bus-enroll <name> <kind> <conversation-id>`). The token is written into that agent's MCP config
(`Authorization: Bearer`), so the name comes from the token, not from cwd/pid heuristics (PR #6 goes away).

**Delivery.** Router → node `deliver{to, message, wake}`. Node picks the adapter for `to`:
- live + native inject available → inject (Codex `turn/steer` if a turn is running, else `turn/start`;
  opencode session prompt; Claude channel notification);
- live + no inject (agy/grok TUI) → tmux nudge with the single-flight latch (PR #9 logic moves here);
- not live → headless resume (today's node path), guarded by "nobody holds the conversation".
Passive mail is never delivered; tools read it on demand (PR #9 semantics).

## 5. What gets deleted / simplified

`plugin.ts` websocket client, supervisor, self-update, naming.ts heuristics, orphan reaping, per-agent tmux wake.
One install + one update path per host (node), already CI-gated.

## 6. Migration

Phase 0: router serves `/mcp` behind `DISCORD_HTTP_MCP=1`, same tool handlers as ws. Old clients keep working.
Phase 1: opencode@mac moves (HTTP tools + opencode-http adapter). Phase 2: Codex (app-server adapter).
Phase 3: Claude. Default plan: a **logic-free stdio pipe** (`agent-bus-pipe`, ~30 lines, like `codex app-server proxy`) that connects Claude's stdio to the node's local MCP socket. The node serves both tools and channel notifications on it. No websocket, no naming, no self-update in the pipe. If §8 Q1 passes, drop the pipe for a plain http entry.
Phase 4: agy/grok on HTTP tools + tmux adapter. Each phase reversible by restoring the old MCP config entry.

## 7. Risks

- Router becomes a hard dependency for tools (already true today via ws).
- Tokens in agent MCP configs are bearer secrets: file perms 0600, tailnet-only listener, revocable per session.
- Native control APIs are experimental (Codex app-server is `[experimental]`; opencode v2 API) → version pin + adapter contract tests.
- Injecting into a live TUI races with the human typing in it; must respect busy state.

## 8. Open questions (to be resolved in critique)

1. Do Claude Code channels work from a URL-configured MCP server (`server:<name>` pointing at an http entry), with notifications over the SSE stream? Docs say stdio only; test before relying on it.
2. Does a Codex TUI attach to the shared app-server daemon so a `turn/start` from the node lands in the same visible thread?
3. opencode: exact endpoint and auth for posting into a session on the background service.
4. Who enrolls agents and where the conversation id comes from for each kind.

## Critique log

(r1…r10 appended below, one section per round: critic, findings, disposition.)
