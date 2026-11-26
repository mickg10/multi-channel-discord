# Round 3 · Neon · Tiebreaks (#8, #9) and 3 New Cuts (#11–#13)

Reviewed `bus-v4-simplification-log.md`, `r1-astra.md`, `r2-fable.md`, `bus-v4-native-ipc.md` (§1–§7, A1–A10), and `prs/pr12.diff`–`pr20.diff` at `0e48c14`.

## Tiebreak (a): #8 — Drop signed receipt HMAC (`pr12.diff`, `src/inboxes.ts` L1070–1116)

- **Verdict: ACCEPT #8** (~25–30 LOC + 1 `receiptKey` journal record removed; subject to `ops-upgrader` veto). Keep plain `randomUUID()` receipts.
- **No harm from a consumed (or active) foreign receipt:** `lease(key, receipt)` filters `pending = this.list(key)` exclusively to `key`'s own entries, and `ack(key, ...)` checks `entry.key !== key`. If agent B presents A's consumed (or active) receipt `R_A`, `ids` is `[]`, `accept([])` is a no-op, A's mail is untouched, and B only leases B's own already-authorized `available` mail (which B could already do via `lease(B, undefined)`).
- **Closes an oracle:** With the HMAC, presenting `R_A` throws `invalid_receipt` whereas garbage returns `receipt_status: 'stale'`, letting B probe whether an opaque string was ever another agent's valid receipt. Dropping the HMAC removes that cross-agent oracle while preserving every mail-safety test (update `consumed-foreign` to assert `stale` + zero cross-agent ack).

## Tiebreak (b): #9 — Drop `term` from the wire (A10)

- **Verdict: SPLIT #9.** **ACCEPT** dropping the worker-side prompt rule ("agents ignore an older term"): with Cut #1, every assignment is router-verified, so workers never need term tracking. **REJECT** dropping `term` from the master's `assign` wire op (keep one integer field + `req.term === currentTerm`, ~5 LOC).
- **Concrete ABA interleaving where `"caller is current master"` is NOT enough:**
  1. `M1` (priority 1, **term 1**) receives Mick's message `X` and starts a slow turn.
  2. `M1` stalls/disconnects; router promotes `M2` (**term 2**). `M2` handles `X` directly (`to="human"` reply, **no** assignment/claim row written for `X`).
  3. `M1` reconnects and is re-promoted (**term 3** — either via A10's priority failback or because `M2` later drops).
  4. `M1`'s delayed term-1 turn finishes and sends `assign(msgId=X, owner=W1)` with no `term`.
  5. Router checks `caller === currentMaster`: `M1 === M1` **passes**, no prior claim exists for `X`, and router wakes `W1` to re-run already-answered work (same bug if `M1` emits a stale `release_claim` or `reassign` after regaining leadership).
- **Fix:** Include `term` in the master's inbox JSON and require `assign` (and any master-only op) to echo `term === currentTerm`. Zero worker-side complexity; cleanly closes ABA re-promotion.

## Three New Cuts (missed by Astra and Fable)

- **11. Make elected master sticky; drop priority preemption at lease boundaries (A10, L252).** Use `masterCandidates` priority *only* to choose among waiting candidates when no master is live. Do not auto-preempt a healthy running standby (`M2`) when `M1` returns: `M2` is already a full standby on `nas642`, and automatic failback adds a deferred-takeover timer/state machine, drops `M2`'s live conversation context mid-task, and manufactures the ABA race in #9. Avoids ~15–25 LOC in PR6a; keep election-on-loss, tie-break by priority, and operator restart/demote to move master back.
- **12. Drop the separate 30 s master-lease renewal protocol and gateway lease proxy (A10, L252 & L257).** On a single-authority router, every live candidate already has WebSocket heartbeat/disconnect detection (legacy WS or gateway WS) plus `releaseAgent` on process exit. Adding a second 30 s lease-renewal timer and gateway-side lease-renewal RPC duplicates WS liveness without catching a hung LLM process (a gateway renewing on its behalf would keep a frozen master elected anyway). Tie master tenure directly to live registration (`ws` close or `releaseAgent` → promote next live candidate, increment monotonic `term`, persist `{term, master}`). Avoids ~40–60 LOC across PR6a and gateway; preserves failover queue, no-candidate fallback, and single-master HA.
- **13. Delete module-global `codexSockets` and `opencodeServicePaths` maps in `src/gateway/host.ts` (PR #16, L2580–2607).** `host.ts` keeps two process-global mutable maps (`setCodexControlSocket`, `setOpencodeServicePath`) keyed by bare `conv` alongside `Registry`, inviting state leaks across tests, cross-kind collisions, and registry-vs-map drift on unregister/rebind. Store the verified `endpoint?: string` directly on `AgentRec`/`Target` in the single `Registry` (Cut #4) and read `target.endpoint` inside the adapters (preserving explicit config `servicePath` override for opencode and the two-independent-service regression). Cuts ~20–25 LOC and removes all module-global mutable state from `host.ts`.
