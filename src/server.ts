import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { loanView, Mode, RecoveryLedger } from './ledger';

const mode = (process.env.RL_MODE ?? 'fixed') as Mode;
if (mode !== 'faulty' && mode !== 'fixed') {
  console.error(`RL_MODE must be "faulty" or "fixed", got "${mode}"`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 4010);
let svc = new RecoveryLedger(mode);

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const path = url.pathname;
  try {
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, mode });

    // Client-facing event intake
    if (req.method === 'POST' && path === '/events') {
      const out = svc.receive(await readBody(req));
      return send(res, out.http, out.body);
    }

    // Read models
    const loanMatch = path.match(/^\/loans\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && loanMatch) {
      const loan = svc.loans.get(`${decodeURIComponent(loanMatch[1])}:${decodeURIComponent(loanMatch[2])}`);
      return loan ? send(res, 200, loanView(loan)) : send(res, 404, { code: 'LOAN_NOT_FOUND' });
    }
    if (req.method === 'GET' && path === '/ledger') {
      const loanId = url.searchParams.get('loan_id');
      return send(res, 200, svc.ledger.filter((e) => !loanId || e.loan_id === loanId));
    }

    // Daily reconciliation job (triggered manually here; scheduled at 02:00 WAT in the rules)
    if (req.method === 'POST' && path === '/jobs/reconcile') {
      const { business_date } = JSON.parse((await readBody(req)) || '{}');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(business_date ?? '')) return send(res, 400, { code: 'INVALID_BUSINESS_DATE' });
      return send(res, 200, svc.reconcile(business_date));
    }

    // Test-only controls — local fixture, never present in a real system
    if (req.method === 'POST' && path === '/__test/reset') {
      svc = new RecoveryLedger(mode);
      return send(res, 200, { ok: true, mode });
    }
    if (req.method === 'POST' && path === '/__test/faults') {
      const f = JSON.parse((await readBody(req)) || '{}');
      svc.faults.loseResponseNext = Boolean(f.lose_response_next);
      svc.faults.failProjectionNext = Boolean(f.fail_projection_next);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { code: 'NOT_FOUND' });
  } catch (err) {
    send(res, 500, { code: 'INTERNAL', message: (err as Error).message });
  }
}).listen(port, () => console.log(`RecoveryLedger listening on :${port} (RL_MODE=${mode})`));
