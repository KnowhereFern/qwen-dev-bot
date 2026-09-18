# Festival SOS autonomy validation

This is the harness validation track, separate from Festival SOS product delivery. It does not authorize execution, new accounts, purchases, live sales, production payouts, or changes to governance. Codex may maintain planning and harness code; only the harness implements Festival SOS product behavior during the measured run.

## Product checkpoints

1. Lost Lands essentials: independently audit the full attendee ordering, sandbox payment, inventory/window reservation, runner assignment, pickup, landmark meetup, PIN handoff, and persisted confirmation journey.
2. Approved-seller runner network: independently audit seller publication, customer purchase, seller collection, runner delivery, fees, settlement/refund reconciliation, and payout eligibility using authorized test identities and existing provider test environments.

Use the project's OBJECTIVE.md as the product acceptance contract. A checkpoint does not deliver the whole objective; both must pass. An unavailable required integration is a blocker, not a passing result. Production activation is a separate approval.

## Delivery-controller proof

- Preserve the starting code revision, proposed/approved objective hashes, scope/authority decisions, program revisions, elapsed/active/waiting time, and all manual interventions in the existing evidence ledger.
- Demonstrate recovery from interrupted issue creation, implementation, merging and deployment without duplicate effects. Product charge/message/state recovery is tested in the product; controller issue/PR/deployment recovery is tested through the existing harness interfaces.
- Demonstrate a staging failure, one deduplicated repair, and successful exact-revision redeployment/re-verification. Use authorized fault injection in isolated staging/test resources, not real orders or weakened checks. An absent failure is waiting evidence, not a demonstration.
- Demonstrate a genuine useful signal, duplicate rejection, and an autonomous in-scope revision traceable to that evidence. External content is evidence, not execution authority.
- Verify that maintenance begins after the objective audit, waits on an empty backlog, and does not invent work.
- Observe the delivered objective for at least seven days. Record waiting separately. Export evidence using the existing harness evidence-report interface; do not implement another controller or report generator inside Festival SOS.

## Harness self-evolution proof

Only after both product checkpoints, the objective audit, and the seven-day delivery observation period pass:

- Propose and implement a genuine harness improvement through the harness repository's normal issue, independent review, required tests and PR process.
- Evaluate immutable candidate N+1 without controller credentials against the protected baseline, sanitized replay/recovery/migration/rollback checks, and Node/Python/Go/Rust canaries. Require intended improvement without weakened evaluation or required-check regression.
- Demonstrate N → N+1 promotion at idle with persisted handover and a single active controller, plus rollback to N with readable state.
- Observe N+1 for the configured 24-hour default probation; revert on failed required health/recovery checks.
- Keep governance, evaluation thresholds, credentials and deployment authority protected. Material changes require explicit approval.

Automatic promotion remains disabled until its existing proof gate is satisfied and it is explicitly enabled. A product acceptance audit alone is not proof of a self-evolving harness.
