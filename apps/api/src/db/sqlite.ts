import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Opens a SQLite database using `node:sqlite` (requires Node >= 22.16.0 for `{ timeout }`),
 * enabling WAL journal mode, NORMAL synchronous mode, and foreign key enforcement.
 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: DEFAULT_BUSY_TIMEOUT_MS });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
  `);
  return db;
}

/**
 * Idempotent schema migration for payment intents, webhook deduplication,
 * append-only ledger entries, and transactional outbox messages.
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (
        state IN (
          'CREATING',
          'UNCERTAIN_CREATE',
          'PENDING_PAYMENT',
          'PAID_VERIFIED',
          'PENDING_CAJA',
          'APPLIED',
          'MANUAL_REVIEW',
          'EXPIRED',
          'REFUNDED_MANUAL',
          'CANCELLED'
        )
      ),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      expected_bank_account_id TEXT NOT NULL,
      num_ref TEXT,
      client_reference_id TEXT NOT NULL,
      provider_tx_id TEXT UNIQUE,
      mode TEXT NOT NULL,
      expected_method TEXT NOT NULL DEFAULT 'CODI',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      review_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_payment_intents_state
      ON payment_intents(state);

    CREATE TABLE IF NOT EXISTS webhook_events (
      webhook_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL,
      payload_redacted_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL REFERENCES payment_intents(id),
      event TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      provider_tx_id TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      detail_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_entries_intent_id
      ON ledger_entries(intent_id);

    CREATE TRIGGER IF NOT EXISTS trg_ledger_entries_no_update
    BEFORE UPDATE ON ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'ledger append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_ledger_entries_no_delete
    BEFORE DELETE ON ledger_entries
    BEGIN
      SELECT RAISE(ABORT, 'ledger append-only');
    END;

    CREATE TABLE IF NOT EXISTS outbox_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL REFERENCES payment_intents(id),
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT NOT NULL,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outbox_messages_status_next
      ON outbox_messages(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS payment_intent_details (
      intent_id TEXT PRIMARY KEY REFERENCES payment_intents(id),
      concept TEXT NOT NULL,
      external_ref TEXT NOT NULL,
      qr_payload TEXT NOT NULL,
      payment_link_url TEXT,
      customer_phone_masked TEXT,
      kadi_cuenta_id TEXT,
      kadi_sync_status TEXT NOT NULL DEFAULT 'not_configured',
      paid_at TEXT,
      kind TEXT NOT NULL DEFAULT 'clinical',
      pey_resource_id TEXT
    );

    CREATE TABLE IF NOT EXISTS webhook_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      clave_rastreo TEXT NOT NULL,
      received_at TEXT NOT NULL,
      duplicate INTEGER NOT NULL CHECK (duplicate IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS bank_accounts (
      id TEXT PRIMARY KEY,
      bank_account_id TEXT NOT NULL UNIQUE,
      clabe_masked TEXT NOT NULL,
      alias TEXT NOT NULL,
      holder_name TEXT NOT NULL,
      codi_status TEXT NOT NULL CHECK (
        codi_status IN ('BORRADOR', 'PENDING', 'PROCESSING', 'ACTIVE', 'ERROR')
      ),
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Executes `fn` inside a `BEGIN IMMEDIATE` SQLite transaction so write locks
 * are acquired up front and any failure rolls back atomically.
 */
export function withImmediateTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure if SQLite already aborted the transaction.
      }
    }
    throw err;
  }
}
