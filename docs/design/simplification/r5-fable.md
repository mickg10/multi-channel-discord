# Round 5 · Fable · #11–#17, narrowed #12, and a coherence check

I accept all six cuts put to me, three of them with a condition. Narrowed #12 leaves out two things we need. The 17 cuts together leave four mechanisms half-removed; each needs a few more lines deleted, not restored. Checked against added lines in `prs/`; tests not run.

## #11, #13–#17

1. **#11 sticky master: ACCEPT, with one condition.** Input: the router restarts while M2 is master. State: both candidates reconnect, and "no master is live" is true for an instant. Wrong result: whichever socket lands first wins, so every router restart can flip the master and bump the term for no reason. On restart, hold the role for the journalled `{term, master}` until that alias re-registers or the liveness bound passes; use priority only after that.

2. **#13 endpoint on the registry record: ACCEPT, on `AgentRec` only, not `Target`.** `Target` is the shared type the router journals in `bind` records and the wake store copies into each row. A local socket path or opencode service path has no business in either. `RouterLink.registerAgent` already sends only kind, conv, alias and host; keep it that way and add a test that the frame carries no endpoint.

3. **#14 no agy credential harvesting: ACCEPT.** R6#3 already made human agy TUIs pull-only, so the harvested `runState` has no consumer left. The cut is incomplete as written: it must also strike the agy clause in §4b registration ("accepted only from a peer descended from that agy pid") and agy CSRF from the §4b secrets list.

4. **#15 no loopback HTTP MCP: ACCEPT.** The whole §4b identity check rests on Unix-socket peer credentials. A TCP loopback listener has none, so it would need a second authentication scheme for the same calls.

5. **#16 retire the verified-socket callback: ACCEPT.** Confirmed: in #19 the injected handler bypasses `serveGatewayMcp` entirely and receives a connection-time snapshot of agents, which is the stale-binding shape the per-call lookup was written to avoid. Its only caller is one test in #17.

6. **#17 fold native `busPost`: ACCEPT, with one check.** The two sender contexts differ today. The `gatewayOp` one sets `instanceId: native:<identity>` and drops replies when the alias has been rebound to another connection; the `busPost` one has no `instanceId` and writes to the socket unguarded. Folding is an improvement, but the implementer must confirm that the rate limiter and the publish dedupe key do not change when `instanceId` appears, or a retried post across the upgrade is delivered twice.

## Narrowed #12 (direct candidates, router websocket watchdog)

7. **Left out: human posts already handed to the master that dies.** Input: Mick posts untargeted at t=0; M1's link black-holed at t=−5 s. State: the post is committed to M1's inbox and pushed into a dead socket; the watchdog fires up to 30 s later. A10 queues for the next master only posts that arrive *after* the lease is lost. Wrong result: M2 is promoted with an empty queue and Mick's post is never seen. Fix with what #1 already gives us: on promotion, re-offer to the new master every human post that has neither an assignment record nor an answer.

8. **Left out: a connected master that is not working.** The watchdog measures the plugin's websocket, and the plugin is a child process that keeps answering pings while its Claude session sits at a permission dialog or a full context. Astra says as much. I do not want a progress protocol; I want the limit written down and one operator action to go with it: a demote command (or removing the alias from the allowlist takes effect at once), which sticky #11 otherwise makes impossible short of killing the session. `@name` and `@all` still reach agents meanwhile.

9. **Before writing a watchdog, check the server's own option.** #12 and #20 set no ping or idle option on the router's websocket server. I believe Bun's server exposes an idle timeout with automatic pings (default about 120 s); I have not verified this against the pinned Bun version. If so, the watchdog is one configuration value plus the fence-before-promote step, and it applies to every connection, which also bounds stale legacy sessions.

## Size check: four mechanisms left half-removed

10. **Lease id.** After #3 (no per-item `ack`), #8 (receipt is a plain UUID) and #10, nothing but the v1 handler reads `leaseId`. The receipt is the lease. Once the v1 `ack` handler retires, drop `lease.id`, `LeasedMessage.leaseId` and `Inboxes.ack()`, and rewrite §4b ("ack must carry the lease id") and §4c (`ack(as,leaseId,id)`, `mark(as,id,state)`) to say the echoed receipt acks. Also remove the now-unused `onPending` parameter of `stepDelivery`.

11. **Claude hook registration.** #2 became "don't build the token route", but the design still carries everything that existed only to feed it: the `SessionStart`/`UserPromptSubmit` `agent-bus register` hook, in-memory token custody, the "re-register on next hook" rule in §5, the ancestry check on hook peers in §4b, A1 and its dissent, and the `claude-inbox` transport value. A channel-capable session registers through its own pipe. Mark all of it as dormant with Q1, in one place, or an implementer will build the hook with nothing behind it.

12. **`tmux` transport and A10's lease wording.** With #14 and M4 deferred I can find no remaining consumer for the `tmux` transport value (Codex and opencode are native, Claude is channel, grok and agy are pull-only or ACP); it survives in three validation sets and one test helper. Confirm and remove it, or name its user. Separately, after #11 and #12, A10 still says "30 s lease", "2 missed heartbeats", "next lease boundary" and "the gateway renews the master lease"; and `role` on the v4 `registerAgent` frame has no user in the first rollout. PR6a should be written from a rewritten A10, not from the amended one plus a ledger.
