import type { PaymentIntent, PaymentMode } from '@codi-pey/contracts';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

interface WebhookLog {
  event_id: string;
  intent_id: string;
  status: string;
  clave_rastreo: string;
  received_at: string;
  duplicate: boolean;
}

export default function App() {
  const [amount, setAmount] = useState('250.00');
  const [concept, setConcept] = useState('Consulta general');
  const [externalRef, setExternalRef] = useState(`ORD-${Date.now().toString().slice(-5)}`);
  const [mode, setMode] = useState<PaymentMode>('qr');
  const [phone, setPhone] = useState('');
  const [kadiCuentaId, setKadiCuentaId] = useState('');

  const [intents, setIntents] = useState<PaymentIntent[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookLog[]>([]);
  const [selected, setSelected] = useState<PaymentIntent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/payments/codi/intents`);
      if (!res.ok) return;
      const data = await res.json();
      setIntents(data.items || []);
      setWebhooks(data.webhooks || []);
      if (selected) {
        const updated = (data.items || []).find((i: PaymentIntent) => i.intent_id === selected.intent_id);
        if (updated) setSelected(updated);
      }
    } catch {
      // Silencioso en polling si la API aún no arranca
    }
  }, [selected]);

  useEffect(() => {
    refreshData();
    const timer = setInterval(refreshData, 2500);
    return () => clearInterval(timer);
  }, [refreshData]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/payments/codi/intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount_mxn: Number(amount),
          concept,
          external_ref: externalRef,
          mode,
          customer_phone: mode === 'request_to_pay' ? phone : undefined,
          kadi_cuenta_id: kadiCuentaId.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'Error al crear intent CoDi');
        return;
      }
      setSelected(data);
      setExternalRef(`ORD-${Date.now().toString().slice(-5)}`);
      await refreshData();
    } catch {
      setError('No se pudo conectar con la API local');
    } finally {
      setLoading(false);
    }
  }

  async function handleSimulatePay(intentId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/sandbox/simulate-pay/${intentId}`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'No se pudo simular el pago');
        return;
      }
      if (data.intent) setSelected(data.intent);
      await refreshData();
    } catch {
      setError('Error al simular webhook pey');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">CoDi + pey · Terminal de Cobro</h1>
            <p className="text-sm text-slate-400">Generador de QR dinámico, Request-to-Pay y monitor de webhooks idempotentes</p>
          </div>
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            API: {API_BASE}
          </span>
        </header>

        {error && (
          <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3 text-sm text-rose-300">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form onSubmit={handleCreate} className="rounded-xl bg-slate-900/70 border border-slate-800 p-5 space-y-4">
            <h2 className="text-lg font-semibold text-white">Nuevo Cobro CoDi</h2>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Monto (MXN)</label>
                <input
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
                <label className="block text-xs text-slate-400 mb-1">Modalidad</label>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as PaymentMode)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                >
                  <option value="qr">QR Dinámico</option>
                  <option value="request_to_pay">Request-to-Pay (Celular)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">Concepto (máx. 40 caracteres)</label>
              <input
                type="text"
                maxLength={40}
                required
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Referencia Externa</label>
                <input
                  type="text"
                  required
                  value={externalRef}
                  onChange={(e) => setExternalRef(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Cuenta KADI (opcional)</label>
                <input
                  type="text"
                  placeholder="ID de cuenta"
                  value={kadiCuentaId}
                  onChange={(e) => setKadiCuentaId(e.target.value)}
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
            </div>

            {mode === 'request_to_pay' && (
              <div>
                <label className="block text-xs text-slate-400 mb-1">Teléfono cliente (10 dígitos)</label>
                <input
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
              disabled={loading}
              className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2.5 text-sm font-semibold text-white transition"
            >
              {loading ? 'Generando...' : 'Generar Intent CoDi'}
            </button>
          </form>

          <div className="rounded-xl bg-slate-900/70 border border-slate-800 p-5 flex flex-col justify-between">
            {selected ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-slate-400">{selected.intent_id}</span>
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                      selected.status === 'paid'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-amber-500/20 text-amber-300'
                    }`}
                  >
                    {selected.status.toUpperCase()}
                  </span>
                </div>

                <div className="flex flex-col items-center bg-white p-4 rounded-xl w-fit mx-auto">
                  <QRCodeSVG value={selected.qr_payload} size={180} />
                </div>

                <div className="text-sm space-y-1 text-slate-300">
                  <p>
                    <strong>Monto:</strong> ${selected.amount_mxn.toFixed(2)} MXN
                  </p>
                  <p>
                    <strong>Concepto:</strong> {selected.concept}
                  </p>
                  {selected.clave_rastreo && (
                    <p>
                      <strong>Clave de rastreo:</strong> <span className="font-mono">{selected.clave_rastreo}</span>
                    </p>
                  )}
                  <p>
                    <strong>Sync KADI:</strong> {selected.kadi_sync_status}
                  </p>
                </div>

                {selected.status === 'pending' && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => handleSimulatePay(selected.intent_id)}
                    className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition"
                  >
                    Simular Pago CoDi (Sandbox Mock)
                  </button>
                )}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-sm text-slate-500 py-12">
                Genera un cobro para visualizar el QR dinámico CoDi.
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="rounded-xl bg-slate-900/70 border border-slate-800 p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Historial de Intents ({intents.length})</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {intents.length === 0 ? (
                <p className="text-xs text-slate-500">Sin cobros registrados aún.</p>
              ) : (
                intents.map((item) => (
                  <button
                    key={item.intent_id}
                    type="button"
                    onClick={() => setSelected(item)}
                    className="w-full text-left rounded-lg bg-slate-950/80 hover:bg-slate-800/80 border border-slate-800 p-3 flex items-center justify-between text-xs"
                  >
                    <div>
                      <p className="font-semibold text-white">
                        ${item.amount_mxn.toFixed(2)} · {item.concept}
                      </p>
                      <p className="text-slate-400 font-mono">{item.intent_id}</p>
                    </div>
                    <span className={item.status === 'paid' ? 'text-emerald-400 font-semibold' : 'text-amber-400'}>
                      {item.status}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl bg-slate-900/70 border border-slate-800 p-5">
            <h3 className="text-sm font-semibold text-white mb-3">Monitor de Webhooks pey ({webhooks.length})</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {webhooks.length === 0 ? (
                <p className="text-xs text-slate-500">Sin eventos recibidos aún.</p>
              ) : (
                webhooks.map((w, idx) => (
                  <div
                    key={`${w.event_id}-${idx}`}
                    className="rounded-lg bg-slate-950/80 border border-slate-800 p-3 text-xs flex items-center justify-between"
                  >
                    <div>
                      <p className="font-mono text-slate-200">{w.event_id}</p>
                      <p className="text-slate-400">Rastreo: {w.clave_rastreo}</p>
                    </div>
                    <span className={w.duplicate ? 'text-amber-400' : 'text-emerald-400'}>
                      {w.duplicate ? 'IDEMPOTENT_DUP' : w.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
