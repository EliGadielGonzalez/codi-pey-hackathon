import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  CreateIntentInputSchema,
  KillSwitchInputSchema,
  ManualFallbackInputSchema,
  ManualReviewResolveInputSchema,
  OnboardingBankAccountInputSchema,
  PeyWebhookEventSchema,
  SimulateBankStatusInputSchema,
  SubscriptionCheckoutInputSchema,
  type ExternalLedgerPort,
  type LedgerEntry,
  type PaymentIntent,
  type PeyVerifyPayload,
  type SubscriptionPlan,
} from '@codi-pey/contracts';
import { PaymentRepo, type PaymentIntentRecord } from './db/payment-repo.js';
import { migrate, openDb } from './db/sqlite.js';
import { signPeyPayload, verifyPeySignature } from './hmac.js';
import { drainOutbox } from './jobs/outbox.js';
import { reconcileOnce } from './jobs/reconciler.js';
import { syncPaymentToKadi } from './kadi-bridge.js';
import {
  PeyApiError,
  PeyClient,
  PeyUncertainCreateError,
  toCents,
} from './pey/client.js';
import { allowlistRedact } from './privacy/allowlist.js';
import { verifyWebhookOnce } from './webhooks/verify.js';

export interface AppConfig {
  peyMode: 'mock' | 'sandbox' | 'live';
  peyWebhookSecret: string;
  kadiBaseUrl?: string;
  kadiBearerToken?: string;
  expectedBankAccountId?: string;
  subscriptionPaymentLinkUrl?: string;
}

export interface AppDeps {
  db?: DatabaseSync;
  repo?: PaymentRepo;
  peyClient?: PeyClient;
  ledgerPort?: ExternalLedgerPort;
  fetchPeyStatus?: (
    intent: PaymentIntentRecord,
  ) => Promise<PeyVerifyPayload | null | undefined>;
}

const DEFAULT_BANK_ACCOUNT_ID = '01TESTBANKACCOUNT0000';
const DEFAULT_SUBSCRIPTION_LINK = 'https://app.pey.mx/p/gadypo';
const INSECURE_DEFAULT_SECRETS = new Set([
  'dev-only-webhook-secret',
  'change-me',
  'secret',
]);
const EIGHTEEN_DIGIT_PATTERN = /(?<!\d)\d{18}(?!\d)/;

const SUBSCRIPTION_PLANS: Record<
  SubscriptionPlan,
  { amountMxn: number; concept: string }
> = {
  mensual: { amountMxn: 990, concept: 'Suscripción KADI Mensual' },
  hospital_pro: { amountMxn: 2490, concept: 'Suscripción KADI Hospital Pro' },
  anual: { amountMxn: 7900, concept: 'Suscripción KADI Anual' },
};

function maskPhone(phone?: string): string | null {
  if (!phone || phone.length < 4) return null;
  return `******${phone.slice(-4)}`;
}

function generateSyntheticUlid(prefix: string): string {
  const raw = randomUUID().replace(/-/g, '').toUpperCase();
  return `${prefix}${raw.slice(0, 22)}`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function createApp(config: AppConfig, deps: AppDeps = {}) {
  const isProdLike =
    config.peyMode === 'live' || process.env.NODE_ENV === 'production';

  if (
    isProdLike &&
    (!config.peyWebhookSecret ||
      config.peyWebhookSecret.trim().length < 16 ||
      INSECURE_DEFAULT_SECRETS.has(config.peyWebhookSecret.trim()))
  ) {
    throw new Error(
      'PEY_WEBHOOK_SECRET must be a strong secret in live/production mode',
    );
  }

  const db = deps.db ?? openDb(':memory:');
  if (!deps.repo) {
    migrate(db);
  }
  const repo = deps.repo ?? new PaymentRepo(db);
  const peyClient = deps.peyClient;
  const subscriptionLinkBase =
    config.subscriptionPaymentLinkUrl || DEFAULT_SUBSCRIPTION_LINK;

  const resolveExpectedBankAccountId = (): string => {
    const active = repo.getActiveBankAccount();
    if (active) return active.bank_account_id;
    return config.expectedBankAccountId || DEFAULT_BANK_ACCOUNT_ID;
  };

  const isKadiConfiguredForIntent = (intentId: string): boolean => {
    const details = repo.getIntentDetails(intentId);
    return Boolean(
      config.kadiBaseUrl &&
        config.kadiBearerToken &&
        details?.kadi_cuenta_id,
    );
  };

  const syncKadiStatusForIntent = (intentId: string): void => {
    const record = repo.getById(intentId);
    if (!record) return;
    const configured = isKadiConfiguredForIntent(intentId);

    if (record.state === 'APPLIED') {
      repo.updateIntentDetails(intentId, {
        kadiSyncStatus: configured ? 'synced' : 'not_configured',
      });
    } else if (record.state === 'PENDING_CAJA' || record.state === 'PAID_VERIFIED') {
      repo.updateIntentDetails(intentId, {
        kadiSyncStatus: configured ? 'pending' : 'not_configured',
      });
    } else if (record.state === 'MANUAL_REVIEW') {
      repo.updateIntentDetails(intentId, {
        kadiSyncStatus: configured ? 'failed' : 'not_configured',
      });
    }
  };

  const resolvedLedgerPort: ExternalLedgerPort = deps.ledgerPort ?? {
    async apply(entry: LedgerEntry) {
      const intentView = repo.getIntentView(entry.intentId);
      if (
        !intentView ||
        !config.kadiBaseUrl ||
        !config.kadiBearerToken ||
        !intentView.kadi_cuenta_id
      ) {
        return { status: 'applied', reason: 'standalone_local_ledger' };
      }

      const status = await syncPaymentToKadi(intentView, {
        kadiBaseUrl: config.kadiBaseUrl,
        kadiBearerToken: config.kadiBearerToken,
      });

      if (status === 'synced') {
        return { status: 'applied' };
      }
      if (status === 'not_configured') {
        return { status: 'applied', reason: 'not_configured' };
      }
      throw new Error('KADI ledger bridge sync failed');
    },
  };

  const resolveFetchStatus = (): ((
    intent: PaymentIntentRecord,
  ) => Promise<PeyVerifyPayload | null | undefined>) => {
    if (deps.fetchPeyStatus) {
      return deps.fetchPeyStatus;
    }
    if (peyClient && config.peyMode !== 'mock') {
      return async (intent) => {
        const details = repo.getIntentDetails(intent.id);
        const resourceId = details?.pey_resource_id || intent.id;
        if (intent.mode === 'payment_link') {
          return peyClient.getPaymentLink(resourceId);
        }
        const qrTx = await peyClient.getCodiQrTransactions(resourceId);
        return {
          id: qrTx.id ?? resourceId,
          status:
            Array.isArray(qrTx.transactions) &&
            qrTx.transactions.some((t) => t.status === 'paid')
              ? 'paid'
              : 'pending',
          transactions: qrTx.transactions,
        };
      };
    }
    return async () => ({ status: 'pending' });
  };

  const app = new Hono();
  app.use('*', cors());

  app.get('/health', (c) => {
    return c.json({
      ok: true,
      mode: config.peyMode,
      kadi_bridge: Boolean(config.kadiBaseUrl),
      codi_enabled: repo.getKillSwitchEnabled(),
    });
  });

  app.get('/api/v1/config/kill-switch', (c) => {
    return c.json({ enabled: repo.getKillSwitchEnabled() });
  });

  app.post('/api/v1/config/kill-switch', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = KillSwitchInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }
    const result = repo.setKillSwitchEnabled(parsed.data.enabled);
    return c.json(result);
  });

  app.get('/api/v1/payments/codi/intents', (c) => {
    return c.json({
      items: repo.listIntentViews(),
      webhooks: repo.listWebhookLogs(),
      ledger: repo.listAllLedgerEntries(100),
      codi_enabled: repo.getKillSwitchEnabled(),
    });
  });

  app.post('/api/v1/payments/codi/intents', async (c) => {
    if (!repo.getKillSwitchEnabled()) {
      return c.json(
        {
          error: 'CODI_DISABLED',
          message:
            'El cobro CoDi está apagado temporalmente. Usa cobro manual en efectivo, tarjeta o transferencia en caja.',
          manual_fallback_recommended: true,
        },
        503,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = CreateIntentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const input = parsed.data;
    const now = new Date();
    const expires = new Date(now.getTime() + 5 * 60 * 1000);
    const intentId = `codi_${randomUUID().slice(0, 12)}`;
    const amountCents = toCents(input.amount_mxn);
    const expectedBankAccountId = resolveExpectedBankAccountId();
    const kadiSyncStatus =
      config.kadiBaseUrl && input.kadi_cuenta_id ? 'pending' : 'not_configured';

    let qrPayload = JSON.stringify({
      v: 1,
      type: input.mode,
      intent_id: intentId,
      amount_mxn: input.amount_mxn,
      concept: input.concept,
      ref: input.external_ref,
      exp: expires.toISOString(),
    });
    let paymentLinkUrl: string | null =
      input.mode === 'payment_link'
        ? `${subscriptionLinkBase}?ref=${encodeURIComponent(intentId)}&amount=${input.amount_mxn}`
        : null;
    if (paymentLinkUrl) {
      qrPayload = paymentLinkUrl;
    }

    if (peyClient && config.peyMode !== 'mock') {
      repo.createIntentWithDetails({
        id: intentId,
        state: 'CREATING',
        amountCents,
        expectedBankAccountId,
        clientReferenceId: input.external_ref,
        mode: input.mode,
        expectedMethod: 'CODI',
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
        concept: input.concept,
        externalRef: input.external_ref,
        qrPayload,
        paymentLinkUrl,
        customerPhoneMasked: maskPhone(input.customer_phone),
        kadiCuentaId: input.kadi_cuenta_id ?? null,
        kadiSyncStatus,
        kind: 'clinical',
      });

      try {
        const res =
          input.mode === 'request_to_pay'
            ? await peyClient.createCodiPushNotification({
                amount: input.amount_mxn,
                phone: input.customer_phone!,
                clientReferenceId: input.external_ref,
                concept: input.concept,
                bankAccountId: expectedBankAccountId,
                expiration: expires.toISOString(),
              })
            : input.mode === 'payment_link'
              ? await peyClient.createPaymentLink({
                  amount: input.amount_mxn,
                  clientReferenceId: input.external_ref,
                  concept: input.concept,
                  bankAccountId: expectedBankAccountId,
                  expiration: expires.toISOString(),
                })
              : await peyClient.createCodiQr({
                  amount: input.amount_mxn,
                  clientReferenceId: input.external_ref,
                  concept: input.concept,
                  bankAccountId: expectedBankAccountId,
                  expiration: expires.toISOString(),
                });

        repo.updateIntentDetails(intentId, {
          peyResourceId: res.id,
          qrPayload: res.qrPayload ?? res.url ?? qrPayload,
          paymentLinkUrl: res.url ?? paymentLinkUrl,
        });
        repo.transition(intentId, 'PENDING_PAYMENT', {
          actor: 'api',
          event: 'PEY_RESOURCE_CREATED',
          detail: { peyResourceId: res.id },
        });
        return c.json(repo.getIntentView(intentId)!, 201);
      } catch (err) {
        if (err instanceof PeyUncertainCreateError) {
          repo.transition(intentId, 'UNCERTAIN_CREATE', {
            actor: 'api',
            event: 'PEY_UNCERTAIN_CREATE',
            reviewReason: 'uncertain_create_timeout',
          });
          return c.json(repo.getIntentView(intentId)!, 202);
        }
        if (err instanceof PeyApiError) {
          repo.transition(intentId, 'UNCERTAIN_CREATE', {
            actor: 'api',
            event: 'PEY_CREATE_REJECTED',
          });
          repo.transition(intentId, 'CANCELLED', {
            actor: 'api',
            event: 'PEY_CREATE_CANCELLED',
            detail: { statusCode: err.statusCode },
          });
          return c.json(
            { error: 'PEY_REJECTED', statusCode: err.statusCode },
            502,
          );
        }
        throw err;
      }
    }

    const created = repo.createIntentWithDetails({
      id: intentId,
      state: 'PENDING_PAYMENT',
      amountCents,
      expectedBankAccountId,
      clientReferenceId: input.external_ref,
      mode: input.mode,
      expectedMethod: 'CODI',
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      concept: input.concept,
      externalRef: input.external_ref,
      qrPayload,
      paymentLinkUrl,
      customerPhoneMasked: maskPhone(input.customer_phone),
      kadiCuentaId: input.kadi_cuenta_id ?? null,
      kadiSyncStatus,
      kind: 'clinical',
    });

    return c.json(created, 201);
  });

  app.get('/api/v1/payments/codi/intents/:id', (c) => {
    const intent = repo.getIntentView(c.req.param('id'));
    if (!intent) return c.json({ error: 'NOT_FOUND' }, 404);
    return c.json(intent);
  });

  app.post('/api/v1/payments/codi/intents/:id/manual-fallback', async (c) => {
    const id = c.req.param('id');
    const existing = repo.getById(id);
    if (!existing) return c.json({ error: 'NOT_FOUND' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const parsed = ManualFallbackInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    if (
      existing.state === 'PENDING_PAYMENT' ||
      existing.state === 'UNCERTAIN_CREATE'
    ) {
      repo.transition(id, 'CANCELLED', {
        actor: 'cashier_manual_fallback',
        event: 'MANUAL_FALLBACK_ACTIVATED',
        detail: {
          fallbackMethod: parsed.data.method,
          note: parsed.data.note ?? 'Cobro manual en caja',
        },
      });
    }

    return c.json({
      ok: true,
      fallback_method: parsed.data.method,
      intent: repo.getIntentView(id),
    });
  });

  app.post('/api/v1/webhooks/pey', async (c) => {
    const rawBody = await c.req.text();
    const hasStandardHeaders = Boolean(
      c.req.header('webhook-id') ||
        c.req.header('webhook-timestamp') ||
        c.req.header('webhook-signature'),
    );
    const legacyMockSig = c.req.header('x-pey-signature');

    let verifiedWebhookId: string | null = null;
    let usedStandardWebhooks = false;

    if (hasStandardHeaders || config.peyMode !== 'mock') {
      usedStandardWebhooks = true;
      const verified = verifyWebhookOnce(
        {
          rawBody,
          headers: c.req.raw.headers,
          secret: config.peyWebhookSecret,
        },
        repo,
      );

      if (!verified.ok) {
        if (verified.reason === 'duplicate') {
          let dupMeta: Record<string, unknown> = {};
          try {
            dupMeta = allowlistRedact(JSON.parse(rawBody)) as Record<
              string,
              unknown
            >;
          } catch {
            dupMeta = {};
          }
          const dupIntentId =
            typeof dupMeta.intent_id === 'string'
              ? dupMeta.intent_id
              : 'unknown';
          const dupClave =
            typeof dupMeta.clave_rastreo === 'string'
              ? dupMeta.clave_rastreo
              : c.req.header('webhook-id') || 'dup';
          const dupEventId =
            typeof dupMeta.event_id === 'string'
              ? dupMeta.event_id
              : c.req.header('webhook-id') || 'dup';
          repo.recordWebhookLog({
            event_id: dupEventId,
            intent_id: dupIntentId,
            status:
              typeof dupMeta.status === 'string' ? dupMeta.status : 'duplicate',
            clave_rastreo: dupClave,
            received_at: new Date().toISOString(),
            duplicate: true,
          });
          const existingIntent =
            dupIntentId !== 'unknown'
              ? repo.getIntentView(dupIntentId)
              : undefined;
          return c.json({
            ok: true,
            idempotent: true,
            ...(existingIntent ? { intent: existingIntent } : {}),
          });
        }
        return c.json(
          { error: 'INVALID_SIGNATURE', reason: verified.reason },
          401,
        );
      }
      verifiedWebhookId = verified.webhookId;
    } else {
      if (
        !verifyPeySignature(rawBody, legacyMockSig, config.peyWebhookSecret)
      ) {
        return c.json({ error: 'INVALID_SIGNATURE' }, 401);
      }
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'INVALID_JSON' }, 400);
    }

    if (usedStandardWebhooks && verifiedWebhookId) {
      repo.updateWebhookRedactedPayload(verifiedWebhookId, json);
    }

    const parsed = PeyWebhookEventSchema.safeParse(json);
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const event = parsed.data;
    const intent = repo.getById(event.intent_id);
    if (!intent) {
      return c.json({ error: 'INTENT_NOT_FOUND' }, 404);
    }

    if (!usedStandardWebhooks) {
      const isNewEvent = repo.registerWebhookOnce(event.event_id, json);
      if (!isNewEvent || repo.hasProcessedProviderTx(event.clave_rastreo)) {
        repo.recordWebhookLog({
          event_id: event.event_id,
          intent_id: event.intent_id,
          status: event.status,
          clave_rastreo: event.clave_rastreo,
          received_at: new Date().toISOString(),
          duplicate: true,
        });
        return c.json({
          ok: true,
          idempotent: true,
          intent: repo.getIntentView(intent.id),
        });
      }
    } else if (repo.hasProcessedProviderTx(event.clave_rastreo)) {
      repo.recordWebhookLog({
        event_id: event.event_id,
        intent_id: event.intent_id,
        status: event.status,
        clave_rastreo: event.clave_rastreo,
        received_at: new Date().toISOString(),
        duplicate: true,
      });
      return c.json({
        ok: true,
        idempotent: true,
        intent: repo.getIntentView(intent.id),
      });
    }

    const nowIso = event.paid_at || new Date().toISOString();

    if (event.status === 'paid') {
      const incomingCents = toCents(event.amount_mxn);
      if (intent.state === 'EXPIRED') {
        repo.transition(intent.id, 'MANUAL_REVIEW', {
          actor: 'webhook',
          event: 'LATE_PAYMENT_WEBHOOK',
          reviewReason: 'late_payment',
          detail: { payload: json, clave_rastreo: event.clave_rastreo },
          nowIso,
        });
      } else if (incomingCents !== intent.amount_cents) {
        if (
          intent.state === 'PENDING_PAYMENT' ||
          intent.state === 'UNCERTAIN_CREATE'
        ) {
          repo.transition(intent.id, 'MANUAL_REVIEW', {
            actor: 'webhook',
            event: 'VERIFY_PAID_MISMATCH',
            reviewReason: 'amount_mismatch',
            detail: { payload: json, expectedCents: intent.amount_cents, incomingCents },
            nowIso,
          });
        }
      } else if (
        intent.state === 'PENDING_PAYMENT' ||
        intent.state === 'UNCERTAIN_CREATE'
      ) {
        if (intent.state === 'UNCERTAIN_CREATE') {
          repo.transition(intent.id, 'PENDING_PAYMENT', {
            actor: 'webhook',
            event: 'UNCERTAIN_CREATE_CONFIRMED',
            nowIso,
          });
        }

        const entry: LedgerEntry = {
          idempotencyKey: event.clave_rastreo,
          intentId: intent.id,
          amountCents: intent.amount_cents,
          method: intent.expected_method,
          providerTxId: event.clave_rastreo,
          accountRef: intent.expected_bank_account_id,
          paidAtIso: nowIso,
        };

        repo.markPaidVerified(intent.id, event.clave_rastreo, entry, {
          actor: 'webhook',
          nowIso,
          detail: { payload: json },
        });
        repo.updateIntentDetails(intent.id, { paidAt: nowIso });

        await drainOutbox({
          repo,
          ledger: resolvedLedgerPort,
          now: nowIso,
        });
        syncKadiStatusForIntent(intent.id);
      }
    } else if (event.status === 'expired') {
      if (
        intent.state === 'PENDING_PAYMENT' ||
        intent.state === 'UNCERTAIN_CREATE'
      ) {
        repo.transition(intent.id, 'EXPIRED', {
          actor: 'webhook',
          event: 'WEBHOOK_EXPIRED',
          detail: { payload: json },
          nowIso,
        });
      }
    } else if (event.status === 'failed') {
      if (
        intent.state === 'PENDING_PAYMENT' ||
        intent.state === 'UNCERTAIN_CREATE'
      ) {
        repo.transition(intent.id, 'CANCELLED', {
          actor: 'webhook',
          event: 'WEBHOOK_FAILED',
          detail: { payload: json },
          nowIso,
        });
      }
    }

    repo.recordWebhookLog({
      event_id: event.event_id,
      intent_id: event.intent_id,
      status: event.status,
      clave_rastreo: event.clave_rastreo,
      received_at: new Date().toISOString(),
      duplicate: false,
    });

    return c.json({
      ok: true,
      idempotent: false,
      intent: repo.getIntentView(intent.id),
    });
  });

  app.post('/api/v1/sandbox/simulate-pay/:id', async (c) => {
    if (config.peyMode !== 'mock') {
      return c.json({ error: 'SANDBOX_DISABLED' }, 403);
    }

    const intent = repo.getIntentView(c.req.param('id'));
    if (!intent) return c.json({ error: 'NOT_FOUND' }, 404);

    const eventPayload = JSON.stringify({
      event_id: `evt_${randomUUID().slice(0, 10)}`,
      intent_id: intent.intent_id,
      status: 'paid',
      clave_rastreo: `CODI${Date.now()}${randomUUID().slice(0, 4)}`,
      amount_mxn: intent.amount_mxn,
      paid_at: new Date().toISOString(),
    });

    const sig = signPeyPayload(eventPayload, config.peyWebhookSecret);
    const webhookRes = await app.request('/api/v1/webhooks/pey', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-pey-signature': `sha256=${sig}`,
      },
      body: eventPayload,
    });

    const result = await webhookRes.json();
    return c.json(result, webhookRes.status as 200);
  });

  app.get('/api/v1/onboarding/bank-account', (c) => {
    return c.json({
      account: repo.getLatestBankAccount() ?? null,
      accounts: repo.listBankAccounts(),
      banxico_sla_business_days: 5,
    });
  });

  app.post('/api/v1/onboarding/bank-account', async (c) => {
    const rawText = await c.req.text();
    if (EIGHTEEN_DIGIT_PATTERN.test(rawText)) {
      return c.json(
        {
          error: 'CLABE_PLAINTEXT_FORBIDDEN',
          message:
            'Por seguridad, no envíes ni almacenes una CLABE de 18 dígitos en claro. Envía únicamente clabeLast4 y una referencia tokenizada.',
        },
        400,
      );
    }

    let body: unknown = null;
    try {
      body = JSON.parse(rawText);
    } catch {
      return c.json({ error: 'INVALID_JSON' }, 400);
    }

    const parsed = OnboardingBankAccountInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const input = parsed.data;
    const clabeMasked = `****${input.clabeLast4}`;

    if (peyClient && config.peyMode !== 'mock') {
      try {
        const res = await peyClient.registerBankAccount({
          clabeLast4: input.clabeLast4,
          alias: input.alias,
          holderName: input.holderName,
          clabeTokenOrEnvRef: input.clabeTokenOrEnvRef,
        });
        const account = repo.upsertBankAccount({
          id: res.id,
          bankAccountId: res.bankAccountId,
          clabeMasked: res.clabeMasked ?? clabeMasked,
          alias: res.alias ?? input.alias,
          holderName: res.holderName ?? input.holderName,
          codiStatus: res.status,
          errorMessage: res.errorMessage ?? null,
        });
        return c.json({ account, banxico_sla_business_days: 5 }, 201);
      } catch (err) {
        if (err instanceof PeyApiError) {
          return c.json(
            { error: 'PEY_BANK_ACCOUNT_REJECTED', statusCode: err.statusCode },
            502,
          );
        }
        return c.json({ error: 'PEY_BANK_ACCOUNT_UNCERTAIN' }, 503);
      }
    }

    const bankAccountId = generateSyntheticUlid('01BA');
    const account = repo.upsertBankAccount({
      id: bankAccountId,
      bankAccountId,
      clabeMasked,
      alias: input.alias,
      holderName: input.holderName,
      codiStatus: input.initialStatus ?? 'PENDING',
      errorMessage: null,
    });

    return c.json({ account, banxico_sla_business_days: 5 }, 201);
  });

  app.post('/api/v1/onboarding/bank-account/:id/simulate-status', async (c) => {
    if (config.peyMode !== 'mock') {
      return c.json({ error: 'SANDBOX_DISABLED' }, 403);
    }
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = SimulateBankStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const updated = repo.updateBankAccountStatus(
      id,
      parsed.data.status,
      parsed.data.status === 'ERROR'
        ? parsed.data.errorMessage || 'Validación Banxico rechazada (simulado)'
        : null,
    );
    if (!updated) return c.json({ error: 'NOT_FOUND' }, 404);
    return c.json({ account: updated });
  });

  app.post('/api/v1/onboarding/bank-account/:id/refresh', async (c) => {
    const id = c.req.param('id');
    const existing = repo.getBankAccountById(id);
    if (!existing) return c.json({ error: 'NOT_FOUND' }, 404);

    if (peyClient && config.peyMode !== 'mock') {
      const remote = await peyClient.getBankAccountStatus(
        existing.bank_account_id,
      );
      const updated = repo.updateBankAccountStatus(
        existing.id,
        remote.status,
        remote.errorMessage ?? null,
      );
      return c.json({ account: updated ?? existing });
    }

    return c.json({ account: existing });
  });

  app.post('/api/v1/subscriptions/checkout', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SubscriptionCheckoutInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const input = parsed.data;
    const planMeta = SUBSCRIPTION_PLANS[input.plan];

    if (input.mode !== 'payment_link' && !repo.getKillSwitchEnabled()) {
      return c.json(
        {
          error: 'CODI_DISABLED',
          message:
            'El cobro CoDi está apagado. Usa el enlace directo de Payment Link o cobro manual.',
          checkout_url: subscriptionLinkBase,
        },
        503,
      );
    }

    const now = new Date();
    const expires = new Date(now.getTime() + 15 * 60 * 1000);
    const intentId = `sub_${randomUUID().slice(0, 12)}`;
    const externalRef = `SUB-${input.plan.toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const concept = input.clinic_name
      ? `${planMeta.concept}`.slice(0, 40)
      : planMeta.concept;
    let checkoutUrl = subscriptionLinkBase;
    let peyResourceId: string | null = null;

    if (peyClient && config.peyMode !== 'mock' && input.mode === 'payment_link') {
      const res = await peyClient.createPaymentLink({
        amount: planMeta.amountMxn,
        clientReferenceId: externalRef,
        concept,
        bankAccountId: resolveExpectedBankAccountId(),
        expiration: expires.toISOString(),
      });
      peyResourceId = res.id;
      if (res.url) checkoutUrl = res.url;
    }

    const qrPayload =
      input.mode === 'payment_link'
        ? checkoutUrl
        : JSON.stringify({
            v: 1,
            type: input.mode,
            kind: 'subscription',
            plan: input.plan,
            intent_id: intentId,
            amount_mxn: planMeta.amountMxn,
            ref: externalRef,
            url: checkoutUrl,
          });

    const intent = repo.createIntentWithDetails({
      id: intentId,
      state: 'PENDING_PAYMENT',
      amountCents: toCents(planMeta.amountMxn),
      expectedBankAccountId: resolveExpectedBankAccountId(),
      clientReferenceId: externalRef,
      mode: input.mode,
      expectedMethod: 'CODI',
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
      concept,
      externalRef,
      qrPayload,
      paymentLinkUrl: checkoutUrl,
      customerPhoneMasked: maskPhone(input.customer_phone),
      kind: 'subscription',
      peyResourceId,
    });

    return c.json(
      {
        intent,
        checkout_url: checkoutUrl,
        plan: input.plan,
        amount_mxn: planMeta.amountMxn,
      },
      201,
    );
  });

  app.get('/api/v1/payments/codi/manual-review', (c) => {
    return c.json({ items: repo.listManualReviewIntents() });
  });

  app.post('/api/v1/payments/codi/manual-review/:id/resolve', async (c) => {
    const id = c.req.param('id');
    const existing = repo.getById(id);
    if (!existing) return c.json({ error: 'NOT_FOUND' }, 404);
    if (existing.state !== 'MANUAL_REVIEW') {
      return c.json(
        {
          error: 'INVALID_STATE',
          message: `El intent ${id} está en estado ${existing.state}, no en MANUAL_REVIEW`,
        },
        409,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = ManualReviewResolveInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        400,
      );
    }

    const { action, note } = parsed.data;
    const targetState =
      action === 'APPLY'
        ? 'APPLIED'
        : action === 'REFUND_MANUAL'
          ? 'REFUNDED_MANUAL'
          : 'CANCELLED';
    const nowIso = new Date().toISOString();

    repo.transition(id, targetState, {
      actor: 'operator',
      event: `MANUAL_REVIEW_${action}`,
      detail: { action, note },
      nowIso,
    });

    if (action === 'APPLY') {
      const details = repo.getIntentDetails(id);
      repo.updateIntentDetails(id, {
        paidAt: details?.paid_at ?? nowIso,
      });
      syncKadiStatusForIntent(id);
    }

    return c.json({
      ok: true,
      intent: repo.getIntentView(id),
    });
  });

  app.post('/api/v1/payments/codi/reconcile', async (c) => {
    const fetchStatus = resolveFetchStatus();
    const reconcile = await reconcileOnce({
      repo,
      fetchStatus,
    });
    const outbox = await drainOutbox({
      repo,
      ledger: resolvedLedgerPort,
    });

    for (const intent of repo.listIntentViews()) {
      const record = repo.getById(intent.intent_id);
      if (record && (record.state === 'PAID_VERIFIED' || record.state === 'APPLIED')) {
        const details = repo.getIntentDetails(intent.intent_id);
        if (details && !details.paid_at) {
          repo.updateIntentDetails(intent.intent_id, {
            paidAt: record.updated_at,
          });
        }
        syncKadiStatusForIntent(intent.intent_id);
      }
    }

    return c.json({
      ok: true,
      reconcile,
      outbox,
    });
  });

  app.get('/api/v1/payments/codi/export.csv', (c) => {
    const headers = [
      'intent_id',
      'kind',
      'state',
      'status',
      'amount_mxn',
      'amount_cents',
      'mode',
      'concept',
      'external_ref',
      'provider_tx_id',
      'expected_bank_account_id',
      'review_reason',
      'kadi_sync_status',
      'created_at',
      'updated_at',
      'expires_at',
      'paid_at',
    ];

    const rows = repo.listIntentViews();
    const lines = [headers.join(',')];
    for (const item of rows) {
      lines.push(
        [
          csvCell(item.intent_id),
          csvCell(item.kind ?? 'clinical'),
          csvCell(item.state ?? ''),
          csvCell(item.status),
          csvCell(item.amount_mxn.toFixed(2)),
          csvCell(item.amount_cents ?? Math.round(item.amount_mxn * 100)),
          csvCell(item.mode),
          csvCell(item.concept),
          csvCell(item.external_ref),
          csvCell(item.provider_tx_id ?? item.clave_rastreo ?? ''),
          csvCell(item.expected_bank_account_id ?? ''),
          csvCell(item.review_reason ?? ''),
          csvCell(item.kadi_sync_status),
          csvCell(item.created_at),
          csvCell(item.updated_at ?? ''),
          csvCell(item.expires_at),
          csvCell(item.paid_at ?? ''),
        ].join(','),
      );
    }

    return c.body(`${lines.join('\n')}\n`, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="codi-pey-export.csv"',
    });
  });

  return app;
}
