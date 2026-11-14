# CoDi + pey — Hackathon Cursor

Repositorio exclusivo del proyecto para el **Hackathon de Cursor (CoDi + pey)**, inicializado con [cursor-hackathon-kit](https://github.com/EliGadielGonzalez/cursor-hackathon-kit) como base de gobernanza agéntica, reglas de Cursor y seguridad.

## Base incluida
- `.cursor/rules/` — Reglas de orquestación, backend, frontend y verificación anti-alucinación.
- `AGENTS.md` — Constitución de workspace y protocolo de handoff para trabajo multi-agente.
- `.gitleaks.toml` — Prevención de fugas de secretos antes de hacer push.
- `docs/templates/TASK.md` — Plantilla de especificación por tarea.

## Seguridad
- Nunca commitear `.env`, llaves de API, tokens de setup ni credenciales reales.
- Usar `.env.example` con placeholders `CHANGE_ME_*`.
