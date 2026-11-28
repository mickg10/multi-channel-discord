# R1 critique (fable) of spec-v1.md

Code refs are main 07e77bd unless marked (#26)/(#27). 6 blockers, 12 majors, 6 minors.

## Blockers

**B1. "Names may repeat across swarms, key is (swarm, name)" is the most expensive line in the spec and breaks its own config.** It is not one of Mick's decisions.
- Every privilege is an alias string: `DISCORD_CROSS_SWARM`, `DISCORD_SWARMS` coordinators, `DISCORD_ADMIN_SESSIONS` (ws.ts:1824), MCP grants, `protectedRenameAlias` (ws.ts:443). A `cfd` session named `claude@mac:swarm-master` would be cross-swarm. `demote <alias>` "acts on that alias's swarm" is undefined once test 11 allows the alias in two swarms.
- Name-keyed state that would need re-keying: `SessionManager.sessions` (sessions.ts:27), `pullSessions` (ws.ts:156), inbox rows, `Subscriptions`, `Conversations`, `CostClasses`, `Unread`, `busPostTimes` (ws.ts:1415), `rules-seen.json`, `AgentChannels.channelFor` (agent-channels.ts:86 #26), `NameLeases` (#27), `Claims`.
- The test premise "same agent name on two hosts" cannot occur: names embed the host (plugin.ts:303).
- **Fix (spec text):** "Bus names stay globally unique, with the existing `-N` suffix and #27 leases unchanged. `swarm` is an attribute of the session and of each durable inbox row. It is a filter, not part of the key." Delete PR1 interface 7's re-keying and PR4 test 11. Test instead: same host and project in sessions `cfd` and `bus` gives `x` and `x-2`, each visible only in its own swarm.

**B2. A cross-swarm session can send but nobody can answer it.** `assertSameSwarm(fromSession, target)` only exempts the sender, so a `cfd` agent's `to=claude@mac:swarm-master` is rejected. Mick's Discord reply to a swarm-master post in `cfd:general` resolves the `**[name →` prefix (router.ts:394-398) inside `cfd` and misses.
- **Fix:** "`to=` is allowed when sender and target share a swarm, or either is a cross-swarm session. The human reply-to-post path resolves the asker in the channel's swarm plus the cross-swarm set. A cross-swarm session is an audience member only of its own swarm: it gets no `@all` and no untagged posts from other swarms."

**B3. The wake guard breaks today's agents and guards the wrong thing.**
- `agents` maps to `default`, so comparing the pane's `#{session_name}` (`agents`) with `SWARM_ID` (`default`) turns wake off for every current agent.
- A daemon Codex has no own pane. An explicit `DISCORD_WAKE_PANE` in any session other than `agents` is then "another session", so wake goes off (plugin.ts:319).
- After `rename-session` or `move-window` the pane is still the agent's own pane. Refusing leaves a pull-mode agent silently deaf until a reconnect, which may be days away.
- **Fix:** cut the per-`send-keys` check. "At startup, if the plugin found its own pane by the ancestor walk and `DISCORD_WAKE_PANE` names a different pane, ignore the override with a warning. With no own pane, `DISCORD_WAKE_PANE` is trusted as today." Compare raw session names only, never the mapped swarm.

**B4. "Finds its pane as today (`findTmuxPane`)" is wrong.** Today it runs only when `DISCORD_WAKE=tmux` and no env pane is set (plugin.ts:319-320). Claude push sessions never call it. `TMUX_PANE` inside a Codex app-server daemon is whichever TUI started the daemon, so it is stale.
- **Fix:** "Swarm discovery always runs the ancestor walk and never uses `TMUX_PANE`. Only if the walk finds no pane, use `SWARM_ID`, else `default`."
- Consequence to state: a plain `codex` started by hand in session `cfd` on the shared `~/.codex` joins `default`. That contradicts "any window of session `cfd` is in swarm `cfd`". Either accept and document it, or have the Codex plugin refuse to register when a TUI ancestor's session differs from `SWARM_ID`.

**B5. Tools that take a raw channel id bypass all scoping.** The spec lists `assertSameSwarm` only for `bus_post`, `channel_*`, `assign`, `answers`.
- `reply` with `chatId` writes to any channel (ws.ts:1014-1037).
- `fetchMessages` reads any channel (ws.ts:1149-1166). So do `react`, `editMessage`, `downloadAttachment` (ws.ts:910-930).
- `channelOps.resolve` accepts an id or `<#id>` and matches names guild-wide with `find` (router.ts:213-220). `general` exists in every swarm, so the first hit wins.
- `handleDispatch` re-delivers any remembered human post by id (ws.ts:1732). The `default` dispatcher can pull a `cfd` post into `default`.
- `listClaims` returns the global table (ws.ts:697). `inboxCount` and `agentStatus` take any name (ws.ts:716-729).
- **Fix:** "Every op that takes a channel id or ref calls `assertChannelInSwarm(caller, channelId)` after resolution, however the ref was written. DMs and the active chat are exempt. `dispatch`, claims, `inboxCount` and `agentStatus` are scoped to the caller's swarm." Add one test per op.

**B6. The channel→swarm map is built only from channels the router created, so the migration cannot work.** Moving #cfd into a `cfd` category by hand leaves it out of `swarms.json`. Archived channels move to the global `archive` category (router.ts:243) or `Agents (archived)` (#26).
- **Fix:** "`channelSwarm(id)` is the swarm whose category, or overflow category, is the channel's current `parentId`, else the persisted id (for archived channels), else `default`. `default` is every channel not mapped to another swarm. On start the router adopts an existing category named `<id>`. When a channel changes swarm, subscriptions of non-members and its `DISCORD_CHANNEL_OWNERS` entry are dropped, with a notice."

## Majors

**M1. `DISCORD_SWARMS` cannot be an env var.** Env is read once (router.ts:32-58), but interface 2 and A10 v2:16 require an immediate reload. The `alias:priority` grammar is ambiguous because aliases contain `:` (`claude@mac:7`). **Fix:** `STATE_DIR/swarms-config.json`, `{swarm: {candidates: [{alias, priority}]}}`, re-read on use like `node-secrets.json` (router.ts:46-50). Malformed fails closed.

**M2. "First sight creates a category" contradicts "unknown → default".** Client strings must never create Discord objects. **Fix:** "A swarm exists only if configured. An ID must match `^[a-z0-9][a-z0-9-]{0,30}$` and not be `default`, `agents`, `archive`, `all` or `human`. Anything else is `default`, and `registered` returns `{swarm, requested}` so the plugin logs the downgrade. Category creation is single-flight per swarm, adopts by name first, and never blocks `register`. Until channels exist, posts fail with `swarm_not_ready`."

**M3. Swarm is stuck at `default` after the config gains a swarm.** `SessionRec.swarm` is immutable, so sessions that registered before `cfd` was configured keep receiving `default` traffic. **Fix:** store the requested swarm; on config reload, close affected connections so they re-register.

**M4. The frame is `register`, not `hello`** (plugin.ts:160, ws.ts:818). Sessions are not journalled (sessions.ts:27); only inbox rows are. Gateway `registerAgent` (ws.ts:~500-548) and `registerNode` agents have no swarm. Offline names enter routing through `allNames` (ws.ts:159-164). **Fix:** "`register.swarm`. Gateway and node agents are `default` in PR1. The swarm of an offline name is the swarm on its inbox rows."

**M5. #26 conflicts.** It uses global `Agents` and `Agents N` categories, adopts by topic across them (`ensure`), has a global `MAX_AGENT_CHANNELS=100`, and creates after 60 s, not "on first registration". A swarm category shares Discord's 50-channel limit between agent and topic channels, and `channel_create` has no overflow handling (router.ts:228-239). **Fix:** specify overflow as `<id> 2`, counted by `channelSwarm`; `ensure` searches only that swarm's categories; the cap is per swarm; `channel_create` uses the same overflow picker.

**M6. The PR1 fallback contradicts the code and A10's motivation.** "Falls back to the live members" reintroduces the duplicate-owner broadcast (A10 v2:5). The code falls back to interactive push sessions only (ws.ts:1809-1817). **Fix:** "interactive members of that swarm, as today; if there are none, 'not routed'." Keep the notice as an in-place reply (router.ts:427), not a post in `<id>:human`.

**M7. The PR4 example violates A10 v2.** `cfd=codex@nas642:cfd-lead:1,claude@nas642:src:2` puts both candidates on one host (HA, v2:39) and makes a working agent a candidate ("the master does no implementation", v2:37). A pull-mode Codex master pongs from the daemon after its TUI dies, so it is never replaced (v2:15). **Fix:** candidates are dedicated push-mode sessions on two hosts, or state that single-candidate swarms have no HA.

**M8. `demote` authority is unspecified.** v2:16 says "Mick or an admin session", and admins are global. **Fix:** `demote <swarm> [alias]`, allowed for Mick in that swarm's channels and for cross-swarm sessions.

**M9. Alias privilege is spoofable at register.** The host is client-claimed (ws.ts:828) and rename protection does not cover the new lists. **Fix:** add cross-swarm and candidate aliases to `protectedRenameAlias`; a cross-swarm alias must register in `default`; state that swarm membership is client-asserted and gives no protection against a hostile agent.

**M10. `start-agents.sh`.**
- `--swarm cfd` sets `HOST=cfd` and exits "unknown host" (lines 16-21, 48). Use a `while`/`shift` parser.
- `-t "$S"` is prefix-matched by tmux, so `cfd` can hit `cfd-injection` (lines 51, 55, 77-83). Use `-t "=$S"`.
- `--restart-codex-daemons` kills every daemon for the user (line 70), and with `S=cfd` the `agents` TUIs count as foreign, so it always refuses. Match the daemon by `CODEX_HOME`.
- Nobody provisions `~/.codex-<id>` (auth, `config.toml`, `SWARM_ID`), and `codex-photos` already has its own home (line 37).
- `--restart` on an arbitrary ID can kill a personal session. Refuse when the session has windows the script does not own.

**M11. Grouped or linked sessions.** `tmux new -t cfd` creates `cfd-1`, and `#{session_name}` for a shared pane is then ambiguous. **Fix:** use `#{session_group}` when it is set; if the pane is in several ungrouped sessions, keep the previous swarm and warn.

**M12. The cross-swarm `<id>:<name>` address is ambiguous.** A bare alias `cfd:lead` is legal (ws.ts:430-434). **Fix:** an explicit `swarm` argument on tools, honoured only for cross-swarm callers.

## Minors

- `cross_swarm` for a plain `to=` needs a global lookup, against interface 4. Return "No session named X in swarm cfd". The `resolveExact` error lists names (wake.ts:22), so pass it scoped names only.
- `sendRulesOnce` stamps `busChannelId` (ws.ts:264). Use the swarm's general.
- With duplicate `instanceId`, `registerSession` returns the existing slot (sessions.ts:36-45), so a re-register must close the old socket first.
- #27's saved `-N` name follows the instance into a new swarm. Harmless under B1.
- `swarms.json` holding `term` needs an fsync before the announce.
- State the order PR1 → PR2 → PR3 → PR4, since PR4 needs `role` from the plugin.

## Cut

The (swarm, name) re-keying (B1), the per-wake session check (B3), PR4 test 11, and `<other>:<name>` string parsing (M12).

## Test gaps

- Human reply to a cross-swarm session's post.
- An id-based `channel_post`, `reply` and `fetch_messages` into another swarm.
- `dispatch` of another swarm's message id.
- A channel moved between categories by hand.
- A config reload with live sessions.
- Concurrent first registrations create one category.
- An old plugin (no `swarm`) against the new router, and the reverse.
- Wake still fires in session `agents` and with a daemon plus `DISCORD_WAKE_PANE`.
- An old `inbox.jsonl` replays as `default`, and a rollback reads the new rows.
- A topic channel with no subscribers.
- A swarm of only pull-mode agents with the coordinator down.

## Checked and fine

- An extra `register` field is ignored by the old router, so the plugin can ship first.
- Human routing has one seam (`oneHumanTarget`, ws.ts:1703), so `pickCoordinator` is a clean swap.
- The 30 s restart hold matches the v2:14 bound.
- Topic-channel-to-master routing matches v2:19.
- tmp+rename matches the existing stores.
- `to=human` per swarm maps onto ws.ts:1589-1594.
- tmux forbids `:` and `.` in session names.
- The router has no ping/pong today, so liveness is correctly PR4 scope.
