import type { PeyTransaction, PeyVerifyPayload } from '@codi-pey/contracts';
import { centsEquals, toCents } from './client.js';

// [P] validar contra OpenAPI/sandbox antes de uso en vivo
export type PeyAmountUnit = 'pesos' | 'centavos';

// [P] validar contra OpenAPI/sandbox antes de uso en vivo
export const PEY_AMOUNT_UNIT: PeyAmountUnit = 'pesos';

export type VerifyPaidReason =
  | 'not_paid'
  | 'invalid_transactions_count'
  | 'method_mismatch'
  | 'amount_mismatch'
  | 'account_mismatch';

export type VerifyPaidResult =
  | { ok: true }
  | { ok: false; reason: VerifyPaidReason };

export interface VerifyPaidInput {
  intent: {
    amountCents: number;
    expectedBankAccountId: string;
    expectedMethod: 'CODI' | (string & {});
  };
  payload: PeyVerifyPayload;
  /** Override for unit testing `'centavos'` vs `'pesos'`; defaults to `PEY_AMOUNT_UNIT`. */
  amountUnit?: PeyAmountUnit;
}

/**
 * Normalizes a raw payload amount (from `amountBreakdown.base` or `amount`) to integer centavos.
 * Numeric strings (e.g. "250.00") are explicitly rejected as `null` (-> `amount_mismatch`)
 * to prevent implicit string-to-number coercion ambiguity.
 */
function normalizePayloadAmountToCents(rawAmount: unknown, unit: PeyAmountUnit): number | null {
  if (typeof rawAmount !== 'number' || !Number.isFinite(rawAmount) || rawAmount <= 0) {
    return null;
  }
  if (unit === 'pesos') {
    try {
      return toCents(rawAmount);
    } catch {
      return null;
    }
  }
  if (!Number.isSafeInteger(rawAmount)) {
    return null;
  }
  return rawAmount;
}

/**
 * Pure C2 payment verification against Pey transaction/payment-link payloads.
 *
 * IMPORTANT (Rule C2): Any `{ ok: false, reason }` result MUST be routed to
 * `MANUAL_REVIEW` by the caller rather than marking the intent as paid or
 * silently discarding the discrepancy.
 */
export function verifyPaid({
  intent,
  payload,
  amountUnit = PEY_AMOUNT_UNIT,
}: VerifyPaidInput): VerifyPaidResult {
  if (!payload || payload.status !== 'paid') {
    return { ok: false, reason: 'not_paid' };
  }

  let subject: PeyTransaction | PeyVerifyPayload = payload;
  const hasTransactionsArray = Array.isArray(payload.transactions);
  // [P] validar contra OpenAPI: indicador de recurso Payment Link cuando falta transactions.
  const isPaymentLinkType =
    typeof payload.type === 'string' && payload.type.toLowerCase() === 'payment_link';

  if (hasTransactionsArray) {
    if (payload.transactions!.length !== 1) {
      return { ok: false, reason: 'invalid_transactions_count' };
    }
    const tx = payload.transactions![0];
    if (!tx || (tx.status !== undefined && tx.status !== 'paid')) {
      return { ok: false, reason: 'not_paid' };
    }
    subject = tx;
  } else if (isPaymentLinkType) {
    return { ok: false, reason: 'invalid_transactions_count' };
  }

  const actualMethod = subject.paymentMethod ?? payload.paymentMethod;
  if (actualMethod !== intent.expectedMethod) {
    return { ok: false, reason: 'method_mismatch' };
  }

  const rawAmount =
    subject.amountBreakdown?.base ??
    subject.amount ??
    payload.amountBreakdown?.base ??
    payload.amount;

  const normalizedCents = normalizePayloadAmountToCents(rawAmount, amountUnit);
  if (normalizedCents === null || !centsEquals(normalizedCents, intent.amountCents)) {
    return { ok: false, reason: 'amount_mismatch' };
  }

  const actualBankAccountId = subject.bankAccountId ?? payload.bankAccountId;
  if (
    typeof actualBankAccountId !== 'string' ||
    actualBankAccountId !== intent.expectedBankAccountId
  ) {
    return { ok: false, reason: 'account_mismatch' };
  }

  return { ok: true };
}
