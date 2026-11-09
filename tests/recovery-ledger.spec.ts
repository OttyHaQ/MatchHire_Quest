import { test, expect } from '@playwright/test';
import { LendingClient } from './helpers';

// Amounts are naira with at most 2 decimal places. 50_000 = ₦50,000.00.
// Business day = WAT (UTC+1). 23:59:59 WAT on 5 Oct = 2026-10-05T22:59:59Z.

let client: LendingClient;

test.beforeEach(async ({ request }) => {
  client = new LendingClient(request);
  await client.reset();
});

test.describe('Happy path and allocation', () => {
  test('TC01 escalate → full repayment → RECOVERED is accepted', async () => {
    await client.escalate('L-001', 50_000, 5_000);
    const pay = await client.send({ event_id: 'rep-001', loan_id: 'L-001', type: 'REPAYMENT', amount_naira: 55_000 });
    expect(pay.body.status).toBe('ACCEPTED');

    const res = await client.send({ event_id: 'res-001', loan_id: 'L-001', type: 'RESOLUTION', resolution: 'RECOVERED' });
    expect(res.status).toBe(200);

    const loan = await client.loan('L-001');
    expect(loan).toMatchObject({ status: 'RECOVERED', total_outstanding_naira: 0, total_repaid_naira: 55_000, overpayment_naira: 0 });
  });

  test('TC02 repayment clears interest first; interest posting adds to interest', async () => {
    await client.escalate('L-002', 50_000, 5_000);
    await client.send({ event_id: 'rep-002', loan_id: 'L-002', type: 'REPAYMENT', amount_naira: 3_000 });
    expect(await client.loan('L-002')).toMatchObject({ interest_outstanding_naira: 2_000, principal_outstanding_naira: 50_000 });

    await client.send({ event_id: 'int-002', loan_id: 'L-002', type: 'INTEREST', amount_naira: 500 });
    expect(await client.loan('L-002')).toMatchObject({ interest_outstanding_naira: 2_500, total_outstanding_naira: 52_500 });
  });
});

test.describe('Cut-off and time zone', () => {
  test('TC03 cut-off: 23:59:59 WAT belongs to that day, 00:00:00 WAT to the next', async () => {
    await client.escalate('L-003', 50_000, 0);
    const before = await client.send({ event_id: 'rep-003a', loan_id: 'L-003', type: 'REPAYMENT', amount_naira: 1_000, event_time: '2026-10-05T22:59:59Z' });
    const after = await client.send({ event_id: 'rep-003b', loan_id: 'L-003', type: 'REPAYMENT', amount_naira: 1_000, event_time: '2026-10-05T23:00:00Z' });
    expect(before.body.business_date).toBe('2026-10-05');
    expect(after.body.business_date).toBe('2026-10-06');

    const day = await client.reconcile('2026-10-05');
    expect(day.day_summary.repayment_event_ids).toEqual(['client-a:rep-003a']);
  });

  test('TC04 time-zone conversion: a WAT-offset timestamp maps to the right WAT day; zone-less is rejected', async () => {
    await client.escalate('L-004', 50_000, 0);
    // 00:30 WAT on 6 Oct is 23:30 UTC on 5 Oct — the UTC date would put it on the wrong day.
    const r = await client.send({ event_id: 'rep-004', loan_id: 'L-004', type: 'REPAYMENT', amount_naira: 1_000, event_time: '2026-10-06T00:30:00+01:00' });
    expect(r.body.business_date).toBe('2026-10-06');
    const [, entry] = await client.ledger('L-004');
    expect(entry.event_time).toBe('2026-10-05T23:30:00.000Z');

    const noZone = await client.send({ event_id: 'rep-004b', loan_id: 'L-004', type: 'REPAYMENT', amount_naira: 1_000, event_time: '2026-10-06T00:30:00' });
    expect(noZone).toMatchObject({ status: 400, body: { code: 'INVALID_EVENT_TIME' } });
  });
});

test.describe('Duplicates and retries — selected failure', () => {
  test('TC05 byte-identical duplicate is acknowledged and changes nothing', async () => {
    await client.escalate('L-005', 50_000, 5_000);
    const sentAt = '2026-10-05T10:00:01.000Z';
    await client.send({ event_id: 'rep-005', loan_id: 'L-005', type: 'REPAYMENT', amount_naira: 6_000 }, sentAt);
    const dup = await client.send({ event_id: 'rep-005', loan_id: 'L-005', type: 'REPAYMENT', amount_naira: 6_000 }, sentAt);

    expect(dup).toMatchObject({ status: 200, body: { status: 'DUPLICATE' } });
    expect((await client.loan('L-005')).total_outstanding_naira).toBe(49_000);
  });

  test('TC06 retry after a lost response is applied once', async () => {
    await client.escalate('L-006', 50_000, 5_000);
    const event = { event_id: 'rep-006', loan_id: 'L-006', type: 'REPAYMENT', amount_naira: 6_000 };

    await client.injectFaults({ lose_response_next: true });
    const first = await client.send(event, '2026-10-05T10:00:01.000Z');
    expect(first.status).toBe(504); // committed, but the client never saw the answer

    const retry = await client.send(event, '2026-10-05T10:00:31.000Z'); // client retries 30s later
    expect(retry).toMatchObject({ status: 200, body: { status: 'DUPLICATE' } });

    const repayments = (await client.ledger('L-006')).filter((e) => e.type === 'REPAYMENT');
    expect(repayments, 'one repayment event must produce one ledger entry').toHaveLength(1);
    expect((await client.loan('L-006')).total_outstanding_naira).toBe(49_000);
  });

  test('TC07 a retried repayment cannot make an unpaid loan look recovered', async () => {
    await client.escalate('L-007', 10_000, 0);
    const event = { event_id: 'rep-007', loan_id: 'L-007', type: 'REPAYMENT', amount_naira: 6_000 };
    await client.injectFaults({ lose_response_next: true });
    await client.send(event, '2026-10-05T10:00:01.000Z');
    await client.send(event, '2026-10-05T10:00:31.000Z');

    expect(await client.loan('L-007')).toMatchObject({ total_outstanding_naira: 4_000, overpayment_naira: 0 });

    const resolve = await client.send({ event_id: 'res-007', loan_id: 'L-007', type: 'RESOLUTION', resolution: 'RECOVERED' });
    expect(resolve).toMatchObject({ status: 409, body: { code: 'BALANCE_NOT_ZERO' } });
    expect((await client.loan('L-007')).status).toBe('IN_RECOVERY');
  });

  test('TC08 daily reconciliation reports one repayment after a retry', async () => {
    await client.escalate('L-008', 50_000, 0);
    const event = { event_id: 'rep-008', loan_id: 'L-008', type: 'REPAYMENT', amount_naira: 6_000, event_time: '2026-10-05T12:00:00Z' };
    await client.injectFaults({ lose_response_next: true });
    await client.send(event, '2026-10-05T12:00:01.000Z');
    await client.send(event, '2026-10-05T12:00:31.000Z');

    const report = await client.reconcile('2026-10-05');
    expect(report.day_summary).toMatchObject({ repayment_count: 1, repayment_total_naira: 6_000 });
  });

  test('TC09 two different repayments of the same amount both count', async () => {
    await client.escalate('L-009', 50_000, 0);
    await client.send({ event_id: 'rep-009a', loan_id: 'L-009', type: 'REPAYMENT', amount_naira: 1_000 });
    await client.send({ event_id: 'rep-009b', loan_id: 'L-009', type: 'REPAYMENT', amount_naira: 1_000 });
    expect(await client.loan('L-009')).toMatchObject({ total_repaid_naira: 2_000, total_outstanding_naira: 48_000 });
  });

  test('TC10 reusing an event_id with a different amount is rejected', async () => {
    await client.escalate('L-010', 50_000, 0);
    await client.send({ event_id: 'rep-010', loan_id: 'L-010', type: 'REPAYMENT', amount_naira: 1_000 });
    const clash = await client.send({ event_id: 'rep-010', loan_id: 'L-010', type: 'REPAYMENT', amount_naira: 9_000 });

    expect(clash).toMatchObject({ status: 409, body: { code: 'EVENT_ID_CONFLICT' } });
    expect((await client.loan('L-010')).total_outstanding_naira).toBe(49_000);
  });
});

test.describe('Partial failure', () => {
  test('TC11 balance update fails after commit → event kept, reconciliation repairs the balance', async () => {
    await client.escalate('L-011', 50_000, 5_000);
    await client.injectFaults({ fail_projection_next: true });
    const r = await client.send({ event_id: 'rep-011', loan_id: 'L-011', type: 'REPAYMENT', amount_naira: 3_000 });
    expect(r).toMatchObject({ status: 200, body: { status: 'ACCEPTED', warning: 'BALANCE_UPDATE_PENDING' } });
    expect((await client.loan('L-011')).total_outstanding_naira).toBe(55_000); // stale until reconciliation
    expect((await client.ledger('L-011')).filter((e) => e.type === 'REPAYMENT')).toHaveLength(1);

    const report = await client.reconcile('2026-10-05');
    expect(report.mismatches_corrected).toEqual([{ loan: 'client-a:L-011', stored_outstanding_naira: 55_000, ledger_outstanding_naira: 52_000 }]);
    expect((await client.loan('L-011')).total_outstanding_naira).toBe(52_000);
  });
});

test.describe('Guards', () => {
  test('TC12 overpayment floors the balance at 0 and records the excess', async () => {
    await client.escalate('L-012', 10_000, 1_000);
    await client.send({ event_id: 'rep-012', loan_id: 'L-012', type: 'REPAYMENT', amount_naira: 12_000 });
    expect(await client.loan('L-012')).toMatchObject({ total_outstanding_naira: 0, overpayment_naira: 1_000 });
  });

  test('TC13 unknown loan and second escalation are rejected', async () => {
    const unknown = await client.send({ event_id: 'rep-013', loan_id: 'L-NOPE', type: 'REPAYMENT', amount_naira: 1_000 });
    expect(unknown).toMatchObject({ status: 404, body: { code: 'LOAN_NOT_FOUND' } });

    await client.escalate('L-013', 10_000, 0);
    const again = await client.send({ event_id: 'esc-L-013-again', loan_id: 'L-013', type: 'ESCALATION', principal_naira: 10_000, interest_naira: 0 });
    expect(again).toMatchObject({ status: 409, body: { code: 'LOAN_ALREADY_IN_RECOVERY' } });
  });

  test('TC14 write-off keeps the balance as written off; resolved loans accept no more events', async () => {
    await client.escalate('L-014', 9_000, 1_000);
    await client.send({ event_id: 'res-014', loan_id: 'L-014', type: 'RESOLUTION', resolution: 'WRITTEN_OFF' });
    expect(await client.loan('L-014')).toMatchObject({ status: 'WRITTEN_OFF', written_off_naira: 10_000 });

    const interest = await client.send({ event_id: 'int-014', loan_id: 'L-014', type: 'INTEREST', amount_naira: 100 });
    const repay = await client.send({ event_id: 'rep-014', loan_id: 'L-014', type: 'REPAYMENT', amount_naira: 100 });
    expect(interest).toMatchObject({ status: 409, body: { code: 'LOAN_RESOLVED' } });
    expect(repay).toMatchObject({ status: 409, body: { code: 'LOAN_RESOLVED' } });
  });

  test('TC15 naira amounts with more than 2 decimal places are rejected', async () => {
    await client.escalate('L-015', 10_000, 0);
    const r = await client.send({ event_id: 'rep-015', loan_id: 'L-015', type: 'REPAYMENT', amount_naira: 10.005 });
    expect(r).toMatchObject({ status: 400, body: { code: 'INVALID_AMOUNT' } });

    const ok = await client.send({ event_id: 'rep-015b', loan_id: 'L-015', type: 'REPAYMENT', amount_naira: 10.5 });
    expect(ok.body.status).toBe('ACCEPTED');
    expect((await client.loan('L-015')).total_outstanding_naira).toBe(9_989.5);
  });
});
