import {
  LedgerEntrySchema,
  type ExternalLedgerPort,
} from '@codi-pey/contracts';
import type { PaymentRepo } from '../db/payment-repo.js';
import { resolveNowDate, type ClockInput } from './reconciler.js';

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const DEFAULT_OUTBOX_BACKOFF: Required<BackoffOptions> = {
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
};

export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_PENDING_CASH_RETRY_MS = 60_000;

/**
 * Pure exponential backoff with upper cap for outbox transport retries.
 */
export function computeBackoffDelayMs(
  attempts: number,
  options: BackoffOptions = {},
): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_OUTBOX_BACKOFF.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_OUTBOX_BACKOFF.maxDelayMs;

  if (!Number.isFinite(baseDelayMs) || baseDelayMs <= 0) {
    throw new RangeError('baseDelayMs must be a positive number');
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) {
    throw new RangeError('maxDelayMs must be a positive number');
  }

  if (!Number.isFinite(attempts) || attempts <= 1) {
    return Math.min(baseDelayMs, maxDelayMs);
  }
  const exponent = Math.min(Math.floor(attempts) - 1, 30);
  const raw = baseDelayMs * Math.pow(2, exponent);
  return Math.min(raw, maxDelayMs);
}

/**
 * Strips headers, bearer tokens, API keys, and secrets from transport errors
 * before storing them in `outbox_messages.last_error`.
 */
export function sanitizeOutboxError(err: unknown): string {
  let name = 'Error';
  let message = 'Unknown ledger transport error';

  if (err instanceof Error) {
    if (err.name) name = err.name;
    if (err.message) message = err.message;
  } else if (typeof err === 'object' && err !== null) {
    const maybeName = (err as { name?: unknown }).name;
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeName === 'string' && maybeName) name = maybeName;
    if (typeof maybeMessage === 'string' && maybeMessage) {
      message = maybeMessage;
    }
  } else if (typeof err === 'string' && err) {
    message = err;
  }

  const scrub = (text: string): string =>
    text
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/Authorization\s*:\s*[^\r\n,;]+/gi, 'Authorization: [REDACTED]')
      .replace(/x-api-key\s*:\s*[^\r\n,;]+/gi, 'x-api-key: [REDACTED]')
      .replace(
        /\b(api[_-]?key|token|secret|password)\s*[=:]\s*[^\s,;]+/gi,
        '$1=[REDACTED]',
      )
      .replace(/\bwhsec_[A-Za-z0-9+/=_-]+/g, 'whsec_[REDACTED]');

  const combined = `${scrub(name)}: ${scrub(message)}`.trim();
  return combined.length > 500 ? `${combined.slice(0, 497)}...` : combined;
}

export interface DrainOutboxInput {
  repo: PaymentRepo;
  ledger: ExternalLedgerPort;
  now?: ClockInput;
  maxAttempts?: number;
  backoffOptions?: BackoffOptions;
  pendingCashRetryMs?: number;
}

export interface DrainOutboxSummary {
  processed: number;
  applied: number;
  pendingCash: number;
  rejected: number;
  retried: number;
  dead: number;
}

/**
 * Drains due `pending` outbox messages, calling `ledger.apply(entry)` while
 * strictly preserving the original `idempotencyKey` across all retries.
 */
export async function drainOutbox(
  input: DrainOutboxInput,
): Promise<DrainOutboxSummary> {
  const {
    repo,
    ledger,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffOptions,
    pendingCashRetryMs = DEFAULT_PENDING_CASH_RETRY_MS,
  } = input;

  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new RangeError('maxAttempts must be a positive integer');
  }

  const nowDate = resolveNowDate(input.now);
  const nowMs = nowDate.getTime();
  const nowIso = nowDate.toISOString();

  const summary: DrainOutboxSummary = {
    processed: 0,
    applied: 0,
    pendingCash: 0,
    rejected: 0,
    retried: 0,
    dead: 0,
  };

  const dueMessages = repo.listDueOutboxMessages(nowIso);

  for (const msg of dueMessages) {
    summary.processed += 1;
    const entry = LedgerEntrySchema.parse(JSON.parse(msg.payload_json));

    try {
      const result = await ledger.apply(entry);

      if (result.status === 'applied' || result.status === 'duplicate') {
        repo.markOutboxApplied({
          messageId: msg.id,
          intentId: msg.intent_id,
          status: result.status,
          actor: 'outbox',
          nowIso,
          detail: result.reason ? { reason: result.reason } : undefined,
        });
        summary.applied += 1;
        continue;
      }

      if (result.status === 'pending_cash') {
        const nextAttemptAtIso = new Date(
          nowMs + pendingCashRetryMs,
        ).toISOString();
        repo.markOutboxPendingCash({
          messageId: msg.id,
          intentId: msg.intent_id,
          nextAttemptAtIso,
          actor: 'outbox',
          reason: result.reason,
          nowIso,
        });
        summary.pendingCash += 1;
        continue;
      }

      if (result.status === 'rejected') {
        repo.markOutboxRejected({
          messageId: msg.id,
          intentId: msg.intent_id,
          reason: result.reason,
          actor: 'outbox',
          nowIso,
        });
        summary.rejected += 1;
        continue;
      }

      throw new Error(`Unsupported ledger apply status: ${String(result.status)}`);
    } catch (err) {
      const nextAttemptNumber = msg.attempts + 1;
      const delayMs = computeBackoffDelayMs(nextAttemptNumber, backoffOptions);
      const nextAttemptAtIso = new Date(nowMs + delayMs).toISOString();
      const sanitizedError = sanitizeOutboxError(err);

      const outcome = repo.recordOutboxTransportError({
        messageId: msg.id,
        intentId: msg.intent_id,
        sanitizedError,
        nextAttemptAtIso,
        maxAttempts,
        actor: 'outbox',
        nowIso,
      });

      if (outcome.status === 'dead') {
        summary.dead += 1;
      } else {
        summary.retried += 1;
      }
    }
  }

  return summary;
}
