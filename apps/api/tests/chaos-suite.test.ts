import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalLedgerPort } from '@codi-pey/contracts';
import { createApp } from '../src/app.js';
import { PaymentRepo } from '../src/db/payment-repo.js';
import { migrate, openDb } from '../src/db/sqlite.js';
import { drainOutbox } from '../src/jobs/outbox.js';
import { PeyClient } from '../src/pey/client.js';

const TEST_SECRET = `whsec_${Buffer.from('chaos-suite-webhook-secret-32by!', 'utf8').toString('base64')}`;

const tempDirs: string[] = [];
const openDbs: DatabaseSync[] = [];

function setupSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codi-pey-chaos-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'chaos.sqlite');
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

describe('EXEC-011 Chaos Suite (§7.7)', () => {
  it('Caos 1: timeout on POST /codi/qr transitions intent to UNCERTAIN_CREATE with exactly 1 fetch attempt', async () => {
    const { db, repo } = setupSqlite();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const peyClient = new PeyClient({
      baseUrl: 'https://sandbox.pey.invalid',
      apiKey: 'pey_chaos_test_key',
      timeoutMs: 25,
      fetchImpl,
    });

    const app = createApp(
      { peyMode: 'sandbox', peyWebhookSecret: TEST_SECRET },
      { db, repo, peyClient },
    );

    const res = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 320,
        concept: 'Consulta caos 1',
        external_ref: 'CHAOS-1',
        mode: 'qr',
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.state).toBe('UNCERTAIN_CREATE');
    expect(repo.getById(body.intent_id)?.state).toBe('UNCERTAIN_CREATE');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('Caos 2: ignores duplicate webhook-id and out-of-order processing webhook after APPLIED without regression or double ledger entry', async () => {
    const { db, repo } = setupSqlite();
    const app = createApp(
      { peyMode: 'live', peyWebhookSecret: TEST_SECRET },
      { db, repo },
    );

    const createRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 180,
        concept: 'Vacuna caos 2',
        external_ref: 'CHAOS-2',
        mode: 'qr',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const nowSec = Math.floor(Date.now() / 1000);
    const paidBody = JSON.stringify({
      event_id: 'evt_chaos2_paid',
      intent_id: created.intent_id,
      status: 'paid',
      clave_rastreo: 'CR_CHAOS_2',
      amount_mxn: 180,
    });
    const paidHeaders = makeStandardWebhookHeaders(
      'wh_chaos2_paid',
      nowSec,
      paidBody,
      TEST_SECRET,
    );

    const firstRes = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: paidHeaders,
      body: paidBody,
    });
    expect(firstRes.status).toBe(200);
    const firstJson = await firstRes.json();
    expect(firstJson.idempotent).toBe(false);
    expect(firstJson.intent.state).toBe('APPLIED');

    // Duplicate webhook-id
    const dupRes = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: paidHeaders,
      body: paidBody,
    });
    expect(dupRes.status).toBe(200);
    expect((await dupRes.json()).idempotent).toBe(true);

    // Delayed out-of-order 'processing' webhook with a fresh webhook-id
    const lateProcBody = JSON.stringify({
      event_id: 'evt_chaos2_late_proc',
      intent_id: created.intent_id,
      status: 'processing',
      clave_rastreo: 'CR_CHAOS_2_PROC',
      amount_mxn: 180,
    });
    const procRes = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: makeStandardWebhookHeaders(
        'wh_chaos2_proc',
        nowSec,
        lateProcBody,
        TEST_SECRET,
      ),
      body: lateProcBody,
    });
    expect(procRes.status).toBe(200);
    expect((await procRes.json()).intent.state).toBe('APPLIED');

    expect(repo.getById(created.intent_id)?.state).toBe('APPLIED');
    const entries = repo.listLedgerEntries(created.intent_id);
    expect(entries.filter((e) => e.to_state === 'PAID_VERIFIED')).toHaveLength(1);
    expect(entries.filter((e) => e.to_state === 'APPLIED')).toHaveLength(1);
  });

  it('Caos 3: recovers lost webhook via /api/v1/payments/codi/reconcile (PENDING_PAYMENT -> PAID_VERIFIED -> APPLIED)', async () => {
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
              transactionId: 'tx_chaos3_recovered',
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 275,
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
        amount_mxn: 275,
        concept: 'Laboratorio caos 3',
        external_ref: 'CHAOS-3',
        mode: 'qr',
      }),
    });
    const created = await createRes.json();
    expect(repo.getById(created.intent_id)?.state).toBe('PENDING_PAYMENT');

    const recRes = await app.request('/api/v1/payments/codi/reconcile', {
      method: 'POST',
    });
    expect(recRes.status).toBe(200);
    const recJson = await recRes.json();
    expect(recJson.reconcile.paidVerified).toBe(1);
    expect(recJson.outbox.applied).toBe(1);

    expect(repo.getById(created.intent_id)?.state).toBe('APPLIED');
    const states = repo.listLedgerEntries(created.intent_id).map((e) => e.to_state);
    expect(states).toEqual(['PENDING_PAYMENT', 'PAID_VERIFIED', 'APPLIED']);
  });

  it('Caos 4: holds intent in PENDING_CAJA when external register is closed and applies with same idempotencyKey once opened', async () => {
    const { db, repo } = setupSqlite();
    let cashOpen = false;
    const observedKeys: string[] = [];

    const ledgerPort: ExternalLedgerPort = {
      async apply(entry) {
        observedKeys.push(entry.idempotencyKey);
        if (!cashOpen) {
          return { status: 'pending_cash', reason: 'caja_cerrada' };
        }
        return { status: 'applied' };
      },
    };

    const app = createApp(
      { peyMode: 'live', peyWebhookSecret: TEST_SECRET },
      { db, repo, ledgerPort },
    );

    const createRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 500,
        concept: 'Cirugía menor caos 4',
        external_ref: 'CHAOS-4',
        mode: 'qr',
      }),
    });
    const created = await createRes.json();

    const nowSec = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      event_id: 'evt_chaos4_paid',
      intent_id: created.intent_id,
      status: 'paid',
      clave_rastreo: 'CR_CHAOS_4',
      amount_mxn: 500,
    });

    const whRes = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: makeStandardWebhookHeaders(
        'wh_chaos4_1',
        nowSec,
        rawBody,
        TEST_SECRET,
      ),
      body: rawBody,
    });
    expect(whRes.status).toBe(200);
    expect(repo.getById(created.intent_id)?.state).toBe('PENDING_CAJA');

    const pendingMsg = repo.getOutboxMessageByIdempotencyKey('CR_CHAOS_4')!;
    expect(pendingMsg.status).toBe('pending');

    // Open register and drain outbox once scheduled retry is due
    cashOpen = true;
    const drainRes = await drainOutbox({
      repo,
      ledger: ledgerPort,
      now: Date.parse(pendingMsg.next_attempt_at),
    });
    expect(drainRes.applied).toBe(1);
    expect(repo.getById(created.intent_id)?.state).toBe('APPLIED');
    expect(repo.getOutboxMessageByIdempotencyKey('CR_CHAOS_4')?.status).toBe('done');
    expect(observedKeys).toEqual(['CR_CHAOS_4', 'CR_CHAOS_4']);
  });

  it('Caos 5: handles Pey 503 outage safely and enforces Kill Switch 503 with manual instructions without corrupting SQLite', async () => {
    const { db, repo } = setupSqlite();
    const fetch503 = vi.fn<typeof fetch>(
      async () => new Response('Service Unavailable', { status: 503 }),
    );
    const peyClient = new PeyClient({
      baseUrl: 'https://sandbox.pey.invalid',
      apiKey: 'pey_chaos_503_key',
      fetchImpl: fetch503,
    });

    const app = createApp(
      { peyMode: 'sandbox', peyWebhookSecret: TEST_SECRET },
      { db, repo, peyClient },
    );

    const peyDownRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 150,
        concept: 'Caos 5 Pey 503',
        external_ref: 'CHAOS-5A',
        mode: 'qr',
      }),
    });
    expect(peyDownRes.status).toBe(202);
    expect((await peyDownRes.json()).state).toBe('UNCERTAIN_CREATE');
    expect(fetch503).toHaveBeenCalledTimes(1);

    const beforeCount = repo.listIntentViews().length;

    await app.request('/api/v1/config/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    const killRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 150,
        concept: 'Caos 5 Kill Switch',
        external_ref: 'CHAOS-5B',
        mode: 'qr',
      }),
    });
    expect(killRes.status).toBe(503);
    const killJson = await killRes.json();
    expect(killJson.error).toBe('CODI_DISABLED');
    expect(killJson.message).toMatch(/cobro manual/i);
    expect(repo.listIntentViews().length).toBe(beforeCount);
  });

  it('Caos 6: retries transient external ledger failures 3x with identical idempotencyKey and survives 5x concurrent webhook deliveries', async () => {
    const { db, repo, dbPath } = setupSqlite();
    let ledgerCalls = 0;
    const observedKeys: string[] = [];

    const ledgerPort: ExternalLedgerPort = {
      async apply(entry) {
        ledgerCalls += 1;
        observedKeys.push(entry.idempotencyKey);
        if (ledgerCalls <= 2) {
          throw new Error(`ECONNRESET transient error #${ledgerCalls}`);
        }
        return { status: 'applied' };
      },
    };

    const app = createApp(
      { peyMode: 'live', peyWebhookSecret: TEST_SECRET },
      { db, repo, ledgerPort },
    );

    const createRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 640,
        concept: 'Hospitalización caos 6',
        external_ref: 'CHAOS-6',
        mode: 'qr',
      }),
    });
    const created = await createRes.json();

    const nowSec = Math.floor(Date.now() / 1000);
    const rawBody = JSON.stringify({
      event_id: 'evt_chaos6_paid',
      intent_id: created.intent_id,
      status: 'paid',
      clave_rastreo: 'CR_CHAOS_6',
      amount_mxn: 640,
    });
    const headers = makeStandardWebhookHeaders(
      'wh_chaos6_1',
      nowSec,
      rawBody,
      TEST_SECRET,
    );

    // 5x concurrent webhook deliveries against SQLite WAL
    const concurrentApps = Array.from({ length: 5 }, (_, idx) => {
      if (idx === 0) return app;
      const conn = openDb(dbPath);
      openDbs.push(conn);
      return createApp(
        { peyMode: 'live', peyWebhookSecret: TEST_SECRET },
        { db: conn, repo: new PaymentRepo(conn), ledgerPort },
      );
    });

    const responses = await Promise.all(
      concurrentApps.map((instance) =>
        instance.request('/api/v1/webhooks/pey', {
          method: 'POST',
          headers,
          body: rawBody,
        }),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const payloads = await Promise.all(responses.map((r) => r.json()));
    expect(payloads.filter((p) => p.idempotent === false)).toHaveLength(1);
    expect(payloads.filter((p) => p.idempotent === true)).toHaveLength(4);

    // Attempt 1 failed inside webhook drainOutbox -> retry 2 fails -> retry 3 succeeds
    let msg = repo.getOutboxMessageByIdempotencyKey('CR_CHAOS_6')!;
    expect(msg.status).toBe('pending');
    expect(msg.attempts).toBe(1);

    const r2 = await drainOutbox({
      repo,
      ledger: ledgerPort,
      now: Date.parse(msg.next_attempt_at),
    });
    expect(r2.retried).toBe(1);
    msg = repo.getOutboxMessageByIdempotencyKey('CR_CHAOS_6')!;
    expect(msg.attempts).toBe(2);

    const r3 = await drainOutbox({
      repo,
      ledger: ledgerPort,
      now: Date.parse(msg.next_attempt_at),
    });
    expect(r3.applied).toBe(1);

    expect(observedKeys).toEqual(['CR_CHAOS_6', 'CR_CHAOS_6', 'CR_CHAOS_6']);
    expect(repo.getById(created.intent_id)?.state).toBe('APPLIED');
    expect(
      repo.listLedgerEntries(created.intent_id).filter((e) => e.to_state === 'APPLIED'),
    ).toHaveLength(1);
  });
});
