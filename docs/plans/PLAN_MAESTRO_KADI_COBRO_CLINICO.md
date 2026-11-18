# Plan Maestro — KADI Cobro Clínico · Gateway y Terminal CoDi con Pey

> **Estado:** plan de arquitectura pública y auditable.
> **Etiquetas:** `[V]` verificado en este repositorio · `[I-web]` documentación pública de Pey / Standard Webhooks, sin inspección directa de la fuente · `[P]` pendiente de validar contra el OpenAPI vigente de Pey.

## 1. Propósito
Servicio de cobro digital **CoDi®** integrado con el API de **Pey**. Se diseña para integridad financiera, verificación en servidor, cero custodia de fondos de terceros y operación resiliente ante fallos de red.

## 2. Invariantes de ingeniería
1. **Exactitud financiera:** todo pago verificado se guarda en centavos enteros en un libro local append-only (SQLite, WAL) y se notifica exactamente una vez a un sistema contable externo mediante un puerto abstracto (`ExternalLedgerPort`).
2. **Verificación en servidor:** nada se acredita sin verificar:
   - firma Standard Webhooks sobre el cuerpo crudo;
   - ventana de `webhook-timestamp` (±300 s);
   - unicidad de `webhook-id`;
   - estado `paid`;
   - método esperado (`CODI`) `[P]`;
   - una sola transacción liquidada;
   - monto en centavos y `bankAccountId` iguales a la intención original.
3. **Titularidad directa:** los cobros van solo a la cuenta bancaria configurada por el titular del comercio (`EXPECTED_BANK_ACCOUNT_ID`). El servicio no concentra ni dispersa fondos.
4. **Resultado incierto:** si un `POST` de creación a Pey agota el tiempo, la intención pasa a `UNCERTAIN_CREATE`. No se reintenta a ciegas; se resuelve con una consulta `GET` o con confirmación del operador.
5. **Privacidad por lista permitida:** todo payload externo pasa por un filtro `allowlistRedactor` antes de guardarse o mostrarse. Solo se conservan identificadores de transacción, montos, estados y marcas de tiempo; todo dato personal del pagador se descarta por defecto.
6. **Sin cautiverio:** interruptor de apagado, cambio inmediato a registro manual si falla el proveedor y exportación completa en CSV.

## 3. Arquitectura de este repositorio
- `packages/contracts`: esquemas Zod de intenciones, eventos de Pey y el contrato abstracto `ExternalLedgerPort`.
- `apps/api`:
  - `pey/client.ts`: cliente HTTP con manejo de `UNCERTAIN_CREATE`.
  - `webhooks/verify.ts`: verificación Standard Webhooks, tolerancia de 5 min y deduplicación por `webhook-id`.
  - `privacy/allowlist.ts`: redactor por lista permitida.
  - `db/sqlite.ts`: `node:sqlite` en WAL (`timeout: 5000`, `BEGIN IMMEDIATE`).
  - `jobs/reconciler.ts` y `jobs/outbox.ts`: reconciliación por `GET` y entrega idempotente hacia `ExternalLedgerPort`.
- `apps/web`: ventanilla de cobro en ≤3 acciones, bandeja `MANUAL_REVIEW`, consola de auditoría y exportación CSV.

## 4. Tareas públicas
| ID | Entregable | Gate |
|---|---|---|
| EXEC-001 | Guardián CI anti-fuga, `engines.node`, `docs/PRIOR_WORK.md`, plan sanitizado, captura del OpenAPI de Pey | `check:leaks`, typecheck, test y build en verde |
| EXEC-002 | Contratos Zod, `PeyClient` con `UNCERTAIN_CREATE`, guardia de `bankAccountId`, `allowlistRedactor` | pruebas unitarias en verde |
| EXEC-003 | Receptor Standard Webhooks (cuerpo crudo, ±300 s, dedupe) y límite de tasa resistente a NAT | `webhook-security.test.ts` en verde |
| EXEC-004 | SQLite WAL, libro append-only, reconciliador y outbox | pruebas de concurrencia y de caos en verde |
| EXEC-005 | UI de cobro, bandeja `MANUAL_REVIEW`, modo manual y exportación CSV | build web y pruebas en verde |

## 5. Frontera público/privado
Este repositorio no contiene código, rutas, tablas ni reglas de ningún sistema privado. La comunicación hacia el sistema contable externo ocurre solo a través de `ExternalLedgerPort`. El comando `npm run check:leaks` falla el build si aparece un término reservado o un número de 18 dígitos.
