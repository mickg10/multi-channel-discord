# R3 critique of spec v3 (Fable)

Code refs are main 07e77bd unless marked #26/#27. Nothing here reopens Mick's decisions or resolved points.

## Blockers

**B1. The plugin cannot normalise a swarm, but v3 makes it do so in four places.** `defaultSessions` and "is there a config at all" live only in the router. The plugin still has to pick the name form (§0, §5 Name), compare the wake pane's session (§5 Wake), detect a change (§5 Re-check) and key `assignedAlias` (§5 Name).
- With no config, a seat in a hand-made session `work` registers as `claude@mac:work/src`, not `claude@mac:src` (plugin.ts:302). That breaks "byte-for-byte today's" in rollout step 1.
- With config, a seat in session `0` gets `claude@mac:0/src` while its swarm is `default`.
- **Fix (§2, §5):** "The plugin never normalises. `register` carries `swarm` (raw) and `swarmName?` (the `<agent>@<host>:<swarm>/<dir>` form, only when the name is generated). The router uses `swarmName` when the normalised swarm isn't `default`, otherwise `name`. `registered` returns the normalised `swarm`; the plugin uses that value for the wake-pane check, the `assignedAlias` key and the re-check (re-register when the raw session changes; the router decides whether anything changed). In `default` the `assignedAlias` key stays the bare `instanceId`."

**B2. `channelSwarm` fails open to `default`, and the register-time prune then deletes subscriptions.** "Anything else gives `default`" includes a channel that isn't in the cache. Plugins reconnect within 1 s of a router restart (reconnect.ts:6), before `clientReady`; `guildChannels` only fetches when the cache is empty (router.ts:203-207).
- At that moment every `cfd` channel reads as `default`, so "at register, subscriptions outside its swarm are dropped" wipes all non-default subscriptions on every router restart.
- The same hole lets a `default` session act on any channel id the cache doesn't know.
- Deleting the `cfd` category in Discord leaves its channels with `parentId` null, so `cfd:general` becomes a `default` channel.
- **Fix (§3):** "`channelSwarm` returns `unknown` until the first full fetch after `clientReady` completes, and for any id not in the cache after one fetch. `unknown` rejects ops with `swarm_not_ready` and never drops a subscription. The register-time prune and the sweep run only after that fetch. A channel that is uncategorised but was last seen in a swarm category is treated as `retired` until the router restarts or Mick moves it."

**B3. A swarm change makes sibling plugin processes evict each other.** Claude runs several plugin processes with one instance id (plugin.ts:128-132, sessions.ts:39-45). Each has its own 10 s timer (plugin.ts:1018).
- Process A sees the move and re-registers in `cfd`; the router closes "all its sockets", including B's. B reconnects after 1 s still believing the old swarm, so the router closes A. This repeats until B's timer fires.
- It never ends when the two disagree for good: "several ungrouped sessions: keep the previous swarm; cold start: `default`" is per-process state, and a sibling started later has a different "previous".
- **Fix (§2, §5):** "The plugin recomputes its session inside `connect()` before every register. A window linked into several ungrouped sessions resolves to the session with the lowest `#{session_id}` (deterministic, no memory). On same host and instance with a different swarm, the router moves the slot, sends the other sockets `swarm_changed`, and they re-register without closing."

## Major

**M1. A name can never change swarm, which contradicts three other lines.** "Journalled swarm differs → `-N`" has no exception and the journal has no expiry.
- A pinned or `bus_rename`d seat that is moved gets `foo-2`; #27 then saves that as the explicit alias (`explicitAlias.save(registeredName)`, plugin.ts:482-484), so moving back gives `foo-2-2`.
- "A bound channel in another swarm is moved" (§3) and the tests "direct channel follows its agent's swarm" and "`move-window` … resets the name" are unreachable under this rule.
- **Fix (§2):** "The journal stores `{swarm, holder: host:instanceId}`. The same holder registering the name in another swarm is a **move**: rewrite the entry, drop its subscriptions and claims, and return its queued legacy rows to `<old swarm>:general` as undelivered. Any other holder gets `-N`, and that `-N` is never written to `bus-aliases`. An entry is deleted when the name is offline and has no inbox rows, subscriptions or claims."

**M2. Re-keying leases by `${host}:${instanceId}` undoes #27 on deploy day.** Existing `name-leases.json` rows hold bare ids. After the PR1 restart, every seat's own lease looks like another instance's (`heldByAnother`, name-leases.ts #27), so a seat asking for its saved `X-2` gets `X-2-2`.
- `Subscriptions.reclaim` is also keyed by bare instance id (subscriptions.ts:90-93). Two hosts with the same Claude PID move each other's subscriptions; the new prune then deletes them.
- **Fix (§2):** "Leases gain an optional `host` field; a row without it matches any host. `instanceId` stays as written, so a rolled-back router still reads the file. `subs.reclaim` is keyed by host and instance, and runs before the swarm prune."

**M3. A swarm added by hot reload is never provisioned.** §3 runs provisioning "after `clientReady`" only. Rollout step 2 writes the config while the router is up, so `cfd` stays `swarm_not_ready` until a restart.
- **Fix (§3):** "Provisioning also runs on any reload that adds a swarm, and retries with backoff after a failure."

**M4. `defaultSessions` as an exact list breaks every ad-hoc tmux session.** tmux names new sessions `1`, `2`, … so the next `tmux new` is `unknown_swarm`. The plugin then retries silently and the agent's tools give no reason.
- **Fix (§1, §5):** "All-numeric session names always normalise to `default`, and all-numeric swarm IDs are reserved. On `unknown_swarm` the plugin sets `registrationError` (as plugin.ts:514-516 does), so every tool call says which session name was refused and how to list it."

**M5. Permission prompts move to a guild channel with no check on who clicks.** The button handler takes any click (router.ts:521-527; `handlePermissionButton`, ws.ts:1373). In a DM that was only Mick; in `<swarm>:human` it is anyone who can see the channel.
- `handlePermissionRequest` also returns silently with no chat (ws.ts:1318), so a `cfd` seat hangs while the swarm is `swarm_not_ready` or adoption was refused.
- **Fix (§4):** "A permission button is honoured only for `interaction.user.id` in `allowFrom`. With no resolvable chat, the router sends a `deny` verdict with the reason at once."

**M6. Cross-swarm and candidate rights hang on an exact name that #27 can take away.** The example `crossSwarm` aliases are `/name`-derived Claude names, not pinned. After a Claude restart the PID changes, the old instance holds the lease for 10 minutes, and the seat comes back as `…-2` with no cross-swarm rights and no error.
- **Fix (§1, §2):** "Rights attach to the exact alias; `-N` forms have none. A register that asks for a protected alias and would receive `-N` is rejected with `protected_alias`. Protected aliases must be pinned with `DISCORD_SESSION_NAME` (takeover is exact); the rollout proof checks it."

**M7. §4 contradicts §3 for cross-swarm subscribers.** The sweep keeps them; "at register, subscriptions outside its swarm are dropped" does not.
- **Fix:** add "except for cross-swarm sessions" to the register rule.

**M8. Election details that differ from A10 v2 or the code.**
- A10 v2 says an unlisted session "is registered as a normal agent and gets `not_master_candidate`". v3 says a candidate alias outside its swarm and a pull-mode `role:'master'` are "rejected", without saying whether the register fails. **Fix:** "A wrong-swarm candidate alias fails the register (`protected_alias`). An unlisted or pull-mode `role:'master'` registers as a normal agent with `not_master_candidate`."
- A10 liveness is "the candidate's own connection", but a Claude master is one slot with several sockets. **Fix:** "The master is lost when no socket of its slot has a verified pong in 30 s."
- "Any session whose eligibility … changes is closed" makes a priority edit a failover with a term bump. **Fix:** "Reload closes a session only when its swarm changes or its alias leaves `candidates`/`crossSwarm`."
- **Config validation:** an alias in two `candidates` lists, or an id in both `swarms` and `retired`, is malformed.

**M9. Copying `auth.json` can log out the live `~/.codex`.** If Codex rotates refresh tokens, the swarm copy refreshing first invalidates the original that the `agents` Codex and Mick use. I have not verified Codex's rotation behaviour.
- **Fix (§7):** "Each `~/.codex-$S…` home gets its own device login from the start; `auth.json` is never copied."

## Minor
- **start-agents.sh:24** guesses every Linux host is `nas642`, so a bare run on nas64 starts the wrong windows. Guess from `hostname -s` and fail on an unknown host.
- **`~/.codex-$S`** is per swarm, yet the spec says one home per window. Use `~/.codex-$S-$w`, and `DISCORD_WAKE_PANE="=$S:=$w"`: a bare `codex` window target prefix-matches `codex-photos`.
- **`channel_create`** must refuse `general` and `human` in a swarm, since both are found by name. With duplicates, the oldest id wins.
- **`swarmMembers` offline names** should be `allNames(deps)` filtered by the journal, not every journal entry; otherwise `@all` queues mail for dead names.
- **§1 "owners apply to `default` only while `default` has no candidates"** reads as switching off `DISCORD_CHANNEL_OWNERS`. Say that owned channels bypass the coordinator like direct channels.
- **Adoption** of an existing category should also be refused when any channel in it has a subscriber outside the swarm.
- **State that a name is never parsed for its swarm.** `/name cfd/x` in `default` gives `claude@mac:cfd/x`.

## Cut
- **PR1's interim coordinator** ("live candidate with the lowest priority"). It is a second, non-sticky election that PR4 replaces. In PR1, send untagged posts in a non-default swarm to interactive members.
- **Resolving `DISCORD_WAKE_PANE` only to warn** when an own pane exists. Ignore it.
- **The per-swarm cap of 100 direct channels.** Keep #26's single cap.

## Test gaps
- A register before `clientReady` keeps `cfd` subscriptions; an op on an uncached id is refused.
- With no config, a seat in session `work` keeps today's name; session `7` is `default`.
- Two sibling processes across a `move-window` end in one slot with no reconnect loop.
- An explicit alias moved `agents` → `cfd` → `agents` keeps its name.
- A PR1 restart over a pre-existing `name-leases.json`: every `-N` seat keeps its name.
- The same PID on two hosts does not move subscriptions.
- A swarm added by reload is provisioned without a restart.
- A permission button clicked by a user outside `allowFrom` is ignored.
- A restarted unpinned cross-swarm seat is rejected, not given `-2`.
- `has-session -t cfd` with only `cfd-injection` present creates a new session.

## Checked and fine
- `claude@mac:cfd/src` passes `isBusAlias`, `qualifiedAliasHost` and `aliasAllowedOnHost` (ws.ts:425-434), and the human `@name` token regex (ws.ts:1789).
- #26 slugs for `…:cfd/src` and `…:cfd-src` collide, but `ensure` falls back to the hashed slug.
- An old plugin against the new router: no `swarm` field means `default`, and `register rejected:` is already handled (plugin.ts:190).
- A rolled-back router ignores `agent-swarms.json` and `swarms-config.json`.
- Inbound allowlist gating in `handleBusInbound` (router.ts:367) covers swarm channels.
- Reserved IDs cover #26's `Agents` categories and the `archive` category (router.ts:243).
- Different-host instances never merging matches PID-based ids.
