# R2 critique (fable) of spec-v2.md

Code refs are main 07e77bd unless marked (#26)/(#27). 5 blockers, 9 majors, 6 minors. Everything here is new in v2 or was not raised in R1.

## Blockers

**B1. Pull-mode agents with the same name evict each other across swarms; the "x and x-2" test cannot pass for them.**
- The router treats every pull-mode register without an explicit `takeover` as a takeover (ws.ts:843) and deregisters the incumbent (ws.ts:851-860). The plugin sends `takeover` only for a configured name (plugin.ts:460).
- `start-agents.sh` starts every CLI in `~/src` (lines 33, 42), so `agy@mac:src` in `cfd` takes the name from `agy@mac:src` in `agents`. The default seat is retired (`replaced`), silently off the bus.
- **Fix (§2):** "A takeover whose incumbent is in another swarm is not a takeover: it is a plain registration and gets the next `-N`. Test with two pull-mode seats, not only push."

**B2. Names flip between swarms by start order, and name-keyed state follows the name.** Instance ids are PIDs (plugin.ts:128-132), so after a reboot neither #27 leases nor `assignedAlias` help. Whichever of `agents` and `cfd` registers first gets `claude@mac:src`, and with it the other swarm's queued inbox rows, subscriptions, claims, `DISCORD_CHANNEL_OWNERS` entry, `DISCORD_ADMIN_SESSIONS` right (router.ts:58) and #26 direct channel.
- **Fix (§5):** "For a non-default swarm the generated name is `<agent>@<host>:<swarm>/<dir>` (legal: bus-alias.ts:6)." Names stay global, and no key changes.
- **Fix (§2):** "The router journals `name → swarm` at register. A register of a name whose journalled swarm differs is a collision and gets `-N`." This covers explicit names (`/name`, `bus_rename`, `DISCORD_SESSION_NAME`).
- This also replaces "offline swarm = newest inbox row", which is wrong: `inboxes.names()` includes names with a remembered conversation and no rows (inboxes.ts:304-308). An offline `cfd` agent with an empty inbox reads as `default`, so `default` can queue mail to it.

**B3. The rendered Codex config points the swarm seat at the default seat's name and pane.** `~/.codex/config.toml` on the Mac has `DISCORD_SESSION_NAME = "codex@mac"` and `DISCORD_WAKE_PANE = "agents:codex"`. §7 only adds two keys. The `cfd` daemon then registers as `codex@mac` with `takeover: true` (plugin.ts:156) and evicts the default Codex. It has no own pane, so §5 trusts the override and types its wake nudges into `agents:codex`.
- **Fix (§7):** "The render rewrites `DISCORD_SESSION_NAME` to `codex@<host>:<swarm>` and `DISCORD_WAKE_PANE` to `=<swarm>:<window>`, and fails if either still names another session. One `CODEX_HOME` per Codex window, since name and pane are per home."
- **Fix (§5):** "With no own pane, a `DISCORD_WAKE_PANE` whose session normalises to a swarm other than `SWARM_ID` is ignored."

**B4. `unknown_swarm` takes this Mac's working sessions, including both cross-swarm sessions, off the bus.** `tmux ls` here shows `0` (9 windows: the `swarm-master`, `bus-pr1`, `bbq` and `bus-simplify` windows, with claude, codex, opencode, grok) and `agents`. Once the config file exists, every plugin in session `0` sends `swarm: "0"`, which is not configured, so it is rejected and retries forever. §1 requires cross-swarm sessions to be in `default`, which they can no longer reach.
- This is not the R1 typo case. It is every agent started by hand.
- **Fix (§1):** "`defaultSessions: ["agents", "0", ...]` in the config: these tmux session names normalise to `default`. Only a name that is neither configured nor listed is rejected." Add a rollout step: list every host's `tmux ls` before the config is first written.

**B5. "With a duplicate `instanceId`, the old socket is closed first" breaks Claude.** Claude spawns several plugin processes per session with the same instance id, and they must merge (plugin.ts:148-152, sessions.ts:36-45). Closing the old socket on each register makes the siblings kick each other in a reconnect loop.
- The same dedup is global, not per host, so equal PIDs on two hosts merge a `cfd` socket into a `default` session's `extraSends` (sessions.ts:42). That is a direct cross-swarm leak.
- **Fix (§2):** "Sockets merge only when host, instance id and swarm all match. Same host and instance id with a different swarm: deregister the old slot and close all its sockets. A different host is never the same instance."

## Majors

**M1. Swarm agents lose permission prompts and plain `reply`.** `permissionRequest` has no channel; it uses `deps.chatId()` and returns silently when there is none (ws.ts:1318-1319). With the `activeChatId` fallback limited to `default`, a `cfd` Claude waits forever for a verdict. The Mac seats run without `--dangerously-skip-permissions` (start-agents.sh:44). **Fix (§4):** "For a non-default swarm, the fallback chat for `permissionRequest` and a `reply` with no `chatId` is that swarm's `human` channel."

**M2. Removing a swarm from the config turns its channels into `default` channels.** `channelSwarm` step 1 only knows configured swarms, so `cfd:general` then resolves as a `default` channel named `general`. **Fix (§3):** "A category recorded in `SwarmStore` for a swarm that is no longer configured is retired: its channels belong to no swarm and every op on them is rejected."

**M3. The persisted id→swarm map contradicts "moved by hand is adopted".** A channel dragged out of `cfd` to no category misses step 1 and hits the stale map, so it stays `cfd` forever. **Fix:** cut the map. `<id> (archived)` is already in `SwarmStore`, so make it a step-1 category.

**M4. Adoption by category name can swallow `default`.** If `DISCORD_BUS_CHANNEL` already sits in a category named `bus` or `cfd`, configuring that swarm makes #general a swarm channel. **Fix (§3):** "Refuse to adopt a category that contains `BUS_CHANNEL`, `HUMAN_CHANNEL`, a `DISCORD_CHANNEL_OWNERS` channel or a #26 `Agents` channel. The swarm stays `swarm_not_ready` and the error is logged. Match the category name case-insensitively."

**M5. A #26 direct channel does not follow its agent.** `AgentChannels.register` finds the existing binding and only refreshes state (agent-channels.ts:91-97 #26), and `update` keeps the current parent (`agentCategoryId(..., currentParent)`). An agent that changes swarm keeps a channel in the old category, and `assertChannelInSwarm` then rejects the owner's own reply. **Fix (§3):** "On register, a bound channel whose `channelSwarm` differs from the session's swarm is moved to the session's category." B2's fixes make this rare.

**M6. Threads resolve to `default`.** A thread's `parentId` is its channel, not a category, and the code has no thread handling. A `default` agent can `fetch_messages` a thread under `cfd:general`. **Fix (§3):** "`channelSwarm` of a thread is the swarm of its parent channel."

**M7. Topic-channel audiences are not scoped.** §4 scopes `everyone` only. Subscriptions are name-keyed and are pruned only when the channel moves, not when the subscriber changes swarm. **Fix (§4):** "Every subscriber fan-out is intersected with `liveMembers(channelSwarm)` plus cross-swarm sessions. A session's subscriptions outside its swarm are dropped when it registers."

**M8. Admin `session=` crosses swarms.** An admin may act for another session (ws.ts:1824-1829). The spec does not say whose swarm `assertChannelInSwarm` checks. **Fix:** "The check uses the acted-for session's swarm. An admin may act for a session in another swarm only if it is cross-swarm."

**M9. `default` has no master in PR4.** `default` is a reserved ID, so it cannot have `candidates`, yet A10 v2 was written for exactly that swarm (v2:39 names `claude@mac:swarm-master`). The same alias is in `crossSwarm`, and a candidate must register `role:'master'` in its own swarm. **Fix (§1/§6):** "The config may contain a `default` key for candidates only; it creates no category. `DISCORD_DISPATCHER` is ignored for a swarm that has candidates. An alias may be both cross-swarm and a `default` candidate."

## Minors

- **"Can't be taken by `register`" is false.** `protectedRenameAlias` is only called on rename (ws.ts:885). A first-come register of a protected alias succeeds, and the legitimate holder registers the same way. Say so, or drop the claim.
- **`crossSwarm` shares a namespace with swarm IDs.** Use `{swarms: {...}, crossSwarm: [...], defaultSessions: [...]}`.
- **`candidates[0]` versus `priority`.** PR1 should pick the lowest priority that is live, as PR4 will.
- **`auth.json` symlink.** If Codex refreshes tokens by write-and-rename, the link becomes a copy and the homes drift until one refresh token is revoked. Verify first, or set the home's `auth.json` aside and log in per home.
- **Mac daemon.** `codex app-server --listen unix://` (start-agents.sh:67-68 comment) may not be per `CODEX_HOME`. Add to the proof: the `cfd` Codex's plugin process has `SWARM_ID=cfd` in its env.
- **Archived swarm channels are still inbound.** "Any channel with a non-default `channelSwarm`" includes `<id> (archived)`. Exclude it.

## Cut

- The id→swarm map (M3).
- "Offline swarm = newest inbox row" and the `swarm` field on inbox rows, replaced by the `name → swarm` journal (B2). This also removes the rollback-reads-new-rows test.
- The reserved `swarm?` field on gateway and node frames. Add it when it is used.

## Test gaps

- Two pull-mode seats, same dir, two swarms: both stay registered (B1).
- Reboot order: `cfd` registers before `agents`; names and queued mail stay with their swarm (B2).
- Two plugin processes with one instance id stay merged; the same id from another host does not merge (B5).
- A session named `0` with config present registers in `default` (B4).
- Rendered Codex config: the name and wake pane are the swarm's own (B3).
- `permissionRequest` from a `cfd` agent reaches `cfd:human` and the verdict returns (M1).
- Config removes a swarm: its channels are not resolvable from `default` (M2).
- A thread under a swarm channel (M6).
- A subscriber that changed swarm gets no topic fan-out (M7).

## Checked and fine

- `<swarm>/<dir>` names pass `isBusAlias` and `generatedName`'s character filter (plugin.ts:303).
- `handleBusInbound` checks `allowFrom` first (router.ts:364-369), so new swarm channels do not widen who can address agents.
- `routeCoordinator`, the sticky term, restart hold, `stale_term` and candidacy only for `role:'master'` match A10 v2.
- `pickCoordinator` swaps cleanly into `oneHumanTarget` (ws.ts:1703-1709), and the interactive fallback matches ws.ts:1809-1817.
- #26's `canAccessDirectChannel` owner check composes with `assertChannelInSwarm`.
- #27's `-N` leases need no key change under global names.
- `=$S` exact targets, the `while`/`shift` parser and the foreign-window refusal fix the script faults from R1.
- The old router ignores `register.swarm`, so the plugin can ship first.
