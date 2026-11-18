import type {
  PeyBankAccountResponse,
  PeyCodiQrTransactionsResponse,
  PeyCreateCodiPushInput,
  PeyCreateCodiQrInput,
  PeyCreatePaymentLinkInput,
  PeyResourceResponse,
} from '@codi-pey/contracts';

// [P] validar contra OpenAPI: rutas configurables centralizadas del API de Pey.
export const PEY_PATHS = {
  createCodiQr: '/codi/qr',
  createCodiPushNotification: '/codi/pn',
  createPaymentLink: '/payment-link/create',
  getCodiQrTransactions: '/transaction/codi/qr/:id',
  getPaymentLink: '/payment-link/:id',
  getBankAccount: '/bank-account/:id',
} as const;

export const PEY_DEFAULTS = {
  timeoutMs: 8_000,
  getMaxRetries: 2,
  retryDelayMs: 100,
} as const;

/**
 * Converts a positive MXN amount to integer centavos without floating-point drift.
 */
export function toCents(amountMxn: number): number {
  if (typeof amountMxn !== 'number' || !Number.isFinite(amountMxn) || amountMxn <= 0) {
    throw new RangeError('amountMxn must be a finite number greater than 0');
  }
  const cents = Math.round(amountMxn * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new RangeError('amountMxn must convert to a positive integer number of cents');
  }
  return cents;
}

/**
 * Exact equality check for integer centavos amounts.
 */
export function centsEquals(aCents: number, bCents: number): boolean {
  return Number.isSafeInteger(aCents) && Number.isSafeInteger(bCents) && aCents === bCents;
}

/**
 * Thrown on POST creation calls when outcome is uncertain (timeout, network error, or HTTP 5xx).
 * Callers MUST NOT auto-retry this operation blindly (Rule C1/RJ-3); reconcile before retrying.
 */
export class PeyUncertainCreateError extends Error {
  readonly clientReference: string;
  override readonly cause?: unknown;
  readonly statusCode?: number;

  constructor(message: string, clientReference: string, cause?: unknown, statusCode?: number) {
    super(message);
    this.name = 'PeyUncertainCreateError';
    this.clientReference = clientReference;
    this.cause = cause;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown on definitive HTTP 4xx errors or exhausted GET failures from Pey.
 */
export class PeyApiError extends Error {
  readonly statusCode: number;
  readonly path: string;

  constructor(message: string, statusCode: number, path: string) {
    super(message);
    this.name = 'PeyApiError';
    this.statusCode = statusCode;
    this.path = path;
  }
}

export interface PeyClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

function resolvePath(template: string, id: string): string {
  return template.replace(':id', encodeURIComponent(id));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PeyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(options: PeyClientOptions) {
    if (!options.baseUrl || !options.baseUrl.trim()) {
      throw new Error('PeyClient requires a non-empty baseUrl');
    }
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error('PeyClient requires a non-empty apiKey');
    }
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? PEY_DEFAULTS.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? PEY_DEFAULTS.retryDelayMs;
  }

  async createCodiQr(input: PeyCreateCodiQrInput): Promise<PeyResourceResponse> {
    return this.postCreate<PeyResourceResponse>(
      PEY_PATHS.createCodiQr,
      input,
      input.clientReferenceId,
    );
  }

  async createCodiPushNotification(
    input: PeyCreateCodiPushInput,
  ): Promise<PeyResourceResponse> {
    return this.postCreate<PeyResourceResponse>(
      PEY_PATHS.createCodiPushNotification,
      input,
      input.clientReferenceId,
    );
  }

  async createPaymentLink(input: PeyCreatePaymentLinkInput): Promise<PeyResourceResponse> {
    return this.postCreate<PeyResourceResponse>(
      PEY_PATHS.createPaymentLink,
      input,
      input.clientReferenceId,
    );
  }

  async getCodiQrTransactions(id: string): Promise<PeyCodiQrTransactionsResponse> {
    return this.getWithRetry<PeyCodiQrTransactionsResponse>(
      resolvePath(PEY_PATHS.getCodiQrTransactions, id),
    );
  }

  async getPaymentLink(id: string): Promise<PeyResourceResponse> {
    return this.getWithRetry<PeyResourceResponse>(resolvePath(PEY_PATHS.getPaymentLink, id));
  }

  async getBankAccount(id: string): Promise<PeyBankAccountResponse> {
    return this.getWithRetry<PeyBankAccountResponse>(
      resolvePath(PEY_PATHS.getBankAccount, id),
    );
  }

  private async fetchWithTimeout(
    path: string,
    method: 'GET' | 'POST',
    bodyJson?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const timeoutErr = new Error(`Pey ${method} ${path} timed out after ${this.timeoutMs}ms`);
        controller.abort(timeoutErr);
        reject(timeoutErr);
      }, this.timeoutMs);
    });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (bodyJson !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const fetchPromise = this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: bodyJson,
      signal: controller.signal,
    });

    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      fetchPromise.catch(() => {});
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Rule C1/RJ-3: Creation POSTs NEVER retry.
   * Timeouts, network errors, and 5xx responses produce PeyUncertainCreateError;
   * 4xx responses produce definitive PeyApiError.
   */
  private async postCreate<T>(
    path: string,
    payload: object,
    clientReference: string,
  ): Promise<T> {
    const bodyJson = JSON.stringify(payload);
    let response: Response;

    try {
      response = await this.fetchWithTimeout(path, 'POST', bodyJson);
    } catch (err) {
      throw new PeyUncertainCreateError(
        `Pey POST ${path} outcome uncertain due to transport or timeout failure`,
        clientReference,
        err,
      );
    }

    if (response.status >= 400 && response.status < 500) {
      throw new PeyApiError(
        `Pey POST ${path} rejected with HTTP ${response.status}`,
        response.status,
        path,
      );
    }

    if (response.status >= 500) {
      throw new PeyUncertainCreateError(
        `Pey POST ${path} outcome uncertain due to HTTP ${response.status}`,
        clientReference,
        new Error(`HTTP ${response.status}`),
        response.status,
      );
    }

    if (!response.ok) {
      throw new PeyUncertainCreateError(
        `Pey POST ${path} returned unexpected HTTP ${response.status}`,
        clientReference,
        new Error(`HTTP ${response.status}`),
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new PeyUncertainCreateError(
        `Pey POST ${path} returned unreadable JSON response`,
        clientReference,
        err,
        response.status,
      );
    }
  }

  private async getWithRetry<T>(path: string): Promise<T> {
    const maxAttempts = 1 + PEY_DEFAULTS.getMaxRetries;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.fetchWithTimeout(path, 'GET');

        if (response.status >= 400 && response.status < 500) {
          throw new PeyApiError(
            `Pey GET ${path} failed with HTTP ${response.status}`,
            response.status,
            path,
          );
        }

        if (response.status >= 500 || !response.ok) {
          lastError = new PeyApiError(
            `Pey GET ${path} failed with HTTP ${response.status}`,
            response.status,
            path,
          );
          if (attempt < maxAttempts) {
            await delay(this.retryDelayMs * attempt);
            continue;
          }
          throw lastError;
        }

        return (await response.json()) as T;
      } catch (err) {
        if (err instanceof PeyApiError && err.statusCode >= 400 && err.statusCode < 500) {
          throw err;
        }
        lastError = err;
        if (attempt < maxAttempts) {
          await delay(this.retryDelayMs * attempt);
          continue;
        }
      }
    }

    if (lastError instanceof PeyApiError) {
      throw lastError;
    }
    throw new PeyApiError(`Pey GET ${path} failed after ${maxAttempts} attempts`, 503, path);
  }
}
