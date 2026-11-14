# AGENTS.md — Constitución de Workspace para Desarrollo Asistido por IA

> Fuente única de gobernanza para Cursor, Claude Code, Codex, Antigravity o cualquier agente que opere en este repositorio.

---

## 1. Reglas de Oro

1. **Plan antes de mutar:** Comunica el plan, archivos a tocar y riesgos antes de modificar código no trivial.
2. **Docs primero, cero escaneos ciegos:** Lee el `README.md`, inventario o archivos de arquitectura antes de volcar directorios completos al contexto. Usa búsquedas puntuales (`rg` / `grep`).
3. **Código limpio en `src/` / `core/`:** Todo documento de diseño, reporte o plan va en `docs/` o `_plans/`, nunca mezclado con el código fuente.
4. **Validación obligatoria (cero alucinaciones):**
   - Todo código debe pasar pruebas proporcionales al cambio.
   - Tolerancia cero a fabricar resultados: reporta por separado **local**, **CI** y **producción**.
   - Si no pudiste correr un test o comando, decláralo como `NOT_RUN` / `UNKNOWN`, nunca como `PASS`.
5. **Secretos intocables:** Ningún agente lee, copia o imprime `.env`, credenciales, tokens ni dumps de base de datos.
6. **Un Write-Set = Un Dueño:** Si hay varios agentes o desarrolladores en paralelo, las lecturas pueden solaparse, las escrituras sobre el mismo archivo NO.
7. **Ejecutor ≠ Auditor Independiente:** Cambios críticos (dinero, pagos, auth, RBAC, migraciones de BD) deben revisarse en una sesión/contexto limpio distinto al del autor, recibiendo solo el diff y los criterios de aceptación.

---

## 2. Pipeline Rápido de Entrega (6 Fases)

| Fase | Qué se hace | Resultado |
|---|---|---|
| **F0 — Contexto** | Reconstruir realidad del repo y alcance exacto | Objetivo claro sin supuestos |
| **F1 — Análisis** | Causa raíz, arquitectura, riesgos y zonas protegidas | Riesgos identificados |
| **F2 — Plan** | Lista exacta de archivos, contratos y criterios de éxito | Plan aprobable |
| **F3 — Implementación** | Ediciones quirúrgicas dentro del write-set | Código funcional |
| **F4 — Validación** | Tests, lint, build y revisión independiente si es crítico | Evidencia literal |
| **F5 — Cierre** | Documentar cambios, pendientes honestos y handoff | Repo listo para demo/merge |

---

## 3. Protocolo de Handoff (Entre Agentes o Turnos)

Al cerrar una sesión o pasar trabajo a otro agente/compañero, deja este bloque mínimo:

```text
TASK_ID: <ID o nombre corto>
STATE: ENTREGADO | READY_FOR_AUDIT | BLOCKED | IN_PROGRESS
SHA: <git rev-parse --short HEAD o N/A>
EVIDENCE: <comando exacto + exit code + resultado real>
WRITE_SET: <rutas modificadas>
NEXT_ACTION: <siguiente paso concreto>
```

---

## 4. Cuándo Detenerse y Preguntar al Humano (STOP)

- Ambigüedad que cambia reglas de negocio, pagos o permisos.
- Acción destructiva (`DROP TABLE`, `git push --force`, borrar ramas/datos) o exposición de secretos.
- Contradicción entre dos fuentes de verdad que no puede resolverse leyendo el código vivo.
