import { createHash } from 'node:crypto';
import { parseEventTime, watBusinessDate } from './time';

// ---------------------------------------------------------------------------
// RecoveryLedger — a fictional recovery system that receives loan events from
// lending systems ("clients") and keeps the outstanding balance of every
// defaulted loan. All amounts in the API are naira with at most 2 decimal
// places (whole kobo). Internally, balances are kept as integer kobo so that
// arithmetic is exact; values are converted to naira at the API boundary.
//
// RL_MODE=faulty reproduces the defect under test: the duplicate check keys on
// a hash of the whole request body, which includes the per-attempt `sent_at`
// transport timestamp. A client retry carries a new `sent_at`, so it is not
// recognised as a duplicate and the repayment is applied twice.
// RL_MODE=fixed keys the duplicate check on client_id + event_id (the rule).
// ---------------------------------------------------------------------------

export type Mode = 'faulty' | 'fixed';
export type EventType = 'ESCALATION' | 'REPAYMENT' | 'INTEREST' | 'RESOLUTION';
export type LoanStatus = 'IN_RECOVERY' | 'RECOVERED' | 'WRITTEN_OFF';

export interface IncomingEvent {
  client_id: string;
  event_id: string;
  loan_id: string;
  type: EventType;
  event_time: string;
  sent_at?: string; // set by the client on every send attempt
  principal_naira?: number; // ESCALATION
  interest_naira?: number; // ESCALATION
  amount_naira?: number; // REPAYMENT, INTEREST
  resolution?: 'RECOVERED' | 'WRITTEN_OFF'; // RESOLUTION
}

/** Internal balance record, in integer kobo. Exposed through the API as LoanView (naira). */
export interface Loan {
  client_id: string;
  loan_id: string;
  status: LoanStatus;
  principal_outstanding_kobo: number;
  interest_outstanding_kobo: number;
  total_outstanding_kobo: number;
  total_repaid_kobo: number;
  overpayment_kobo: number;
  written_off_kobo: number;
}

export interface LoanView {
  client_id: string;
  loan_id: string;
  status: LoanStatus;
  principal_outstanding_naira: number;
  interest_outstanding_naira: number;
  total_outstanding_naira: number;
  total_repaid_naira: number;
  overpayment_naira: number;
  written_off_naira: number;
}

/** Naira → integer kobo. Only call on values that passed isNairaAmount. */
export const toKobo = (naira: number) => Math.round(naira * 100);
/** Integer kobo → naira (exact to 2 decimal places). */
export const toNaira = (kobo: number) => kobo / 100;
export const formatNaira = (kobo: number) =>
  `₦${toNaira(kobo).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function loanView(l: Loan): LoanView {
  return {
    client_id: l.client_id,
    loan_id: l.loan_id,
    status: l.status,
    principal_outstanding_naira: toNaira(l.principal_outstanding_kobo),
    interest_outstanding_naira: toNaira(l.interest_outstanding_kobo),
    total_outstanding_naira: toNaira(l.total_outstanding_kobo),
    total_repaid_naira: toNaira(l.total_repaid_kobo),
    overpayment_naira: toNaira(l.overpayment_kobo),
    written_off_naira: toNaira(l.written_off_kobo),
  };
}

export interface LedgerEntry {
  seq: number;
  client_id: string;
  event_id: string;
  loan_id: string;
  type: EventType;
  event_time: string;
  business_date: string; // WAT date of event_time
  received_at: string;
  payload_fingerprint: string; // hash of the business fields (sent_at excluded)
  event: IncomingEvent;
}

export interface Outcome {
  http: number;
  body: Record<string, unknown>;
}

export class Faults {
  /** Commit the event, then answer 504 as if the response was lost in transit. */
  loseResponseNext = false;
  /** Commit the event to the ledger, then fail the balance (projection) update. */
  failProjectionNext = false;
}

const loanKey = (clientId: string, loanId: string) => `${clientId}:${loanId}`;

function businessFingerprint(e: IncomingEvent): string {
  const { sent_at: _ignored, ...business } = e;
  return createHash('sha256').update(JSON.stringify(business, Object.keys(business).sort())).digest('hex');
}

function rawRequestFingerprint(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** A naira amount with at most 2 decimal places (i.e. a whole number of kobo). */
function isNairaAmount(n: unknown): n is number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  const kobo = n * 100;
  return Math.abs(kobo - Math.round(kobo)) < 1e-6;
}
function isPositiveNaira(n: unknown): n is number {
  return isNairaAmount(n) && n > 0;
}
function isNonNegativeNaira(n: unknown): n is number {
  return isNairaAmount(n) && n >= 0;
}

/** Applies one accepted ledger entry to a loan. Shared by live processing and the reconciliation replay. */
export function applyEntry(loans: Map<string, Loan>, entry: LedgerEntry): void {
  const e = entry.event;
  const key = loanKey(e.client_id, e.loan_id);
  if (e.type === 'ESCALATION') {
    const p = toKobo(e.principal_naira ?? 0);
    const i = toKobo(e.interest_naira ?? 0);
    loans.set(key, {
      client_id: e.client_id,
      loan_id: e.loan_id,
      status: 'IN_RECOVERY',
      principal_outstanding_kobo: p,
      interest_outstanding_kobo: i,
      total_outstanding_kobo: p + i,
      total_repaid_kobo: 0,
      overpayment_kobo: 0,
      written_off_kobo: 0,
    });
    return;
  }
  const loan = loans.get(key);
  if (!loan) return; // validated before commit; cannot happen for accepted entries
  if (e.type === 'REPAYMENT') {
    const amount = toKobo(e.amount_naira!);
    let remaining = amount;
    const toInterest = Math.min(remaining, loan.interest_outstanding_kobo); // interest first
    loan.interest_outstanding_kobo -= toInterest;
    remaining -= toInterest;
    const toPrincipal = Math.min(remaining, loan.principal_outstanding_kobo);
    loan.principal_outstanding_kobo -= toPrincipal;
    remaining -= toPrincipal;
    loan.overpayment_kobo += remaining; // balance floors at 0; excess is recorded
    loan.total_repaid_kobo += amount;
  } else if (e.type === 'INTEREST') {
    loan.interest_outstanding_kobo += toKobo(e.amount_naira!);
  } else if (e.type === 'RESOLUTION') {
    if (e.resolution === 'WRITTEN_OFF') {
      loan.written_off_kobo = loan.principal_outstanding_kobo + loan.interest_outstanding_kobo;
      loan.status = 'WRITTEN_OFF';
    } else {
      loan.status = 'RECOVERED';
    }
  }
  loan.total_outstanding_kobo = loan.principal_outstanding_kobo + loan.interest_outstanding_kobo;
}

export class RecoveryLedger {
  readonly ledger: LedgerEntry[] = [];
  readonly loans = new Map<string, Loan>(); // stored balances (the projection)
  readonly rejections: Array<{ at: string; code: string; event: unknown }> = [];
  private readonly seenKeys = new Map<string, string>(); // dedupe key -> business fingerprint
  readonly faults = new Faults();

  constructor(readonly mode: Mode) {}

  private reject(http: number, code: string, message: string, event: unknown): Outcome {
    this.rejections.push({ at: new Date().toISOString(), code, event });
    return { http, body: { status: 'REJECTED', code, message } };
  }

  /** Validates, de-duplicates, commits to the ledger, then updates the stored balance. */
  receive(rawBody: string): Outcome {
    let e: IncomingEvent;
    try {
      e = JSON.parse(rawBody);
    } catch {
      return this.reject(400, 'INVALID_JSON', 'Body is not valid JSON', rawBody);
    }

    // --- shape validation ---
    for (const f of ['client_id', 'event_id', 'loan_id', 'type'] as const) {
      if (typeof e?.[f] !== 'string' || e[f] === '') return this.reject(400, 'MISSING_FIELD', `${f} is required`, e);
    }
    const eventTime = parseEventTime(e.event_time);
    if (!eventTime) return this.reject(400, 'INVALID_EVENT_TIME', 'event_time must be ISO 8601 with a zone', e);
    if (!['ESCALATION', 'REPAYMENT', 'INTEREST', 'RESOLUTION'].includes(e.type))
      return this.reject(400, 'UNKNOWN_TYPE', `Unknown event type ${e.type}`, e);
    if (e.type === 'ESCALATION' && !(isNonNegativeNaira(e.principal_naira) && isNonNegativeNaira(e.interest_naira) && e.principal_naira + e.interest_naira > 0))
      return this.reject(400, 'INVALID_AMOUNT', 'principal_naira and interest_naira must be naira with at most 2 decimal places, total > 0', e);
    if ((e.type === 'REPAYMENT' || e.type === 'INTEREST') && !isPositiveNaira(e.amount_naira))
      return this.reject(400, 'INVALID_AMOUNT', 'amount_naira must be a positive naira amount with at most 2 decimal places', e);
    if (e.type === 'RESOLUTION' && e.resolution !== 'RECOVERED' && e.resolution !== 'WRITTEN_OFF')
      return this.reject(400, 'INVALID_RESOLUTION', 'resolution must be RECOVERED or WRITTEN_OFF', e);

    // --- duplicate check ---
    const fingerprint = businessFingerprint(e);
    const dedupeKey =
      this.mode === 'faulty'
        ? rawRequestFingerprint(rawBody) // DEFECT: includes sent_at, which changes on every retry
        : `${e.client_id}:${e.event_id}`; // RULE: client_id + event_id identifies an event
    const seen = this.seenKeys.get(dedupeKey);
    if (seen !== undefined) {
      if (seen !== fingerprint) {
        return this.reject(409, 'EVENT_ID_CONFLICT', 'event_id already used with different business data', e);
      }
      return { http: 200, body: { status: 'DUPLICATE', message: 'Already processed; no change made' } };
    }

    // --- business validation against current state ---
    const key = loanKey(e.client_id, e.loan_id);
    const loan = this.loans.get(key);
    if (e.type === 'ESCALATION') {
      if (loan?.status === 'IN_RECOVERY') return this.reject(409, 'LOAN_ALREADY_IN_RECOVERY', 'Loan is already in recovery', e);
      if (loan) return this.reject(409, 'LOAN_RESOLVED', 'Loan is already resolved', e);
    } else {
      if (!loan) return this.reject(404, 'LOAN_NOT_FOUND', 'Loan has not been escalated', e);
      if (loan.status !== 'IN_RECOVERY') return this.reject(409, 'LOAN_RESOLVED', `Loan is ${loan.status}; no further events accepted`, e);
      if (e.type === 'RESOLUTION' && e.resolution === 'RECOVERED' && loan.total_outstanding_kobo !== 0)
        return this.reject(409, 'BALANCE_NOT_ZERO', `Cannot mark RECOVERED with ${formatNaira(loan.total_outstanding_kobo)} outstanding`, e);
    }

    // --- commit: the ledger is the source of truth ---
    const entry: LedgerEntry = {
      seq: this.ledger.length + 1,
      client_id: e.client_id,
      event_id: e.event_id,
      loan_id: e.loan_id,
      type: e.type,
      event_time: eventTime.toISOString(),
      business_date: watBusinessDate(eventTime),
      received_at: new Date().toISOString(),
      payload_fingerprint: fingerprint,
      event: e,
    };
    this.ledger.push(entry);
    this.seenKeys.set(dedupeKey, fingerprint);

    // --- update stored balance (may fail independently of the commit) ---
    let projectionPending = false;
    try {
      if (this.faults.failProjectionNext) {
        this.faults.failProjectionNext = false;
        throw new Error('Injected fault: balance update failed after ledger commit');
      }
      applyEntry(this.loans, entry);
    } catch {
      projectionPending = true; // reconciliation will repair the stored balance
    }

    if (this.faults.loseResponseNext) {
      this.faults.loseResponseNext = false;
      return { http: 504, body: { status: 'GATEWAY_TIMEOUT', message: 'Injected fault: response lost after commit' } };
    }
    return {
      http: 200,
      body: { status: 'ACCEPTED', seq: entry.seq, business_date: entry.business_date, ...(projectionPending ? { warning: 'BALANCE_UPDATE_PENDING' } : {}) },
    };
  }

  /**
   * Daily reconciliation. Replays the whole ledger to recompute every balance,
   * compares with the stored balance, corrects mismatches and reports them.
   * Also summarises the events whose WAT business date equals `businessDate`.
   */
  reconcile(businessDate: string) {
    const replayed = new Map<string, Loan>();
    for (const entry of this.ledger) applyEntry(replayed, entry);

    const mismatches: Array<{ loan: string; stored_outstanding_naira: number | null; ledger_outstanding_naira: number }> = [];
    for (const [key, truth] of replayed) {
      const stored = this.loans.get(key);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(truth)) {
        mismatches.push({
          loan: key,
          stored_outstanding_naira: stored ? toNaira(stored.total_outstanding_kobo) : null,
          ledger_outstanding_naira: toNaira(truth.total_outstanding_kobo),
        });
        this.loans.set(key, structuredClone(truth));
      }
    }

    const dayEntries = this.ledger.filter((x) => x.business_date === businessDate);
    const repayments = dayEntries.filter((x) => x.type === 'REPAYMENT');
    return {
      business_date: businessDate,
      loans_checked: replayed.size,
      mismatches_corrected: mismatches,
      day_summary: {
        events: dayEntries.length,
        repayment_count: repayments.length,
        repayment_total_naira: toNaira(repayments.reduce((s, x) => s + toKobo(x.event.amount_naira ?? 0), 0)),
        repayment_event_ids: repayments.map((x) => `${x.client_id}:${x.event_id}`),
      },
    };
  }
}
