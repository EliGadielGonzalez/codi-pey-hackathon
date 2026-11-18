import type { DatabaseSync } from 'node:sqlite';
import { LedgerEntrySchema, type LedgerEntry } from '@codi-pey/contracts';
import {
  assertTransition,
  type PaymentIntentState,
} from '../domain/state-machine.js';
import { allowlistRedact } from '../privacy/allowlist.js';
import type { DedupeStore } from '../webhooks/verify.js';
import { withImmediateTx } from './sqlite.js';

export class IntentNotFoundError extends Error {
  readonly intentId: string;

  constructor(intentId: string) {
    super(`Payment intent not found: ${intentId}`);
    this.name = 'IntentNotFoundError';
    this.intentId = intentId;
  }
}

export class OutboxMessageNotFoundError extends Error {
  readonly messageId: number;

  constructor(messageId: number) {
    super(`Outbox message not found: ${messageId}`);
    this.name = 'OutboxMessageNotFoundError';
    this.messageId = messageId;
  }
}

export interface PaymentIntentRecord {
  id: string;
  state: PaymentIntentState;
  amount_cents: number;
  expected_bank_account_id: string;
  num_ref: string | null;
  client_reference_id: string;
  provider_tx_id: string | null;
  mode: string;
  expected_method: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  review_reason: string | null;
}

export interface LedgerEntryRecord {
  id: number;
  intent_id: string;
  event: string;
  from_state: PaymentIntentState | null;
  to_state: PaymentIntentState;
  amount_cents: number;
  provider_tx_id: string | null;
  actor: string;
  created_at: string;
  detail_json: string | null;
}

export interface OutboxMessageRecord {
  id: number;
  intent_id: string;
  idempotency_key: string;
  payload_json: string;
  status: 'pending' | 'done' | 'dead';
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

export interface CreatePaymentIntentInput {
  id: string;
  state?: PaymentIntentState;
  amountCents: number;
  expectedBankAccountId: string;
  numRef?: string | null;
  clientReferenceId: string;
  mode: string;
  expectedMethod?: string;
  expiresAt: string;
  createdAt?: string;
  actor?: string;
}

export interface TransitionOptions {
  actor: string;
  detail?: Record<string, unknown>;
  event?: string;
  reviewReason?: string | null;
  nowIso?: string;
}

export interface MarkPaidVerifiedOptions {
  actor?: string;
  detail?: Record<string, unknown>;
  nowIso?: string;
}

function serializeDetail(detail?: Record<string, unknown>): string | null {
  if (!detail) return null;
  const sanitized: Record<string, unknown> = { ...detail };
  if ('payload' in sanitized && sanitized.payload !== undefined) {
    sanitized.payload = allowlistRedact(sanitized.payload);
  }
  return JSON.stringify(sanitized);
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

export class PaymentRepo implements DedupeStore {
  constructor(private readonly db: DatabaseSync) {}

  createIntent(input: CreatePaymentIntentInput): PaymentIntentRecord {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new RangeError('amountCents must be a positive safe integer');
    }
    const state: PaymentIntentState = input.state ?? 'CREATING';
    const createdAt = input.createdAt ?? defaultNowIso();
    const expectedMethod = input.expectedMethod ?? 'CODI';
    const actor = input.actor ?? 'api';

    return withImmediateTx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO payment_intents (
            id, state, amount_cents, expected_bank_account_id, num_ref,
            client_reference_id, provider_tx_id, mode, expected_method,
            created_at, updated_at, expires_at, review_reason
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          input.id,
          state,
          input.amountCents,
          input.expectedBankAccountId,
          input.numRef ?? null,
          input.clientReferenceId,
          input.mode,
          expectedMethod,
          createdAt,
          createdAt,
          input.expiresAt,
        );

      this.insertLedgerEntryInTx({
        intentId: input.id,
        event: 'INTENT_CREATED',
        fromState: null,
        toState: state,
        amountCents: input.amountCents,
        providerTxId: null,
        actor,
        createdAt,
        detail: { mode: input.mode },
      });

      return this.getByIdOrThrowInTx(input.id);
    });
  }

  getById(intentId: string): PaymentIntentRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM payment_intents WHERE id = ?')
      .get(intentId) as PaymentIntentRecord | undefined;
    return row;
  }

  listByState(state: PaymentIntentState): PaymentIntentRecord[] {
    return this.db
      .prepare('SELECT * FROM payment_intents WHERE state = ? ORDER BY created_at ASC, id ASC')
      .all(state) as unknown as PaymentIntentRecord[];
  }

  listLedgerEntries(intentId: string): LedgerEntryRecord[] {
    return this.db
      .prepare('SELECT * FROM ledger_entries WHERE intent_id = ? ORDER BY id ASC')
      .all(intentId) as unknown as LedgerEntryRecord[];
  }

  getOutboxMessageByIdempotencyKey(
    idempotencyKey: string,
  ): OutboxMessageRecord | undefined {
    return this.db
      .prepare('SELECT * FROM outbox_messages WHERE idempotency_key = ?')
      .get(idempotencyKey) as OutboxMessageRecord | undefined;
  }

  transition(
    intentId: string,
    to: PaymentIntentState,
    options: TransitionOptions,
  ): PaymentIntentRecord {
    return withImmediateTx(this.db, () =>
      this.transitionInTx(intentId, to, options),
    );
  }

  /**
   * Registers a webhook idempotently using `INSERT ... ON CONFLICT DO NOTHING`.
   * Always redacts payload via `allowlistRedact` before persistence.
   * Returns `true` if this webhook_id was new, `false` if already seen.
   */
  registerWebhookOnce(
    webhookId: string,
    redactedPayload: unknown,
    receivedAtIso = defaultNowIso(),
  ): boolean {
    const safePayload = allowlistRedact(redactedPayload);
    const result = this.db
      .prepare(
        `INSERT INTO webhook_events (webhook_id, received_at, payload_redacted_json)
         VALUES (?, ?, ?)
         ON CONFLICT(webhook_id) DO NOTHING`,
      )
      .run(webhookId, receivedAtIso, JSON.stringify(safePayload));
    return result.changes === 1;
  }

  /**
   * Implements `DedupeStore` from `webhooks/verify.ts`.
   * Returns `true` when already seen (duplicate), `false` when newly recorded.
   */
  seen(id: string): boolean {
    const isNew = this.registerWebhookOnce(id, {});
    return !isNew;
  }

  /**
   * Enqueues a ledger entry in the transactional outbox.
   * Duplicate `idempotency_key` is a silent no-op (returns `false`).
   */
  enqueueOutbox(
    intentId: string,
    entry: LedgerEntry,
    nextAttemptAtIso = defaultNowIso(),
  ): boolean {
    return withImmediateTx(this.db, () =>
      this.enqueueOutboxInTx(intentId, entry, nextAttemptAtIso),
    );
  }

  /**
   * Atomically transitions `PENDING_PAYMENT -> PAID_VERIFIED`, stores `provider_tx_id`,
   * appends the ledger audit entry, and enqueues the outbox message in one `BEGIN IMMEDIATE` tx.
   */
  markPaidVerified(
    intentId: string,
    providerTxId: string,
    entry: LedgerEntry,
    options: MarkPaidVerifiedOptions = {},
  ): PaymentIntentRecord {
    if (!providerTxId || providerTxId.trim().length === 0) {
      throw new Error('providerTxId must be a non-empty string');
    }
    const parsedEntry = LedgerEntrySchema.parse(entry);
    if (parsedEntry.intentId !== intentId) {
      throw new Error('LedgerEntry.intentId must match intentId');
    }
    if (parsedEntry.providerTxId !== providerTxId) {
      throw new Error('LedgerEntry.providerTxId must match providerTxId');
    }
    if (parsedEntry.idempotencyKey !== providerTxId) {
      throw new Error('LedgerEntry.idempotencyKey must equal providerTxId');
    }

    const nowIso = options.nowIso ?? defaultNowIso();
    const actor = options.actor ?? 'reconciler';

    return withImmediateTx(this.db, () => {
      const current = this.getByIdOrThrowInTx(intentId);
      assertTransition(current.state, 'PAID_VERIFIED');

      this.db
        .prepare(
          `UPDATE payment_intents
           SET state = 'PAID_VERIFIED', provider_tx_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(providerTxId, nowIso, intentId);

      this.insertLedgerEntryInTx({
        intentId,
        event: 'PAID_VERIFIED',
        fromState: current.state,
        toState: 'PAID_VERIFIED',
        amountCents: current.amount_cents,
        providerTxId,
        actor,
        createdAt: nowIso,
        detail: options.detail,
      });

      this.enqueueOutboxInTx(intentId, parsedEntry, nowIso);

      return this.getByIdOrThrowInTx(intentId);
    });
  }

  listDueOutboxMessages(nowIso: string): OutboxMessageRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM outbox_messages
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY id ASC`,
      )
      .all(nowIso) as unknown as OutboxMessageRecord[];
  }

  markOutboxApplied(options: {
    messageId: number;
    intentId: string;
    status: 'applied' | 'duplicate';
    actor: string;
    nowIso: string;
    detail?: Record<string, unknown>;
  }): void {
    withImmediateTx(this.db, () => {
      this.transitionInTx(options.intentId, 'APPLIED', {
        actor: options.actor,
        event: 'OUTBOX_APPLIED',
        detail: { ledgerStatus: options.status, ...options.detail },
        nowIso: options.nowIso,
      });

      this.db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'done', last_error = NULL
           WHERE id = ?`,
        )
        .run(options.messageId);
    });
  }

  markOutboxRejected(options: {
    messageId: number;
    intentId: string;
    reason?: string;
    actor: string;
    nowIso: string;
  }): void {
    const reviewReason = options.reason ?? 'ledger_rejected';
    withImmediateTx(this.db, () => {
      this.transitionInTx(options.intentId, 'MANUAL_REVIEW', {
        actor: options.actor,
        event: 'OUTBOX_REJECTED',
        reviewReason,
        detail: { ledgerStatus: 'rejected', reason: reviewReason },
        nowIso: options.nowIso,
      });

      this.db
        .prepare(
          `UPDATE outbox_messages
           SET status = 'done', last_error = ?
           WHERE id = ?`,
        )
        .run(reviewReason, options.messageId);
    });
  }

  markOutboxPendingCash(options: {
    messageId: number;
    intentId: string;
    nextAttemptAtIso: string;
    actor: string;
    reason?: string;
    nowIso: string;
  }): void {
    withImmediateTx(this.db, () => {
      const current = this.getByIdOrThrowInTx(options.intentId);
      if (current.state !== 'PENDING_CAJA') {
        this.transitionInTx(options.intentId, 'PENDING_CAJA', {
          actor: options.actor,
          event: 'OUTBOX_PENDING_CASH',
          detail: {
            ledgerStatus: 'pending_cash',
            reason: options.reason ?? null,
          },
          nowIso: options.nowIso,
        });
      }

      this.db
        .prepare(
          `UPDATE outbox_messages
           SET next_attempt_at = ?, last_error = NULL
           WHERE id = ?`,
        )
        .run(options.nextAttemptAtIso, options.messageId);
    });
  }

  recordOutboxTransportError(options: {
    messageId: number;
    intentId: string;
    sanitizedError: string;
    nextAttemptAtIso: string;
    maxAttempts: number;
    actor: string;
    nowIso: string;
  }): { attempts: number; status: 'pending' | 'dead' } {
    return withImmediateTx(this.db, () => {
      const msg = this.db
        .prepare('SELECT * FROM outbox_messages WHERE id = ?')
        .get(options.messageId) as OutboxMessageRecord | undefined;
      if (!msg) {
        throw new OutboxMessageNotFoundError(options.messageId);
      }

      const nextAttempts = msg.attempts + 1;
      const isDead = nextAttempts >= options.maxAttempts;

      if (isDead) {
        this.db
          .prepare(
            `UPDATE outbox_messages
             SET status = 'dead', attempts = ?, last_error = ?
             WHERE id = ?`,
          )
          .run(nextAttempts, options.sanitizedError, options.messageId);

        this.transitionInTx(options.intentId, 'MANUAL_REVIEW', {
          actor: options.actor,
          event: 'OUTBOX_DEAD',
          reviewReason: 'outbox_max_attempts_exceeded',
          detail: {
            attempts: nextAttempts,
            lastError: options.sanitizedError,
          },
          nowIso: options.nowIso,
        });

        return { attempts: nextAttempts, status: 'dead' };
      }

      this.db
        .prepare(
          `UPDATE outbox_messages
           SET attempts = ?, next_attempt_at = ?, last_error = ?
           WHERE id = ?`,
        )
        .run(
          nextAttempts,
          options.nextAttemptAtIso,
          options.sanitizedError,
          options.messageId,
        );

      return { attempts: nextAttempts, status: 'pending' };
    });
  }

  private getByIdOrThrowInTx(intentId: string): PaymentIntentRecord {
    const row = this.getById(intentId);
    if (!row) {
      throw new IntentNotFoundError(intentId);
    }
    return row;
  }

  private transitionInTx(
    intentId: string,
    to: PaymentIntentState,
    options: TransitionOptions,
  ): PaymentIntentRecord {
    const current = this.getByIdOrThrowInTx(intentId);
    assertTransition(current.state, to);

    const nowIso = options.nowIso ?? defaultNowIso();
    const nextReviewReason =
      options.reviewReason !== undefined
        ? options.reviewReason
        : current.review_reason;

    this.db
      .prepare(
        `UPDATE payment_intents
         SET state = ?, updated_at = ?, review_reason = ?
         WHERE id = ?`,
      )
      .run(to, nowIso, nextReviewReason, intentId);

    this.insertLedgerEntryInTx({
      intentId,
      event: options.event ?? 'STATE_TRANSITION',
      fromState: current.state,
      toState: to,
      amountCents: current.amount_cents,
      providerTxId: current.provider_tx_id,
      actor: options.actor,
      createdAt: nowIso,
      detail: options.detail,
    });

    return this.getByIdOrThrowInTx(intentId);
  }

  private enqueueOutboxInTx(
    intentId: string,
    entry: LedgerEntry,
    nextAttemptAtIso: string,
  ): boolean {
    const parsed = LedgerEntrySchema.parse(entry);
    if (parsed.intentId !== intentId) {
      throw new Error('LedgerEntry.intentId must match intentId');
    }

    const result = this.db
      .prepare(
        `INSERT INTO outbox_messages (
          intent_id, idempotency_key, payload_json, status, attempts, next_attempt_at, last_error
        ) VALUES (?, ?, ?, 'pending', 0, ?, NULL)
        ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(
        intentId,
        parsed.idempotencyKey,
        JSON.stringify(parsed),
        nextAttemptAtIso,
      );

    return result.changes === 1;
  }

  private insertLedgerEntryInTx(input: {
    intentId: string;
    event: string;
    fromState: PaymentIntentState | null;
    toState: PaymentIntentState;
    amountCents: number;
    providerTxId: string | null;
    actor: string;
    createdAt: string;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `INSERT INTO ledger_entries (
          intent_id, event, from_state, to_state, amount_cents,
          provider_tx_id, actor, created_at, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.intentId,
        input.event,
        input.fromState,
        input.toState,
        input.amountCents,
        input.providerTxId,
        input.actor,
        input.createdAt,
        serializeDetail(input.detail),
      );
  }
}
