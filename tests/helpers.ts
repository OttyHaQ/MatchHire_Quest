import { APIRequestContext, expect } from '@playwright/test';

export const CLIENT = 'client-a';

export type EventInput = Record<string, unknown> & { event_id: string; loan_id: string; type: string };

/** A lending-system client posting events to RecoveryLedger. */
export class LendingClient {
  constructor(private readonly api: APIRequestContext) {}

  /** Sends one attempt. Every attempt carries its own sent_at, as a real HTTP client retry would. */
  async send(event: EventInput, sentAt = new Date().toISOString()) {
    const res = await this.api.post('/events', {
      data: { client_id: CLIENT, event_time: '2026-10-05T10:00:00Z', ...event, sent_at: sentAt },
    });
    return { status: res.status(), body: await res.json() };
  }

  async escalate(loanId: string, principalNaira: number, interestNaira: number) {
    const r = await this.send({ event_id: `esc-${loanId}`, loan_id: loanId, type: 'ESCALATION', principal_naira: principalNaira, interest_naira: interestNaira });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r;
  }

  async loan(loanId: string) {
    const res = await this.api.get(`/loans/${CLIENT}/${loanId}`);
    expect(res.status()).toBe(200);
    return res.json();
  }

  async ledger(loanId: string): Promise<Array<Record<string, any>>> {
    return (await this.api.get(`/ledger?loan_id=${loanId}`)).json();
  }

  async reconcile(businessDate: string) {
    const res = await this.api.post('/jobs/reconcile', { data: { business_date: businessDate } });
    expect(res.status()).toBe(200);
    return res.json();
  }

  async injectFaults(f: { lose_response_next?: boolean; fail_projection_next?: boolean }) {
    expect((await this.api.post('/__test/faults', { data: f })).status()).toBe(200);
  }

  async reset() {
    expect((await this.api.post('/__test/reset')).status()).toBe(200);
  }
}
