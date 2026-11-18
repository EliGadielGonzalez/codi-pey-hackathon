# Trabajo previo declarado

Declaración conforme a las reglas del hackatón sobre componentes previos.

## Existía antes del hackatón (no forma parte de este repositorio)
- **KADI SCV**: sistema propietario y privado de gestión para clínicas veterinarias. No se publica ni se incluye en este repositorio. Este proyecto lo trata como un sistema contable externo, a través de un contrato genérico (`ExternalLedgerPort`).
- **cursor-hackathon-kit**: plantilla inicial de repositorio, usada como base del monorepo (primer commit).

## Construido durante el hackatón (este repositorio)
- Gateway y terminal de cobro CoDi con el API de Pey: cliente HTTP, verificación de webhooks Standard Webhooks, persistencia local, reconciliador, bandeja de excepciones y consola de auditoría.
- Contratos Zod y pruebas automatizadas.
- Guardián CI anti-fuga (`scripts/check-no-private-leaks.mjs`).

Cualquier cambio a esta declaración debe hacerse antes de la postulación (10-dic-2026).
