import { z } from 'zod';

export const PaymentModeSchema = z.enum(['qr', 'request_to_pay']);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;

export const IntentStatusSchema = z.enum(['pending', 'paid', 'expired', 'failed']);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

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
  qr_payload: z.string(),
  clave_rastreo: z.string().optional(),
  kadi_cuenta_id: z.string().optional(),
  kadi_sync_status: z.enum(['not_configured', 'pending', 'synced', 'failed']).default('not_configured'),
  created_at: z.string(),
  expires_at: z.string(),
  paid_at: z.string().optional(),
});

export type PaymentIntent = z.infer<typeof PaymentIntentSchema>;

export const PeyWebhookEventSchema = z.object({
  event_id: z.string().min(1),
  intent_id: z.string().min(1),
  status: z.enum(['paid', 'failed', 'expired']),
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
export * from './pey.js';
