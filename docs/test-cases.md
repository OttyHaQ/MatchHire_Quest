# Test cases and results

15 automated cases in [tests/recovery-ledger.spec.ts](../tests/recovery-ledger.spec.ts), run with Playwright's API testing against a local RecoveryLedger. Amounts are naira. Each test starts from an empty ledger.

**All data is synthetic:** the loans, clients, event IDs and ₦ amounts are invented for this fixture. None comes from a real system.

**Results:** faulty build — 11 passed, **4 failed** ([run log](../results/faulty/test-run.txt)). Fixed build — **15 passed** ([run log](../results/fixed/test-run.txt)).

| ID | Covers | Input | Expected | Faulty | Fixed |
|---|---|---|---|---|---|
| TC01 | Happy path | Escalate P ₦50,000 + I ₦5,000 → repay ₦55,000 → RECOVERED | Accepted; status RECOVERED; outstanding ₦0; repaid ₦55,000 | Pass | Pass |
| TC02 | Allocation (R1, I1) | Escalate P ₦50,000 + I ₦5,000 → repay ₦3,000 → interest ₦500 | After repay: interest ₦2,000, principal ₦50,000. After interest: interest ₦2,500, total ₦52,500 | Pass | Pass |
| TC03 | Cut-off boundary (B3) | Repayments at `2026-10-05T22:59:59Z` and `2026-10-05T23:00:00Z`; reconcile 2026-10-05 | First → 2026-10-05, second → 2026-10-06; day report lists only the first | Pass | Pass |
| TC04 | Time-zone conversion (B2, B3) | Repayment at `2026-10-06T00:30:00+01:00`; then one with no zone | Business date 2026-10-06; stored as `2026-10-05T23:30:00.000Z`. Zone-less → 400 `INVALID_EVENT_TIME` | Pass | Pass |
| TC05 | Duplicate input — identical resend (B5) | Same repayment ₦6,000 sent twice with the same `sent_at` | Second → 200 `DUPLICATE`; outstanding ₦49,000 | Pass | Pass |
| **TC06** | **Retry after lost response (B5, P4)** | Repayment ₦6,000; first attempt committed but answered 504; retry same `event_id`, new `sent_at` | Retry → 200 `DUPLICATE`; 1 ledger entry; outstanding ₦49,000 | **Fail** — retry ACCEPTED as new | Pass |
| **TC07** | **Retry → false recovery (S1)** | Escalate ₦10,000; repay ₦6,000 with lost response + retry; send RECOVERED | Outstanding ₦4,000, overpayment ₦0; RECOVERED → 409 `BALANCE_NOT_ZERO` | **Fail** — outstanding ₦0, overpayment ₦2,000 | Pass |
| **TC08** | **Retry vs reconciliation (D3)** | Repay ₦6,000 with lost response + retry; reconcile 2026-10-05 | Day report: 1 repayment, ₦6,000 | **Fail** — 2 repayments, ₦12,000 | Pass |
| TC09 | Over-fix guard (B6) | Two repayments of ₦1,000 with different `event_id`s | Both apply; repaid ₦2,000; outstanding ₦48,000 | Pass | Pass |
| **TC10** | **`event_id` reuse with different data (B5)** | `rep-010` for ₦1,000, then `rep-010` for ₦9,000 | Second → 409 `EVENT_ID_CONFLICT`; outstanding ₦49,000 | **Fail** — accepted as a new event | Pass |
| TC11 | Partial failure (P1–P3, D2) | Balance update fails after commit on a ₦3,000 repayment; then reconcile | 200 with `BALANCE_UPDATE_PENDING`; stored balance stale at ₦55,000; ledger has the entry; reconcile corrects to ₦52,000 and lists the mismatch | Pass | Pass |
| TC12 | Overpayment (R2) | Escalate P ₦10,000 + I ₦1,000; repay ₦12,000 | Outstanding ₦0; overpayment ₦1,000 | Pass | Pass |
| TC13 | Guards (R3, E1) | Repay an unknown loan; escalate the same loan twice with different `event_id`s | 404 `LOAN_NOT_FOUND`; 409 `LOAN_ALREADY_IN_RECOVERY` | Pass | Pass |
| TC14 | Write-off and closed loans (S2, S3) | Escalate ₦9,000 + ₦1,000 → WRITTEN_OFF → interest → repayment | Written off ₦10,000; later events → 409 `LOAN_RESOLVED` | Pass | Pass |
| TC15 | Whole-kobo naira amounts (B1) | Repayment `amount_naira: 10.005`; then `amount_naira: 10.5` | First → 400 `INVALID_AMOUNT`; second accepted; outstanding ₦9,989.50 | Pass | Pass |

**Why TC05 passes on the faulty build:** it resends identical bytes, which a whole-body hash does catch. That is exactly how the defect would survive a basic duplicate test. TC06 differs only in `sent_at`, as a real retry does.
