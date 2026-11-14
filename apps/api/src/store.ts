import type { PaymentIntent } from '@codi-pey/contracts';

export interface WebhookLogEntry {
  event_id: string;
  intent_id: string;
  status: string;
  clave_rastreo: string;
  received_at: string;
  duplicate: boolean;
}

export class InMemoryPaymentStore {
  private intents = new Map<string, PaymentIntent>();
  private processedEvents = new Set<string>();
  private processedClaves = new Set<string>();
  private webhookLogs: WebhookLogEntry[] = [];

  saveIntent(intent: PaymentIntent): void {
    this.intents.set(intent.intent_id, intent);
  }

  getIntent(intentId: string): PaymentIntent | undefined {
    return this.intents.get(intentId);
  }

  listIntents(): PaymentIntent[] {
    return Array.from(this.intents.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  hasProcessedWebhook(eventId: string, claveRastreo: string): boolean {
    return this.processedEvents.has(eventId) || this.processedClaves.has(claveRastreo);
  }

  markWebhookProcessed(entry: WebhookLogEntry): void {
    this.processedEvents.add(entry.event_id);
    this.processedClaves.add(entry.clave_rastreo);
    this.webhookLogs.unshift(entry);
    if (this.webhookLogs.length > 50) this.webhookLogs.pop();
  }

  recordDuplicateWebhook(entry: WebhookLogEntry): void {
    this.webhookLogs.unshift(entry);
    if (this.webhookLogs.length > 50) this.webhookLogs.pop();
  }

  listWebhookLogs(): WebhookLogEntry[] {
    return [...this.webhookLogs];
  }
}
