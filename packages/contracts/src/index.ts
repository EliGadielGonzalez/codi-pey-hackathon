import { z } from 'zod';
import {
  PeyBankAccountStatusSchema,
  PeyRegisterBankAccountInputSchema,
} from './pey.js';

export const PaymentModeSchema = z.enum(['qr', 'request_to_pay', 'payment_link']);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;

export const IntentStatusSchema = z.enum(['pending', 'paid', 'expired', 'failed']);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

export const IntentKindSchema = z.enum(['clinical', 'subscription']);
export type IntentKind = z.infer<typeof IntentKindSchema>;

export const CreateIntentInputSchema = z
  .object({
    amount_mxn: z.number().min(0.01).max(8000),
    concept: z.string().trim().min(1).max(40),
    external_ref: z.string().trim().min(1).max(120),
    mode: PaymentModeSchema.default('qr'),
    customer_phone: z
      .string()
      .regex(/^\d{10}$/, 'El teléfono debe tener 10 dígitos')
      .optional(),
    kadi_cuenta_id: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.mode !== 'request_to_pay' || Boolean(data.customer_phone), {
    message: 'customer_phone es obligatorio en modo request_to_pay',
    path: ['customer_phone'],
  });

export type CreateIntentInput = z.infer<typeof CreateIntentInputSchema>;

export const PaymentIntentSchema = z.object({
  intent_id: z.string(),
  amount_mxn: z.number(),
  concept: z.string(),
  external_ref: z.string(),
  mode: PaymentModeSchema,
  customer_phone: z.string().optional(),
  status: IntentStatusSchema,
  state: z.string().optional(),
  amount_cents: z.number().int().optional(),
  expected_bank_account_id: z.string().optional(),
  provider_tx_id: z.string().nullable().optional(),
  review_reason: z.string().nullable().optional(),
  kind: IntentKindSchema.optional(),
  payment_link_url: z.string().nullable().optional(),
  qr_payload: z.string(),
  clave_rastreo: z.string().optional(),
  kadi_cuenta_id: z.string().optional(),
  kadi_sync_status: z.enum(['not_configured', 'pending', 'synced', 'failed']).default('not_configured'),
  created_at: z.string(),
  updated_at: z.string().optional(),
  expires_at: z.string(),
  paid_at: z.string().optional(),
});

export type PaymentIntent = z.infer<typeof PaymentIntentSchema>;

export const PeyWebhookEventSchema = z.object({
  event_id: z.string().min(1),
  intent_id: z.string().min(1),
  status: z.enum(['paid', 'failed', 'expired', 'processing']),
  clave_rastreo: z.string().min(1),
  amount_mxn: z.number().min(0.01),
  paid_at: z.string().optional(),
});

export type PeyWebhookEvent = z.infer<typeof PeyWebhookEventSchema>;

export const KadiPaymentSyncSchema = z.object({
  monto: z.number().min(0.01),
  metodo_pago: z.enum(['efectivo', 'transferencia', 'tarjeta_credito', 'tarjeta_debito']),
  referencia: z.string().max(500),
});

export type KadiPaymentSync = z.infer<typeof KadiPaymentSyncSchema>;

export const OnboardingBankAccountInputSchema = PeyRegisterBankAccountInputSchema.and(
  z.object({
    initialStatus: PeyBankAccountStatusSchema.optional(),
  }),
);

export type OnboardingBankAccountInput = z.infer<typeof OnboardingBankAccountInputSchema>;

export const SimulateBankStatusInputSchema = z.object({
  status: PeyBankAccountStatusSchema,
  errorMessage: z.string().trim().max(240).optional(),
});

export type SimulateBankStatusInput = z.infer<typeof SimulateBankStatusInputSchema>;

export const BankAccountViewSchema = z.object({
  id: z.string(),
  bank_account_id: z.string(),
  clabe_masked: z.string(),
  alias: z.string(),
  holder_name: z.string(),
  codi_status: PeyBankAccountStatusSchema,
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type BankAccountView = z.infer<typeof BankAccountViewSchema>;

export const ManualReviewActionSchema = z.enum(['APPLY', 'REFUND_MANUAL', 'CANCEL']);
export type ManualReviewAction = z.infer<typeof ManualReviewActionSchema>;

export const ManualReviewResolveInputSchema = z.object({
  action: ManualReviewActionSchema,
  note: z.string().trim().min(1, 'La nota de auditoría es obligatoria').max(500),
});

export type ManualReviewResolveInput = z.infer<typeof ManualReviewResolveInputSchema>;

export const SubscriptionPlanSchema = z.enum(['mensual', 'hospital_pro', 'anual']);
export type SubscriptionPlan = z.infer<typeof SubscriptionPlanSchema>;

export const SubscriptionCheckoutInputSchema = z
  .object({
    plan: SubscriptionPlanSchema.default('mensual'),
    mode: PaymentModeSchema.default('payment_link'),
    customer_phone: z
      .string()
      .regex(/^\d{10}$/, 'El teléfono debe tener 10 dígitos')
      .optional(),
    clinic_name: z.string().trim().min(1).max(80).optional(),
  })
  .refine((data) => data.mode !== 'request_to_pay' || Boolean(data.customer_phone), {
    message: 'customer_phone es obligatorio en modo request_to_pay',
    path: ['customer_phone'],
  });

export type SubscriptionCheckoutInput = z.infer<typeof SubscriptionCheckoutInputSchema>;

export const KillSwitchInputSchema = z.object({
  enabled: z.boolean(),
});

export type KillSwitchInput = z.infer<typeof KillSwitchInputSchema>;

export const ManualFallbackInputSchema = z.object({
  method: z.enum(['efectivo', 'tarjeta', 'transferencia']).default('efectivo'),
  note: z.string().trim().max(240).optional(),
});

export type ManualFallbackInput = z.infer<typeof ManualFallbackInputSchema>;

export * from './pey.js';
export * from './ledger.js';
