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
  const url = `${base}/api/v1/cuentas/${encodeURIComponent(intent.kadi_cuenta_id)}/pagos`;

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
