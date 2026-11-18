import type { PaymentIntent, PaymentMode } from '@codi-pey/contracts';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';
import type { ManualFallbackReceipt } from '../types.js';

export interface VentanillaCobroTabProps {
  codiEnabled: boolean;
  intents: PaymentIntent[];
  selected: PaymentIntent | null;
  loading: boolean;
  reconciling: boolean;
  onSelectIntent: (intent: PaymentIntent) => void;
  onCreateIntent: (input: {
    amount_mxn: number;
    concept: string;
    external_ref: string;
    mode: PaymentMode;
    customer_phone?: string;
    kadi_cuenta_id?: string;
  }) => Promise<void>;
  onSimulatePay: (intentId: string) => Promise<void>;
  onReconcileNow: () => Promise<void>;
  onActivateManualFallback: (
    intent: PaymentIntent | null,
    method: 'efectivo' | 'tarjeta' | 'transferencia',
    note: string,
  ) => Promise<void>;
  manualReceipt: ManualFallbackReceipt | null;
}

function getStateBadgeClass(state?: string, status?: string): string {
  if (state === 'APPLIED' || state === 'PAID_VERIFIED' || status === 'paid') {
    return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
  }
  if (state === 'MANUAL_REVIEW') {
    return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
  }
  if (state === 'EXPIRED' || state === 'CANCELLED' || state === 'REFUNDED_MANUAL' || status === 'failed') {
    return 'bg-rose-500/20 text-rose-300 border-rose-500/30';
  }
  return 'bg-sky-500/20 text-sky-300 border-sky-500/30';
}

export function VentanillaCobroTab({
  codiEnabled,
  intents,
  selected,
  loading,
  reconciling,
  onSelectIntent,
  onCreateIntent,
  onSimulatePay,
  onReconcileNow,
  onActivateManualFallback,
  manualReceipt,
}: VentanillaCobroTabProps) {
  const [amount, setAmount] = useState('250.00');
  const [concept, setConcept] = useState('Consulta veterinaria');
  const [externalRef, setExternalRef] = useState(`ORD-${Date.now().toString().slice(-5)}`);
  const [mode, setMode] = useState<PaymentMode>('qr');
  const [phone, setPhone] = useState('');
  const [kadiCuentaId, setKadiCuentaId] = useState('');
  const [manualMethod, setManualMethod] = useState<'efectivo' | 'tarjeta' | 'transferencia'>('efectivo');
  const [manualModeOpen, setManualModeOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await onCreateIntent({
      amount_mxn: Number(amount),
      concept,
      external_ref: externalRef,
      mode,
      customer_phone: mode === 'request_to_pay' ? phone : undefined,
      kadi_cuenta_id: kadiCuentaId.trim() || undefined,
    });
    setExternalRef(`ORD-${Date.now().toString().slice(-5)}`);
  }

  return (
    <div className="space-y-6">
      {!codiEnabled && (
        <div className="rounded-xl bg-amber-500/15 border border-amber-500/40 p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-amber-200">
              Kill Switch activo: cobro CoDi apagado temporalmente
            </p>
            <p className="text-xs text-amber-300/90">
              Opera en Modo Manual Degradado (efectivo, tarjeta o transferencia) sin detener la atención en recepción.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setManualModeOpen(true)}
            className="rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs px-3 py-2 transition"
          >
            Usar Modo Manual Degradado
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={handleSubmit} className="glass-card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">1. Emitir Cobro (≤ 3 clics)</h2>
              <p className="text-xs text-slate-400">Monto + Concepto + Modo → Emitir → Confirmación</p>
            </div>
            <button
              type="button"
              onClick={() => setManualModeOpen((v) => !v)}
              className="text-xs text-amber-300 hover:text-amber-200 underline underline-offset-2"
            >
              Modo Manual Degradado
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="amount-input">
                Monto (MXN)
              </label>
              <input
                id="amount-input"
                type="number"
                step="0.01"
                min="0.01"
                max="8000"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="mode-select">
                Modo de Cobro
              </label>
              <select
                id="mode-select"
                value={mode}
                onChange={(e) => setMode(e.target.value as PaymentMode)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              >
                <option value="qr">QR CoDi</option>
                <option value="request_to_pay">Push CoDi (Celular)</option>
                <option value="payment_link">Payment Link</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1" htmlFor="concept-input">
              Concepto (máx. 40 caracteres)
            </label>
            <input
              id="concept-input"
              type="text"
              maxLength={40}
              required
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="ref-input">
                Referencia Externa
              </label>
              <input
                id="ref-input"
                type="text"
                required
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="acct-ref-input">
                Ref. Contable Externa (opcional)
              </label>
              <input
                id="acct-ref-input"
                type="text"
                placeholder="ID de referencia"
                value={kadiCuentaId}
                onChange={(e) => setKadiCuentaId(e.target.value)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>
          </div>

          {mode === 'request_to_pay' && (
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="phone-input">
                Teléfono cliente (10 dígitos)
              </label>
              <input
                id="phone-input"
                type="tel"
                pattern="\d{10}"
                required
                placeholder="5512345678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !codiEnabled}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white transition"
          >
            {loading ? 'Emitiendo...' : 'Emitir Cobro CoDi'}
          </button>

          {(manualModeOpen || !codiEnabled) && (
            <div className="rounded-lg bg-slate-950/90 border border-amber-500/30 p-3 space-y-2">
              <p className="text-xs font-semibold text-amber-300">
                Respaldo Operativo: Modo Manual Degradado
              </p>
              <div className="flex flex-col md:flex-row gap-2">
                <select
                  aria-label="Método manual"
                  value={manualMethod}
                  onChange={(e) =>
                    setManualMethod(e.target.value as 'efectivo' | 'tarjeta' | 'transferencia')
                  }
                  className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-1.5 text-xs text-white"
                >
                  <option value="efectivo">Efectivo en caja</option>
                  <option value="tarjeta">Terminal bancaria (Tarjeta)</option>
                  <option value="transferencia">Transferencia SPEI manual</option>
                </select>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() =>
                    onActivateManualFallback(
                      selected,
                      manualMethod,
                      `Cobro manual (${manualMethod}) - ${concept} $${amount}`,
                    )
                  }
                  className="rounded-lg bg-amber-600 hover:bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition"
                >
                  Registrar en Modo Manual
                </button>
              </div>
              {manualReceipt && (
                <p className="text-xs text-emerald-300">
                  Respaldo manual registrado ({manualReceipt.method}) · ${manualReceipt.amountMxn.toFixed(2)} MXN
                </p>
              )}
            </div>
          )}
        </form>

        <div className="glass-card p-5 flex flex-col justify-between">
          {selected ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono text-slate-400">{selected.intent_id}</span>
                <span
                  className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getStateBadgeClass(
                    selected.state,
                    selected.status,
                  )}`}
                >
                  {selected.state || selected.status.toUpperCase()}
                </span>
              </div>

              <div className="flex flex-col items-center bg-white p-4 rounded-xl w-fit mx-auto">
                <QRCodeSVG value={selected.qr_payload || selected.intent_id} size={180} />
              </div>

              {selected.payment_link_url && (
                <div className="rounded-lg bg-slate-950/90 border border-slate-800 p-2.5 text-xs break-all">
                  <span className="text-slate-400">Payment Link: </span>
                  <a
                    href={selected.payment_link_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-400 hover:text-indigo-300 underline"
                  >
                    {selected.payment_link_url}
                  </a>
                </div>
              )}

              <div className="text-sm space-y-1 text-slate-300">
                <p>
                  <strong>Monto:</strong> ${selected.amount_mxn.toFixed(2)} MXN
                </p>
                <p>
                  <strong>Concepto:</strong> {selected.concept}
                </p>
                <p>
                  <strong>Cuenta destino:</strong> {selected.expected_bank_account_id || '01TESTBANKACCOUNT0000'}
                </p>
                {(selected.clave_rastreo || selected.provider_tx_id) && (
                  <p>
                    <strong>Clave de rastreo:</strong>{' '}
                    <span className="font-mono">{selected.clave_rastreo || selected.provider_tx_id}</span>
                  </p>
                )}
                {selected.review_reason && (
                  <p className="text-amber-300">
                    <strong>Motivo revisión:</strong> {selected.review_reason}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={reconciling}
                  onClick={onReconcileNow}
                  className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-white transition"
                >
                  {reconciling ? 'Verificando...' : 'Verificar pago ahora'}
                </button>

                {selected.status === 'pending' && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => onSimulatePay(selected.intent_id)}
                    className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 text-xs font-semibold text-white transition"
                  >
                    Simular Pago CoDi (Mock)
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center text-sm text-slate-400 py-12 space-y-3">
              <p>Emite un cobro CoDi para visualizar el QR dinámico o Payment Link.</p>
              <button
                type="button"
                disabled={reconciling}
                onClick={onReconcileNow}
                className="rounded-lg bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                {reconciling ? 'Verificando...' : 'Verificar pago ahora'}
              </button>
            </div>
          )}
        </div>
      </div>

      <section className="glass-card p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">Historial de Intents ({intents.length})</h3>
          <button
            type="button"
            disabled={reconciling}
            onClick={onReconcileNow}
            className="text-xs text-sky-400 hover:text-sky-300"
          >
            {reconciling ? 'Conciliando...' : 'Reconciliar y drenar outbox'}
          </button>
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {intents.length === 0 ? (
            <p className="text-xs text-slate-500">Sin cobros registrados aún.</p>
          ) : (
            intents.map((item) => (
              <button
                key={item.intent_id}
                type="button"
                onClick={() => onSelectIntent(item)}
                className="w-full text-left rounded-lg bg-slate-950/80 hover:bg-slate-800/80 border border-slate-800 p-3 flex items-center justify-between text-xs transition"
              >
                <div>
                  <p className="font-semibold text-white">
                    ${item.amount_mxn.toFixed(2)} · {item.concept}
                    {item.kind === 'subscription' ? ' (Suscripción)' : ''}
                  </p>
                  <p className="text-slate-400 font-mono">
                    {item.intent_id} · {item.mode}
                  </p>
                </div>
                <span
                  className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${getStateBadgeClass(
                    item.state,
                    item.status,
                  )}`}
                >
                  {item.state || item.status}
                </span>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
