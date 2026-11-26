# A10 v2 (draft): swarm master, router-run election

Replaces A10 in `bus-v4-native-ipc.md`. Reflects cuts #1, #9, #11, #12 (with a and b) and #21. PR6a is written from this text, not from the old A10 plus the ledger.

**Why.** Mick, 2026-11-26: one master whose only job is to coordinate messaging and leadership. Evidence: with no dispatcher set, every untargeted human post reached every live session and produced duplicate owners three times in one morning.

**Candidates.** A session asks for the role with `role:"master"` on the legacy `register` frame. Candidacy is allowlisted in router config (`masterCandidates: [{alias, priority}]`, operator-written). An unlisted session is registered as a normal agent and gets `not_master_candidate`. First rollout: **directly connected plugin clients only**. A gateway-bound session cannot be a candidate until the gateway can attest that specific conversation and the router can expire the attestation within the liveness bound. The v4 `registerAgent` frame has no `role` field.

**Election.** The router is the single authority; there is no consensus protocol.
- The master is **sticky**. Priority (lowest wins, ties to earliest registration) chooses a master only when none is live. A returning higher-priority candidate does not take over.
- Every change increments a monotonic **term**. The router journals `{term, master}` and announces `master: <alias> (term N)` in #general.
- After a router restart, the role is held for the journalled master until it re-registers or the liveness bound passes. Only then does priority apply.

**Liveness.** One mechanism: the router's websocket ping/pong on the candidate's own connection. The master is lost when no pong arrives within **30 s of the last verified pong** (ping interval included), or on close. The router fences the expired connection (closes it and rejects its ops) **before** promoting. Use the server's built-in idle timeout if it gives this bound; otherwise a router timer. There is no separate lease, no renewal RPC and no gateway proxy.
- **Known limit.** The pong comes from the plugin process. A master stuck at a dialog or with a full context still pongs and is not replaced. `@name` and `@all` keep working meanwhile.
- **Operator action.** `demote <alias>` (Mick or an admin session) treats the master as lost at once and promotes the next live candidate. The demoted alias is not eligible again until it re-registers. Removing an alias from the allowlist has the same immediate effect.

**Routing** (replaces the PR #9 dispatcher setting).
- An untargeted human post goes to the master only, carrying its message id and the current `term`. A post in a topic channel also goes to the master, which assigns within that channel's subscribers.
- `@name` and `to=` go direct. `@all` reaches everyone.
- While the master is lost and another candidate is live, posts are **queued** for the next master.
- Only when **no candidate is live** do posts fall back to all live interactive sessions.
- Human replies follow #20: in the topic channel, with a copy in #human-questions.

**Disposition of a human post.** Each untargeted human post X ends in exactly one durable record in the claims table, keyed by X's message id, with X's body journalled. There are two ways to write it, and both are request-correlated calls that carry `term`:
- `assign{msgId: X, owner, term}`. The router then delivers the saved post to the owner and shows the assignment in-channel. The master may name itself.
- A human-directed post with `answers: X`. The router journals X, the answer payload and a stable publication id **before** any Discord I/O.

At commit, with no asynchronous gap, the router checks: the caller is the incumbent, `term` equals the journalled current term, X is a human post that was routed to the master, and the owner is a known session (a subscriber, for a topic channel). A stale term is rejected with `stale_term`: no record, no delivery. A retry of a committed request returns the recorded disposition and completes any pending delivery or publication once.

**Promotion.** The new master receives, in bounded batches, oldest first:
- the posts queued during failover, and
- every human post routed to a previous master that has no disposition record. Nothing expires.

The router itself retries any journalled answer whose publication is still pending. The successor never composes that answer again. The #general announcement includes the count of posts without a disposition, so drift is visible.

**Agents.** An agent acts on an assignment, a direct `to=`/`@name`, or `@all`. It does not self-claim work from an untargeted human post. Agents hold no election state and never compare terms. Ordinary self-claims for directly addressed work are unchanged. The master does no implementation.

**HA.** At least two candidates on different hosts (`claude@mac:swarm-master` priority 1, `claude@nas642:swarm-master` priority 2). The standby receives nothing until promoted.

**Per-machine server.** Unchanged from §1: the gateway, one per host, native, not docker. It takes no part in election in the first rollout.

**PRs.** PR6a router: allowlist, sticky election, term journal, restart hold, liveness and fence, `demote`, routing switch, disposition record, promotion re-offer, announce. PR6b plugin: `DISCORD_ROLE=master` → register field, the `assign` tool, `answers` on human-directed posts, `term` and message id in the inbound meta. Both keep the v1 compatibility readers; v1 retirement is a separate PR. Rollout: launch the two swarm-master sessions, then set the allowlist. Rollback: an empty allowlist restores the fallback.

**Acceptance tests.**
1. Black-hole the master's link right after a pong, standby healthy: exactly one promotion within 30 s, and the old connection's ops are rejected.
2. Post during the black-hole window: the new master receives it once.
3. A → B → A, where B answered X with `answers: X`: A's delayed term-1 `assign` for X gives `stale_term`, zero owners, zero deliveries. Repeat after a router restart.
4. Retry of a committed `assign` returns the recorded owner with one delivery.
5. Crash before and after the Discord send of an answer, and a Discord outage longer than five minutes: the answer is never recomposed; inside Discord's nonce window a retry shows one answer. After the window, an ambiguous send is reconciled against a durable publication reference (recent channel history) before any retry; if delivery cannot be established it is surfaced as `uncertain`, not re-sent blindly. Test the crash window with nonce dedupe expired. (R10, Astra)
6. Router restart with the standby reconnecting first: the journalled master keeps the role and the term does not change.
7. A returning priority-1 candidate does not displace a live priority-2 master.
8. `demote` promotes at once; an unlisted alias gets `not_master_candidate`; no candidate live gives the broadcast fallback.
