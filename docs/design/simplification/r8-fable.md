# Round 8 · Fable · Last defence

I accept all five cuts put to me. One thing already cut must be narrowed, and it is my own #10. Nothing else needs to come back. The A10 rewrite is in [a10-v2-draft.md](a10-v2-draft.md) (52 lines). Checked against the lines visible in `prs/`; tests not run.

## #22, #12(a), #24–#26

1. **#22 delete `probe()`: ACCEPT.** N2 already forbids check-then-send, so a busy probe could never authorize an inject. Astra's point that the opencode probe only checks the active map is an object settles it. Keep the two guards the ruling added: the partially-typed-draft test, and no injection on a kind without an atomic native queue. The opencode allowlist loses `GET /api/session/active` and A5's `GET /api/session/{id}`; `GET /api/session` stays for discovery.

2. **#12(a) in Astra's form: ACCEPT, with two additions.** Journalling the answer before Discord I/O and re-offering in batches with no expiry are right. Addition one: "require `answers: X`" is not enforceable, because the router cannot tell that a human-directed post closes X. Input: the master answers X and omits `answers`. State: X has no disposition, forever. Result: X is re-offered on every promotion. That is the safe direction (a duplicate answer beats a lost post), but it must not be invisible, so the #general master announcement carries the count of posts without a disposition. Addition two: the master must be able to close X without posting, so `assign` may name the master itself.

3. **#24 delete `Inboxes.push()` and `drain()`: ACCEPT.** I found no caller outside tests in the visible lines of #12, #18 and #20. `drain()` accepts before the caller has sent anything, which is the order that lost mail in the R5 finding.

4. **#25 delete `resumeFromDisk()`: ACCEPT.** Two tests call it. It replays results before the router has confirmed any binding, which A7 forbids for the real host.

5. **#26 share the private-directory check: ACCEPT.** Since #17 the two copies are identical and both throw on a foreign owner. Keep the throwing form; #14's original returned silently.

## What must come back

6. **Narrow my own #10 leak fix.** I wrote "drop a terminal row once the router has acknowledged its result". That is too broad. Input: a `held` wake to a bypass session, reported and acknowledged; then a second message for the same conversation. State: the `held` row is the only thing making the gateway answer `queued`, because the router's `wakePending` counts only `uncertain` and `woken`. Wrong result if the row is dropped: a second nudge and a second approval dialog, then a third, which breaks "at most one un-acked nudge per conversation" (R2#2). Drop only `unavailable` rows on acknowledgement. `woken`, `held` and `refused` rows stay until that conversation's next `check_inbox`, as they do today.

7. **Nothing else.** I re-read the 26 cuts for a removed guard with a logged failure behind it and found none. The pre-send wake record, the receipt echo, the per-call identity check, the peer-credential checks and commit-before-transport are all intact.

## A10 rewrite

8. **Three choices in the draft that the ledger did not settle.** (a) `demote` makes the alias ineligible until it re-registers; otherwise sticky election would hand the role straight back to a stuck master when the next one drops. (b) Batches go oldest first. (c) The restart hold uses the same 30 s bound as liveness, so there is one number.

9. **One addition beyond the ledger.** The draft states the commit-time checks for both `assign` and `answers` in one place: incumbent, current term, X was routed to the master, owner is known. `answers` needs the term fence as much as `assign` does, or a deposed master's late answer is published after its successor's.

10. **PR6b grows.** The plugin needs the `assign` tool, `answers` on human-directed posts as a request-correlated call, and `term` plus the message id in the inbound meta. The old A10 scoped PR6b as one environment variable.
