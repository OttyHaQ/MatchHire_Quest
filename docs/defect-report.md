# DEF-001 — Retried repayment is applied twice; loan can be wrongly marked RECOVERED

| Field | Value |
|---|---|
| Component | RecoveryLedger — event intake (`POST /events`) |
| Build | `RL_MODE=faulty` (local fixture) |
| Severity | **S1 — Critical** |
| Priority | P1 — block release |
| Found by | Regression cases TC06, TC07, TC08, TC10 |
| Status | Fixed in `RL_MODE=fixed`; verified (15/15 pass) |

## Summary

When a client retries a repayment event after a lost response, RecoveryLedger applies it a second time. The loan's balance is understated by the repayment amount, and a partly paid loan can reach 0 and be accepted as `RECOVERED`.

## Steps to reproduce

Automated: `npm run test:faulty` (TC06–TC08, TC10), or start the faulty service and run `npx tsx scripts/repro.ts` ([transcript](../results/faulty/repro-transcript.txt)).

1. Escalate loan `L-DEMO`: principal ₦10,000.00, interest 0.
2. Make the next response fail after commit (`POST /__test/faults {"lose_response_next": true}`).
3. Post repayment `rep-demo`, ₦6,000.00, `sent_at 10:00:01Z` → client receives **504**.
4. Client retries `rep-demo` unchanged except `sent_at 10:00:31Z`.
5. Read the loan, the ledger, send `RECOVERED`, run reconciliation for 2026-10-05.

## Expected vs actual

| Check | Expected (rules B5, S1) | Actual (faulty) |
|---|---|---|
| Retry response | 200 `DUPLICATE` | 200 `ACCEPTED` (seq 3) |
| REPAYMENT ledger entries | 1 | **2** (same `event_id`) |
| Outstanding balance | ₦4,000.00 | **₦0** |
| Overpayment | ₦0 | **₦2,000.00** |
| `RECOVERED` resolution | 409 `BALANCE_NOT_ZERO` | **200 `ACCEPTED`** — loan closed |
| Reconciliation | 1 repayment, ₦6,000.00; no mismatches | 2 repayments, ₦12,000.00; **no mismatches flagged** |

## Severity rationale

- **Money record corrupted:** the loan's debt is understated by the full repayment amount.
- **Wrong business outcome:** recovery stops on ₦4,000.00 still owed, and a ₦2,000.00 "overpayment" may be refunded.
- **Silent:** no error, no alert. Reconciliation replays the same ledger, so it agrees with the wrong balance.
- **Common trigger:** any timeout after commit plus a standard retry.

## Root cause

`src/ledger.ts` builds the duplicate-check key from a SHA-256 hash of the **entire raw request body**. The body includes `sent_at`, which the client sets fresh on every attempt. A retry therefore always produces a new key, and is treated as a new event.

The rule (B5) is that `client_id` + `event_id` identifies an event. Transport metadata must never be part of the identity.

Second symptom, same cause: reusing an `event_id` with a different amount is accepted as a new event instead of being rejected (TC10).

**Why it escaped:** the existing duplicate check was only tested with a byte-identical resend (TC05), which the hash does catch.

## Fix

1. Key the duplicate check on `client_id + event_id`.
2. Store a fingerprint of the business fields (excluding `sent_at`) with the key. Same key + same fingerprint → `200 DUPLICATE`; same key + different fingerprint → `409 EVENT_ID_CONFLICT`.
3. In a real database, back this with a unique constraint on `(client_id, event_id)` so concurrent retries can't race past the check.
4. **Data repair:** find ledger entries sharing `(client_id, event_id)`, reverse the extras, re-run reconciliation, and give ops the list of affected loans — especially any marked `RECOVERED` or with an overpayment.

Verified: fixed build passes all 15 cases ([run log](../results/fixed/test-run.txt), [transcript](../results/fixed/repro-transcript.txt)).

## Release checks that would have blocked this

- **TC06, TC07, TC08, TC10 run in CI on every change to event intake**; any failure blocks merge.
- Release-readiness item: "Retry after a lost response is tested, not only an identical resend."
- Release-readiness item: "Duplicate identity is defined in the rules and does not include transport fields."
