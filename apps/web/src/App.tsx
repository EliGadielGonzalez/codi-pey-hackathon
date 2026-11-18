import type {
  BankAccountView,
  ManualReviewAction,
  PaymentIntent,
  PaymentMode,
  PeyBankAccountStatus,
  SubscriptionPlan,
} from '@codi-pey/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ExcepcionesAuditoriaTab } from './components/ExcepcionesAuditoriaTab.js';
import { OnboardingSuscripcionTab } from './components/OnboardingSuscripcionTab.js';
import { VentanillaCobroTab } from './components/VentanillaCobroTab.js';
import type {
  ActiveTab,
  LedgerAuditEntry,
  ManualFallbackReceipt,
  WebhookLog,
} from './types.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('ventanilla');
  const [showPeyBranding, setShowPeyBranding] = useState(true);

  const [codiEnabled, setCodiEnabled] = useState(true);
  const [intents, setIntents] = useState<PaymentIntent[]>([]);
  const [manualReviewItems, setManualReviewItems] = useState<PaymentIntent[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookLog[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerAuditEntry[]>([]);
  const [bankAccount, setBankAccount] = useState<BankAccountView | null>(null);

  const [selected, setSelected] = useState<PaymentIntent | null>(null);
  const [manualReceipt, setManualReceipt] = useState<ManualFallbackReceipt | null>(null);
  const [loading, setLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    try {
      const [intentsRes, reviewRes, bankRes, killRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/payments/codi/intents`),
        fetch(`${API_BASE}/api/v1/payments/codi/manual-review`),
        fetch(`${API_BASE}/api/v1/onboarding/bank-account`),
        fetch(`${API_BASE}/api/v1/config/kill-switch`),
      ]);

      if (intentsRes.ok) {
        const data = await intentsRes.json();
        const items: PaymentIntent[] = data.items || [];
        setIntents(items);
        setWebhooks(data.webhooks || []);
        setLedgerEntries(data.ledger || []);
        if (typeof data.codi_enabled === 'boolean') {
          setCodiEnabled(data.codi_enabled);
        }
        setSelected((prev) => {
          if (!prev) return null;
          return items.find((i) => i.intent_id === prev.intent_id) ?? prev;
        });
      }

      if (reviewRes.ok) {
        const reviewData = await reviewRes.json();
        setManualReviewItems(reviewData.items || []);
      }

      if (bankRes.ok) {
        const bankData = await bankRes.json();
        setBankAccount(bankData.account ?? null);
      }

      if (killRes.ok) {
        const killData = await killRes.json();
        if (typeof killData.enabled === 'boolean') {
          setCodiEnabled(killData.enabled);
        }
      }
    } catch {
      // Silencioso en polling si la API local aún no arranca
    }
  }, []);

  useEffect(() => {
    refreshData();
    const timer = setInterval(refreshData, 2500);
    return () => clearInterval(timer);
  }, [refreshData]);

  async function handleCreateIntent(input: {
    amount_mxn: number;
    concept: string;
    external_ref: string;
    mode: PaymentMode;
    customer_phone?: string;
    kadi_cuenta_id?: string;
  }) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/payments/codi/intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message || data?.error || 'Error al emitir cobro CoDi');
        return;
      }
      setSelected(data);
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
      setError('Error al simular webhook Pey');
    } finally {
      setLoading(false);
    }
  }

  async function handleReconcileNow() {
    setReconciling(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/payments/codi/reconcile`, {
        method: 'POST',
      });
      if (!res.ok) {
        setError('No se pudo ejecutar la reconciliación');
        return;
      }
      await refreshData();
    } catch {
      setError('Error de red al verificar pago');
    } finally {
      setReconciling(false);
    }
  }

  async function handleActivateManualFallback(
    intent: PaymentIntent | null,
    method: 'efectivo' | 'tarjeta' | 'transferencia',
    note: string,
  ) {
    setLoading(true);
    setError(null);
    try {
      if (intent && intent.status === 'pending') {
        await fetch(`${API_BASE}/api/v1/payments/codi/intents/${intent.intent_id}/manual-fallback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method, note }),
        });
      }
      setManualReceipt({
        intentId: intent?.intent_id ?? 'MANUAL_CAJA',
        method,
        amountMxn: intent?.amount_mxn ?? 0,
        concept: intent?.concept ?? note,
        recordedAt: new Date().toISOString(),
      });
      await refreshData();
    } catch {
      setError('No se pudo registrar el respaldo manual');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegisterBankAccount(input: {
    clabeLast4: string;
    alias: string;
    holderName: string;
    clabeTokenOrEnvRef?: string;
  }) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/onboarding/bank-account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message || data?.error || 'Error al vincular cuenta');
        return;
      }
      setBankAccount(data.account);
      await refreshData();
    } catch {
      setError('Error al conectar onboarding bancario');
    } finally {
      setLoading(false);
    }
  }

  async function handleSimulateBankStatus(
    id: string,
    status: PeyBankAccountStatus,
    errorMessage?: string,
  ) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/onboarding/bank-account/${id}/simulate-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, errorMessage }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || 'No se pudo actualizar estado bancario');
        return;
      }
      setBankAccount(data.account);
    } catch {
      setError('Error al simular estado Banxico');
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshBankStatus(id: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/onboarding/bank-account/${id}/refresh`, {
        method: 'POST',
      });
      const data = await res.json();
      if (res.ok && data.account) {
        setBankAccount(data.account);
      }
    } catch {
      setError('Error al consultar estado de cuenta bancaria');
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckoutSubscription(input: {
    plan: SubscriptionPlan;
    mode: PaymentMode;
    customer_phone?: string;
    clinic_name?: string;
  }): Promise<{ intent: PaymentIntent; checkout_url: string } | null> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/subscriptions/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message || data?.error || 'Error al generar checkout');
        return null;
      }
      setSelected(data.intent);
      await refreshData();
      return { intent: data.intent, checkout_url: data.checkout_url };
    } catch {
      setError('Error de red al generar suscripción');
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleKillSwitch(enabled: boolean) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/config/kill-switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (res.ok) {
        setCodiEnabled(data.enabled);
      }
    } catch {
      setError('No se pudo actualizar el Kill Switch');
    } finally {
      setLoading(false);
    }
  }

  async function handleResolveManualReview(
    intentId: string,
    action: ManualReviewAction,
    note: string,
  ) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/payments/codi/manual-review/${intentId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.message || data?.error || 'Error al resolver excepción');
        return;
      }
      await refreshData();
    } catch {
      setError('Error al resolver revisión manual');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight text-white">
              {showPeyBranding
                ? 'KADI Cobro Clínico · Impulsado por CoDi® y Pey (0% comisión)'
                : 'KADI Cobro Clínico · Terminal de Pagos'}
            </h1>
            <p className="text-xs md:text-sm text-slate-400">
              Cobro clínico verificable en servidor, libro append-only SQLite WAL y cero custodia de fondos
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPeyBranding((v) => !v)}
              className="rounded-full px-3 py-1 text-xs font-medium bg-slate-900 border border-slate-700 text-slate-300 hover:bg-slate-800 transition"
            >
              {showPeyBranding ? 'Co-branding Pey: ON' : 'Co-branding Pey: OFF'}
            </button>

            <button
              type="button"
              onClick={() => handleToggleKillSwitch(!codiEnabled)}
              className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${
                codiEnabled
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/25'
                  : 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30'
              }`}
            >
              {codiEnabled ? 'CoDi Activo' : 'CoDi Apagado (Kill Switch)'}
            </button>
          </div>
        </header>

        <nav className="flex flex-wrap gap-2" aria-label="Secciones principales">
          <button
            type="button"
            onClick={() => setActiveTab('ventanilla')}
            className={`rounded-lg px-4 py-2 text-xs md:text-sm font-semibold transition ${
              activeTab === 'ventanilla'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            Ventanilla de Cobro
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('onboarding')}
            className={`rounded-lg px-4 py-2 text-xs md:text-sm font-semibold transition ${
              activeTab === 'onboarding'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            Onboarding Bancario y Suscripción
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('auditoria')}
            className={`rounded-lg px-4 py-2 text-xs md:text-sm font-semibold transition flex items-center gap-2 ${
              activeTab === 'auditoria'
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            <span>Excepciones y Auditoría</span>
            {manualReviewItems.length > 0 && (
              <span className="rounded-full bg-amber-500 text-slate-950 px-1.5 py-0.5 text-[10px] font-bold">
                {manualReviewItems.length}
              </span>
            )}
          </button>
        </nav>

        {error && (
          <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 p-3 text-sm text-rose-300 flex items-center justify-between gap-2">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-xs text-rose-200 underline"
            >
              Cerrar
            </button>
          </div>
        )}

        {activeTab === 'ventanilla' && (
          <VentanillaCobroTab
            codiEnabled={codiEnabled}
            intents={intents}
            selected={selected}
            loading={loading}
            reconciling={reconciling}
            onSelectIntent={setSelected}
            onCreateIntent={handleCreateIntent}
            onSimulatePay={handleSimulatePay}
            onReconcileNow={handleReconcileNow}
            onActivateManualFallback={handleActivateManualFallback}
            manualReceipt={manualReceipt}
          />
        )}

        {activeTab === 'onboarding' && (
          <OnboardingSuscripcionTab
            bankAccount={bankAccount}
            loading={loading}
            onRegisterBankAccount={handleRegisterBankAccount}
            onSimulateBankStatus={handleSimulateBankStatus}
            onRefreshBankStatus={handleRefreshBankStatus}
            onCheckoutSubscription={handleCheckoutSubscription}
          />
        )}

        {activeTab === 'auditoria' && (
          <ExcepcionesAuditoriaTab
            codiEnabled={codiEnabled}
            manualReviewItems={manualReviewItems}
            ledgerEntries={ledgerEntries}
            webhooks={webhooks}
            exportCsvUrl={`${API_BASE}/api/v1/payments/codi/export.csv`}
            loading={loading}
            onToggleKillSwitch={handleToggleKillSwitch}
            onResolveManualReview={handleResolveManualReview}
          />
        )}
      </div>
    </div>
  );
}
