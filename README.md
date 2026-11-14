# CoDi + pey — Hackathon Cursor

Monorepo del proyecto **CoDi + pey** para el Hackathon de Cursor, inicializado con [cursor-hackathon-kit](https://github.com/EliGadielGonzalez/cursor-hackathon-kit) y alineado con el contrato REST de conciliación de `kadi-hackathon`.

## Estructura

- `packages/contracts/` — Esquemas Zod compartidos (`CreateIntentInput`, `PaymentIntent`, `PeyWebhookEvent`, `KadiPaymentSync`).
- `apps/api/` — API en **Node.js 22 + TypeScript + Hono + Zod + Vitest** (intents CoDi, webhooks pey con HMAC + idempotencia, modo sandbox `mock` y bridge opcional hacia `POST /api/v1/cuentas/{id}/pagos`).
- `apps/web/` — Terminal de cobro CoDi en **React 19 + Vite + TypeScript + Tailwind CSS** (QR dinámico, Request-to-Pay y monitor de webhooks).

## Inicio rápido

```bash
cp .env.example .env
npm install
npm run build
npm test
```

En dos terminales:
```bash
npm run dev:api   # http://localhost:3001
npm run dev:web   # http://localhost:5173
```

## Endpoints (`apps/api`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado de la API y modo (`mock\|sandbox\|live`) |
| `POST` | `/api/v1/payments/codi/intents` | Crea intent CoDi (`qr` o `request_to_pay`) |
| `GET` | `/api/v1/payments/codi/intents` | Lista intents y log de webhooks |
| `GET` | `/api/v1/payments/codi/intents/:id` | Consulta estado de un intent |
| `POST` | `/api/v1/webhooks/pey` | Recibe webhook firmado (`x-pey-signature`) con idempotencia |
| `POST` | `/api/v1/sandbox/simulate-pay/:id` | Simula liquidación CoDi en modo `PEY_MODE=mock` |

## Seguridad
- Nunca commitear `.env`, llaves de API, tokens de setup ni credenciales reales.
- Ejecutar `gitleaks detect --source . --config .gitleaks.toml` antes de cada push.
