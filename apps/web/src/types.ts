import type { BankAccountView, PaymentIntent } from '@codi-pey/contracts';

export interface WebhookLog {
  event_id: string;
  intent_id: string;
  status: string;
  clave_rastreo: string;
  received_at: string;
  duplicate: boolean;
}

export interface LedgerAuditEntry {
  id: number;
  intent_id: string;
  event: string;
  from_state: string | null;
  to_state: string;
  amount_cents: number;
  provider_tx_id: string | null;
  actor: string;
  created_at: string;
  detail_json: string | null;
}

export interface ManualFallbackReceipt {
  intentId: string;
  method: 'efectivo' | 'tarjeta' | 'transferencia';
  amountMxn: number;
  concept: string;
  recordedAt: string;
}

export type ActiveTab = 'ventanilla' | 'onboarding' | 'auditoria';

export type { BankAccountView, PaymentIntent };
