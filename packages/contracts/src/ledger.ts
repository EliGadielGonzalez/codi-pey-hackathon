import { z } from 'zod';

/**
 * Normalized payment ledger entry produced once a payment intent is verified as paid.
 * `idempotencyKey` MUST match `providerTxId` so retries across the outbox never double-post.
 */
export const LedgerEntrySchema = z.object({
  idempotencyKey: z.string().min(1),
  intentId: z.string().min(1),
  amountCents: z.number().int().positive(),
  method: z.string().min(1),
  providerTxId: z.string().min(1),
  accountRef: z.string().min(1).optional(),
  paidAtIso: z.string().min(1),
});

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const ExternalLedgerApplyStatusSchema = z.enum([
  'applied',
  'duplicate',
  'pending_cash',
  'rejected',
]);

export type ExternalLedgerApplyStatus = z.infer<typeof ExternalLedgerApplyStatusSchema>;

export const ExternalLedgerApplyResultSchema = z.object({
  status: ExternalLedgerApplyStatusSchema,
  reason: z.string().optional(),
});

export type ExternalLedgerApplyResult = z.infer<typeof ExternalLedgerApplyResultSchema>;

/**
 * Abstract port for posting verified payments to an external accounting ledger.
 * Implementations MUST throw/reject on transport or transient failures so the
 * outbox can retry safely with the same idempotencyKey.
 */
export interface ExternalLedgerPort {
  apply(entry: LedgerEntry): Promise<ExternalLedgerApplyResult>;
}
