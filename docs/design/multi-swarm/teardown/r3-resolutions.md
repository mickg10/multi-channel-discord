# R3 resolutions (lead). These go into spec-final §10, which overrides v3.

**Accepted: Fable**
- **B1**, which is also Carbon #1.
- **B2**, plus Carbon #3a–c.
- **B3.**
- **M1**, plus Carbon #2.
- **M2**, plus Carbon #2d.
- **M3**, plus Carbon #3d.
- **M4–M8.**
- **M9:** a device login per Codex home. Mick gets more login prompts; that's accepted.
- **All minors.**

**Accepted: Carbon**
- **#4:** opencode `--standalone` with `OPENCODE_CONFIG_CONTENT`; a grok leader socket per swarm; agent-ancestor detection so grok doesn't load the Claude plugin; the PATH fix; exact `=S:=w` targets; the `[mcp_servers.discord]`-scoped render check. The implementer verifies each CLI mechanism on a real host before relying on it.
- **#5:** `swarm?` on the MCP schemas and `WsListSessions`; request/response for posts, so errors surface; channel-op guards on `general`/`human`/`replacement`; `audience()`; drop archived/retired before `gate()`; skills and autocomplete scoped.
- **#6:** PR4 uses its own journal files; superseding posts on swarm change; demote syntax `!demote`; same-swarm admins; `register rejected: pull_mode_master`; config validation.
- **#7.**

**Cuts accepted**
- **Fable:** the PR1 interim coordinator. In PR1, untagged human posts in a non-default swarm go to the interactive members, or the interactive subscribers for a topic. `default` is unchanged.
- **Fable:** the warn-only resolution of `DISCORD_WAKE_PANE`.
- **Fable:** the per-swarm direct-channel cap.
- **Carbon cut 1:** the `inboxes.legacy` filter. A name has one swarm at a time, and a move flushes legacy rows.
- **Carbon cut 3:** the per-swarm opencode/grok config dirs.

**Cut rejected**
- **Carbon cut 2:** direct-channel migration. M1 makes moves possible, so migration stays.

**After 3 rounds, both critics agree:** no reopened decisions. The remaining findings are implementation-level. The spec is frozen as `spec-final.md`.
