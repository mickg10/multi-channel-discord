# Round 9 · Neon · A10 v2 Red-Team, 6-PR Cut Mapping, and Restorations

Reviewed `bus-v4-simplification-log.md`, `r7-astra.md`, `r8-fable.md`, and `a10-v2-draft.md` at `666dd58`.

## Red-team of `a10-v2-draft.md`

- **Coverage:** Every accepted A10 cut (`#1`, `#9`-split, `#11`, `#12` narrowed + a/b, `#21`) is represented with no ruling reversals; six line-level fixes below close remaining edge cases before PR6a begins.
- **L12 & L21 (restart-hold queuing):** L12 holds the role for the journalled master up to 30 s, while L22 broadcasts whenever "no candidate is live." Clarify in L12/L21 that untargeted human posts arriving *during* the 30 s restart hold are **queued**, not broadcast, until either the held master reconnects or the 30 s hold expires with zero live candidates.
- **L14 (initial watchdog clock):** L14 starts the 30 s bound at "the last verified pong." Add "or connection registration before the first pong" so a candidate that registers and immediately black-holes before any pong still expires within 30 s.
- **L16 (`demote` last-candidate & allowlist reload):** Specify: (a) demoting the *only* live candidate bumps `term`, journals `{term, master: null}`, fences the demoted connection, and enters broadcast fallback until a candidate (re-)registers; (b) define how allowlist edits take effect (file-mtime reload like `Grants.reload`, or restart)—don't promise "immediate" without a reload hook.
- **L26–L27 (`from_human` provenance & #20 publish reuse):** On L26, require `assign` delivery to preserve `from_human: true` (plus original `msgId`/channel meta, as PR #9's `dispatch` does) and note that `assign{owner: master}` also closes posts a predecessor answered without `answers`. On L27, state that `answers: X` reuses #20's persisted publish record so retries send only any missing topic/`#human-questions` copy.
- **L29 (commit-check scope & conflict order):** Scope the owner check to `"and (for assign) the owner is a known session (a subscriber, for a topic channel)"` (`answers` has no owner). Pin order: check incumbent + `term === currentTerm` **before** idempotency lookup (so stale-term retries always return `stale_term`), and on a same-term call for already-disposed `X`, return the recorded disposition only when the payload matches—reject conflicting re-dispositions without overwriting or re-delivering.
- **L45–L53 (missing acceptance tests):** Add three tests matching ledger rulings: (a) Test 3b: A→B→A where B answered `X` *without* `answers: X` (no disposition row), proving `term` itself blocks A's delayed term-1 `assign`; (b) bounded oldest-first batch re-offer + `#general` no-disposition count; (c) `assign` naming the master itself closes `X` with zero extra posts.

## Amended 6-PR plan audit (all 26 cuts mapped, zero orphans)

| PR (merge order) | Cuts | Scope / Primary Files | Dependencies / Rollout Gate |
|---|---|---|---|
| **PR-1** Design freeze | `#2`, `#14`, `#15`, `#19`, `#21` *(+ `#22` doc)* | `docs/design/bus-v4-native-ipc.md` (A10 v2, dormant Q1/Claude hooks, strip agy LS creds + Codex HTTP + `probe`/opencode GETs) | None; merges first to unblock PR-5 |
| **PR-2** Router cleanup & compat | `#8`, `#17a`, `#24` | `src/inboxes.ts` (drop receipt HMAC + `push`/`drain`), `src/ws.ts` (`busPost` in `gatewayOp` + legacy compat) | Independent; **must deploy live to vps2 before PR-3** |
| **PR-3** Gateway wire, store & adapters | `#3a`, `#7`, `#10`, `#17b`, `#20`, `#22`, `#23`, `#25` | `deliver.ts` (drop `onPending`), `store.ts` (narrowed `#10` `unavailable`-only drop), `router-link.ts`, `gateway.ts`, `types.ts`, `adapters/{codex,opencode}.ts`, `fake-adapter.ts` | Stacks on `#13`–`#17`/`#19`; merges after PR-2 is live on vps2 |
| **PR-4** Gateway host, registry & peer-cred | `#4`, `#5`, `#6`, `#13`, `#16`, `#26` | `registry.ts`, `host.ts`, `peer-cred.ts`, `peer.ts`, `discovery.ts`, `gateway.ts` (`privateDir`/`onConn`) | Stacks/rebases on PR-3 (`host.ts`/`gateway.ts` overlap) |
| **PR-5** Master election (PR6a/6b) | `#1`, `#9`, `#11`, `#12` | Router (`ws.ts`, `router.ts`, `inboxes.ts`/claims) + `plugin.ts` (`DISCORD_ROLE=master`, `assign`, `answers`, meta); keeps v1 compat readers | Requires PR-1 frozen; independent of PR-3/PR-4 |
| **PR-6** Router v1 retirement | `#18` *(+ `#3b`, `#17c`)* | `src/inboxes.ts` (`leaseId`, `Inboxes.ack()`), `src/ws.ts` (drop v1 `mark`/`ack`/legacy native `busPost` translation) | Merges **only** after all gateway scopes & rollback images run PR-3 |

- **Mapping check:** All 26 cuts (`#1`–`#26`) are accounted for with zero orphans. Only two cuts legitimately span a live mixed-version deploy boundary—`#3` (`3a` gateway drops `mark`/`ack`/`onPending` in PR-3; `3b` router retires v1 handlers in PR-6) and `#17` (`17a` router accepts `gatewayOp:busPost` in PR-2; `17b` gateway flips caller in PR-3; `17c` router retires compat in PR-6)—leaving `#18` cleanly in PR-6; note PR-4 rebases on PR-3 for shared `host.ts`/`gateway.ts` edits.
- **PR-1 doc sync for #22:** Include `#22`'s spec edits in PR-1 so the frozen doc matches code: drop `probe` from §4c `interface Adapter` and drop `GET /api/session/active` + A5's `GET /api/session/{id}` from §4b's opencode allowlist (retaining `GET /api/session` for discovery).

## Restorations

- **No further restorations beyond Fable's R8 narrowing of `#10`** (drop only `unavailable` rows on ack; keep `woken`/`held`/`refused` until next `check_inbox` to preserve R2#2's one-nudge invariant). Every other logged-failure guard (N1–N4, pre-send wake store, echoed receipt, per-call identity, peer-cred checks, commit-before-transport, ABA term fence) remains intact across all 26 cuts.
