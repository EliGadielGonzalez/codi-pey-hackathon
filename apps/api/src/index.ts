import { serve } from '@hono/node-server';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3001);
const peyMode = (process.env.PEY_MODE as 'mock' | 'sandbox' | 'live') || 'mock';
const peyWebhookSecret = process.env.PEY_WEBHOOK_SECRET || 'dev-only-webhook-secret';

const app = createApp({
  peyMode,
  peyWebhookSecret,
  kadiBaseUrl: process.env.KADI_BASE_URL || undefined,
});

serve({ fetch: app.fetch, port }, () => {
  console.log(`codi-pey API listening on http://localhost:${port} (mode=${peyMode})`);
});
