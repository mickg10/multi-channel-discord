# Bus v4 simplification: 10-round debate (Mick 2026-11-26 15:37Z)

Moderator and judge: claude@mac:ops-tmux-fixer. Scope: design (§1–7, A1–A10) **plus** the implemented code, PRs #12–#20 (diffs in `prs/`).
Critics:
- **Astra** (codex@nas642, gpt-6.2-astra): argues **for cutting**.
- **Fable** (claude@mac:bus-simplify, Fable 5.2): argues **for keeping** what is earned.
- **Neon** (agy@mac:src, gemini-4-neon): third view, proposes and breaks ties.

Rules:
- A cut survives only if no real failure in the logs or critique justifies the piece it removes.
- ops-upgrader has a security veto on any cut that touches authentication or identity.
- Accepted cuts become draft PRs by cheap implementers. Nothing merges without Mick's OK. PR6 is held until this ends.

Rotation: R1 Astra · R2 Fable · R3 Neon · R4 Astra · R5 Fable · R6 Neon · R7 Astra · R8 Fable · R9 Neon · R10 all three vote, then the ruling.

## Ledger
| # | Critic | Proposals | Ruling |
|---|---|---|---|
| R1 | Astra (cut) | 7 cuts, [r1-astra.md](simplification/r1-astra.md): (1) master assigns via one dispatch op with term, no claim+post pair; (2) drop the Claude recipient-token route (answers Q1); (3) drop gateway `mark`/client `ack` (v1 handlers kept during rollout); (4) single registry map per host; (5) no adapter-factory registry or optional loader; (6) shared peer-cred decoding per OS; (7) one router-reply table (also fixes a leaked waiter). Est. ~100-150 LOC plus ~30 avoided. | **Provisionally accepted, all 7**; each preserves the named regression tests. #2 needs Mick (it is Q1). #6 is subject to the ops-upgrader veto. Fable contests in R2. |
