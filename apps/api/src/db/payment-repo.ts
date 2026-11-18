import type { DatabaseSync } from 'node:sqlite';
import {
  LedgerEntrySchema,
  type BankAccountView,
  type IntentKind,
  type IntentStatus,
  type LedgerEntry,
  type PaymentIntent,
  type PaymentMode,
  type PeyBankAccountStatus,
} from '@codi-pey/contracts';
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

export interface PaymentIntentDetailsRecord {
  intent_id: string;
  concept: string;
  external_ref: string;
  qr_payload: string;
  payment_link_url: string | null;
  customer_phone_masked: string | null;
  kadi_cuenta_id: string | null;
  kadi_sync_status: 'not_configured' | 'pending' | 'synced' | 'failed';
  paid_at: string | null;
  kind: IntentKind;
  pey_resource_id: string | null;
}

export interface CreateIntentWithDetailsInput extends CreatePaymentIntentInput {
  concept: string;
  externalRef: string;
  qrPayload: string;
  paymentLinkUrl?: string | null;
  customerPhoneMasked?: string | null;
  kadiCuentaId?: string | null;
  kadiSyncStatus?: 'not_configured' | 'pending' | 'synced' | 'failed';
  kind?: IntentKind;
  peyResourceId?: string | null;
}

export interface WebhookLogEntry {
  event_id: string;
  intent_id: string;
  status: string;
  clave_rastreo: string;
  received_at: string;
  duplicate: boolean;
}

export interface UpsertBankAccountInput {
  id: string;
  bankAccountId: string;
  clabeMasked: string;
  alias: string;
  holderName: string;
  codiStatus: PeyBankAccountStatus;
  errorMessage?: string | null;
  nowIso?: string;
}

export function mapStateToStatus(state: PaymentIntentState): IntentStatus {
  switch (state) {
    case 'PAID_VERIFIED':
    case 'PENDING_CAJA':
    case 'APPLIED':
      return 'paid';
    case 'EXPIRED':
      return 'expired';
    case 'MANUAL_REVIEW':
    case 'REFUNDED_MANUAL':
    case 'CANCELLED':
      return 'failed';
    case 'CREATING':
    case 'UNCERTAIN_CREATE':
    case 'PENDING_PAYMENT':
    default:
      return 'pending';
  }
}

function toPaymentIntentView(
  row: PaymentIntentRecord & Partial<PaymentIntentDetailsRecord>,
): PaymentIntent {
  return {
    intent_id: row.id,
    amount_mxn: Number((row.amount_cents / 100).toFixed(2)),
    concept: row.concept ?? row.client_reference_id,
    external_ref: row.external_ref ?? row.client_reference_id,
    mode: (row.mode as PaymentMode) || 'qr',
    ...(row.customer_phone_masked ? { customer_phone: row.customer_phone_masked } : {}),
    status: mapStateToStatus(row.state),
    state: row.state,
    amount_cents: row.amount_cents,
    expected_bank_account_id: row.expected_bank_account_id,
    provider_tx_id: row.provider_tx_id,
    review_reason: row.review_reason,
    kind: row.kind ?? 'clinical',
    payment_link_url: row.payment_link_url ?? null,
    qr_payload: row.qr_payload ?? '',
    ...(row.provider_tx_id ? { clave_rastreo: row.provider_tx_id } : {}),
    ...(row.kadi_cuenta_id ? { kadi_cuenta_id: row.kadi_cuenta_id } : {}),
    kadi_sync_status: row.kadi_sync_status ?? 'not_configured',
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    ...(row.paid_at ? { paid_at: row.paid_at } : {}),
  };
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

  createIntentWithDetails(input: CreateIntentWithDetailsInput): PaymentIntent {
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

      this.db
        .prepare(
          `INSERT INTO payment_intent_details (
            intent_id, concept, external_ref, qr_payload, payment_link_url,
            customer_phone_masked, kadi_cuenta_id, kadi_sync_status, paid_at,
            kind, pey_resource_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.concept,
          input.externalRef,
          input.qrPayload,
          input.paymentLinkUrl ?? null,
          input.customerPhoneMasked ?? null,
          input.kadiCuentaId ?? null,
          input.kadiSyncStatus ?? 'not_configured',
          input.kind ?? 'clinical',
          input.peyResourceId ?? null,
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
        detail: { mode: input.mode, kind: input.kind ?? 'clinical' },
      });

      return this.getIntentView(input.id)!;
    });
  }

  getIntentDetails(intentId: string): PaymentIntentDetailsRecord | undefined {
    return this.db
      .prepare('SELECT * FROM payment_intent_details WHERE intent_id = ?')
      .get(intentId) as PaymentIntentDetailsRecord | undefined;
  }

  updateIntentDetails(
    intentId: string,
    patch: Partial<{
      qrPayload: string;
      paymentLinkUrl: string | null;
      kadiSyncStatus: 'not_configured' | 'pending' | 'synced' | 'failed';
      paidAt: string | null;
      peyResourceId: string | null;
    }>,
  ): void {
    const existing = this.getIntentDetails(intentId);
    if (!existing) return;
    this.db
      .prepare(
        `UPDATE payment_intent_details
         SET qr_payload = ?,
             payment_link_url = ?,
             kadi_sync_status = ?,
             paid_at = ?,
             pey_resource_id = ?
         WHERE intent_id = ?`,
      )
      .run(
        patch.qrPayload ?? existing.qr_payload,
        patch.paymentLinkUrl !== undefined ? patch.paymentLinkUrl : existing.payment_link_url,
        patch.kadiSyncStatus ?? existing.kadi_sync_status,
        patch.paidAt !== undefined ? patch.paidAt : existing.paid_at,
        patch.peyResourceId !== undefined ? patch.peyResourceId : existing.pey_resource_id,
        intentId,
      );
  }

  getIntentView(intentId: string): PaymentIntent | undefined {
    const row = this.db
      .prepare(
        `SELECT pi.*, pid.concept, pid.external_ref, pid.qr_payload,
                pid.payment_link_url, pid.customer_phone_masked,
                pid.kadi_cuenta_id, pid.kadi_sync_status, pid.paid_at,
                pid.kind, pid.pey_resource_id
         FROM payment_intents pi
         LEFT JOIN payment_intent_details pid ON pid.intent_id = pi.id
         WHERE pi.id = ?`,
      )
      .get(intentId) as (PaymentIntentRecord & Partial<PaymentIntentDetailsRecord>) | undefined;
    return row ? toPaymentIntentView(row) : undefined;
  }

  listIntentViews(): PaymentIntent[] {
    const rows = this.db
      .prepare(
        `SELECT pi.*, pid.concept, pid.external_ref, pid.qr_payload,
                pid.payment_link_url, pid.customer_phone_masked,
                pid.kadi_cuenta_id, pid.kadi_sync_status, pid.paid_at,
                pid.kind, pid.pey_resource_id
         FROM payment_intents pi
         LEFT JOIN payment_intent_details pid ON pid.intent_id = pi.id
         ORDER BY pi.created_at DESC, pi.id DESC`,
      )
      .all() as unknown as Array<PaymentIntentRecord & Partial<PaymentIntentDetailsRecord>>;
    return rows.map(toPaymentIntentView);
  }

  listManualReviewIntents(): PaymentIntent[] {
    const rows = this.db
      .prepare(
        `SELECT pi.*, pid.concept, pid.external_ref, pid.qr_payload,
                pid.payment_link_url, pid.customer_phone_masked,
                pid.kadi_cuenta_id, pid.kadi_sync_status, pid.paid_at,
                pid.kind, pid.pey_resource_id
         FROM payment_intents pi
         LEFT JOIN payment_intent_details pid ON pid.intent_id = pi.id
         WHERE pi.state = 'MANUAL_REVIEW'
         ORDER BY pi.updated_at DESC, pi.id DESC`,
      )
      .all() as unknown as Array<PaymentIntentRecord & Partial<PaymentIntentDetailsRecord>>;
    return rows.map(toPaymentIntentView);
  }

  listAllLedgerEntries(limit = 200): LedgerEntryRecord[] {
    return this.db
      .prepare('SELECT * FROM ledger_entries ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as LedgerEntryRecord[];
  }

  hasProcessedProviderTx(providerTxId: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM payment_intents WHERE provider_tx_id = ? LIMIT 1')
      .get(providerTxId);
    return Boolean(row);
  }

  updateWebhookRedactedPayload(webhookId: string, rawPayload: unknown): void {
    const safePayload = allowlistRedact(rawPayload);
    this.db
      .prepare('UPDATE webhook_events SET payload_redacted_json = ? WHERE webhook_id = ?')
      .run(JSON.stringify(safePayload), webhookId);
  }

  recordWebhookLog(entry: WebhookLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO webhook_logs (event_id, intent_id, status, clave_rastreo, received_at, duplicate)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.event_id,
        entry.intent_id,
        entry.status,
        entry.clave_rastreo,
        entry.received_at,
        entry.duplicate ? 1 : 0,
      );
  }

  listWebhookLogs(limit = 50): WebhookLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, intent_id, status, clave_rastreo, received_at, duplicate
         FROM webhook_logs
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as Array<{
      event_id: string;
      intent_id: string;
      status: string;
      clave_rastreo: string;
      received_at: string;
      duplicate: number;
    }>;
    return rows.map((r) => ({
      event_id: r.event_id,
      intent_id: r.intent_id,
      status: r.status,
      clave_rastreo: r.clave_rastreo,
      received_at: r.received_at,
      duplicate: r.duplicate === 1,
    }));
  }

  upsertBankAccount(input: UpsertBankAccountInput): BankAccountView {
    const nowIso = input.nowIso ?? defaultNowIso();
    return withImmediateTx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO bank_accounts (
            id, bank_account_id, clabe_masked, alias, holder_name,
            codi_status, error_message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bank_account_id) DO UPDATE SET
            clabe_masked = excluded.clabe_masked,
            alias = excluded.alias,
            holder_name = excluded.holder_name,
            codi_status = excluded.codi_status,
            error_message = excluded.error_message,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.bankAccountId,
          input.clabeMasked,
          input.alias,
          input.holderName,
          input.codiStatus,
          input.errorMessage ?? null,
          nowIso,
          nowIso,
        );

      return this.getBankAccountById(input.id) ?? (this.db
        .prepare('SELECT * FROM bank_accounts WHERE bank_account_id = ?')
        .get(input.bankAccountId) as unknown as BankAccountView);
    });
  }

  getLatestBankAccount(): BankAccountView | undefined {
    return this.db
      .prepare('SELECT * FROM bank_accounts ORDER BY updated_at DESC, created_at DESC LIMIT 1')
      .get() as BankAccountView | undefined;
  }

  getActiveBankAccount(): BankAccountView | undefined {
    return this.db
      .prepare(
        `SELECT * FROM bank_accounts
         WHERE codi_status = 'ACTIVE'
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get() as BankAccountView | undefined;
  }

  listBankAccounts(): BankAccountView[] {
    return this.db
      .prepare('SELECT * FROM bank_accounts ORDER BY updated_at DESC, created_at DESC')
      .all() as unknown as BankAccountView[];
  }

  getBankAccountById(idOrBankAccountId: string): BankAccountView | undefined {
    return this.db
      .prepare('SELECT * FROM bank_accounts WHERE id = ? OR bank_account_id = ? LIMIT 1')
      .get(idOrBankAccountId, idOrBankAccountId) as BankAccountView | undefined;
  }

  updateBankAccountStatus(
    idOrBankAccountId: string,
    status: PeyBankAccountStatus,
    errorMessage: string | null = null,
    nowIso = defaultNowIso(),
  ): BankAccountView | undefined {
    const existing = this.getBankAccountById(idOrBankAccountId);
    if (!existing) return undefined;
    this.db
      .prepare(
        `UPDATE bank_accounts
         SET codi_status = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, errorMessage, nowIso, existing.id);
    return this.getBankAccountById(existing.id);
  }

  getKillSwitchEnabled(): boolean {
    const row = this.db
      .prepare("SELECT value_json FROM app_config WHERE key = 'codi_kill_switch'")
      .get() as { value_json: string } | undefined;
    if (!row) return true;
    try {
      const parsed = JSON.parse(row.value_json) as { enabled?: unknown };
      return typeof parsed.enabled === 'boolean' ? parsed.enabled : true;
    } catch {
      return true;
    }
  }

  setKillSwitchEnabled(enabled: boolean, nowIso = defaultNowIso()): { enabled: boolean; updated_at: string } {
    this.db
      .prepare(
        `INSERT INTO app_config (key, value_json, updated_at)
         VALUES ('codi_kill_switch', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify({ enabled }), nowIso);
    return { enabled, updated_at: nowIso };
  }
}
