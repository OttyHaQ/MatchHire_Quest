// Step-by-step reproduction of DEF-001 against a running RecoveryLedger.
// Usage: start the service (RL_MODE=faulty or fixed), then
//   npx tsx scripts/repro.ts http://localhost:4010
const base = process.argv[2] ?? 'http://localhost:4010';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}\n  → ${res.status} ${JSON.stringify(json)}\n`);
  return json;
}

(async () => {
  const health = await call('GET', '/health');
  console.log(`=== DEF-001 reproduction (RL_MODE=${health.mode}) ===\n`);
  await call('POST', '/__test/reset');

  const base = { client_id: 'client-a', loan_id: 'L-DEMO' };
  console.log('1. Escalate a defaulted loan: ₦10,000.00 principal, no interest');
  await call('POST', '/events', { ...base, event_id: 'esc-demo', type: 'ESCALATION', event_time: '2026-10-05T09:00:00Z', sent_at: '2026-10-05T09:00:00Z', principal_naira: 10_000, interest_naira: 0 });

  console.log('2. Simulate a lost response: the next event is committed but the client receives 504');
  await call('POST', '/__test/faults', { lose_response_next: true });

  const repayment = { ...base, event_id: 'rep-demo', type: 'REPAYMENT', event_time: '2026-10-05T10:00:00Z', amount_naira: 6_000 };
  console.log('3. Client posts a ₦6,000.00 repayment');
  await call('POST', '/events', { ...repayment, sent_at: '2026-10-05T10:00:01Z' });

  console.log('4. Client retries the SAME event_id 30s later (new sent_at, as its HTTP retry policy does)');
  await call('POST', '/events', { ...repayment, sent_at: '2026-10-05T10:00:31Z' });

  console.log('5. Stored loan balance — expected ₦4,000.00 outstanding');
  await call('GET', '/loans/client-a/L-DEMO');

  console.log('6. Ledger entries for the loan — expected 1 REPAYMENT');
  const ledger = await call('GET', '/ledger?loan_id=L-DEMO');
  console.log(`   REPAYMENT entries: ${ledger.filter((e: any) => e.type === 'REPAYMENT').length}\n`);

  console.log('7. Lender sends RECOVERED — expected 409 BALANCE_NOT_ZERO');
  await call('POST', '/events', { ...base, event_id: 'res-demo', type: 'RESOLUTION', resolution: 'RECOVERED', event_time: '2026-10-05T11:00:00Z', sent_at: '2026-10-05T11:00:00Z' });

  console.log('8. Daily reconciliation for 2026-10-05 — expected 1 repayment, ₦6,000.00, no mismatches');
  await call('POST', '/jobs/reconcile', { business_date: '2026-10-05' });
})();
