import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { PaymentRepo } from './db/payment-repo.js';
import { migrate, openDb } from './db/sqlite.js';
import { PeyClient } from './pey/client.js';

function loadLocalEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
    path.resolve(process.cwd(), '../../../.env'),
  ];
  const seen = new Set<string>();

  for (const envPath of candidates) {
    if (seen.has(envPath) || !fs.existsSync(envPath)) continue;
    seen.add(envPath);

    const content = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      if (!key || process.env[key] !== undefined) continue;
      let val = line.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

loadLocalEnv();

const port = Number(process.env.PORT || 3001);
const peyMode =
  (process.env.PEY_MODE as 'mock' | 'sandbox' | 'live' | undefined) || 'mock';
const isProduction = process.env.NODE_ENV === 'production';

const rawWebhookSecret = process.env.PEY_WEBHOOK_SECRET?.trim();
if ((peyMode !== 'mock' || isProduction) && !rawWebhookSecret) {
  throw new Error(
    'PEY_WEBHOOK_SECRET is required when PEY_MODE is not mock or NODE_ENV=production',
  );
}

const peyWebhookSecret =
  rawWebhookSecret || `mock_${randomBytes(24).toString('hex')}`;

const dbPath = process.env.SQLITE_DB_PATH || './data/codi-pey.sqlite';
if (dbPath !== ':memory:') {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
}
const db = openDb(dbPath);
migrate(db);
const repo = new PaymentRepo(db);

const peyClient =
  process.env.PEY_BASE_URL && process.env.PEY_API_KEY
    ? new PeyClient({
        baseUrl: process.env.PEY_BASE_URL,
        apiKey: process.env.PEY_API_KEY,
      })
    : undefined;

const app = createApp(
  {
    peyMode,
    peyWebhookSecret,
    kadiBaseUrl: process.env.KADI_BASE_URL || undefined,
    kadiBearerToken: process.env.KADI_BEARER_TOKEN || undefined,
    expectedBankAccountId: process.env.EXPECTED_BANK_ACCOUNT_ID || undefined,
    subscriptionPaymentLinkUrl:
      process.env.PEY_SUBSCRIPTION_PAYMENT_LINK_URL || undefined,
  },
  {
    db,
    repo,
    peyClient,
  },
);

serve({ fetch: app.fetch, port }, () => {
  console.log(
    `codi-pey API listening on http://localhost:${port} (mode=${peyMode}, db=${dbPath})`,
  );
});
