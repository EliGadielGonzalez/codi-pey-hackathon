import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookFailureReason =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'bad_signature';

export type WebhookVerificationResult =
  | { ok: true; webhookId: string }
  | { ok: false; reason: WebhookFailureReason };

export type HeaderInput =
  | Headers
  | Record<string, string | string[] | undefined>;

export interface VerifyStandardWebhookOptions {
  rawBody: string;
  headers: HeaderInput;
  secret: string;
  /** Tolerance window in seconds around `now` (default: 300s). */
  toleranceSeconds?: number;
  /** Injectable clock returning Unix epoch seconds (number or function). */
  now?: number | (() => number);
}

const DEFAULT_TOLERANCE_SECONDS = 300;
const SECRET_PREFIX = 'whsec_';

function readHeader(headers: HeaderInput, name: string): string | undefined {
  if (headers instanceof Headers) {
    const val = headers.get(name);
    return val === null ? undefined : val.trim();
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) {
      const first = value.find((v) => typeof v === 'string' && v.trim().length > 0);
      return first?.trim();
    }
    if (typeof value === 'string') {
      return value.trim();
    }
  }
  return undefined;
}

function decodeWebhookSecret(secret: string): Buffer {
  if (secret.startsWith(SECRET_PREFIX)) {
    return Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  }
  return Buffer.from(secret, 'utf8');
}

function resolveNowSeconds(now?: number | (() => number)): number {
  if (typeof now === 'function') {
    return now();
  }
  if (typeof now === 'number') {
    return now;
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * Verifies a Standard Webhooks signature against the exact raw body string.
 */
export function verifyStandardWebhook(
  options: VerifyStandardWebhookOptions,
): WebhookVerificationResult {
  const { rawBody, headers, secret } = options;
  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  if (typeof rawBody !== 'string') {
    return { ok: false, reason: 'bad_signature' };
  }

  const webhookId = readHeader(headers, 'webhook-id');
  const webhookTimestamp = readHeader(headers, 'webhook-timestamp');
  const webhookSignature = readHeader(headers, 'webhook-signature');

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { ok: false, reason: 'missing_headers' };
  }

  if (!/^\d+$/.test(webhookTimestamp)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  const parsedTimestamp = Number(webhookTimestamp);
  if (!Number.isSafeInteger(parsedTimestamp)) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  const nowSeconds = resolveNowSeconds(options.now);
  if (!Number.isFinite(nowSeconds)) {
    return { ok: false, reason: 'bad_timestamp' };
  }
  if (Math.abs(nowSeconds - parsedTimestamp) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  if (!secret) {
    return { ok: false, reason: 'bad_signature' };
  }
  const secretBytes = decodeWebhookSecret(secret);
  if (secretBytes.length === 0) {
    return { ok: false, reason: 'bad_signature' };
  }

  const signedPayload = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expectedBase64 = createHmac('sha256', secretBytes)
    .update(signedPayload, 'utf8')
    .digest('base64');
  const expectedBuf = Buffer.from(expectedBase64, 'utf8');

  const tokens = webhookSignature.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (!token.startsWith('v1,')) continue;
    const candidateSig = token.slice(3);
    if (!candidateSig) continue;

    const candidateBuf = Buffer.from(candidateSig, 'utf8');
    if (candidateBuf.length !== expectedBuf.length) continue;

    if (timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true, webhookId };
    }
  }

  return { ok: false, reason: 'bad_signature' };
}

export type WebhookVerifyOnceFailureReason = WebhookFailureReason | 'duplicate';

export type WebhookVerifyOnceResult =
  | { ok: true; webhookId: string }
  | { ok: false; reason: WebhookVerifyOnceFailureReason };

/**
 * Verifies a Standard Webhooks signature FIRST and only registers `webhook-id`
 * in `dedupe` after signature and timestamp verification succeed.
 */
export function verifyWebhookOnce(
  options: VerifyStandardWebhookOptions,
  dedupe: DedupeStore,
): WebhookVerifyOnceResult {
  const verified = verifyStandardWebhook(options);
  if (!verified.ok) {
    return verified;
  }
  if (dedupe.seen(verified.webhookId)) {
    return { ok: false, reason: 'duplicate' };
  }
  return verified;
}

/**
 * Deduplication store contract so EXEC-004 can swap in-memory tracking for SQLite.
 *
 * SECURITY: `seen()` MUST NEVER be called before signature verification succeeds;
 * otherwise unauthenticated callers can poison legitimate `webhook-id` values.
 * Prefer `verifyWebhookOnce(options, dedupe)`.
 */
export interface DedupeStore {
  seen(id: string): boolean;
}

/**
 * Bounded in-memory webhook-id deduplication store with FIFO eviction.
 *
 * SECURITY: `seen()` mutates state (check + insert). It MUST NEVER be called
 * before verifying the webhook signature — use `verifyWebhookOnce` instead.
 */
export class WebhookDedupe implements DedupeStore {
  private readonly ids = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    if (!Number.isInteger(maxSize) || maxSize <= 0) {
      throw new RangeError('maxSize must be a positive integer');
    }
    this.maxSize = maxSize;
  }

  seen(id: string): boolean {
    if (this.ids.has(id)) {
      return true;
    }
    if (this.ids.size >= this.maxSize) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) {
        this.ids.delete(oldest);
      }
    }
    this.ids.add(id);
    return false;
  }

  get size(): number {
    return this.ids.size;
  }
}
