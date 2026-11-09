# Directive — stop retried repayments from being applied twice

## Objective

Make sure a repayment event retried by a lending client is applied to a defaulted loan **exactly once**, so a partly paid loan can never be shown as fully recovered. Prove it with an automated regression check that fails against the faulty behaviour and passes after the fix.

## Scope

**In scope**
- RecoveryLedger, a fictional local loan-recovery service ([rules](docs/business-rules.md)): event intake for escalation, repayment, interest and resolution events, the stored balance, and the daily reconciliation job.
- Selected failure F1: duplicate repayment on client retry ([why](intent.md)).
- Supporting coverage: happy path, cut-off, time zone, partial failure and guards.

**Out of scope**
- Any live or real financial system, data or format.
- Persistence, concurrency across instances, authentication, and out-of-order delivery (listed as gaps).

## Requirements

1. The duplicate check identifies an event by `client_id + event_id` only (rule B5).
2. A repeat with the same business data returns `200 DUPLICATE` and changes nothing.
3. A repeat with different business data returns `409 EVENT_ID_CONFLICT`.
4. Different `event_id`s with the same amount both apply (no over-deduplication).
5. `RECOVERED` is rejected while any balance is outstanding.
6. At least eight automated cases with explicit inputs and expected outcomes, covering happy path, cut-off boundary, time-zone conversion, duplicate input, retry and partial failure.
7. The selected-failure cases fail on the faulty build and pass on the fixed build.
8. One defect report with reproduction steps, expected vs actual, severity rationale, root cause, evidence, fix and blocking release checks.
9. A release-readiness decision with remaining gaps and handoff instructions.

## Completion criteria

- [x] `npm run test:faulty` → 11 passed, 4 failed (TC06, TC07, TC08, TC10), each failing on the duplicate-retry assertion
- [x] `npm run test:fixed` → 15 passed
- [x] Reproduction transcript shows the faulty build accepting the retry and a false RECOVERED, and the fixed build rejecting both
- [x] Defect report, test-case table and release-readiness checklist written and linked below
- [x] Repository pushed and links below are publicly accessible
- [ ] Loom recorded (≤ 5 minutes) and linked below

## Appendix — results and handoff

### A. Artifacts

| Item | Link |
|---|---|
| Repository | [github.com/OttyHaQ/MatchHire_Quest](https://github.com/OttyHaQ/MatchHire_Quest) |
| Loom walkthrough | **[Loom URL]** |
| Why this problem, ranking, AI use | [intent.md](intent.md) |
| Business rules, assumptions and flow map | [docs/business-rules.md](docs/business-rules.md) |
| Test cases (15) with inputs, expected and results | [docs/test-cases.md](docs/test-cases.md) |
| Test code | [tests/recovery-ledger.spec.ts](tests/recovery-ledger.spec.ts) |
| Defect / root-cause report | [docs/defect-report.md](docs/defect-report.md) |
| Release-readiness checklist and decision | [docs/release-readiness.md](docs/release-readiness.md) |
| Faulty build — test run (4 failed) | [results/faulty/test-run.txt](results/faulty/test-run.txt) |
| Fixed build — test run (15 passed) | [results/fixed/test-run.txt](results/fixed/test-run.txt) |
| Faulty build — reproduction transcript | [results/faulty/repro-transcript.txt](results/faulty/repro-transcript.txt) |
| Fixed build — reproduction transcript | [results/fixed/repro-transcript.txt](results/fixed/repro-transcript.txt) |
| HTML reports | `results/faulty/html-report/`, `results/fixed/html-report/` (open with `npx playwright show-report <folder>`) |

### B. How to reproduce and view

Requires Node.js 20 or newer. From the project folder:

```bash
npm ci                    # install dependencies
npm run test:faulty       # faulty build: expect 11 passed, 4 failed
npm run test:fixed        # fixed build: expect 15 passed
npx playwright show-report results/faulty/html-report   # failure details in the browser
```

Step-by-step reproduction with readable output:

```bash
npm run start:faulty                             # terminal 1 (npm start for the fixed build)
npx tsx scripts/repro.ts http://localhost:4010   # terminal 2
```

`RL_MODE=faulty` reproduces the defect and `RL_MODE=fixed` applies the fix. The only behavioural difference is the duplicate-check key in `src/ledger.ts` (lines 216–218).

### C. Checks and actual results

Last run: 3 Nov 2026, Windows 11, Node.js v22.20.0, Playwright 1.63.

| Check | Expected | Actual |
|---|---|---|
| `npm run typecheck` | No errors | No errors |
| `npm run test:faulty` | 11 passed, 4 failed (TC06, TC07, TC08, TC10) | 11 passed, 4 failed: TC06, TC07, TC08, TC10 ([log](results/faulty/test-run.txt)) |
| Faulty failures fail for the right reason | Each fails on the retry being applied twice | TC06: retry `ACCEPTED`, not `DUPLICATE`. TC07: ₦0 outstanding and ₦2,000 overpayment, not ₦4,000 and ₦0. TC08: 2 repayments totalling ₦12,000, not 1 of ₦6,000. TC10: reused `event_id` with a new amount `ACCEPTED`, not `409` |
| `npm run test:fixed` | 15 passed | 15 passed ([log](results/fixed/test-run.txt)) |
| Faulty reproduction script | Retry accepted; false `RECOVERED` accepted | As expected ([transcript](results/faulty/repro-transcript.txt)) |
| Fixed reproduction script | Retry `DUPLICATE`; `RECOVERED` rejected with `409 BALANCE_NOT_ZERO` | As expected ([transcript](results/fixed/repro-transcript.txt)) |

All data is synthetic: loans, clients, event IDs and ₦ amounts are invented for this fixture.

### D. What existed before the Quest

The project was built on 3 Nov 2026, **before I accepted the Quest**, using Claude (Claude Desktop). I supplied the business rules, the failure ranking and the expected outcome of every test case. Claude generated the code (the service, the tests and the reproduction script), drafted the documents, and produced the first set of results. After that, I reviewed it and directed the changes in section E, which Claude (Claude Code) carried out.

### E. AI contribution and corrections

**Who did what:**
- **Me:** the business rules, the failure ranking, the expected outcome of every test case, the release decision, and the changes below.
- **Claude:** the code and the first drafts of the documents (section D). Claude Code then made each change below at my direction and re-ran both builds after every change.

**What I decided and corrected:**

| # | What I found or decided | Change made | How it was verified |
|---|---|---|---|
| 1 | Amounts were in kobo everywhere, which is hard to read in the docs. I chose to switch the whole project to naira, not just the docs. | API fields renamed from `*_kobo` to `*_naira`, and every test value converted. Amounts may have up to 2 decimal places; anything finer (₦10.005) is rejected. Balances are still calculated in whole kobo internally, so no rounding errors appear. Rule B1 and TC15 were rewritten. | Typecheck clean; fixed 15/15; faulty still fails the same 4 cases with the same symptoms in naira; logs, reports and transcripts regenerated. |
| 2 | I couldn't follow the flowchart in the business rules. | Rewritten in plain language, with outcomes colour-coded and the retry path shown. | Rendered and checked in light and dark themes. |
| 3 | The rewritten flowchart was still cluttered: oversized diamonds and a long looping retry arrow. | Redesigned: short questions in the diamonds, details in the outcome boxes, and the retry shown as its own starting point. | Rendered and checked again. |
| 4 | My Markdown viewer showed the chart's code instead of the chart. | Replaced with a picture ([flow-map.png](docs/diagrams/flow-map.png)). The editable source is in [flow-map.mmd](docs/diagrams/flow-map.mmd); `npx tsx scripts/render-diagram.ts` rebuilds the image. | Image checked; it displays in VS Code and on GitHub. |
| 5 | The Loom outline was too thin to record from. | Expanded into a timed recording script, kept outside the repository as private notes. | Checked against the current results and line numbers. |

### F. Limitations

- **Duplicate keys are kept in memory.** A retry that arrives after a restart would be applied again. A real system needs the keys persisted, plus a unique database constraint on `(client_id, event_id)`.
- **Concurrency is not tested.** Two identical retries arriving at the same moment could both pass the check in a multi-instance deployment.
- **Reconciliation trusts the ledger.** It cannot detect a duplicate that is already recorded.
- **Out-of-order events (F3) are not covered.** No ordering rules are defined yet.
- **The data repair is a written plan only.** There is no real data to run it on.
- **The fixture is local and fictional.** It has test-only fault-injection endpoints (`/__test/*`) and has never been run against a live or real financial system.

Full list with next steps: [Release readiness → Remaining gaps](docs/release-readiness.md#remaining-gaps).

### G. Effort

| Phase | Hours |
|---|---|
| Generating the initial project with Claude Desktop | **[ ]** |
| Reviewing the project and directing changes | **[ ]** |
| Documentation, Loom and career video | **[ ]** |
| **Total** | **[ ]** |

### H. Handoff

- **Run it:** see section B.
- **Keep in CI:** TC06–TC10 must gate any change to event intake or reconciliation. `npm test` exits non-zero on any failure.
- **Ops:** before release, find existing duplicate `(client_id, event_id)` entries, reverse the extras, and review affected loans, especially any marked RECOVERED or with an overpayment ([defect report → Fix](docs/defect-report.md#fix)).
- **Engineering:** close the limitations above, starting with persisted keys and the unique constraint.

More detail: [Release readiness → Handoff](docs/release-readiness.md#handoff).
