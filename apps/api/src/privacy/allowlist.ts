export const REDACTION_MARKER = '[REDACTED_BY_ALLOWLIST]';

const ALLOWED_STRICT_TOKEN_KEYS = new Set([
  'id',
  'transactionid',
  'type',
  'status',
  'paymentmethod',
  'numref',
  'clientreferenceid',
]);

const ALLOWED_TIMESTAMP_KEYS = new Set([
  'datepaid',
  'createdat',
  'expiration',
]);

const ALLOWED_AMOUNT_KEYS = new Set(['amount']);

const STRICT_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const BARE_PHONE_PATTERN = /^\d{10,15}$/;
const SAFE_TIMESTAMP_PATTERN = /^[0-9TZ:.+-]{8,40}$/;

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeStrictToken(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'string') {
    return REDACTION_MARKER;
  }
  if (!STRICT_TOKEN_PATTERN.test(value) || BARE_PHONE_PATTERN.test(value)) {
    return REDACTION_MARKER;
  }
  return value;
}

function sanitizeTimestamp(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' && SAFE_TIMESTAMP_PATTERN.test(value)) {
    return value;
  }
  return REDACTION_MARKER;
}

function sanitizeAmount(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return REDACTION_MARKER;
}

function maskBankAccountId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return REDACTION_MARKER;
  }
  if (value.length <= 4) {
    return '****';
  }
  return `****${value.slice(-4)}`;
}

function redactAmountBreakdown(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return REDACTION_MARKER;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (normalizeKey(key) === 'base') {
      result[key] = sanitizeAmount(entry);
    }
  }
  return result;
}

function redactNode(input: unknown, seen: WeakSet<object>): unknown {
  if (input === null || input === undefined) {
    return input;
  }
  if (typeof input !== 'object') {
    return input;
  }
  if (input instanceof Date) {
    return input.toISOString();
  }
  if (seen.has(input)) {
    return REDACTION_MARKER;
  }

  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((item) => redactNode(item, seen));
  }

  if (!isPlainRecord(input)) {
    return REDACTION_MARKER;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = normalizeKey(key);

    if (normalized === 'bankaccountid') {
      out[key] = maskBankAccountId(value);
      continue;
    }

    if (normalized === 'amountbreakdown') {
      out[key] = redactAmountBreakdown(value);
      continue;
    }

    if (normalized === 'transactions') {
      out[key] = Array.isArray(value)
        ? value.map((item) => redactNode(item, seen))
        : REDACTION_MARKER;
      continue;
    }

    if (ALLOWED_STRICT_TOKEN_KEYS.has(normalized)) {
      out[key] = sanitizeStrictToken(value);
      continue;
    }

    if (ALLOWED_TIMESTAMP_KEYS.has(normalized)) {
      out[key] = sanitizeTimestamp(value);
      continue;
    }

    if (ALLOWED_AMOUNT_KEYS.has(normalized)) {
      out[key] = sanitizeAmount(value);
      continue;
    }

    out[key] = REDACTION_MARKER;
  }

  return out;
}

/**
 * Recursively redacts any object or array using a strict allowlist.
 * Non-allowlisted keys (including nested metadata/externalMetadata and PII)
 * are replaced with "[REDACTED_BY_ALLOWLIST]". Never mutates the input.
 */
export function allowlistRedact(input: unknown): unknown {
  return redactNode(input, new WeakSet<object>());
}
