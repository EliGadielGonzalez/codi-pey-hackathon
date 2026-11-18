import {
  DEMO_CLINIC_BANK_PRESETS,
  validateBanxicoClabe,
  type BankAccountView,
  type DemoClinicBankPreset,
  type PaymentIntent,
  type PaymentMode,
  type PeyBankAccountStatus,
  type SubscriptionPlan,
} from '@codi-pey/contracts';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';

export interface OnboardingSuscripcionTabProps {
  bankAccount: BankAccountView | null;
  loading: boolean;
  onRegisterBankAccount: (input: {
    clabeLast4: string;
    alias: string;
    holderName: string;
    clabeTokenOrEnvRef?: string;
  }) => Promise<void>;
  onSimulateBankStatus: (
    id: string,
    status: PeyBankAccountStatus,
    errorMessage?: string,
  ) => Promise<void>;
  onRefreshBankStatus: (id: string) => Promise<void>;
  onCheckoutSubscription: (input: {
    plan: SubscriptionPlan;
    mode: PaymentMode;
    customer_phone?: string;
    clinic_name?: string;
  }) => Promise<{ intent: PaymentIntent; checkout_url: string } | null>;
}

const BANK_STATUS_BADGES: Record<PeyBankAccountStatus, string> = {
  BORRADOR: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  PENDING: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  PROCESSING: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  ACTIVE: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  ERROR: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
};

const DEFAULT_PRESET = DEMO_CLINIC_BANK_PRESETS[0];

function formatClabeValidationError(reason?: string, expected?: number, actual?: number): string {
  switch (reason) {
    case 'empty':
      return 'Ingresa una CLABE de 18 dígitos para verificarla localmente.';
    case 'non_numeric':
      return 'La CLABE solo debe contener dígitos numéricos.';
    case 'invalid_length':
      return 'La CLABE debe tener exactamente 18 dígitos.';
    case 'invalid_bank_code':
      return 'El código de banco (primeros 3 dígitos) no es válido.';
    case 'check_digit_mismatch':
      return `Dígito verificador Banxico inválido (esperado ${expected}, recibido ${actual}).`;
    default:
      return 'La CLABE no cumple la validación matemática Banxico.';
  }
}

export function OnboardingSuscripcionTab({
  bankAccount,
  loading,
  onRegisterBankAccount,
  onSimulateBankStatus,
  onRefreshBankStatus,
  onCheckoutSubscription,
}: OnboardingSuscripcionTabProps) {
  const [clabeLast4, setClabeLast4] = useState('6252');
  const [alias, setAlias] = useState(DEFAULT_PRESET.alias);
  const [holderName, setHolderName] = useState(DEFAULT_PRESET.holderName);
  const [clabeTokenOrEnvRef, setClabeTokenOrEnvRef] = useState('ENV:PEY_DEMO_CLABE_BBVA');
  const [localClabeInput, setLocalClabeInput] = useState('');
  const [localClabeError, setLocalClabeError] = useState<string | null>(null);
  const [localClabeInfo, setLocalClabeInfo] = useState<string | null>(null);

  const [plan, setPlan] = useState<SubscriptionPlan>('mensual');
  const [subMode, setSubMode] = useState<PaymentMode>('payment_link');
  const [subPhone, setSubPhone] = useState('');
  const [subResult, setSubResult] = useState<{
    intent: PaymentIntent;
    checkout_url: string;
  } | null>(null);

  function applyDemoPreset(preset: DemoClinicBankPreset) {
    setClabeLast4(preset.clabeLast4);
    setAlias(preset.alias);
    setHolderName(preset.holderName);
    setClabeTokenOrEnvRef(preset.clabeTokenOrEnvRef);
    setLocalClabeInput('');
    setLocalClabeError(null);
    setLocalClabeInfo(null);
  }

  function handleLocalClabeChange(value: string) {
    setLocalClabeInput(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setLocalClabeError(null);
      setLocalClabeInfo(null);
      return;
    }

    const check = validateBanxicoClabe(trimmed);
    if (check.valid && check.last4) {
      setLocalClabeError(null);
      setLocalClabeInfo(
        `CLABE válida: ${check.bankName ?? `Banco ${check.bankCode}`} · ${check.masked}`,
      );
      setClabeLast4(check.last4);
    } else {
      setLocalClabeInfo(null);
      setLocalClabeError(
        formatClabeValidationError(
          check.reason,
          check.expectedCheckDigit,
          check.actualCheckDigit,
        ),
      );
    }
  }

  async function handleBankSubmit(e: React.FormEvent) {
    e.preventDefault();
    let effectiveLast4 = clabeLast4;
    if (localClabeInput.trim().length > 0) {
      const check = validateBanxicoClabe(localClabeInput);
      if (!check.valid || !check.last4) {
        setLocalClabeInfo(null);
        setLocalClabeError(
          formatClabeValidationError(
            check.reason,
            check.expectedCheckDigit,
            check.actualCheckDigit,
          ),
        );
        return;
      }
      effectiveLast4 = check.last4;
      setClabeLast4(check.last4);
      setLocalClabeInput('');
      setLocalClabeError(null);
      setLocalClabeInfo(null);
    }

    await onRegisterBankAccount({
      clabeLast4: effectiveLast4,
      alias,
      holderName,
      clabeTokenOrEnvRef: clabeTokenOrEnvRef.trim() || undefined,
    });
  }

  async function handleSubSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await onCheckoutSubscription({
      plan,
      mode: subMode,
      customer_phone: subMode === 'request_to_pay' ? subPhone : undefined,
      clinic_name: holderName,
    });
    if (res) setSubResult(res);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section className="glass-card p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Onboarding Bancario CoDi (Banxico)</h2>
          <p className="text-xs text-slate-400">
            Titularidad directa al comercio · nunca almacenamos CLABE de 18 dígitos en claro.
          </p>
        </div>

        <div className="rounded-lg bg-sky-500/10 border border-sky-500/30 p-3 text-xs text-sky-200">
          La activación CoDi ante Banxico puede tardar hasta <strong>5 días hábiles</strong> (
          <span className="font-mono">BORRADOR → PENDING → PROCESSING → ACTIVE</span>). Mientras concluye, tu clínica
          opera en borrador o cobro manual sin detener la operación.
        </div>

        <div className="space-y-1.5">
          <p className="text-xs text-slate-400">Perfiles demo locales (sin exponer CLABE completa):</p>
          <div className="flex flex-wrap gap-2">
            {DEMO_CLINIC_BANK_PRESETS.map((preset) => {
              const active =
                clabeLast4 === preset.clabeLast4 &&
                clabeTokenOrEnvRef === preset.clabeTokenOrEnvRef;
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => applyDemoPreset(preset)}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                    active
                      ? 'bg-indigo-600/30 border-indigo-400 text-indigo-100'
                      : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {preset.bankName} {preset.clabeMasked}
                </button>
              );
            })}
          </div>
        </div>

        <form onSubmit={handleBankSubmit} className="space-y-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1" htmlFor="local-clabe-check">
              Verificador local de CLABE (18 dígitos · opcional, no se envía por red)
            </label>
            <input
              id="local-clabe-check"
              type="password"
              autoComplete="off"
              inputMode="numeric"
              placeholder="Opcional: pega 18 dígitos para validar Banxico localmente"
              value={localClabeInput}
              onChange={(e) => handleLocalClabeChange(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-white font-mono"
            />
            {localClabeError && (
              <p className="mt-1 text-xs text-rose-300">{localClabeError}</p>
            )}
            {localClabeInfo && (
              <p className="mt-1 text-xs text-emerald-300">{localClabeInfo}</p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="clabe-last4">
                Últimos 4 dígitos CLABE
              </label>
              <input
                id="clabe-last4"
                type="text"
                pattern="\d{4}"
                maxLength={4}
                required
                value={clabeLast4}
                onChange={(e) => setClabeLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="bank-alias">
                Alias de Cuenta
              </label>
              <input
                id="bank-alias"
                type="text"
                required
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1" htmlFor="holder-name">
              Titular de la Cuenta
            </label>
            <input
              id="holder-name"
              type="text"
              required
              value={holderName}
              onChange={(e) => setHolderName(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1" htmlFor="clabe-ref">
              Referencia tokenizada / Env Ref (sin CLABE completa)
            </label>
            <input
              id="clabe-ref"
              type="text"
              value={clabeTokenOrEnvRef}
              onChange={(e) => setClabeTokenOrEnvRef(e.target.value)}
              className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-slate-300 font-mono"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition"
          >
            {loading ? 'Vinculando...' : 'Vincular Cuenta Bancaria'}
          </button>
        </form>

        {bankAccount ? (
          <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-white">
                  {bankAccount.holder_name} · {bankAccount.clabe_masked}
                </p>
                <p className="text-xs text-slate-400 font-mono">
                  {bankAccount.alias} · ID: {bankAccount.bank_account_id}
                </p>
              </div>
              <span
                className={`px-2.5 py-1 rounded-full text-xs font-semibold border ${
                  BANK_STATUS_BADGES[bankAccount.codi_status]
                }`}
              >
                {bankAccount.codi_status}
              </span>
            </div>

            {bankAccount.error_message && (
              <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded p-2">
                {bankAccount.error_message}
              </p>
            )}

            <div className="flex flex-wrap gap-1.5 pt-1">
              {(['BORRADOR', 'PENDING', 'PROCESSING', 'ACTIVE', 'ERROR'] as PeyBankAccountStatus[]).map(
                (st) => (
                  <button
                    key={st}
                    type="button"
                    disabled={loading}
                    onClick={() =>
                      onSimulateBankStatus(
                        bankAccount.bank_account_id,
                        st,
                        st === 'ERROR' ? 'Validación Banxico rechazada (simulado)' : undefined,
                      )
                    }
                    className="rounded-md bg-slate-800 hover:bg-slate-700 px-2.5 py-1 text-[11px] text-slate-200 transition"
                  >
                    Simular {st}
                  </button>
                ),
              )}
              <button
                type="button"
                disabled={loading}
                onClick={() => onRefreshBankStatus(bankAccount.bank_account_id)}
                className="rounded-md bg-sky-600/30 hover:bg-sky-600/50 border border-sky-500/40 px-2.5 py-1 text-[11px] text-sky-200 transition"
              >
                Consultar estado
              </button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Aún no hay una cuenta bancaria vinculada.</p>
        )}
      </section>

      <section className="glass-card p-5 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Suscripción KADI (Anillo 1)</h2>
          <p className="text-xs text-slate-400">
            Checkout SaaS directo con Pey Payment Link o CoDi Push sin comisiones por transacción.
          </p>
        </div>

        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div className="text-xs text-emerald-200">
            <p className="font-semibold">Payment Link Oficial Pey</p>
            <p className="font-mono text-emerald-300">https://app.pey.mx/p/gadypo</p>
          </div>
          <a
            href="https://app.pey.mx/p/gadypo"
            target="_blank"
            rel="noreferrer"
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white text-center transition"
          >
            Abrir Link Pey
          </a>
        </div>

        <form onSubmit={handleSubSubmit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="sub-plan">
                Plan SaaS KADI
              </label>
              <select
                id="sub-plan"
                value={plan}
                onChange={(e) => setPlan(e.target.value as SubscriptionPlan)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              >
                <option value="mensual">Mensual ($990 MXN)</option>
                <option value="hospital_pro">Hospital Pro ($2,490 MXN)</option>
                <option value="anual">Anual ($7,900 MXN)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="sub-mode">
                Canal de Cobro
              </label>
              <select
                id="sub-mode"
                value={subMode}
                onChange={(e) => setSubMode(e.target.value as PaymentMode)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              >
                <option value="payment_link">Payment Link (Pey)</option>
                <option value="qr">QR CoDi</option>
                <option value="request_to_pay">CoDi Push (Celular)</option>
              </select>
            </div>
          </div>

          {subMode === 'request_to_pay' && (
            <div>
              <label className="block text-xs text-slate-400 mb-1" htmlFor="sub-phone">
                Teléfono titular (10 dígitos)
              </label>
              <input
                id="sub-phone"
                type="tel"
                pattern="\d{10}"
                required
                placeholder="5512345678"
                value={subPhone}
                onChange={(e) => setSubPhone(e.target.value)}
                className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white transition"
          >
            {loading ? 'Generando checkout...' : 'Generar Checkout de Suscripción'}
          </button>
        </form>

        {subResult && (
          <div className="rounded-xl bg-slate-950/90 border border-slate-800 p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono text-slate-400">{subResult.intent.intent_id}</span>
              <span className="text-emerald-300 font-semibold">
                ${subResult.intent.amount_mxn.toFixed(2)} MXN
              </span>
            </div>
            <div className="flex flex-col items-center bg-white p-3 rounded-lg w-fit mx-auto">
              <QRCodeSVG value={subResult.intent.qr_payload || subResult.checkout_url} size={140} />
            </div>
            <p className="text-xs text-slate-300 break-all">
              <strong>Checkout URL:</strong>{' '}
              <a
                href={subResult.checkout_url}
                target="_blank"
                rel="noreferrer"
                className="text-indigo-400 underline"
              >
                {subResult.checkout_url}
              </a>
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
