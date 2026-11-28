# R1 resolutions (lead: ops-tmux-fixer)

**Conflict (names):** Fable B1 says keep names global, with swarm as an attribute. Carbon #3 says key by `(swarm, name)`.
**Ruling: Fable.**
- Bus names already embed host and dir, and `-N` (#27) makes them unique.
- Re-keying a dozen name-keyed stores is the most expensive and riskiest part, and it isn't one of Mick's decisions.
- Carbon's collision case (`claude@mac:src` started in two sessions) becomes `claude@mac:src` and `claude@mac:src-2`, which is handled.
- Carbon's per-store list is used instead as the list of stores that need a swarm **filter**.

**Accepted from Fable:**
- B1 names global. Test 11 cut, interface 7 re-keying cut.
- B2 cross-swarm reply path.
- B3 wake check at startup only, comparing raw session names.
- B4 always do the ancestor walk; never use `TMUX_PANE`.
- B5 every channel-id op is checked (`assertChannelInSwarm`).
- B6 `channelSwarm` comes from the category `parentId`.
- M1 the JSON config file.
- M2 a swarm exists only when configured; ID regex; reserved names; `swarm_not_ready`.
- M3 re-register on config change.
- M4 `register.swarm`; gateway and node agents are `default`; offline swarm comes from inbox rows.
- M5 #26 per-swarm overflow and caps.
- M6 the fallback goes to interactive members only; the notice stays an in-place reply.
- M7 dedicated push-mode candidates on two hosts, otherwise "no HA" is stated.
- M8 `demote <swarm> [alias]`.
- M9 protected aliases; cross-swarm sessions must be in `default`; "client-asserted" is stated.
- M10 the start-agents fixes.
- M11 `session_group`.
- M12 an explicit `swarm` arg.
- All minors.

**Accepted from Carbon:**
- #1 full op list: `askUser`, `permissionRequest`, `channel_unsubscribe`/`archive`+replacement; `activeChatId` fallback only for `default`; `reply` to a swarm general redirects to busPost.
- #2 inbound entry for swarm channels; `everyone` on each swarm's general/human; bus_post and `to=human` use the swarm's channels; #26's `to=human` guard is per swarm.
- #4 unknown swarm: Carbon says reject, Fable says downgrade. **Ruling: reject when config is set** (`unknown_swarm`), because a silent downgrade into `default` is exactly the cross-pollination Mick wants avoided. When config is unset, everything is `default`.
- #5 direct channels bypass the master; 3-way `routeCoordinator`; PR6b folded into PR4; candidacy is checked only for `role:'master'`; topic assign needs a subscriber.
- #6 the JSON config, hot-reloaded like `Grants.reload`. The env fallback is cut (one grammar only).
- #7 normSwarm for `agents`. Session polling on the 10 s timer, with re-register on change; this beats Fable's "keep until reconnect", because a pane moved by hand should follow. The PR #27 `assignedAlias` key gets the swarm.
- #8 Codex home provisioning by symlinking `auth.json`, a rendered `config.toml`, and daemon restart scoped by `CODEX_HOME`.
- #9 `swarm` in `listSessions`/`bus_sessions`.
- #10 single-flight provisioning, reconciling with existing guild channels; per-swarm archive category.
- #11 bare persisted rows load as `default`; slash commands scoped by channel swarm; `HumanMail` partitioned by swarm.
- Cuts 1–3 accepted: `agentChannels` and the master/term slots come out of PR1's SwarmStore. The master/term journal belongs to PR4's own store. This **reverses** my earlier seam-3 note to bus-pr1; PR4 owns its journal.

**Rejected:**
- Carbon #3's re-keying (see the ruling above).
- Carbon #9's "resolve `to` in channelSwarm(channel)". The sender's swarm decides, plus the cross-swarm exemption.
