import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  verifyStandardWebhook,
  verifyWebhookOnce,
  WebhookDedupe,
} from '../src/webhooks/verify.js';

function makeSignatureHeader(
  webhookId: string,
  timestamp: string,
  rawBody: string,
  secret: string,
): string {
  const key = secret.startsWith('whsec_')
    ? Buffer.from(secret.slice('whsec_'.length), 'base64')
    : Buffer.from(secret, 'utf8');
  const sig = createHmac('sha256', key)
    .update(`${webhookId}.${timestamp}.${rawBody}`, 'utf8')
    .digest('base64');
  return `v1,${sig}`;
}

describe('verifyStandardWebhook', () => {
  const whsecSecret = `whsec_${Buffer.from('super-secret-webhook-key-32bytes!', 'utf8').toString('base64')}`;
  const nowSeconds = 1_700_000_000;
  const rawBody = '{"id":"evt_1","status":"paid"}';

  it('accepts a valid whsec_ signed webhook and space-separated signature list', () => {
    const ts = String(nowSeconds);
    const validSig = makeSignatureHeader('msg_001', ts, rawBody, whsecSecret);

    const result = verifyStandardWebhook({
      rawBody,
      secret: whsecSecret,
      now: () => nowSeconds,
      headers: {
        'webhook-id': 'msg_001',
        'webhook-timestamp': ts,
        'webhook-signature': `v0,oldsig ${validSig}`,
      },
    });

    expect(result).toEqual({ ok: true, webhookId: 'msg_001' });
  });

  it('supports plain utf8 secrets without whsec_ prefix', () => {
    const utf8Secret = 'plain-utf8-webhook-secret';
    const ts = String(nowSeconds);
    const sig = makeSignatureHeader('msg_utf8', ts, rawBody, utf8Secret);

    const result = verifyStandardWebhook({
      rawBody,
      secret: utf8Secret,
      now: nowSeconds,
      headers: {
        'Webhook-Id': 'msg_utf8',
        'Webhook-Timestamp': ts,
        'Webhook-Signature': sig,
      },
    });

    expect(result).toEqual({ ok: true, webhookId: 'msg_utf8' });
  });

  it('rejects altered body and reformatted JSON', () => {
    const ts = String(nowSeconds);
    const sig = makeSignatureHeader('msg_002', ts, rawBody, whsecSecret);
    const headers = {
      'webhook-id': 'msg_002',
      'webhook-timestamp': ts,
      'webhook-signature': sig,
    };

    const altered = verifyStandardWebhook({
      rawBody: '{"id":"evt_2","status":"paid"}',
      secret: whsecSecret,
      now: nowSeconds,
      headers,
    });
    expect(altered).toEqual({ ok: false, reason: 'bad_signature' });

    const reformattedJson = JSON.stringify(JSON.parse(rawBody), null, 2);
    const reformatted = verifyStandardWebhook({
      rawBody: reformattedJson,
      secret: whsecSecret,
      now: nowSeconds,
      headers,
    });
    expect(reformatted).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects timestamp at 301s delta and accepts at 299s delta', () => {
    const rejectedTs = String(nowSeconds - 301);
    const rejectedSig = makeSignatureHeader('msg_301', rejectedTs, rawBody, whsecSecret);
    expect(
      verifyStandardWebhook({
        rawBody,
        secret: whsecSecret,
        now: nowSeconds,
        headers: {
          'webhook-id': 'msg_301',
          'webhook-timestamp': rejectedTs,
          'webhook-signature': rejectedSig,
        },
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });

    const acceptedTs = String(nowSeconds - 299);
    const acceptedSig = makeSignatureHeader('msg_299', acceptedTs, rawBody, whsecSecret);
    expect(
      verifyStandardWebhook({
        rawBody,
        secret: whsecSecret,
        now: nowSeconds,
        headers: {
          'webhook-id': 'msg_299',
          'webhook-timestamp': acceptedTs,
          'webhook-signature': acceptedSig,
        },
      }),
    ).toEqual({ ok: true, webhookId: 'msg_299' });
  });

  it('rejects missing headers, non-numeric timestamps, and malformed/wrong-length signatures safely', () => {
    expect(
      verifyStandardWebhook({
        rawBody,
        secret: whsecSecret,
        now: nowSeconds,
        headers: {
          'webhook-id': 'msg_missing',
          'webhook-timestamp': String(nowSeconds),
        },
      }),
    ).toEqual({ ok: false, reason: 'missing_headers' });

    expect(
      verifyStandardWebhook({
        rawBody,
        secret: whsecSecret,
        now: nowSeconds,
        headers: {
          'webhook-id': 'msg_bad_ts',
          'webhook-timestamp': 'not-a-number',
          'webhook-signature': 'v1,abc',
        },
      }),
    ).toEqual({ ok: false, reason: 'bad_timestamp' });

    expect(
      verifyStandardWebhook({
        rawBody,
        secret: whsecSecret,
        now: nowSeconds,
        headers: {
          'webhook-id': 'msg_short_sig',
          'webhook-timestamp': String(nowSeconds),
          'webhook-signature': 'v1,short malformed_token',
        },
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('WebhookDedupe', () => {
  it('tracks duplicate webhook IDs and enforces maxSize bound', () => {
    const dedupe = new WebhookDedupe(2);

    expect(dedupe.seen('wh_1')).toBe(false);
    expect(dedupe.seen('wh_1')).toBe(true);
    expect(dedupe.seen('wh_2')).toBe(false);
    expect(dedupe.size).toBe(2);

    // Adding a third evicts the oldest ('wh_1')
    expect(dedupe.seen('wh_3')).toBe(false);
    expect(dedupe.size).toBe(2);
    expect(dedupe.seen('wh_2')).toBe(true);
    expect(dedupe.seen('wh_1')).toBe(false);
  });

  it('verifyWebhookOnce does not consume webhook-id on invalid signature and rejects replay after valid signature', () => {
    const whsecSecret = `whsec_${Buffer.from('poison-test-secret-32-bytes-long', 'utf8').toString('base64')}`;
    const nowSeconds = 1_700_000_000;
    const ts = String(nowSeconds);
    const body = '{"id":"evt_poison","status":"paid"}';
    const dedupe = new WebhookDedupe(10);

    // 1. Invalid signature with legitimate webhook-id must NOT poison dedupe
    const badAttempt = verifyWebhookOnce(
      {
        rawBody: body,
        secret: whsecSecret,
        now: nowSeconds,
        headers: {
          'webhook-id': 'msg_legit_1',
          'webhook-timestamp': ts,
          'webhook-signature': 'v1,invalid_signature',
        },
      },
      dedupe,
    );
    expect(badAttempt).toEqual({ ok: false, reason: 'bad_signature' });

    // 2. Same webhook-id with valid signature is accepted once
    const validSig = makeSignatureHeader('msg_legit_1', ts, body, whsecSecret);
    const firstValid = verifyWebhookOnce(
      {
        rawBody: body,
        secret: whsecSecret,
        now: nowSeconds,
        headers: {
          'webhook-id': 'msg_legit_1',
          'webhook-timestamp': ts,
          'webhook-signature': validSig,
        },
      },
      dedupe,
    );
    expect(firstValid).toEqual({ ok: true, webhookId: 'msg_legit_1' });

    // 3. Second delivery with valid signature is rejected as duplicate
    const secondValid = verifyWebhookOnce(
      {
        rawBody: body,
        secret: whsecSecret,
        now: nowSeconds,
        headers: {
          'webhook-id': 'msg_legit_1',
          'webhook-timestamp': ts,
          'webhook-signature': validSig,
        },
      },
      dedupe,
    );
    expect(secondValid).toEqual({ ok: false, reason: 'duplicate' });
  });
});
