# Intent — why this problem

## The flow I chose

RecoveryLedger is a **fictional** loan-recovery service. Lending systems send it events (escalation, repayment, interest, resolution), and it keeps the balance of every defaulted loan. Its rules are written out in [docs/business-rules.md](docs/business-rules.md). It is not a description of any real system, and no real data, names or formats are used.

This is a settlement flow: every repayment event changes the recorded balance of real debt, and that balance decides whether recovery continues or stops.

**Why not the suggested rewards service:** the brief allows "an equally concrete business flow with explicit rules". I chose loan recovery because it's the domain I work in, so I can judge whether the rules and failures are realistic. The risk under test is the same as in the brief's example, where retries must not create a second payout: here, a retry must not apply a repayment twice.

## Affected users

| Who | How F1 hurts them |
|---|---|
| **Lenders** (the lending systems' owners) | Their recorded debt is understated, and a loan can be closed as RECOVERED while money is still owed. That money is then never collected. |
| **Recovery and collections teams** | They stop working an account that still has a balance, because the system says it is paid. |
| **Operations and finance** | They may refund an "overpayment" that never happened, and the daily reconciliation report gives them no warning. |
| **Borrowers** | When the error is found later, the balance is corrected upwards and recovery restarts on a loan they were told was settled. |

## Candidate failures, ranked

I have no incident data for this fictional system, so the scores below are my judgement, based on how event intake and client retries usually behave. The reasoning is stated so it can be challenged.

**Scoring:** each criterion is scored 1–5, where 5 is worst impact, most likely, or easiest to reproduce and guard. Impact counts double, because a money error that reaches a business decision matters more than one that's merely likely. **Score = 2 × Impact + Likelihood + Ease** (maximum 20).

| # | Failure | Impact | Likelihood | Ease | **Score** |
|---|---|---|---|---|---|
| **F1** | **A retried repayment is applied twice.** The client times out after the service has saved the event, retries the same `event_id`, and the duplicate check misses it. | **5** — the balance is understated; a partly paid loan can show ₦0 and be marked RECOVERED; a false overpayment may be refunded. It's silent: reconciliation replays the same wrong ledger and agrees. | **4** — timeouts after a save are routine, and any client retry policy triggers this path. | **4** — needs one injected lost response and one retry. | **18** |
| F2 | Business day bucketed by UTC instead of WAT. | **3** — daily totals and reports are wrong for events between 00:00 and 00:59 WAT, but balances stay right. | **3** — affects one hour of every day. | **5** — boundary timestamps only. | **14** |
| F4 | Balance update fails after the event is saved. | **3** — the stored balance is stale until the nightly job, so a borrower may be chased for up to a day for money already paid. | **2** — rare. | **5** — one injected fault. | **13** |
| F3 | Events arrive out of order (a repayment before the interest it should cover). | **3** — the interest/principal split is wrong, but the total is right. | **2** — depends on client delivery guarantees, which are unknown. | **2** — needs ordering rules that aren't defined yet. | **10** |

**Uncertainty:** the likelihood scores are estimates, not measurements. If real data showed retries after a lost response were very rare, F1 would score 16 and still rank first, because its impact score alone outweighs the others.

## Why F1

- **It has the highest impact.** It corrupts the money record itself, and the decision to stop recovery follows from that.
- **It is silent.** It passes the obvious duplicate test (an identical resend) and it survives reconciliation, because reconciliation trusts the ledger. Nothing else in the system would catch it, so a regression test is the only guard.
- **It is common.** It needs no unusual input: one slow response and a standard retry.

F2 and F4 are still covered by tests (TC03, TC04, TC11) because they share the same fixture. F3 is recorded as a remaining gap in [docs/release-readiness.md](docs/release-readiness.md).

## Evidence

- **No incident history.** RecoveryLedger is fictional, so there are no real incidents, tickets or users. None are claimed.
- **What the evidence is:** a reproduction of the failure in the fixture. The faulty build fails 4 regression tests (TC06, TC07, TC08, TC10), and the reproduction script shows a ₦6,000 repayment counted twice and a loan with ₦4,000 still owed accepted as RECOVERED ([test log](results/faulty/test-run.txt), [transcript](results/faulty/repro-transcript.txt)). The fixed build passes all 15 tests.
- **Untested assumption:** that lending clients retry on timeout with the same `event_id` (rule P4). This is common retry behaviour, but it hasn't been checked against any real client.

All loans, clients, event IDs and amounts are synthetic.

## Intended value

- **A written identity rule** (B5: an event is its `client_id` + `event_id`) that developers and testers can point to.
- **A regression gate:** four tests that fail if a retry can ever be applied twice, run on every change to event intake.
- **A decision-level safeguard:** a loan can't be marked RECOVERED while money is owed, even if a duplicate slips through some other way.
- **A repair plan** for duplicates that may already be in the ledger ([defect report → Fix](docs/defect-report.md#fix)).

These are intended outcomes. None of them has been measured on a real system.

## Non-goals

- Testing any live or real financial system, data or format.
- Persistence, restarts, and concurrent retries across several instances (recorded as gaps).
- Out-of-order event delivery (F3).
- Authentication, a user interface, and notifications.
- Crypto wallets or token flows.

## How I used AI, and what I owned

The project was built with Claude (Claude Desktop) before I accepted the Quest. Details are in the [directive appendix, sections D and E](directive.md#appendix--results-and-handoff).

- **I owned:** the business flow and rules (from my loan-recovery experience), the choice and ranking of failures, the expected outcome of every test case, and the release decision in [docs/release-readiness.md](docs/release-readiness.md).
- **AI (Claude) did:** generated the code (the service, the Playwright tests and the reproduction script) and drafted the documents from my rules, ranking and expected values. Later it made each change I asked for and re-ran both builds after every change.
- **I directed:** the changes listed in [directive section E](directive.md#e-ai-contribution-and-corrections). That includes switching every amount from kobo to naira, and rejecting the flowchart twice until it was readable.
- **I checked:** that the faulty build fails exactly TC06, TC07, TC08 and TC10, each because the retry is applied twice (read from the assertion output, not the pass count), and that the fixed build passes all 15.
