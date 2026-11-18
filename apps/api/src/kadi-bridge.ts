import { KadiPaymentSyncSchema, type PaymentIntent } from '@codi-pey/contracts';

export interface BridgeConfig {
  kadiBaseUrl?: string;
  kadiBearerToken?: string;
}

export async function syncPaymentToKadi(
  intent: PaymentIntent,
  config: BridgeConfig,
): Promise<'not_configured' | 'synced' | 'failed'> {
  if (!config.kadiBaseUrl || !config.kadiBearerToken || !intent.kadi_cuenta_id) {
    return 'not_configured';
  }

  const payload = KadiPaymentSyncSchema.parse({
    monto: intent.amount_mxn,
    metodo_pago: 'transferencia',
    referencia: `CODI:${intent.clave_rastreo || intent.intent_id}`,
  });

  const base = config.kadiBaseUrl.replace(/\/+$/, '');
  const template = process.env.LEDGER_PAYMENT_PATH || '/ledger/accounts/{account_ref}/payments';
  const url = `${base}${template.replace('{account_ref}', encodeURIComponent(intent.kadi_cuenta_id))}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.kadiBearerToken}`,
      },
      body: JSON.stringify(payload),
    });
    return res.ok ? 'synced' : 'failed';
  } catch {
    return 'failed';
  }
}
