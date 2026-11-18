import { describe, expect, it } from 'vitest';
import { allowlistRedact, REDACTION_MARKER } from '../src/privacy/allowlist.js';

describe('allowlistRedact', () => {
  it('keeps allowlisted fields, masks bankAccountId, keeps only amountBreakdown.base, and redacts PII', () => {
    const input = {
      id: 'qr_001',
      transactionId: 'tx_001',
      type: 'CODI_QR',
      status: 'paid',
      amount: 1999,
      amountBreakdown: {
        base: 1999,
        commission: 50,
        internalTax: 8,
      },
      paymentMethod: 'CODI',
      numRef: 'REF001',
      clientReferenceId: 'ORD-001',
      datePaid: '2026-11-18T00:00:00Z',
      createdAt: '2026-11-17T23:55:00Z',
      expiration: '2026-11-18T00:05:00Z',
      bankAccountId: '01TESTBANKACCOUNT00000000',
      customerEmail: 'patient@example.test',
      phone: '5500000000',
      clabe: 'SYNTHETIC_CLABE_TOKEN',
      nombre: 'Test Person',
      rfc: 'XXXX010101XXX',
      curp: 'XXXX010101XXXXXX00',
      metadata: {
        id: 'nested-secret-id',
        customerEmail: 'nested@example.test',
      },
      externalMetadata: {
        ownerName: 'Nested Secret',
      },
    };

    const redacted = allowlistRedact(input) as Record<string, unknown>;

    expect(redacted.id).toBe('qr_001');
    expect(redacted.transactionId).toBe('tx_001');
    expect(redacted.type).toBe('CODI_QR');
    expect(redacted.status).toBe('paid');
    expect(redacted.amount).toBe(1999);
    expect(redacted.amountBreakdown).toEqual({ base: 1999 });
    expect(redacted.paymentMethod).toBe('CODI');
    expect(redacted.numRef).toBe('REF001');
    expect(redacted.clientReferenceId).toBe('ORD-001');
    expect(redacted.datePaid).toBe('2026-11-18T00:00:00Z');
    expect(redacted.createdAt).toBe('2026-11-17T23:55:00Z');
    expect(redacted.expiration).toBe('2026-11-18T00:05:00Z');
    expect(redacted.bankAccountId).toBe('****0000');

    expect(redacted.customerEmail).toBe(REDACTION_MARKER);
    expect(redacted.phone).toBe(REDACTION_MARKER);
    expect(redacted.clabe).toBe(REDACTION_MARKER);
    expect(redacted.nombre).toBe(REDACTION_MARKER);
    expect(redacted.rfc).toBe(REDACTION_MARKER);
    expect(redacted.curp).toBe(REDACTION_MARKER);
    expect(redacted.metadata).toBe(REDACTION_MARKER);
    expect(redacted.externalMetadata).toBe(REDACTION_MARKER);

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('patient@example.test');
    expect(serialized).not.toContain('nested@example.test');
    expect(serialized).not.toContain('SYNTHETIC_CLABE_TOKEN');
    expect(serialized).not.toContain('01TESTBANKACCOUNT00000000');
    expect(serialized).not.toContain('Test Person');
    expect(serialized).not.toContain('Nested Secret');
  });

  it('handles snake_case and mixed casing variations without leaking PII', () => {
    const input = {
      transaction_id: 'tx_snake',
      CustomerEmail: 'upper@example.test',
      customer_email: 'snake@example.test',
      bank_account_id: 'TESTACCT9876',
      amount_breakdown: { Base: 500, fee: 12 },
      client_reference_id: 'REF-SNAKE',
    };

    const redacted = allowlistRedact(input) as Record<string, unknown>;
    expect(redacted.transaction_id).toBe('tx_snake');
    expect(redacted.client_reference_id).toBe('REF-SNAKE');
    expect(redacted.bank_account_id).toBe('****9876');
    expect(redacted.amount_breakdown).toEqual({ Base: 500 });
    expect(redacted.CustomerEmail).toBe(REDACTION_MARKER);
    expect(redacted.customer_email).toBe(REDACTION_MARKER);
  });

  it('recursively redacts PII inside transactions[*] and top-level arrays', () => {
    const paymentLink = {
      id: 'pl_1',
      status: 'paid',
      transactions: [
        {
          id: 'tx_1',
          amount: 2500,
          bankAccountId: '01TESTBANKACCOUNT00001234',
          customer_email: 'tx-user@example.test',
          metadata: { curp: 'SECRET_CURP' },
        },
      ],
    };

    const redacted = allowlistRedact(paymentLink) as {
      id: string;
      transactions: Array<Record<string, unknown>>;
    };

    expect(redacted.id).toBe('pl_1');
    expect(redacted.transactions).toHaveLength(1);
    expect(redacted.transactions[0].id).toBe('tx_1');
    expect(redacted.transactions[0].bankAccountId).toBe('****1234');
    expect(redacted.transactions[0].customer_email).toBe(REDACTION_MARKER);
    expect(redacted.transactions[0].metadata).toBe(REDACTION_MARKER);

    const arr = allowlistRedact([{ id: 'a1', nombre: 'Secret' }]) as Array<Record<string, unknown>>;
    expect(arr[0].id).toBe('a1');
    expect(arr[0].nombre).toBe(REDACTION_MARKER);
  });

  it('never mutates the original input', () => {
    const original = {
      id: 'qr_immutable',
      bankAccountId: '01TESTBANKACCOUNT00000000',
      amountBreakdown: { base: 1000, extra: 99 },
      metadata: { phone: '5511223344' },
      transactions: [{ id: 'tx_1', customerEmail: 'keep@example.test' }],
    };
    const snapshot = structuredClone(original);

    const redacted = allowlistRedact(original);

    expect(original).toEqual(snapshot);
    expect(redacted).not.toBe(original);
  });
});
