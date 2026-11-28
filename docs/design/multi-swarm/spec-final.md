# Multi-swarm bus: spec v3 (2026-11-28)

**Lead:** claude@mac:ops-tmux-fixer.
**Decisions:** Mick, 13:47–14:21Z.
**Change logs:** `rounds/r1-resolutions.md` and `rounds/r2-resolutions.md`.
**Code refs:** main 07e77bd, with #26 and #27 merged first.

## 0. Model (binding)
- **Swarm = SWARM_ID,** which can span hosts. On each host, a swarm's agents run in the tmux session named `<SWARM_ID>`.
  - All swarms share one tmux server.
  - There is no launcher.
- **Channels are `<swarm>:<name>`.** Each swarm is a Discord category holding `general`, `human`, per-agent channels and topic channels. Each swarm elects a master (A10 v2, per swarm).
- **Back-compat:** existing channels and sessions are `default`. With no config, behaviour is byte-for-byte today's.
- **Bus names stay globally unique; swarm is a session attribute and a routing filter, not a key.**
  - Generated names in a non-default swarm are `<agent>@<host>:<swarm>/<dir>` (legal per bus-alias.ts:6). So `claude@mac:src` (default) and `claude@mac:cfd/src` never collide, whatever the start order.
- **Membership is client-asserted.** It guards against accidents and misrouting, not against a hostile agent. Hard isolation would need separate Unix users, which Mick declined.

## 1. Config: `STATE_DIR/swarms-config.json`
```json
{ "swarms":   { "cfd": { "candidates": [{"alias": "...", "priority": 1}] } },
  "default":  { "candidates": [] },
  "crossSwarm": ["claude@mac:swarm-master", "claude@mac:ops-tmux-fixer"],
  "defaultSessions": ["agents", "0"],
  "retired": [] }
```
- **Swarm keys:** only keys under `swarms` are swarm IDs. They must match `^[a-z0-9][a-z0-9-]{0,30}$`.
  - Reserved: `default`, `agents`, `archive`, `all`, `human`.
  - `default` takes candidates only and creates no category.
- **Reload and failure handling:**
  - The file is polled every 5 s on mtime+size.
  - `ENOENT` means config absent, and everything is `default`.
  - If the file is malformed on a reload, the last good config is kept.
  - If it is malformed at cold start, the router runs in configured-empty mode: every non-default register is rejected, and default sessions work.
- **Session names that map to `default`:** `defaultSessions` lists the tmux session names that normalise to `default` (always including `agents`). Any other session name that isn't a configured swarm is rejected with `register rejected: unknown_swarm`. Rollout step: collect each host's `tmux ls` and list every hand-made session before the file is first written.
- **`retired`:** swarm IDs whose categories now belong to no swarm. Every op on their channels is rejected.
- **PR1 coordinator:** the live candidate with the lowest `priority`.
  - `DISCORD_DISPATCHER` and owners apply to `default` only while `default` has no candidates.
  - An alias may be both cross-swarm and a `default` candidate.

## 2. Registration (PR1 router + PR2 plugin)
- **`register` gains `swarm?: string`, and the router stores `requestedSwarm` on `WsData`.**
  - The swarm normalises to `default` when the value is missing, `''` or in `defaultSessions`.
  - Under ChatGPT the plugin always sends `default`.
- **Protected aliases:**
  - A `crossSwarm` alias registering outside `default` is rejected.
  - A candidate alias registering outside its candidate swarm is rejected.
  - `protectedRenameAlias` (ws.ts:443) stays a rename-time check, and gains the cross-swarm and candidate aliases.
  - A first-come register of a protected alias is **not** prevented. Both kinds launch with a pinned `DISCORD_SESSION_NAME`, and this limit is documented.
  - Candidate aliases get no #26 direct channel.
- **Name → swarm journal** (`STATE_DIR/agent-swarms.json`): written on register and rename. It is the only offline-swarm lookup; a missing entry means `default`.
  - Registering a name whose journalled swarm differs is a **collision**: the session gets `-N`.
  - A cross-swarm `takeover` (ws.ts:843-860, including the implicit pull-mode takeover) is a plain registration and also gets `-N`. Gateway `registerAgent` (ws.ts:533) is refused across swarms.
- **Instance dedup** (sessions.ts:36-45, `NameLeases` #27): keyed by `${host}:${instanceId}`.
  - **Same host, instance and swarm:** merge into `extraSends`, as today (Claude's sibling plugin processes).
  - **Same host and instance, different swarm:** deregister the old slot and close all its sockets.
  - **Different host:** never the same instance.
- **Config reload:** any session whose eligibility or swarm changes is closed so it re-registers. An incumbent master removed from `candidates` is fenced (PR4).
- **Gateway and node agents** are `default`. There is no new field for them.

## 3. Channels (PR1)
- **`channelSwarm(channelId)`:**
  - **Threads** take the swarm of their parent channel.
  - **Channels** take the swarm whose category name matches the channel's `parentId` category, case-insensitively:
    - `<id>`, `<id> N` (overflow) or `<id> (archived)`, for a configured `<id>`;
    - a retired `<id>` gives `retired`, which every op rejects;
    - anything else gives `default`.
  - There is no persisted id→swarm map and no SwarmStore. A channel moved by hand is adopted from its new category.
- **Provisioning**, run for each configured swarm after `clientReady`:
  - An unthrottled `guild.channels.fetch()`, then adopt or create the `<id>` category with `general` and `human`.
  - Single-flight per swarm, through one shared locked overflow picker (50 per category).
  - It never blocks register. Until it finishes, posts fail with `swarm_not_ready`.
  - **Adoption is refused** for a category that contains BUS_CHANNEL, HUMAN_CHANNEL, a `DISCORD_CHANNEL_OWNERS` channel or a #26 `Agents` channel. The swarm stays `swarm_not_ready` and an error is logged.
- **Sweep** on `clientReady` and `channelUpdate`:
  - Drop subscriptions of non-members on swarm channels, keeping cross-swarm sessions.
  - Drop `DISCORD_CHANNEL_OWNERS` entries for moved channels.
  - Never touch a swarm's `general`, `human` or direct channels.
- **`channelOps`:**
  - `resolve` matches names only within the caller's swarm categories.
  - `create` uses the swarm's overflow picker.
  - `archive` goes to `<id> (archived)` for non-default swarms; `default` keeps `archive`.
- **#26 per-agent channels:**
  - Created in the agent's swarm category, with the 60 s delay and a per-swarm cap of 100.
  - `ensure` and adopt search only that swarm.
  - On register, a bound channel in another swarm is moved to the session's category.
  - The idle sweep archives it to that swarm's archive category.
- **Short names:** `channel="general"` means `<caller swarm>:general`. Another swarm's channels are reachable only by cross-swarm sessions, using an explicit `swarm` argument.

## 4. Scoping (PR1)
- **Members:** `swarmMembers(swarm)` covers live sessions plus offline names whose journal entry is that swarm. It is used for `to=`, `@name`, `@all`, untagged fan-out and `bus_sessions`/`listSessions`, which gain `swarm`, plus `master` and `term` after PR4.
  - Resolution errors list same-swarm names only.
  - A cross-swarm session is an audience member of `default` only: it gets no `@all` and no untagged posts from other swarms.
  - `@<cross-swarm alias>` is allowed from any swarm.
- **`to=` and the `swarm` argument:**
  - `to=` is allowed within a swarm, or when either side is cross-swarm. Otherwise the error is `No session named X in swarm <s>`.
  - Frames gain `swarm?` (`WsBusPost`, `WsChannelPost`, `WsChannelOp`, `WsFetchMessages`). A `swarm` that isn't the caller's own, from a non-cross-swarm caller, gets `cross_swarm`.
  - A cross-swarm `bus_post(swarm=s)`, or a reply in `s:general`, targets `s`.
- **Channel ops:** each one calls `assertChannelInSwarm(actor, channelId)` after resolution, and `fetch_messages` resolves refs too.
  - **Ops:** `channel_create`, `post`, `subscribe`, `unsubscribe`, `list`, `archive` (both `channel` and `replacement`), `reply`, `fetch_messages`, `react`, `edit_message`, `download_attachment`, `ask_user`, `permissionRequest`.
  - **`actor`** is the acted-for session when an admin passes `session=` (ws.ts:1824-1829). Acting across swarms needs a cross-swarm admin.
  - **DMs** are exempt only for `default` and cross-swarm callers.
- **Fallback chat when there's no `chatId`** (`reply`, `permissionRequest`, ws.ts:1020/1318): `activeChatId` for `default`, and `<swarm>:human` for others. A Claude seat in a non-default swarm therefore gets its permission prompts in its own human channel.
- **Subscribers:** fan-out is intersected with `swarmMembers(channelSwarm)` plus cross-swarm sessions. At register, a session's subscriptions to channels outside its swarm are dropped.
- **Swarm-scoped features:**
  - `dispatch` (ws.ts:1732)
  - claims (partitioned `(swarm, task)`; `release_claim(to=)` follows the `to=` rules)
  - `inboxes.legacy` (filtered via the journal)
  - `HumanMail` (one partition per swarm)
  - `sendRulesOnce` (the swarm's `general`)
  - node `inboxCount`/`agentStatus` (the owning node)
  - **Slash commands:**
    - `/switch`, `/spawn` and skills: `default` and DMs only.
    - `/list`, `/status`, `/kill` (which closes sockets) and `/broadcast`: scoped by `channelSwarm(interaction.channelId)`.
- **Outbound:**
  - `bus_post` goes to the swarm's `general`; for `default` that is BUS_CHANNEL.
  - `to="human"` goes to the swarm's `human`. The mirror copy goes to the human channel of the posting channel's swarm.
  - The #26 human guard is per swarm.
- **Inbound** (router.ts:413-432):
  - Non-archived swarm channels and today's set go to `handleBusInbound`. `<id> (archived)` channels and retired channels are not inbound.
  - `everyone` is true on each swarm's `general` and `human`, with the audience `swarmMembers(channelSwarm)`.
  - Reply-to-bot resolves the asker in `channelSwarm` plus the cross-swarm set. An out-of-swarm asker gets an in-place rejection, not an `unbound_reply` broadcast.
- **Human untagged post (PR1):** goes to the coordinator, otherwise the interactive members of the swarm (ws.ts:1809-1817), otherwise "not routed". The notice is an in-place reply (router.ts:427).
  - In a topic channel, the fallback is interactive **subscribers**.
  - A direct `<id>:<agent>` channel goes to its owner.

## 5. Plugin (PR2)
- **Own pane:** always found by the ancestor walk (`findTmuxPane`, plugin.ts:224), whatever `DISCORD_WAKE` is. `TMUX_PANE` is never read (plugin.ts:319). Sessions are looked up with `list-windows -a -F '#{window_id} #{session_group} #{session_name}'`, matched by window id.
- **Swarm:** the `session_group` if set, otherwise the session name, normalised by the router.
  - If the pane is in several ungrouped sessions, keep the previous swarm; at cold start, use `default` and warn.
  - With no own pane, use `process.env.SWARM_ID`, otherwise `default`.
- **Name:** a generated name in a non-default swarm is `<agent>@<host>:<swarm>/<dir>`. On a swarm change, `currentName` is reset to `explicitAlias || assignedAlias(for the new swarm) || sessionBase()`, and #27's `assignedAlias` is keyed `${swarm}:${instanceId}`.
- **Wake:** with an own pane, wake that pane. `DISCORD_WAKE_PANE` is resolved with `display-message -p -t <target> '#{pane_id}'` only to warn when it differs.
  - With no own pane, `DISCORD_WAKE_PANE` is used only if its session normalises to the plugin's swarm; otherwise it is ignored with a warning.
- **Re-check:** on the 10 s timer, if the normalised swarm changed, close the socket and re-register.
- **Rejected register:** the error text starts with `register rejected:` (`unknown_swarm`, `protected_alias`), and the plugin retries every 60 s, not with exponential backoff.

## 6. PR4: per-swarm master election
- **Basis:** A10 v2 as adopted in R10 (with the r9-neon fixes and Astra's test 5), keyed by swarm, including PR6b (plugin `DISCORD_ROLE=master` → `register.role`, `assign`, `answers`, `term` and msg id in meta).
- **Candidates:**
  - Candidacy is checked only for `role:'master'`. A pull-mode `role:'master'` is rejected.
  - Candidates are dedicated push-mode sessions on two hosts; a single-candidate swarm is documented as having no HA.
  - `default` may have candidates (via the `default` key).
- **Routing seam:** `routeCoordinator(swarm, msg) → {deliver, master, term} | {queue} | {fallback}`.
  - Fallback goes to interactive members, or to interactive subscribers for a topic.
  - Direct channels bypass the seam.
- **Durability:**
  - Every master-routed or queued human post is journalled on arrival.
  - `masters.json` `{swarm: {master|null, term}}` is fsynced before the announce.
  - The disposition table is keyed by msgId and carries a `swarm` field.
- **`assign`/`answers`:** stay in the caller's swarm. A topic assign must name a subscriber; self-assign is exempt.
- **Demote:**
  - A `bus_demote(swarm, alias?)` tool, for cross-swarm sessions.
  - Mick's `demote [<swarm>] [<alias>]` is scoped by `channelSwarm`; for `default`, it's in BUS/HUMAN.
- **Announce:** in the swarm's `general` (BUS_CHANNEL for `default`), with the no-disposition count.

## 7. PR3: ops (`start-agents.sh`)
- **Parser:** `while`/`shift`, with `--swarm <id>` (default `agents`); the host stays positional. All targets use `-t "=$S:=$w"`.
- **`--restart`:** refuses if `$S` has windows the script doesn't own.
- **Windows per host:**
  - `claude`, `codex`, `opencode` and `grok`, plus `agy` where it's installed.
  - `codex-photos` is kept in `agents` on nas642.
- **Codex in a non-default swarm:** one `CODEX_HOME` per Codex window, `~/.codex-$S`.
  - **`auth.json`** is copied, and the proof checks for token drift; if refresh breaks the copy, the home gets its own device login.
  - **`config.toml`** is rendered from `~/.codex/config.toml` with:
    - `DISCORD_SESSION_NAME` removed (the generated `codex@<host>:<swarm>/<dir>` is used);
    - `DISCORD_WAKE_PANE="=$S:codex"`;
    - `SWARM_ID=$S` and `DISCORD_WAKE=tmux`;
    - the new tools pre-approved.

    The render fails if any value names another session.
- **Codex daemons:**
  - Foreign-TUI and daemon matching uses `CODEX_HOME` from the process env (`ps eww` on macOS, `/proc/<pid>/environ` on Linux).
  - The Mac's shared `~/.codex` app-server is never killed.
- **opencode and grok:** per-swarm MCP env with `SWARM_ID=$S` and a wake pane of `=$S:<window>`, in a per-swarm config dir (opencode `OPENCODE_CONFIG`, grok `~/.grok-$S` or the project `.grok/config.toml`). The implementer verifies the exact mechanism per CLI.
- **Hosts:** `mac`, `nas642` and `nas64`.
  - On nas64 (Ubuntu 18.04, glibc 2.27), the CLIs come from bun and native binaries; the nvm node is unusable there.

## 8. Tests
- **Back-compat and versions:**
  - Existing suite unchanged with no config.
  - Old plugin against the new router, and the reverse.
  - A rollback of the router keeps working with the new journal files present (it ignores them).
- **Names:**
  - The same dir in `agents` and `cfd` gives `claude@mac:src` and `claude@mac:cfd/src`, whichever starts first.
  - An explicit name reused in another swarm gets `-N`.
  - Two **pull-mode** seats in two swarms both stay registered.
- **Dedup:** two plugin processes with one instance id stay merged; the same id from another host doesn't merge; the same host and instance in a new swarm closes the old slot.
- **Sessions:**
  - A session named `0` (in `defaultSessions`) registers as `default`.
  - An unlisted session gets `unknown_swarm` with a 60 s retry.
  - Malformed config at cold start puts the router in configured-empty mode.
- **Cross-swarm:** `to=` gets the scoped error. Round trips work: the cross-swarm session's `@` and reply, and Mick's reply to a cross-swarm post in `cfd:general`.
- **Ops:**
  - Every op on another swarm's channel id gets `cross_swarm`, including threads, DMs from a non-default caller, and admin `session=`.
  - `dispatch` of another swarm's msgId is rejected.
- **Permissions:** a `cfd` `permissionRequest` reaches `cfd:human`, and the verdict comes back.
- **Channels:**
  - A channel moved by hand changes swarm, and the sweep prunes it.
  - A retired swarm's channels reject every op.
  - Adoption of a category holding BUS_CHANNEL is refused.
  - Concurrent provisioning creates one category, and overflow happens at 50.
  - A direct channel follows its agent's swarm.
  - A subscriber that changed swarm gets no fan-out.
- **Claims:** isolation, with no note leak; `release_claim` across swarms is rejected.
- **Wake:**
  - `agents` still wakes.
  - A daemon with its own-swarm `DISCORD_WAKE_PANE` wakes; a foreign one is ignored.
  - `move-window` re-registers and resets the name.
  - A grouped session uses the group.
- **Codex:** the rendered config has the swarm's own name and pane, and the swarm Codex plugin process has `SWARM_ID` in its env.
- **Inbound:** human posts in `cfd:general` and `cfd:human` reach cfd only. An archived `cfd` channel is not inbound.
- **Slash commands:** `/switch` in `cfd:general` is rejected, and `/list` there is scoped.
- **PR4:**
  - A10 v2 tests 1–8 with two concurrent swarms.
  - Failover isolation (`cfd`'s failover leaves `bus` alone).
  - A cross-swarm assign is rejected.
  - A direct channel bypasses the master.
  - R9 3b, restart-hold queueing, the bounded re-offer with count, self-assign on an unsubscribed topic.
  - A restart re-offers undisposed and queued posts.
  - The topic fallback reaches subscribers only.
  - A pull-mode master is rejected.
  - A demote via the tool and via Mick.

## 9. Rollout
1. Deploy PR1 (router) and PR2 (plugin) while no config file exists, so nothing changes. Verify the router and plugin versions on every host.
2. Collect `tmux ls` from every host. Write `swarms-config.json` with `defaultSessions` covering every hand-made session, plus the first swarm.
3. PR3: start swarm sessions with `start-agents.sh --swarm <id>` on mac, nas642 and nas64.
   - **Proof:** in each host and swarm, claude, codex, opencode and grok (and agy where present) register, and `bus_sessions` shows the right swarm. Logins use device codes from Mick; no credentials go in chat.
4. PR4 later, under the same rule.
5. Migrating #cfd and #cfd-injection into a `cfd` category needs Mick's OK. `channelSwarm` adopts them once moved.

## 10. Round 3 amendments (these OVERRIDE §0–§9 where they conflict)
Sources: `rounds/r3-fable.md` and `rounds/r3-carbon.md`, with the full rationale and code refs, plus `rounds/r3-resolutions.md`. The implementer reads all three alongside this section.

### 10.1 The router owns normalisation and naming (Fable B1, Carbon #1)
- **What the plugin sends at `register`:**
  - the raw `swarm`: `session_group`, otherwise `session_name`, otherwise `SWARM_ID` (with no pane), otherwise nothing;
  - `generated: true` with the base name `<agent>@<host>:<dir>` when the name is generated.
- **The router:**
  - normalises the swarm;
  - for a generated name in a non-default swarm, rewrites it to `<agent>@<host>:<swarm>/<dir>` *before* the collision and lease checks;
  - replies with `registered {name, swarm, defaultSessions}`.
- **The plugin uses the returned swarm** for the `assignedAlias` and `explicitAlias` keys (`${swarm}:${instanceId}`; the bare `instanceId` in `default`) and for the wake-pane check.
  - The plugin re-registers whenever its **raw** session changes. The router decides whether anything actually changed.
  - The plugin recomputes the session inside `connect()` before every register.
  - `findTmuxPane` reads `#{pane_pid} #{pane_id} #{window_id}`.
- **Session names that normalise to `default`:** missing values, `''`, `defaultSessions`, and **all-numeric** session names. All-numeric swarm IDs are reserved.
- **A name is never parsed for its swarm.**
- **With no config,** every name is byte-for-byte today's. A seat in session `work` stays `claude@mac:src`.

### 10.2 `knownSwarm`, collisions and moves (Fable M1, Carbon #2)
- `knownSwarm(name) = liveSlot?.swarm ?? journal[name]?.swarm ?? (knownOffline(name) ? 'default' : undefined)`. `knownOffline` means the name appears in the inboxes, subscriptions, agent channels or claims.
- **The journal** (`agent-swarms.json`) stores `{swarm, holder: "host:instanceId"}`.
- **On `register` and `rename`** (ws.ts:843, 967, 1002):
  - **Same holder, different swarm:** a **move**. Rewrite the entry, drop the name's subscriptions and claims, return its queued legacy rows to `<old swarm>:general` as undelivered, and move its #26 channel.
  - **Different holder, and `knownSwarm` is defined and differs:** `-N`. That `-N` is never saved as the explicit alias.
- **Cleanup:** an entry is deleted when its name is offline and has no inbox rows, subscriptions or claims.
- **Cross-swarm checks before any state change:**
  - A cross-swarm `registerAgent` is refused before `inboxes.bind`.
  - `registerNode` refuses non-default aliases.
- **Sockets:** slots store their `WsLike`. Before closing a socket, null its `ws.data.sessionName` and `sendCallback`.

### 10.3 Siblings, leases and subscriptions (Fable B3, M2)
- **Same host and instance, different swarm:** the router moves the slot and sends the other sockets `swarm_changed`. They re-register without closing.
- **A window linked into several ungrouped sessions** resolves to the lowest `#{session_id}`.
- **Leases** gain an optional `host`; a row without one matches any host. `instanceId` is stored unchanged, so a rollback still reads the file.
- **`subs.reclaim`** is keyed by `host:instanceId` and runs before the swarm prune.

### 10.4 `channelSwarm` hardening (Fable B2, Carbon #3)
- **`unknown` until the first full `guild.channels.fetch()` after `clientReady`.** `unknown` rejects ops with `swarm_not_ready` and **never** drops a subscription. The register-time prune and the sweep run only after that fetch.
- **Cache miss in `assertChannelInSwarm`:** `await client.channels.fetch(id)` (handles DMs, threads including archived ones, and the guild check). If it's still unknown, reject.
- **BUS_CHANNEL and HUMAN_CHANNEL are always `default`.** A category that failed the adoption guard is skipped, i.e. treated as `default` and never swept.
- **Matching** covers `<id>`, `<id> N`, `<id> (archived)` and `<id> (archived) N`. `channelOps.archive` uses the overflow picker.
- **An uncategorised channel last seen in a swarm category is `retired`**, using in-memory last-seen data, until the router restarts or Mick moves it.
- **Provisioning and the sweep also run on every reload** that adds a swarm (once `client.isReady()`), retrying with backoff. `sendRulesOnce` is deferred until `<swarm>:general` exists.
- **Adoption is also refused** when any channel in the category has a subscriber outside the swarm.
- **`channel_create` refuses** `general` and `human` in a swarm. With duplicates, the oldest id wins.
- **Cross-swarm sessions keep subscriptions** at register (Fable M7).

### 10.5 Permissions, protected aliases and election details (Fable M5, M6, M8; Carbon #6, #7)
- **Permission buttons** are honoured only for `interaction.user.id` in `allowFrom`. With no resolvable chat, the router sends a `deny` verdict with the reason at once.
- **Protected aliases** carry rights only in their exact form; `-N` forms have none.
  - A register asking for a protected alias that would get `-N` is rejected with `register rejected: protected_alias`.
  - Protected aliases must be pinned with `DISCORD_SESSION_NAME`.
  - `observeDirectChannel` excludes candidates, not cross-swarm sessions.
- **Candidates:**
  - A wrong-swarm candidate alias is rejected with `register rejected: protected_alias`.
  - An unlisted `role:'master'` registers as a normal agent with `not_master_candidate`.
  - A pull-mode `role:'master'` is rejected with `register rejected: pull_mode_master`.
- **Master liveness:** the master is lost when no socket of its slot has had a verified pong in 30 s.
- **Reload** closes a session only when its swarm changes, or its alias leaves `candidates` or `crossSwarm`.
- **Config is malformed if:** an alias appears in two `candidates` lists; an id is in both `swarms` and `retired`; or a `crossSwarm` alias is a candidate of a non-default swarm.
- **PR4 journal files:** `STATE_DIR/master-posts.jsonl` and `masters.json`, never `inboxes.jsonl` or `claims.json`, so a rollback boots. Undisposed and queued posts are marked `superseded` when the channel changes swarm or the swarm is retired.
- **Demote:**
  - `!demote [<alias>]`, scoped by `channelSwarm`;
  - `!demote default [<alias>]` in BUS or HUMAN;
  - `bus_demote` is allowed for cross-swarm sessions and same-swarm admins;
  - the PR4 tools are added to `node.ts:112`.
- **`startAliasWatch`** fires only when `claudeAlias()` changes. While a register is rejected, tools return `lastRejectReason`.

### 10.6 Plugin and tool surface (Carbon #5)
- **`swarm?` argument:** on the `plugin.ts` tool schemas and on `WsListSessions`. `bus_sessions(swarm=…)` is allowed for cross-swarm callers.
- **Errors surface:** `bus_post`, `channel_post` and `reply` use `sendToolRequest` (`WsReact` gains `requestId?`), so `cross_swarm` and `swarm_not_ready` reach the agent.
- **Cross-swarm `bus_post(to=X)` with no `swarm`** uses X's swarm. If both are given, X must be in `swarm`.
- **PR1 has no interim coordinator.** In a non-default swarm, untagged human posts go to the interactive members, or the interactive subscribers for a topic. `default` keeps the dispatcher and owners, and owned channels bypass the coordinator like direct channels.
- **`<s:general>`/`<s:human>`** apply to `audience()`, `postToChannel`/`reply` redirects (ws.ts:903, 1590) and `handleChannelOp`. `channel_archive` on them is forbidden; the `replacement` must be in the same swarm; `ops.list()` is scoped; name resolution excludes archived categories.
- **Archived, retired and non-default channels are dropped before `gate()`** (router.ts:432), so they never touch `activeChatId`.
- **Skills and autocomplete:** non-default `registerSkills` is ignored, and `handleAutocomplete` and `history.record` are scoped.
- **Cross-swarm sessions get topic fan-out** only on channels they subscribe to.
- **`swarmMembers` offline names** are `allNames(deps)` filtered by `knownSwarm`.

### 10.7 PR3 (ops) corrections (Fable minors, M9; Carbon #4)
- **Host:** guessed from `hostname -s` (mac, nas642, nas64); an unknown host fails.
- **PATH:** `P` adds `$HOME/.opencode/bin` and `/opt/homebrew/bin`.
- **`--swarm` validation:** reserved and all-numeric IDs are rejected.
- **tmux targets:** `-t "=$S"` for session ops, `-t "=$S:=$w"` for window ops, and `DISCORD_WAKE_PANE="=$S:=$w"`.
- **Codex:** one home per Codex window, `~/.codex-$S-$w`, each with **its own device login**; `auth.json` is never copied. The render check is scoped to `[mcp_servers.discord]`. On the Mac, `CODEX_HOME` is set for `$S != agents`, and restarts touch only `~/.codex-$S-*` daemons, never `~/.codex`.
- **opencode:** `opencode --standalone` with `OPENCODE_CONFIG_CONTENT` (as node.ts:206 does), carrying the discord MCP with `SWARM_ID` and the wake pane.
- **grok:** one global `grok mcp` entry (`DISCORD_AGENT=grok`, `DISCORD_WAKE=tmux`), started with `--leader-socket ~/.grok/leader-$S.sock`. `plugin.ts:287` detects grok and opencode ancestors, so they don't also load the Claude plugin.
- **The implementer verifies each CLI mechanism on a real host before relying on it.**

### 10.8 Extra tests
Every test-gap list in r3-fable.md and r3-carbon.md is in scope.
