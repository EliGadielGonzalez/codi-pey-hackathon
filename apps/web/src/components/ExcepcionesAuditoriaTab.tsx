import type { ManualReviewAction, PaymentIntent } from '@codi-pey/contracts';
import { useState } from 'react';
import type { LedgerAuditEntry, WebhookLog } from '../types.js';

export interface ExcepcionesAuditoriaTabProps {
  codiEnabled: boolean;
  manualReviewItems: PaymentIntent[];
  ledgerEntries: LedgerAuditEntry[];
  webhooks: WebhookLog[];
  exportCsvUrl: string;
  loading: boolean;
  onToggleKillSwitch: (enabled: boolean) => Promise<void>;
  onResolveManualReview: (
    intentId: string,
    action: ManualReviewAction,
    note: string,
  ) => Promise<void>;
}

export function ExcepcionesAuditoriaTab({
  codiEnabled,
  manualReviewItems,
  ledgerEntries,
  webhooks,
  exportCsvUrl,
  loading,
  onToggleKillSwitch,
  onResolveManualReview,
}: ExcepcionesAuditoriaTabProps) {
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <div className="space-y-6">
      <div className="glass-card p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">
            Control Operativo: Kill Switch y Exportación sin Cautiverio
          </h2>
          <p className="text-xs text-slate-400">
            Apaga el cobro CoDi al instante ante contingencias o exporta todo el historial en CSV estándar.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={() => onToggleKillSwitch(!codiEnabled)}
            className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
              codiEnabled
                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
          >
            {codiEnabled ? 'Apagar Cobro CoDi (Kill Switch)' : 'Encender Cobro CoDi'}
          </button>

          <a
            href={exportCsvUrl}
            download="codi-pey-export.csv"
            className="rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 px-4 py-2 text-xs font-semibold text-white transition"
          >
            Exportar CSV
          </a>
        </div>
      </div>

      <section className="glass-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">
            Bandeja de Excepciones · MANUAL_REVIEW ({manualReviewItems.length})
          </h3>
          <span className="text-xs text-slate-400">Regla C2: discrepancias nunca se auto-aplican</span>
        </div>

        {manualReviewItems.length === 0 ? (
          <p className="text-xs text-slate-500 py-4">
            Sin excepciones pendientes en MANUAL_REVIEW.
          </p>
        ) : (
          <div className="space-y-3">
            {manualReviewItems.map((item) => {
              const note = notes[item.intent_id] ?? '';
              return (
                <div
                  key={item.intent_id}
                  className="rounded-xl bg-slate-950/90 border border-amber-500/30 p-4 space-y-3"
                >
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-white">
                        ${item.amount_mxn.toFixed(2)} MXN · {item.concept}
                      </p>
                      <p className="text-xs text-slate-400 font-mono">
                        {item.intent_id} · Motivo: {item.review_reason || 'revisión_manual'}
                      </p>
                    </div>
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30 w-fit">
                      MANUAL_REVIEW
                    </span>
                  </div>

                  <div className="flex flex-col md:flex-row gap-2">
                    <input
                      type="text"
                      placeholder="Nota de auditoría obligatoria (ej. Verificado en estado de cuenta)"
                      value={note}
                      onChange={(e) =>
                        setNotes((prev) => ({ ...prev, [item.intent_id]: e.target.value }))
                      }
                      className="flex-1 rounded-lg bg-slate-900 border border-slate-700 px-3 py-1.5 text-xs text-white"
                    />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={loading || !note.trim()}
                        onClick={() => onResolveManualReview(item.intent_id, 'APPLY', note.trim())}
                        className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-1.5 text-xs font-semibold text-white transition"
                      >
                        Aplicar
                      </button>
                      <button
                        type="button"
                        disabled={loading || !note.trim()}
                        onClick={() =>
                          onResolveManualReview(item.intent_id, 'REFUND_MANUAL', note.trim())
                        }
                        className="rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-3 py-1.5 text-xs font-semibold text-white transition"
                      >
                        Reembolso Manual
                      </button>
                      <button
                        type="button"
                        disabled={loading || !note.trim()}
                        onClick={() => onResolveManualReview(item.intent_id, 'CANCEL', note.trim())}
                        className="rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 px-3 py-1.5 text-xs font-semibold text-white transition"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="glass-card p-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">
            Auditoría Append-Only ({ledgerEntries.length})
          </h3>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {ledgerEntries.length === 0 ? (
              <p className="text-xs text-slate-500">Sin entradas de auditoría aún.</p>
            ) : (
              ledgerEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-lg bg-slate-950/80 border border-slate-800 p-3 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-indigo-300">{entry.event}</span>
                    <span className="font-mono text-slate-400">
                      ${(entry.amount_cents / 100).toFixed(2)} MXN
                    </span>
                  </div>
                  <p className="font-mono text-slate-300">
                    {entry.intent_id} · {entry.from_state ?? 'INIT'} → {entry.to_state}
                  </p>
                  <p className="text-slate-500">
                    Actor: {entry.actor} · {entry.created_at}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="glass-card p-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">
            Monitor de Webhooks Redactados ({webhooks.length})
          </h3>
          <div className="space-y-2 max-h-72 overflow-y-auto">
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
                    <p className="text-slate-400">
                      {w.intent_id} · Rastreo: {w.clave_rastreo}
                    </p>
                  </div>
                  <span className={w.duplicate ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                    {w.duplicate ? 'IDEMPOTENT_DUP' : w.status}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
