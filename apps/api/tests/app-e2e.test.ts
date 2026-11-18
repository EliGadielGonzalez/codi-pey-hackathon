import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PaymentRepo } from '../src/db/payment-repo.js';
import { migrate, openDb } from '../src/db/sqlite.js';

const TEST_SECRET = `whsec_${Buffer.from('e2e-strong-webhook-secret-32byte!', 'utf8').toString('base64')}`;

const tempDirs: string[] = [];
const openDbs: DatabaseSync[] = [];

function setupSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codi-pey-e2e-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'e2e.sqlite');
  const db = openDb(dbPath);
  openDbs.push(db);
  migrate(db);
  const repo = new PaymentRepo(db);
  return { db, repo, dbPath };
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop()!;
    if (db.isOpen) db.close();
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeStandardWebhookHeaders(
  webhookId: string,
  timestampSec: number,
  rawBody: string,
  secret: string,
): Record<string, string> {
  const key = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
  const sig = createHmac('sha256', key)
    .update(`${webhookId}.${timestampSec}.${rawBody}`, 'utf8')
    .digest('base64');
  return {
    'Content-Type': 'application/json',
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestampSec),
    'webhook-signature': `v1,${sig}`,
  };
}

describe('App E2E (SQLite + Kill Switch + Onboarding + Suscripción + Manual Review + CSV)', () => {
  it('enforces kill switch (503 when disabled) and allows reactivation', async () => {
    const { db, repo } = setupSqlite();
    const app = createApp(
      { peyMode: 'mock', peyWebhookSecret: TEST_SECRET },
      { db, repo },
    );

    const initial = await app.request('/api/v1/config/kill-switch');
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ enabled: true });

    const disableRes = await app.request('/api/v1/config/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disableRes.status).toBe(200);
    expect((await disableRes.json()).enabled).toBe(false);

    const blockedRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 300,
        concept: 'Consulta',
        external_ref: 'ORD-KILL-1',
        mode: 'qr',
      }),
    });
    expect(blockedRes.status).toBe(503);
    const blockedJson = await blockedRes.json();
    expect(blockedJson.error).toBe('CODI_DISABLED');
    expect(blockedJson.manual_fallback_recommended).toBe(true);

    const enableRes = await app.request('/api/v1/config/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enableRes.status).toBe(200);

    const allowedRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 300,
        concept: 'Consulta',
        external_ref: 'ORD-KILL-2',
        mode: 'qr',
      }),
    });
    expect(allowedRes.status).toBe(201);
  });

  it('registers masked bank account, rejects plaintext 18-digit CLABE, and simulates Banxico states', async () => {
    const { db, repo } = setupSqlite();
    const app = createApp(
      { peyMode: 'mock', peyWebhookSecret: TEST_SECRET },
      { db, repo },
    );

    const rejectRes = await app.request('/api/v1/onboarding/bank-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clabeLast4: '8998',
        alias: 'Cuenta Clínica',
        holderName: 'Clínica Demo',
        clabeTokenOrEnvRef: '1'.repeat(18),
      }),
    });
    expect(rejectRes.status).toBe(400);
    expect((await rejectRes.json()).error).toBe('CLABE_PLAINTEXT_FORBIDDEN');

    const createRes = await app.request('/api/v1/onboarding/bank-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clabeLast4: '8998',
        alias: 'Cuenta Principal',
        holderName: 'Clínica Demo S.A.',
        initialStatus: 'BORRADOR',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.account.clabe_masked).toBe('****8998');
    expect(created.account.codi_status).toBe('BORRADOR');

    const accountId = created.account.bank_account_id;
    for (const nextStatus of ['PENDING', 'PROCESSING', 'ACTIVE'] as const) {
      const simRes = await app.request(
        `/api/v1/onboarding/bank-account/${accountId}/simulate-status`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      expect(simRes.status).toBe(200);
      expect((await simRes.json()).account.codi_status).toBe(nextStatus);
    }

    const getRes = await app.request('/api/v1/onboarding/bank-account');
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.account.codi_status).toBe('ACTIVE');
    expect(fetched.banxico_sla_business_days).toBe(5);
  });

  it('creates Ring 1 SaaS subscription checkout with Pey Payment Link', async () => {
    const { db, repo } = setupSqlite();
    const app = createApp(
      { peyMode: 'mock', peyWebhookSecret: TEST_SECRET },
      { db, repo },
    );

    const res = await app.request('/api/v1/subscriptions/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: 'mensual',
        mode: 'payment_link',
        clinic_name: 'Clínica Demo',
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.checkout_url).toBe('https://app.pey.mx/p/gadypo');
    expect(json.amount_mxn).toBe(990);
    expect(json.intent.kind).toBe('subscription');
    expect(json.intent.payment_link_url).toBe('https://app.pey.mx/p/gadypo');
  });

  it('routes mismatched webhook amounts to MANUAL_REVIEW and resolves APPLY, REFUND_MANUAL, and CANCEL with audit notes', async () => {
    const { db, repo } = setupSqlite();
    const app = createApp(
      { peyMode: 'mock', peyWebhookSecret: TEST_SECRET },
      { db, repo },
    );

    const createIntent = async (ref: string) => {
      const r = await app.request('/api/v1/payments/codi/intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount_mxn: 200,
          concept: 'Estudio',
          external_ref: ref,
          mode: 'qr',
        }),
      });
      return r.json();
    };

    const i1 = await createIntent('MR-1');
    const i2 = await createIntent('MR-2');
    const i3 = await createIntent('MR-3');

    const nowSec = Math.floor(Date.now() / 1000);
    for (const [idx, intent] of [i1, i2, i3].entries()) {
      const rawBody = JSON.stringify({
        event_id: `evt_mismatch_${idx}`,
        intent_id: intent.intent_id,
        status: 'paid',
        clave_rastreo: `CR_MISMATCH_${idx}`,
        amount_mxn: 150, // mismatch vs 200
      });
      const res = await app.request('/api/v1/webhooks/pey', {
        method: 'POST',
        headers: makeStandardWebhookHeaders(
          `wh_mr_${idx}`,
          nowSec,
          rawBody,
          TEST_SECRET,
        ),
        body: rawBody,
      });
      expect(res.status).toBe(200);
    }

    const listRes = await app.request('/api/v1/payments/codi/manual-review');
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    expect(listJson.items).toHaveLength(3);

    const rApply = await app.request(
      `/api/v1/payments/codi/manual-review/${i1.intent_id}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'APPLY', note: 'Diferencia cubierta en caja' }),
      },
    );
    expect(rApply.status).toBe(200);
    expect((await rApply.json()).intent.state).toBe('APPLIED');

    const rRefund = await app.request(
      `/api/v1/payments/codi/manual-review/${i2.intent_id}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'REFUND_MANUAL', note: 'Devuelto por transferencia' }),
      },
    );
    expect(rRefund.status).toBe(200);
    expect((await rRefund.json()).intent.state).toBe('REFUNDED_MANUAL');

    const rCancel = await app.request(
      `/api/v1/payments/codi/manual-review/${i3.intent_id}/resolve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'CANCEL', note: 'Cobro duplicado cancelado' }),
      },
    );
    expect(rCancel.status).toBe(200);
    expect((await rCancel.json()).intent.state).toBe('CANCELLED');

    const ledgerEntries = repo.listLedgerEntries(i1.intent_id);
    expect(ledgerEntries.some((e) => e.event === 'MANUAL_REVIEW_APPLY')).toBe(true);
  });

  it('triggers reconcileOnce + drainOutbox on demand and exports sanitized CSV', async () => {
    const { db, repo } = setupSqlite();
    const app = createApp(
      { peyMode: 'mock', peyWebhookSecret: TEST_SECRET },
      {
        db,
        repo,
        fetchPeyStatus: async (intent) => ({
          id: intent.id,
          status: 'paid',
          transactions: [
            {
              transactionId: `tx_rec_${intent.id}`,
              status: 'paid',
              paymentMethod: 'CODI',
              amount: intent.amount_cents / 100,
              bankAccountId: intent.expected_bank_account_id,
            },
          ],
        }),
      },
    );

    const createRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 450,
        concept: 'Rayos X',
        external_ref: 'ORD-REC-1',
        mode: 'request_to_pay',
        customer_phone: '5512345678',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const recRes = await app.request('/api/v1/payments/codi/reconcile', {
      method: 'POST',
    });
    expect(recRes.status).toBe(200);
    const recJson = await recRes.json();
    expect(recJson.reconcile.paidVerified).toBe(1);
    expect(recJson.outbox.applied).toBe(1);

    const fetchedRes = await app.request(
      `/api/v1/payments/codi/intents/${created.intent_id}`,
    );
    const fetched = await fetchedRes.json();
    expect(fetched.state).toBe('APPLIED');
    expect(fetched.status).toBe('paid');

    const csvRes = await app.request('/api/v1/payments/codi/export.csv');
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('content-type')).toContain('text/csv');
    const csvText = await csvRes.text();
    expect(csvText).toContain('intent_id,kind,state,status,amount_mxn');
    expect(csvText).toContain(created.intent_id);
    expect(csvText).toContain('APPLIED');
    expect(csvText).not.toContain('5512345678');
  });

  it('rejects insecure webhook secret in live mode and enforces Standard Webhooks in live mode', async () => {
    expect(() =>
      createApp({
        peyMode: 'live',
        peyWebhookSecret: 'dev-only-webhook-secret',
      }),
    ).toThrow();

    const { db, repo } = setupSqlite();
    const liveApp = createApp(
      { peyMode: 'live', peyWebhookSecret: TEST_SECRET },
      { db, repo },
    );

    const createRes = await liveApp.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 120,
        concept: 'Vacuna',
        external_ref: 'ORD-LIVE-1',
        mode: 'qr',
      }),
    });
    const created = await createRes.json();

    const rawBody = JSON.stringify({
      event_id: 'evt_live_1',
      intent_id: created.intent_id,
      status: 'paid',
      clave_rastreo: 'CODILIVE001',
      amount_mxn: 120,
    });

    // Legacy x-pey-signature must be rejected in live mode
    const legacyAttempt = await liveApp.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pey-signature': 'sha256=deadbeef',
      },
      body: rawBody,
    });
    expect(legacyAttempt.status).toBe(401);

    // Valid Standard Webhooks passes and replay returns idempotent: true
    const nowSec = Math.floor(Date.now() / 1000);
    const headers = makeStandardWebhookHeaders(
      'wh_live_1',
      nowSec,
      rawBody,
      TEST_SECRET,
    );
    const first = await liveApp.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers,
      body: rawBody,
    });
    expect(first.status).toBe(200);
    expect((await first.json()).idempotent).toBe(false);

    const replay = await liveApp.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers,
      body: rawBody,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).idempotent).toBe(true);
  });
});
