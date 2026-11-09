# RecoveryLedger Quest — duplicate repayment on client retry

A QA assessment project. RecoveryLedger is a **fictional** loan-recovery service: lending systems send it escalation, repayment, interest and resolution events, and it keeps the balance of every defaulted loan. The selected failure: **a repayment retried after a lost response is applied twice**, which can make an unpaid loan look recovered.

Start with [directive.md](directive.md) (objective, scope, completion criteria, links to all evidence) and [intent.md](intent.md) (why this problem).

## Run it

Requires Node.js 20+.

```bash
npm ci
npm run test:faulty   # reproduces the defect: 11 passed, 4 failed
npm run test:fixed    # after the fix: 15 passed
npx playwright show-report results/fixed/html-report
```

Step-by-step reproduction with readable output:

```bash
npm run start:faulty                             # terminal 1 (use npm start for the fixed build)
npx tsx scripts/repro.ts http://localhost:4010   # terminal 2
```

`RL_MODE=faulty` reproduces the defect; `RL_MODE=fixed` (the default) applies the fix. The only behavioural difference is the duplicate-check key in `src/ledger.ts`.

## Layout

| Path | What |
|---|---|
| `src/` | The service: rules engine (`ledger.ts`), WAT time handling (`time.ts`), HTTP API (`server.ts`) |
| `tests/` | Playwright API tests (15 cases) |
| `scripts/repro.ts` | Scripted reproduction of DEF-001 |
| `scripts/render-diagram.ts` | Rebuilds the flow-map image from its source (`npx tsx scripts/render-diagram.ts`; needs internet access) |
| `docs/` | Rules, test cases, defect report, release readiness |
| `docs/diagrams/` | Flow map: `flow-map.png` (shown in the business rules) and its editable source `flow-map.mmd` |
| `results/` | Saved test runs, HTML reports and reproduction transcripts for both builds |

`/__test/*` endpoints exist only to inject faults in this local fixture.
