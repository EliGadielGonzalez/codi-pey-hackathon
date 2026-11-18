import type { LedgerEntry, PeyVerifyPayload } from '@codi-pey/contracts';
import type { PaymentIntentRecord, PaymentRepo } from '../db/payment-repo.js';
import { verifyPaid } from '../pey/verify-payment.js';

export type ClockInput =
  | Date
  | number
  | string
  | (() => Date | number | string);

export function resolveNowDate(now?: ClockInput): Date {
  const raw = typeof now === 'function' ? now() : now;
  const date =
    raw === undefined
      ? new Date()
      : raw instanceof Date
        ? new Date(raw.getTime())
        : new Date(raw);

  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid clock timestamp provided');
  }
  return date;
}

export interface ReconcileOnceInput {
  repo: PaymentRepo;
  fetchStatus: (
    intent: PaymentIntentRecord,
  ) => Promise<PeyVerifyPayload | null | undefined>;
  verify?: typeof verifyPaid;
  now?: ClockInput;
}

export interface ReconcileSummary {
  checked: number;
  paidVerified: number;
  manualReview: number;
  expired: number;
  latePayments: number;
  unchanged: number;
  fetchErrors: number;
}

function extractPaidFields(
  intent: PaymentIntentRecord,
  payload: PeyVerifyPayload,
  fallbackNowIso: string,
): {
  providerTxId: string | undefined;
  paidAtIso: string;
  method: string;
  accountRef: string | undefined;
} {
  const tx =
    Array.isArray(payload.transactions) && payload.transactions.length === 1
      ? payload.transactions[0]
      : undefined;

  const rawTxId = tx?.transactionId ?? tx?.id ?? payload.id;
  const providerTxId =
    typeof rawTxId === 'string' && rawTxId.trim().length > 0
      ? rawTxId.trim()
      : undefined;

  const paidAtIso =
    (typeof tx?.datePaid === 'string' && tx.datePaid) ||
    (typeof payload.datePaid === 'string' && payload.datePaid) ||
    fallbackNowIso;

  const method =
    (typeof tx?.paymentMethod === 'string' && tx.paymentMethod) ||
    (typeof payload.paymentMethod === 'string' && payload.paymentMethod) ||
    intent.expected_method;

  const rawAccountRef = tx?.bankAccountId ?? payload.bankAccountId;
  const accountRef =
    typeof rawAccountRef === 'string' && rawAccountRef.length > 0
      ? rawAccountRef
      : undefined;

  return { providerTxId, paidAtIso, method, accountRef };
}

function hasLatePaidSignal(payload: PeyVerifyPayload | null | undefined): boolean {
  if (!payload) return false;
  if (payload.status === 'paid') return true;
  if (Array.isArray(payload.transactions)) {
    return payload.transactions.some((tx) => tx?.status === 'paid');
  }
  return false;
}

/**
 * Runs a single reconciliation pass over `PENDING_PAYMENT`, `UNCERTAIN_CREATE`,
 * and `EXPIRED` intents. Never auto-recreates missing `UNCERTAIN_CREATE` resources.
 */
export async function reconcileOnce(
  input: ReconcileOnceInput,
): Promise<ReconcileSummary> {
  const { repo, fetchStatus, verify = verifyPaid } = input;
  const nowDate = resolveNowDate(input.now);
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();

  const summary: ReconcileSummary = {
    checked: 0,
    paidVerified: 0,
    manualReview: 0,
    expired: 0,
    latePayments: 0,
    unchanged: 0,
    fetchErrors: 0,
  };

  const activeIntents = [
    ...repo.listByState('PENDING_PAYMENT'),
    ...repo.listByState('UNCERTAIN_CREATE'),
  ];

  for (const intent of activeIntents) {
    summary.checked += 1;
    let payload: PeyVerifyPayload | null | undefined;
    try {
      payload = await fetchStatus(intent);
    } catch {
      summary.fetchErrors += 1;
      continue;
    }

    const isExpiredByClock = nowMs > Date.parse(intent.expires_at);

    if (!payload) {
      if (isExpiredByClock) {
        repo.transition(intent.id, 'EXPIRED', {
          actor: 'reconciler',
          event: 'INTENT_EXPIRED',
          detail: { reason: 'expired_without_resource' },
          nowIso,
        });
        summary.expired += 1;
      } else {
        // UNCERTAIN_CREATE without a remote resource is left for operator inspection;
        // never auto-recreate payment resources in Pey.
        summary.unchanged += 1;
      }
      continue;
    }

    const verification = verify({
      intent: {
        amountCents: intent.amount_cents,
        expectedBankAccountId: intent.expected_bank_account_id,
        expectedMethod: intent.expected_method,
      },
      payload,
    });

    if (verification.ok) {
      const { providerTxId, paidAtIso, method, accountRef } = extractPaidFields(
        intent,
        payload,
        nowIso,
      );

      if (!providerTxId) {
        repo.transition(intent.id, 'MANUAL_REVIEW', {
          actor: 'reconciler',
          event: 'MANUAL_REVIEW_REQUIRED',
          reviewReason: 'missing_provider_tx_id',
          detail: { reason: 'missing_provider_tx_id', payload },
          nowIso,
        });
        summary.manualReview += 1;
        continue;
      }

      const entry: LedgerEntry = {
        idempotencyKey: providerTxId,
        intentId: intent.id,
        amountCents: intent.amount_cents,
        method,
        providerTxId,
        ...(accountRef ? { accountRef } : {}),
        paidAtIso,
      };

      if (intent.state === 'UNCERTAIN_CREATE') {
        repo.transition(intent.id, 'PENDING_PAYMENT', {
          actor: 'reconciler',
          event: 'UNCERTAIN_CREATE_CONFIRMED',
          detail: { reason: 'resource_confirmed_paid_in_provider' },
          nowIso,
        });
      }

      repo.markPaidVerified(intent.id, providerTxId, entry, {
        actor: 'reconciler',
        detail: { method, paidAtIso },
        nowIso,
      });
      summary.paidVerified += 1;
      continue;
    }

    if (verification.reason !== 'not_paid') {
      repo.transition(intent.id, 'MANUAL_REVIEW', {
        actor: 'reconciler',
        event: 'VERIFY_PAID_MISMATCH',
        reviewReason: verification.reason,
        detail: { reason: verification.reason, payload },
        nowIso,
      });
      summary.manualReview += 1;
      continue;
    }

    if (isExpiredByClock) {
      repo.transition(intent.id, 'EXPIRED', {
        actor: 'reconciler',
        event: 'INTENT_EXPIRED',
        detail: {
          reason: 'expired_without_payment',
          providerStatus: payload.status ?? null,
        },
        nowIso,
      });
      summary.expired += 1;
    } else {
      summary.unchanged += 1;
    }
  }

  const expiredIntents = repo.listByState('EXPIRED');
  for (const intent of expiredIntents) {
    summary.checked += 1;
    let payload: PeyVerifyPayload | null | undefined;
    try {
      payload = await fetchStatus(intent);
    } catch {
      summary.fetchErrors += 1;
      continue;
    }

    if (hasLatePaidSignal(payload)) {
      const verification = verify({
        intent: {
          amountCents: intent.amount_cents,
          expectedBankAccountId: intent.expected_bank_account_id,
          expectedMethod: intent.expected_method,
        },
        payload: payload!,
      });
      const reviewReason = verification.ok
        ? 'late_payment'
        : `late_payment:${verification.reason}`;

      repo.transition(intent.id, 'MANUAL_REVIEW', {
        actor: 'reconciler',
        event: 'LATE_PAYMENT_DETECTED',
        reviewReason,
        detail: { reason: reviewReason, payload },
        nowIso,
      });
      summary.latePayments += 1;
      summary.manualReview += 1;
    } else {
      summary.unchanged += 1;
    }
  }

  return summary;
}
