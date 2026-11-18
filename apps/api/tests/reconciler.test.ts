import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeyVerifyPayload } from '@codi-pey/contracts';
import { PaymentRepo, type PaymentIntentRecord } from '../src/db/payment-repo.js';
import { migrate, openDb } from '../src/db/sqlite.js';
import type { PaymentIntentState } from '../src/domain/state-machine.js';
import { reconcileOnce } from '../src/jobs/reconciler.js';

const tempDirs: string[] = [];
const openDbs: DatabaseSync[] = [];

function setupRepo(): PaymentRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codi-pey-reconciler-'));
  tempDirs.push(dir);
  const db = openDb(path.join(dir, 'reconciler.sqlite'));
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

function seedIntent(
  repo: PaymentRepo,
  id: string,
  state: PaymentIntentState,
  overrides: Partial<{ amountCents: number; expiresAt: string }> = {},
): PaymentIntentRecord {
  return repo.createIntent({
    id,
    state,
    amountCents: overrides.amountCents ?? 25_000, // 250.00 MXN
    expectedBankAccountId: '01TESTBANKACCOUNT0000',
    clientReferenceId: `cref_${id}`,
    mode: 'qr',
    createdAt: '2026-11-18T00:00:00.000Z',
    expiresAt: overrides.expiresAt ?? '2026-11-18T00:15:00.000Z',
  });
}

describe('reconcileOnce', () => {
  const activeNow = '2026-11-18T00:05:00.000Z';
  const expiredNow = '2026-11-18T00:20:00.000Z';

  it('transitions PENDING_PAYMENT and UNCERTAIN_CREATE to PAID_VERIFIED with outbox entry when paid and verified', async () => {
    const repo = setupRepo();
    seedIntent(repo, 'int_pending_ok', 'PENDING_PAYMENT');
    seedIntent(repo, 'int_uncertain_ok', 'UNCERTAIN_CREATE');

    const payloads = new Map<string, PeyVerifyPayload>([
      [
        'int_pending_ok',
        {
          id: 'res_1',
          status: 'paid',
          transactions: [
            {
              transactionId: 'tx_pey_001',
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 250,
              bankAccountId: '01TESTBANKACCOUNT0000',
              datePaid: '2026-11-18T00:04:00.000Z',
            },
          ],
        },
      ],
      [
        'int_uncertain_ok',
        {
          id: 'res_2',
          status: 'paid',
          transactions: [
            {
              transactionId: 'tx_pey_002',
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 250,
              bankAccountId: '01TESTBANKACCOUNT0000',
              datePaid: '2026-11-18T00:04:30.000Z',
            },
          ],
        },
      ],
    ]);

    const summary = await reconcileOnce({
      repo,
      now: activeNow,
      fetchStatus: async (intent) => payloads.get(intent.id),
    });

    expect(summary).toEqual({
      checked: 2,
      paidVerified: 2,
      manualReview: 0,
      expired: 0,
      latePayments: 0,
      unchanged: 0,
      fetchErrors: 0,
    });

    const p = repo.getById('int_pending_ok')!;
    expect(p.state).toBe('PAID_VERIFIED');
    expect(p.provider_tx_id).toBe('tx_pey_001');
    expect(repo.getOutboxMessageByIdempotencyKey('tx_pey_001')?.status).toBe('pending');

    const u = repo.getById('int_uncertain_ok')!;
    expect(u.state).toBe('PAID_VERIFIED');
    expect(u.provider_tx_id).toBe('tx_pey_002');
    expect(repo.getOutboxMessageByIdempotencyKey('tx_pey_002')?.status).toBe('pending');
  });

  it('routes paid payloads failing C2 verifyPaid checks to MANUAL_REVIEW with exact review_reason', async () => {
    const repo = setupRepo();
    seedIntent(repo, 'int_amt', 'PENDING_PAYMENT');
    seedIntent(repo, 'int_method', 'PENDING_PAYMENT');
    seedIntent(repo, 'int_acct', 'PENDING_PAYMENT');
    seedIntent(repo, 'int_txcount', 'UNCERTAIN_CREATE');

    const payloads = new Map<string, PeyVerifyPayload>([
      [
        'int_amt',
        {
          status: 'paid',
          transactions: [
            {
              transactionId: 'tx_bad_amt',
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 249, // mismatch vs 250
              bankAccountId: '01TESTBANKACCOUNT0000',
            },
          ],
        },
      ],
      [
        'int_method',
        {
          status: 'paid',
          transactions: [
            {
              transactionId: 'tx_bad_method',
              status: 'paid',
              paymentMethod: 'CARD',
              amount: 250,
              bankAccountId: '01TESTBANKACCOUNT0000',
            },
          ],
        },
      ],
      [
        'int_acct',
        {
          status: 'paid',
          transactions: [
            {
              transactionId: 'tx_bad_acct',
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 250,
              bankAccountId: '99OTHERBANKACCOUNT999',
            },
          ],
        },
      ],
      [
        'int_txcount',
        {
          status: 'paid',
          transactions: [
            {
              transactionId: 'tx_1',
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 125,
              bankAccountId: '01TESTBANKACCOUNT0000',
            },
            {
              transactionId: 'tx_2',
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 125,
              bankAccountId: '01TESTBANKACCOUNT0000',
            },
          ],
        },
      ],
    ]);

    const summary = await reconcileOnce({
      repo,
      now: activeNow,
      fetchStatus: async (intent) => payloads.get(intent.id),
    });

    expect(summary.manualReview).toBe(4);
    expect(repo.getById('int_amt')?.state).toBe('MANUAL_REVIEW');
    expect(repo.getById('int_amt')?.review_reason).toBe('amount_mismatch');
    expect(repo.getById('int_method')?.state).toBe('MANUAL_REVIEW');
    expect(repo.getById('int_method')?.review_reason).toBe('method_mismatch');
    expect(repo.getById('int_acct')?.state).toBe('MANUAL_REVIEW');
    expect(repo.getById('int_acct')?.review_reason).toBe('account_mismatch');
    expect(repo.getById('int_txcount')?.state).toBe('MANUAL_REVIEW');
    expect(repo.getById('int_txcount')?.review_reason).toBe('invalid_transactions_count');
  });

  it('leaves active pending and missing UNCERTAIN_CREATE intents unchanged before expires_at', async () => {
    const repo = setupRepo();
    seedIntent(repo, 'int_still_pending', 'PENDING_PAYMENT');
    seedIntent(repo, 'int_uncertain_missing', 'UNCERTAIN_CREATE');

    const summary = await reconcileOnce({
      repo,
      now: activeNow,
      fetchStatus: async (intent) =>
        intent.id === 'int_still_pending' ? { status: 'pending' } : null,
    });

    expect(summary).toEqual({
      checked: 2,
      paidVerified: 0,
      manualReview: 0,
      expired: 0,
      latePayments: 0,
      unchanged: 2,
      fetchErrors: 0,
    });
    expect(repo.getById('int_still_pending')?.state).toBe('PENDING_PAYMENT');
    expect(repo.getById('int_uncertain_missing')?.state).toBe('UNCERTAIN_CREATE');
  });

  it('expires unpaid intents once now > expires_at', async () => {
    const repo = setupRepo();
    seedIntent(repo, 'int_exp_pending', 'PENDING_PAYMENT');
    seedIntent(repo, 'int_exp_uncertain', 'UNCERTAIN_CREATE');

    const summary = await reconcileOnce({
      repo,
      now: expiredNow,
      fetchStatus: async (intent) =>
        intent.id === 'int_exp_pending' ? { status: 'pending' } : null,
    });

    expect(summary.expired).toBe(2);
    expect(repo.getById('int_exp_pending')?.state).toBe('EXPIRED');
    expect(repo.getById('int_exp_uncertain')?.state).toBe('EXPIRED');
  });

  it('routes EXPIRED intents with late payment detected to MANUAL_REVIEW', async () => {
    const repo = setupRepo();
    seedIntent(repo, 'int_late_paid', 'EXPIRED');
    seedIntent(repo, 'int_still_expired', 'EXPIRED');

    const summary = await reconcileOnce({
      repo,
      now: expiredNow,
      fetchStatus: async (intent) =>
        intent.id === 'int_late_paid'
          ? {
              status: 'paid',
              transactions: [
                {
                  transactionId: 'tx_late_1',
                  status: 'paid',
                  paymentMethod: 'CODI',
                  amount: 250,
                  bankAccountId: '01TESTBANKACCOUNT0000',
                },
              ],
            }
          : { status: 'expired' },
    });

    expect(summary).toEqual({
      checked: 2,
      paidVerified: 0,
      manualReview: 1,
      expired: 0,
      latePayments: 1,
      unchanged: 1,
      fetchErrors: 0,
    });
    expect(repo.getById('int_late_paid')?.state).toBe('MANUAL_REVIEW');
    expect(repo.getById('int_late_paid')?.review_reason).toBe('late_payment');
    expect(repo.getById('int_still_expired')?.state).toBe('EXPIRED');
  });

  it('keeps state unchanged when fetchStatus throws a transport error', async () => {
    const repo = setupRepo();
    seedIntent(repo, 'int_fetch_err', 'PENDING_PAYMENT');

    const summary = await reconcileOnce({
      repo,
      now: expiredNow,
      fetchStatus: async () => {
        throw new Error('ECONNRESET timeout contacting Pey');
      },
    });

    expect(summary).toEqual({
      checked: 1,
      paidVerified: 0,
      manualReview: 0,
      expired: 0,
      latePayments: 0,
      unchanged: 0,
      fetchErrors: 1,
    });
    expect(repo.getById('int_fetch_err')?.state).toBe('PENDING_PAYMENT');
  });
});
