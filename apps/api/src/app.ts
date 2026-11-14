import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  CreateIntentInputSchema,
  PeyWebhookEventSchema,
  type PaymentIntent,
} from '@codi-pey/contracts';
import { signPeyPayload, verifyPeySignature } from './hmac.js';
import { syncPaymentToKadi } from './kadi-bridge.js';
import { InMemoryPaymentStore } from './store.js';

export interface AppConfig {
  peyMode: 'mock' | 'sandbox' | 'live';
  peyWebhookSecret: string;
  kadiBaseUrl?: string;
  kadiBearerToken?: string;
}

export function createApp(config: AppConfig, store = new InMemoryPaymentStore()) {
  const app = new Hono();
  app.use('*', cors());

  app.get('/health', (c) => {
    return c.json({ ok: true, mode: config.peyMode, kadi_bridge: Boolean(config.kadiBaseUrl) });
  });

  app.get('/api/v1/payments/codi/intents', (c) => {
    return c.json({ items: store.listIntents(), webhooks: store.listWebhookLogs() });
  });

  app.post('/api/v1/payments/codi/intents', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateIntentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const input = parsed.data;
    const now = new Date();
    const expires = new Date(now.getTime() + 5 * 60 * 1000);
    const intentId = `codi_${randomUUID().slice(0, 12)}`;

    const qrPayload = JSON.stringify({
      v: 1,
      type: input.mode,
      intent_id: intentId,
      amount_mxn: input.amount_mxn,
      concept: input.concept,
      ref: input.external_ref,
      exp: expires.toISOString(),
    });

    const intent: PaymentIntent = {
      intent_id: intentId,
      amount_mxn: input.amount_mxn,
      concept: input.concept,
      external_ref: input.external_ref,
      mode: input.mode,
      customer_phone: input.customer_phone,
      status: 'pending',
      qr_payload: qrPayload,
      kadi_cuenta_id: input.kadi_cuenta_id,
      kadi_sync_status: config.kadiBaseUrl && input.kadi_cuenta_id ? 'pending' : 'not_configured',
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    };

    store.saveIntent(intent);
    return c.json(intent, 201);
  });

  app.get('/api/v1/payments/codi/intents/:id', (c) => {
    const intent = store.getIntent(c.req.param('id'));
    if (!intent) return c.json({ error: 'NOT_FOUND' }, 404);
    return c.json(intent);
  });

  app.post('/api/v1/webhooks/pey', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('x-pey-signature');

    if (!verifyPeySignature(rawBody, signature, config.peyWebhookSecret)) {
      return c.json({ error: 'INVALID_SIGNATURE' }, 401);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'INVALID_JSON' }, 400);
    }

    const parsed = PeyWebhookEventSchema.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() }, 400);
    }

    const event = parsed.data;
    const intent = store.getIntent(event.intent_id);
    if (!intent) {
      return c.json({ error: 'INTENT_NOT_FOUND' }, 404);
    }

    if (store.hasProcessedWebhook(event.event_id, event.clave_rastreo)) {
      store.recordDuplicateWebhook({
        event_id: event.event_id,
        intent_id: event.intent_id,
        status: event.status,
        clave_rastreo: event.clave_rastreo,
        received_at: new Date().toISOString(),
        duplicate: true,
      });
      return c.json({ ok: true, idempotent: true, intent });
    }

    intent.status = event.status;
    intent.clave_rastreo = event.clave_rastreo;
    intent.paid_at = event.paid_at || new Date().toISOString();

    if (event.status === 'paid') {
      const kadiToken = c.req.header('x-kadi-token') || config.kadiBearerToken;
      intent.kadi_sync_status = await syncPaymentToKadi(intent, {
        kadiBaseUrl: config.kadiBaseUrl,
        kadiBearerToken: kadiToken,
      });
    }

    store.saveIntent(intent);
    store.markWebhookProcessed({
      event_id: event.event_id,
      intent_id: event.intent_id,
      status: event.status,
      clave_rastreo: event.clave_rastreo,
      received_at: new Date().toISOString(),
      duplicate: false,
    });

    return c.json({ ok: true, idempotent: false, intent });
  });

  app.post('/api/v1/sandbox/simulate-pay/:id', async (c) => {
    if (config.peyMode !== 'mock') {
      return c.json({ error: 'SANDBOX_DISABLED' }, 403);
    }

    const intent = store.getIntent(c.req.param('id'));
    if (!intent) return c.json({ error: 'NOT_FOUND' }, 404);

    const eventPayload = JSON.stringify({
      event_id: `evt_${randomUUID().slice(0, 10)}`,
      intent_id: intent.intent_id,
      status: 'paid',
      clave_rastreo: `CODI${Date.now()}`,
      amount_mxn: intent.amount_mxn,
      paid_at: new Date().toISOString(),
    });

    const sig = signPeyPayload(eventPayload, config.peyWebhookSecret);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-pey-signature': `sha256=${sig}`,
    };
    const kadiToken = c.req.header('x-kadi-token');
    if (kadiToken) headers['x-kadi-token'] = kadiToken;

    const webhookRes = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers,
      body: eventPayload,
    });

    const result = await webhookRes.json();
    return c.json(result, webhookRes.status as 200);
  });

  return app;
}
