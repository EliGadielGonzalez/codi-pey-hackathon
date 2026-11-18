import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExternalLedgerPort, LedgerEntry } from '@codi-pey/contracts';
import { PaymentRepo } from '../src/db/payment-repo.js';
import { migrate, openDb } from '../src/db/sqlite.js';
import {
  computeBackoffDelayMs,
  drainOutbox,
  sanitizeOutboxError,
} from '../src/jobs/outbox.js';

const tempDirs: string[] = [];
const openDbs: DatabaseSync[] = [];

function setupRepo(): PaymentRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codi-pey-outbox-'));
  tempDirs.push(dir);
  const db = openDb(path.join(dir, 'outbox.sqlite'));
  openDbs.push(db);
  migrate(db);
  return new PaymentRepo(db);
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

function seedPaidVerified(
  repo: PaymentRepo,
  intentId: string,
  providerTxId: string,
  nowIso = '2026-11-18T00:00:00.000Z',
): LedgerEntry {
  repo.createIntent({
    id: intentId,
    state: 'PENDING_PAYMENT',
    amountCents: 35_000,
    expectedBankAccountId: '01TESTBANKACCOUNT0000',
    clientReferenceId: `cref_${intentId}`,
    mode: 'qr',
    createdAt: nowIso,
    expiresAt: '2026-11-18T00:15:00.000Z',
  });

  const entry: LedgerEntry = {
    idempotencyKey: providerTxId,
    intentId,
    amountCents: 35_000,
    method: 'CODI',
    providerTxId,
    accountRef: '01TESTBANKACCOUNT0000',
    paidAtIso: nowIso,
  };

  repo.markPaidVerified(intentId, providerTxId, entry, { nowIso });
  return entry;
}

describe('computeBackoffDelayMs and sanitizeOutboxError', () => {
  it('computes pure exponential backoff with upper cap', () => {
    expect(computeBackoffDelayMs(1, { baseDelayMs: 1_000, maxDelayMs: 10_000 })).toBe(
      1_000,
    );
    expect(computeBackoffDelayMs(2, { baseDelayMs: 1_000, maxDelayMs: 10_000 })).toBe(
      2_000,
    );
    expect(computeBackoffDelayMs(3, { baseDelayMs: 1_000, maxDelayMs: 10_000 })).toBe(
      4_000,
    );
    expect(computeBackoffDelayMs(4, { baseDelayMs: 1_000, maxDelayMs: 10_000 })).toBe(
      8_000,
    );
    expect(computeBackoffDelayMs(5, { baseDelayMs: 1_000, maxDelayMs: 10_000 })).toBe(
      10_000,
    );
    expect(computeBackoffDelayMs(20, { baseDelayMs: 1_000, maxDelayMs: 10_000 })).toBe(
      10_000,
    );
  });

  it('scrubs authorization headers, bearer tokens, and api keys from last_error', () => {
    const raw = new Error(
      '503 upstream failed; Authorization: Bearer super_secret_jwt_123 x-api-key: key_abc token=tok_xyz',
    );
    const cleaned = sanitizeOutboxError(raw);
    expect(cleaned).not.toContain('super_secret_jwt_123');
    expect(cleaned).not.toContain('key_abc');
    expect(cleaned).not.toContain('tok_xyz');
    expect(cleaned).toContain('[REDACTED]');
  });
});

describe('drainOutbox', () => {
  it('retries 3 transport failures then applies on 4th attempt using the exact same idempotencyKey', async () => {
    const repo = setupRepo();
    seedPaidVerified(repo, 'int_retry_ok', 'tx_retry_key_1', '2026-11-18T00:00:00.000Z');

    const observedKeys: string[] = [];
    let callCount = 0;

    const ledger: ExternalLedgerPort = {
      async apply(entry) {
        observedKeys.push(entry.idempotencyKey);
        callCount += 1;
        if (callCount <= 3) {
          throw new Error(
            `Transport timeout #${callCount} with Bearer secret_bearer_token_999`,
          );
        }
        return { status: 'applied' };
      },
    };

    const backoffOptions = { baseDelayMs: 1_000, maxDelayMs: 60_000 };
    let nowMs = Date.parse('2026-11-18T00:00:00.000Z');

    // Attempt 1 fails -> next_attempt_at = +1_000ms
    const r1 = await drainOutbox({ repo, ledger, now: nowMs, backoffOptions });
    expect(r1.retried).toBe(1);
    let msg = repo.getOutboxMessageByIdempotencyKey('tx_retry_key_1')!;
    expect(msg.status).toBe('pending');
    expect(msg.attempts).toBe(1);
    expect(msg.last_error).not.toContain('secret_bearer_token_999');

    // Before backoff expires -> 0 due messages
    const tooEarly = await drainOutbox({
      repo,
      ledger,
      now: nowMs + 500,
      backoffOptions,
    });
    expect(tooEarly.processed).toBe(0);

    // Attempt 2 fails -> next_attempt_at = +2_000ms
    nowMs = Date.parse(msg.next_attempt_at);
    const r2 = await drainOutbox({ repo, ledger, now: nowMs, backoffOptions });
    expect(r2.retried).toBe(1);
    msg = repo.getOutboxMessageByIdempotencyKey('tx_retry_key_1')!;
    expect(msg.attempts).toBe(2);

    // Attempt 3 fails -> next_attempt_at = +4_000ms
    nowMs = Date.parse(msg.next_attempt_at);
    const r3 = await drainOutbox({ repo, ledger, now: nowMs, backoffOptions });
    expect(r3.retried).toBe(1);
    msg = repo.getOutboxMessageByIdempotencyKey('tx_retry_key_1')!;
    expect(msg.attempts).toBe(3);

    // Attempt 4 succeeds
    nowMs = Date.parse(msg.next_attempt_at);
    const r4 = await drainOutbox({ repo, ledger, now: nowMs, backoffOptions });
    expect(r4.applied).toBe(1);

    expect(observedKeys).toEqual([
      'tx_retry_key_1',
      'tx_retry_key_1',
      'tx_retry_key_1',
      'tx_retry_key_1',
    ]);
    expect(repo.getById('int_retry_ok')?.state).toBe('APPLIED');
    const finalMsg = repo.getOutboxMessageByIdempotencyKey('tx_retry_key_1')!;
    expect(finalMsg.status).toBe('done');
    expect(finalMsg.last_error).toBeNull();
  });

  it('handles duplicate status as APPLIED and done', async () => {
    const repo = setupRepo();
    const t0 = '2026-11-18T00:00:00.000Z';
    seedPaidVerified(repo, 'int_dup_apply', 'tx_dup_apply_1', t0);

    const ledger: ExternalLedgerPort = {
      async apply() {
        return { status: 'duplicate' };
      },
    };

    const res = await drainOutbox({ repo, ledger, now: t0 });
    expect(res.applied).toBe(1);
    expect(repo.getById('int_dup_apply')?.state).toBe('APPLIED');
    expect(repo.getOutboxMessageByIdempotencyKey('tx_dup_apply_1')?.status).toBe('done');
  });

  it('moves rejected entries to MANUAL_REVIEW and marks message done', async () => {
    const repo = setupRepo();
    const t0 = '2026-11-18T00:00:00.000Z';
    seedPaidVerified(repo, 'int_rejected', 'tx_rejected_1', t0);

    const ledger: ExternalLedgerPort = {
      async apply() {
        return { status: 'rejected', reason: 'account_closed' };
      },
    };

    const res = await drainOutbox({ repo, ledger, now: t0 });
    expect(res.rejected).toBe(1);
    expect(repo.getById('int_rejected')?.state).toBe('MANUAL_REVIEW');
    expect(repo.getById('int_rejected')?.review_reason).toBe('account_closed');
    expect(repo.getOutboxMessageByIdempotencyKey('tx_rejected_1')?.status).toBe('done');
  });

  it('transitions to PENDING_CAJA on pending_cash, keeps message pending for later retry, and eventually applies', async () => {
    const repo = setupRepo();
    const t0Ms = Date.parse('2026-11-18T00:00:00.000Z');
    seedPaidVerified(
      repo,
      'int_cash',
      'tx_cash_1',
      new Date(t0Ms).toISOString(),
    );

    let step = 0;
    const ledger: ExternalLedgerPort = {
      async apply() {
        step += 1;
        if (step <= 2) {
          return { status: 'pending_cash', reason: 'register_closed' };
        }
        return { status: 'applied' };
      },
    };

    const r1 = await drainOutbox({
      repo,
      ledger,
      now: t0Ms,
      pendingCashRetryMs: 30_000,
    });
    expect(r1.pendingCash).toBe(1);
    expect(repo.getById('int_cash')?.state).toBe('PENDING_CAJA');
    expect(repo.getOutboxMessageByIdempotencyKey('tx_cash_1')?.status).toBe('pending');

    // Second cycle still pending_cash -> stays PENDING_CAJA without transition error
    const r2 = await drainOutbox({
      repo,
      ledger,
      now: t0Ms + 30_000,
      pendingCashRetryMs: 30_000,
    });
    expect(r2.pendingCash).toBe(1);
    expect(repo.getById('int_cash')?.state).toBe('PENDING_CAJA');

    // Third cycle applied -> PENDING_CAJA -> APPLIED
    const r3 = await drainOutbox({
      repo,
      ledger,
      now: t0Ms + 60_000,
      pendingCashRetryMs: 30_000,
    });
    expect(r3.applied).toBe(1);
    expect(repo.getById('int_cash')?.state).toBe('APPLIED');
    expect(repo.getOutboxMessageByIdempotencyKey('tx_cash_1')?.status).toBe('done');
  });

  it('marks message dead and moves intent to MANUAL_REVIEW when maxAttempts is reached', async () => {
    const repo = setupRepo();
    let nowMs = Date.parse('2026-11-18T00:00:00.000Z');
    seedPaidVerified(
      repo,
      'int_dead',
      'tx_dead_1',
      new Date(nowMs).toISOString(),
    );

    const ledger: ExternalLedgerPort = {
      async apply() {
        throw new Error('ECONNREFUSED');
      },
    };

    const backoffOptions = { baseDelayMs: 500, maxDelayMs: 5_000 };

    // Attempt 1 & 2 -> pending
    await drainOutbox({ repo, ledger, now: nowMs, maxAttempts: 3, backoffOptions });
    nowMs = Date.parse(repo.getOutboxMessageByIdempotencyKey('tx_dead_1')!.next_attempt_at);
    await drainOutbox({ repo, ledger, now: nowMs, maxAttempts: 3, backoffOptions });
    expect(repo.getOutboxMessageByIdempotencyKey('tx_dead_1')?.status).toBe('pending');

    // Attempt 3 hits maxAttempts=3 -> dead + MANUAL_REVIEW
    nowMs = Date.parse(repo.getOutboxMessageByIdempotencyKey('tx_dead_1')!.next_attempt_at);
    const r3 = await drainOutbox({
      repo,
      ledger,
      now: nowMs,
      maxAttempts: 3,
      backoffOptions,
    });
    expect(r3.dead).toBe(1);

    const msg = repo.getOutboxMessageByIdempotencyKey('tx_dead_1')!;
    expect(msg.status).toBe('dead');
    expect(msg.attempts).toBe(3);
    expect(repo.getById('int_dead')?.state).toBe('MANUAL_REVIEW');
    expect(repo.getById('int_dead')?.review_reason).toBe('outbox_max_attempts_exceeded');
  });
});
