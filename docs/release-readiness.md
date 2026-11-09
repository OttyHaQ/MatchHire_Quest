# Release readiness — event intake duplicate fix (DEF-001)

## Decision

**GO** for the fixed build, scoped to event intake and duplicate handling, on two conditions:

1. The data-repair query for existing duplicate `(client_id, event_id)` entries runs, and ops review the affected loans before or at release.
2. The production store enforces a unique constraint on `(client_id, event_id)` (not in scope of this fixture; see gaps).

## Checklist

| # | Check | Result |
|---|---|---|
| 1 | Business rules written down and agreed (B, E, R, I, S, P, D) | Pass — [business-rules.md](business-rules.md) |
| 2 | Happy path end to end | Pass — TC01 |
| 3 | Interest-first allocation and overpayment | Pass — TC02, TC12 |
| 4 | Cut-off boundary at 23:59:59 / 00:00:00 WAT | Pass — TC03 |
| 5 | Time-zone conversion; zone-less timestamps rejected | Pass — TC04 |
| 6 | Identical resend is a no-op | Pass — TC05 |
| 7 | **Retry after lost response is applied once** | Pass — TC06 (fails on faulty build) |
| 8 | **Retry cannot cause a false RECOVERED** | Pass — TC07 (fails on faulty build) |
| 9 | **Reconciliation counts a retried repayment once** | Pass — TC08 (fails on faulty build) |
| 10 | Genuine repeat payments are not over-deduplicated | Pass — TC09 |
| 11 | `event_id` reuse with different data rejected | Pass — TC10 (fails on faulty build) |
| 12 | Partial failure keeps the event and reconciliation repairs it | Pass — TC11 |
| 13 | Guards: unknown loan, double escalation, closed loans, decimals | Pass — TC13–TC15 |
| 14 | Regression cases gate CI for event intake | Ready — `npm test` exits non-zero on any failure; wire into the pipeline |
| 15 | Data repair plan for historical duplicates | Written — [defect-report.md](defect-report.md#fix); not executed (no real data) |

## Remaining gaps

| Gap | Risk | Next step |
|---|---|---|
| Duplicate keys live in memory; a restart forgets them | A retry after a restart would be applied again | Persist keys with the ledger; unique constraint on `(client_id, event_id)` |
| Concurrency: two retries arriving at the same moment | Both could pass the check in a multi-instance deployment | Database unique constraint; add a parallel-retry test |
| Out-of-order events (F3) | Wrong interest/principal split | Define ordering by `event_time`, then add tests |
| Reconciliation trusts the ledger | It cannot detect a duplicate that is already in the ledger | Add a check for repeated `(client_id, event_id)` in the daily report |
| Rejected events are logged, not alerted | Clients may not notice rejected repayments | Alert ops on rejections, especially `EVENT_ID_CONFLICT` |
| No auth on the fixture's test endpoints | Fixture only | Never ship `/__test/*` routes |

## Handoff

- **Run it:** `npm ci`, then `npm run test:faulty` (expect 4 failures) and `npm run test:fixed` (expect 15 passes). Reports open with `npx playwright show-report results/fixed/html-report`.
- **Own going forward:** keep TC06–TC10 in the CI gate for any change to event intake or reconciliation.
- **Ops:** run the duplicate-entry query from the defect report and review loans marked RECOVERED or with an overpayment.
- **Engineering:** close the gaps above, starting with persisted keys and the unique constraint.
