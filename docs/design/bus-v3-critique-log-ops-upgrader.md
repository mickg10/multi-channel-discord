# Host gateway + HTTP MCP proposal — critique log

Channel: #discord_integration (1574810821291147347). Requested by Mick 2026-11-25 15:53Z: "Think very hard … 10 rounds of critique".

Schedule: R1 R5 R9 grok@nas642:src · R2 R6 codex@nas642 · R3 R7 opencode_nas642_glm53_abli · R4 R8 claude@mac:multi-channel-discord · R10 consolidated → post to human.

## v1 (posted 2 parts)
A. Router serves Streamable HTTP MCP; identity options (i) per-dir header (ii) bus_whoami bind to MCP session (iii) local gateway proxy names.
B. One gateway per host; adapters: opencode serve HTTP API; codex app-server control socket (unverified: TUI render + concurrent turns); Claude keeps thin stdio client (channels); tmux fallback for agy/grok.
C. Busy-check before inject + single-flight; localhost-only adapter APIs (yolo = RCE); router-only trust, from_human from router; gateway keeps name→session map; gateway down → tools still work, inbox queues.
D. Rollout 0 spike, 1 opencode, 2 codex, 3 HTTP MCP, 4 retire non-Claude clients.

## Round log
- R1 grok: (pending)
- R1 grok: identity split (HTTP vs gateway map); (i)(ii) fail; (iii) only binding; drop "tools work w/o gateway"; cutover per type (no double wake); codex no turn/start on TUI-loaded thread until test; grok stays tmux.
## v2
A' local gateway stamps name+conv id; router rejects node-secret-only. Agent→gateway via (a) stdio `bus-pipe` shim (peer pid via SO_PEERCRED/LOCAL_PEERPID; unifies Claude channels via notifications down pipe) [recommended] or (b) loopback HTTP + peer-pid lookup.
C' gateway down → tools+wakes wait. Codex adapter queue-only until disposable same-thread test.
D' cutover per agent type; grok/agy tmux adapter; claim = one gateway/host + dumb shim.
- R2 codex@nas642: (pending)
- R2 codex@nas642: bun ffi SO_PEERCRED works on Linux (gives shim pid); parent/cwd ambiguous → explicit launcher registration w/ capability+generation; crossed-claim test; turn/start steers active turn → queue-only until idle-only op/owner-side dequeue; isolate daemon adapter, never restart daemon.
## v3
A'' bus-launch mints token+generation in env; peer pid ancestry corroborates; daemon-spawned MCP (codex app-server, opencode service?) = node-level read-only tools.
B'' codex queue-only; race test; no dedup assumption; isolated conn; rediscover after daemon restart; never restart daemon.
- R3 opencode: (pending)
- (outside rota) claude@nas642:src/Fable: (1) native inject = UserInput w/ Mick authority → adapters inject ONLY a fixed nudge string; bodies+from_human only via check_inbox tool result; test: injection-text to disposable yolo codex → only nudge in transcript. (2) /clear,/resume change Claude session id under same pid → gateway re-reads ~/.claude/sessions/<pid>.json per call (has status busy/idle + tmux pane); Claude needs no bus-launch; mandatory bus-launch = ask Mick. Note: opencode acp / agy acp exist. → fold into v4 with R3.
- ops-tmux-fixer: duplicate stopped; PR #10 bus-v3-design docs/design/bus-v3-host-node.md → I own it; channels doc: local stdio only, http under server: undocumented, ignored under -p; Mac opencode TUI attaches to serve --service on 127.0.0.1 ephemeral port
- codex@mac (handoff): control sock exists on Mac, attach of agents:2 unproven; node.ts codex = one-shot exec resume (idle), not live injection; test matrix: 2 clients, visible-TUI delivery, busy turn/start vs steer, reconnect, single input owner.
- codex@nas642 correction: codex 0.170 tools/call carries _meta.threadId+sessionId (mcp_tool_call.rs L634-639, L1562-1593) → per-thread codex tool identity w/o bus-launch; verify 2 same-cwd threads identity echo; reject missing/mismatched meta; wake still queue-only.
- codex@nas642 delivery evidence (disposable fixtures, current Inboxes): enqueue+exit → 0 recovered (200ms batched save nodes.ts); drained-unacked batch → 0 recovered (ws.ts drains before reply); 501 msgs → oldest silently dropped. v4: commit-before-ack, lease by msg id, ack after recipient acceptance, overflow surfaced to sender, uncertain acceptance w/o idempotent submit → unresolved for reconciliation. ALSO a live-router bug today.
- Mick idea: Claude adapter = native peer socket. Facts: session json has messagingSocketPath /tmp/cc-socks/<pid>.sock, peerProtocol 1, status, tmux; .key 0600. ops-tmux-fixer tested: peer msg starts idle turn, wrapper cross-session-message (peer trust, not user). Risks: undocumented→version pin+fallback (channel shim→tmux); node must run as the user (nas642 root unit doesn't); no ack. Untested: nas642, non-bypass. Adapter sends fixed nudge only.
- DOCS (cross-session-messaging): socket documented for own-child (hooks/Bash) via CLAUDE_CODE_MESSAGING_SOCKET/TOKEN; external posts = no permission class; bypass receiver may hold per crossSessionInbound; identical repeats deduped; 50 queue cap; no ack. v4 Claude adapter: SessionStart hook registers socket+token+session_id+pid to gateway; fixed nudge w/ varying id; test bypass/non-bypass/hold/nas642; gateway runs as user.
- MICK GOAL (16:12): native IPC wherever possible, tmux only fallback. Matrix: claude inbox socket (documented); opencode serve --service HTTP + api/acp; codex app-server control socket (queue-only for TUI threads); grok agent serve WS 127.0.0.1:2419 secret / agent stdio / leader.sock (live TUI not on leader → tmux); agy acp (headless only). Asked Mick: OK to launch grok/agy daemon-attached?
- MICK: multi-claude across workspaces. Docs: same-machine not dir-scoped; address by /rename name (+short id on dup); cross-machine only via Remote Control (Anthropic, claude.ai login) → bus stays cross-host. Mac: 4 sessions (2 in ~/src, 2 in ~/src/ops), stale 89497.sock w/o session file → validate pid+session file. Mapping: claude@host:<name> → session by name, reread per call; dup name = error; unnamed → sessionId[:6]. BLOCKER: bypass receiver HOLDS non-bypass/unverified senders (5m dialog). Options (a) crossSessionInbound accept [rec] (b) own-child relay via SessionStart hook (c) tmux. Asked Mick.
- codex@mac: Mac codex 0.132 app-server stdio/unix/ws; TurnSteerParams requires expectedTurnId (mismatch fails) — concurrency precondition; unverified TUI render/reconnect/approval ownership; daemon PATH must include node.
