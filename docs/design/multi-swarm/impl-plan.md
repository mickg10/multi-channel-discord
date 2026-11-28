# Multi-swarm implementation plan

**Spec:** `spec-final.md`. §10 overrides §0–§9.
**Implementer:** agy Neon seat `agy@mac:swarm-impl`.
**Reviewer:** ops-tmux-fixer.
**Merge and deploy:** discord-integrator, under the bus rule.

## Base
- **Worktree:** `~/src/mcd-multi-swarm`.
- **Branch:** `feat-multi-swarm` at 0c7e504. That is main 07e77bd plus #26 and #27 merged locally (one router.ts import/shutdown conflict, resolved). 278 tests pass and 1 is skipped.
- **Prerequisite:** #26 and #27 must merge to main before the first multi-swarm PR. Each PR is then rebased onto main.

## PR order (each its own branch off the previous one; each green on its own)
1. **PR1a: config and registration**
   - **Files:** `src/swarm-config.ts` (new), `src/swarm-journal.ts` (new), `src/types.ts`, `src/ws.ts` (register/rename/registerAgent/registerNode), `src/sessions.ts` (`host:instanceId`, slot `WsLike`, `swarm`), `src/name-leases.ts` (optional host), `src/subscriptions.ts` (reclaim key).
   - **Spec:** §1, §2, 10.1–10.3 and 10.5 (protected and candidate checks only).
   - **Acceptance:**
     - With no config file, the full existing suite is unchanged.
     - The new tests cover names, dedup, journal moves, `-N`, protected aliases, `unknown_swarm`, numeric and `defaultSessions`, and the configured-empty cold start.
2. **PR1b: channels**
   - **Files:** `src/swarm-channels.ts` (new: `channelSwarm`, provisioning, sweep, overflow picker), `src/router.ts` (clientReady/channelUpdate/reload hooks, inbound entry, before-`gate()` drop), `src/agent-channels.ts`, `channelOps`.
   - **Spec:** §3 and 10.4.
   - **Acceptance:** fake-guild tests covering provisioning (single-flight, adoption refusal), unknown-before-fetch, cache-miss fetch, threads, archived N, retired, sweep, and the moved direct channel.
3. **PR1c: scoping**
   - **Files:** `src/ws.ts` (`assertChannelInSwarm` on every op, `swarmMembers`, `to=` rules, outbound/inbound/fallback, claims/dispatch/HumanMail), `src/router.ts` (reply-to-bot, permission buttons), `src/slash-commands.ts`, `src/nodes.ts` (claims partition).
   - **Spec:** §4, 10.5 (permissions) and 10.6.
   - **Acceptance:** one cross-swarm rejection test per op; permission round trip in `cfd:human`; slash-command scoping.
4. **PR2: plugin**
   - **Files:** `src/plugin.ts`.
   - **Content:**
     - raw swarm with `generated` at register;
     - `registered.swarm`;
     - pane and window lookup;
     - the 10 s re-check;
     - the `swarm_changed` handling;
     - `swarm?` on the tool schemas;
     - `sendToolRequest` for posts;
     - the `register rejected:` handling with `lastRejectReason` and a 60 s retry;
     - the grok/opencode ancestor check;
     - the alias-watch fix.
   - **Spec:** §5, 10.1 and 10.6.
   - **Acceptance:** plugin unit tests, plus a manual two-session run on the Mac against a local router.
5. **PR3: ops**
   - **Files:** `mickg-containers/vps2/agent-bus/start-agents.sh` (ops repo, a separate commit there) and the per-CLI config renders.
   - **Spec:** §7 and 10.7.
   - **Acceptance:** run on mac, nas642 and nas64 with `--swarm test1`, each CLI verified on a real host (§9 proof).
6. **PR4: per-swarm election.** Later, after PR1–PR3 run live. Spec §6 and 10.5.

Every PR must pass `bunx tsc --noEmit` and `bun test`. Each one also has to keep the no-config back-compat suite byte-identical in behaviour.

## Rollout (spec §9)
1. Merge and deploy PR1a–c and PR2 with no config file present. Verify versions on every host.
2. Collect `tmux ls` from mac, nas642 and nas64. Write `swarms-config.json` on vps2 with `defaultSessions` and one swarm, `test1`.
3. PR3: start `test1` sessions on all three hosts.
   - **Proof:** claude, codex, opencode and grok (plus agy where present) register as `<agent>@<host>:test1/<dir>`, and `bus_sessions` shows them in `test1`.
   - **Cross-check:** a `test1` agent cannot reach `default`, and the reverse.
4. nas64 logins: device codes from Mick. The CLIs are already installed: claude 2.1.332, codex 0.172.0, opencode 1.19.6, grok 1.0.92, and the bus client on bun 1.4.5.
5. Real swarms (e.g. `cfd`) and channel migration only with Mick's OK.

## Rules for the implementer
- **Don't touch:** live sessions, vps2, or any host outside the worktree. No pushes to main.
- **Commit and push:**
  - commit per PR on its own branch;
  - push the branch;
  - open a **draft** PR against main with a stacked-base note.
- **Report:** post progress to `claude@mac:ops-tmux-fixer` via `bus_post` only when a PR is ready or you're blocked.
- **When the spec is wrong against the code:** write the deviation in the PR description, with file:line. Don't silently redesign.
