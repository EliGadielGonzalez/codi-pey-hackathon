#!/usr/bin/env node
// Guardián anti-fuga (C6). Falla con exit 1 si el repo público contiene
// términos internos de sistemas privados o un número de 18 dígitos (CLABE).
// Nunca imprime el valor encontrado de un posible CLABE, solo archivo:línea.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const SELF = 'scripts/check-no-private-leaks.mjs';
const SKIP = new Set([SELF, 'package-lock.json']);
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|zip|gz)$/i;

const FORBIDDEN_TERMS = [
  'workspacekadiclear',
  'core/backend',
  'core/frontend',
  'HospitalizacionService',
  'VentaRapidaAction',
  'AplicarPagoOperation',
  'RegistrarPagoAction',
  'RevertirPagoAction',
  'DarAltaCuentaAction',
  'EstadoCuentaPolicy',
  'MoneyIdempotency',
  'IntegracionCredencial',
  'InstanceConfig',
  'CorteCaja',
  'MovimientoCaja',
  'cuenta_pagos',
  'movimiento_caja',
  '/api/v1/cuentas',
];
const CLABE_PATTERNS = [/(?<!\d)\d{18}(?!\d)/, /(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{2}(?!\d)/];

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean);

const findings = [];
for (const file of files) {
  if (SKIP.has(file) || BINARY_EXT.test(file)) continue;
  let text;
  try {
    if (!statSync(file).isFile()) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    for (const term of FORBIDDEN_TERMS) {
      if (lower.includes(term.toLowerCase())) findings.push(`${file}:${i + 1} término privado (${term})`);
    }
    if (CLABE_PATTERNS.some((re) => re.test(line))) findings.push(`${file}:${i + 1} posible CLABE de 18 dígitos (valor omitido)`);
  });
}

if (findings.length) {
  console.error('check-no-private-leaks: FALLO');
  for (const f of findings) console.error(' - ' + f);
  process.exit(1);
}
console.log(`check-no-private-leaks: OK (${files.length} archivos revisados)`);
