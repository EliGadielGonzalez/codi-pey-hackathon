import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signPeyPayload } from '../src/hmac.js';

const TEST_SECRET = 'test-webhook-secret';

describe('CoDi + pey API', () => {
  it('creates a QR payment intent and retrieves it', async () => {
    const app = createApp({ peyMode: 'mock', peyWebhookSecret: TEST_SECRET });

    const createRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 250.5,
        concept: 'Consulta veterinaria',
        external_ref: 'ORD-001',
        mode: 'qr',
      }),
    });

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.status).toBe('pending');
    expect(created.qr_payload).toContain('ORD-001');

    const getRes = await app.request(`/api/v1/payments/codi/intents/${created.intent_id}`);
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.intent_id).toBe(created.intent_id);
  });

  it('rejects webhook with invalid HMAC signature', async () => {
    const app = createApp({ peyMode: 'mock', peyWebhookSecret: TEST_SECRET });
    const res = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pey-signature': 'sha256=bad' },
      body: JSON.stringify({
        event_id: 'evt_1',
        intent_id: 'codi_1',
        status: 'paid',
        clave_rastreo: 'CR1',
        amount_mxn: 100,
      }),
    });
    expect(res.status).toBe(401);
  });

  it('processes valid webhook and enforces idempotency on duplicates', async () => {
    const app = createApp({ peyMode: 'mock', peyWebhookSecret: TEST_SECRET });

    const createRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 100,
        concept: 'Vacuna',
        external_ref: 'ORD-002',
        mode: 'qr',
      }),
    });
    const created = await createRes.json();

    const body = JSON.stringify({
      event_id: 'evt_unique_1',
      intent_id: created.intent_id,
      status: 'paid',
      clave_rastreo: 'CODI999888',
      amount_mxn: 100,
    });
    const sig = signPeyPayload(body, TEST_SECRET);

    const first = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pey-signature': `sha256=${sig}` },
      body,
    });
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.idempotent).toBe(false);
    expect(firstJson.intent.status).toBe('paid');

    const second = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-pey-signature': `sha256=${sig}` },
      body,
    });
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.idempotent).toBe(true);
  });

  it('simulates payment in mock mode', async () => {
    const app = createApp({ peyMode: 'mock', peyWebhookSecret: TEST_SECRET });
    const createRes = await app.request('/api/v1/payments/codi/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount_mxn: 420,
        concept: 'Estética',
        external_ref: 'ORD-003',
        mode: 'request_to_pay',
        customer_phone: '5512345678',
      }),
    });
    const created = await createRes.json();

    const simRes = await app.request(`/api/v1/sandbox/simulate-pay/${created.intent_id}`, {
      method: 'POST',
    });
    expect(simRes.status).toBe(200);
    const simJson = await simRes.json();
    expect(simJson.intent.status).toBe('paid');
  });
});
