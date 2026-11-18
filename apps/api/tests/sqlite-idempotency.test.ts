import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@codi-pey/contracts';
import { PaymentRepo } from '../src/db/payment-repo.js';
import { migrate, openDb } from '../src/db/sqlite.js';
import { InvalidTransitionError } from '../src/domain/state-machine.js';
import { REDACTION_MARKER } from '../src/privacy/allowlist.js';
import { verifyWebhookOnce } from '../src/webhooks/verify.js';

const tempDirs: string[] = [];
const openDbs: DatabaseSync[] = [];

function createTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codi-pey-sqlite-'));
  tempDirs.push(dir);
  return path.join(dir, 'payments.sqlite');
}

function trackDb(db: DatabaseSync): DatabaseSync {
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop()!;
    if (db.isOpen) {
      db.close();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeLedgerEntry(
  intentId: string,
  providerTxId: string,
  amountCents = 15_000,
): LedgerEntry {
  return {
    idempotencyKey: providerTxId,
    intentId,
    amountCents,
    method: 'CODI',
    providerTxId,
    accountRef: '01TESTBANKACCOUNT0000',
    paidAtIso: '2026-11-18T00:05:00.000Z',
  };
}

describe('sqlite idempotency, concurrency, append-only ledger, and atomic outbox', () => {
  it('handles 5 distinct DatabaseSync connections registering the same webhook_id concurrently with 1 true, 4 false, and 0 SQLITE_BUSY', async () => {
    const dbPath = createTempDbPath();
    const bootstrapDb = trackDb(openDb(dbPath));
    migrate(bootstrapDb);
    // Calling migrate a second time verifies idempotency.
    migrate(bootstrapDb);
    bootstrapDb.close();

    const repos = Array.from({ length: 5 }, () => {
      const conn = trackDb(openDb(dbPath));
      return new PaymentRepo(conn);
    });

    const rawPayload = {
      id: 'evt_concurrent_1',
      status: 'paid',
      amount: 150,
      bankAccountId: '01TESTBANKACCOUNT1234',
      customerPhone: '5512345678',
      metadata: { secretNote: 'must_be_redacted' },
    };

    const results = await Promise.all(
      repos.map(async (repo, idx) => {
        await Promise.resolve();
        return repo.registerWebhookOnce(
          `wh_concurrent_001`,
          { ...rawPayload, worker: idx },
          '2026-11-18T00:00:00.000Z',
        );
      }),
    );

    const trueCount = results.filter((r) => r === true).length;
    const falseCount = results.filter((r) => r === false).length;
    expect(trueCount).toBe(1);
    expect(falseCount).toBe(4);

    const verifyDb = trackDb(openDb(dbPath));
    const stored = verifyDb
      .prepare('SELECT webhook_id, payload_redacted_json FROM webhook_events WHERE webhook_id = ?')
      .get('wh_concurrent_001') as { webhook_id: string; payload_redacted_json: string };

    expect(stored.webhook_id).toBe('wh_concurrent_001');
    const parsed = JSON.parse(stored.payload_redacted_json) as Record<string, unknown>;
    expect(parsed.bankAccountId).toBe('****1234');
    expect(parsed.customerPhone).toBe(REDACTION_MARKER);
    expect(parsed.metadata).toBe(REDACTION_MARKER);
    expect(stored.payload_redacted_json).not.toContain('5512345678');
    expect(stored.payload_redacted_json).not.toContain('must_be_redacted');
  });

  it('integrates PaymentRepo as DedupeStore with verifyWebhookOnce', () => {
    const dbPath = createTempDbPath();
    const db = trackDb(openDb(dbPath));
    migrate(db);
    const repo = new PaymentRepo(db);

    const secret = `whsec_${Buffer.from('test-webhook-secret-32-bytes-key!', 'utf8').toString('base64')}`;
    const rawBody = '{"id":"evt_1","status":"paid"}';
    const ts = '1700000000';
    const sig = createHmac('sha256', Buffer.from('test-webhook-secret-32-bytes-key!', 'utf8'))
      .update(`msg_dedupe_1.${ts}.${rawBody}`, 'utf8')
      .digest('base64');

    const options = {
      rawBody,
      secret,
      now: 1700000000,
      headers: {
        'webhook-id': 'msg_dedupe_1',
        'webhook-timestamp': ts,
        'webhook-signature': `v1,${sig}`,
      },
    };

    expect(verifyWebhookOnce(options, repo)).toEqual({
      ok: true,
      webhookId: 'msg_dedupe_1',
    });
    expect(verifyWebhookOnce(options, repo)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('enforces append-only ledger_entries via SQLite BEFORE UPDATE and BEFORE DELETE triggers', () => {
    const dbPath = createTempDbPath();
    const db = trackDb(openDb(dbPath));
    migrate(db);
    const repo = new PaymentRepo(db);

    repo.createIntent({
      id: 'int_ledger_1',
      state: 'PENDING_PAYMENT',
      amountCents: 25_000,
      expectedBankAccountId: '01TESTBANKACCOUNT0000',
      clientReferenceId: 'cref_1',
      mode: 'qr',
      createdAt: '2026-11-18T00:00:00.000Z',
      expiresAt: '2026-11-18T00:15:00.000Z',
    });

    const entries = repo.listLedgerEntries('int_ledger_1');
    expect(entries).toHaveLength(1);

    expect(() =>
      db
        .prepare('UPDATE ledger_entries SET amount_cents = 1 WHERE id = ?')
        .run(entries[0].id),
    ).toThrow(/ledger append-only/);

    expect(() =>
      db
        .prepare('DELETE FROM ledger_entries WHERE id = ?')
        .run(entries[0].id),
    ).toThrow(/ledger append-only/);
  });

  it('rolls back markPaidVerified atomically when outbox enqueue fails', () => {
    const dbPath = createTempDbPath();
    const db = trackDb(openDb(dbPath));
    migrate(db);
    const repo = new PaymentRepo(db);

    repo.createIntent({
      id: 'int_atomic_1',
      state: 'PENDING_PAYMENT',
      amountCents: 19_900,
      expectedBankAccountId: '01TESTBANKACCOUNT0000',
      clientReferenceId: 'cref_atomic_1',
      mode: 'qr',
      createdAt: '2026-11-18T00:00:00.000Z',
      expiresAt: '2026-11-18T00:15:00.000Z',
    });

    // Simulate a database-level failure when inserting into outbox_messages.
    db.exec(`
      CREATE TRIGGER trg_test_fail_outbox
      BEFORE INSERT ON outbox_messages
      BEGIN
        SELECT RAISE(ABORT, 'simulated outbox failure');
      END;
    `);

    expect(() =>
      repo.markPaidVerified(
        'int_atomic_1',
        'tx_atomic_001',
        makeLedgerEntry('int_atomic_1', 'tx_atomic_001', 19_900),
      ),
    ).toThrow(/simulated outbox failure/);

    const after = repo.getById('int_atomic_1')!;
    expect(after.state).toBe('PENDING_PAYMENT');
    expect(after.provider_tx_id).toBeNull();
    expect(repo.listLedgerEntries('int_atomic_1')).toHaveLength(1);
    expect(repo.getOutboxMessageByIdempotencyKey('tx_atomic_001')).toBeUndefined();
  });

  it('treats duplicate enqueueOutbox with the same idempotencyKey as a silent no-op', () => {
    const dbPath = createTempDbPath();
    const db = trackDb(openDb(dbPath));
    migrate(db);
    const repo = new PaymentRepo(db);

    repo.createIntent({
      id: 'int_outbox_dup_1',
      state: 'PENDING_PAYMENT',
      amountCents: 10_000,
      expectedBankAccountId: '01TESTBANKACCOUNT0000',
      clientReferenceId: 'cref_dup_1',
      mode: 'qr',
      createdAt: '2026-11-18T00:00:00.000Z',
      expiresAt: '2026-11-18T00:15:00.000Z',
    });

    const entry = makeLedgerEntry('int_outbox_dup_1', 'tx_dup_key_1', 10_000);
    expect(repo.enqueueOutbox('int_outbox_dup_1', entry, '2026-11-18T00:05:00.000Z')).toBe(
      true,
    );
    expect(repo.enqueueOutbox('int_outbox_dup_1', entry, '2026-11-18T00:06:00.000Z')).toBe(
      false,
    );

    const rows = db
      .prepare('SELECT * FROM outbox_messages WHERE idempotency_key = ?')
      .all('tx_dup_key_1');
    expect(rows).toHaveLength(1);
  });

  it('rejects invalid transition inside BEGIN IMMEDIATE without partial writes', () => {
    const dbPath = createTempDbPath();
    const db = trackDb(openDb(dbPath));
    migrate(db);
    const repo = new PaymentRepo(db);

    repo.createIntent({
      id: 'int_bad_tx_1',
      state: 'PENDING_PAYMENT',
      amountCents: 12_000,
      expectedBankAccountId: '01TESTBANKACCOUNT0000',
      clientReferenceId: 'cref_bad_1',
      mode: 'qr',
      createdAt: '2026-11-18T00:00:00.000Z',
      expiresAt: '2026-11-18T00:15:00.000Z',
    });

    expect(() =>
      repo.transition('int_bad_tx_1', 'APPLIED', { actor: 'test' }),
    ).toThrow(InvalidTransitionError);

    expect(repo.getById('int_bad_tx_1')?.state).toBe('PENDING_PAYMENT');
    expect(repo.listLedgerEntries('int_bad_tx_1')).toHaveLength(1);
  });
});
