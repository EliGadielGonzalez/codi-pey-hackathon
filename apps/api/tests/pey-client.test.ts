import { describe, expect, it, vi } from 'vitest';
import {
  centsEquals,
  PEY_PATHS,
  PeyApiError,
  PeyClient,
  PeyUncertainCreateError,
  toCents,
} from '../src/pey/client.js';
import {
  PEY_AMOUNT_UNIT,
  verifyPaid,
} from '../src/pey/verify-payment.js';

const TEST_API_KEY = 'pey_test_secret_key_do_not_leak';
const TEST_BASE_URL = 'https://sandbox.pey.invalid';
const TEST_BANK_ACCOUNT = '01TESTBANKACCOUNT00000000';

describe('toCents & centsEquals', () => {
  it('converts MXN amounts accurately without floating-point drift', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.01)).toBe(1);
    expect(centsEquals(1999, toCents(19.99))).toBe(true);
    expect(centsEquals(1999, 2000)).toBe(false);
  });

  it('rejects non-positive, sub-cent, NaN, and infinite amounts', () => {
    expect(() => toCents(0)).toThrow(RangeError);
    expect(() => toCents(-10)).toThrow(RangeError);
    expect(() => toCents(0.001)).toThrow(RangeError);
    expect(() => toCents(Number.NaN)).toThrow(RangeError);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('PeyClient', () => {
  it('sends Authorization Bearer header and calls configured endpoint paths', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 'qr_123', status: 'pending' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new PeyClient({
      baseUrl: TEST_BASE_URL,
      apiKey: TEST_API_KEY,
      fetchImpl,
    });

    const res = await client.createCodiQr({
      amount: 1999,
      clientReferenceId: 'ORD-100',
    });

    expect(res.id).toBe('qr_123');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TEST_BASE_URL}${PEY_PATHS.createCodiQr}`);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TEST_API_KEY}`,
    );
  });

  it('never retries POST creation on timeout and throws PeyUncertainCreateError without leaking apiKey', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      () => new Promise(() => {}),
    );

    const client = new PeyClient({
      baseUrl: TEST_BASE_URL,
      apiKey: TEST_API_KEY,
      timeoutMs: 25,
      fetchImpl: fetchMock,
    });

    let caught: unknown;
    try {
      await client.createCodiPushNotification({
        amount: 5000,
        phone: '5500000000',
        clientReferenceId: 'ORD-TIMEOUT',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PeyUncertainCreateError);
    const uncertain = caught as PeyUncertainCreateError;
    expect(uncertain.clientReference).toBe('ORD-TIMEOUT');
    expect(uncertain.cause).toBeDefined();
    expect(uncertain.message).not.toContain(TEST_API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries POST creation on HTTP 400 and throws PeyApiError without leaking apiKey', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 }),
    );

    const client = new PeyClient({
      baseUrl: TEST_BASE_URL,
      apiKey: TEST_API_KEY,
      fetchImpl: fetchMock,
    });

    let caught: unknown;
    try {
      await client.createPaymentLink({
        amount: 2500,
        clientReferenceId: 'ORD-400',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PeyApiError);
    const apiErr = caught as PeyApiError;
    expect(apiErr.statusCode).toBe(400);
    expect(apiErr.message).not.toContain(TEST_API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never retries POST creation on HTTP 503 and treats it as PeyUncertainCreateError', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('Service Unavailable', { status: 503 }),
    );

    const client = new PeyClient({
      baseUrl: TEST_BASE_URL,
      apiKey: TEST_API_KEY,
      fetchImpl: fetchMock,
    });

    let caught: unknown;
    try {
      await client.createCodiQr({
        amount: 3000,
        clientReferenceId: 'ORD-503',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PeyUncertainCreateError);
    expect((caught as PeyUncertainCreateError).clientReference).toBe('ORD-503');
    expect((caught as PeyUncertainCreateError).message).not.toContain(TEST_API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries GET requests on 503 up to 2 times and succeeds when recovered', async () => {
    let attempt = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      attempt += 1;
      if (attempt < 3) {
        return new Response('Busy', { status: 503 });
      }
      return new Response(JSON.stringify({ id: 'pl_ok', status: 'paid' }), { status: 200 });
    });

    const client = new PeyClient({
      baseUrl: TEST_BASE_URL,
      apiKey: TEST_API_KEY,
      retryDelayMs: 5,
      fetchImpl: fetchMock,
    });

    const res = await client.getPaymentLink('pl_ok');
    expect(res.id).toBe('pl_ok');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry GET requests on 4xx', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('Not Found', { status: 404 }),
    );

    const client = new PeyClient({
      baseUrl: TEST_BASE_URL,
      apiKey: TEST_API_KEY,
      retryDelayMs: 5,
      fetchImpl: fetchMock,
    });

    await expect(client.getBankAccount(TEST_BANK_ACCOUNT)).rejects.toBeInstanceOf(PeyApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes cause on PeyUncertainCreateError and strips headers.Authorization / apiKey', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const transportErr = Object.assign(
        new Error(`Socket hangup with Bearer ${TEST_API_KEY}`),
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          config: { headers: { Authorization: `Bearer ${TEST_API_KEY}` } },
        },
      );
      throw transportErr;
    });

    const client = new PeyClient({
      baseUrl: TEST_BASE_URL,
      apiKey: TEST_API_KEY,
      fetchImpl: fetchMock,
    });

    let caught: unknown;
    try {
      await client.createCodiQr({
        amount: 250.0,
        clientReferenceId: 'ORD-SANITIZE',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PeyUncertainCreateError);
    const uncertain = caught as PeyUncertainCreateError;
    expect(uncertain.message).not.toContain(TEST_API_KEY);
    expect(uncertain.cause).toEqual({
      name: 'Error',
      message: 'Socket hangup with Bearer [REDACTED]',
    });
    expect(Object.keys(uncertain.cause ?? {})).toEqual(['name', 'message']);
    expect(JSON.stringify(uncertain.cause)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(uncertain.cause)).not.toContain('headers');
    expect(JSON.stringify(uncertain.cause)).not.toContain('Authorization');
  });
});

describe('verifyPaid (C2)', () => {
  const baseIntent = {
    amountCents: 1999,
    expectedBankAccountId: TEST_BANK_ACCOUNT,
    expectedMethod: 'CODI' as const,
  };

  it('defaults PEY_AMOUNT_UNIT to pesos and validates decimal MXN payloads against centavos intents', () => {
    expect(PEY_AMOUNT_UNIT).toBe('pesos');

    // 250.00 pesos vs 25000 centavos => ok
    expect(
      verifyPaid({
        intent: {
          amountCents: 25_000,
          expectedBankAccountId: TEST_BANK_ACCOUNT,
          expectedMethod: 'CODI',
        },
        payload: {
          status: 'paid',
          paymentMethod: 'CODI',
          amount: 250.0,
          bankAccountId: TEST_BANK_ACCOUNT,
        },
      }),
    ).toEqual({ ok: true });

    // 19.99 pesos vs 1999 centavos => ok
    expect(
      verifyPaid({
        intent: baseIntent,
        payload: {
          status: 'paid',
          paymentMethod: 'CODI',
          amountBreakdown: { base: 19.99 },
          bankAccountId: TEST_BANK_ACCOUNT,
        },
      }),
    ).toEqual({ ok: true });

    // 250 pesos vs 250 centavos => amount_mismatch (prevents 100x underpayment acceptance)
    expect(
      verifyPaid({
        intent: {
          amountCents: 250,
          expectedBankAccountId: TEST_BANK_ACCOUNT,
          expectedMethod: 'CODI',
        },
        payload: {
          status: 'paid',
          paymentMethod: 'CODI',
          amount: 250,
          bankAccountId: TEST_BANK_ACCOUNT,
        },
      }),
    ).toEqual({ ok: false, reason: 'amount_mismatch' });

    // Floating-point rounding: 0.1 + 0.2 pesos vs 30 centavos => ok
    expect(
      verifyPaid({
        intent: {
          amountCents: 30,
          expectedBankAccountId: TEST_BANK_ACCOUNT,
          expectedMethod: 'CODI',
        },
        payload: {
          status: 'paid',
          paymentMethod: 'CODI',
          amountBreakdown: { base: 0.1 + 0.2 },
          bankAccountId: TEST_BANK_ACCOUNT,
        },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects zero, negative, NaN, and numeric string amounts in pesos mode (including amountBreakdown.base)', () => {
    for (const badAmount of [0, -10, Number.NaN, '250.00' as unknown as number]) {
      expect(
        verifyPaid({
          intent: {
            amountCents: 25_000,
            expectedBankAccountId: TEST_BANK_ACCOUNT,
            expectedMethod: 'CODI',
          },
          payload: {
            status: 'paid',
            paymentMethod: 'CODI',
            amount: badAmount,
            bankAccountId: TEST_BANK_ACCOUNT,
          },
        }),
      ).toEqual({ ok: false, reason: 'amount_mismatch' });

      expect(
        verifyPaid({
          intent: {
            amountCents: 25_000,
            expectedBankAccountId: TEST_BANK_ACCOUNT,
            expectedMethod: 'CODI',
          },
          payload: {
            status: 'paid',
            paymentMethod: 'CODI',
            amountBreakdown: { base: badAmount },
            amount: 250.0,
            bankAccountId: TEST_BANK_ACCOUNT,
          },
        }),
      ).toEqual({ ok: false, reason: 'amount_mismatch' });
    }
  });

  it('supports centavos mode via optional amountUnit parameter', () => {
    expect(
      verifyPaid({
        intent: {
          amountCents: 25_000,
          expectedBankAccountId: TEST_BANK_ACCOUNT,
          expectedMethod: 'CODI',
        },
        payload: {
          status: 'paid',
          paymentMethod: 'CODI',
          amountBreakdown: { base: 25_000 },
          bankAccountId: TEST_BANK_ACCOUNT,
        },
        amountUnit: 'centavos',
      }),
    ).toEqual({ ok: true });

    expect(
      verifyPaid({
        intent: {
          amountCents: 25_000,
          expectedBankAccountId: TEST_BANK_ACCOUNT,
          expectedMethod: 'CODI',
        },
        payload: {
          status: 'paid',
          paymentMethod: 'CODI',
          amount: 250.0,
          bankAccountId: TEST_BANK_ACCOUNT,
        },
        amountUnit: 'centavos',
      }),
    ).toEqual({ ok: false, reason: 'amount_mismatch' });
  });

  it('returns ok:true for valid single-tx payment link payload in pesos', () => {
    expect(
      verifyPaid({
        intent: baseIntent,
        payload: {
          type: 'payment_link',
          status: 'paid',
          transactions: [
            {
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 19.99,
              bankAccountId: TEST_BANK_ACCOUNT,
            },
          ],
        },
      }),
    ).toEqual({ ok: true });
  });

  it('returns not_paid when status is not paid', () => {
    expect(
      verifyPaid({
        intent: baseIntent,
        payload: {
          status: 'pending',
          paymentMethod: 'CODI',
          amount: 19.99,
          bankAccountId: TEST_BANK_ACCOUNT,
        },
      }),
    ).toEqual({ ok: false, reason: 'not_paid' });
  });

  it('returns invalid_transactions_count when payment link transactions length !== 1', () => {
    expect(
      verifyPaid({
        intent: baseIntent,
        payload: {
          status: 'paid',
          transactions: [],
        },
      }),
    ).toEqual({ ok: false, reason: 'invalid_transactions_count' });

    expect(
      verifyPaid({
        intent: baseIntent,
        payload: {
          status: 'paid',
          transactions: [
            {
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 19.99,
              bankAccountId: TEST_BANK_ACCOUNT,
            },
            {
              status: 'paid',
              paymentMethod: 'CODI',
              amount: 19.99,
              bankAccountId: TEST_BANK_ACCOUNT,
            },
          ],
        },
      }),
    ).toEqual({ ok: false, reason: 'invalid_transactions_count' });
  });

  it('returns method_mismatch when paymentMethod differs', () => {
    expect(
      verifyPaid({
        intent: baseIntent,
        payload: {
          status: 'paid',
          paymentMethod: 'CARD',
          amountBreakdown: { base: 19.99 },
          bankAccountId: TEST_BANK_ACCOUNT,
        },
      }),
    ).toEqual({ ok: false, reason: 'method_mismatch' });
  });

  it('returns amount_mismatch when amount differs', () => {
    expect(
      verifyPaid({
        intent: baseIntent,
        payload: {
          status: 'paid',
          paymentMethod: 'CODI',
          amountBreakdown: { base: 19.98 },
          bankAccountId: TEST_BANK_ACCOUNT,
        },
      }),
    ).toEqual({ ok: false, reason: 'amount_mismatch' });
  });

  it('returns account_mismatch when bankAccountId differs', () => {
    expect(
      verifyPaid({
        intent: baseIntent,
        payload: {
          status: 'paid',
          paymentMethod: 'CODI',
          amountBreakdown: { base: 19.99 },
          bankAccountId: '01OTHERBANKACCOUNT00009999',
        },
      }),
    ).toEqual({ ok: false, reason: 'account_mismatch' });
  });
});
